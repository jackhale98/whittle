import { devices, expect, type Page, test } from '@playwright/test';
import type { SketchFeature } from '@whittle/contracts';
import { addBox, app, boot, cameraState, cameraStill, toPage, topCenter, touch } from './helpers';

/**
 * Multi-touch in sketch mode on the iPad (D1, D9): before the Pencil is used, only a lone finger
 * draws. A second finger cancels the one-finger action and both navigate: a pinch zooms and
 * creates nothing, a two-finger tap undoes and leaves no anchor, a three-finger tap redoes, and the
 * next single tap draws normally. Two quick taps with a tool active are clicks, never "fit". In
 * model mode a pen tap with a finger resting on the glass still selects.
 */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

async function sketchOf(page: Page): Promise<SketchFeature | null> {
  const f = (await app(page).doc()).parts[0]?.features.find((x) => x.type === 'sketch');
  return f?.type === 'sketch' ? f : null;
}

async function counts(page: Page): Promise<{ lines: number; points: number }> {
  await app(page).settled();
  const s = await sketchOf(page);
  return {
    lines: s?.entities.filter((e) => e.kind === 'line').length ?? 0,
    points: s?.entities.filter((e) => e.kind === 'point').length ?? 0,
  };
}

test('sketch mode: pinch zooms, two/three-finger taps undo/redo, single taps still draw', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  const a = app(page);
  const t = await touch(page);
  await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await cameraStill(page);
  expect((await a.ui()).sketch?.tool).toBe('line'); // a new sketch starts with the line tool

  // 1. Pinch: one finger first (the line tool owns it), then a second → both navigate.
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const far = (await cameraState(page)).distance;
  await t.down([{ x: cx - 60, y: cy }]);
  await t.down([
    { x: cx - 60, y: cy },
    { x: cx + 60, y: cy },
  ]);
  for (let k = 1; k <= 10; k++)
    await t.move([
      { x: cx - 60 - k * 6, y: cy },
      { x: cx + 60 + k * 6, y: cy },
    ]);
  await t.up();
  await cameraStill(page);
  const near = (await cameraState(page)).distance;
  expect(near, 'the pinch zoomed in').toBeLessThan(far * 0.9);
  expect(await counts(page)).toEqual({ lines: 0, points: 0 });
  // No anchor was left behind: one tap only places the first point of a line.
  /** Page point of sketch (x, y); it must land on the canvas, not on the sheet or the rail. */
  const p = async (x: number, y: number) => {
    const q = await toPage(page, [x, y, 0]);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
      q,
    );
    expect(hit, `(${x}, ${y}) is on the canvas`).toBe('viewport-canvas');
    return q;
  };
  await t.tap([await p(12, 9)]);
  await page.waitForTimeout(400); // past the double-tap window
  expect(await counts(page)).toEqual({ lines: 0, points: 0 });
  await t.tap([await p(24, 9)]);
  await expect.poll(async () => (await counts(page)).lines).toBe(1);
  await page.keyboard.press('Escape'); // end the chain, keep the tool
  await page.waitForTimeout(400);

  // 2. Two quick nearby taps with the tool active: tool clicks, never "fit all".
  const before = await cameraState(page);
  await t.doubleTap(await p(-18, 12));
  await page.waitForTimeout(300);
  await cameraStill(page);
  expect((await cameraState(page)).distance).toBeCloseTo(before.distance, 6);
  expect(await counts(page)).toEqual({ lines: 1, points: 2 });
  // (Like a double-click, it ends the line chain it started; the tool stays.)
  expect((await a.ui()).sketch?.tool).toBe('line');
  await page.waitForTimeout(400);

  // 3. Two-finger tap: undo (the line goes) and no anchor is placed.
  await t.tap([await p(-10, 15), await p(10, 15)]);
  await expect.poll(async () => (await counts(page)).lines).toBe(0);
  await page.waitForTimeout(400);
  // 4. Three-finger tap: redo.
  await t.tap([await p(-10, 15), await p(10, 15), await p(0, 22)]);
  await expect.poll(async () => (await counts(page)).lines).toBe(1);
  await page.waitForTimeout(400);
  // 5. The next single taps behave normally: first point, then a line.
  await t.tap([await p(-24, 4)]);
  await page.waitForTimeout(400);
  expect((await counts(page)).lines).toBe(1);
  await t.tap([await p(-8, 4)]);
  await expect.poll(async () => (await counts(page)).lines).toBe(2);
  expect((await counts(page)).points).toBe(4);
});

test('model mode: a pen tap with a finger resting on the screen still selects (D9)', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  await addBox(page);
  const a = app(page);
  await a.idle();
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  const t = await touch(page);
  const top = await topCenter(page);
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  expect((await a.ui()).selection).toEqual([]);
  await t.pen.down(top);
  await t.down([{ x: box.x + box.width - 80, y: box.y + box.height - 80 }]); // a resting palm
  await t.pen.up(top);
  await expect.poll(async () => (await a.ui()).selection).toEqual(['face']);
  await t.up();
});
