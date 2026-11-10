import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { dist, frame, open, type RGB, samplePoints, settle } from './helpers';
import { PERF_FACTOR } from './perf-budget';

const Q = '?backend=webgl2&reducedMotion=1';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'screenshots');

// Fixture (harness `setCompare`): box x 0-40, y 0-30, z 0-20; added block x 40-55 (z 0-8);
// removed through-hole x 14-26, y 9-21. Top view: +X to the right.
const ADDED_AT: [number, number, number] = [48, 15, 8];
const REMOVED_AT: [number, number, number] = [20, 15, 20];
const BODY_AT: [number, number, number] = [6, 5, 20];

const greenish = (p: RGB) => p[1] > p[0] + 25 && p[1] > p[2] + 10;
const reddish = (p: RGB) => p[0] > p[1] + 40 && p[0] > p[2] + 40;

async function screenAt(page: Page, pts: Array<[number, number, number]>) {
  return page.evaluate((ps) => ps.map((p) => window.__viewport!.viewport.worldToScreen(p)), pts);
}

async function colours(page: Page, pts: Array<[number, number, number]>) {
  const at = await screenAt(page, pts);
  return samplePoints(
    page,
    at.map((a) => [a.x, a.y] as [number, number]),
  );
}

async function setup(page: Page, query = Q) {
  await open(page, query);
  await page.evaluate(() => {
    const v = window.__viewport!;
    v.viewport.setView('top', false);
    v.viewport.fitAll(false, { includeOverlay: false });
  });
  await frame(page);
}

test.describe('compare overlay', () => {
  test('added block is green, removed hole is red, toggles work, null restores the bodies', async ({
    page,
  }) => {
    await setup(page);
    // Fit including the overlay, so the added block is inside the view.
    await page.evaluate(() => {
      window.__viewport!.setCompare();
      window.__viewport!.viewport.fitAll(false, { includeOverlay: true });
    });
    await page.evaluate(() => window.__viewport!.clearCompare());
    await frame(page);

    const before = await page.evaluate(() =>
      window.__viewport!.viewport.getBodyMaterialState('box'),
    );
    const [bodyBefore, addedBefore] = await colours(page, [BODY_AT, ADDED_AT]);
    expect(before).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    expect(greenish(addedBefore!)).toBe(false);

    await page.evaluate(() => window.__viewport!.setCompare());
    await frame(page);
    mkdirSync(SHOTS, { recursive: true });
    await page.locator('canvas').screenshot({ path: join(SHOTS, 'compare-both.png') });
    const stats = await page.evaluate(() => window.__viewport!.viewport.getCompareStats());
    expect(stats).toMatchObject({
      active: true,
      show: 'both',
      addedMeshes: 1,
      removedMeshes: 1,
      ghostOpacity: 0.15,
    });
    const ghosted = await page.evaluate(() =>
      window.__viewport!.viewport.getBodyMaterialState('box'),
    );
    expect(ghosted).toMatchObject({ opacity: 0.15, transparent: true, depthWrite: false });
    const [bodyG, addedG, removedG] = await colours(page, [BODY_AT, ADDED_AT, REMOVED_AT]);
    expect(greenish(addedG!), `added ${addedG}`).toBe(true);
    expect(reddish(removedG!), `removed ${removedG}`).toBe(true);
    // The live body has faded away to nearly the background.
    expect(dist(bodyG!, bodyBefore!)).toBeGreaterThan(8);

    // Toggles: only one side at a time; geometry is not rebuilt.
    const builds = stats.geometryBuilds;
    await page.evaluate(() => window.__viewport!.setCompare({ show: 'added' }));
    await frame(page);
    let [a, r] = await colours(page, [ADDED_AT, REMOVED_AT]);
    expect(greenish(a!)).toBe(true);
    expect(reddish(r!)).toBe(false);
    await page.evaluate(() => window.__viewport!.setCompare({ show: 'removed' }));
    await frame(page);
    [a, r] = await colours(page, [ADDED_AT, REMOVED_AT]);
    expect(greenish(a!)).toBe(false);
    expect(reddish(r!)).toBe(true);
    const after = await page.evaluate(() => window.__viewport!.viewport.getCompareStats());
    expect(after.show).toBe('removed');
    expect(after.geometryBuilds).toBe(builds);

    // null restores opacity and material state exactly and removes the colours.
    await page.evaluate(() => window.__viewport!.clearCompare());
    await frame(page);
    const restored = await page.evaluate(() =>
      window.__viewport!.viewport.getBodyMaterialState('box'),
    );
    expect(restored).toEqual(before);
    expect(await page.evaluate(() => window.__viewport!.viewport.getCompareStats())).toMatchObject({
      active: false,
      ghostOpacity: null,
    });
    const [bodyAfter, addedAfter, removedAfter] = await colours(page, [
      BODY_AT,
      ADDED_AT,
      REMOVED_AT,
    ]);
    expect(dist(bodyAfter!, bodyBefore!)).toBeLessThan(3);
    expect(greenish(addedAfter!)).toBe(false);
    expect(reddish(removedAfter!)).toBe(false);
  });

  test('removed material stays visible even when the bodies are not ghosted (ghost 1)', async ({
    page,
  }) => {
    await setup(page);
    await page.evaluate(() => window.__viewport!.setCompare({ ghost: 1 }));
    await frame(page);
    const [removed] = await colours(page, [REMOVED_AT]);
    expect(reddish(removed!), `removed ${removed}`).toBe(true);
  });

  test('overlay meshes are not pickable; live bodies still are', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__viewport!.setCompare();
      window.__viewport!.viewport.fitAll(false, { includeOverlay: true });
    });
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    await frame(page);
    const [onAdded, onBody] = await screenAt(page, [ADDED_AT, BODY_AT]);
    const hits = await page.evaluate(
      ([a, b]) => {
        const v = window.__viewport!.viewport;
        const tol = { tolerancePx: 2 };
        return {
          added: v.pick(a!.x, a!.y, tol).map((h) => h.bodyId),
          body: v.pick(b!.x, b!.y, tol).map((h) => `${h.bodyId}:${h.kind}`),
        };
      },
      [onAdded!, onBody!],
    );
    expect(hits.added).toEqual([]);
    expect(hits.body).toContain('box:face');
  });

  test('section view clips the overlay', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__viewport!.setCompare();
      window.__viewport!.viewport.fitAll(false, { includeOverlay: true });
    });
    await frame(page);
    expect(greenish((await colours(page, [ADDED_AT]))[0]!)).toBe(true);
    // Keep x <= 30: the added block (x 40-55) is clipped, the hole (x 14-26) stays.
    await page.evaluate(() =>
      window.__viewport!.viewport.setSection({
        origin: [30, 15, 10],
        normal: [1, 0, 0],
        caps: true,
      }),
    );
    await frame(page);
    const [a, r] = await colours(page, [ADDED_AT, REMOVED_AT]);
    expect(greenish(a!), `added under section ${a}`).toBe(false);
    expect(reddish(r!), `removed under section ${r}`).toBe(true);
  });

  test('fit-to-view includes the overlay only when asked', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.__viewport!.setCompare());
    const dists = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.fitAll(false);
      const plain = v.getCameraState().distance;
      v.fitAll(false, { includeOverlay: true });
      return { plain, withOverlay: v.getCameraState().distance };
    });
    expect(dists.withOverlay).toBeGreaterThan(dists.plain);
  });

  test('dark theme uses the dark palette (still green and red)', async ({ page }) => {
    await setup(page, `${Q}&theme=dark`);
    await page.evaluate(() => {
      window.__viewport!.setCompare();
      window.__viewport!.viewport.fitAll(false, { includeOverlay: true });
    });
    await frame(page);
    const [a, r] = await colours(page, [ADDED_AT, REMOVED_AT]);
    expect(greenish(a!), `added ${a}`).toBe(true);
    expect(reddish(r!), `removed ${r}`).toBe(true);
  });

  test('perf probe: toggling show and re-setting the overlay stay within the 16 ms budget', async ({
    page,
  }) => {
    await setup(page);
    await settle(page); // the one-off environment build stalls software GL for seconds
    await page.evaluate(() => {
      window.__viewport!.setCompare();
      window.__viewport!.viewport.fitAll(false, { includeOverlay: true });
    });
    await frame(page);
    // Warm every state once (first draw of each material may compile a shader).
    await page.evaluate(async () => {
      const w = window.__viewport!;
      for (const show of ['added', 'removed', 'both'] as const) {
        w.setCompare({ show });
        await w.viewport.nextFrame();
      }
    });
    const result = await page.evaluate(async () => {
      const w = window.__viewport!;
      const v = w.viewport;
      const timed = async (fn: () => void) => {
        const t0 = performance.now();
        fn();
        const handler = performance.now() - t0;
        await v.nextFrame();
        return { handler, total: performance.now() - t0, cpu: v.stats().frameMs };
      };
      const toggles: Array<{ handler: number; total: number; cpu: number }> = [];
      const resets: Array<{ handler: number; total: number; cpu: number }> = [];
      const shows = ['added', 'removed', 'both'] as const;
      const materialsBefore = w.sharedMaterialCount();
      for (let i = 0; i < 30; i++) {
        toggles.push(await timed(() => w.setCompare({ show: shows[i % 3] })));
      }
      const builds0 = v.getCompareStats().geometryBuilds;
      for (let i = 0; i < 30; i++) resets.push(await timed(() => w.setCompare({ fresh: true })));
      return {
        toggles,
        resets,
        rebuilt: v.getCompareStats().geometryBuilds - builds0,
        materialsGrew: w.sharedMaterialCount() - materialsBefore,
      };
    });
    const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
    const summary = {
      toggleHandlerP95: p95(result.toggles.map((t) => t.handler)),
      toggleToFrameP95: p95(result.toggles.map((t) => t.total)),
      toggleCpuMax: Math.max(...result.toggles.map((t) => t.cpu)),
      resetHandlerP95: p95(result.resets.map((t) => t.handler)),
      resetToFrameMedian: [...result.resets.map((t) => t.total)].sort((a, b) => a - b)[15]!,
      resetToFrameP95: p95(result.resets.map((t) => t.total)),
      resetCpuMax: Math.max(...result.resets.map((t) => t.cpu)),
    };
    console.log(`[perf] compare ${JSON.stringify(summary)}`);
    test.info().annotations.push({ type: 'compare-perf', description: JSON.stringify(summary) });
    expect(result.rebuilt).toBe(30); // re-setting with new buffers rebuilds geometry...
    expect(result.materialsGrew).toBe(0); // ...but never creates new shared materials
    expect(summary.toggleHandlerP95).toBeLessThanOrEqual(16 * PERF_FACTOR);
    expect(summary.resetHandlerP95).toBeLessThanOrEqual(16 * PERF_FACTOR);
    // Render CPU time per frame (PLAN §10: <= 16 ms interaction) is gated below. Wall latency to
    // the next frame on SwiftShader is dominated by software rasterisation of the whole lit scene
    // (a plain camera move costs the same), so that latency is reported, not gated.
    if (process.env.WREN_PERF_ASSERT) {
      // Software GL: the 16 ms budget times the CI factor (ADR-010); WREN_FRAME_BUDGET_MS overrides.
      const budget = Number(process.env.WREN_FRAME_BUDGET_MS ?? 16 * PERF_FACTOR);
      expect(summary.toggleCpuMax).toBeLessThanOrEqual(budget);
      expect(summary.resetCpuMax).toBeLessThanOrEqual(budget);
    }
  });
});
