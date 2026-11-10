import { devices, expect, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraStill, tool, toPage, touch } from './helpers';

/**
 * Owner's tablet findings (2026-11-10, PLAN M3.5 "Owner additions"): a visible way to drop the
 * active sketch tool, a visible way to clear a selection, and a sketch hiding once the feature
 * that consumed it is no longer being edited. iPad emulation, touch only.
 */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

async function openTablet(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
}

async function newSketch(page: Page) {
  await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
  const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(tools).toBeVisible();
  await cameraStill(page);
  return tools;
}

test('Select tool and the Done ✕ return a sketch to selection; the Pencil still draws freehand', async ({
  page,
}) => {
  test.slow();
  await openTablet(page);
  const a = app(page);
  const t = await touch(page);
  const tools = await newSketch(page);
  const tool = async () => (await a.ui()).sketch?.tool ?? null;

  // A new sketch starts with the line tool; Select is first and not pressed, Done names the tool.
  expect(await tool()).toBe('line');
  const select = tools.getByRole('button', { name: 'Select', exact: true });
  await expect(select).toBeVisible();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  const done = tools.getByRole('button', { name: 'Done with Line' });
  await expect(done).toBeVisible();
  const first = await tools.getByRole('button').first().getAttribute('aria-label');
  expect(first).toBe('Select');

  // The Done ✕ drops the tool.
  await done.tap();
  await expect.poll(tool).toBeNull();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByTestId('tool-done')).toHaveCount(0);

  // Pick a tool, then the Select tool drops it.
  await tools.getByRole('button', { name: 'Rectangle', exact: true }).tap();
  await expect.poll(tool).toBe('rectangle');
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await select.tap();
  await expect.poll(tool).toBeNull();

  // With no tool the Pencil draws freehand: a rectangle stroke is recognised and committed.
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
      pts.push(await toPage(page, [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, 0]));
    }
  }
  pts.push(await toPage(page, [-30, -20, 0]));
  await t.pen.down(pts[0] as { x: number; y: number });
  for (const p of pts.slice(1)) await t.pen.move(p);
  await t.pen.up(pts.at(-1) as { x: number; y: number });
  await a.settled();
  expect((await a.ui()).sketch?.lastStroke?.shape).toBe('rectangle');
  expect(await tool()).toBeNull();
});

test('tapping empty space clears the selection, and the ✕ Clear selection controls do too', async ({
  page,
}) => {
  test.slow();
  await openTablet(page);
  await addBox(page);
  await app(page).idle();
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  const a = app(page);
  const t = await touch(page);
  const face = async () =>
    toPage(page, [10, 10, (await a.regen())?.bodies[0]?.bbox.max[2] ?? 10] as [
      number,
      number,
      number,
    ]);
  const empty = async () => {
    const box = await page.getByTestId('viewport-canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.12 };
  };
  const bubble = page.getByTestId('context-bubble');

  // Tap a face: selected, with a bubble and an inspector, with a Clear selection ✕ on the bubble.
  await t.tap([await face()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(1);
  await expect(bubble.getByRole('button', { name: 'Clear selection' })).toBeVisible();
  // (The inspector's own ✕ is covered by the desktop component test.)

  // The bubble's ✕ clears it.
  await bubble.getByRole('button', { name: 'Clear selection' }).tap();
  await expect.poll(async () => (await a.ui()).selection.length).toBe(0);
  await expect(bubble).toBeHidden();

  // Tapping empty space clears too.
  await t.tap([await face()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(1);
  await t.tap([await empty()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(0);
});

test('a sketch hides once the cut-revolve that consumed it is done', async ({ page }) => {
  test.slow();
  const { docWith, extrude, fid, region, Sk } = await import('./fixtures');
  await openTablet(page);
  const a = app(page);
  const t = await touch(page);
  const SB = fid('SB');
  const E1 = fid('E1');
  const S2 = fid('S2');
  const base = new Sk();
  base.rect('b', 'bl', 0, 0, 80, 50, '80 mm', '50 mm');
  // The profile (a 10 × 6 rectangle) and the axis line, on the XZ plane (sketch y = world z).
  const prof = new Sk();
  prof.rect('p', 'pl', 20, 2, 30, 8, '10 mm', '6 mm');
  prof.point('ax0', 0, 0);
  prof.point('ax1', 0, 10);
  prof.entities.push({ id: 'axis', kind: 'line', start: 'ax0', end: 'ax1', construction: true });
  await a.load(
    docWith('revolve-hide', {}, [
      base.feature(SB, 'Base sketch'),
      extrude(E1, 'Base', [region(SB, 'r1')], '10 mm'),
      prof.feature(S2, 'Profile sketch', { name: 'origin:XZ', kind: 'face' }),
    ]),
  );
  await a.idle();
  const regions = (await a.regen())?.sketches.find((s) => s.id === S2)?.regions ?? [];
  expect(regions.length).toBeGreaterThan(0);
  // An unconsumed sketch is shown.
  expect(await a.shownSketches()).toContain(S2);

  // Revolved cut: pick the profile region with a finger.
  await tool(page, 'revolveCut', 'tap');
  await expect.poll(async () => (await a.ui()).prompt).toBe('revolveCut');
  expect(await a.shownSketches(), 'regions are picked on a visible sketch').toContain(S2);
  const at = await toPage(page, [25, 0, 5]);
  await t.tap([at]);
  await expect
    .poll(async () => (await a.doc()).parts[0]?.features.some((f) => f.type === 'revolve'))
    .toBe(true);
  const rev = (await a.doc()).parts[0]?.features.find((f) => f.type === 'revolve');
  expect(rev && 'op' in rev ? rev.op : null).toBe('cut');
  // While it is being edited the sketch it uses stays visible.
  expect(await a.shownSketches()).toContain(S2);
  // The axis comes from the same sketch: pick its construction line with a finger.
  const insp = page.getByTestId('feature-inspector');
  await insp
    .getByLabel('Axis', { exact: true })
    .getByRole('button', { name: /^Change/ })
    .tap();
  await expect.poll(async () => (await a.ui()).picking?.path).toBe('/axis');
  expect(await a.shownSketches(), 'the axis is picked on the visible sketch').toContain(S2);
  await t.tap([await toPage(page, [0, 0, 5])]);
  await expect
    .poll(async () => {
      const f = (await a.doc()).parts[0]?.features.find((x) => x.type === 'revolve');
      return f && 'axis' in f ? f.axis.name : null;
    })
    .toContain(`S${S2}`);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await expect.poll(async () => (await a.ui()).featureId).toBeNull();
  // Not being edited any more: the consumed sketch is hidden.
  await expect.poll(async () => await a.shownSketches()).not.toContain(S2);
});

test('a sketch drawn and finished in the app hides after its cut-revolve is done', async ({
  page,
}) => {
  test.slow();
  await openTablet(page);
  await addBox(page);
  await app(page).idle();
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  const a = app(page);
  const t = await touch(page);
  const tools = await newSketch(page);
  await tools.getByRole('button', { name: 'Rectangle', exact: true }).tap();
  await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('rectangle');
  const cv = await page.getByTestId('viewport-canvas').boundingBox();
  if (!cv) throw new Error('no canvas');
  const p1 = { x: cv.x + cv.width * 0.45, y: cv.y + cv.height * 0.2 };
  const p2 = { x: cv.x + cv.width * 0.6, y: cv.y + cv.height * 0.35 };
  for (const q of [p1, p2])
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
        q,
      ),
      `(${q.x}, ${q.y}) is on the canvas`,
    ).toBe('viewport-canvas');
  await t.tap([p1]);
  await page.waitForTimeout(500); // two quick taps would be a double-tap
  await t.tap([p2]);
  await expect
    .poll(async () => {
      await a.settled();
      const f = (await a.doc()).parts[0]?.features.findLast((x) => x.type === 'sketch');
      return f?.type === 'sketch' ? f.entities.length : 0;
    })
    .toBeGreaterThan(3);
  const sk = (await a.doc()).parts[0]?.features.findLast((f) => f.type === 'sketch');
  if (sk?.type !== 'sketch') throw new Error('no sketch');
  expect(sk.entities.filter((e) => e.kind === 'line').length).toBeGreaterThanOrEqual(4);
  await tools.getByRole('button', { name: 'Finish' }).tap();
  await expect.poll(async () => (await a.ui()).sketch).toBeNull();
  await cameraStill(page);

  await tool(page, 'revolveCut', 'tap');
  await expect.poll(async () => (await a.ui()).prompt).toBe('revolveCut');
  await t.tap([{ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }]);
  await expect
    .poll(async () => (await a.doc()).parts[0]?.features.some((f) => f.type === 'revolve'))
    .toBe(true);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await expect.poll(async () => (await a.ui()).featureId).toBeNull();
  await expect.poll(async () => await a.shownSketches()).not.toContain(sk.id);
});
