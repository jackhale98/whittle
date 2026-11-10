import { expect, test } from '@playwright/test';
import {
  camera,
  collectGestures,
  dist,
  frame,
  open as openRaw,
  settle,
  touchDriver,
} from './helpers';

/** Opens the harness and waits out the one-off idle work (timing-sensitive input tests). */
async function open(page: import('@playwright/test').Page, query = ''): Promise<void> {
  await openRaw(page, query);
  await settle(page);
}

const Q = '?backend=webgl2&reducedMotion=1';

test.describe('touch gestures (CDP touch)', () => {
  test('tap, doubleTap and the camera staying put', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    const before = await camera(page);

    await t.tap(t.cx, t.cy);
    await page.waitForTimeout(450); // let the double-tap window lapse
    await t.tap(t.cx + 100, t.cy - 50);
    await page.waitForTimeout(450);
    expect(await g.kinds()).toEqual(['tap', 'tap']);

    await g.clear();
    await t.tap(t.cx, t.cy);
    await t.tap(t.cx + 3, t.cy + 2);
    await page.waitForTimeout(50);
    expect(await g.kinds()).toEqual(['tap', 'doubleTap']);

    const after = await camera(page);
    expect(dist(after.position, before.position)).toBeLessThan(0.5);
    // The viewport never fits on its own once an app listens (the app maps doubleTap).
    expect(dist(after.target, before.target)).toBeLessThan(1e-3);
  });

  test('without an app listener a double tap still fits the view (M1 behaviour)', async ({
    page,
  }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    await page.evaluate(() => window.__viewport!.viewport.zoomTo([5, 5, 5], 4, false));
    await frame(page);
    expect(dist((await camera(page)).target, [5, 5, 5])).toBeLessThan(1e-3);
    await t.tap(t.cx, t.cy);
    await t.tap(t.cx, t.cy);
    await page.waitForTimeout(100);
    await frame(page);
    expect(dist((await camera(page)).target, [20, 15, 10])).toBeLessThan(0.5);
  });

  test('a drag never ends in a tap, and orbits', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    const before = await camera(page);
    await t.start([{ x: t.cx, y: t.cy, id: 1 }]);
    for (let i = 1; i <= 10; i++) {
      await t.move([{ x: t.cx + i * 10, y: t.cy + i * 3, id: 1 }]);
      await page.waitForTimeout(16);
    }
    await t.end();
    await page.waitForTimeout(100);
    expect(await g.kinds()).toEqual([]);
    expect(dist((await camera(page)).position, before.position)).toBeGreaterThan(5);
  });

  test('long-press fires once at >= 500 ms and does not also orbit', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    const before = await camera(page);
    await page.evaluate(() => {
      const w = window as unknown as { __down: number };
      window.addEventListener('pointerdown', () => {
        w.__down = performance.now();
      });
    });
    await t.start([{ x: t.cx, y: t.cy, id: 1 }]);
    // Wait for it (CDP delivery latency varies under load), then measure in the page's own clock.
    await page.waitForFunction(
      () => (window as unknown as { __g: unknown[] }).__g.length > 0,
      null,
      {
        timeout: 5000,
      },
    );
    await page.waitForTimeout(150);
    expect(await g.kinds()).toEqual(['longPress']);
    const fired = (await g.all())[0]!;
    const down = await page.evaluate(() => (window as unknown as { __down: number }).__down);
    // The 500 ms is counted from the event's creation time, a few ms before the page handler ran.
    expect(fired.t - down).toBeGreaterThanOrEqual(470);
    expect(fired.t - down).toBeLessThan(2000);
    expect(Math.abs(fired.x - t.cx)).toBeLessThan(2);
    // The finger now slides: this must not move the camera.
    for (let i = 1; i <= 10; i++) {
      await t.move([{ x: t.cx + i * 15, y: t.cy + i * 5, id: 1 }]);
      await page.waitForTimeout(16);
    }
    await t.end();
    await page.waitForTimeout(100);
    await frame(page);
    expect(await g.kinds()).toEqual(['longPress']); // lifting does not tap
    expect(dist((await camera(page)).position, before.position)).toBeLessThan(0.5);
  });

  test('a press that moves > 8 px before 500 ms is a drag, not a long-press', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    await t.start([{ x: t.cx, y: t.cy, id: 1 }]);
    await page.waitForTimeout(200);
    await t.move([{ x: t.cx + 14, y: t.cy, id: 1 }]);
    await page.waitForTimeout(500);
    await t.end();
    expect(await g.kinds()).toEqual([]);
  });

  test('two-finger tap and three-finger tap', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    const before = await camera(page);
    const two = [
      { x: t.cx - 40, y: t.cy, id: 1 },
      { x: t.cx + 40, y: t.cy, id: 2 },
    ];
    await t.start(two);
    await page.waitForTimeout(60);
    await t.end();
    await page.waitForTimeout(400);
    const three = [
      { x: t.cx - 60, y: t.cy, id: 1 },
      { x: t.cx, y: t.cy + 30, id: 2 },
      { x: t.cx + 60, y: t.cy, id: 3 },
    ];
    await t.start(three);
    await page.waitForTimeout(60);
    await t.end();
    await page.waitForTimeout(100);
    expect(await g.kinds()).toEqual(['twoFingerTap', 'threeFingerTap']);
    expect(dist((await camera(page)).position, before.position)).toBeLessThan(0.5);
  });

  test('two-finger pinch/pan are not taps', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    await t.start([
      { x: t.cx - 30, y: t.cy, id: 1 },
      { x: t.cx + 30, y: t.cy, id: 2 },
    ]);
    for (let i = 1; i <= 8; i++) {
      await t.move([
        { x: t.cx - 30 - i * 6, y: t.cy, id: 1 },
        { x: t.cx + 30 + i * 6, y: t.cy, id: 2 },
      ]);
    }
    await t.end();
    expect(await g.kinds()).toEqual([]);
  });
});

test.describe('twist-roll', () => {
  test('a two-finger twist rolls the view about its axis, in the direction of the fingers', async ({
    page,
  }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    await page.evaluate(() => window.__viewport!.viewport.setView('front', false));
    await frame(page);
    const proj = (p: [number, number, number]) =>
      page.evaluate((q) => window.__viewport!.viewport.worldToScreen(q), p);
    const angleOf = async () => {
      const c = await proj([20, 15, 10]);
      const p = await proj([40, 15, 10]); // a point to the right of the target
      return Math.atan2(p.y - c.y, p.x - c.x);
    };
    const a0 = await angleOf();
    const r0 = await page.evaluate(() => window.__viewport!.viewport.getRoll());
    expect(Math.abs(r0)).toBeLessThan(1e-6);

    const deg = Math.PI / 180;
    const target = 50 * deg; // fingers turn clockwise on screen by 50 degrees
    await t.start([
      { x: t.cx - 70, y: t.cy, id: 1 },
      { x: t.cx + 70, y: t.cy, id: 2 },
    ]);
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const a = (target * i) / steps;
      await t.move([
        { x: t.cx - 70 * Math.cos(a), y: t.cy - 70 * Math.sin(a), id: 1 },
        { x: t.cx + 70 * Math.cos(a), y: t.cy + 70 * Math.sin(a), id: 2 },
      ]);
      await page.waitForTimeout(16);
    }
    await t.end();
    await page.waitForTimeout(100);
    await frame(page);

    let turned = (await angleOf()) - a0;
    if (turned > Math.PI) turned -= 2 * Math.PI;
    if (turned < -Math.PI) turned += 2 * Math.PI;
    // Content follows the fingers (clockwise), minus the 5 degree start threshold.
    expect(turned / deg).toBeGreaterThan(35);
    expect(turned / deg).toBeLessThan(52);
    const roll = await page.evaluate(() => window.__viewport!.viewport.getRoll());
    expect(Math.abs(roll) / deg).toBeGreaterThan(35);
    // target stays put (pure roll plus a tiny pan/zoom jitter)
    expect(dist((await camera(page)).target, [20, 15, 10])).toBeLessThan(2);

    // A standard view levels the camera again.
    await page.evaluate(() => window.__viewport!.viewport.setView('front', true));
    await frame(page);
    expect(Math.abs(await page.evaluate(() => window.__viewport!.viewport.getRoll()))).toBeLessThan(
      1e-4,
    );
  });

  test('a pure pinch does not roll', async ({ page }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    await t.start([
      { x: t.cx - 30, y: t.cy, id: 1 },
      { x: t.cx + 30, y: t.cy, id: 2 },
    ]);
    for (let i = 1; i <= 10; i++) {
      await t.move([
        { x: t.cx - 30 - i * 6, y: t.cy + (i % 2), id: 1 },
        { x: t.cx + 30 + i * 6, y: t.cy - (i % 2), id: 2 },
      ]);
    }
    await t.end();
    await frame(page);
    expect(Math.abs(await page.evaluate(() => window.__viewport!.viewport.getRoll()))).toBeLessThan(
      0.02,
    );
  });
});

test.describe('input policy and palm rejection', () => {
  /** CDP mouse events with pointerType 'pen' produce real pen pointer events. */
  async function penDrag(
    page: import('@playwright/test').Page,
    from: [number, number],
    to: [number, number],
  ) {
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.locator('canvas').boundingBox())!;
    const send = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x: box.x + x,
        y: box.y + y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'pen',
      });
    await send('mousePressed', ...from);
    for (let i = 1; i <= 10; i++) {
      await send(
        'mouseMoved',
        from[0] + ((to[0] - from[0]) * i) / 10,
        from[1] + ((to[1] - from[1]) * i) / 10,
      );
    }
    await send('mouseReleased', ...to);
  }

  test('with penDraws the pen never moves the camera and the app still receives it', async ({
    page,
  }) => {
    await open(page, Q);
    await page.evaluate(() => {
      const w = window as unknown as { __pen: string[] };
      w.__pen = [];
      const c = document.querySelector('canvas')!;
      for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
        c.addEventListener(type, (e) => {
          if (e.pointerType === 'pen') w.__pen.push(type);
        });
      }
      window.__viewport!.viewport.setInputPolicy({ penDraws: true });
    });
    const before = await camera(page);
    await penDrag(page, [300, 300], [480, 380]);
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeLessThan(1e-3);
    const events = await page.evaluate(() => (window as unknown as { __pen: string[] }).__pen);
    expect(events).toContain('pointerdown');
    expect(events).toContain('pointermove');
    expect(events).toContain('pointerup');

    // Without the policy a pen orbits like a mouse.
    await page.evaluate(() => window.__viewport!.viewport.setInputPolicy({ penDraws: false }));
    await penDrag(page, [300, 300], [480, 380]);
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeGreaterThan(3);
  });

  test('fingers still navigate while a pen policy is active', async ({ page }) => {
    await open(page, Q);
    await page.evaluate(() => window.__viewport!.viewport.setInputPolicy({ penDraws: true }));
    const t = await touchDriver(page);
    const before = await camera(page);
    await t.start([{ x: t.cx, y: t.cy, id: 1 }]);
    for (let i = 1; i <= 10; i++) {
      await t.move([{ x: t.cx + i * 12, y: t.cy, id: 1 }]);
      await page.waitForTimeout(16);
    }
    await t.end();
    await frame(page);
    expect(dist((await camera(page)).position, before.position)).toBeGreaterThan(5);
  });

  test('touch taps are suppressed during and for palmRejectMs after pen contact', async ({
    page,
  }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    const g = await collectGestures(page);
    await page.evaluate(() =>
      window.__viewport!.viewport.setInputPolicy({ penDraws: true, palmRejectMs: 500 }),
    );
    await penDrag(page, [300, 300], [400, 330]);
    await t.tap(t.cx, t.cy + 100); // palm lands right after the stroke
    await page.waitForTimeout(100);
    expect(await g.kinds()).toEqual([]);
    await page.waitForTimeout(700);
    await t.tap(t.cx, t.cy + 100);
    await page.waitForTimeout(50);
    expect(await g.kinds()).toEqual(['tap']);

    // Long-press is suppressed for a palm that rests while the pen draws.
    await g.clear();
    await page.evaluate(() =>
      window.__viewport!.viewport.setInputPolicy({ penDraws: true, palmRejectMs: 800 }),
    );
    await penDrag(page, [300, 300], [400, 330]);
    await t.start([{ x: t.cx, y: t.cy + 100, id: 1 }]);
    await page.waitForTimeout(600);
    await t.end();
    expect(await g.kinds()).toEqual([]);
  });
});

test.describe('camera events and zoomTo', () => {
  test('onCamera is throttled to one call per frame and ends with moving=false', async ({
    page,
  }) => {
    await open(page, Q);
    const t = await touchDriver(page);
    await page.evaluate(() => {
      const w = window as unknown as { __cam: Array<{ moving: boolean }>; __r0: number };
      w.__cam = [];
      w.__r0 = window.__viewport!.viewport.getRenderCount();
      window.__viewport!.viewport.onCamera((c) => w.__cam.push({ moving: c.moving }));
    });
    await t.start([{ x: t.cx, y: t.cy, id: 1 }]);
    for (let i = 1; i <= 30; i++) {
      // several moves per frame: events must still be one per frame
      await t.move([{ x: t.cx + i * 4, y: t.cy + i, id: 1 }]);
      await t.move([{ x: t.cx + i * 4 + 1, y: t.cy + i, id: 1 }]);
    }
    await t.end();
    // Damping settles over a few frames; on a loaded CI runner that can take longer than a fixed
    // wait, so wait for the camera to report it stopped, then check the event stream.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = window as unknown as { __cam: Array<{ moving: boolean }> };
            return (
              !window.__viewport!.viewport.isCameraMoving() &&
              w.__cam[w.__cam.length - 1]?.moving === false
            );
          }),
        { timeout: 5_000 },
      )
      .toBe(true);
    const { cam, renders } = await page.evaluate(() => {
      const w = window as unknown as { __cam: Array<{ moving: boolean }>; __r0: number };
      return { cam: w.__cam, renders: window.__viewport!.viewport.getRenderCount() - w.__r0 };
    });
    expect(cam.length).toBeGreaterThan(3);
    expect(cam.length).toBeLessThanOrEqual(renders + 1);
    expect(cam.some((c) => c.moving)).toBe(true);
    expect(cam[cam.length - 1]!.moving).toBe(false);
    expect(await page.evaluate(() => window.__viewport!.viewport.isCameraMoving())).toBe(false);
  });

  test('zoomTo centres the point and frames the radius', async ({ page }) => {
    await open(page, Q);
    await page.evaluate(() => window.__viewport!.viewport.zoomTo([10, 5, 3], 6, false));
    await frame(page);
    const cam = await camera(page);
    expect(dist(cam.target, [10, 5, 3])).toBeLessThan(1e-3);
    // radius 6 fills about half the view -> the visible half-height is about 2 * 6 at the target
    const half = cam.distance * Math.tan((35 * Math.PI) / 360);
    expect(half).toBeGreaterThan(9);
    expect(half).toBeLessThan(15);
    const s = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([10, 5, 3]));
    const box = (await page.locator('canvas').boundingBox())!;
    expect(Math.abs(s.x - box.width / 2)).toBeLessThan(1);
    expect(Math.abs(s.y - box.height / 2)).toBeLessThan(1);
  });

  test('prefers-reduced-motion removes camera animation (no option given)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '?backend=webgl2');
    await page.evaluate(() => window.__viewport!.viewport.setView('top', true));
    // reduced motion: the camera is at its destination immediately, with nothing to tween
    const cam = await camera(page);
    expect(Math.abs(cam.position[0] - cam.target[0])).toBeLessThan(0.5);
    expect(cam.position[2]).toBeGreaterThan(cam.target[2] + 10);
    await frame(page);
    await frame(page);
    expect(await page.evaluate(() => window.__viewport!.viewport.isCameraMoving())).toBe(false);

    // And the opposite: with no preference, the same call animates.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__viewport!.viewport.setView('front', true));
    expect(await page.evaluate(() => window.__viewport!.viewport.isCameraMoving())).toBe(true);
    await frame(page);
    // Still tweening a frame later (the 180 ms animation spans several frames).
    expect(await page.evaluate(() => window.__viewport!.viewport.isCameraMoving())).toBe(true);
  });
});
