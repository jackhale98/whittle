import { expect, type Page, test } from '@playwright/test';
import { frame, open, settle } from './helpers';

/**
 * Regression: sketch curves, region fills, highlights and body edges lie exactly on a face. They
 * used `polygonOffset`, which WebGPU applies only to triangle lists and in raw depth units, so on
 * the WebGPU backend (Edge/Chrome default) an inactive sketch on a face vanished. The depth bias
 * is now a clip-space z shift (overlays.ts `applyDepthBias`), identical on both backends.
 */

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--enable-webgpu-developer-features',
      '--use-vulkan=swiftshader',
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--disable-vulkan-fallback-to-gl-for-testing',
      '--ignore-gpu-blocklist',
    ],
  },
});

/** Number of canvas pixels that differ noticeably between two screenshots. */
async function diffPixels(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ({ x, y }) => {
      const load = async (d: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${d}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const [pa, pb] = await Promise.all([load(x), load(y)]);
      let n = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d =
          Math.abs((pa[i] as number) - (pb[i] as number)) +
          Math.abs((pa[i + 1] as number) - (pb[i + 1] as number)) +
          Math.abs((pa[i + 2] as number) - (pb[i + 2] as number));
        if (d > 45) n++;
      }
      return n;
    },
    { x: a.toString('base64'), y: b.toString('base64') },
  );
}

/**
 * `webgl2-no-polygon-offset` runs the WebGL2 backend with `gl.polygonOffset` stubbed out: that is
 * what the WebGPU backend effectively does to our overlays (headless Chromium here has no usable
 * WebGPU device, see backend.ts), so this variant fails without the depth bias.
 */
const variants = [
  { name: 'webgl2', backend: 'webgl2', noOffset: false },
  { name: 'webgl2-no-polygon-offset', backend: 'webgl2', noOffset: true },
  { name: 'webgpu', backend: 'webgpu', noOffset: false },
] as const;

for (const { name, backend, noOffset } of variants) {
  test.describe(`coplanar overlays on ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      if (noOffset) {
        await page.addInitScript(() => {
          WebGL2RenderingContext.prototype.polygonOffset = () => {};
        });
      }
    });

    test('a sketch on the top face, seen obliquely and inactive, is drawn', async ({ page }) => {
      const got = await open(page, `?backend=${backend}&reducedMotion=1&hover=0`);
      test.skip(got !== backend, `${backend} is not available in this browser`);
      await settle(page);
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      const base = await page.locator('canvas').screenshot();
      await page.evaluate(() => window.__viewport!.showSketch(false));
      await frame(page);
      const withSketch = await page.locator('canvas').screenshot();
      // The rectangle and circle outlines plus their translucent regions: thousands of pixels.
      expect(await diffPixels(page, base, withSketch)).toBeGreaterThan(1500);
    });

    test('a sketch within a hair of the face wins the depth test; one clearly behind stays hidden', async ({
      page,
    }) => {
      const got = await open(page, `?backend=${backend}&reducedMotion=1&hover=0`);
      test.skip(got !== backend, `${backend} is not available in this browser`);
      await settle(page);
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      const base = await page.locator('canvas').screenshot();
      // 0.15 mm under the top face: numeric slop of a sketch "on" the face, and what depth
      // precision does to coplanar geometry. The bias (0.2 % of the view distance) covers it.
      await page.evaluate(() => window.__viewport!.showSketchAt(19.85));
      await frame(page);
      const near = await page.locator('canvas').screenshot();
      expect(await diffPixels(page, base, near)).toBeGreaterThan(1500);
      // 3 mm inside the part: hidden by the model, as it must be.
      await page.evaluate(() => window.__viewport!.showSketchAt(17));
      await frame(page);
      const deep = await page.locator('canvas').screenshot();
      expect(await diffPixels(page, base, deep)).toBeLessThan(150);
    });

    test('a selected top face and its edges are drawn over the face', async ({ page }) => {
      const got = await open(page, `?backend=${backend}&reducedMotion=1&hover=0`);
      test.skip(got !== backend, `${backend} is not available in this browser`);
      await settle(page);
      await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
      await frame(page);
      const base = await page.locator('canvas').screenshot();
      const hit = await page.evaluate(() => {
        const v = window.__viewport!.viewport;
        const s = v.worldToScreen([20, 15, 20]);
        return v.pick(s.x, s.y, { kinds: ['face'] })[0] ?? null;
      });
      expect(hit?.kind).toBe('face');
      await page.evaluate((h) => {
        window.__viewport!.viewport.setHighlights({
          selected: [{ bodyId: h!.bodyId, kind: 'face', index: h!.index }],
          preselected: [],
        });
      }, hit);
      await frame(page);
      const lit = await page.locator('canvas').screenshot();
      // The accent fill covers the whole top face.
      expect(await diffPixels(page, base, lit)).toBeGreaterThan(8000);
    });
  });
}
