import { devices, expect, type Page, test } from '@playwright/test';
import type { SketchFeature } from '@wren-cad/contracts';
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
  test.setTimeout(180_000); // many touch round trips; slow on software GL under load
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

test('a pinch during a finger drag of a sketch point ends the drag (M2 re-gate N1)', async ({
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
  // One line, then leave the line tool (select mode: a finger on a point drags it).
  await t.tap([await toPage(page, [-20, 10, 0])]);
  await a.settled();
  await t.tap([await toPage(page, [20, 10, 0])]);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await a.idle();
  const points = async () =>
    ((await sketchOf(page))?.entities ?? [])
      .filter((e) => e.kind === 'point')
      .map((e) => (e.kind === 'point' ? [e.x, e.y] : [0, 0]));

  // Drag the right end a little with one finger, then add a second finger and pinch.
  const end = await toPage(page, [20, 10, 0]);
  await t.down([end]);
  for (let k = 1; k <= 5; k++) await t.move([{ x: end.x + k * 4, y: end.y }]);
  const f1 = { x: end.x + 20, y: end.y };
  const f2 = { x: end.x + 150, y: end.y + 80 };
  await t.down([f1, f2]);
  for (let k = 1; k <= 6; k++)
    await t.move([
      { x: f1.x - k * 5, y: f1.y },
      { x: f2.x + k * 5, y: f2.y },
    ]);
  await t.up();
  await a.idle();
  const afterPinch = await points();

  // A later one-finger orbit on empty space must not move any sketch point.
  await cameraStill(page);
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const from = { x: box.x + 200, y: box.y + box.height - 220 };
  await t.drag(from, { x: from.x + 60, y: from.y - 40 });
  await a.idle();
  expect(await points()).toEqual(afterPinch);
  // The drag's result before the pinch was kept as an ordinary, undoable edit.
  expect(afterPinch.some(([x]) => (x as number) > 20.5)).toBe(true);
});

test('sketch mode: a one-finger drag on empty space orbits; presses the sketch keeps do not (M3.5 N4)', async ({
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
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const from = { x: box.x + 200, y: box.y + box.height - 220 };
  const to = { x: from.x + 90, y: from.y - 60 };
  const moved = async (run: () => Promise<void>): Promise<number> => {
    await cameraStill(page);
    const before = (await cameraState(page)).position as number[];
    await run();
    await cameraStill(page);
    const after = (await cameraState(page)).position as number[];
    return Math.hypot(...after.map((v, i) => v - (before[i] ?? 0)));
  };
  const penDrag = async (a0: { x: number; y: number }, b0: { x: number; y: number }) => {
    await t.pen.down(a0);
    for (let k = 1; k <= 8; k++)
      await t.pen.move({
        x: a0.x + ((b0.x - a0.x) * k) / 8,
        y: a0.y + ((b0.y - a0.y) * k) / 8,
      });
    await t.pen.up(b0);
  };

  const total = async () => {
    const c = await counts(page);
    return c.lines + c.points;
  };
  const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const lineTool = tools.getByRole('button', { name: 'Line', exact: true });

  // 1. No tool, before any Pencil input (the Pencil hands later fingers to the camera), on a spot
  //    with nothing drawn: a one-finger drag orbits and the sketch stays open.
  await lineTool.tap();
  await expect.poll(async () => (await a.ui()).sketch?.tool ?? null).toBeNull();
  expect((await a.ui()).sketch, 'still sketching').not.toBeNull();
  // Up and right, like the line strokes below: from the straight-down sketch view a downward drag
  // would push a turntable orbit over the pole (clamped, it only spins about the view axis).
  const empty = { x: box.x + box.width - 300, y: box.y + 320 };
  const emptyTo = { x: empty.x + 90, y: empty.y - 60 };
  expect(await total(), 'nothing drawn yet').toBe(0);
  const orbit = await moved(() => t.drag(empty, emptyTo));
  expect(orbit, 'one-finger drag on empty space in select mode').toBeGreaterThan(1);
  expect((await a.ui()).sketch, 'orbiting keeps the sketch open').not.toBeNull();
  expect(await total(), 'orbiting draws nothing').toBe(0);
  // Back to the plane view, so the next strokes land on the sketch plane where expected.
  await page.keyboard.press('Digit5'); // Top view
  await cameraStill(page);

  // 2. The line tool: a finger drag draws a line and never orbits.
  await lineTool.tap();
  await expect.poll(async () => (await a.ui()).sketch?.tool ?? null).toBe('line');
  const lines0 = (await counts(page)).lines;
  expect(await moved(() => t.drag(from, to)), 'finger drag with the line tool').toBeLessThan(1e-6);
  expect((await counts(page)).lines, 'the finger drag drew a line').toBe(lines0 + 1);
  await page.keyboard.press('Escape'); // end the chain, keep the tool
  await expect.poll(async () => (await a.ui()).sketch?.tool ?? null).toBe('line');

  // 3. The Pencil with the line tool draws too, and never orbits.
  const from2 = { x: from.x, y: from.y - 120 };
  const to2 = { x: to.x, y: to.y - 120 };
  const lines1 = (await counts(page)).lines;
  expect(await moved(() => penDrag(from2, to2)), 'Pencil drag with the line tool').toBeLessThan(
    1e-6,
  );
  expect((await counts(page)).lines, 'the Pencil drag drew a line').toBe(lines1 + 1);

  // 4. No tool: the Pencil draws a recognised stroke instead of navigating.
  await page.keyboard.press('Escape');
  await lineTool.tap();
  await expect.poll(async () => (await a.ui()).sketch?.tool ?? null).toBeNull();
  expect((await a.ui()).sketch, 'still sketching').not.toBeNull();
  const from3 = { x: from.x, y: from.y - 240 };
  const to3 = { x: to.x, y: to.y - 240 };
  const before = await total();
  expect(await moved(() => penDrag(from3, to3)), 'Pencil drag with no tool').toBeLessThan(1e-6);
  expect(await total(), 'the Pencil stroke drew geometry').toBeGreaterThan(before);
});
