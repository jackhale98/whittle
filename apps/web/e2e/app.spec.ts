import { expect, type Page, test } from '@playwright/test';
import type { RuntimeDiagnostics, WhittleTestHooks } from '@whittle/contracts';

/**
 * M0 acceptance: "a deployed URL shows a shaded box with edges in under 2 s (warm), works in
 * airplane mode after the first visit". Runs against the production build served like GitHub
 * Pages (base /whittle/, isolation only via the service worker).
 */

interface Timings {
  shellInteractiveMs: number;
  kernelReadyMs: number;
  firstBodyMs: number;
}

const hooks = (page: Page) => ({
  diagnostics: () =>
    page.evaluate(() =>
      (window as unknown as { __whittle: WhittleTestHooks }).__whittle.diagnostics(),
    ) as Promise<RuntimeDiagnostics>,
  firstBody: () =>
    page.evaluate(() =>
      (window as unknown as { __whittle: WhittleTestHooks }).__whittle.firstBodyRendered(),
    ) as Promise<Timings>,
});

/** Pixel statistics of the viewport canvas, decoded from a real screenshot (not readPixels). */
async function canvasStats(page: Page) {
  const png = await page.getByTestId('viewport-canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const at = (x: number, y: number) => {
      const i = (Math.floor(y) * c.width + Math.floor(x)) * 4;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    };
    const corner = at(4, 4);
    let differing = 0;
    let dark = 0;
    const shades = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (
        Math.abs(r - (corner[0] ?? 0)) +
          Math.abs(g - (corner[1] ?? 0)) +
          Math.abs(b - (corner[2] ?? 0)) >
        30
      )
        differing++;
      if (r + g + b < 200) dark++;
      shades.add(`${r >> 3},${g >> 3},${b >> 3}`);
    }
    const total = data.length / 4;
    return { differingFraction: differing / total, darkPixels: dark, shades: shades.size };
  }, png.toString('base64'));
}

async function firstVisit(page: Page): Promise<Timings> {
  await page.goto('./');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  return hooks(page).firstBody();
}

test.describe('box on screen (M0)', () => {
  test('first visit: OCCT box rendered by the threaded kernel with shading and edges', async ({
    page,
  }) => {
    const t = await firstVisit(page);
    const d = await hooks(page).diagnostics();
    expect(d.crossOriginIsolated).toBe(true);
    expect(d.kernelVariant).toBe('threaded');
    expect(['webgpu', 'webgl2']).toContain(d.renderBackend);
    await expect(page.getByTestId('app-shell')).toContainText('Kernel ready');

    const s = await canvasStats(page);
    expect(s.differingFraction).toBeGreaterThan(0.05); // a body covers part of the view
    expect(s.darkPixels).toBeGreaterThan(200); // feature edges are drawn
    expect(s.shades).toBeGreaterThan(20); // shaded, not flat
    console.log(`first visit (cold kernel): ${JSON.stringify(t)} backend=${d.renderBackend}`);
  });

  test('warm visit: shaded box with edges in under 2 s', async ({ page }) => {
    await firstVisit(page);
    await page.reload();
    const t = await hooks(page).firstBody();
    console.log(`warm visit: ${JSON.stringify(t)}`);
    expect(t.firstBodyMs).toBeLessThan(2000);
    expect(t.kernelReadyMs).toBeLessThan(1000 + t.shellInteractiveMs); // PLAN §10 warm kernel ≤ 1 s
    const s = await canvasStats(page);
    expect(s.differingFraction).toBeGreaterThan(0.05);
  });

  test('airplane mode after the first visit: shell, kernel and box all load offline', async ({
    page,
    context,
  }) => {
    await firstVisit(page);
    await context.setOffline(true);
    await page.reload();
    const t = await hooks(page).firstBody();
    console.log(`offline visit: ${JSON.stringify(t)}`);
    const d = await hooks(page).diagnostics();
    expect(d.crossOriginIsolated).toBe(true);
    expect(d.kernelVariant).toBe('threaded');
    const s = await canvasStats(page);
    expect(s.differingFraction).toBeGreaterThan(0.05);
    expect(s.darkPixels).toBeGreaterThan(200);
  });
});

test.describe('fallback without cross-origin isolation', () => {
  test.use({ serviceWorkers: 'block' });

  test('single-threaded kernel still renders the box', async ({ page }) => {
    await page.goto('./');
    const t = await hooks(page).firstBody();
    const d = await hooks(page).diagnostics();
    expect(d.crossOriginIsolated).toBe(false);
    expect(d.kernelVariant).toBe('single');
    const s = await canvasStats(page);
    expect(s.differingFraction).toBeGreaterThan(0.05);
    console.log(`fallback: ${JSON.stringify(t)}`);
  });
});

test('forced WebGL2 backend renders the box (deterministic CI path)', async ({ page }) => {
  await page.goto('./?backend=webgl2');
  await page.waitForFunction(() => window.crossOriginIsolated === true);
  await hooks(page).firstBody();
  expect((await hooks(page).diagnostics()).renderBackend).toBe('webgl2');
  await page.screenshot({ path: 'test-results/m0-box-desktop.png' });
});
