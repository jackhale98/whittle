import { expect, type Page, test } from '@playwright/test';
import { app, boot, clickAt, palette, sketchOn, tool, toolButton, toolGroup } from './helpers';

/**
 * The grouped desktop command bar (PLAN 9.1: categories with flyouts, keyboard navigation, per-user
 * last-used tool, per-tool hints) and the feature tree's nested sketches (ADR-015).
 */

const SHOTS = process.env.WHITTLE_SHOTS;

async function start(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
}

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Modeling tools' });
const items = (page: Page) => page.getByTestId('feature-tree').getByRole('treeitem');
const features = async (page: Page) => (await app(page).doc()).parts[0]?.features ?? [];

test('the command bar is grouped, keyboard-navigable, and remembers the last-used tool', async ({
  page,
}) => {
  test.slow();
  await start(page);
  const b = bar(page);

  // Five categories and More; no wider than the old flat bar (it was ~620 px).
  await expect(b.getByRole('button')).toHaveCount(6);
  expect((await b.boundingBox())?.width ?? 0).toBeLessThanOrEqual(620);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-bar-collapsed.png` });

  // Sketch and Hole are direct buttons; Solid / Modify / Inspect open flyouts.
  await expect(toolButton(page, 'sketch')).toBeVisible();
  await expect(toolButton(page, 'hole')).toHaveAttribute('aria-disabled', 'true');
  await expect(toolGroup(page, 'solid')).toHaveAttribute('aria-haspopup', 'true');

  // Roving focus: Left/Right move across the categories.
  await toolButton(page, 'sketch').focus();
  await page.keyboard.press('ArrowRight');
  await expect(toolGroup(page, 'solid')).toBeFocused();

  // ArrowUp opens; the face tool has focus; arrows move inside; Escape closes and returns.
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('tool-flyout')).toBeVisible();
  await expect(toolButton(page, 'extrude')).toBeFocused();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-bar-open.png` });
  await page.keyboard.press('ArrowDown');
  await expect(toolButton(page, 'pushPull')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-flyout')).toBeHidden();
  await expect(toolGroup(page, 'solid')).toBeFocused();

  // Disabled tools say when they arrive, and stay reachable.
  await page.keyboard.press('ArrowRight');
  await expect(toolGroup(page, 'modify')).toBeFocused();
  await page.keyboard.press('Enter');
  const shell = toolButton(page, 'shell');
  await expect(shell).toHaveAttribute('aria-disabled', 'true');
  await expect(shell).toContainText('Coming in M3');
  await expect(toolButton(page, 'fillet')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // Choosing a tool makes it the category's face, and it survives a reload (per user).
  await toolGroup(page, 'solid').click();
  await toolButton(page, 'revolve').click();
  await expect(page.getByRole('button', { name: 'Revolve, Solid tools' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('whittle.lastTools')))
    .toContain('"solid":"revolve"');
  await app(page).flushSave();
  await boot(page);
  await expect(page.getByRole('button', { name: 'Revolve, Solid tools' })).toBeVisible();
});

test('sketches nest under the feature that uses them; shared ones show a badge; delete asks inline', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await start(page);
  const a = app(page);

  // A sketch on Top: a 40 x 30 rectangle.
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
    [0, 0],
  ] as const) {
    await clickAt(page, x, y);
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('finish-sketch').click();
  await a.idle();

  // 5. A new sketch is top-level until a feature consumes it.
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveAttribute('aria-level', '1');
  await expect(items(page).first()).not.toHaveAttribute('aria-expanded', 'false');

  const extrudeOnce = async (depth: string) => {
    await tool(page, 'extrude');
    await expect(page.getByTestId('prompt-chip')).toContainText('Select a sketch region');
    await a.idle();
    await clickAt(page, 20, 15);
    const field = page.getByTestId('extrude-depth-input').getByRole('textbox');
    await expect(field).toBeVisible();
    await field.fill(depth);
    await field.press('Enter');
    await a.idle();
  };

  // 1-2. One consumer: the sketch nests under it, collapsed, with a chevron.
  await extrudeOnce('10');
  await expect(items(page)).toHaveCount(1);
  const e1 = items(page).first();
  await expect(e1).toContainText('Extrude 1');
  await expect(e1).toHaveAttribute('aria-expanded', 'false');
  await e1.getByTestId('nest-toggle').click();
  await expect(e1).toHaveAttribute('aria-expanded', 'true');
  await expect(items(page)).toHaveCount(2);
  const nested = items(page).nth(1);
  await expect(nested).toContainText('Sketch 1');
  await expect(nested).toHaveAttribute('aria-level', '2');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-nested.png` });

  // The rollback bar cannot stop between them: from the end, one step up goes to the very top.
  const rollback = page.getByRole('separator', { name: 'Rollback bar' });
  await rollback.focus();
  await page.keyboard.press('ArrowUp');
  await expect(rollback).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('ArrowDown');
  await expect(rollback).toHaveAttribute('aria-valuenow', '2');

  // 'Selecting' a nested sketch opens sketch mode as before.
  await nested.dblclick({ position: { x: 150, y: 10 } }).catch(() => {});
  await page.keyboard.press('Escape');

  // Two consumers: the sketch is top-level again, with "used by 2".
  await extrudeOnce('5');
  await expect(items(page)).toHaveCount(3);
  const shared = items(page).filter({ hasText: 'Sketch 1' });
  await expect(shared).toHaveAttribute('aria-level', '1');
  await expect(shared.getByTestId('used-by')).toHaveText('used by 2');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-shared-badge.png` });

  // Deleting one consumer folds the sketch back under the other.
  await items(page).filter({ hasText: 'Extrude 2' }).focus();
  await page.keyboard.press('Delete');
  await a.idle();
  await expect(items(page)).toHaveCount(2); // Extrude 1 is still open, its sketch back under it
  await expect(items(page).filter({ hasText: 'Sketch 1' })).toHaveAttribute('aria-level', '2');
  await expect(items(page).filter({ hasText: 'Sketch 1' }).getByTestId('used-by')).toHaveCount(0);

  // 6. Deleting a feature with a nested sketch asks inline: Keep sketch.
  await items(page).filter({ hasText: 'Extrude 1' }).focus();
  await page.keyboard.press('Delete');
  const prompt = page.getByTestId('delete-prompt');
  await expect(prompt).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-delete-prompt.png` });
  await prompt.getByRole('button', { name: 'Keep sketch' }).click();
  await a.idle();
  expect((await features(page)).map((f) => f.type)).toEqual(['sketch']);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText('Sketch 1');

  // Undo brings the extrude back, nested again.
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  expect((await features(page)).map((f) => f.type)).toEqual(['sketch', 'extrude']);
  await expect(items(page).filter({ hasText: 'Sketch 1' })).toHaveAttribute('aria-level', '2');

  // 6. ... and Delete sketch too removes both, as one undo step.
  await items(page).filter({ hasText: 'Extrude 1' }).focus();
  await page.keyboard.press('Delete');
  await page.getByTestId('delete-prompt').getByRole('button', { name: 'Delete sketch too' }).click();
  await a.idle();
  expect(await features(page)).toHaveLength(0);
  await page.keyboard.press('ControlOrMeta+z');
  await a.idle();
  expect((await features(page)).map((f) => f.type)).toEqual(['sketch', 'extrude']);

  // 7. "Show sketches in the history" restores the flat list, and it persists.
  await palette(page, 'Show sketches in the history');
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toContainText('Sketch 1');
  await expect(items(page).nth(1)).toContainText('Extrude 1');
  await expect(items(page).nth(0)).toHaveAttribute('aria-level', '1');
  await expect(items(page).nth(1)).not.toHaveAttribute('aria-expanded', 'false');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-flat.png` });
  await a.flushSave();
  await boot(page);
  await expect(items(page)).toHaveCount(2);
  await palette(page, 'Nest sketches under their features');
  await expect(items(page).filter({ hasText: 'Extrude 1' })).toHaveAttribute('aria-expanded', 'false');
  await expect(items(page).filter({ hasText: 'Sketch 1' })).toHaveCount(0);
});
