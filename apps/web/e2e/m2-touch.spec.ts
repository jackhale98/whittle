import { devices, expect, type Page, test } from '@playwright/test';
import {
  addBox,
  app,
  boot,
  cameraState,
  cameraStill,
  tool,
  toPage,
  topCenter,
  touch,
  touchStats,
} from './helpers';
import { expectTouchTarget } from './targets';

/**
 * M2 on the tablet shell with touch and Pencil (PLAN §9.3 gesture map): taps select through the
 * viewport's gestures (exactly once), the context bubble, double-tap zoom, long-press, two- and
 * three-finger undo/redo, push/pull with a finger and the inline keypad, the Measure tool, and
 * Pencil strokes recognised in sketch mode.
 */

const SHOTS = process.env.WHITTLE_SHOTS;

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

async function tabletBox(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  await addBox(page);
  await app(page).idle();
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
}

const bubble = (page: Page) => page.getByTestId('context-bubble');

/**
 * A point on the canvas with no geometry under it and no panel over it. After a zoom the part can
 * fill most of the view, and where exactly depends on the renderer, so "empty space" is searched
 * for rather than assumed.
 */
async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
  const spot = await page.evaluate(() => {
    const v = (
      window as unknown as {
        __whittleViewport: { pick(x: number, y: number, o: object): unknown[] };
      }
    ).__whittleViewport;
    const canvas = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
    const r = canvas.getBoundingClientRect();
    for (let fy = 0.25; fy <= 0.85; fy += 0.05) {
      for (let fx = 0.95; fx >= 0.15; fx -= 0.05) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (document.elementFromPoint(x, y) !== canvas) continue; // a panel or chip is there
        const hits = v.pick(x - r.left, y - r.top, {
          kinds: ['face', 'edge', 'vertex'],
          tolerancePx: 30,
          all: true,
        });
        if (hits.length === 0) return { x, y };
      }
    }
    return null;
  });
  if (!spot) throw new Error('no empty spot on the canvas');
  return spot;
}

type Box = { x: number; y: number; width: number; height: number } | null;
/** Two page boxes intersect (a missing box never counts as clear). */
const boxesOverlap = (r: Box, s: Box): boolean =>
  !r ||
  !s ||
  (r.x < s.x + s.width && s.x < r.x + r.width && r.y < s.y + s.height && s.y < r.y + r.height);

test('touch taps select once; bubble; double-tap zoom; long-press; 2/3-finger undo/redo', async ({
  page,
}) => {
  test.slow();
  await tabletBox(page);
  const a = app(page);
  expect(await page.getByTestId('app-shell').getAttribute('data-tier')).toBe('tablet');
  const t = await touch(page);

  // One tap = one pick (the gesture path; pointer-up ignores touch in model mode).
  const before = (await a.ui()).choices;
  const top = await topCenter(page);
  await t.tap([top]);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['face']);
  expect((await a.ui()).choices).toBe(before + 1);
  await expect(bubble(page)).toBeVisible();
  await expect(bubble(page).locator('[data-action]')).toHaveCount(3);
  for (const id of ['sketch', 'pushPull', 'measure'])
    await expect(bubble(page).locator(`[data-action="${id}"]`)).toBeVisible();
  // The bubble stays clear of the top bar and the rail.
  const bb = await bubble(page).boundingBox();
  expect(boxesOverlap(bb, await page.getByTestId('top-bar').boundingBox())).toBe(false);
  expect(
    boxesOverlap(bb, await page.getByRole('toolbar', { name: 'Modeling tools' }).boundingBox()),
  ).toBe(false);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-landscape-rail-bubble.png` });

  // Double-tap on the face zooms to it; on empty space it fits everything.
  const far = (await cameraState(page)).distance;
  await t.doubleTap(top);
  await cameraStill(page);
  const near = (await cameraState(page)).distance;
  expect(near).toBeLessThan(far * 0.9);
  await t.doubleTap(await emptySpot(page));
  await cameraStill(page);
  expect((await cameraState(page)).distance).toBeGreaterThan(near * 1.1);

  // Long-press on empty space: the view actions.
  await t.down([{ x: 1100, y: 600 }]);
  await expect(bubble(page).locator('[data-action="fit"]')).toBeVisible();
  await t.up();
  await expect(bubble(page).locator('[data-action="undo"]')).toBeVisible();
  await bubble(page).locator('[data-action="fit"]').tap();
  await expect(bubble(page)).toHaveCount(0);

  // Two-finger tap = undo (the box goes), three-finger tap = redo.
  await t.tap([
    { x: 900, y: 500 },
    { x: 960, y: 500 },
  ]);
  await a.idle();
  expect((await a.doc()).parts[0]?.features).toHaveLength(0);
  await t.tap([
    { x: 900, y: 500 },
    { x: 960, y: 500 },
    { x: 1020, y: 500 },
  ]);
  await a.idle();
  expect((await a.doc()).parts[0]?.features).toHaveLength(1);
});

test('push/pull with a finger: bubble → arrow drag → feature; then a keypad value', async ({
  page,
}) => {
  test.slow();
  await tabletBox(page);
  const a = app(page);
  const t = await touch(page);
  const b = (await a.regen())?.bodies[0]?.bbox;
  const centre: [number, number, number] = [
    ((b?.min[0] ?? 0) + (b?.max[0] ?? 0)) / 2,
    ((b?.min[1] ?? 0) + (b?.max[1] ?? 0)) / 2,
    b?.max[2] ?? 0,
  ];
  const top = await topCenter(page);
  await t.tap([top]);
  await a.idle();
  await bubble(page).locator('[data-action="pushPull"]').tap();
  await expect.poll(async () => (await a.ui()).pushPull?.faces).toBe(1);

  // Drag the arrow with a finger: along the screen image of +Z.
  const base = await toPage(page, centre);
  const up = await toPage(page, [centre[0], centre[1], centre[2] + 5]);
  const l = Math.hypot(up.x - base.x, up.y - base.y);
  const dir = { x: (up.x - base.x) / l, y: (up.y - base.y) / l };
  const grip = { x: base.x + dir.x * 45, y: base.y + dir.y * 45 };
  const to = { x: grip.x + dir.x * 100, y: grip.y + dir.y * 100 };
  const builds = (await touchStats(page)).prismBuilds;
  await t.down([grip]);
  for (let k = 1; k <= 10; k++)
    await t.move([
      { x: grip.x + ((to.x - grip.x) * k) / 10, y: grip.y + ((to.y - grip.y) * k) / 10 },
    ]);
  await expect.poll(async () => (await a.ui()).pushPull?.dragging).toBe(true);
  expect((await touchStats(page)).prismBuilds).toBe(builds + 1);
  await expect(page.getByTestId('value-chip')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-push-pull-drag-chip.png` });
  await t.up();
  await a.idle();
  const f = (await a.doc()).parts[0]?.features.at(-1);
  expect(f?.type).toBe('pushPull');
  const d = f?.type === 'pushPull' ? Number.parseFloat(f.distance) : 0;
  expect(d).toBeGreaterThan(2);
  expect((await a.regen())?.bodies[0]?.volume).toBeCloseTo(40 * 30 * (20 + d), 0);

  // Again, this time typed on the keypad: tap the chip, AC, 4, mm, Enter.
  const top2 = await topCenter(page);
  await t.tap([top2]);
  await a.idle();
  await bubble(page).locator('[data-action="pushPull"]').tap();
  await page.getByTestId('value-chip').getByRole('button').tap();
  const keypad = page.getByTestId('keypad');
  await expect(keypad).toBeVisible();
  await keypad.getByRole('button', { name: 'AC (clear)' }).tap();
  await keypad.getByRole('button', { name: '4', exact: true }).tap();
  await keypad.getByRole('button', { name: 'mm (millimetres)' }).tap();
  await keypad.getByRole('button', { name: 'Enter' }).tap();
  await a.idle();
  const g = (await a.doc()).parts[0]?.features.at(-1);
  expect(g?.type === 'pushPull' && g.distance.replace(/\s/g, '')).toBe('4mm');
  expect((await a.regen())?.bodies[0]?.volume).toBeCloseTo(40 * 30 * (24 + d), 0);
});

test('Inspect → Measure on the tablet: taps pick, the sheet shows the reading', async ({
  page,
}) => {
  test.slow();
  await tabletBox(page);
  const a = app(page);
  await tool(page, 'measure', 'tap');
  await expect(page.getByTestId('history-sheet')).toHaveAttribute('data-snap', 'half');
  await expect(page.getByTestId('measure-inspector')).toBeVisible();
  const top = await topCenter(page);
  const t = await touch(page);
  await t.tap([top]);
  await a.idle();
  await expect(page.getByTestId('measure-reading')).toHaveAttribute('data-kind', 'area');
  await expect(page.getByTestId('measure-label')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-measure.png` });
});

test('Pencil: strokes are recognised live and committed; fingers never draw while it is in use', async ({
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

  // A rectangle, drawn as one stroke.
  const corners: Array<[number, number]> = [
    [-30, -20],
    [30, -20],
    [30, 20],
    [-30, 20],
    [-30, -20],
  ];
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [x0, y0] = corners[i] as [number, number];
    const [x1, y1] = corners[i + 1] as [number, number];
    for (let k = 0; k < 12; k++) {
      const u = k / 12;
      pts.push(
        await toPage(page, [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + Math.sin(k) * 0.15, 0]),
      );
    }
  }
  pts.push(await toPage(page, [-30, -20, 0]));
  await t.pen.down(pts[0] as { x: number; y: number });
  for (const p of pts.slice(1)) await t.pen.move(p);
  // Live feedback while the Pencil is still down.
  await expect(page.getByTestId('stroke-shape')).toHaveAttribute('data-shape', 'rectangle');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-pencil-stroke.png` });
  await t.pen.up(pts.at(-1) as { x: number; y: number });
  await a.settled();
  expect((await a.ui()).sketch?.lastStroke?.shape).toBe('rectangle');
  const sk = (await a.doc()).parts[0]?.features[0];
  if (sk?.type !== 'sketch') throw new Error('no sketch');
  expect(sk.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
  expect((await a.sketch())?.status).not.toBe('failed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-pencil-recognised.png` });

  // The line tool is active, but a finger tap no longer draws: fingers navigate.
  const n = sk.entities.length;
  const p = await toPage(page, [50, 40, 0]);
  await t.tap([p]);
  await t.tap([{ x: p.x + 40, y: p.y }]);
  await a.settled();
  const after = (await a.doc()).parts[0]?.features[0];
  expect(after?.type === 'sketch' && after.entities.length).toBe(n);

  // A Pencil line from a corner snaps onto it (end-point inference).
  const from = await toPage(page, [30.4, 20.3, 0]);
  const toP = await toPage(page, [30.2, 50, 0]);
  await t.pen.down(from);
  for (let k = 1; k <= 12; k++)
    await t.pen.move({
      x: from.x + ((toP.x - from.x) * k) / 12,
      y: from.y + ((toP.y - from.y) * k) / 12,
    });
  await t.pen.up(toP);
  await a.settled();
  expect((await a.ui()).sketch?.lastStroke?.shape).toBe('line');
  const sk2 = (await a.doc()).parts[0]?.features[0];
  if (sk2?.type !== 'sketch') throw new Error('no sketch');
  expect(sk2.constraints.some((c) => c.kind === 'coincident')).toBe(true);
  expect(sk2.entities.filter((e) => e.kind === 'line')).toHaveLength(5);
});

test('Pencil hover preselects; a Pencil tap selects in model mode', async ({ page }) => {
  test.slow();
  await tabletBox(page);
  const a = app(page);
  const t = await touch(page);
  const top = await topCenter(page);
  await t.pen.hover(top);
  await expect.poll(async () => (await a.ui()).hover).toBe('face');
  await t.pen.down(top);
  await t.pen.up(top);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['face']);
});

test('portrait: the bubble and overlays stay clear of the rail, top bar and sheet', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 820, height: 1180 });
  await tabletBox(page);
  const a = app(page);
  const t = await touch(page);
  await t.tap([await topCenter(page)]);
  await a.idle();
  await expect(bubble(page)).toBeVisible();
  const overlap = (
    r: { x: number; y: number; width: number; height: number } | null,
    s: typeof r,
  ) =>
    !!r &&
    !!s &&
    r.x < s.x + s.width &&
    s.x < r.x + r.width &&
    r.y < s.y + s.height &&
    s.y < r.y + r.height;
  const b = await bubble(page).boundingBox();
  const library = await page.getByTestId('library-button').boundingBox();
  for (const chrome of [
    await page.getByTestId('top-bar').boundingBox(),
    await page.getByRole('toolbar', { name: 'Modeling tools' }).boundingBox(),
    await page.getByTestId('history-sheet').boundingBox(),
  ]) {
    expect(overlap(b, chrome)).toBe(false);
    expect(overlap(library, chrome)).toBe(false);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-portrait-rail-bubble.png` });
});

test('touch targets: welcome actions, Close, Library and the prompt Esc are 44 px', async ({
  page,
}) => {
  await boot(page);
  const welcome = page.getByTestId('welcome');
  const actions = welcome.getByRole('button');
  expect(await actions.count()).toBeGreaterThanOrEqual(5);
  for (const b of await actions.all()) {
    await expectTouchTarget(
      b,
      (await b.getAttribute('aria-label')) ?? ((await b.textContent()) || 'button'),
    );
  }
  await expectTouchTarget(welcome.getByTestId('take-tour'), 'Take the 60-second tour');
  await expectTouchTarget(page.getByRole('button', { name: 'Close welcome' }), 'Close welcome');
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  await expectTouchTarget(page.getByTestId('library-button'), 'Library');
  await page.locator('[data-tool-group="sketch"]').tap();
  const chip = page.getByTestId('prompt-chip');
  await expect(chip).toContainText('Select a plane');
  await expectTouchTarget(chip.getByRole('button', { name: /cancel selection/ }), 'Esc');
});
