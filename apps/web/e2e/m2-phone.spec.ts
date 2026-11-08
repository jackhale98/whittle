import { devices, expect, type Page, test } from '@playwright/test';
import type { WhittleTestHooks } from '@whittle/contracts';
import { app, boot, cameraStill, touch, touchStats } from './helpers';

/**
 * The phone viewer (PLAN §9.1, §8.4): cached meshes render without the kernel, which boots only
 * for the first measurement (or edit); Parts, Measure and Section tabs in the sheet, and the
 * viewer bubble on a tapped face.
 */

const SHOTS = process.env.WHITTLE_SHOTS;

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: devices['iPhone 13'].userAgent,
  // 2, not the iPhone's 3: SwiftShader on CI renders 9 MP frames slowly enough to turn taps into
  // long presses. The tier comes from the UA and the short side, not the pixel ratio.
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

/** Page point of a face pick in the band of the view above the sheet (`top`..`bottom` px). */
async function faceAt(page: Page, top: number, bottom: number) {
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const p = await page.evaluate(
    ({ top, bottom, w }) => {
      const v = (
        window as unknown as {
          __whittleViewport: {
            pick(x: number, y: number, o: unknown): Array<{ kind: string; normal?: number[] }>;
          };
        }
      ).__whittleViewport;
      // Prefer an upward face (a flat top), else any face.
      let any: { x: number; y: number } | null = null;
      for (let y = top; y < bottom; y += 12)
        for (let x = 40; x < w - 40; x += 12) {
          const h = v.pick(x, y, { kinds: ['face'] })[0];
          if (!h) continue;
          // Well inside the face: no edge or vertex within a finger's reach.
          if (v.pick(x, y, { kinds: ['edge', 'vertex'], tolerancePx: 30 }).length) continue;
          if ((h.normal?.[2] ?? 0) > 0.99) return { x, y };
          any ??= { x, y };
        }
      return any;
    },
    { top, bottom, w: box.width },
  );
  if (!p) throw new Error('no face in view');
  return { x: box.x + p.x, y: box.y + p.y };
}

const tab = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Viewer tools' }).getByRole('button', { name });

test('phone: a cached document is a viewer until the first measurement boots the kernel', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  expect(await page.getByTestId('app-shell').getAttribute('data-tier')).toBe('phone');
  // The demo has no cached meshes yet: the kernel boots to show it, and the cache is written.
  await page.getByTestId('open-demo').tap();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  expect((await a.ui()).kernel.started).toBe(true);
  expect(await a.cacheSaved()).toBe(true);
  expect((await a.regen())?.quality).toBe('coarse'); // phones settle at coarse meshes

  // Reopen: the cached meshes are on screen and the kernel is not started.
  await page.reload();
  await page.waitForFunction(
    () => !!(window as unknown as { __whittle?: WhittleTestHooks }).__whittle,
  );
  await page.evaluate(() =>
    (window as unknown as { __whittle: WhittleTestHooks }).__whittle.firstBodyRendered(),
  );
  expect((await a.regen())?.source).toBe('cache');
  expect((await a.ui()).kernel.started).toBe(false);
  await expect(page.getByTestId('kernel-loading')).toHaveCount(0);
  await cameraStill(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone-viewer.png` });

  // Parts: the part, its visibility.
  await tab(page, 'Parts').tap();
  const parts = page.getByTestId('parts-list');
  await expect(parts.getByRole('listitem')).toHaveCount(1);
  await parts.getByRole('button', { name: /^Hide / }).tap();
  await expect(parts.getByRole('button', { name: /^Show / })).toBeVisible();
  await parts.getByRole('button', { name: /^Show / }).tap();

  // A tapped face offers the viewer actions.
  await page.getByTestId('tools-sheet-grip').getByRole('button').first().tap();
  await expect(page.getByTestId('tools-sheet')).toHaveAttribute('data-snap', 'peek');
  const face = await faceAt(page, 120, 600);
  const t = await touch(page);
  await t.tap([face]);
  await a.idle();
  const bubble = page.getByTestId('context-bubble');
  await expect(bubble.locator('[data-action="measure"]')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone-bubble.png` });
  expect((await a.ui()).kernel.started).toBe(false); // selecting is not an edit

  // Measure: the first measurement boots the kernel and reads the face exactly.
  await bubble.locator('[data-action="measure"]').tap();
  await expect.poll(async () => (await a.ui()).kernel.started).toBe(true);
  await expect(page.getByTestId('tools-sheet')).toHaveAttribute('data-snap', 'half');
  await expect
    .poll(async () => (await a.ui()).measure?.results.length, { timeout: 30_000 })
    .toBe(1);
  expect((await a.ui()).measure?.results[0]?.area).toBeGreaterThan(0);
  await expect(page.getByTestId('measure-reading')).toHaveAttribute('data-kind', 'area');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone-measure.png` });

  // Section: on, along Y, flipped; caps are drawn by the viewport.
  await tab(page, 'Section').tap();
  expect((await a.ui()).measure).toBeNull(); // leaving the tab ends measuring
  const panel = page.getByTestId('section-panel');
  await panel.getByRole('switch', { name: 'Section view' }).tap();
  await expect.poll(async () => (await touchStats(page)).sectionActive).toBe(true);
  await panel.getByRole('radio', { name: 'Y' }).tap();
  expect((await a.ui()).section.axis).toBe('y');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone-section.png` });
});
