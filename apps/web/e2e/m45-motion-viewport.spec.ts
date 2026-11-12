import { expect, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraState, cameraStill, toPage } from './helpers';

/**
 * M4.5 (3D mice), viewport side: a fake WebHID device (`navigator.hid`, installed before the app
 * loads) sends real report bytes through the real parser and the lazily loaded adapter into the
 * viewport. Orbit about the cursor pivot (same pivot as a mouse orbit at that cursor), pan, zoom
 * toward the surface, no conflict with a mouse drag, wheel de-duplication, turntable keeps +Z up.
 */

test.use({ viewport: { width: 1280, height: 720 } });

type V3 = [number, number, number];

const FAKE_HID = () => {
  type L = (e: { reportId: number; data: DataView }) => void;
  const ls = new Set<L>();
  const dev = {
    vendorId: 0x256f,
    productId: 0xc635,
    productName: 'Test 6-DoF controller',
    opened: false,
    collections: [{ usagePage: 1, usage: 8 }],
    open: () => {
      dev.opened = true;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    addEventListener: (_t: string, l: L) => void ls.add(l),
    removeEventListener: (_t: string, l: L) => void ls.delete(l),
  };
  Object.defineProperty(navigator, 'hid', {
    configurable: true,
    value: {
      getDevices: () => Promise.resolve([dev]),
      requestDevice: () => Promise.resolve([dev]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const send = (reportId: number, bytes: number[]) => {
    const data = new DataView(new Uint8Array(bytes).buffer);
    for (const l of [...ls]) l({ reportId, data });
  };
  const i16 = (v: number) => {
    const n = Math.round(v * 350) & 0xffff;
    return [n & 0xff, n >> 8];
  };
  /** Device frame: x right, y toward the user, z down; rotation tilt forward / right / twist. */
  const combined = (tx: number, ty: number, tz: number, rx: number, ry: number, rz: number) =>
    send(1, [tx, ty, tz, rx, ry, rz].flatMap(i16));
  (window as unknown as Record<string, unknown>).__fake = {
    dev,
    combined,
    hold: (v: number[], ms: number) =>
      new Promise<void>((resolve) => {
        const t0 = performance.now();
        const id = setInterval(() => {
          if (performance.now() - t0 >= ms) {
            clearInterval(id);
            combined(0, 0, 0, 0, 0, 0);
            resolve();
          } else
            combined(
              v[0] as number,
              v[1] as number,
              v[2] as number,
              v[3] as number,
              v[4] as number,
              v[5] as number,
            );
        }, 8);
      }),
  };
};

interface Fake {
  dev: { opened: boolean };
  combined(...v: number[]): void;
  hold(v: number[], ms: number): Promise<void>;
}
type VP = {
  getNavigationState(): {
    pivot: V3 | null;
    pivotSource: string | null;
    markerVisible: boolean;
    dragging: string | null;
    motionActive: boolean;
  };
};
const nav = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __wrenViewport: VP }).__wrenViewport.getNavigationState(),
  );
const hold = (page: Page, v: number[], ms: number) =>
  page.evaluate(
    ([x, d]) => (window as unknown as { __fake: Fake }).__fake.hold(x as number[], d as number),
    [v, ms] as const,
  );
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - (b[i] as number)));

async function setup(page: Page) {
  await page.addInitScript(FAKE_HID);
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  await page.keyboard.press('0'); // isometric
  await cameraStill(page);
  // The adapter loads after the first paint and opens the granted device.
  await page.waitForFunction(
    () => (window as unknown as { __fake: Fake }).__fake.dev.opened,
    null,
    {
      timeout: 20_000,
    },
  );
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  const top = [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2, b.max[2]!] as V3;
  const at = await toPage(page, top);
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { whenPickReady(): Promise<void> } }
    ).__wrenViewport.whenPickReady(),
  );
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(250); // a still pointer (the wheel echo rule looks at recent moves)
  return { top, at };
}

test('orbit about the cursor pivot, like a mouse orbit started at the same cursor', async ({
  page,
}) => {
  const s = await setup(page);
  const c0 = await cameraState(page);
  let marker = false;
  const run = hold(page, [0, 0, 0, 0.3, 0.6, 0], 700);
  for (let i = 0; i < 12; i++) {
    marker ||= (await nav(page)).markerVisible;
    await page.waitForTimeout(40);
  }
  await run;
  await frame(page);
  const st = await nav(page);
  const c1 = await cameraState(page);
  expect(st.pivotSource).toBe('surface');
  expect(marker).toBe(true);
  expect((await nav(page)).markerVisible).toBe(false);
  expect(c1.distance).toBeCloseTo(c0.distance, 5);
  expect(dist(c0.position, c1.position)).toBeGreaterThan(1);
  const sc = await toPage(page, st.pivot as V3);
  expect(Math.hypot(sc.x - s.at.x, sc.y - s.at.y)).toBeLessThan(2);

  // Same cursor, same view: a mouse orbit picks the same surface point.
  await page.keyboard.press('0');
  await cameraStill(page);
  const at = await toPage(page, st.pivot as V3);
  await page.mouse.move(at.x, at.y);
  await hold(page, [0, 0, 0, 0, 0.3, 0], 250);
  const viaDevice = (await nav(page)).pivot as V3;
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(at.x + 25, at.y + 6, { steps: 5 });
  const viaMouse = await nav(page);
  await page.mouse.up({ button: 'right' });
  expect(viaMouse.pivotSource).toBe('surface');
  expect(dist(viaDevice, viaMouse.pivot as V3)).toBeLessThan(1e-3);
});

test('pan moves the model in the view plane', async ({ page }) => {
  const s = await setup(page);
  const before = await toPage(page, s.top);
  const p0 = await cameraState(page);
  await hold(page, [0.5, 0, 0, 0, 0, 0], 400); // push right
  await frame(page);
  const after = await toPage(page, s.top);
  const p1 = await cameraState(page);
  expect(after.x).toBeGreaterThan(before.x + 5);
  expect(p1.distance).toBeCloseTo(p0.distance, 5);
  const f = (c: typeof p0) => c.target.map((t, i) => t - (c.position[i] as number));
  const n = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  expect(dist(n(f(p0)), n(f(p1)))).toBeLessThan(1e-6); // direction unchanged: a pan
});

test('push and pull zoom toward the surface under the cursor', async ({ page }) => {
  const s = await setup(page);
  const d0 = (await cameraState(page)).distance;
  // Device y toward the user is +: push away = zoom in. Long enough for slow software-GL frames
  // (samples are capped at 50 ms each, so a busy main thread only shortens the move).
  await hold(page, [0, -0.5, 0, 0, 0, 0], 2000);
  await frame(page);
  const d1 = (await cameraState(page)).distance;
  expect(d1).toBeLessThan(d0 * 0.9);
  const sc = await toPage(page, s.top);
  expect(Math.hypot(sc.x - s.at.x, sc.y - s.at.y)).toBeLessThan(2);
  await hold(page, [0, 0.5, 0, 0, 0, 0], 2000);
  await frame(page);
  expect((await cameraState(page)).distance).toBeGreaterThan(d1 * 1.1);
});

test('a mouse drag in flight is never fought; the device works again after it', async ({
  page,
}) => {
  const s = await setup(page);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(s.at.x + 40, s.at.y + 10, { steps: 6 });
  await frame(page);
  expect((await nav(page)).dragging).toBe('orbit');
  const held = await cameraState(page);
  await hold(page, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 300);
  expect(dist(held.position, (await cameraState(page)).position)).toBeLessThan(1e-9);
  await page.mouse.move(s.at.x + 80, s.at.y + 20, { steps: 6 });
  await frame(page);
  expect(dist(held.position, (await cameraState(page)).position)).toBeGreaterThan(1e-3);
  await page.mouse.up({ button: 'right' });
  await frame(page);
  const p0 = await cameraState(page);
  await hold(page, [0, 0, 0, 0, 0.6, 0], 300);
  await frame(page);
  expect(dist(p0.position, (await cameraState(page)).position)).toBeGreaterThan(1e-3);
});

test('wheel events that echo the device are dropped; a real wheel still zooms', async ({
  page,
}) => {
  const s = await setup(page);
  const dist0 = async () => (await cameraState(page)).distance;
  // A wheel event right behind a device report, pointer still: the driver's echo. Dispatched in
  // the same task as the report so the 100 ms window does not depend on test-runner latency.
  const wheelAfterReport = () =>
    page.evaluate(
      ([x, y]) => {
        (window as unknown as { __fake: Fake }).__fake.combined(0.1, 0, 0, 0, 0, 0);
        const canvas = document.querySelector('[data-testid="viewport-canvas"]') as HTMLElement;
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -300,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [s.at.x, s.at.y] as const,
    );
  const base = await dist0();
  await wheelAfterReport();
  await page.waitForTimeout(500);
  await hold(page, [0, 0, 0, 0, 0, 0], 1); // ends the session the report started
  await cameraStill(page);
  expect(Math.abs((await dist0()) - base), 'the echo did not zoom').toBeLessThan(1e-3 * base);
  // Quiet for longer than the echo window: a wheel is real again.
  const before = await dist0();
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(600);
  expect(await dist0()).toBeLessThan(before * 0.95);
});

test('turntable keeps +Z up through a long orbit', async ({ page }) => {
  await setup(page);
  await hold(page, [0, 0, 0, 0.7, 0.8, 0.5], 800);
  await frame(page);
  const c = await cameraState(page);
  const a = await toPage(page, c.target as V3);
  const b = await toPage(page, [c.target[0]!, c.target[1]!, c.target[2]! + 5]);
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.5);
  expect(b.y).toBeLessThan(a.y);
});
