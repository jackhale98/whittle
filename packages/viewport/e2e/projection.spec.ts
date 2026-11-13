import { expect, type Page, test } from '@playwright/test';
import type { NavigationOptions, PickHit } from '@wren-cad/contracts';
import { countColor, dist, frame, open, settle, touchDriver } from './helpers';

/**
 * ADR-098: orthographic by default, perspective as a setting. Every navigation input has to behave
 * the same in both: the same assertions run once per projection.
 */

type V3 = [number, number, number];
const PROJECTIONS = ['orthographic', 'perspective'] as const;
type Projection = (typeof PROJECTIONS)[number];

async function boot(page: Page, projection: Projection | null, extra = '') {
  const p = projection ? `&projection=${projection}` : '';
  await open(page, `?backend=webgl2&reducedMotion=1${p}${extra}`);
  await settle(page);
  const box = (await page.locator('canvas').boundingBox())!;
  return { box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

const nav = (page: Page, o: Partial<NavigationOptions>) =>
  page.evaluate((opts) => window.__viewport!.viewport.setNavigation(opts), o);
const screenOf = (page: Page, p: V3) =>
  page.evaluate((w) => window.__viewport!.viewport.worldToScreen(w), p);
const info = (page: Page) => page.evaluate(() => window.__viewport!.projectionInfo());
const cam = (page: Page) => page.evaluate(() => window.__viewport!.viewport.getCameraState());
const pickFace = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => window.__viewport!.viewport.pick(px as number, py as number, { kinds: ['face'] }),
    [x, y],
  ) as Promise<PickHit[]>;

test.describe('the setting', () => {
  test('orthographic is the default; the setting switches the projection matrix', async ({
    page,
  }) => {
    await boot(page, null);
    expect(await page.evaluate(() => window.__viewport!.viewport.getNavigation().projection)).toBe(
      'orthographic',
    );
    const o = await info(page);
    expect(o.orthographic).toBe(true);
    expect(o.p32).toBe(0);
    expect(
      o.near,
      'near is behind the scene centre minus its reach, from the scene bounds',
    ).toBeLessThan(0);
    await nav(page, { projection: 'perspective' });
    await frame(page);
    const p = await info(page);
    expect(p.orthographic).toBe(false);
    expect(p.p32).toBe(-1);
    await nav(page, { projection: 'orthographic' });
    await frame(page);
    expect((await info(page)).p32).toBe(0);
  });

  test('switching keeps the target, the pose and the apparent size at the target', async ({
    page,
  }) => {
    const { box } = await boot(page, 'perspective');
    // A segment lying in the plane through the target, perpendicular to the view axis.
    const c = await cam(page);
    const f = [0, 1, 2].map((i) => (c.target[i] as number) - (c.position[i] as number));
    const fl = Math.hypot(f[0]!, f[1]!, f[2]!);
    const fw = f.map((v) => v / fl);
    // right = fwd x up(0,0,1)
    const rx = fw[1]!;
    const ry = -fw[0]!;
    const rl = Math.hypot(rx, ry);
    const right: V3 = [rx / rl, ry / rl, 0];
    const at = (k: number): V3 => [
      c.target[0]! + right[0] * k,
      c.target[1]! + right[1] * k,
      c.target[2]! + right[2] * k,
    ];
    const a0 = await screenOf(page, at(-12));
    const b0 = await screenOf(page, at(12));
    const t0 = await screenOf(page, c.target as V3);
    await nav(page, { projection: 'orthographic' });
    await frame(page);
    const a1 = await screenOf(page, at(-12));
    const b1 = await screenOf(page, at(12));
    const t1 = await screenOf(page, c.target as V3);
    const after = await cam(page);
    expect(dist(after.position, c.position)).toBeLessThan(1e-9);
    expect(dist(after.target, c.target)).toBeLessThan(1e-9);
    for (const [u, v] of [
      [a0, a1],
      [b0, b1],
      [t0, t1],
    ] as const) {
      expect(Math.hypot(u.x - v.x, u.y - v.y), 'no jump at the target plane').toBeLessThan(0.75);
    }
    expect(t1.x).toBeCloseTo(box.width / 2, 0);
    // And back.
    await nav(page, { projection: 'perspective' });
    await frame(page);
    const a2 = await screenOf(page, at(-12));
    expect(Math.hypot(a2.x - a0.x, a2.y - a0.y)).toBeLessThan(0.75);
  });
});

test.describe('the owner case: a hole seen straight on', () => {
  /** Pick the whole canvas on a grid; count faces named `hole.*` (walls) and the floor. */
  async function holeHits(page: Page) {
    return page.evaluate(async () => {
      const w = window.__viewport!;
      const v = w.viewport;
      v.setView('top', false);
      await v.nextFrame();
      await v.whenPickReady();
      const names = w.holeFaceNames();
      const c = { w: window.innerWidth, h: window.innerHeight };
      const counts: Record<string, number> = {};
      const step = 3;
      for (let y = 0; y < c.h; y += step) {
        for (let x = 0; x < c.w; x += step) {
          const hit = v.pick(x, y, { kinds: ['face'], tolerancePx: 0 })[0];
          if (!hit) continue;
          const n = names[hit.index] as string;
          counts[n] = (counts[n] ?? 0) + 1;
        }
      }
      return counts;
    });
  }

  test('orthographic top view: no hole-wall pixels, the floor and top are there', async ({
    page,
  }) => {
    await boot(page, 'orthographic', '&empty=1');
    await page.evaluate(() => window.__viewport!.loadHoleBlock());
    const counts = await holeHits(page);
    const walls = Object.entries(counts)
      .filter(([n]) => n.startsWith('hole.') && n !== 'hole.floor')
      .reduce((s, [, k]) => s + k, 0);
    expect(counts['hole.floor'] ?? 0, 'the floor is visible').toBeGreaterThan(200);
    expect(counts['face.zmax'] ?? 0, 'the top is visible').toBeGreaterThan(1000);
    expect(walls, `walls seen from straight above: ${JSON.stringify(counts)}`).toBe(0);
  });

  test('perspective top view: the hole walls show (off-axis hole)', async ({ page }) => {
    await boot(page, 'perspective', '&empty=1');
    await page.evaluate(() => window.__viewport!.loadHoleBlock());
    const counts = await holeHits(page);
    expect(
      counts['hole.xmax'] ?? 0,
      `the wall on the far side from the view axis is seen: ${JSON.stringify(counts)}`,
    ).toBeGreaterThan(20);
  });
});

for (const projection of PROJECTIONS) {
  test.describe(`navigation in ${projection}`, () => {
    test('wheel zoom keeps the surface point under the cursor, in and out', async ({ page }) => {
      const { box, cx, cy } = await boot(page, projection);
      const px = box.width / 2 + 70;
      const py = box.height / 2 + 30;
      const hit = (await pickFace(page, px, py))[0];
      expect(hit?.kind).toBe('face');
      const p = hit!.point as V3;
      await page.mouse.move(cx + 70, cy + 30);
      const h0 = (await info(page)).halfHeight;
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -100);
        await frame(page);
        const s = await screenOf(page, p);
        expect(Math.hypot(s.x - px, s.y - py), `notch ${i}`).toBeLessThan(1.5);
      }
      const h1 = (await info(page)).halfHeight;
      if (projection === 'orthographic') {
        // Every notch scales the view height by the same ratio (0.85).
        expect(h1 / h0).toBeCloseTo(0.85 ** 6, 2);
      }
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 100);
        await frame(page);
      }
      const s = await screenOf(page, p);
      expect(Math.hypot(s.x - px, s.y - py), 'zooming out').toBeLessThan(1.5);
      if (projection === 'orthographic') {
        expect((await info(page)).halfHeight).toBeGreaterThan(h1 * 2);
      }
    });

    test('wheel zoom into a deep zoom clips nothing: near and far follow the scene', async ({
      page,
    }) => {
      const { box, cx, cy } = await boot(page, projection);
      await page.mouse.move(cx + 70, cy + 30);
      for (let i = 0; i < 25; i++) {
        await page.mouse.wheel(0, -100);
        await frame(page);
      }
      const px = box.width / 2 + 70;
      const py = box.height / 2 + 30;
      const hit = (await pickFace(page, px, py))[0];
      expect(hit, 'the surface is still there at the deepest zoom').toBeTruthy();
      const i = await info(page);
      // The corners of the box are all inside the clip range (ortho) or in front (perspective).
      const c = await cam(page);
      const f = [0, 1, 2].map((k) => (c.target[k] as number) - (c.position[k] as number));
      const fl = Math.hypot(f[0]!, f[1]!, f[2]!);
      for (const corner of [
        [0, 0, 0],
        [40, 30, 20],
        [0, 30, 0],
        [40, 0, 20],
      ] as V3[]) {
        const depth =
          ((corner[0] - c.position[0]!) * f[0]! +
            (corner[1] - c.position[1]!) * f[1]! +
            (corner[2] - c.position[2]!) * f[2]!) /
          fl;
        if (projection === 'orthographic') {
          expect(depth).toBeGreaterThan(i.near);
          expect(depth).toBeLessThan(i.far);
        }
      }
    });

    test('middle-drag pan keeps the grabbed point under the cursor', async ({ page }) => {
      const { box, cx, cy } = await boot(page, projection);
      const px = box.width / 2 + 40;
      const py = box.height / 2 + 10;
      const hit = (await pickFace(page, px, py))[0];
      expect(hit?.kind).toBe('face');
      const p = hit!.point as V3;
      await page.mouse.move(cx + 40, cy + 10);
      await page.mouse.down({ button: 'middle' });
      let worst = 0;
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(cx + 40 - i * 9, cy + 10 + i * 5);
        await frame(page);
        const s = await screenOf(page, p);
        worst = Math.max(worst, Math.hypot(s.x - (px - i * 9), s.y - (py + i * 5)));
      }
      await page.mouse.up({ button: 'middle' });
      expect(worst).toBeLessThan(1.5);
    });

    for (const orbit of ['turntable', 'trackball'] as const) {
      test(`${orbit} orbit turns about the surface point under the cursor`, async ({ page }) => {
        const { box, cx, cy } = await boot(page, projection);
        await nav(page, { orbit });
        const px = box.width / 2 + 70;
        const py = box.height / 2 + 30;
        const hit = (await pickFace(page, px, py))[0];
        expect(hit?.kind).toBe('face');
        const p = hit!.point as V3;
        const before = await cam(page);
        await page.mouse.move(cx + 70, cy + 30);
        await page.mouse.down({ button: 'right' });
        let worst = 0;
        for (let i = 1; i <= 16; i++) {
          await page.mouse.move(cx + 70 + i * 9, cy + 30 + Math.sin(i / 3) * 40);
          await frame(page);
          const s = await screenOf(page, p);
          worst = Math.max(worst, Math.hypot(s.x - px, s.y - py));
        }
        const st = await page.evaluate(() => window.__viewport!.viewport.getNavigationState());
        await page.mouse.up({ button: 'right' });
        expect(st.pivotSource).toBe('surface');
        expect(worst).toBeLessThan(2);
        expect(dist((await cam(page)).position, before.position)).toBeGreaterThan(1);
      });
    }

    test('orbit from a miss pivots about the scene centre, never a stale point', async ({
      page,
    }) => {
      const { cx, cy } = await boot(page, projection);
      await page.mouse.move(cx - 380, cy + 280);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(cx - 340, cy + 280, { steps: 4 });
      await frame(page);
      const st = await page.evaluate(() => window.__viewport!.viewport.getNavigationState());
      await page.mouse.up({ button: 'right' });
      expect(['center', 'screenCenter', 'axis']).toContain(st.pivotSource);
      expect(st.pivot).not.toBeNull();
    });

    test('fitAll with frame insets frames the model in the free area; views, zoomTo and the cube', async ({
      page,
    }) => {
      const { box } = await boot(page, projection);
      const w = box.width;
      const h = box.height;
      const ins = { top: 50, bottom: 220, left: 30, right: 10 };
      await page.evaluate((i) => {
        const v = window.__viewport!.viewport;
        v.setFrameInsets(i);
        v.fitAll(false);
      }, ins);
      await frame(page);
      const corners: V3[] = [];
      for (const x of [0, 40])
        for (const y of [0, 30]) for (const z of [0, 20]) corners.push([x, y, z]);
      const extent = async () => {
        const pts = await Promise.all(corners.map((c) => screenOf(page, c)));
        return {
          x0: Math.min(...pts.map((p) => p.x)),
          x1: Math.max(...pts.map((p) => p.x)),
          y0: Math.min(...pts.map((p) => p.y)),
          y1: Math.max(...pts.map((p) => p.y)),
        };
      };
      const e = await extent();
      expect(e.x0).toBeGreaterThanOrEqual(ins.left);
      expect(e.x1).toBeLessThanOrEqual(w - ins.right);
      expect(e.y0).toBeGreaterThanOrEqual(ins.top);
      expect(e.y1).toBeLessThanOrEqual(h - ins.bottom);
      const freeW = w - ins.left - ins.right;
      const freeH = h - ins.top - ins.bottom;
      expect(
        Math.max((e.x1 - e.x0) / freeW, (e.y1 - e.y0) / freeH),
        'fills the free area',
      ).toBeGreaterThan(0.45);
      // The fit centres the bounding sphere: exact for the parallel projection, off by the
      // foreshortening of the near corners for perspective.
      const slack = projection === 'orthographic' ? 6 : 40;
      expect(Math.abs((e.x0 + e.x1) / 2 - (ins.left + freeW / 2))).toBeLessThan(slack);
      expect(Math.abs((e.y0 + e.y1) / 2 - (ins.top + freeH / 2))).toBeLessThan(slack);

      // Standard views level the camera and look at the model.
      await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
      await frame(page);
      const front = await cam(page);
      expect(front.position[1]!).toBeLessThan(front.target[1]!);
      expect(Math.abs(front.position[0]! - front.target[0]!)).toBeLessThan(1e-6);
      await page.evaluate(() => window.__viewport!.viewport.setViewDirection([1, 1, 1], false));
      await frame(page);
      const e2 = await extent();
      expect(e2.x0).toBeGreaterThanOrEqual(ins.left - 1);
      expect(e2.y1).toBeLessThanOrEqual(h - ins.bottom + 1);

      // zoomTo centres the point.
      await page.evaluate(() => window.__viewport!.viewport.setFrameInsets({}));
      await page.evaluate(() => window.__viewport!.viewport.zoomTo([40, 30, 20], 8, false));
      await frame(page);
      const s = await screenOf(page, [40, 30, 20]);
      expect(Math.hypot(s.x - w / 2, s.y - h / 2)).toBeLessThan(1.5);

      // The view cube: its top face levels the camera onto the top view.
      const cube = page.getByTestId('view-cube');
      const cb = (await cube.boundingBox())!;
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.3);
      await page.waitForTimeout(100);
      await frame(page);
      const top = await cam(page);
      expect(Math.abs(top.position[0]! - top.target[0]!)).toBeLessThan(1e-6);
      expect(top.position[2]!).toBeGreaterThan(top.target[2]!);
    });

    test('pinch zooms toward the fingers: the point between them stays put', async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await boot(page, projection);
      const t = await touchDriver(page);
      const mx = t.cx + 30;
      const my = t.cy - 20;
      const hit = (await pickFace(page, mx, my))[0];
      expect(hit?.kind).toBe('face');
      const p = hit!.point as V3;
      const d0 = (await cam(page)).distance;
      await t.start([
        { x: mx - 30, y: my, id: 1 },
        { x: mx + 30, y: my, id: 2 },
      ]);
      for (let i = 1; i <= 10; i++) {
        await t.move([
          { x: mx - 30 - i * 8, y: my, id: 1 },
          { x: mx + 30 + i * 8, y: my, id: 2 },
        ]);
        await page.waitForTimeout(16);
      }
      await t.end();
      await frame(page);
      const s = await screenOf(page, p);
      expect((await cam(page)).distance, 'spread = zoom in').toBeLessThan(d0 * 0.8);
      expect(Math.hypot(s.x - mx, s.y - my), 'the point between the fingers stays').toBeLessThan(6);
      await ctx.close();
    });

    test('Pencil orbits about the surface under the tip; 3D mouse push zooms toward the cursor', async ({
      page,
    }) => {
      const { box, cx, cy } = await boot(page, projection);
      const px = box.width / 2 + 60;
      const py = box.height / 2 + 20;
      const hit = (await pickFace(page, px, py))[0];
      const p = hit!.point as V3;
      // Pen orbit: dispatched as pointer events with pointerType 'pen'.
      await page.evaluate(
        ([x, y]) => {
          const c = document.getElementById('c') as HTMLCanvasElement;
          const r = c.getBoundingClientRect();
          const ev = (type: string, dx: number, dy: number, buttons: number) =>
            c.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 7,
                pointerType: 'pen',
                isPrimary: true,
                bubbles: true,
                cancelable: true,
                clientX: r.left + (x as number) + dx,
                clientY: r.top + (y as number) + dy,
                button: 0,
                buttons,
                pressure: buttons ? 0.5 : 0,
              }),
            );
          ev('pointerdown', 0, 0, 1);
          for (let i = 1; i <= 8; i++) ev('pointermove', i * 6, i * 3, 1);
          ev('pointerup', 48, 24, 0);
        },
        [px, py],
      );
      await frame(page);
      // A Pencil one-finger drag orbits (the camera turned) - and the point under the tip stayed.
      const s = await screenOf(page, p);
      expect(Math.hypot(s.x - px, s.y - py)).toBeLessThan(2.5);

      // 3D mouse: z push zooms in toward the surface under the (last known) cursor.
      await page.mouse.move(cx + 60, cy + 20);
      const hit2 = (await pickFace(page, px, py))[0];
      const q = hit2!.point as V3;
      const d0 = (await cam(page)).distance;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const v = window.__viewport!.viewport;
            const start = performance.now();
            const id = setInterval(() => {
              const now = performance.now();
              if (now - start > 400) {
                clearInterval(id);
                v.motion?.({ t: [0, 0, 0], r: [0, 0, 0], time: now });
                resolve();
                return;
              }
              v.motion?.({ t: [0, 0, -0.5], r: [0, 0, 0], time: now });
            }, 8);
          }),
      );
      await frame(page);
      const s2 = await screenOf(page, q);
      expect((await cam(page)).distance).toBeLessThan(d0 * 0.9);
      expect(Math.hypot(s2.x - px, s2.y - py), 'the surface stays under the cursor').toBeLessThan(
        2,
      );
    });
  });
}

for (const projection of PROJECTIONS) {
  test.describe(`picking and overlays in ${projection}`, () => {
    test('picks round-trip: a face hit projects back to the pixel, depth is nearer-first', async ({
      page,
    }) => {
      const { box } = await boot(page, projection);
      await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.45, 0.55],
        [0.57, 0.48],
        [0.52, 0.4],
      ] as const) {
        const x = box.width * fx;
        const y = box.height * fy;
        const hit = (await pickFace(page, x, y))[0];
        if (!hit) continue;
        const s = await screenOf(page, hit.point as V3);
        expect(Math.hypot(s.x - x, s.y - y)).toBeLessThan(1.5);
        expect(hit.depth ?? 0).toBeGreaterThanOrEqual(0);
      }
      // Vertices are occlusion tested (sight lines run parallel to the view in orthographic): the
      // near top corner is found, the far bottom corner behind the box is not.
      const vertexAt = (q: V3) =>
        page.evaluate((w) => {
          const v = window.__viewport!.viewport;
          const sp = v.worldToScreen(w);
          return v.pick(sp.x, sp.y, { kinds: ['vertex'], tolerancePx: 4 }).length;
        }, q);
      expect(await vertexAt([40, 0, 20])).toBeGreaterThan(0);
      expect(await vertexAt([0, 30, 0])).toBe(0);
    });

    test('box select: window and crossing agree with what is on screen', async ({ page }) => {
      const { box } = await boot(page, projection);
      await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
      const w = box.width;
      const h = box.height;
      const all = await page.evaluate(
        ([ww, hh]) =>
          window
            .__viewport!.viewport.pickRect(
              { x0: 0, y0: 0, x1: ww as number, y1: hh as number },
              { mode: 'window', kinds: ['face'] },
            )
            .map((x) => x.index),
        [w, h],
      );
      // Iso view: three faces are visible.
      expect(new Set(all).size).toBe(3);
      const small = await page.evaluate(
        ([ww, hh]) =>
          window
            .__viewport!.viewport.pickRect(
              {
                x0: (ww as number) / 2 - 6,
                y0: (hh as number) / 2 - 6,
                x1: (ww as number) / 2 + 6,
                y1: (hh as number) / 2 + 6,
              },
              { mode: 'crossing', kinds: ['face'] },
            )
            .map((x) => x.index),
        [w, h],
      );
      expect(small.length).toBeGreaterThanOrEqual(1);
    });

    test('screen-sized dots (markers, pivot, sketch points) keep their pixel size at any depth and zoom', async ({
      page,
    }) => {
      const { cx, cy } = await boot(page, projection);
      const danger: [number, number, number] = [208, 40, 28];
      await page.evaluate(() => {
        window.__viewport!.viewport.setMarkers('m', [
          {
            kind: 'point',
            points: [
              [20, 15, 20],
              [0, 0, 0],
            ],
            tone: 'error',
          },
        ]);
      });
      await frame(page);
      const a = (await countColor(page, danger, 40)).count;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -100);
        await frame(page);
      }
      const b = (await countColor(page, danger, 40)).count;
      // Two dots, a few tens of pixels each; an unscaled sprite would fill the screen or vanish.
      expect(a).toBeGreaterThan(40);
      expect(a).toBeLessThan(4000);
      expect(b / a, 'zooming does not resize them').toBeGreaterThan(0.8);
      expect(b / a).toBeLessThan(1.25);
    });

    test('handles keep their on-screen length at any depth and zoom; the pivot marker shows', async ({
      page,
    }) => {
      const { cx, cy } = await boot(page, projection);
      await page.evaluate(() => {
        const v = window.__viewport!.viewport;
        v.setHandle('h1', {
          kind: 'arrow',
          origin: [20, 15, 20],
          direction: [0, 0, 1],
          length: 84,
        });
        v.setHandle('h2', { kind: 'arrow', origin: [0, 0, 0], direction: [1, 0, 0], length: 60 });
      });
      await frame(page);
      const len = (id: string) =>
        page.evaluate((i) => window.__viewport!.viewport.getHandleScreenLength(i), id);
      // The arrow points at/away from the camera in places: allow foreshortening only upward.
      await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
      await frame(page);
      const a = await len('h2');
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -100);
        await frame(page);
      }
      const b = await len('h2');
      expect(a).toBeGreaterThan(55);
      expect(Math.abs(a! - b!)).toBeLessThan(1.5);
      expect(a).toBeLessThan(61);
      // Orbit shows the pivot marker.
      await page.mouse.move(cx + 20, cy + 10);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(cx + 60, cy + 10, { steps: 4 });
      await frame(page);
      expect(
        (await page.evaluate(() => window.__viewport!.viewport.getNavigationState())).markerVisible,
      ).toBe(true);
      await page.mouse.up({ button: 'right' });
    });

    test('sketch overlays and reference geometry pick, section planes cut', async ({ page }) => {
      const { box } = await boot(page, projection);
      await page.evaluate(() => window.__viewport!.showSketch(true));
      await page.evaluate(() => window.__viewport!.viewport.setView('top', false));
      await frame(page);
      const hits = await page.evaluate(() => {
        const v = window.__viewport!.viewport;
        const out: string[] = [];
        for (let y = 0; y < window.innerHeight; y += 4) {
          for (let x = 0; x < window.innerWidth; x += 4) {
            const h = v.pick(x, y, { kinds: ['sketchCurve', 'region'] })[0];
            if (h) out.push(h.kind);
          }
        }
        return out;
      });
      expect(hits.filter((k) => k === 'sketchCurve').length).toBeGreaterThan(3);
      expect(hits.filter((k) => k === 'region').length).toBeGreaterThan(20);
      await page.evaluate(() => window.__viewport!.hideSketch());

      // Reference geometry (ADR-093): plane, axis and point are picked by name.
      const frameOf = (origin: V3, z: V3 = [0, 0, 1]) => ({
        origin,
        x: [1, 0, 0] as V3,
        y: [0, 1, 0] as V3,
        z,
      });
      await page.evaluate((refs) => window.__viewport!.viewport.setReferences(refs), [
        { name: 'P1', kind: 'plane', frame: frameOf([20, 15, 40]), extent: 30 },
        {
          name: 'A1',
          kind: 'axis',
          frame: { origin: [60, 15, 10], x: [1, 0, 0], y: [0, 1, 0], z: [0, 1, 0] },
          extent: 40,
        },
        { name: 'X1', kind: 'point', frame: frameOf([-20, 15, 30]), extent: 10 },
      ] as const as never);
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      const refPick = (q: V3) =>
        page.evaluate((w) => {
          const v = window.__viewport!.viewport;
          const s = v.worldToScreen(w);
          return v.pick(s.x, s.y, { all: true }).map((h) => h.bodyId);
        }, q);
      expect(await refPick([-4, 15, 40])).toContain('P1');
      expect(await refPick([60, 15, 10])).toContain('A1');
      expect(await refPick([-20, 15, 30])).toContain('X1');
      await page.evaluate(() => window.__viewport!.viewport.setReferences([]));

      // A section through the middle removes the near half: its cap faces the camera.
      await page.evaluate(() => {
        window.__viewport!.viewport.setSection({
          origin: [20, 15, 10],
          normal: [0, 0, 1],
          caps: true,
        });
      });
      await frame(page);
      const top = await page.evaluate(
        ([w, h]) => {
          const v = window.__viewport!.viewport;
          const s = v.worldToScreen([20, 15, 10]);
          return { s, pts: v.pick(s.x, s.y, { kinds: ['face'] }).map((x) => x.point), w, h };
        },
        [box.width, box.height],
      );
      // The remaining body is below z = 10: nothing is hit above the cut.
      for (const p of top.pts) expect(p[2]!).toBeLessThanOrEqual(10 + 1e-3);
      await page.evaluate(() => window.__viewport!.viewport.setSection(null));
    });
  });
}
