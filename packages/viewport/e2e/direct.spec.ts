import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { boxMesh } from '@wren-cad/test-fixtures';
import { camera, countColor, dist, frame, open, samplePoints, touchDriver } from './helpers';
import { PERF_FACTOR } from './perf-budget';

const Q = '?backend=webgl2&reducedMotion=1';
const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, '..', 'test-results', 'screenshots');
const TOP = boxMesh(1, 1, 1).faceNames.indexOf('face.zmax');

test.describe('push/pull preview', () => {
  test('prism preview is drawn translucent accent for add and red for cut', async ({ page }) => {
    await open(page, Q);
    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
    await frame(page);

    const at = (p: [number, number, number]) =>
      page.evaluate((q) => window.__viewport!.viewport.worldToScreen(q), p);
    const capAdd = await at([20, 15, 36]);
    const topFace = await at([20, 15, 20]);
    const [bgBefore, faceBefore] = await samplePoints(page, [
      [capAdd.x, capAdd.y],
      [topFace.x, topFace.y],
    ]);

    await page.evaluate((face) => {
      window.__viewport!.viewport.setPreview('pp', {
        kind: 'prism',
        bodyId: 'box',
        faces: [face],
        direction: [0, 0, 1],
        distance: 18,
      });
    }, TOP);
    await frame(page);
    await page.locator('canvas').screenshot({ path: join(SHOTS, 'preview-add.png') });
    const [addPx, faceAdd] = await samplePoints(page, [
      [capAdd.x, capAdd.y],
      [topFace.x, topFace.y],
    ]);
    // Over the empty scene the cap is a translucent accent (blue): red drops, blue stays.
    expect(addPx![2]).toBeGreaterThan(addPx![0] + 50);
    expect(dist(addPx!, bgBefore!)).toBeGreaterThan(40);
    // Seen through the add-preview the old top face is tinted too, but the body is still there.
    expect(dist(faceAdd!, faceBefore!)).toBeGreaterThan(15);

    await page.evaluate((face) => {
      window.__viewport!.viewport.setPreview('pp', {
        kind: 'prism',
        bodyId: 'box',
        faces: [face],
        direction: [0, 0, 1],
        distance: -12,
      });
    }, TOP);
    await frame(page);
    await page.locator('canvas').screenshot({ path: join(SHOTS, 'preview-cut.png') });
    // The cut shows through the solid in a red tint (its cap sits inside the body).
    const inside = await at([20, 15, 8]);
    const [cutPx, cutBefore] = await samplePoints(page, [
      [inside.x, inside.y],
      [topFace.x, topFace.y],
    ]);
    expect(cutPx![0]).toBeGreaterThan(cutPx![2] + 20);
    expect(dist(cutBefore!, faceBefore!)).toBeGreaterThan(10);

    await page.evaluate(() => window.__viewport!.viewport.setPreview('pp', null));
    await frame(page);
    const [goneFace] = await samplePoints(page, [[topFace.x, topFace.y]]);
    expect(dist(goneFace!, faceBefore!)).toBeLessThan(3);
  });

  test('a distance-only update is a uniform write: no rebuild, no typed-array allocation', async ({
    page,
  }) => {
    await open(page, Q);
    const result = await page.evaluate((face) => {
      const v = window.__viewport!.viewport;
      const spec = (distance: number) => ({
        kind: 'prism' as const,
        bodyId: 'box',
        faces: [face],
        direction: [0, 0, 1] as [number, number, number],
        distance,
      });
      v.setPreview('pp', spec(5));
      const builds0 = v.getTouchStats().prismBuilds;

      // Count typed-array constructions during the update calls.
      const w = window as unknown as Record<string, unknown>;
      let allocs = 0;
      const names = ['Float32Array', 'Uint32Array', 'Float64Array', 'Uint8Array', 'Uint16Array'];
      const originals: Record<string, unknown> = {};
      for (const n of names) {
        const Orig = w[n] as new (...a: unknown[]) => unknown;
        originals[n] = Orig;
        w[n] = new Proxy(Orig, {
          construct(target, args, nt) {
            allocs++;
            return Reflect.construct(target, args, nt);
          },
        });
      }
      for (let i = 0; i < 300; i++) v.setPreview('pp', spec(5 + i * 0.1));
      for (const n of names) w[n] = originals[n];
      return { builds0, builds1: v.getTouchStats().prismBuilds, allocs };
    }, TOP);
    expect(result.builds0).toBe(1);
    expect(result.builds1).toBe(1);
    expect(result.allocs).toBe(0);

    // Changing the faces or the body does rebuild.
    const rebuilt = await page.evaluate((face) => {
      const v = window.__viewport!.viewport;
      v.setPreview('pp', {
        kind: 'prism',
        bodyId: 'box',
        faces: [face, 0],
        direction: [0, 0, 1],
        distance: 3,
      });
      return v.getTouchStats().prismBuilds;
    }, TOP);
    expect(rebuilt).toBe(2);
  });

  test('perf probe: same-frame preview latency, update -> presented in <= 16 ms during a drag', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
    await frame(page);
    await page.evaluate((face) => {
      const v = window.__viewport!.viewport;
      const w = window as unknown as { __lat: Array<Record<string, number>> };
      w.__lat = [];
      v.setPreview('pp', {
        kind: 'prism',
        bodyId: 'box',
        faces: [face],
        direction: [0, 0, 1],
        distance: 1,
      });
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      canvas.addEventListener('pointermove', (e) => {
        const t0 = performance.now();
        const r0 = v.getRenderCount();
        v.setPreview('pp', {
          kind: 'prism',
          bodyId: 'box',
          faces: [face],
          direction: [0, 0, 1],
          distance: (600 - e.offsetY) * 0.2,
        });
        void v.nextFrame().then(() => {
          w.__lat.push({
            handlerToRender: performance.now() - t0,
            renderCpuMs: v.stats().frameMs,
            frames: v.getRenderCount() - r0,
            presentedAt: v.getTouchStats().lastPreviewPresentedAt - r0,
          });
        });
      });
    }, TOP);
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + 300);
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(box.x + 300 + (i % 5), box.y + 300 + i * 3);
      await page.waitForTimeout(18);
    }
    await page.waitForTimeout(100);
    const lat = await page.evaluate(
      () => (window as unknown as { __lat: Array<Record<string, number>> }).__lat,
    );
    expect(lat.length).toBeGreaterThan(40);
    const pct = (key: string, q: number) => {
      const v = lat.map((l) => l[key] as number).sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(v.length * q))] as number;
    };
    const mean = (key: string) => lat.reduce((a, l) => a + (l[key] as number), 0) / lat.length;
    const summary = {
      samples: lat.length,
      handlerToRender: {
        mean: mean('handlerToRender'),
        p95: pct('handlerToRender', 0.95),
        max: pct('handlerToRender', 1),
      },
      renderCpuMs: { mean: mean('renderCpuMs'), max: pct('renderCpuMs', 1) },
    };
    console.log(`[perf] preview latency ${JSON.stringify(summary)}`);
    test.info().annotations.push({ type: 'preview-latency', description: JSON.stringify(summary) });
    // Every update lands in the very next frame...
    for (const l of lat) {
      expect(l.frames).toBe(1);
      expect(l.presentedAt).toBe(1);
    }
    // ...and within the 16 ms budget (PLAN §10), times the CI factor (ADR-010).
    expect(pct('handlerToRender', 0.95)).toBeLessThanOrEqual(16 * PERF_FACTOR);
  });

  test('mesh preview is a translucent accent solid; prism of an unknown body is ignored', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
    await frame(page);
    const at = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([66, 0, 6]));
    const [before] = await samplePoints(page, [[at.x, at.y]]);
    await page.evaluate(() => window.__viewport!.previewBox('mp', [60, 0, 0]));
    await frame(page);
    const [during] = await samplePoints(page, [[at.x, at.y]]);
    expect(during![2]).toBeGreaterThan(during![0] + 20); // accent tint over the empty scene
    expect(dist(during!, before!)).toBeGreaterThan(30);
    await page.evaluate(() => window.__viewport!.previewBox('mp', null));
    await frame(page);
    const [after] = await samplePoints(page, [[at.x, at.y]]);
    expect(dist(after!, before!)).toBeLessThan(3);

    const builds = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.setPreview('x', {
        kind: 'prism',
        bodyId: 'nope',
        faces: [0],
        direction: [0, 0, 1],
        distance: 4,
      });
      return v.getTouchStats().prismBuilds;
    });
    expect(builds).toBe(0);
    expect(await page.evaluate(() => window.__viewportError)).toBeUndefined();
  });

  test('previews follow a body that is replaced (coarse -> fine) and a theme change', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate((face) => {
      const v = window.__viewport!;
      v.viewport.setPreview('pp', {
        kind: 'prism',
        bodyId: 'box',
        faces: [face],
        direction: [0, 0, 1],
        distance: 6,
      });
      v.resizeBox(50, 30, 20); // new buffers, same body id
      v.viewport.setTheme('dark');
    }, TOP);
    await frame(page);
    const builds = await page.evaluate(
      () => window.__viewport!.viewport.getTouchStats().prismBuilds,
    );
    expect(builds).toBe(2);
  });
});

test.describe('handle', () => {
  const place = (page: import('@playwright/test').Page) =>
    page.evaluate((face) => {
      void face;
      const v = window.__viewport!.viewport;
      v.setView('iso', false);
      v.setHandle('pp', { kind: 'arrow', origin: [20, 15, 20], direction: [0, 0, 1] });
    }, TOP);

  test('is picked before the face behind it, as kind handle with entity = id', async ({ page }) => {
    await open(page, Q);
    await place(page);
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const r = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      const o = v.worldToScreen([20, 15, 20]);
      return {
        o,
        atOrigin: v.pick(o.x, o.y),
        faceOnly: v.pick(o.x, o.y, { kinds: ['face'] }),
        all: v.pick(o.x, o.y, { all: true }),
        away: v.pick(o.x - 120, o.y + 60),
      };
    });
    expect(r.atOrigin[0]?.kind).toBe('handle');
    expect(r.atOrigin[0]?.entity).toBe('pp');
    expect(r.faceOnly[0]?.kind).toBe('face'); // the face is right there if handles are not wanted
    expect(r.all[0]?.kind).toBe('handle');
    expect(r.all.some((h: { kind: string }) => h.kind === 'face')).toBe(true);
    expect(r.away[0]?.entity).not.toBe('pp');

    // Removing it releases the pick.
    await page.evaluate(() => window.__viewport!.viewport.setHandle('pp', null));
    const after = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      const o = v.worldToScreen([20, 15, 20]);
      return v.pick(o.x, o.y);
    });
    expect(after[0]?.kind).not.toBe('handle');
  });

  test('keeps a constant size on screen while zooming and orbiting', async ({ page }) => {
    await open(page, Q);
    await place(page);
    await frame(page);
    const len = () => page.evaluate(() => window.__viewport!.viewport.getHandleScreenLength('pp'));
    const a = (await len())!;
    // Absolute length: looking along the horizon the arrow is not foreshortened: 84 px by default.
    await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
    await frame(page);
    const level = (await len())!;
    expect(level).toBeGreaterThan(80);
    expect(level).toBeLessThan(88);
    await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.zoomTo([20, 15, 20], 8, false));
    await frame(page);
    const b = (await len())!;
    await page.evaluate(() => window.__viewport!.viewport.zoomTo([20, 15, 20], 400, false));
    await frame(page);
    const c = (await len())!;
    // within perspective foreshortening of the arrow itself (it is sized at its origin's depth)
    for (const x of [b, c]) expect(Math.abs(x - a)).toBeLessThan(6);
    // And a custom length.
    await page.evaluate(() =>
      window.__viewport!.viewport.setHandle('pp', {
        kind: 'arrow',
        origin: [20, 15, 20],
        direction: [0, 0, 1],
        length: 40,
      }),
    );
    await frame(page);
    expect(Math.abs((await len())! - 40 * (a / level))).toBeLessThan(6); // same orientation as `a`
  });

  test('is drawn in the accent colour and highlights on hover', async ({ page }) => {
    await open(page, Q);
    await place(page);
    await frame(page);
    const o = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([20, 15, 20]));
    const box = (await page.locator('canvas').boundingBox())!;
    // sample along the shaft (screen up from the origin)
    const samples = await samplePoints(page, [[o.x, o.y - 30]]);
    expect(samples[0]![2]).toBeGreaterThan(samples[0]![0] + 40); // blue-ish accent

    const cold = await countColor(page, [11, 95, 232], 40);
    await page.mouse.move(box.x + o.x, box.y + o.y - 30);
    await page.waitForTimeout(100);
    await frame(page);
    expect(
      (await page.evaluate(() => window.__viewport!.viewport.getTouchStats())).handleHover,
    ).toBe('pp');
    const hot = await countColor(page, [11, 95, 232], 40);
    expect(hot.count).toBeLessThan(cold.count); // lighter tone replaces the accent
    await page.mouse.move(box.x + o.x - 200, box.y + o.y + 150);
    await page.waitForTimeout(100);
    expect(
      (await page.evaluate(() => window.__viewport!.viewport.getTouchStats())).handleHover,
    ).toBeNull();
  });

  test('a press on the handle never navigates; the app still gets the pointer', async ({
    page,
  }) => {
    await open(page, Q);
    await place(page);
    await frame(page);
    await page.evaluate(() => {
      const w = window as unknown as { __ptr: string[] };
      w.__ptr = [];
      const c = document.querySelector('canvas')!;
      for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
        c.addEventListener(type, (e) => w.__ptr.push(`${type}:${e.pointerType}`));
      }
      window.__viewport!.viewport.onGesture((g) => w.__ptr.push(`gesture:${g.kind}`));
    });
    const o = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([20, 15, 20]));
    const box = (await page.locator('canvas').boundingBox())!;
    const before = await camera(page);
    await page.mouse.move(box.x + o.x, box.y + o.y - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + o.x + 5, box.y + o.y - 120, { steps: 10 });
    await page.mouse.up();
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeLessThan(1e-3);
    const ptr = await page.evaluate(() => (window as unknown as { __ptr: string[] }).__ptr);
    expect(ptr).toContain('pointerdown:mouse');
    expect(ptr).toContain('pointermove:mouse');
    expect(ptr).toContain('pointerup:mouse');
    expect(ptr.filter((p) => p.startsWith('gesture:'))).toEqual([]);

    // Navigation is back for a press elsewhere.
    await page.mouse.move(box.x + o.x - 250, box.y + o.y + 150);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + o.x - 120, box.y + o.y + 150, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeGreaterThan(3);
  });

  test('with touch: dragging the handle does not orbit, and the finger needs no precision', async ({
    page,
  }) => {
    await open(page, Q);
    await place(page);
    await frame(page);
    const t = await touchDriver(page);
    const o = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([20, 15, 20]));
    const before = await camera(page);
    // 20 px beside the shaft: inside the finger tolerance
    await t.start([{ x: o.x + 18, y: o.y - 40, id: 1 }]);
    for (let i = 1; i <= 8; i++) {
      await t.move([{ x: o.x + 18, y: o.y - 40 - i * 10, id: 1 }]);
      await page.waitForTimeout(16);
    }
    await t.end();
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeLessThan(1e-3);
  });
});

test.describe('markers and sketch points', () => {
  test('setMarkers draws tone-coloured points, lines and dashed polylines; null removes', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
    await frame(page);
    const danger: [number, number, number] = [208, 40, 28];
    const base = await countColor(page, danger, 30);

    await page.evaluate(() =>
      window.__viewport!.viewport.setMarkers('m', [
        {
          kind: 'line',
          points: [
            [-10, -5, 10],
            [50, -5, 10],
          ],
          tone: 'error',
        },
      ]),
    );
    await frame(page);
    const solid = await countColor(page, danger, 30);
    expect(solid.count).toBeGreaterThan(base.count + 100);

    await page.evaluate(() =>
      window.__viewport!.viewport.setMarkers('m', [
        {
          kind: 'polyline',
          points: [
            [-10, -5, 10],
            [20, -5, 10],
            [50, -5, 10],
          ],
          tone: 'error',
          dashed: true,
        },
      ]),
    );
    await frame(page);
    const dashed = await countColor(page, danger, 30);
    expect(dashed.count).toBeGreaterThan(base.count + 40);
    expect(dashed.count).toBeLessThan(solid.count * 0.9);

    const warn: [number, number, number] = [194, 124, 0];
    const w0 = await countColor(page, warn, 30);
    await page.evaluate(() =>
      window.__viewport!.viewport.setMarkers('m', [
        {
          kind: 'point',
          points: [
            [20, -5, 10],
            [30, -5, 5],
          ],
          tone: 'warning',
        },
      ]),
    );
    await frame(page);
    const dots = await countColor(page, warn, 40);
    expect(dots.count).toBeGreaterThan(w0.count + 60);

    await page.evaluate(() => window.__viewport!.viewport.setMarkers('m', null));
    await frame(page);
    expect((await countColor(page, warn, 40)).count).toBeLessThanOrEqual(w0.count);
    expect((await countColor(page, danger, 30)).count).toBeLessThanOrEqual(base.count);
  });

  test('SketchResult.points are drawn and picked as sketchPoint; one-point curves still work', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate(() => {
      const v = window.__viewport!;
      v.viewport.setView('top', false);
      v.showSketchPoints([
        { entity: 'sp1', at: [12, 12, 20] },
        { entity: 'sp2', at: [28, 8, 20] },
      ]);
    });
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const hits = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      const a = v.worldToScreen([12, 12, 20]);
      const b = v.worldToScreen([28, 8, 20]);
      return {
        a: v.pick(a.x + 2, a.y - 1, { kinds: ['sketchPoint'] }),
        b: v.pick(b.x, b.y, { kinds: ['sketchPoint'] }),
        miss: v.pick(a.x + 80, a.y + 80, { kinds: ['sketchPoint'], tolerancePx: 8 }),
        sx: a,
      };
    });
    expect(hits.a[0]?.kind).toBe('sketchPoint');
    expect(hits.a[0]?.entity).toBe('sp1');
    expect(hits.a[0]?.bodyId).toBe('F03');
    expect(hits.b[0]?.entity).toBe('sp2');
    expect(hits.miss).toEqual([]);

    // The dot is actually drawn (dark fully-constrained or blue under-constrained pixel cluster).
    const px = await samplePoints(page, [[hits.sx.x, hits.sx.y]]);
    expect(px[0]![2]).toBeGreaterThan(px[0]![0] + 30); // blue-ish dot centre

    // Legacy path: the fixture's own one-point curve `p1` is still a sketchPoint.
    const legacy = await page.evaluate(() => {
      const v = window.__viewport!;
      v.showSketch(false);
      const vp = v.viewport;
      for (let y = 0; y < 600; y += 6) {
        for (let x = 0; x < 800; x += 6) {
          const h = vp.pick(x, y, { kinds: ['sketchPoint'], tolerancePx: 5 });
          if (h[0]?.entity === 'p1') return true;
        }
      }
      return false;
    });
    expect(legacy).toBe(true);
  });
});
