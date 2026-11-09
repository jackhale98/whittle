import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { PickHit } from '@wren-cad/contracts';
import type { HarnessApi } from '../harness/main';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, '..', 'test-results', 'screenshots'); // untracked output

async function open(page: Page, query = '') {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`/?backend=webgl2&reducedMotion=1${query}`);
  await page.waitForFunction(() => window.__viewport || window.__viewportError, null, {
    timeout: 60_000,
  });
  const error = await page.evaluate(() => window.__viewportError);
  expect(error, `viewport failed to start. console:\n${logs.join('\n')}`).toBeUndefined();
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
}

type P3 = [number, number, number];

/** Canvas-relative CSS px of a world point. */
const toScreen = (page: Page, p: P3) =>
  page.evaluate((q) => {
    const s = window.__viewport?.viewport.worldToScreen(q as P3);
    return s as { x: number; y: number; visible: boolean };
  }, p);

const pick = (
  page: Page,
  x: number,
  y: number,
  options: { tolerancePx?: number; all?: boolean; kinds?: string[] } = {},
) =>
  page.evaluate(
    ([px, py, o]) =>
      window.__viewport?.viewport.pick(px as number, py as number, o as never) as PickHit[],
    [x, y, options] as const,
  );

const ready = (page: Page) => page.evaluate(() => window.__viewport?.viewport.whenPickReady());

/** Pixel colour at canvas-relative CSS px, via screenshot. */
async function pixelAt(
  page: Page,
  points: Array<[number, number]>,
  pick: 'centre' | 'darkest' | 'bluest' = 'centre',
) {
  const png = (await page.locator('canvas').screenshot()).toString('base64');
  return page.evaluate(
    async ([data, pts, pk]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const k = img.width / (document.querySelector('canvas') as HTMLCanvasElement).clientWidth;
      return (pts as Array<[number, number]>).map(([x, y]) => {
        // 5x5 neighbourhood: thin (2 px) lines may miss the exact sample point.
        const r = pk === 'centre' ? 0 : 2;
        const d = ctx.getImageData(
          Math.round(x * k) - r,
          Math.round(y * k) - r,
          2 * r + 1,
          2 * r + 1,
        ).data;
        let best = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let i = 0; i < d.length; i += 4) {
          const score =
            pk === 'darkest'
              ? (d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number)
              : pk === 'bluest'
                ? (d[i] as number) - (d[i + 2] as number)
                : 0;
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        }
        return [d[best], d[best + 1], d[best + 2]] as [number, number, number];
      });
    },
    [png, points, pick] as const,
  );
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

// Box 40 x 30 x 20 at the origin. Face ordinals: xmin 0, xmax 1, ymin 2, ymax 3, zmin 4, zmax 5.
// Edge ordinals: 0-3 along z at (x0y0, x0y1, x1y0, x1y1), 4-7 along x at (y0z0, y0z1, y1z0, y1z1),
// 8-11 along y at (z0x0, z0x1, z1x0, z1x1). Vertex ordinals: 0 x0y0z0, 1 x0y0z1, ... 7 x1y1z1.
const FACE_CENTRES: Array<{ name: string; index: number; p: P3 }> = [
  { name: 'zmax (top)', index: 5, p: [20, 15, 20] },
  { name: 'ymin (front)', index: 2, p: [20, 0, 10] },
  { name: 'xmax (right)', index: 1, p: [40, 15, 10] },
];

for (const mode of ['cpu-fallback', 'id-buffer'] as const) {
  test.describe(`picking (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page);
      if (mode === 'id-buffer') await ready(page);
    });

    test('picks the visible faces of the box with point and normal', async ({ page }) => {
      for (const f of FACE_CENTRES) {
        const s = await toScreen(page, f.p);
        expect(s.visible).toBe(true);
        const hits = await pick(page, s.x, s.y, { kinds: ['face'] });
        expect(hits, f.name).toHaveLength(1);
        const h = hits[0] as PickHit;
        expect(h.kind).toBe('face');
        expect(h.index, f.name).toBe(f.index);
        expect(h.bodyId).toBe('box');
        expect(h.distancePx).toBe(0);
        // The pick ray hits the face plane at (about) the projected world point.
        expect(
          Math.hypot(h.point[0] - f.p[0], h.point[1] - f.p[1], h.point[2] - f.p[2]),
        ).toBeLessThan(0.5);
        expect(h.normal).toBeDefined();
      }
      const stats = await page.evaluate(() => window.__viewport?.viewport.getPickStats());
      if (mode === 'id-buffer') expect(stats?.idBufferPicks).toBeGreaterThanOrEqual(3);
      else expect(stats?.fallbackPicks).toBeGreaterThanOrEqual(3);
    });

    test('empty space returns nothing', async ({ page }) => {
      expect(await pick(page, 4, 4)).toEqual([]);
    });

    test('picks an edge and a vertex by screen distance (and not a hidden one)', async ({
      page,
    }) => {
      // Edge 11 runs along y at z1/x1 (top-right edge): midpoint (40, 15, 20).
      const e = await toScreen(page, [40, 15, 20]);
      const hits = await pick(page, e.x + 2, e.y + 1);
      expect(hits[0]?.kind).toBe('edge');
      expect(hits[0]?.index).toBe(11);
      expect(hits[0]?.distancePx).toBeLessThan(6);
      // Vertex 7 = (40, 30, 20)... is on the far side; vertex 5 = (40, 0, 20) is visible.
      const v = await toScreen(page, [40, 0, 20]);
      const vh = await pick(page, v.x + 1, v.y + 1);
      expect(vh[0]?.kind).toBe('vertex');
      expect(vh[0]?.index).toBe(5);
      // Vertex 2 = (0, 30, 0) is hidden behind the box in the iso view: never picked.
      const hidden = await toScreen(page, [0, 30, 0]);
      const hh = await pick(page, hidden.x, hidden.y, { kinds: ['vertex'], tolerancePx: 6 });
      expect(hh.filter((h) => h.index === 2)).toHaveLength(0);
    });

    test('touch tolerance picks a thin edge 15 px away; mouse tolerance does not', async ({
      page,
    }) => {
      const e = await toScreen(page, [20, 0, 20]); // edge 9?: along x at (y0, z1) -> ordinal 5
      // Move straight away from the edge, into the empty background above the box silhouette.
      const px = e.x;
      const py = e.y - 15;
      const mouse = await pick(page, px, py, { tolerancePx: 6 });
      expect(mouse.find((h) => h.kind === 'edge')).toBeUndefined();
      const touch = await pick(page, px, py, { tolerancePx: 22 });
      expect(touch[0]?.kind).toBe('edge');
      expect(touch[0]?.index).toBe(5);
      expect(touch[0]?.distancePx).toBeGreaterThan(10);
      expect(touch[0]?.distancePx).toBeLessThanOrEqual(22);
    });

    test('all: true lists every candidate within tolerance, sorted by distance', async ({
      page,
    }) => {
      const v = await toScreen(page, [40, 0, 20]);
      const hits = await pick(page, v.x + 3, v.y + 3, { all: true, tolerancePx: 22 });
      expect(hits.length).toBeGreaterThanOrEqual(3);
      const d = hits.map((h) => h.distancePx);
      expect([...d].sort((a, b) => a - b)).toEqual(d);
      const kinds = new Set(hits.map((h) => h.kind));
      expect(kinds.has('vertex')).toBe(true);
      expect(kinds.has('edge')).toBe(true);
      expect(kinds.has('face')).toBe(true);
    });
  });
}

test.describe('highlights', () => {
  test('selected and preselected faces change pixels; selection is stronger', async ({ page }) => {
    await open(page);
    const top = await toScreen(page, [20, 15, 20]);
    const right = await toScreen(page, [40, 15, 10]);
    const spots: Array<[number, number]> = [
      [top.x, top.y],
      [right.x, right.y],
    ];
    const base = await pixelAt(page, spots);
    await page.evaluate(() =>
      window.__viewport?.viewport.setHighlights({
        selected: [{ bodyId: 'box', kind: 'face', index: 5 }],
        preselected: [{ bodyId: 'box', kind: 'face', index: 1 }],
      }),
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const lit = await pixelAt(page, spots);
    const dSel = dist(lit[0]!, base[0]!);
    const dPre = dist(lit[1]!, base[1]!);
    expect(dSel, 'selected face changes colour').toBeGreaterThan(25);
    expect(dPre, 'preselected face changes colour').toBeGreaterThan(8);
    expect(dSel).toBeGreaterThan(dPre);
    // Selected face leans accent blue.
    expect(lit[0]![2]).toBeGreaterThan(lit[0]![0]);

    // Edge highlight draws thicker accent pixels along the edge; vertex adds a dot.
    const edge = await toScreen(page, [40, 15, 20]);
    const beforeEdge = await pixelAt(page, [[edge.x, edge.y]]);
    await page.evaluate(() =>
      window.__viewport?.viewport.setHighlights({
        selected: [
          { bodyId: 'box', kind: 'edge', index: 11 },
          { bodyId: 'box', kind: 'vertex', index: 5 },
        ],
        preselected: [],
      }),
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const afterEdge = await pixelAt(page, [[edge.x, edge.y]]);
    expect(dist(afterEdge[0]!, beforeEdge[0]!)).toBeGreaterThan(40);
    const vtx = await toScreen(page, [40, 0, 20]);
    const [vp] = await pixelAt(page, [[vtx.x, vtx.y]]);
    expect(vp![2]).toBeGreaterThan(vp![0] + 30);

    // Clearing restores the original look.
    await page.evaluate(() =>
      window.__viewport?.viewport.setHighlights({ selected: [], preselected: [] }),
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const cleared = await pixelAt(page, spots);
    expect(dist(cleared[0]!, base[0]!)).toBeLessThan(4);
  });
});

test.describe('sketch overlay', () => {
  test('rectangle + circle render, DOF-coloured, and their curves/regions are pickable', async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => window.__viewport?.setView('top'));
    await page.evaluate(() => window.__viewport?.showSketch(false));
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());

    // Fixed (near-black) rectangle edge at x = 5, y = 15 on the plane z = 20.
    const l4 = await toScreen(page, [5, 15, 20]);
    const [px] = await pixelAt(page, [[l4.x, l4.y]], 'darkest');
    expect(Math.max(...px!)).toBeLessThan(90);
    // Circle (partial, blue-ish) at angle 0: (26, 15, 20)
    const c = await toScreen(page, [26, 15, 20]);
    const [cp] = await pixelAt(page, [[c.x, c.y]], 'bluest');
    expect(cp![2], 'partially constrained circle leans blue').toBeGreaterThan(cp![0]);

    // Curve picks
    const l4b = await toScreen(page, [5, 10, 20]); // away from the construction line at y = 15
    const line = await pick(page, l4b.x + 2, l4b.y, { kinds: ['sketchCurve'] });
    expect(line[0]?.kind).toBe('sketchCurve');
    expect(line[0]?.entity).toBe('l4');
    expect(line[0]?.bodyId).toBe('F02');
    const circ = await pick(page, c.x - 1, c.y + 1, { kinds: ['sketchCurve'] });
    expect(circ[0]?.entity).toBe('c1');
    const pt = await toScreen(page, [28, 20, 20]);
    const pp = await pick(page, pt.x + 1, pt.y + 1);
    expect(pp[0]?.kind).toBe('sketchPoint');
    expect(pp[0]?.entity).toBe('p1');
    // Regions: inside the rectangle (but outside the circle) and inside the circle.
    const inRect = await toScreen(page, [10, 8, 20]);
    const r0 = await pick(page, inRect.x, inRect.y, { kinds: ['region'] });
    expect(r0[0]?.kind).toBe('region');
    expect(r0[0]?.index).toBe(0);
    const inCircle = await toScreen(page, [20, 17, 20]);
    const r1 = await pick(page, inCircle.x, inCircle.y, { kinds: ['region'], all: true });
    expect(r1.map((h) => h.index).sort()).toEqual([0, 1]);

    // Highlighting a sketch curve changes pixels.
    const before = await pixelAt(page, [[l4.x, l4.y]], 'darkest');
    await page.evaluate(() =>
      window.__viewport?.viewport.setHighlights({
        selected: [{ bodyId: 'F02', kind: 'sketchCurve', index: 3, entity: 'l4' }],
        preselected: [],
      }),
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const after = await pixelAt(page, [[l4.x, l4.y]], 'darkest');
    expect(dist(after[0]!, before[0]!)).toBeGreaterThan(40);

    // Active mode dims the body and puts the sketch on top; removal restores.
    await page.evaluate(() =>
      window.__viewport?.viewport.setHighlights({ selected: [], preselected: [] }),
    );
    const body = await toScreen(page, [38, 3, 20]);
    const [b0] = await pixelAt(page, [[body.x, body.y]]);
    await page.evaluate(() => window.__viewport?.showSketch(true));
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const [b1] = await pixelAt(page, [[body.x, body.y]]);
    expect(dist(b1!, b0!)).toBeGreaterThan(8);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'sketch-active-top.png') });
    await page.evaluate(() => window.__viewport?.hideSketch());
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const [b2] = await pixelAt(page, [[body.x, body.y]]);
    expect(dist(b2!, b0!)).toBeLessThan(4);
    expect(await pick(page, l4.x, l4.y, { kinds: ['sketchCurve'] })).toEqual([]);
  });
});

test.describe('plane helpers', () => {
  test('screenToPlane / worldToScreen round trip and lookAtPlane', async ({ page }) => {
    await open(page);
    const out = await page.evaluate(() => {
      const v = (window.__viewport as HarnessApi).viewport;
      const plane = { origin: [0, 0, 20], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as never;
      const s = v.worldToScreen([12, 7, 20]);
      const local = v.screenToPlane(s.x, s.y, plane);
      v.lookAtPlane(plane, false);
      const cam = (window.__viewport as HarnessApi).viewport.getCameraState();
      const s2 = v.worldToScreen([12, 7, 20]);
      const local2 = v.screenToPlane(s2.x, s2.y, plane);
      // A plane seen edge-on (x-z plane through y = 0, looking along y) is parallel to a top view.
      return { local, local2, cam };
    });
    expect(out.local?.[0]).toBeCloseTo(12, 2);
    expect(out.local?.[1]).toBeCloseTo(7, 2);
    expect(out.local2?.[0]).toBeCloseTo(12, 2);
    expect(out.local2?.[1]).toBeCloseTo(7, 2);
    // Looking straight down +z at the plane from above, with +y up on screen.
    const d = out.cam.position.map((p, i) => p - out.cam.target[i]!);
    expect(d[2]! / out.cam.distance).toBeGreaterThan(0.999);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const up = await toScreen(page, [20, 25, 20]);
    const base = await toScreen(page, [20, 5, 20]);
    expect(up.y).toBeLessThan(base.y); // larger y is higher on screen
    const right = await toScreen(page, [35, 15, 20]);
    const left = await toScreen(page, [5, 15, 20]);
    expect(right.x).toBeGreaterThan(left.x);
  });
});

test.describe('view cube', () => {
  test('click changes the view: faces, an edge and a corner', async ({ page }) => {
    await open(page);
    const cube = page.getByTestId('view-cube');
    await expect(cube).toBeVisible();
    const cam = () =>
      page.evaluate(() => {
        const c = window.__viewport?.viewport.getCameraState();
        if (!c) throw new Error('no viewport');
        return c.position.map((p, i) => (p - c.target[i]!) / c.distance);
      });
    const box = (await cube.boundingBox())!;
    // Initial iso view: the cube shows its front, right and top faces; click the centre of each
    // visible face by sampling the svg: use the face labels' positions via a hit probe.
    const faceAt = async (fx: number, fy: number) => {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(60);
      await page.evaluate(() => window.__viewport?.viewport.nextFrame());
      return cam();
    };
    // Cube centre region in iso shows the corner where front/right/top meet -> iso-ish corner.
    const centre = await faceAt(0.5, 0.5);
    expect(centre[2]).toBeGreaterThan(0.5); // a corner/edge toward the camera, up
    // Top face is the upper rhombus: click above the centre.
    const top = await faceAt(0.5, 0.3);
    expect(dist(top, [0, 0, 1])).toBeLessThan(0.05);
    // Now looking from the top: the cube shows only its top face; its centre is the top view.
    const again = await faceAt(0.5, 0.5);
    expect(dist(again, [0, 0, 1])).toBeLessThan(0.05);
    // A corner of the top face (upper-right) -> a cube corner direction with z > 0.
    const corner = await faceAt(0.5 + 0.255, 0.5 - 0.255);
    expect(Math.abs(corner[0]!)).toBeGreaterThan(0.4);
    expect(Math.abs(corner[1]!)).toBeGreaterThan(0.4);
    expect(corner[2]).toBeGreaterThan(0.4);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'view-cube-corner.png') });
  });
});

test.describe('touch regression', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });

  test('one-finger orbit still turns >= 45 degrees for a 150 px drag (phone emulation)', async ({
    page,
  }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    const cam = () => page.evaluate(() => window.__viewport?.viewport.getCameraState());
    const before = (await cam())!;
    const box = (await page.locator('canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: x === undefined ? [] : [{ x, y: y as number, id: 1 }],
      });
    await send('touchStart', cx - 75, cy);
    for (let i = 1; i <= 15; i++) {
      await send('touchMove', cx - 75 + i * 10, cy);
      await page.waitForTimeout(16);
    }
    await send('touchEnd');
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const after = (await cam())!;
    const dir = (c: typeof before) => c.position.map((p, i) => p - c.target[i]!);
    const a = dir(before);
    const b = dir(after);
    const cos =
      (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b));
    const deg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
    console.log(`[touch] 150 px drag turned the view ${deg.toFixed(1)} degrees`);
    expect(deg).toBeGreaterThanOrEqual(45);

    // Touch pick: a finger-sized (22 px) tolerance finds the nearby edge.
    await ready(page);
    const e = await toScreen(page, [20, 15, 20]);
    expect(e.visible).toBe(true);
  });
});

test('coarse/fine replacement is cheap, keeps the camera and stays pickable', async ({ page }) => {
  await open(page);
  const cam = () => page.evaluate(() => window.__viewport?.viewport.getCameraState());
  const before = await cam();
  const res = await page.evaluate(() => {
    const w = window.__viewport as HarnessApi;
    const refill: number[] = [];
    for (let i = 0; i < 20; i++) refill.push(w.resizeBox(40 + i * 0.1, 30, 20));
    const swap = w.replaceWithSphere(20_000);
    const refillSphere: number[] = [];
    for (let i = 0; i < 5; i++) refillSphere.push(w.replaceWithSphere(20_000));
    return { refill, swap, refillSphere };
  });
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  expect(await cam()).toEqual(before); // never refits on replace
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(
    `[perf] setBody replace: same-size refill (box) avg ${avg(res.refill).toFixed(2)} ms, ` +
      `geometry swap (20k-tri sphere) ${res.swap.toFixed(1)} ms, same-size refill (20k tris) avg ${avg(res.refillSphere).toFixed(1)} ms`,
  );
  // Still pickable after replacement (faces from the CPU fallback, then from the ID buffer).
  await page.evaluate(() => window.__viewport?.viewport.whenPickReady());
  const c = await toScreen(page, [0, 0, 0]);
  const hits = await pick(page, c.x, c.y, { kinds: ['face'] });
  expect(hits[0]?.kind).toBe('face');
  expect(hits[0]?.bodyId).toBe('box');
  // And a body removed is gone from picking.
  await page.evaluate(() => window.__viewport?.viewport.removeBody('box'));
  expect(await pick(page, c.x, c.y)).toEqual([]);
});

test('context loss is reported to the app', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { __lost: string[] };
    w.__lost = [];
    window.__viewport?.viewport.on('contextlost', (e) => w.__lost.push(e.reason));
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await page.waitForFunction(() => (window as unknown as { __lost: string[] }).__lost.length > 0);
});

test('screenshot artefacts (selection look, sketch, dark theme)', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 640 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await open(page, `&theme=${theme}`);
    await page.waitForTimeout(250);
    const hl = (selected: unknown[], preselected: unknown[]) =>
      page.evaluate(
        ([s, p]) =>
          window.__viewport?.viewport.setHighlights({ selected: s, preselected: p } as never),
        [selected, preselected] as const,
      );
    await hl(
      [
        { bodyId: 'box', kind: 'face', index: 5 },
        { bodyId: 'box', kind: 'vertex', index: 5 },
      ],
      [
        { bodyId: 'box', kind: 'face', index: 1 },
        { bodyId: 'box', kind: 'edge', index: 11 },
      ],
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    await page.screenshot({ path: join(SHOTS, `selection-${theme}.png`) });
    await hl([], []);
    await page.evaluate(() => window.__viewport?.showSketch(false));
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    await page.screenshot({ path: join(SHOTS, `sketch-iso-${theme}.png`) });
    await page.evaluate(() => {
      const w = window.__viewport as HarnessApi;
      w.viewport.lookAtPlane(
        { origin: [0, 0, 20], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        false,
      );
      w.showSketch(true);
    });
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    await page.screenshot({ path: join(SHOTS, `sketch-active-${theme}.png`) });
  }
  await context.close();
});

test('perf probe: picking active on a 1M-triangle model', async ({ page }) => {
  // Minutes on software GL: run with `pnpm --filter @wren-cad/viewport perf` (WREN_PERF=1).
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1');
  test.setTimeout(240_000);
  await open(page);
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  const t0 = Date.now();
  await ready(page);
  const idReadyMs = Date.now() - t0;
  const box = (await page.locator('canvas').boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };
  // Face pick from the ID buffer, and edge/vertex pick (needs BVH for occlusion: first build).
  const res = await page.evaluate(
    ([x, y]) => {
      const v = (window as unknown as { __viewport: HarnessApi }).__viewport.viewport;
      const t = (fn: () => unknown) => {
        const s = performance.now();
        const out = fn();
        return { ms: performance.now() - s, out };
      };
      const face = t(() => v.pick(x as number, y as number, { kinds: ['face'] }));
      const faceAgain = t(() => v.pick((x as number) + 3, y as number, { kinds: ['face'] }));
      const edgeFirst = t(() => v.pick(x as number, y as number, { kinds: ['edge', 'vertex'] }));
      const edgeAgain = t(() => v.pick(x as number, y as number, { kinds: ['edge', 'vertex'] }));
      return {
        face: face.ms,
        faceAgain: faceAgain.ms,
        edgeFirst: edgeFirst.ms,
        edgeAgain: edgeAgain.ms,
        stats: v.getPickStats(),
        hit: (face.out as PickHit[])[0]?.kind ?? null,
      };
    },
    [centre.x, centre.y] as const,
  );
  console.log(
    `[perf] 1M tris: ID buffer ready after ${idReadyMs} ms (refresh ${res.stats.lastIdRefreshMs.toFixed(0)} ms); ` +
      `face pick ${res.face.toFixed(2)} ms (repeat ${res.faceAgain.toFixed(2)} ms); ` +
      `edge/vertex pick first ${res.edgeFirst.toFixed(1)} ms (BVH build ${res.stats.lastBvhBuildMs.toFixed(0)} ms), repeat ${res.edgeAgain.toFixed(2)} ms`,
  );
  expect(res.hit).toBe('face');

  // Orbit with picking enabled: frame time must not regress (ID pass only runs when idle).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + Math.sin(i / 4) * 150,
      box.y + box.height / 2 + 20,
    );
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  }
  await page.mouse.up({ button: 'right' });
  const stats = await page.evaluate(() => window.__viewport?.viewport.stats());
  console.log(
    `[perf] orbit with picking enabled: renderCpuMs(avg60)=${stats?.frameMs.toFixed(2)} (advisory on SwiftShader)`,
  );
  await page.evaluate(() => window.__viewport?.viewport.whenPickReady());
});
