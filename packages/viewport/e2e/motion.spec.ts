import { expect, type Page, test } from '@playwright/test';
import { dist, frame, open, settle } from './helpers';
import { PERF_FACTOR } from './perf-budget';

/**
 * 3D mouse motion in the viewport (M4.5, ADR-096): samples injected through `viewport.motion`
 * (the HID layer is covered by unit tests and by the app's E2E) drive orbit about the cursor
 * pivot, pan and zoom toward the surface, never fight a pointer gesture, and the wheel echo of a
 * vendor driver is dropped.
 */

const Q = '?backend=webgl2&reducedMotion=1';
type V3 = [number, number, number];

/** Sends samples at `hz` for `ms` (real time, as a device would), then a zero sample. */
async function drive(page: Page, t: V3, r: V3, ms: number, hz = 125): Promise<void> {
  await page.evaluate(
    ([tt, rr, dur, rate]) =>
      new Promise<void>((resolve) => {
        const v = window.__viewport!.viewport;
        const start = performance.now();
        const id = setInterval(() => {
          const now = performance.now();
          if (now - start >= (dur as number)) {
            clearInterval(id);
            v.motion?.({ t: [0, 0, 0], r: [0, 0, 0], time: now });
            resolve();
            return;
          }
          v.motion?.({ t: tt as V3, r: rr as V3, time: now });
        }, 1000 / (rate as number));
      }),
    [t, r, ms, hz] as const,
  );
  await frame(page);
}

const nav = (page: Page) => page.evaluate(() => window.__viewport!.viewport.getNavigationState());
const toScreen = (page: Page, p: V3) =>
  page.evaluate((q) => window.__viewport!.viewport.worldToScreen(q), p);

/**
 * Screen x offset between two points on the vertical line through the camera target. That line
 * lies in the plane holding the view axis, so it is a vertical screen line exactly when the
 * camera has no roll (perspective cannot lean it).
 */
async function verticalLean(page: Page): Promise<{ dx: number; up: boolean }> {
  const c = await page.evaluate(() => window.__viewport!.viewport.getCameraState());
  const a = await toScreen(page, c.target as V3);
  const b = await toScreen(page, [c.target[0]!, c.target[1]!, c.target[2]! + 5]);
  return { dx: Math.abs(a.x - b.x), up: b.y < a.y };
}

async function pose(page: Page) {
  const c = await page.evaluate(() => window.__viewport!.viewport.getCameraState());
  const f = [0, 1, 2].map((i) => (c.target[i] as number) - (c.position[i] as number));
  const l = Math.hypot(f[0] as number, f[1] as number, f[2] as number);
  return {
    position: c.position as V3,
    fwd: f.map((x) => x / l) as V3,
    distance: c.distance,
  };
}

async function boot(page: Page, query = Q) {
  await open(page, query);
  await settle(page);
  const box = (await page.locator('canvas').boundingBox())!;
  // Cursor on the box's top face (world top-face centre), canvas px.
  const top = await toScreen(page, [20, 15, 20]);
  await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
  return { box, cx: box.x + top.x, cy: box.y + top.y, px: top.x, py: top.y };
}

test.describe('3D mouse motion', () => {
  test('orbit turns about the surface under the cursor, like a mouse orbit at the same cursor', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    const p0 = await pose(page);
    let marker = false;
    const during = (async () => {
      for (let i = 0; i < 20; i++) {
        marker ||= (await nav(page)).markerVisible;
        await page.waitForTimeout(25);
      }
    })();
    await drive(page, [0, 0, 0], [0.3, 0.6, 0], 600);
    await during;
    const st = await nav(page);
    const p1 = await pose(page);
    expect(st.pivotSource).toBe('surface');
    expect(marker, 'pivot marker shown while turning').toBe(true);
    expect(st.markerVisible, 'marker gone after the motion ends').toBe(false);
    expect(st.motionActive).toBe(false);
    expect(dist(p0.fwd, p1.fwd), 'the view direction changed').toBeGreaterThan(0.05);
    expect(p1.distance).toBeCloseTo(p0.distance, 6); // an orbit keeps the distance
    // The pivot point stays under the cursor.
    const sc = await toScreen(page, st.pivot as V3);
    expect(Math.hypot(sc.x - s.px, sc.y - s.py)).toBeLessThan(2);
  });

  test('the pivot matches a mouse orbit begun at the same cursor in the same view', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    await drive(page, [0, 0, 0], [0, 0.4, 0], 300);
    const viaMotion = (await nav(page)).pivot as V3;
    await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
    await frame(page);
    // Cursor at the very same world point: both pivots are the surface point there.
    const sc = await toScreen(page, viaMotion);
    await page.mouse.move(s.box.x + sc.x, s.box.y + sc.y);
    await drive(page, [0, 0, 0], [0, 0.2, 0], 200);
    const again = (await nav(page)).pivot as V3;
    expect(dist(viaMotion, again)).toBeLessThan(1e-3);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(s.box.x + sc.x + 20, s.box.y + sc.y + 8, { steps: 4 });
    const mouse = (await nav(page)).pivot as V3;
    await page.mouse.up({ button: 'right' });
    expect(dist(mouse, again)).toBeLessThan(1e-3);
  });

  test('turntable keeps +Z up: the model vertical stays vertical on screen', async ({ page }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    await page.evaluate(() => window.__viewport!.viewport.setNavigation({ orbit: 'turntable' }));
    // Yaw, pitch and twist all at once.
    await drive(page, [0, 0, 0], [0.7, 0.8, 0.5], 700);
    const lean = await verticalLean(page);
    expect(lean.dx, 'no roll: +Z is still vertical on screen').toBeLessThan(0.5);
    expect(lean.up, '+Z points up the screen').toBe(true);
    const st = await nav(page);
    expect(st.motionFrames).toBeGreaterThan(0);
  });

  test('trackball: twist rolls the view', async ({ page }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    await page.evaluate(() => window.__viewport!.viewport.setNavigation({ orbit: 'trackball' }));
    await drive(page, [0, 0, 0], [0, 0, 0.8], 600);
    expect((await verticalLean(page)).dx, 'rolled: +Z leans').toBeGreaterThan(1);
  });

  test('pan moves the model with the cap in the view plane, at about one view width per second', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    const before = await toScreen(page, [20, 15, 20]);
    const p0 = await pose(page);
    await drive(page, [0.5, 0, 0], [0, 0, 0], 400);
    const after = await toScreen(page, [20, 15, 20]);
    const p1 = await pose(page);
    expect(dist(p0.fwd, p1.fwd), 'pan keeps the view direction').toBeLessThan(1e-9);
    expect(p1.distance).toBeCloseTo(p0.distance, 6);
    expect(after.x, 'push right moves the model right').toBeGreaterThan(before.x + 5);
    expect(Math.abs(after.y - before.y)).toBeLessThan(Math.abs(after.x - before.x) * 0.5);
    // 0.5 of full deflection for 0.4 s = 0.2 view widths at the pivot's depth (dt-capped, so a
    // late timer may only shorten it).
    const width = s.box.width;
    const moved = after.x - before.x;
    expect(moved).toBeGreaterThan(0.05 * width);
    expect(moved).toBeLessThan(0.26 * width);

    const y0 = await toScreen(page, [20, 15, 20]);
    await drive(page, [0, 0.5, 0], [0, 0, 0], 300);
    const y1 = await toScreen(page, [20, 15, 20]);
    expect(y1.y, 'pull up moves the model up the screen').toBeLessThan(y0.y - 5);
  });

  test('push/pull zooms toward the surface under the cursor and keeps it there', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    const surfaceAt = () =>
      page.evaluate(
        ([x, y]) => {
          const v = window.__viewport!.viewport;
          const h = v.pick(x as number, y as number, { kinds: ['face'] })[0];
          const c = v.getCameraState().position;
          return h
            ? { p: h.point as V3, d: Math.hypot(h.point[0] - c[0]!, h.point[1] - c[1]!, h.point[2] - c[2]!) }
            : null;
        },
        [s.px, s.py],
      );
    const before = await surfaceAt();
    expect(before).not.toBeNull();
    await drive(page, [0, 0, -0.5], [0, 0, 0], 400); // push away = zoom in
    const sc = await toScreen(page, before!.p);
    const mid = await surfaceAt();
    expect((mid?.d as number) < (before?.d as number) * 0.9, 'closer to the surface').toBe(true);
    expect(Math.hypot(sc.x - s.px, sc.y - s.py), 'the surface point stays under the cursor').toBeLessThan(2);
    await drive(page, [0, 0, 0.5], [0, 0, 0], 400); // pull = zoom out
    const out = await surfaceAt();
    expect((out?.d as number) > (mid?.d as number) * 1.1).toBe(true);
  });

  test('motion is ignored while a mouse drag is in flight, and the drag stays 1:1', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(s.cx + 40, s.cy + 10, { steps: 6 });
    await frame(page);
    expect((await nav(page)).dragging).toBe('orbit');
    const held = await pose(page);
    await drive(page, [0.9, 0.9, 0.9], [0.9, 0.9, 0.9], 400); // would move everything
    const still = await pose(page);
    expect(dist(held.position, still.position), 'the device did not move the camera').toBeLessThan(
      1e-9,
    );
    expect((await nav(page)).dragging, 'the drag is still going').toBe('orbit');
    await page.mouse.move(s.cx + 80, s.cy + 20, { steps: 6 });
    await frame(page);
    const after = await pose(page);
    expect(dist(held.position, after.position), 'the mouse still orbits').toBeGreaterThan(1e-3);
    await page.mouse.up({ button: 'right' });
    await frame(page);
    // Once the pointer is up the device works again.
    const p0 = await pose(page);
    await drive(page, [0, 0, 0], [0, 0.6, 0], 300);
    expect(dist(p0.position, (await pose(page)).position)).toBeGreaterThan(1e-3);
  });

  test('a held left button (an app drag) also blocks the device, and a press ends a session', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    // Start motion, press in the middle of it: the session ends and the camera stops.
    const running = drive(page, [0.5, 0, 0], [0, 0, 0], 800);
    await page.waitForTimeout(250);
    await page.mouse.down({ button: 'left' });
    const atPress = await pose(page);
    await running;
    const atEnd = await pose(page);
    expect(dist(atPress.position, atEnd.position), 'no movement while the button is down').toBeLessThan(
      0.5,
    ); // allow the last frame in flight
    await page.mouse.up({ button: 'left' });
    expect((await nav(page)).motionActive).toBe(false);
  });

  test('wheel events echoing 3D mouse motion are dropped; a real wheel still zooms', async ({
    page,
  }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    const wheelDelta = async () => {
      const a = (await pose(page)).distance;
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(300);
      return a - (await pose(page)).distance;
    };
    // Baseline: the wheel zooms in.
    expect(await wheelDelta()).toBeGreaterThan(0.5);
    await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
    await frame(page);
    // A motion sample (a pan: no zoom of its own), then a wheel within the echo window and no
    // pointer movement: the driver's echo, changes nothing.
    await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
    await frame(page);
    const base = (await pose(page)).distance;
    await page.evaluate(() => {
      window.__viewport!.viewport.motion?.({ t: [0.1, 0, 0], r: [0, 0, 0], time: performance.now() });
    });
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    expect((await pose(page)).distance, 'the echo did not zoom').toBeCloseTo(base, 6);
    // Quiet for longer than the echo window, then a wheel is real again.
    await page.evaluate(() =>
      window.__viewport!.viewport.motion?.({ t: [0, 0, 0], r: [0, 0, 0], time: performance.now() }),
    );
    await page.waitForTimeout(250);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    expect((await pose(page)).distance).toBeLessThan(base - 0.5);
  });

  test('works with motion preferences either way (nothing here animates)', async ({ page }) => {
    const s = await boot(page, '?backend=webgl2&reducedMotion=0');
    await page.mouse.move(s.cx, s.cy);
    const p0 = await pose(page);
    await drive(page, [0, 0, 0], [0, 0.6, 0.2], 400);
    const p1 = await pose(page);
    expect(dist(p0.fwd, p1.fwd)).toBeGreaterThan(0.03);
    expect((await nav(page)).motionActive).toBe(false);
  });

  test('dt is capped: a long gap between samples does not jump the camera', async ({ page }) => {
    const s = await boot(page);
    await page.mouse.move(s.cx, s.cy);
    const p0 = await pose(page);
    await page.evaluate(async () => {
      const v = window.__viewport!.viewport;
      v.motion?.({ t: [1, 0, 0], r: [0, 0, 0], time: performance.now() });
      await new Promise((r) => setTimeout(r, 120));
      v.motion?.({ t: [1, 0, 0], r: [0, 0, 0], time: performance.now() }); // 120 ms later: capped to 50 ms
      v.motion?.({ t: [0, 0, 0], r: [0, 0, 0], time: performance.now() });
    });
    await frame(page);
    const p1 = await pose(page);
    // 1.0 x 0.05 s = 0.05 view widths at most, not 0.12.
    const moved = dist(p0.position, p1.position);
    const widthWorld = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      const a = v.worldToScreen([0, 0, 20]);
      const b = v.worldToScreen([40, 0, 20]);
      return Math.hypot(b.x - a.x, b.y - a.y);
    });
    expect(moved).toBeGreaterThan(0);
    expect(widthWorld).toBeGreaterThan(0);
    const viewWidthWorld = (s.box.width / widthWorld) * 40;
    expect(moved).toBeLessThanOrEqual(0.06 * viewWidthWorld);
  });
});

test('perf probe: 3D mouse motion holds the frame budget (125 Hz samples, 60 fps)', async ({
  page,
}) => {
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1');
  test.setTimeout(240_000);
  await open(page, Q);
  await settle(page);
  const box = (await page.locator('canvas').boundingBox())!;
  const top = await toScreen(page, [20, 15, 20]);
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await page.evaluate(() => window.__viewport!.viewport.whenPickReady());

  const run = (ms: number) =>
    page.evaluate(
      (dur) =>
        new Promise<{ frames: number[]; callMs: number[]; renders: number }>((resolve) => {
          const v = window.__viewport!.viewport;
          const frames: number[] = [];
          const callMs: number[] = [];
          let last = performance.now();
          let alive = true;
          const raf = () => {
            const now = performance.now();
            frames.push(now - last);
            last = now;
            if (alive) requestAnimationFrame(raf);
          };
          requestAnimationFrame(raf);
          const r0 = v.getRenderCount();
          const start = performance.now();
          let k = 0;
          const id = setInterval(() => {
            const now = performance.now();
            if (now - start >= dur) {
              clearInterval(id);
              alive = false;
              v.motion?.({ t: [0, 0, 0], r: [0, 0, 0], time: now });
              resolve({ frames, callMs, renders: v.getRenderCount() - r0 });
              return;
            }
            k++;
            // A sustained turn about the vertical plus a wobble on all other axes, like a hand on
            // the cap (the wobble is fast, so the view stays near its start instead of reaching
            // the pole, where the ground fills the screen and software GL slows to a crawl).
            const a = k / 10;
            const t0 = performance.now();
            v.motion?.({
              t: [Math.sin(a) * 0.5, Math.cos(a) * 0.3, Math.sin(a / 2) * 0.2],
              r: [Math.sin(a / 3) * 0.4, 0.3 + Math.cos(a / 2) * 0.2, Math.sin(a) * 0.3],
              time: now,
            });
            callMs.push(performance.now() - t0);
          }, 8);
        }),
      ms,
    );

  const stat = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return {
      mean: a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1),
      p50: s[Math.floor(s.length * 0.5)] ?? 0,
      p95: s[Math.floor(s.length * 0.95)] ?? 0,
      max: s.at(-1) ?? 0,
      fast: a.filter((x) => x <= 20).length / Math.max(a.length, 1),
    };
  };
  const fmt = (x: ReturnType<typeof stat>) =>
    `median ${x.p50.toFixed(1)} ms, mean ${x.mean.toFixed(1)}, p95 ${x.p95.toFixed(0)}, max ${x.max.toFixed(0)}, ${(x.fast * 100).toFixed(0)}% of frames <= 20 ms`;

  // The same box scene under a mouse orbit is the baseline: on CPU-only software GL both show
  // the same rasteriser stalls, so the comparison (not the absolute stall) is what motion owns.
  const motion = await run(3000);
  const nav0 = await nav(page);
  const f = stat(motion.frames.slice(2));
  const c = stat(motion.callMs);
  const applyMean = nav0.motionApplyMs / Math.max(nav0.motionFrames, 1);

  await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
  await page.evaluate(() => window.__viewport!.viewport.nextFrame());
  await page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __alive: boolean };
    w.__f = [];
    w.__alive = true;
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      w.__f.push(n - last);
      last = n;
      if (w.__alive) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const mx = box.x + top.x;
  const my = box.y + top.y;
  await page.mouse.move(mx, my);
  await page.mouse.down({ button: 'right' });
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 3000; i++) {
    await page.mouse.move(mx + i * 2, my + Math.sin(i / 5) * 12);
    await page.waitForTimeout(8);
  }
  await page.mouse.up({ button: 'right' });
  const mouseFrames = await page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __alive: boolean };
    w.__alive = false;
    return w.__f;
  });
  const m = stat(mouseFrames.slice(2));

  console.log(`[perf] motion 125 Hz, box, frame interval: ${fmt(f)}`);
  console.log(`[perf] mouse orbit,   box, frame interval: ${fmt(m)}`);
  console.log(
    `[perf] motion() call mean ${c.mean.toFixed(3)} ms p95 ${c.p95.toFixed(3)} ms; ` +
      `camera write mean ${applyMean.toFixed(3)} ms over ${nav0.motionFrames} frames; renders ${motion.renders}`,
  );
  // Real-time cost per report and per frame: far below the 16.7 ms frame budget.
  expect(c.p95).toBeLessThan(1 * PERF_FACTOR);
  expect(applyMean).toBeLessThan(1 * PERF_FACTOR);

  // 1M triangles: the render itself dominates; motion must not add to it.
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  const big = await run(3000);
  const stats = await page.evaluate(() => window.__viewport!.viewport.stats());
  const fb = stat(big.frames.slice(2));
  console.log(
    `[perf] motion 125 Hz, 1M triangles, frame interval: ${fmt(fb)}; render CPU ${stats.frameMs.toFixed(2)} ms ` +
      '(budget <= 8 ms desktop; advisory on CPU-only SwiftShader)',
  );
  if (process.env.WREN_PERF_ASSERT) {
    // 60 fps (x PERF_FACTOR on software GL), and never worse than the mouse orbit it replaces.
    expect(f.p50, 'box: median frame interval').toBeLessThanOrEqual(16.7 * PERF_FACTOR);
    expect(f.mean, 'motion is no worse than a mouse orbit').toBeLessThanOrEqual(m.mean * 1.25 + 10);
    expect(stats.frameMs).toBeLessThanOrEqual(8 * PERF_FACTOR);
  }
});
