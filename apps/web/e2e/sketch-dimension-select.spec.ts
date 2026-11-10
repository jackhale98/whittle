// SPDX-License-Identifier: GPL-3.0-or-later
// Owner bug (2026-11-10): after dimensioning a circle its centre could not be grabbed (the leader's
// hit area covered it), the leader swung round the fixed label when the circle moved, and Delete
// did not remove a dimension (a click opened the editor, so Delete went to the text field).
import { expect, type Page, test } from '@playwright/test';
import type { DimensionConstraint, SketchFeature } from '@wren-cad/contracts';
import { app, boot, clickAt, sketchOn, toPage } from './helpers';

async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features.find((x) => x.type === 'sketch');
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}

async function circleWithDiameter(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const a = app(page);
  await page.keyboard.press('Shift+C');
  await clickAt(page, 10, 10);
  await clickAt(page, 25, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, 25, 10);
  await clickAt(page, 35, 20); // label up and right: the leader crosses the centre
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill('30');
  await editor.press('Enter');
  await a.settled();
  await page.keyboard.press('Escape'); // select tool
}

const centreOf = (f: SketchFeature) => {
  const c = f.entities.find((e) => e.kind === 'circle');
  const p = f.entities.find((e) => e.kind === 'point' && c?.kind === 'circle' && e.id === c.center);
  if (p?.kind !== 'point') throw new Error('no centre');
  return [p.x, p.y] as const;
};
const dimOf = (f: SketchFeature) =>
  f.constraints.find((c): c is DimensionConstraint => 'value' in c);

test('a dimensioned circle drags by its centre and its label comes along', async ({ page }) => {
  test.slow();
  await circleWithDiameter(page);
  const a = app(page);
  const before = await sketchOf(page);
  const [x0, y0] = centreOf(before);
  const l0 = dimOf(before)?.label;
  if (!l0) throw new Error('no label');

  const c = await toPage(page, [x0, y0, 0]);
  await page.mouse.move(c.x, c.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y, { steps: 8 });
  await page.mouse.move(c.x + 80, c.y + 20, { steps: 8 });
  await page.mouse.up();
  await a.settled();

  const after = await sketchOf(page);
  const [x1, y1] = centreOf(after);
  expect(x1 - x0, 'the centre moved right with the pointer').toBeGreaterThan(5);
  expect(y1).toBeLessThan(y0); // screen down is sketch -y on the Top plane
  const circle = after.entities.find((e) => e.kind === 'circle');
  expect(circle?.kind === 'circle' && circle.radius).toBeCloseTo(15, 6);
  const l1 = dimOf(after)?.label;
  expect(l1?.[0]).toBeCloseTo(l0[0] + (x1 - x0), 6);
  expect(l1?.[1]).toBeCloseTo(l0[1] + (y1 - y0), 6);
});

test('a click selects a dimension, Delete removes it, and the chip does too', async ({ page }) => {
  test.slow();
  await circleWithDiameter(page);
  const a = app(page);
  const label = page.locator('button[data-kind="diameter"]');
  await label.click();
  await expect(label).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('dimension-editor')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await sketchOf(page)).constraints.length).toBe(0);
  expect((await a.history()).past.at(-1)?.label).toBe('Delete constraint');

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await sketchOf(page)).constraints.length).toBe(1);
  await label.click();
  await page.getByRole('button', { name: 'Delete dimension' }).click();
  await expect.poll(async () => (await sketchOf(page)).constraints.length).toBe(0);

  // A second click on a selected label still edits.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await sketchOf(page)).constraints.length).toBe(1);
  await label.click();
  await label.click();
  await expect(page.getByTestId('dimension-editor').getByRole('textbox')).toBeFocused();
});
