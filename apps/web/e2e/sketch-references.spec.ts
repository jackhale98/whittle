import { expect, type Page, test } from '@playwright/test';
import type { DimensionConstraint, SketchFeature } from '@whittle/contracts';
import { app, boot, clickAt, sketchOn } from './helpers';

/**
 * Dimensions to the sketch's origin and axes (ADR-017 item 1): a rectangle anchored only by
 * dimensions from the origin is fully constrained without `fix`; editing the origin distance moves
 * it; a circle's centre is dimensioned to the vertical axis.
 */

test.use({ viewport: { width: 1280, height: 720 } });

async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features[0];
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}

/** The sketch point nearest to (x, y), sketch mm (the solver moves points as dimensions land). */
async function nearest(page: Page, x: number, y: number): Promise<[number, number]> {
  const s = await sketchOf(page);
  let best: [number, number] = [Number.NaN, Number.NaN];
  let bd = Number.POSITIVE_INFINITY;
  for (const e of s.entities) {
    if (e.kind !== 'point') continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bd) {
      bd = d;
      best = [e.x, e.y];
    }
  }
  return best;
}

/** Dimension tool: click the picks, then the label position, type `expr`. */
async function dimension(
  page: Page,
  picks: [number, number][],
  label: [number, number],
  expr: string,
) {
  for (const [x, y] of picks) await clickAt(page, x, y);
  await clickAt(page, label[0], label[1]);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill(expr);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await app(page).settled();
}

async function dims(page: Page): Promise<DimensionConstraint[]> {
  await app(page).settled();
  return (await sketchOf(page)).constraints.filter((c): c is DimensionConstraint => 'value' in c);
}

test('a rectangle dimensioned from the origin is fully constrained without fix', async ({
  page,
}) => {
  test.slow(); // a dozen solves and regens on software GL
  await boot(page);
  const a = app(page);
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');

  // Rectangle away from the axes (no snaps to them), drawn off the target size.
  await page.getByRole('button', { name: 'Rectangle' }).click();
  await clickAt(page, 13, 8);
  await clickAt(page, 51, 29);
  await a.settled();
  await page.keyboard.press('Escape');
  const before = await sketchOf(page);
  expect(
    before.constraints.some((c) => JSON.stringify(c).includes('"@')),
    'no reference snaps',
  ).toBe(false);

  await page.keyboard.press('d');
  // Corner ↔ origin, label below their span: horizontal 10 mm.
  let corner = await nearest(page, 13, 8);
  await dimension(page, [corner, [0, 0]], [corner[0] / 2, -9], '10 mm');
  // Corner ↔ origin, label left of their span: vertical 5 mm.
  corner = await nearest(page, 10, 8);
  await dimension(page, [corner, [0, 0]], [-9, corner[1] / 2], '5 mm');
  corner = await nearest(page, 10, 5);
  expect(corner[0]).toBeCloseTo(10, 6);
  expect(corner[1]).toBeCloseTo(5, 6);
  // Width (bottom edge) and height (left edge).
  const far = await nearest(page, 51, 29);
  await dimension(
    page,
    [[(corner[0] + far[0]) / 2, corner[1]]],
    [(corner[0] + far[0]) / 2, 12],
    '40 mm',
  );
  await dimension(
    page,
    [[corner[0], (corner[1] + far[1]) / 2]],
    [16, (corner[1] + far[1]) / 2],
    '20 mm',
  );

  const d = await dims(page);
  expect(d.map((c) => c.kind)).toEqual(['hDistance', 'vDistance', 'length', 'length']);
  expect(d.slice(0, 2).map((c) => ('a' in c ? c.a : null))).toEqual(['@origin', '@origin']);
  const s = await sketchOf(page);
  expect(s.constraints.some((c) => c.kind === 'fix')).toBe(false);
  expect(s.entities.some((e) => e.id.startsWith('@'))).toBe(false);
  await expect.poll(async () => (await a.sketch())?.dof).toBe(0);
  await expect(page.getByTestId('sketch-status').first()).toContainText('Fully constrained');
  await expect(page.getByTestId('sketch-status').first()).not.toContainText('redundant');
  const opposite = await nearest(page, 50, 25);
  expect(opposite[0]).toBeCloseTo(50, 6);
  expect(opposite[1]).toBeCloseTo(25, 6);
  await page.mouse.move(5, 5); // no hover highlight in the shot
  await page.screenshot({ path: 'test-results/sketch-references-origin.png' });

  // Edit the 10 mm: the rectangle moves with it.
  await page.keyboard.press('Escape'); // select tool
  await page.locator('button[data-kind="hDistance"]').click();
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill('25 mm');
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await a.settled();
  await expect.poll(async () => (await nearest(page, 25, 5))[0]).toBeCloseTo(25, 6);
  expect((await nearest(page, 65, 25))[0]).toBeCloseTo(65, 6);
  expect((await nearest(page, 65, 25))[1]).toBeCloseTo(25, 6);
  expect((await a.sketch())?.dof).toBe(0);

  // A circle away from the axes; its centre dimensioned to the vertical axis (pick the circle,
  // then the axis).
  await page.keyboard.press('Shift+C');
  await clickAt(page, -30, 32);
  await clickAt(page, -26, 32);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await dimension(
    page,
    [
      [-26, 32],
      [0, 44],
    ],
    [-15, 40],
    '35 mm',
  );
  const last = (await dims(page)).at(-1);
  expect(last?.kind).toBe('distance');
  expect(last && 'b' in last ? last.b : null).toBe('@y');
  const circle = (await sketchOf(page)).entities.find((e) => e.kind === 'circle');
  const center =
    circle?.kind === 'circle'
      ? (await sketchOf(page)).entities.find((e) => e.id === circle.center)
      : undefined;
  expect(center?.kind === 'point' ? center.x : null).toBeCloseTo(-35, 6);
  expect(center?.kind === 'point' ? center.y : null).toBeCloseTo(32, 0);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: 'test-results/sketch-references-axis.png' });

  // The finished sketch regenerates (same solver core in the kernel worker).
  await page.getByTestId('finish-sketch').click();
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok']);
});
