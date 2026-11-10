import { devices, expect, type Page, test } from '@playwright/test';
import type { SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { app, boot, palette } from './helpers';

/**
 * M3.6 acceptance, sketch visibility: a consumed sketch is hidden by default; its eye toggle in
 * the tree (nested or flat) shows it and the setting is document data (it survives save ->
 * reload); hiding it again, or "Reset to automatic", restores the default; "Show all sketches" /
 * "Hide all sketches" / "Reset sketch visibility" in the palette write one undo entry each.
 * "Shown" is what the viewport holds (`shownSketches`), not just what the tree says.
 */

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const sketches = async (page: Page) =>
  (await part(page)).features.filter((f): f is SketchFeature => f.type === 'sketch');
const sketchId = async (page: Page, name: string) =>
  (await sketches(page)).find((s) => s.name === name)?.id as string;
const visibility = async (page: Page, name: string) =>
  (await sketches(page)).find((s) => s.name === name)?.visibility;
const shown = async (page: Page) => (await app(page).shownSketches()).sort();
const tree = (page: Page) => page.getByTestId('feature-tree');

async function openDemo(page: Page, how: 'click' | 'tap') {
  await boot(page);
  await page.getByTestId('open-demo')[how]();
  await expect.poll(async () => (await part(page)).features.length).toBe(9);
  await app(page).idle();
}

/** The eye of a sketch row (nested under its feature until that is expanded). */
async function eye(page: Page, sketch: string, how: 'click' | 'tap') {
  const named = tree(page).getByRole('button', { name: new RegExp(`^(Show|Hide) ${sketch}`) });
  if ((await named.count()) === 0) {
    const owner = { 'Plate sketch': 'Plate', 'Hole sketch': 'Holes', 'Upright sketch': 'Upright' }[
      sketch
    ] as string;
    await tree(page).locator(`[data-testid="nest-toggle"][aria-label="Expand ${owner}"]`)[how]();
  }
  return named;
}

test('a consumed sketch: the eye shows it, it survives save -> reload, hiding or resetting restores the default', async ({
  page,
}) => {
  test.slow();
  await openDemo(page, 'click');
  const a = app(page);
  expect(await shown(page)).toEqual([]); // all three are consumed: hidden by default
  const plate = await sketchId(page, 'Plate sketch');
  const past0 = (await a.history()).past.length;

  // The eye of a nested sketch: automatic (a dot marks it), off.
  const e = await eye(page, 'Plate sketch', 'click');
  await expect(e).toHaveAttribute('data-shown', 'false');
  await expect(e).toHaveAttribute('data-visibility', 'auto');
  await expect(e.getByTestId('auto-marker')).toBeVisible();

  // Show it: the viewport holds the sketch, the document says so, one undo entry.
  await e.click();
  await expect.poll(() => shown(page)).toEqual([plate]);
  expect(await visibility(page, 'Plate sketch')).toBe('shown');
  expect((await a.history()).past.length).toBe(past0 + 1);
  await expect(e).toHaveAttribute('data-shown', 'true');
  await expect(e).toHaveAttribute('data-visibility', 'shown');
  await expect(e).toHaveAccessibleName('Hide Plate sketch');
  // Others are untouched.
  expect(await visibility(page, 'Hole sketch')).toBeUndefined();

  // Save -> reload: still shown (document data, not view state).
  await a.idle();
  await a.flushSave();
  await page.reload();
  await boot(page);
  await expect.poll(async () => visibility(page, 'Plate sketch')).toBe('shown');
  await expect.poll(() => shown(page)).toEqual([plate]);
  const again = await eye(page, 'Plate sketch', 'click');
  await expect(again).toHaveAttribute('data-shown', 'true');

  // Hide it again: back to the default look (consumed = not shown), explicitly hidden.
  await again.click();
  await expect.poll(() => shown(page)).toEqual([]);
  expect(await visibility(page, 'Plate sketch')).toBe('hidden');

  // "Reset to automatic" (row menu) restores the rule itself, not just the look.
  await tree(page)
    .getByRole('treeitem', { name: /^Plate sketch/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in viewport' }).click();
  await expect.poll(() => shown(page)).toEqual([plate]);
  await tree(page)
    .getByRole('treeitem', { name: /^Plate sketch/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset to automatic' }).click();
  await expect.poll(() => shown(page)).toEqual([]);
  expect([undefined, 'auto']).toContain(await visibility(page, 'Plate sketch'));
  await expect(await eye(page, 'Plate sketch', 'click')).toHaveAttribute('data-visibility', 'auto');
});

test('Show all / Hide all / Reset sketch visibility from the palette: one undo entry each, flat mode too', async ({
  page,
}) => {
  test.slow();
  await openDemo(page, 'click');
  const a = app(page);
  const all = (await sketches(page)).map((s) => s.id).sort();
  expect(all).toHaveLength(3);
  const past0 = (await a.history()).past.length;

  await palette(page, 'Show all sketches');
  await expect.poll(() => shown(page)).toEqual(all);
  expect((await sketches(page)).every((s) => s.visibility === 'shown')).toBe(true);
  expect((await a.history()).past.length).toBe(past0 + 1);

  await palette(page, 'Hide all sketches');
  await expect.poll(() => shown(page)).toEqual([]);
  expect((await sketches(page)).every((s) => s.visibility === 'hidden')).toBe(true);
  expect((await a.history()).past.length).toBe(past0 + 2);

  // One undo restores the previous state in a single step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => shown(page)).toEqual(all);
  expect((await a.history()).past.length).toBe(past0 + 1);

  await palette(page, 'Reset sketch visibility');
  await expect.poll(() => shown(page)).toEqual([]);
  expect((await sketches(page)).every((s) => !s.visibility || s.visibility === 'auto')).toBe(true);

  // Flat mode: the sketch rows are top level and carry the same eye.
  await palette(page, 'Show sketches in the history');
  const holeEye = tree(page).getByRole('button', { name: 'Show Hole sketch' });
  await expect(holeEye).toBeVisible();
  await holeEye.click();
  await expect.poll(() => shown(page)).toEqual([await sketchId(page, 'Hole sketch')]);
  await expect(tree(page).getByRole('button', { name: 'Hide Hole sketch' })).toBeVisible();
  await palette(page, 'Nest sketches under their features');
});

test('rollback: a sketch whose feature is rolled back shows by default; an explicit hide still hides it', async ({
  page,
}) => {
  test.slow();
  await openDemo(page, 'click');
  const a = app(page);
  const plate = await sketchId(page, 'Plate sketch');
  const p = await part(page);
  expect(await shown(page)).toEqual([]);

  // Roll back to just the sketch: nothing consumes it any more.
  expect(await a.apply({ kind: 'setRollback', partId: p.id, index: 1 })).toBe(true);
  await a.idle();
  await expect.poll(() => shown(page)).toEqual([plate]);

  // Hidden is honoured even though nothing consumes the sketch.
  expect(
    await a.apply({
      kind: 'setSketchVisibility',
      partId: p.id,
      featureIds: [plate],
      visibility: 'hidden',
    }),
  ).toBe(true);
  await a.idle();
  await expect.poll(() => shown(page)).toEqual([]);

  // Back to the full model: still hidden.
  expect(await a.apply({ kind: 'setRollback', partId: p.id, index: 9 })).toBe(true);
  await a.idle();
  expect(await shown(page)).toEqual([]);
});

test.describe('tablet', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });

  test('the eye works by touch in the tablet sheet', async ({ page }) => {
    test.slow();
    await openDemo(page, 'tap');
    const a = app(page);
    const plate = await sketchId(page, 'Plate sketch');
    const sheet = page.getByTestId('history-sheet');
    await sheet
      .getByRole('button', { name: /History/ })
      .first()
      .tap();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    const e = await eye(page, 'Plate sketch', 'tap');
    await e.tap();
    await expect.poll(() => shown(page)).toEqual([plate]);
    expect(await visibility(page, 'Plate sketch')).toBe('shown');
    await e.tap();
    await expect.poll(() => shown(page)).toEqual([]);
    expect(await a.history().then((h) => h.past.length)).toBeGreaterThan(0);
  });
});
