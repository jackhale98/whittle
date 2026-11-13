import { expect, type Page, test } from '@playwright/test';
import type { ViewportReference } from '../src/index';
import { countColor, frame, open, type RGB } from './helpers';
import { PERF_FACTOR } from './perf-budget';

/**
 * ADR-093: reference planes, axes and points are drawn after the bodies without writing depth,
 * picked as face / edge / vertex with their persistent name, highlighted, themed, and a hidden
 * reference (one that is not handed to the viewport) is neither drawn nor pickable.
 */

const frameOf = (origin: [number, number, number], z: [number, number, number] = [0, 0, 1]) => ({
  origin,
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z,
});

// The harness box spans 0..40 x 0..30 x 0..20.
const PLANE: ViewportReference = {
  name: 'Fplane1:plane',
  kind: 'plane',
  label: 'Offset',
  frame: frameOf([20, 15, 40]),
  extent: 30,
};
const AXIS: ViewportReference = {
  name: 'Faxis1:axis',
  kind: 'axis',
  label: 'Axis',
  frame: { origin: [60, 15, 10], x: [1, 0, 0], y: [0, 1, 0], z: [0, 1, 0] },
  extent: 40,
};
const POINT: ViewportReference = {
  name: 'Fpoint1:point',
  kind: 'point',
  label: 'P',
  frame: frameOf([-20, 15, 30]),
  extent: 10,
};

const set = (page: Page, refs: ViewportReference[]) =>
  page.evaluate((r) => window.__viewport?.viewport.setReferences(r), refs);

const at = (page: Page, p: [number, number, number]) =>
  page.evaluate((q) => window.__viewport!.viewport.worldToScreen(q), p);

const pickAt = (page: Page, p: [number, number, number], kinds?: string[]) =>
  page.evaluate(
    ({ q, k }) => {
      const v = window.__viewport!.viewport;
      const s = v.worldToScreen(q);
      return v
        .pick(s.x, s.y, { all: true, ...(k ? { kinds: k as never } : {}) })
        .map((h) => ({ bodyId: h.bodyId, kind: h.kind, entity: h.entity }));
    },
    { q: p, k: kinds },
  );

const LIGHT_REF: RGB = [15, 118, 110]; // #0f766e
const DARK_REF: RGB = [45, 212, 191]; // #2dd4bf

// ADR-098: both projections (reference outlines, picks and sizes use the projection's scale).
for (const projection of ['orthographic', 'perspective'] as const)
  for (const backend of ['webgl2', 'auto'] as const) {
    test.describe(`reference geometry (${backend}, ${projection})`, () => {
      test('drawn in the theme colour, picked with persistent names, hidden = gone', async ({
        page,
      }) => {
        const actual = await open(
          page,
          `?backend=${backend}&reducedMotion=1&projection=${projection}`,
        );
        test.info().annotations.push({ type: 'backend', description: actual });
        await frame(page);
        const before = await countColor(page, LIGHT_REF, 40);

        await set(page, [PLANE, AXIS, POINT]);
        await frame(page);
        const stats = await page.evaluate(() => window.__viewport!.viewport.getReferenceStats());
        expect(stats).toMatchObject({ planes: 1, axes: 1, points: 1, originShown: false });
        const drawn = await countColor(page, LIGHT_REF, 40);
        expect(drawn.count, 'reference outline and crosshair are drawn').toBeGreaterThan(
          before.count + 100,
        );

        // A plane is a face hit, an axis an edge hit, a point a vertex hit, all with the name.
        const onPlane = await pickAt(page, [-4, 15, 40]);
        expect(onPlane.find((h) => h.bodyId === 'Fplane1:plane')).toMatchObject({
          bodyId: 'Fplane1:plane',
          kind: 'face',
          entity: 'reference',
        });
        const onAxis = await pickAt(page, [60, 15, 10]);
        expect(onAxis.find((h) => h.bodyId === 'Faxis1:axis')).toMatchObject({
          bodyId: 'Faxis1:axis',
          kind: 'edge',
          entity: 'reference',
        });
        const onPoint = await pickAt(page, [-20, 15, 30]);
        expect(onPoint.find((h) => h.bodyId === 'Fpoint1:point')).toMatchObject({
          bodyId: 'Fpoint1:point',
          kind: 'vertex',
          entity: 'reference',
        });
        // The kinds filter keeps the pick honest: a plane is not an edge.
        expect(await pickAt(page, [-4, 15, 40], ['edge'])).toEqual([]);
        // A plane never blocks the body behind it: over the box the face is what is picked.
        await set(page, [{ ...PLANE, frame: frameOf([20, 15, 30]), extent: 60 }]);
        expect((await pickAt(page, [20, 15, 20], ['face'])).map((h) => h.bodyId)).toEqual(['box']);
        await set(page, [PLANE, AXIS, POINT]);
        // The body is still pickable where no reference lies in front of it.
        const body = await pickAt(page, [20, 15, 20], ['face']);
        expect(body.some((h) => h.bodyId === 'box')).toBe(true);

        // Hidden references are not handed over: nothing drawn, nothing to pick.
        await set(page, [AXIS, POINT]);
        await frame(page);
        expect((await pickAt(page, [-4, 15, 40], ['face'])).map((h) => h.bodyId)).not.toContain(
          'Fplane1:plane',
        );
        await set(page, []);
        await frame(page);
        expect((await countColor(page, LIGHT_REF, 40)).count).toBeLessThanOrEqual(before.count + 5);
        expect(await pickAt(page, [60, 15, 10], ['edge'])).toEqual([]);
      });

      test('dark theme uses the dark reference token; the highlight uses the accent', async ({
        page,
      }) => {
        await open(page, `?backend=${backend}&reducedMotion=1&theme=dark&projection=${projection}`);
        await set(page, [AXIS, PLANE]);
        await frame(page);
        expect((await countColor(page, DARK_REF, 40)).count).toBeGreaterThan(100);
        expect((await countColor(page, LIGHT_REF, 12)).count).toBe(0);
        // Selection highlight: the axis in the accent colour (#5b9bff in dark).
        await page.evaluate(() =>
          window.__viewport!.viewport.setHighlights({
            selected: [{ bodyId: 'Faxis1:axis', kind: 'edge', index: 0, entity: 'reference' }],
            preselected: [],
          }),
        );
        await frame(page);
        expect((await countColor(page, [91, 155, 255], 40)).count).toBeGreaterThan(30);
      });

      test('the origin planes and axes follow their own toggle and are pickable', async ({
        page,
      }) => {
        await open(page, `?backend=${backend}&reducedMotion=1&projection=${projection}`);
        await set(page, [PLANE]);
        await page.evaluate(() => window.__viewport!.viewport.setOriginReferences(true));
        await frame(page);
        const names = await page.evaluate(
          () => window.__viewport!.viewport.getReferenceStats().names,
        );
        expect(names).toEqual(
          expect.arrayContaining([
            'Fplane1:plane',
            'origin:XY',
            'origin:XZ',
            'origin:YZ',
            'origin:X',
            'origin:Y',
            'origin:Z',
            'origin:O',
          ]),
        );
        // The X axis runs through the box's front-bottom edge region: pick it just past the box.
        const hit = await pickAt(page, [47, 0, 0], ['edge']);
        expect(hit.find((h) => h.bodyId === 'origin:X')).toMatchObject({
          bodyId: 'origin:X',
          kind: 'edge',
        });
        await page.evaluate(() => window.__viewport!.viewport.setOriginReferences(false));
        await frame(page);
        expect(await pickAt(page, [47, 0, 0], ['edge'])).toEqual([]);
        expect(
          await page.evaluate(() => window.__viewport!.viewport.getReferenceStats().originShown),
        ).toBe(false);
      });

      test('references render on demand: an idle viewport draws no frames', async ({ page }) => {
        await open(page, `?backend=${backend}&reducedMotion=1&projection=${projection}`);
        await set(page, [PLANE, AXIS, POINT]);
        await frame(page);
        await page.waitForTimeout(3500); // the studio environment is built on idle, once
        const n = await page.evaluate(() => window.__viewport!.viewport.getRenderCount());
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__viewport!.viewport.getRenderCount())).toBe(n);
      });
    });
  }

test('a reference never hides geometry: bodies keep their depth, references write none', async ({
  page,
}) => {
  await open(page, '?backend=webgl2&reducedMotion=1');
  await frame(page);
  // A plane through the middle of the box: the box top (z = 20) is still its own colour at the
  // pixel where the plane lies behind it, and the plane's fill does not tint the body there.
  const centre = await at(page, [20, 15, 20]);
  const sample = (p: { x: number; y: number }) =>
    page.evaluate(async ({ x, y }) => {
      const v = window.__viewport!.viewport;
      await v.nextFrame();
      const c = v.canvas;
      const bmp = await createImageBitmap(c);
      const k = document.createElement('canvas');
      k.width = bmp.width;
      k.height = bmp.height;
      const ctx = k.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      const s = bmp.width / c.clientWidth;
      return Array.from(ctx.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data);
    }, p);
  const without = await sample(centre);
  await set(page, [{ ...PLANE, frame: frameOf([20, 15, 10]), extent: 50 }]);
  const within = await sample(centre);
  // The top face is in front of the plane (z = 10 is inside the box): no tint.
  expect(within.slice(0, 3)).toEqual(without.slice(0, 3));
});

test('perf probe: 1M triangles orbiting with reference geometry and origin planes drawn', async ({
  page,
}) => {
  // Minutes on software GL: run with `pnpm --filter @wren-cad/viewport perf` (WREN_PERF=1).
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1');
  test.setTimeout(300_000);
  const backend = await open(page, '?backend=webgl2&reducedMotion=1');
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  await frame(page);
  const refs: ViewportReference[] = [];
  for (let i = 0; i < 8; i++) {
    refs.push({ ...PLANE, name: `Fp${i}:plane`, frame: frameOf([0, 0, i * 12]), extent: 40 });
  }
  for (let i = 0; i < 4; i++) {
    refs.push({ ...AXIS, name: `Fa${i}:axis`, frame: { ...AXIS.frame, origin: [i * 9, 0, 0] } });
    refs.push({ ...POINT, name: `Fq${i}:point`, frame: frameOf([i * 7, 4, 4]) });
  }
  // Camera moves driven through the API (no pointer): this isolates what drawing the references
  // adds to a frame. (A pointer orbit with picking enabled also re-renders the 1M-triangle ID
  // image on this software rasteriser, which is not what is being measured.)
  const measure = async (label: string) => {
    await page.evaluate(async () => {
      const v = window.__viewport!.viewport;
      for (let i = 0; i < 60; i++) {
        v.setViewDirection([1 + Math.sin(i / 5), -1 + Math.cos(i / 7), 0.7], false);
        await v.nextFrame();
      }
    });
    const s = await page.evaluate(() => window.__viewport!.viewport.stats());
    console.log(
      `[perf] ${label}: backend=${backend} tris=${s.triangles} drawCalls=${s.drawCalls} renderCpuMs(avg60)=${s.frameMs.toFixed(2)}`,
    );
    return s;
  };
  const base = await measure('1M tris, no references');
  await set(page, refs);
  await page.evaluate(() => window.__viewport!.viewport.setOriginReferences(true));
  await frame(page);
  const withRefs = await measure('1M tris, 8 planes + 4 axes + 4 points + origin');
  // A reference pick on that scene: an extra ray test per plane and a distance test per axis/point.
  const pickMs = await page.evaluate(() => {
    const v = window.__viewport!.viewport;
    const t: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      v.pick(300 + i * 5, 250, { all: true, kinds: ['edge', 'vertex'], tolerancePx: 6 });
      t.push(performance.now() - s);
    }
    return t.sort((a, b) => a - b)[10] as number;
  });
  console.log(`[perf] pick with references on 1M tris: median ${pickMs.toFixed(2)} ms`);
  if (process.env.WREN_PERF_ASSERT) {
    const budget = Number(process.env.WREN_FRAME_BUDGET_MS ?? 8 * PERF_FACTOR);
    expect(
      withRefs.frameMs,
      'frame time with references stays inside the 1M-triangle budget',
    ).toBeLessThanOrEqual(budget);
    // The references themselves cost at most a few draw calls and ~1 ms of CPU.
    expect(withRefs.frameMs - base.frameMs).toBeLessThanOrEqual(2 * PERF_FACTOR);
  }
});
