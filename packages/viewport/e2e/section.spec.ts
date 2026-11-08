import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { countColor, dist, frame, open, samplePoints } from './helpers';

// Light palette: body #b4bdc9 = (180,189,201); caps are that darkened by 20% toward black.
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'screenshots');
const CAP: [number, number, number] = [144, 151, 161];
const BACKGROUND: [number, number, number] = [236, 239, 243];

test.describe('section', () => {
  test('caps fill the cut solid in a darkened body colour (WebGL2 stencil)', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.setView('right', false); // camera on +X looking at the box
      v.setSection({ origin: [20, 15, 10], normal: [1, 0, 0], caps: true });
    });
    await frame(page);
    mkdirSync(SHOTS, { recursive: true });
    await page.locator('canvas').screenshot({ path: join(SHOTS, 'section-caps.png') });
    const box = (await page.locator('canvas').boundingBox())!;
    const [centre] = await samplePoints(page, [[box.width / 2, box.height / 2]]);
    expect(dist(centre!, CAP), `centre pixel ${centre}`).toBeLessThan(14);

    // The cap is a flat solid colour: a patch of pixels around the centre is uniform.
    const patch = await samplePoints(page, [
      [box.width / 2 - 20, box.height / 2 - 12],
      [box.width / 2 + 20, box.height / 2 + 12],
      [box.width / 2 - 15, box.height / 2 + 15],
    ]);
    for (const p of patch) expect(dist(p, centre!)).toBeLessThan(4);

    // Large share of pixels is cap coloured and sits roughly in the middle of the canvas.
    const caps = await countColor(page, CAP, 8);
    expect(caps.count).toBeGreaterThan(2500);
  });

  test('without caps the cut is hollow; clearing the section restores the body', async ({
    page,
  }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    const box = (await page.locator('canvas').boundingBox())!;
    const mid: [number, number] = [box.width / 2, box.height / 2];
    await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.setView('right', false);
      v.setSection({ origin: [20, 15, 10], normal: [1, 0, 0], caps: false });
    });
    await frame(page);
    const [hollow] = await samplePoints(page, [mid]);
    // Looking into the open shell: back faces are culled, so we see through to the ground/background.
    expect(dist(hollow!, CAP)).toBeGreaterThan(25);

    await page.evaluate(() => window.__viewport!.viewport.setSection(null));
    await frame(page);
    const [solid] = await samplePoints(page, [mid]);
    // Shaded (lit) body: just clearly not background and not the flat cap colour.
    expect(dist(solid!, BACKGROUND), `solid ${solid}`).toBeGreaterThan(50);
  });

  test('half the model is clipped away and the caps follow the plane', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.setView('front', false); // looking along +y: x runs left to right
      v.setSection({ origin: [10, 15, 10], normal: [1, 0, 0], caps: true });
    });
    await frame(page);
    const box = (await page.locator('canvas').boundingBox())!;
    const p0 = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([2, 0, 10]));
    const p1 = await page.evaluate(() => window.__viewport!.viewport.worldToScreen([38, 0, 10]));
    const [kept, clipped] = await samplePoints(page, [
      [p0.x, p0.y],
      [p1.x, p1.y],
    ]);
    expect(dist(kept!, BACKGROUND), `kept ${kept}`).toBeGreaterThan(50);
    expect(dist(clipped!, BACKGROUND), `clipped ${clipped}`).toBeLessThan(40);
    expect(box.width).toBeGreaterThan(0);
  });

  test('picking ignores clipped geometry', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    const hit = (kinds: string[]) =>
      page.evaluate((k) => {
        const v = window.__viewport!.viewport;
        const c = v.worldToScreen([20, 15, 10]);
        return v.pick(c.x, c.y, { kinds: k as never });
      }, kinds);
    await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      v.setView('right', false);
    });
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const before = await hit(['face']);
    expect(before[0]?.kind).toBe('face');
    expect(before[0]?.point[0]).toBeCloseTo(40, 3); // the +x face nearest the camera

    await page.evaluate(() =>
      window.__viewport!.viewport.setSection({ origin: [20, 15, 10], normal: [1, 0, 0] }),
    );
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    // The near wall is gone; the far -x wall is back-facing from this side: nothing to pick.
    expect(await hit(['face'])).toEqual([]);

    // From the other side the kept half is picked as usual (its x=0 face).
    await page.evaluate(() => window.__viewport!.viewport.setView('left', false));
    await frame(page);
    await page.evaluate(() => window.__viewport!.viewport.whenPickReady());
    const kept = await hit(['face']);
    expect(kept[0]?.kind).toBe('face');
    expect(kept[0]?.point[0]).toBeCloseTo(0, 3);

    // Edges/vertices on the clipped side are not offered either.
    await page.evaluate(() => window.__viewport!.viewport.setView('iso', false));
    await frame(page);
    const all = await page.evaluate(() => {
      const v = window.__viewport!.viewport;
      const out: number[] = [];
      for (let y = 0; y < 600; y += 12) {
        for (let x = 0; x < 800; x += 12) {
          for (const h of v.pick(x, y, { kinds: ['edge', 'vertex'], tolerancePx: 4 })) {
            out.push(h.point[0]);
          }
        }
      }
      return out;
    });
    expect(all.length).toBeGreaterThan(0);
    for (const x of all) expect(x).toBeLessThanOrEqual(20 + 1e-3);
  });

  test('works with several bodies and survives body replacement', async ({ page }) => {
    await open(page, '?backend=webgl2&reducedMotion=1');
    await page.evaluate(() => {
      const v = window.__viewport!;
      v.addBox('second', [20, 20, 20], [60, 0, 0]);
      v.viewport.fitAll(false);
      v.viewport.setSection({ origin: [30, 15, 10], normal: [1, 0, 0] });
      v.addBox('second', [20, 20, 20], [60, 0, 0]); // replace while sectioned
    });
    await frame(page);
    // The first body is cut, the second is fully clipped; nothing throws.
    const stats = await page.evaluate(() => window.__viewport!.viewport.stats());
    expect(stats.triangles).toBeGreaterThan(0);
    await page.evaluate(() => {
      const v = window.__viewport!;
      v.viewport.setSection(null);
      v.viewport.removeBody('second');
    });
    await frame(page);
    expect(await page.evaluate(() => window.__viewportError)).toBeUndefined();
  });
});
