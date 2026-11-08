import { expect, type Page, test } from '@playwright/test';
import type { DimensionConstraint, SketchFeature } from '@whittle/contracts';
import { app, boot, clickAt, sketchOn, toPage } from './helpers';

/**
 * Sketch editing details (PLAN §2.1, §9.2): a drag is one undo step, over-constraining explains
 * itself with a one-click fix, and a failing feature keeps its last good geometry as a ghost.
 */

async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features[0];
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}

/** The sketch point nearest to (x, y), sketch mm. */
async function nearest(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const s = await sketchOf(page);
  let best = { x: Number.NaN, y: Number.NaN, d: Number.POSITIVE_INFINITY };
  for (const e of s.entities) {
    if (e.kind !== 'point') continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < best.d) best = { x: e.x, y: e.y, d };
  }
  return { x: best.x, y: best.y };
}

test('drag is one undo step; conflicts offer a fix; a failing extrude leaves a ghost', async ({
  page,
}) => {
  test.slow(); // dozens of solves and regens; slow on 2-core software-GL CI runners
  await boot(page);
  const a = app(page);
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
  // From the origin along both axes: the corners snap to them (ADR-017), leaving width + height.
  await expect.poll(async () => (await a.sketch())?.dof).toBe(2);
  await page.keyboard.press('Escape'); // select tool

  // Drag the top-right corner: the rectangle stays a rectangle, and it is one undo step.
  const start = await nearest(page, 40, 30);
  const from = await toPage(page, [start.x, start.y, 0]);
  const to = await toPage(page, [50, 38, 0]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await a.settled();
  await expect
    .poll(async () => {
      const p = await nearest(page, 50, 38);
      return Math.hypot(p.x - 50, p.y - 38) < 1;
    })
    .toBe(true);
  await page.keyboard.press('ControlOrMeta+z'); // the whole drag is one step
  await expect.poll(async () => nearest(page, start.x, start.y)).toEqual(start);
  await a.settled();

  // Right edge 30 mm, then the left edge 35 mm: over-constrained → fix in one click.
  await page.keyboard.press('d');
  await clickAt(page, 40, 15);
  await clickAt(page, 48, 15);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.press('Enter'); // keep the measured 30 mm
  await expect(editor).toBeHidden();
  await a.settled();
  await clickAt(page, 0, 15);
  await clickAt(page, -8, 15);
  await expect(editor).toBeFocused();
  await editor.fill('35');
  await editor.press('Enter');
  const panel = page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('sketch-status').first()).toContainText('Over-constrained');
  // Fix labels wrap inside the card (no clipping).
  for (const b of await panel.locator('li button').all()) {
    const fits = await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, (await b.textContent()) ?? '').toBe(true);
  }
  await panel.locator('li').first().hover(); // highlights the conflicting constraints
  await page.screenshot({ path: 'test-results/m1-conflict-panel.png' });
  await panel.getByRole('button').filter({ hasNotText: /^$/ }).nth(1).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await a.sketch())?.status).toBe('solved');
  // Back to DOF colours: the hovered card's highlight is gone with it.
  await expect.poll(async () => (await a.ui()).sketch?.highlight ?? null).toBeNull();
  await page.screenshot({ path: 'test-results/m1-after-conflict-fix.png' });

  // Finish, extrude, then break it: depth 0 is an error, the last good body stays as a ghost.
  await page.getByTestId('finish-sketch').click();
  await page.keyboard.press('e');
  await a.idle();
  await clickAt(page, 20, 15);
  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await depth.fill('10');
  await depth.press('Enter');
  await a.idle();
  expect((await a.regen())?.bodies).toHaveLength(1);
  await depth.fill('0');
  await depth.press('Enter');
  await a.idle();
  const r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(['ok', 'error']);
  expect(r?.bodies).toHaveLength(0);
  await expect(page.getByTestId('feature-message')).toBeVisible();
  await page.screenshot({ path: 'test-results/m1-error-ghost.png' });
});

test('dimension tool: horizontal/vertical by placement, Ø ↔ R, driving ↔ reference', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  // Slanted lines (0,0)→(30,20) and (40,0)→(60,15), then a circle at (−20, 10) R 6.
  await clickAt(page, 0, 0);
  await clickAt(page, 30, 20);
  await page.keyboard.press('Escape');
  await clickAt(page, 40, 0);
  await clickAt(page, 60, 15);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+C');
  await clickAt(page, -20, 10);
  await clickAt(page, -14, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  const dims = async () => {
    await a.settled();
    return (await sketchOf(page)).constraints.filter((c): c is DimensionConstraint => 'value' in c);
  };

  // Both end points, label above their span: horizontal distance (positive, left → right).
  await clickAt(page, 0, 0);
  await clickAt(page, 30, 20);
  await clickAt(page, 15, 28);
  await expect(editor).toBeFocused();
  await editor.press('Enter');
  // The line itself, label right of it: vertical distance between its ends.
  await clickAt(page, 15, 10);
  await clickAt(page, 38, 10);
  await expect(editor).toBeFocused();
  await editor.press('Enter');
  // The other line, Shift while placing: aligned (its true length), wherever the label goes.
  await clickAt(page, 50, 7.5);
  await page.keyboard.down('Shift');
  await clickAt(page, 50, 22);
  await page.keyboard.up('Shift');
  await expect(editor).toBeFocused();
  await editor.press('Enter');
  let d = await dims();
  expect(d.map((c) => c.kind)).toEqual(['hDistance', 'vDistance', 'length']);
  // Measured from clicked geometry (rounded to 0.01 mm), positive left → right / bottom → top.
  const mm = d.map((c) => Number.parseFloat(c.value));
  expect(mm[0]).toBeCloseTo(30, 1);
  expect(mm[1]).toBeCloseTo(20, 1);
  expect(mm[2]).toBeCloseTo(25, 1);

  // Circle → diameter; the label's toggle makes it a radius (expression converted).
  await clickAt(page, -26, 10);
  await clickAt(page, -30, 20);
  await expect(editor).toBeFocused();
  const kindToggle = page.getByTestId('dimension-toggle-kind');
  await expect(kindToggle).toHaveText('Ø → R');
  await kindToggle.click();
  await expect.poll(async () => (await dims()).at(-1)?.kind).toBe('radius');
  d = await dims();
  expect(d.at(-1)?.value).toBe('6 mm');

  // Driving → reference (shown in parentheses), and back to driving from the selected label.
  await page.keyboard.press('Escape');
  await page.locator('button[data-kind="hDistance"]').click();
  await expect(editor).toBeFocused();
  await page.getByTestId('dimension-toggle-driving').click();
  await expect.poll(async () => (await dims())[0]?.driving).toBe(false);
  const ref = page.getByRole('button', { name: /^Reference dimension: / }).first();
  await expect(ref).toHaveText(/^\(.*\)$/);
  await page.screenshot({ path: 'test-results/m1-dimension-reference.png' });
  await ref.click();
  await page.getByTestId('dimension-toggle-driving').click();
  await expect.poll(async () => (await dims())[0]?.driving).toBe(true);
  // Back to driving at its measured value (no jump).
  expect(Number.parseFloat((await dims())[0]?.value ?? '')).toBeCloseTo(mm[0] as number, 1);
});
