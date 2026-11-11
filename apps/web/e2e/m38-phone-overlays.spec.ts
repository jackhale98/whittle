import { devices, expect, type Locator, type Page, test } from '@playwright/test';
import { app, boot, cameraStill, touch } from './helpers';

/**
 * M3.8 acceptance, phone overlays: after "section by face" or Measure on the demo bracket the
 * selection bubble is gone, the floating overlays never intersect, the sheet's tab is the tool's
 * one home (its chip hides), at least 60 % of the model is visible above the sheet and the offset
 * field shows its unit.
 */

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: devices['iPhone 13'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const tab = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Viewer tools' }).getByRole('button', { name });

/** A face well inside a flat top, between `top` and `bottom` px of the canvas. */
async function faceAt(page: Page, top: number, bottom: number) {
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const p = await page.evaluate(
    ({ top, bottom, w }) => {
      const v = (
        window as unknown as {
          __wrenViewport: {
            pick(x: number, y: number, o: unknown): Array<{ kind: string; normal?: number[] }>;
          };
        }
      ).__wrenViewport;
      let any: { x: number; y: number } | null = null;
      for (let y = top; y < bottom; y += 12)
        for (let x = 40; x < w - 40; x += 12) {
          const h = v.pick(x, y, { kinds: ['face'] })[0];
          if (!h) continue;
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

interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every visible floating overlay's page box. */
async function overlayBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const sels: Record<string, string> = {
      bubble: '[data-testid="context-bubble"]',
      'section-chip': '[data-testid="section-chip"]',
      prompt: '[data-testid="prompt"]',
      toast: '[data-testid="toast"]',
      'view-cube': '[data-testid="view-cube"]',
      'top-bar': '[data-testid="top-bar"]',
      library: '[data-testid="library-button"]',
      sheet: '[data-testid="tools-sheet"]',
    };
    const out: { name: string; x: number; y: number; w: number; h: number }[] = [];
    for (const [name, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el || (el as HTMLElement).hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  });
}

function expectNoIntersections(boxes: Box[]) {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      expect(hit, `${a.name} and ${b.name} overlap`).toBe(false);
    }
}

/**
 * The share of the model's projected bounding-box hull that lies above `limit` (page y). The hull
 * of the eight projected bbox corners is an upper bound of the silhouette; clipping it with
 * Sutherland-Hodgman gives the visible part.
 */
async function visibleShare(page: Page, limit: number, top: number): Promise<number> {
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  const canvas = await page.getByTestId('viewport-canvas').boundingBox();
  if (!canvas) throw new Error('no canvas');
  return page.evaluate(
    ({ min, max, limit, top, oy }) => {
      type P = [number, number];
      const v = (
        window as unknown as {
          __wrenViewport: { worldToScreen(p: number[]): { x: number; y: number } };
        }
      ).__wrenViewport;
      const pts: P[] = [];
      for (const x of [min[0], max[0]])
        for (const y of [min[1], max[1]])
          for (const z of [min[2], max[2]]) {
            const s = v.worldToScreen([x ?? 0, y ?? 0, z ?? 0]);
            pts.push([s.x, s.y + oy]);
          }
      const cross = (o: P, a: P, c: P) =>
        (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
      const sorted = [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const half = (arr: P[]) => {
        const h: P[] = [];
        for (const p of arr) {
          while (h.length >= 2 && cross(h[h.length - 2] as P, h[h.length - 1] as P, p) <= 0)
            h.pop();
          h.push(p);
        }
        h.pop();
        return h;
      };
      const hull = [...half(sorted), ...half([...sorted].reverse())];
      const area = (poly: P[]) => {
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i] as P;
          const q = poly[(i + 1) % poly.length] as P;
          a += p[0] * q[1] - q[0] * p[1];
        }
        return Math.abs(a) / 2;
      };
      // Clip to top <= y <= limit.
      const clip = (poly: P[], inside: (p: P) => boolean, cut: (p: P, q: P) => P) => {
        const out: P[] = [];
        poly.forEach((p, i) => {
          const q = poly[(i + 1) % poly.length] as P;
          if (inside(p)) {
            out.push(p);
            if (!inside(q)) out.push(cut(p, q));
          } else if (inside(q)) out.push(cut(p, q));
        });
        return out;
      };
      const at =
        (y: number) =>
        (p: P, q: P): P => {
          const t = (y - p[1]) / (q[1] - p[1]);
          return [p[0] + t * (q[0] - p[0]), y];
        };
      let vis = clip(hull, (p) => p[1] <= limit, at(limit));
      if (vis.length) vis = clip(vis, (p) => p[1] >= top, at(top));
      return vis.length ? area(vis) / area(hull) : 0;
    },
    { min: b.min, max: b.max, limit, top, oy: canvas.y },
  );
}

async function openDemo(page: Page) {
  await boot(page);
  const a = app(page);
  await page.getByTestId('open-demo').tap();
  await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
  await a.idle();
  return a;
}

async function sheetTop(page: Page): Promise<number> {
  const s = (await overlayBoxes(page)).find((b) => b.name === 'sheet');
  if (!s) throw new Error('no sheet');
  return s.y;
}

async function expectUnit(field: Locator) {
  const input = field.locator('input');
  await expect(input).toHaveValue(/mm$/);
  // The unit is not clipped: the text fits the input's content box.
  const fits = await input.evaluate(
    (el) => (el as HTMLInputElement).scrollWidth <= el.clientWidth + 1,
  );
  expect(fits, 'the value and its unit fit the field').toBe(true);
}

test('phone: section by face closes the bubble, hides the chip behind the Section tab, frames the model', async ({
  page,
}) => {
  test.slow();
  const a = await openDemo(page);
  const t = await touch(page);
  await t.tap([await faceAt(page, 120, 700)]);
  await a.idle();
  const bubble = page.getByTestId('context-bubble');
  await expect(bubble.locator('[data-action="section"]')).toBeVisible();
  expectNoIntersections(await overlayBoxes(page));

  await bubble.locator('[data-action="section"]').tap();
  await a.idle();
  await cameraStill(page);
  // The action closed the bubble, and it does not come back on its own.
  await expect(bubble).toHaveCount(0);
  await expect.poll(async () => (await a.ui()).section.enabled).toBe(true);
  // The Section tab is open: its chip is hidden (the tab has Flip and the switch).
  await expect(page.getByTestId('section-panel')).toBeVisible();
  await expect(page.getByTestId('section-chip')).toHaveCount(0);
  expectNoIntersections(await overlayBoxes(page));
  await expectUnit(page.getByTestId('section-offset-value'));
  expect(await visibleShare(page, await sheetTop(page), 54)).toBeGreaterThanOrEqual(0.6);

  // Collapse the sheet: the chip is back, clear of everything, and the model is re-framed.
  await page.getByTestId('tools-sheet-grip').getByRole('button').first().tap();
  await expect(page.getByTestId('tools-sheet')).toHaveAttribute('data-snap', 'peek');
  await expect(page.getByTestId('section-chip')).toBeVisible();
  await cameraStill(page);
  await page.waitForTimeout(400);
  await cameraStill(page);
  expectNoIntersections(await overlayBoxes(page));
  expect(await visibleShare(page, await sheetTop(page), 54)).toBeGreaterThanOrEqual(0.6);
  await expect(bubble).toHaveCount(0);

  if (process.env.WREN_SHOTS)
    await page.screenshot({ path: `${process.env.WREN_SHOTS}/phone-section-chip.png` });
});

test('phone: measure by face closes the bubble, shows the tab as the one home, frames the model', async ({
  page,
}) => {
  test.slow();
  const a = await openDemo(page);
  const t = await touch(page);
  await t.tap([await faceAt(page, 120, 700)]);
  await a.idle();
  const bubble = page.getByTestId('context-bubble');
  await bubble.locator('[data-action="measure"]').tap();
  await expect.poll(async () => (await a.ui()).measure?.active, { timeout: 30_000 }).toBe(true);
  await a.idle();
  await cameraStill(page);
  await expect(bubble).toHaveCount(0);
  // The Measure tab carries the instruction and results: no floating prompt chip.
  await expect(page.getByTestId('prompt')).toHaveCount(0);
  expectNoIntersections(await overlayBoxes(page));
  expect(await visibleShare(page, await sheetTop(page), 54)).toBeGreaterThanOrEqual(0.6);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`phone visual baselines, ${scheme}: section tab open and chip over the collapsed sheet`, async ({
    page,
  }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: scheme });
    const a = await openDemo(page);
    const t = await touch(page);
    await t.tap([await faceAt(page, 120, 700)]);
    await a.idle();
    await page.getByTestId('context-bubble').locator('[data-action="section"]').tap();
    await a.idle();
    await cameraStill(page);
    // The GL canvas differs between renderers: the baselines cover the opaque sheet and the chip.
    const sheet = async () => {
      const top = await sheetTop(page);
      return { x: 0, y: top, width: 390, height: 844 - top };
    };
    await expect(page).toHaveScreenshot(`phone-section-tab-${scheme}.png`, { clip: await sheet() });
    await page.getByTestId('tools-sheet-grip').getByRole('button').first().tap();
    await expect(page.getByTestId('section-chip')).toBeVisible();
    await cameraStill(page);
    await expect(page).toHaveScreenshot(`phone-section-peek-${scheme}.png`, {
      clip: await sheet(),
    });
    await expect(page.getByTestId('section-chip')).toHaveScreenshot(
      `phone-section-chip-${scheme}.png`,
      {
        maxDiffPixelRatio: 0.06,
      },
    );
  });
}
