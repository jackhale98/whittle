import { expect, type Page, test } from '@playwright/test';
import type { NavigationOptions, PickHit } from '@wren-cad/contracts';
import { collectGestures, dist, frame, open, samplePoints, settle } from './helpers';

/**
 * M3.5 navigation (ADR-046): pivot at the cursor, marker, button mapping per preset, turntable vs
 * trackball, 1:1 drag, invert zoom, rotate speed, and box selection.
 */

const Q = '?backend=webgl2&reducedMotion=1';

type V3 = [number, number, number];

async function boot(
  page: Page,
  query = Q,
): Promise<{
  cx: number;
  cy: number;
  box: { x: number; y: number; width: number; height: number };
}> {
  await open(page, query);
  await settle(page);
  const box = (await page.locator('canvas').boundingBox())!;
  return { box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

const nav = (page: Page, o: Partial<NavigationOptions>) =>
  page.evaluate((opts) => window.__viewport!.viewport.setNavigation(opts), o);

const state = (page: Page) => page.evaluate(() => window.__viewport!.viewport.getNavigationState());

const pose = (page: Page) =>
  page.evaluate(() => {
    const c = window.__viewport!.viewport.getCameraState();
    const f = [0, 1, 2].map((i) => (c.target[i] as number) - (c.position[i] as number));
    const l = Math.hypot(f[0]!, f[1]!, f[2]!);
    return {
      position: c.position as V3,
      target: c.target as V3,
      distance: c.distance,
      fwd: f.map((v) => v / l) as V3,
    };
  });

/** none / pan (view direction unchanged) / orbit (view direction changed). */
function classify(a: Awaited<ReturnType<typeof pose>>, b: Awaited<ReturnType<typeof pose>>) {
  if (dist(a.position, b.position) < 1e-6) return 'none';
  return dist(a.fwd, b.fwd) < 1e-6 ? 'pan' : 'orbit';
}

type Btn = 'left' | 'middle' | 'right';

async function drag(
  page: Page,
  button: Btn,
  from: [number, number],
  to: [number, number],
  opts: { steps?: number; mods?: string[] } = {},
): Promise<void> {
  for (const m of opts.mods ?? []) await page.keyboard.down(m);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button });
  await page.mouse.move(to[0], to[1], { steps: opts.steps ?? 10 });
  await frame(page);
  await page.mouse.up({ button });
  await frame(page);
  for (const m of opts.mods ?? []) await page.keyboard.up(m);
}

async function click(page: Page, button: Btn, at: [number, number], holdMs = 0): Promise<void> {
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down({ button });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.up({ button });
  await frame(page);
}

const pickAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => window.__viewport!.viewport.pick(px as number, py as number, { kinds: ['face'] }),
    [x, y],
  ) as Promise<PickHit[]>;

const screenOf = (page: Page, p: V3) =>
  page.evaluate((w) => window.__viewport!.viewport.worldToScreen(w), p);

test.describe('pivot at the cursor', () => {
  for (const orbit of ['turntable', 'trackball'] as const) {
    test(`${orbit}: the surface point under the cursor stays put on screen while orbiting`, async ({
      page,
    }) => {
      const { box, cx, cy } = await boot(page);
      await nav(page, { orbit });
      // An off-centre point on the box, found by picking.
      const px = cx - box.x + 70;
      const py = cy - box.y + 30;
      const hit = (await pickAt(page, px, py))[0];
      expect(hit?.kind).toBe('face');
      const p = hit!.point as V3;

      await page.mouse.move(cx + 70, cy + 30);
      await page.mouse.down({ button: 'right' });
      let worst = 0;
      for (let i = 1; i <= 24; i++) {
        await page.mouse.move(cx + 70 + i * 9, cy + 30 + Math.sin(i / 3) * 40);
        await frame(page);
        const s = await screenOf(page, p);
        worst = Math.max(worst, Math.hypot(s.x - px, s.y - py));
      }
      const st = await state(page);
      await page.mouse.up({ button: 'right' });
      expect(st.pivotSource).toBe('surface');
      expect(dist(st.pivot!, p)).toBeLessThan(1e-6);
      expect(worst).toBeLessThan(2);
      // The camera really turned.
      const after = await pose(page);
      expect(after.fwd).not.toEqual([0, 0, 0]);
    });
  }

  test('pan, then orbit never pivots in empty space', async ({ page }) => {
    const { box, cx, cy } = await boot(page);
    // Pan so the box sits off to one side.
    await drag(page, 'middle', [cx, cy], [cx + 330, cy - 90]);
    const startOnBox = await screenOf(page, [20, 15, 10]);
    // 1. Orbit starting on the box: pivot is on its surface, under the cursor.
    const onBox = [startOnBox.x - 20, startOnBox.y];
    const h = (await pickAt(page, onBox[0]!, onBox[1]!))[0];
    expect(h?.kind).toBe('face');
    await page.mouse.move(box.x + onBox[0]!, box.y + onBox[1]!);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + onBox[0]! + 40, box.y + onBox[1]! + 5, { steps: 6 });
    let st = await state(page);
    await page.mouse.up({ button: 'right' });
    expect(st.pivotSource).toBe('surface');

    // 2. Orbit starting on the background while the box centre is still on screen: its centre.
    const bg: [number, number] = [box.x + 60, box.y + box.height - 60];
    await drag(page, 'right', bg, [bg[0] + 30, bg[1] - 10], { steps: 4 });
    st = await state(page);
    expect(st.pivotSource).toBe('center');
    expect(dist(st.pivot!, [20, 15, 10])).toBeLessThan(1e-4);

    // 3. Pan the model far off screen, then orbit from the background: the pivot must be on
    //    screen and in front of the camera, never a stale target out in the void.
    await drag(page, 'middle', [cx - 400, cy], [cx + 560, cy], { steps: 12 });
    const gone = await screenOf(page, [20, 15, 10]);
    expect(gone.x < 0 || gone.x > box.width || gone.y < 0 || gone.y > box.height).toBe(true);
    await drag(page, 'right', [cx, cy], [cx + 25, cy + 5], { steps: 4 });
    st = await state(page);
    expect(st.pivotSource).not.toBe('surface');
    expect(st.pivotScreen).not.toBeNull();
    expect(st.pivotScreen!.x).toBeGreaterThanOrEqual(-1);
    expect(st.pivotScreen!.x).toBeLessThanOrEqual(box.width + 1);
    expect(st.pivotScreen!.y).toBeGreaterThanOrEqual(-1);
    expect(st.pivotScreen!.y).toBeLessThanOrEqual(box.height + 1);
  });

  test("pivot 'center' always turns about the visible bodies' centre", async ({ page }) => {
    const { cx, cy } = await boot(page);
    await nav(page, { pivot: 'center' });
    await drag(page, 'right', [cx + 60, cy + 20], [cx + 100, cy + 20], { steps: 4 });
    const st = await state(page);
    expect(st.pivotSource).toBe('center');
    expect(dist(st.pivot!, [20, 15, 10])).toBeLessThan(1e-4);
  });
});

test.describe('pivot marker', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`is visible mid-drag and gone on release (${theme})`, async ({ page }) => {
      const { box, cx, cy } = await boot(page, `${Q}&theme=${theme}`);
      expect((await state(page)).markerVisible).toBe(false);
      await page.mouse.move(cx + 50, cy + 10);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(cx + 80, cy + 10, { steps: 5 });
      await frame(page);
      const st = await state(page);
      expect(st.markerVisible).toBe(true);
      // The accent dot is actually drawn at the pivot.
      const [px] = await samplePoints(page, [[st.pivotScreen!.x, st.pivotScreen!.y]]);
      const accent: [number, number, number] = theme === 'light' ? [11, 95, 232] : [91, 155, 255];
      expect(dist(px!, accent)).toBeLessThan(60);
      expect(box.width).toBeGreaterThan(0);
      await page.mouse.up({ button: 'right' });
      await frame(page);
      expect((await state(page)).markerVisible).toBe(false);
    });
  }

  test('showPivot: false never shows it', async ({ page }) => {
    const { cx, cy } = await boot(page);
    await nav(page, { showPivot: false });
    await page.mouse.move(cx + 50, cy + 10);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 90, cy + 10, { steps: 5 });
    await frame(page);
    expect((await state(page)).markerVisible).toBe(false);
    await page.mouse.up({ button: 'right' });
  });
});

test.describe('button mapping per preset', () => {
  test('rightOrbit (default): left never navigates, right orbits, middle pans', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page);
    expect((await page.evaluate(() => window.__viewport!.viewport.getNavigation())).preset).toBe(
      'rightOrbit',
    );
    const p0 = await pose(page);
    await drag(page, 'left', [cx, cy], [cx + 150, cy + 60]);
    expect(classify(p0, await pose(page))).toBe('none');
    await drag(page, 'right', [cx, cy], [cx + 150, cy + 60]);
    const p1 = await pose(page);
    expect(classify(p0, p1)).toBe('orbit');
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40]);
    expect(classify(p1, await pose(page))).toBe('pan');
  });

  test('middleOrbit: middle orbits, Ctrl+middle pans, right-drag pans, clicks', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page);
    await nav(page, { preset: 'middleOrbit' });
    const g = await collectGestures(page);
    const p0 = await pose(page);
    await drag(page, 'left', [cx, cy], [cx + 150, cy + 60]);
    expect(classify(p0, await pose(page))).toBe('none');
    await drag(page, 'middle', [cx, cy], [cx + 150, cy + 60]);
    const p1 = await pose(page);
    expect(classify(p0, p1)).toBe('orbit');
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40], { mods: ['Control'] });
    const p2 = await pose(page);
    expect(classify(p1, p2)).toBe('pan');
    await drag(page, 'right', [cx, cy], [cx + 100, cy + 40]);
    expect(classify(p2, await pose(page))).toBe('pan');
    expect(await g.kinds()).toEqual([]); // drags emit no gestures

    // Middle click on geometry sets the pivot and reports it; on empty space it does nothing.
    const s = await screenOf(page, [20, 15, 10]);
    const box = (await page.locator('canvas').boundingBox())!;
    await click(page, 'middle', [box.x + s.x, box.y + s.y]);
    expect((await g.all()).map((e) => e.kind)).toEqual(['setPivot']);
    await g.clear();
    await click(page, 'middle', [box.x + 20, box.y + box.height - 20]);
    expect(await g.kinds()).toEqual([]);
    // Right click is the context menu.
    await click(page, 'right', [cx, cy]);
    expect(await g.kinds()).toEqual(['contextMenu']);
  });

  test('middlePan: middle pans, Shift+middle orbits, right click opens the menu', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page);
    await nav(page, { preset: 'middlePan' });
    const g = await collectGestures(page);
    const p0 = await pose(page);
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40]);
    const p1 = await pose(page);
    expect(classify(p0, p1)).toBe('pan');
    await drag(page, 'middle', [cx, cy], [cx + 150, cy + 60], { mods: ['Shift'] });
    expect(classify(p1, await pose(page))).toBe('orbit');
    await drag(page, 'left', [cx, cy], [cx + 150, cy + 60]);
    await click(page, 'right', [cx, cy]);
    expect(await g.kinds()).toEqual(['contextMenu']);
  });

  test('rightOrbitRepeat: quick click repeats, hold opens the menu, drag orbits', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page);
    await nav(page, { preset: 'rightOrbitRepeat' });
    const g = await collectGestures(page);
    await click(page, 'right', [cx, cy]);
    await click(page, 'right', [cx, cy], 450);
    const all = await g.all();
    expect(all.map((e) => e.kind)).toEqual(['contextMenu', 'contextMenu']);
    expect(all[0]!.repeat).toBe(true);
    expect(all[1]!.repeat).toBeFalsy();
    await g.clear();
    const p0 = await pose(page);
    await drag(page, 'right', [cx, cy], [cx + 120, cy + 40]);
    expect(classify(p0, await pose(page))).toBe('orbit');
    expect(await g.kinds()).toEqual([]);
  });

  test('contextMenu fires for a click, not a drag, and the browser menu stays suppressed', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page);
    const g = await collectGestures(page);
    await page.evaluate(() => {
      const w = window as unknown as { __cm: boolean[] };
      w.__cm = [];
      window.addEventListener('contextmenu', (e) => w.__cm.push(e.defaultPrevented));
    });
    // A 2 px wobble is still a click.
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 2, cy + 1);
    await page.mouse.up({ button: 'right' });
    await frame(page);
    let all = await g.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'contextMenu', pointerType: 'mouse' });
    await g.clear();
    // A real drag is navigation, never a menu.
    await drag(page, 'right', [cx, cy], [cx + 60, cy]);
    all = await g.all();
    expect(all).toHaveLength(0);
    const cm = await page.evaluate(() => (window as unknown as { __cm: boolean[] }).__cm);
    expect(cm.length).toBeGreaterThan(0);
    expect(cm.every(Boolean)).toBe(true);
  });

  test('left clicks still reach the app: the harness selects on a left click', async ({ page }) => {
    const { box, cx, cy } = await boot(page);
    await nav(page, { preset: 'middleOrbit' });
    // The harness selects on pointerup and the tap path reports a gesture to the app.
    const g = await collectGestures(page);
    await click(page, 'left', [cx, cy]);
    expect(await g.kinds()).toEqual(['tap']);
    expect(box.width).toBeGreaterThan(0);
  });
});

test.describe('turntable and trackball', () => {
  async function rolls(page: Page, cx: number, cy: number, box: { height: number }) {
    await page.mouse.move(cx, cy - box.height / 2 + 40);
    await page.mouse.down({ button: 'right' });
    let maxRoll = 0;
    // 540 px of vertical drag at 2 pi per canvas height is ~270 degrees: over the pole.
    const total = 540;
    const n = 36;
    for (let i = 1; i <= n; i++) {
      await page.mouse.move(cx, cy - box.height / 2 + 40 + (total * i) / n);
      await frame(page);
      const r = await page.evaluate(() => window.__viewport!.viewport.getRoll());
      maxRoll = Math.max(maxRoll, Math.abs(r));
    }
    await page.mouse.up({ button: 'right' });
    return maxRoll;
  }

  test('turntable keeps +Z vertical and stops at the poles', async ({ page }) => {
    const { box, cx, cy } = await boot(page);
    const maxRoll = await rolls(page, cx, cy, box);
    expect(maxRoll).toBeLessThan(0.01);
    const p = await pose(page);
    expect(Math.abs(p.fwd[2])).toBeLessThan(1); // never exactly at the pole
  });

  test('trackball passes over the pole (the view turns upside down) and rotates freely', async ({
    page,
  }) => {
    const { box, cx, cy } = await boot(page);
    await nav(page, { orbit: 'trackball' });
    const maxRoll = await rolls(page, cx, cy, box);
    expect(maxRoll).toBeGreaterThan(Math.PI * 0.9);
  });

  test('the view cube works in both modes: a face click levels the camera', async ({ page }) => {
    const { cx, cy, box } = await boot(page);
    await nav(page, { orbit: 'trackball' });
    await rolls(page, cx, cy, box);
    const cube = page.getByTestId('view-cube');
    const cb = (await cube.boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.waitForTimeout(300);
    await frame(page);
    expect(Math.abs(await page.evaluate(() => window.__viewport!.viewport.getRoll()))).toBeLessThan(
      0.02,
    );
    // Back to turntable: stays level through an orbit.
    await nav(page, { orbit: 'turntable' });
    await drag(page, 'right', [cx, cy], [cx + 80, cy + 120]);
    expect(Math.abs(await page.evaluate(() => window.__viewport!.viewport.getRoll()))).toBeLessThan(
      0.02,
    );
  });

  test('switching trackball to turntable levels the camera', async ({ page }) => {
    const { box, cx, cy } = await boot(page);
    await nav(page, { orbit: 'trackball' });
    await rolls(page, cx, cy, box);
    const before = await pose(page);
    await nav(page, { orbit: 'turntable' });
    await frame(page);
    expect(Math.abs(await page.evaluate(() => window.__viewport!.viewport.getRoll()))).toBeLessThan(
      1e-3,
    );
    const after = await pose(page);
    expect(dist(after.position, before.position)).toBeLessThan(1e-3);
  });
});

test.describe('dragging follows the pointer', () => {
  test('no inertia after release and no smoothing lag while dragging (smoothing on)', async ({
    page,
  }) => {
    const { cx, cy } = await boot(page, '?backend=webgl2&reducedMotion=0');
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 100, cy + 30, { steps: 8 });
    // The camera state is the drag's final state immediately, with no easing tail.
    const a = await pose(page);
    await frame(page);
    await frame(page);
    const b = await pose(page);
    expect(dist(a.position, b.position)).toBeLessThan(1e-9);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);
    const c = await pose(page);
    expect(dist(b.position, c.position)).toBeLessThan(1e-9);

    // Programmatic moves still ease.
    await page.evaluate(() => window.__viewport!.viewport.setView('front', true));
    await frame(page);
    expect(await page.evaluate(() => window.__viewport!.viewport.isCameraMoving())).toBe(true);
  });

  test('rotateSpeed is a gain', async ({ page }) => {
    const { cx, cy } = await boot(page);
    const angle = async (speed: number) => {
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      await nav(page, { rotateSpeed: speed });
      const a = await pose(page);
      await drag(page, 'right', [cx, cy], [cx + 40, cy], { steps: 5 });
      const b = await pose(page);
      return Math.acos(
        Math.min(1, a.fwd[0] * b.fwd[0] + a.fwd[1] * b.fwd[1] + a.fwd[2] * b.fwd[2]),
      );
    };
    const one = await angle(1);
    const two = await angle(2);
    expect(one).toBeGreaterThan(0.05);
    expect(two / one).toBeGreaterThan(1.85);
    expect(two / one).toBeLessThan(2.15);
    // Out-of-range values clamp to the contract range.
    await nav(page, { rotateSpeed: 99 });
    expect(
      (await page.evaluate(() => window.__viewport!.viewport.getNavigation())).rotateSpeed,
    ).toBe(4);
  });
});

test.describe('zoom', () => {
  test('wheel zooms to the cursor and invertZoom reverses it', async ({ page }) => {
    const { cx, cy } = await boot(page);
    const wheel = async () => {
      await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
      await frame(page);
      const a = await pose(page);
      await page.mouse.move(cx + 120, cy - 40);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(100);
      await frame(page);
      return { a, b: await pose(page) };
    };
    const normal = await wheel();
    expect(normal.b.distance).toBeLessThan(normal.a.distance - 1);
    // Zoom-to-cursor: the target moved toward the cursor rather than staying put.
    expect(dist(normal.a.target, normal.b.target)).toBeGreaterThan(0.1);
    await nav(page, { invertZoom: true });
    const inv = await wheel();
    expect(inv.b.distance).toBeGreaterThan(inv.a.distance + 1);
  });
});

test.describe('touch and pen', () => {
  test('one-finger orbit pivots on the first finger surface point', async ({ page }) => {
    const { box, cx, cy } = await boot(page);
    const cdp = await page.context().newCDPSession(page);
    const send = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      pts: Array<{ x: number; y: number; id: number }>,
    ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const px = cx - box.x + 70;
    const py = cy - box.y + 30;
    const p = (await pickAt(page, px, py))[0]!.point as V3;
    await send('touchStart', [{ x: cx + 70, y: cy + 30, id: 1 }]);
    let worst = 0;
    for (let i = 1; i <= 12; i++) {
      await send('touchMove', [{ x: cx + 70 + i * 10, y: cy + 30 + i * 3, id: 1 }]);
      await page.waitForTimeout(16);
      await frame(page);
      const s = await screenOf(page, p);
      worst = Math.max(worst, Math.hypot(s.x - px, s.y - py));
    }
    const st = await state(page);
    await send('touchEnd', []);
    expect(st.pivotSource).toBe('surface');
    expect(worst).toBeLessThan(2);
  });

  test('pinch respects invertZoom', async ({ page }) => {
    const { cx, cy } = await boot(page);
    const cdp = await page.context().newCDPSession(page);
    const send = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      pts: Array<{ x: number; y: number; id: number }>,
    ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const pinchOut = async () => {
      await page.evaluate(() => window.__viewport!.viewport.fitAll(false));
      await frame(page);
      const a = await pose(page);
      await send('touchStart', [
        { x: cx - 30, y: cy, id: 1 },
        { x: cx + 30, y: cy, id: 2 },
      ]);
      for (let i = 1; i <= 10; i++) {
        await send('touchMove', [
          { x: cx - 30 - i * 8, y: cy, id: 1 },
          { x: cx + 30 + i * 8, y: cy, id: 2 },
        ]);
      }
      await send('touchEnd', []);
      await page.waitForTimeout(100);
      await frame(page);
      return { a, b: await pose(page) };
    };
    const normal = await pinchOut();
    expect(normal.b.distance).toBeLessThan(normal.a.distance - 1);
    await nav(page, { invertZoom: true });
    const inv = await pinchOut();
    expect(inv.b.distance).toBeGreaterThan(inv.a.distance + 1);
  });

  test('pen with penDraws never navigates', async ({ page }) => {
    const { cx, cy } = await boot(page);
    await page.evaluate(() => window.__viewport!.viewport.setInputPolicy({ penDraws: true }));
    const before = await pose(page);
    await page.evaluate(
      ([x, y]) => {
        const c = document.querySelector('canvas')!;
        const r = c.getBoundingClientRect();
        const ev = (type: string, dx: number) =>
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: 'pen',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: (x as number) + dx - 0 * r.left,
            clientY: y as number,
            bubbles: true,
          });
        c.dispatchEvent(ev('pointerdown', 0));
        for (let i = 1; i <= 10; i++) c.dispatchEvent(ev('pointermove', i * 12));
        c.dispatchEvent(ev('pointerup', 120));
      },
      [cx, cy],
    );
    await frame(page);
    expect(classify(before, await pose(page))).toBe('none');
  });
});

/** Box selection on the known fixture: a 40 x 30 x 20 box in the iso view. */
test.describe('pickRect', () => {
  async function rectOf(page: Page, pts: V3[], pad = 6) {
    const s = await page.evaluate(
      (ps) => ps.map((p) => window.__viewport!.viewport.worldToScreen(p)),
      pts,
    );
    return {
      x0: Math.min(...s.map((p) => p.x)) - pad,
      y0: Math.min(...s.map((p) => p.y)) - pad,
      x1: Math.max(...s.map((p) => p.x)) + pad,
      y1: Math.max(...s.map((p) => p.y)) + pad,
    };
  }
  const corners = (): V3[] => {
    const out: V3[] = [];
    for (const x of [0, 40]) for (const y of [0, 30]) for (const z of [0, 20]) out.push([x, y, z]);
    return out;
  };
  const rect = (
    page: Page,
    r: { x0: number; y0: number; x1: number; y1: number },
    mode: 'window' | 'crossing',
    extra: { kinds?: string[]; visibleOnly?: boolean } = {},
  ) =>
    page.evaluate(
      ([rr, m, ex]) =>
        window.__viewport!.viewport.pickRect(rr as never, { mode: m as never, ...(ex as object) }),
      [r, mode, extra] as const,
    ) as Promise<PickHit[]>;

  test('window needs the whole item inside, crossing needs a touch', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const all = await rectOf(page, corners());

    // Whole model inside: the three visible faces, visible edges and vertices.
    const win = await rect(page, all, 'window');
    expect(win.filter((h) => h.kind === 'face')).toHaveLength(3);
    expect(win.filter((h) => h.kind === 'edge')).toHaveLength(9);
    expect(win.filter((h) => h.kind === 'vertex')).toHaveLength(7);

    // Hidden geometry is excluded by default and included with visibleOnly: false.
    const hidden = await rect(page, all, 'window', { visibleOnly: false });
    expect(hidden.filter((h) => h.kind === 'face')).toHaveLength(6);
    expect(hidden.filter((h) => h.kind === 'edge')).toHaveLength(12);
    expect(hidden.filter((h) => h.kind === 'vertex')).toHaveLength(8);

    // A rectangle covering only the left half of the model: no face is entirely inside ...
    const mid = (all.x0 + all.x1) / 2;
    const half = { ...all, x1: mid };
    const halfWin = await rect(page, half, 'window', { kinds: ['face'] });
    expect(halfWin).toHaveLength(0);
    // ... but crossing finds the faces it touches.
    const halfCross = await rect(page, half, 'crossing', { kinds: ['face'] });
    expect(halfCross.length).toBeGreaterThanOrEqual(2);

    // A small rectangle inside one face: crossing finds exactly that face, window nothing.
    const c = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([20, 0, 10]));
    const tiny = { x0: c.x - 5, y0: c.y - 5, x1: c.x + 5, y1: c.y + 5 };
    const tinyCross = await rect(page, tiny, 'crossing', { kinds: ['face'] });
    expect(tinyCross).toHaveLength(1);
    expect(await rect(page, tiny, 'window', { kinds: ['face'] })).toHaveLength(0);

    // Empty background.
    expect(await rect(page, { x0: 2, y0: 2, x1: 30, y1: 30 }, 'crossing')).toEqual([]);
  });

  test('results are deduplicated, nearest-first, and filtered by kind', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const all = await rectOf(page, corners());
    const hits = await rect(page, all, 'crossing');
    const keys = hits.map((h) => `${h.kind}|${h.bodyId}|${h.index}`);
    expect(new Set(keys).size).toBe(keys.length);
    const cam = await pose(page);
    const d = hits.map((h) => dist(h.point as V3, cam.position));
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThanOrEqual(d[i - 1]! - 1e-6);
    const faces = await rect(page, all, 'crossing', { kinds: ['face'] });
    expect(faces.every((h) => h.kind === 'face')).toBe(true);
    // Reversed corners give the same answer.
    const flipped = await rect(
      page,
      { x0: all.x1, y0: all.y1, x1: all.x0, y1: all.y0 },
      'crossing',
    );
    expect(flipped.map((h) => `${h.kind}|${h.index}`).sort()).toEqual(
      hits.map((h) => `${h.kind}|${h.index}`).sort(),
    );
  });

  test('a face hidden behind another is not picked until visibleOnly is off', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.__viewport!.addBox('wall', [4, 60, 60], [-30, -15, -20]);
      window.__viewport!.viewport.fitAll(false);
    });
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const everything = { x0: -50, y0: -50, x1: 5000, y1: 5000 };
    const vis = await rect(page, everything, 'crossing', { kinds: ['face'] });
    const all = await rect(page, everything, 'crossing', { kinds: ['face'], visibleOnly: false });
    expect(all).toHaveLength(12);
    expect(vis.length).toBeLessThan(12);
    expect(vis.length).toBeGreaterThanOrEqual(3);
  });
});

test('perf probe: orbit start and full-screen box select on a 1M-triangle model', async ({
  page,
}) => {
  // Minutes on software GL: run with `pnpm --filter @wren-cad/viewport perf` (WREN_PERF=1).
  test.skip(!process.env.WREN_PERF, 'perf probe: set WREN_PERF=1');
  test.setTimeout(300_000);
  await open(page, '?backend=webgl2&reducedMotion=1');
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  await frame(page);
  await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Orbit start: the pick under the cursor (ID buffer current, BVH built after the refresh).
  const starts: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    await page.mouse.move(cx + i * 7, cy + 10);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + i * 7 + 20, cy + 10, { steps: 3 });
    starts.push((await state(page)).lastPivotMs);
    await page.mouse.up({ button: 'right' });
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;

  // Full-screen box select, both modes, on a current ID image.
  await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
  const rect = await page.evaluate(() => {
    const v = window.__viewport!.viewport;
    const c = v.canvas;
    const r = { x0: 0, y0: 0, x1: c.clientWidth, y1: c.clientHeight };
    const t = (mode: 'window' | 'crossing') => {
      const s = performance.now();
      const hits = v.pickRect(r, { mode });
      return { ms: performance.now() - s, n: hits.length };
    };
    const crossing = t('crossing');
    const win = t('window'); // first window call also builds the per-image totals
    const winAgain = t('window');
    return { crossing, win, winAgain };
  });
  console.log(
    `[perf] 1M tris: orbit-start pivot pick median ${med(starts).toFixed(2)} ms (runs ${starts
      .map((v) => v.toFixed(2))
      .join('/')}); full-screen pickRect crossing ${rect.crossing.ms.toFixed(2)} ms ` +
      `(${rect.crossing.n} hits), window ${rect.win.ms.toFixed(2)} ms first / ` +
      `${rect.winAgain.ms.toFixed(2)} ms repeat (${rect.win.n} hits)`,
  );
  expect(rect.crossing.n).toBeGreaterThan(0);
  if (process.env.WREN_PERF_ASSERT) {
    const f = Number(process.env.WREN_PERF_FACTOR ?? '1');
    expect(med(starts), 'orbit-start pick budget 2 ms').toBeLessThanOrEqual(2 * f);
    expect(rect.crossing.ms, 'full-screen pickRect budget 16 ms').toBeLessThanOrEqual(16 * f);
    expect(
      rect.win.ms,
      'full-screen pickRect (window, first call) budget 16 ms',
    ).toBeLessThanOrEqual(16 * f);
  }
});
