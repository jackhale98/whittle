import { expect, type Page, test } from '@playwright/test';
import type { NavigationPreset } from '@wren-cad/contracts';
import { open, settle } from './helpers';
import { PERF_FACTOR } from './perf-budget';

/**
 * Wheel zoom (ADR-057 addendum): the camera moves toward the surface under the cursor, every notch
 * scales the distance to it by the same ratio, nothing blocks the main thread between notches,
 * and the zoom keeps going after an orbit about a cursor pivot. Covers all four presets.
 */

const PRESETS: Array<{ preset: NavigationPreset; orbit: 'left' | 'middle' | 'right' }> = [
  { preset: 'rightOrbit', orbit: 'right' },
  { preset: 'rightOrbitRepeat', orbit: 'right' },
  { preset: 'middleOrbit', orbit: 'middle' },
  { preset: 'middlePan', orbit: 'right' },
];

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;

async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const longs: number[] = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longs.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
    const dists: number[] = [];
    window.addEventListener(
      'wheel',
      () => dists.push(window.__viewport!.viewport.getCameraState().distance),
      true,
    );
    (window as unknown as { __wp: unknown }).__wp = { longs, dists };
  });
}

const take = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __wp: { longs: number[]; dists: number[] } }).__wp;
    const out = { longs: [...p.longs], dists: [...p.dists] };
    p.longs.length = 0;
    p.dists.length = 0;
    return out;
  });

/** Distance from the camera to the face under (x, y), and that surface point. */
const surface = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const v = window.__viewport!.viewport;
      const h = v.pick(px as number, py as number, { kinds: ['face'] })[0];
      const c = v.getCameraState().position;
      if (!h) return null;
      return {
        d: Math.hypot(h.point[0] - c[0]!, h.point[1] - c[1]!, h.point[2] - c[2]!),
        p: h.point,
      };
    },
    [x, y],
  );

test('perf probe: wheel burst on a 1M-triangle model has no long task and a steady zoom ratio', async ({
  page,
}) => {
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1 (minutes on software GL)');
  test.setTimeout(300_000);
  await open(page, '?backend=webgl2');
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width * 0.55;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
  // Rest work (BVH prebuild) runs after BVH_PREBUILD_QUIET_MS of stillness: let it finish first.
  await page.waitForFunction(
    () => window.__viewport!.viewport.getPickStats().lastBvhBuildMs > 0,
    null,
    {
      timeout: 60_000,
    },
  );
  await page.waitForTimeout(1000);
  await install(page);
  await take(page);
  const notches = 20;
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(800);
  const r = await take(page);
  const ratios = r.dists.slice(1).map((d, i) => d / (r.dists[i] as number));
  const med = median(ratios.slice(1));
  console.log(
    `[perf] 1M tris wheel burst: ${notches} notches, long tasks ${r.longs.length} (max ${Math.max(0, ...r.longs).toFixed(0)} ms), ` +
      `ratio median ${med.toFixed(3)} (min ${Math.min(...ratios.slice(1)).toFixed(3)}, max ${Math.max(...ratios.slice(1)).toFixed(3)})`,
  );
  expect(
    Math.max(0, ...r.longs),
    'no long task over 50 ms (x PERF_FACTOR) in the burst',
  ).toBeLessThanOrEqual(50 * PERF_FACTOR);
  for (const x of ratios.slice(1)) expect(Math.abs(x / med - 1)).toBeLessThanOrEqual(0.1);
});

for (const { preset, orbit } of PRESETS) {
  test.describe(`preset ${preset}`, () => {
    test('notches scale the distance by one ratio, toward the cursor, with no stall after an orbit', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await open(page, '?backend=webgl2');
      await settle(page);
      await page.evaluate((p) => window.__viewport!.viewport.setNavigation({ preset: p }), preset);
      const box = (await page.locator('canvas').boundingBox())!;
      // A point on the box: project its top-face centre.
      const top = await page.evaluate(() =>
        window.__viewport!.viewport.worldToScreen([20, 15, 20]),
      );
      const ox = box.x + top.x;
      const oy = box.y + top.y;
      await page.mouse.move(ox, oy);
      await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
      await install(page);

      // 1. Orbit about a cursor pivot (the pivot lands on the box under the cursor).
      await page.mouse.down({ button: orbit });
      await page.mouse.move(ox + 70, oy + 25, { steps: 8 });
      await page.mouse.up({ button: orbit });
      const nav = await page.evaluate(() => window.__viewport!.viewport.getNavigationState());
      expect(nav.pivotSource).toBe('surface');
      await settle(page);
      await page.evaluate(() => window.__viewport!.viewport.whenPickReady());

      // 2. Wheel in at the pivot's screen position: 10 notches, each one settles.
      const at = nav.pivotScreen as { x: number; y: number };
      await page.mouse.move(box.x + at.x, box.y + at.y);
      const s0 = await surface(page, at.x, at.y);
      expect(s0, 'a surface under the cursor').not.toBeNull();
      const ds: number[] = [(s0 as { d: number }).d];
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(450);
        await page.evaluate(() => window.__viewport!.viewport.nextFrame());
        const s = await surface(page, at.x, at.y);
        expect(s, `surface still under the cursor after notch ${i + 1}`).not.toBeNull();
        ds.push((s as { d: number }).d);
        // The same surface point stays under the cursor.
        const p0 = (s0 as { p: number[] }).p;
        const p = (s as { p: number[] }).p;
        expect(Math.hypot(p[0]! - p0[0]!, p[1]! - p0[1]!, p[2]! - p0[2]!)).toBeLessThan(0.5);
      }
      const ratios = ds.slice(1).map((d, i) => d / (ds[i] as number));
      for (const r of ratios) {
        expect(r).toBeGreaterThan(0.85 * 0.9);
        expect(r).toBeLessThan(0.85 * 1.1);
      }

      // 3. And back out: the ratio is the inverse, and the view never jumps.
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(450);
      }
      await page.evaluate(() => window.__viewport!.viewport.nextFrame());
      const back = await surface(page, at.x, at.y);
      expect((back as { d: number }).d / ds[0]!).toBeGreaterThan(0.9);
      expect((back as { d: number }).d / ds[0]!).toBeLessThan(1.1);
    });

    test('a burst of notches is steady and does not stall', async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, '?backend=webgl2');
      await settle(page);
      await page.evaluate((p) => window.__viewport!.viewport.setNavigation({ preset: p }), preset);
      const box = (await page.locator('canvas').boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
      await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
      await install(page);
      const before = (await page.evaluate(() => window.__viewport!.viewport.getCameraState()))
        .distance;
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(60);
        if (preset === 'middleOrbit' && i % 3 === 2) {
          // A loose wheel click between notches (a press without movement) must not disturb the zoom.
          await page.mouse.down({ button: 'middle' });
          await page.mouse.up({ button: 'middle' });
        }
      }
      await page.waitForTimeout(600);
      const r = await take(page);
      const after = (await page.evaluate(() => window.__viewport!.viewport.getCameraState()))
        .distance;
      expect(Math.max(0, ...r.longs)).toBeLessThanOrEqual(50);
      // 12 notches of 0.85 on the distance to the anchor (the target distance follows it).
      // (The first notch re-bases the target distance onto the anchor's depth, so only a loose bound.)
      expect(after / before).toBeGreaterThan(0.85 ** 12 * 0.5);
      expect(after / before).toBeLessThan(0.85 ** 12 * 2);
      const ratios = r.dists.slice(1).map((d, i) => d / (r.dists[i] as number));
      const med = median(ratios.slice(1));
      for (const x of ratios.slice(1)) expect(Math.abs(x / med - 1)).toBeLessThanOrEqual(0.1);
    });
  });
}

test('reduced motion: a notch applies at once; invertZoom flips it', async ({ page }) => {
  await open(page, '?backend=webgl2&reducedMotion=1');
  await settle(page);
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The first notch re-bases the target distance onto the anchor's depth; measure the second.
  await page.mouse.wheel(0, -100);
  await page.evaluate(() => window.__viewport!.viewport.nextFrame());
  const d0 = (await page.evaluate(() => window.__viewport!.viewport.getCameraState())).distance;
  await page.mouse.wheel(0, -100);
  await page.evaluate(() => window.__viewport!.viewport.nextFrame());
  const d1 = (await page.evaluate(() => window.__viewport!.viewport.getCameraState())).distance;
  expect(d1 / d0).toBeCloseTo(0.85, 2);
  await page.evaluate(() => window.__viewport!.viewport.setNavigation({ invertZoom: true }));
  await page.mouse.wheel(0, -100);
  await page.evaluate(() => window.__viewport!.viewport.nextFrame());
  const d2 = (await page.evaluate(() => window.__viewport!.viewport.getCameraState())).distance;
  expect(d2 / d1).toBeCloseTo(1 / 0.85, 2);
});
