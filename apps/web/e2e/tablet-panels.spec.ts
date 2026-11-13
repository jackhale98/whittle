import { devices, expect, type Page, test } from '@playwright/test';
import {
  addBox,
  app,
  boot,
  cameraState,
  cameraStill,
  openPanel,
  panel,
  toPage,
  topCenter,
  touch,
} from './helpers';

/**
 * ADR-099 on a portrait iPad (820 x 1180): too narrow to dock both side panels, so the feature
 * panel and the inspector open as overlays over the view, one at a time. The model must stay in
 * the free area (frame insets, ADR-086), never jump (zoom and orientation are untouched), and a tap
 * outside or the panel's button closes the overlay.
 */

test.use({
  viewport: { width: 820, height: 1180 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

type Rect = { x: number; y: number; width: number; height: number };
const inside = (p: { x: number; y: number }, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

async function box(page: Page, testId: string): Promise<Rect> {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

/** The part's centre and its eight corners, in page px. */
async function partPoints(page: Page) {
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const corners = [];
  for (const x of [x0, x1])
    for (const y of [y0, y1])
      for (const z of [z0, z1]) corners.push(await toPage(page, [x ?? 0, y ?? 0, z ?? 0]));
  const centre = await toPage(page, [
    ((x0 ?? 0) + (x1 ?? 0)) / 2,
    ((y0 ?? 0) + (y1 ?? 0)) / 2,
    ((z0 ?? 0) + (z1 ?? 0)) / 2,
  ]);
  return { centre, corners };
}

async function fitNow(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __wrenViewport: { fitAll(animate: boolean): void } }
    ).__wrenViewport.fitAll(false),
  );
  await cameraStill(page);
}

async function start(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
  await addBox(page);
  await app(page).idle();
  await cameraStill(page);
}

test('portrait: the panels overlay the view; the new feature opens the inspector, Done closes it', async ({
  page,
}) => {
  test.slow();
  await start(page);
  await expect(page.getByTestId('shell-body')).toHaveAttribute('data-panels', 'overlay');
  // The values of the new box are in the inspector overlay; the tree is closed.
  await expect(panel(page, 'right')).not.toHaveAttribute('inert', '');
  await expect(panel(page, 'left')).toHaveAttribute('inert', '');
  const canvas = await box(page, 'viewport-canvas');
  // The view did not shrink for the overlay: it is the whole window width minus the body padding.
  expect(canvas.width).toBeGreaterThan(780);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await expect(panel(page, 'right')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('panel-scrim')).toHaveCount(0);
});

test('portrait: opening the tree and the inspector never covers the selected geometry', async ({
  page,
}) => {
  test.slow();
  await start(page);
  const a = app(page);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  // Select the top face by touch.
  const t = await touch(page);
  await t.tap([await topCenter(page)]);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['face']);
  const rest = await partPoints(page);
  const camera = await cameraState(page);

  for (const side of ['left', 'right'] as const) {
    await openPanel(page, side);
    await cameraStill(page);
    // One at a time.
    await expect(panel(page, side === 'left' ? 'right' : 'left')).toHaveAttribute('inert', '');
    const p = await box(page, `${side}-panel`);
    const canvas = await box(page, 'viewport-canvas');
    const now = await partPoints(page);
    const face = await topCenter(page);
    expect(inside(face, p), `${side} panel covers the selected face's centre`).toBe(false);
    expect(inside(now.centre, p), `${side} panel covers the part's centre`).toBe(false);
    expect(inside(face, canvas)).toBe(true);
    // The view moved sideways into the free area; zoom and orientation are untouched.
    const c = await cameraState(page);
    expect(c.distance).toBeCloseTo(camera.distance, 3);
    const dir = (s: typeof camera) =>
      s.position.map((v, i) => (v - (s.target[i] ?? 0)) / s.distance);
    dir(c).forEach((v, i) => {
      expect(v).toBeCloseTo(dir(camera)[i] ?? 0, 3);
    });
    // The selection survives opening a panel.
    expect((await a.ui()).selection).toEqual(['face']);
    // Close by the same button: the view comes back where it was.
    await page.getByTestId(`${side}-toggle`).tap();
    await expect(panel(page, side)).toHaveAttribute('inert', '');
    // The panel slides away over ~260 ms and the camera follows it frame by frame.
    await expect
      .poll(async () => {
        const back = (await partPoints(page)).centre;
        return Math.max(Math.abs(back.x - rest.centre.x), Math.abs(back.y - rest.centre.y));
      })
      .toBeLessThan(1.5);
  }
});

test('portrait: a tap outside closes the overlay and does not act on the view', async ({
  page,
}) => {
  test.slow();
  await start(page);
  const a = app(page);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  await openPanel(page, 'left');
  const p = await box(page, 'left-panel');
  const canvas = await box(page, 'viewport-canvas');
  await expect(page.getByTestId('panel-scrim')).toHaveCount(1);
  // Tap on the part, outside the panel: the panel closes and nothing is selected by that tap.
  const outside = {
    x: p.x + p.width + (canvas.x + canvas.width - p.x - p.width) / 2,
    y: p.y + 300,
  };
  await page.touchscreen.tap(outside.x, outside.y);
  await expect(panel(page, 'left')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('left-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('panel-scrim')).toHaveCount(0);
  expect((await a.ui()).selection).toEqual([]);
  // Escape closes it too, and returns focus to its button.
  await openPanel(page, 'right');
  await page.keyboard.press('Escape');
  await expect(panel(page, 'right')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('right-toggle')).toBeFocused();
});

test('portrait: a fit stays framed in the area the panel leaves free', async ({ page }) => {
  test.slow();
  await start(page);
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  await fitNow(page);
  const full = await box(page, 'viewport-canvas');
  for (const c of (await partPoints(page)).corners) expect(inside(c, full)).toBe(true);

  for (const side of ['left', 'right'] as const) {
    await openPanel(page, side);
    await cameraStill(page);
    await fitNow(page);
    const p = await box(page, `${side}-panel`);
    const { corners, centre } = await partPoints(page);
    for (const c of corners) {
      expect(inside(c, p), `${side}: a corner is under the panel`).toBe(false);
      expect(inside(c, full), `${side}: a corner is outside the view`).toBe(true);
    }
    expect(inside(centre, p)).toBe(false);
    await page.getByTestId(`${side}-toggle`).tap();
    await expect(panel(page, side)).toHaveAttribute('inert', '');
    await cameraStill(page);
  }
});

test('landscape iPad docks both panels and the view resizes instead of being covered', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1180, height: 820 });
  await start(page);
  await expect(page.getByTestId('shell-body')).toHaveAttribute('data-panels', 'docked');
  await openPanel(page, 'left');
  await openPanel(page, 'right');
  // Both open at once, side by side with the view (no overlay, no scrim).
  await expect(page.getByTestId('panel-scrim')).toHaveCount(0);
  const l = await box(page, 'left-panel');
  const r = await box(page, 'right-panel');
  const c = await box(page, 'viewport-canvas');
  expect(l.x + l.width).toBeLessThanOrEqual(c.x + 1);
  expect(c.x + c.width).toBeLessThanOrEqual(r.x + 1);
  expect(c.width).toBeGreaterThanOrEqual(480);
});

test('narrow iPads (820 and 744 wide): the top bar fits and every button is reachable at 44 px', async ({
  page,
}) => {
  test.slow();
  await start(page);
  for (const width of [820, 744]) {
    await page.setViewportSize({ width, height: 1133 });
    await page.waitForTimeout(200);
    const bar = await page.getByTestId('top-bar').evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      right: Math.max(
        ...[...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right),
      ),
      small: [...el.querySelectorAll('button')]
        .filter(
          (b) => b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44,
        )
        .map((b) => b.getAttribute('aria-label') ?? b.textContent),
    }));
    expect(bar.scroll, `${width}: top bar overflows`).toBeLessThanOrEqual(bar.client);
    expect(bar.right, `${width}: a button is off screen`).toBeLessThanOrEqual(width);
    expect(bar.small).toEqual([]);
  }
});
