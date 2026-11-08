import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import type { HarnessApi } from '../harness/main';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, '__screenshots__');

type Backend = 'webgpu' | 'webgl2';

async function open(page: Page, query = ''): Promise<Backend> {
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

/** Read the canvas pixels via a screenshot (works for both WebGL and WebGPU swap chains). */
async function pixels(page: Page) {
  const png = await page.locator('canvas').screenshot();
  return png;
}

async function sample(page: Page): Promise<{
  centre: [number, number, number];
  corner: [number, number, number];
  darkPixels: number;
  distinct: number;
}> {
  const png = await pixels(page);
  const b64 = png.toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const at = (x: number, y: number): [number, number, number] => {
      const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return [d[0] as number, d[1] as number, d[2] as number];
    };
    const all = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    const seen = new Set<number>();
    for (let i = 0; i < all.length; i += 4) {
      const lum =
        (all[i] as number) * 0.3 + (all[i + 1] as number) * 0.59 + (all[i + 2] as number) * 0.11;
      if (lum < 90) dark++;
      seen.add(((all[i] as number) << 16) | ((all[i + 1] as number) << 8) | (all[i + 2] as number));
    }
    return {
      centre: at(c.width / 2, c.height / 2),
      corner: at(4, 4),
      darkPixels: dark,
      distinct: seen.size,
    };
  }, b64);
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

for (const requested of ['webgl2', 'auto'] as const) {
  test.describe(`render (${requested})`, () => {
    test('box is drawn: shaded faces and edge pixels, not a blank canvas', async ({ page }) => {
      const backend = await open(page, requested === 'webgl2' ? '?backend=webgl2' : '');
      console.log(`[backend] requested=${requested} actual=${backend}`);
      if (requested === 'webgl2') expect(backend).toBe('webgl2');
      else expect(['webgpu', 'webgl2']).toContain(backend); // headless may lack a WebGPU adapter

      const s = await sample(page);
      expect(dist(s.centre, s.corner), 'centre must differ from the background').toBeGreaterThan(
        25,
      );
      expect(s.darkPixels, 'feature edges should produce dark pixels').toBeGreaterThan(300);
      expect(s.distinct, 'shaded faces give a gradient of colours').toBeGreaterThan(20);

      const stats = await page.evaluate(() => window.__viewport?.viewport.stats());
      expect(stats?.backend).toBe(backend);
      expect(stats?.triangles).toBe(12);
      expect(stats?.drawCalls).toBeGreaterThan(0);
    });
  });
}

test('dark theme renders a dark background', async ({ page }) => {
  await open(page, '?backend=webgl2&theme=dark');
  const s = await sample(page);
  expect(s.corner[0] + s.corner[1] + s.corner[2]).toBeLessThan(150);
  expect(dist(s.centre, s.corner)).toBeGreaterThan(25);
});

test.describe('camera', () => {
  test('mouse: left-drag orbits, wheel zooms, right-drag pans, double-click fits', async ({
    page,
  }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    const cam = () => page.evaluate(() => window.__viewport?.viewport.getCameraState());
    const before = (await cam())!;
    const box = (await page.locator('canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 60, { steps: 12 });
    await page.mouse.up();
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const orbited = (await cam())!;
    expect(dist(orbited.position, before.position)).toBeGreaterThan(5);
    expect(dist(orbited.target, before.target)).toBeLessThan(1e-3);
    expect(orbited.distance).toBeCloseTo(before.distance, 0);

    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const zoomed = (await cam())!;
    expect(zoomed.distance).toBeLessThan(orbited.distance - 1);

    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 120, cy + 40, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const panned = (await cam())!;
    expect(dist(panned.target, zoomed.target)).toBeGreaterThan(1);

    await page.mouse.dblclick(cx, cy);
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const fitted = (await cam())!;
    expect(dist(fitted.target, [20, 15, 10])).toBeLessThan(0.5);
  });

  test('touch: one-finger drag orbits, two-finger pinch zooms (CDP touch events)', async ({
    page,
  }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    const cdp = await page.context().newCDPSession(page);
    const cam = () => page.evaluate(() => window.__viewport?.viewport.getCameraState());
    const box = (await page.locator('canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const touch = (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      pts: Array<{ x: number; y: number; id: number }>,
    ) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })),
      });

    const before = (await cam())!;
    await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', [{ x: cx + i * 12, y: cy + i * 4, id: 1 }]);
    }
    await touch('touchEnd', []);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const orbited = (await cam())!;
    expect(dist(orbited.position, before.position)).toBeGreaterThan(5);
    expect(dist(orbited.target, before.target)).toBeLessThan(1e-3);

    // Pinch out (fingers apart) -> dolly in.
    await touch('touchStart', [
      { x: cx - 30, y: cy, id: 1 },
      { x: cx + 30, y: cy, id: 2 },
    ]);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', [
        { x: cx - 30 - i * 8, y: cy, id: 1 },
        { x: cx + 30 + i * 8, y: cy, id: 2 },
      ]);
    }
    await touch('touchEnd', []);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const pinched = (await cam())!;
    expect(pinched.distance).toBeLessThan(orbited.distance - 1);

    // Double-tap fits.
    for (let n = 0; n < 2; n++) {
      await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
      await touch('touchEnd', []);
    }
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    const fitted = (await cam())!;
    expect(dist(fitted.target, [20, 15, 10])).toBeLessThan(0.5);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('canvas')!).touchAction),
    ).toBe('none');
  });

  test('standard views point the camera along the expected axes', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    const expectations: Record<string, number[]> = {
      front: [0, -1, 0],
      back: [0, 1, 0],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
    };
    for (const [view, dir] of Object.entries(expectations)) {
      await page.evaluate((v) => window.__viewport?.setView(v as never), view);
      await page.evaluate(() => window.__viewport?.viewport.nextFrame());
      const c = (await page.evaluate(() => window.__viewport?.viewport.getCameraState()))!;
      const d = c.position.map((p, i) => (p - c.target[i]!) / c.distance);
      expect(dist(d, dir), view).toBeLessThan(1e-2);
    }
  });

  test('idle viewport does not burn frames (render on demand)', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    await page.waitForTimeout(400); // let any pending frames settle
    const count = () => page.evaluate(() => window.__viewport?.viewport.getRenderCount() ?? -1);
    const a = await count();
    await page.waitForTimeout(700);
    expect(await count()).toBe(a);
    // ...and an explicit request renders exactly one more frame.
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
    expect(await count()).toBe(a + 1);
  });
});

test('screenshot artefact (box, WebGL2, DPR 2)', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await open(page, '?backend=webgl2&reducedMotion=1');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, 'box-webgl2.png') });
  await page.evaluate(() => {
    window.__viewport?.viewport.setTheme('dark');
  });
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  await page.screenshot({ path: join(SHOTS, 'box-webgl2-dark.png') });
  await context.close();
});

test('perf probe: 1M triangles orbiting', async ({ page }) => {
  test.setTimeout(240_000);
  const backend = await open(page, '?backend=webgl2&reducedMotion=1');
  await page.evaluate(() => window.__viewport?.loadDense(1_000_000));
  await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  const stats = await page.evaluate(() => window.__viewport?.viewport.stats());
  expect(stats?.triangles).toBeGreaterThan(950_000);

  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();

  // Measure rAF-to-rAF presented frame intervals and per-render CPU time while dragging.
  const N = 40;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__frames.push(now - last);
      last = now;
      if (w.__frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < N; i++) {
    await page.mouse.move(cx + Math.sin(i / 4) * 150, cy + Math.cos(i / 4) * 60);
    await page.evaluate(() => window.__viewport?.viewport.nextFrame());
  }
  await page.mouse.up();
  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames);
  const after = await page.evaluate(() => window.__viewport?.viewport.stats());
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  console.log(
    `[perf] backend=${backend} tris=${after?.triangles} drawCalls=${after?.drawCalls} ` +
      `renderCpuMs(avg60)=${after?.frameMs.toFixed(2)} frameInterval mean=${mean.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
      '(budget <= 8 ms desktop; advisory on CPU-only SwiftShader)',
  );
  expect(after?.frameMs).toBeGreaterThan(0);
});
