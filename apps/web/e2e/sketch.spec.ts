import { expect, type Page, test } from '@playwright/test';
import type { SketchFeature } from '@whittle/contracts';
import { app, boot, cameraStill, clickAt, toPage } from './helpers';

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
  test.setTimeout(120_000);
  await boot(page);
  const a = app(page);
  await page.keyboard.press('s');
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).click();
  await cameraStill(page);
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
    [0, 0],
  ] as const) {
    await clickAt(page, x, y);
  }
  await expect.poll(async () => (await a.sketch())?.dof).toBe(4);
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
  await expect
    .poll(async () => {
      const p = await nearest(page, 50, 38);
      return Math.hypot(p.x - 50, p.y - 38) < 1;
    })
    .toBe(true);
  await page.keyboard.press('ControlOrMeta+z'); // the whole drag is one step
  await expect.poll(async () => nearest(page, start.x, start.y)).toEqual(start);

  // Right edge 30 mm, then the left edge 35 mm: over-constrained → fix in one click.
  await page.keyboard.press('d');
  await clickAt(page, 40, 15);
  await clickAt(page, 48, 15);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.press('Enter'); // keep the measured 30 mm
  await clickAt(page, 0, 15);
  await clickAt(page, -8, 15);
  await expect(editor).toBeFocused();
  await editor.fill('35');
  await editor.press('Enter');
  const panel = page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('sketch-status').first()).toContainText('Over-constrained');
  await panel.getByRole('button').filter({ hasNotText: /^$/ }).nth(1).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await a.sketch())?.status).toBe('solved');

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
