import { expect, type Page } from '@playwright/test';
import type { HarnessApi } from '../harness/main';

export type Backend = 'webgpu' | 'webgl2';

export async function open(page: Page, query = ''): Promise<Backend> {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__viewport || window.__viewportError, null, {
    timeout: 60_000,
  });
  const error = await page.evaluate(() => window.__viewportError);
  expect(error, `viewport failed to start. console:\n${logs.join('\n')}`).toBeUndefined();
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  return page.evaluate(() => (window.__viewport as HarnessApi).backend);
}

export const frame = (page: Page) => page.evaluate(() => window.__viewport?.viewport.nextFrame());

export const camera = (page: Page) =>
  page.evaluate(() => (window.__viewport as HarnessApi).viewport.getCameraState());

export const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export type RGB = [number, number, number];

/** Canvas pixels at CSS-px points, via a screenshot (valid for WebGL and WebGPU swap chains). */
export async function samplePoints(page: Page, points: Array<[number, number]>): Promise<RGB[]> {
  const png = await page.locator('canvas').screenshot();
  return page.evaluate(
    async ({ data, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      return pts.map(([x, y]) => {
        const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        return [d[0] as number, d[1] as number, d[2] as number] as [number, number, number];
      });
    },
    { data: png.toString('base64'), pts: points },
  );
}

/** Count canvas pixels within `tol` (euclidean RGB) of `rgb`, and their bounding box. */
export async function countColor(
  page: Page,
  rgb: RGB,
  tol: number,
): Promise<{ count: number; bbox: [number, number, number, number] | null }> {
  const png = await page.locator('canvas').screenshot();
  return page.evaluate(
    async ({ data, target, t }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      let x0 = c.width;
      let y0 = c.height;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < px.length; i += 4) {
        const d = Math.hypot(
          (px[i] as number) - target[0],
          (px[i + 1] as number) - target[1],
          (px[i + 2] as number) - target[2],
        );
        if (d <= t) {
          count++;
          const p = i / 4;
          const x = p % c.width;
          const y = Math.floor(p / c.width);
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      return {
        count,
        bbox: count > 0 ? ([x0, y0, x1, y1] as [number, number, number, number]) : null,
      };
    },
    { data: png.toString('base64'), target: rgb, t: tol },
  );
}

type TouchPoint = { x: number; y: number; id: number };

/** CDP touch driver (real touch pointer events through Chromium's input pipeline). */
export async function touchDriver(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('canvas').boundingBox())!;
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: TouchPoint[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p) => ({ x: p.x + box.x, y: p.y + box.y, id: p.id })),
    });
  return {
    box,
    cx: box.width / 2,
    cy: box.height / 2,
    start: (pts: TouchPoint[]) => send('touchStart', pts),
    move: (pts: TouchPoint[]) => send('touchMove', pts),
    /** Lift every finger except `remaining`. */
    end: (remaining: TouchPoint[] = []) => send('touchEnd', remaining),
    async tap(x: number, y: number) {
      await send('touchStart', [{ x, y, id: 1 }]);
      await send('touchEnd', []);
    },
  };
}

/** Collects `onGesture` events in the page (also hands gesture ownership to the "app"). */
export async function collectGestures(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __g: Array<{ kind: string; x: number; y: number; t: number }>;
    };
    w.__g = [];
    window.__viewport?.viewport.onGesture((g) => w.__g.push({ ...g, t: performance.now() }));
  });
  return {
    kinds: () =>
      page.evaluate(() =>
        (window as unknown as { __g: Array<{ kind: string }> }).__g.map((g) => g.kind),
      ),
    all: () =>
      page.evaluate(
        () =>
          (window as unknown as { __g: Array<{ kind: string; x: number; y: number; t: number }> })
            .__g,
      ),
    clear: () =>
      page.evaluate(() => {
        (window as unknown as { __g: unknown[] }).__g = [];
      }),
  };
}

/**
 * Waits until the viewport's one-off idle work is done (studio environment built, first lit frame
 * presented) and the page is running at a steady frame cadence again. On software GL the first
 * frame lit by the new environment stalls the renderer for ~3 s (shader JIT in the GPU process),
 * which would otherwise swallow timers and input in timing-sensitive tests.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__viewport?.viewport.getTouchStats().environmentReady === true,
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  // A screenshot cannot complete before the GPU process has drained its backlog (the JIT stall).
  await page.screenshot({ clip: { x: 0, y: 0, width: 8, height: 8 } });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = performance.now();
        let steady = 0;
        const tick = () => {
          const now = performance.now();
          steady = now - last < 40 ? steady + 1 : 0;
          last = now;
          if (steady >= 8) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}
