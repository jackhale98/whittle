import { type CDPSession, expect, type Page, test } from '@playwright/test';
import type { WhittleTestHooks } from '@whittle/contracts';

/**
 * Touch navigation on phone/tablet emulation (PLAN §9.3). Regression for: one-finger drags
 * reaching the canvas but barely rotating the camera, because the render-on-demand loop stopped
 * between pointer moves (camera-controls applies drag deltas only inside update()).
 */

interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

const PHONE = {
  viewport: { width: 390, height: 664 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

test.use(PHONE);

async function ready(page: Page): Promise<void> {
  await page.goto('./');
  // Isolation is known at document start; the app's hooks only exist once its module has run.
  await page.waitForFunction(
    () =>
      window.crossOriginIsolated === true &&
      !!(window as unknown as Partial<{ __whittle: unknown }>).__whittle,
  );
  await page.evaluate(() =>
    (window as unknown as { __whittle: WhittleTestHooks }).__whittle.firstBodyRendered(),
  );
  // First launch shows the (non-modal) welcome card over the view: close it.
  await page.getByRole('button', { name: 'Close welcome' }).click();
}

function camera(page: Page): Promise<CameraState> {
  return page.evaluate(() => {
    const v = (window as unknown as { __whittleViewport: { getCameraState(): CameraState } })
      .__whittleViewport;
    return v.getCameraState();
  });
}

function azimuthDeg(c: CameraState): number {
  const dx = c.position[0] - c.target[0];
  const dy = c.position[1] - c.target[1];
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

async function touchGesture(
  page: Page,
  cdp: CDPSession,
  from: Array<[number, number]>,
  to: Array<[number, number]>,
  steps = 20,
): Promise<void> {
  const at = (k: number) =>
    from.map(([x, y], i) => {
      const [tx, ty] = to[i] ?? [x, y];
      return { x: x + ((tx - x) * k) / steps, y: y + ((ty - y) * k) / steps, id: i + 1 };
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= steps; k++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settled(page); // damping settles
}

/** Waits until the camera stops moving (two equal readings ~3 frames apart), not a fixed time. */
async function settled(page: Page): Promise<void> {
  let last = '';
  for (let i = 0; i < 100; i++) {
    const s = JSON.stringify(await camera(page));
    if (s === last) return;
    last = s;
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
        ),
    );
  }
}

test('one-finger drag over the part orbits the camera substantially', async ({ page }) => {
  test.slow(); // software GL at 3× device pixels on CI
  await ready(page);
  const cdp = await page.context().newCDPSession(page);
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = await camera(page);
  await touchGesture(page, cdp, [[cx - 60, cy]], [[cx + 90, cy]]);
  const after = await camera(page);
  const turned = Math.abs(((azimuthDeg(after) - azimuthDeg(before) + 540) % 360) - 180);
  expect(turned).toBeGreaterThan(45); // 150 px drag on a 664 px tall view ≈ 80°
  expect(after.distance).toBeCloseTo(before.distance, 3); // orbit, not zoom
});

test('two-finger pinch zooms and two-finger drag pans', async ({ page }) => {
  test.slow(); // software GL at 3× device pixels on CI
  await ready(page);
  const cdp = await page.context().newCDPSession(page);
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const before = await camera(page);
  await touchGesture(
    page,
    cdp,
    [
      [cx - 40, cy],
      [cx + 40, cy],
    ],
    [
      [cx - 140, cy],
      [cx + 140, cy],
    ],
  );
  const zoomed = await camera(page);
  expect(zoomed.distance).toBeLessThan(before.distance * 0.8); // spread fingers = zoom in

  await touchGesture(
    page,
    cdp,
    [
      [cx - 40, cy],
      [cx + 40, cy],
    ],
    [
      [cx - 40, cy + 120],
      [cx + 40, cy + 120],
    ],
  );
  const panned = await camera(page);
  const moved = Math.hypot(
    panned.target[0] - zoomed.target[0],
    panned.target[1] - zoomed.target[1],
    panned.target[2] - zoomed.target[2],
  );
  expect(moved).toBeGreaterThan(5); // mm
});
