import { devices, expect, type Page, test } from '@playwright/test';
import type { DimensionConstraint, EntityRef, SketchFeature, WrenDoc } from '@wren-cad/contracts';
import { docWith, edgeName, extrude, fid, region, Sk, side } from './fixtures';
import {
  addBox,
  app,
  boot,
  cameraState,
  cameraStill,
  clickAt,
  palette,
  sketchOn,
  toPage,
  touch,
} from './helpers';

/**
 * M3.5 acceptance (PLAN "M3.5 — Navigation, input and sketch curves", Accept list): pivot at the
 * cursor, the four mouse presets (left box select, right / middle orbit and pan, right click =
 * radial menu), the radial menu (flick, Space, touch, Pencil, held key), Tab cycling, keys by
 * physical key, the keymap editor, errors at their cause, conflicts, curve tools, draggable
 * dimension labels, lineage.
 */

test.use({ viewport: { width: 1280, height: 720 } });

type V3 = [number, number, number];
type Btn = 'left' | 'middle' | 'right';

interface Probe {
  pick(x: number, y: number, o: { kinds: string[]; all?: boolean }): { point: V3; kind: string }[];
  worldToScreen(p: V3): { x: number; y: number; visible: boolean };
  getNavigation(): { preset: string };
  getNavigationState(): {
    dragging: string | null;
    pivot: V3 | null;
    pivotSource: string | null;
    markerVisible: boolean;
    pivotScreen: { x: number; y: number } | null;
  };
  whenPickReady(): Promise<void>;
}

const probe = (page: Page) => ({
  nav: () =>
    page.evaluate(() =>
      (window as unknown as { __wrenViewport: Probe }).__wrenViewport.getNavigationState(),
    ),
  navigation: () =>
    page.evaluate(() =>
      (window as unknown as { __wrenViewport: Probe }).__wrenViewport.getNavigation(),
    ),
  pickReady: () =>
    page.evaluate(() =>
      (window as unknown as { __wrenViewport: Probe }).__wrenViewport.whenPickReady(),
    ),
  pickFace: (x: number, y: number) =>
    page.evaluate(
      ([px, py]) =>
        (window as unknown as { __wrenViewport: Probe }).__wrenViewport.pick(
          px as number,
          py as number,
          { kinds: ['face'] },
        ),
      [x, y],
    ),
  toScreen: (p: V3) =>
    page.evaluate(
      (q) => (window as unknown as { __wrenViewport: Probe }).__wrenViewport.worldToScreen(q),
      p,
    ),
});

const nav = (page: Page) => probe(page).nav();
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));

async function canvasBox(page: Page) {
  const box = await page.getByTestId('viewport-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

async function drag(
  page: Page,
  button: Btn,
  from: [number, number],
  to: [number, number],
  opts: { steps?: number; mods?: string[] } = {},
): Promise<void> {
  for (const m of opts.mods ?? []) await page.keyboard.down(m);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button });
  await page.mouse.move(to[0], to[1], { steps: opts.steps ?? 10 });
  await frame(page);
  await page.mouse.up({ button });
  await frame(page);
  for (const m of opts.mods ?? []) await page.keyboard.up(m);
}

async function pose(page: Page) {
  const c = await cameraState(page);
  const f = [0, 1, 2].map((i) => (c.target[i] as number) - (c.position[i] as number));
  const l = Math.hypot(f[0] as number, f[1] as number, f[2] as number);
  return { position: c.position, fwd: f.map((x) => x / l) };
}

/** none / pan (view direction unchanged) / orbit (direction changed). */
function classify(a: Awaited<ReturnType<typeof pose>>, b: Awaited<ReturnType<typeof pose>>) {
  const d = (p: number[], q: number[]) => Math.hypot(...p.map((x, i) => x - (q[i] as number)));
  if (d(a.position, b.position) < 1e-6) return 'none';
  return d(a.fwd, b.fwd) < 1e-6 ? 'pan' : 'orbit';
}

/** A box on screen, centred, with the bounding box of its projected corners. */
async function boxSetup(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  await page.keyboard.press('0'); // isometric
  await cameraStill(page);
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  const corners: V3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z] as V3);
  const pts = await Promise.all(corners.map((c) => toPage(page, c)));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  // Empty canvas to the right of the part (the canvas is narrower than the window: panels flank it).
  const cv = await page.getByTestId('viewport-canvas').boundingBox();
  if (!cv) throw new Error('no canvas');
  const empty = {
    x: Math.max(Math.max(...xs) + 40, cv.x + cv.width - 200),
    y: cv.y + cv.height / 2,
  };
  return {
    b,
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
    empty,
    canvas: cv,
  };
}

const selection = async (page: Page) => (await app(page).ui()).selection.length;

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

test.describe('orbit and pivot', () => {
  test('orbiting from a point on a face keeps it under the cursor (2 px) and shows the marker', async ({
    page,
  }) => {
    const s = await boxSetup(page);
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    await probe(page).pickReady();
    const box = await canvasBox(page);
    const px = cx + 20 - box.x;
    const py = cy + 10 - box.y;
    const hit = (await probe(page).pickFace(px, py))[0];
    expect(hit?.kind).toBe('face');
    const p = hit?.point as V3;

    await page.mouse.move(cx + 20, cy + 10);
    await page.mouse.down({ button: 'right' });
    let worst = 0;
    let marker = false;
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(cx + 20 + i * 9, cy + 10 + Math.sin(i / 3) * 30);
      await frame(page);
      const sc = await probe(page).toScreen(p);
      worst = Math.max(worst, Math.hypot(sc.x - px, sc.y - py));
      marker ||= (await nav(page)).markerVisible;
    }
    const st = await nav(page);
    await page.mouse.up({ button: 'right' });
    expect(st.pivotSource).toBe('surface');
    expect(marker).toBe(true);
    expect(worst).toBeLessThan(2);
    await frame(page);
    expect((await nav(page)).markerVisible).toBe(false);
  });

  test('panning then orbiting never pivots in empty space', async ({ page }) => {
    const s = await boxSetup(page);
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    const box = await canvasBox(page);
    await drag(page, 'middle', [cx, cy], [cx + 250, cy - 60]);
    // Orbit from the background: the pivot is the bodies' centre, in front and on screen.
    await drag(
      page,
      'right',
      [box.x + 40, box.y + box.height - 40],
      [box.x + 70, box.y + box.height - 50],
      {
        steps: 4,
      },
    );
    let st = await nav(page);
    expect(st.pivotSource).toBe('center');
    // Pan the model far off screen: the pivot must still be on screen, never a stale target.
    await drag(page, 'middle', [cx - 300, cy], [cx + 450, cy], { steps: 12 });
    await drag(page, 'right', [cx, cy], [cx + 25, cy + 5], { steps: 4 });
    st = await nav(page);
    expect(st.pivotSource).not.toBe('surface');
    expect(st.pivotScreen).not.toBeNull();
    expect(st.pivotScreen?.x ?? -1).toBeGreaterThanOrEqual(-1);
    expect(st.pivotScreen?.x ?? 1e9).toBeLessThanOrEqual(box.width + 1);
    expect(st.pivotScreen?.y ?? -1).toBeGreaterThanOrEqual(-1);
    expect(st.pivotScreen?.y ?? 1e9).toBeLessThanOrEqual(box.height + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Settings and presets
// ---------------------------------------------------------------------------------------------

async function openSettings(page: Page, tab: 'Navigation' | 'Keyboard' = 'Navigation') {
  await palette(page, tab === 'Navigation' ? 'Settings' : 'Keyboard shortcuts');
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('presets', () => {
  test('the settings panel switches presets, persists them, and the mapping follows', async ({
    page,
  }) => {
    const s = await boxSetup(page);
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    const a = app(page);
    expect((await probe(page).navigation()).preset).toBe('rightOrbit');

    // Default: left never navigates (box select), right orbits, middle pans.
    let p0 = await pose(page);
    await drag(page, 'left', [cx - 300, cy - 200], [cx - 250, cy - 160]);
    expect(classify(p0, await pose(page))).toBe('none');
    await drag(page, 'right', [cx, cy], [cx + 150, cy + 60]);
    let p1 = await pose(page);
    expect(classify(p0, p1)).toBe('orbit');
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40]);
    expect(classify(p1, await pose(page))).toBe('pan');
    // A right click opens the radial menu (and nothing is a modal dialog).
    await page.mouse.click(s.empty.x, s.empty.y, { button: 'right' });
    await expect(page.getByTestId('radial-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('radial-menu')).toBeHidden();

    // Middle button orbits.
    const panel = await openSettings(page);
    await panel.getByRole('radio', { name: /Middle button orbits/ }).check();
    expect((await probe(page).navigation()).preset).toBe('middleOrbit');
    expect(await page.evaluate(() => localStorage.getItem('wren.navigation'))).toContain(
      'middleOrbit',
    );
    await page.getByTestId('settings-close').click();
    p0 = await pose(page);
    await drag(page, 'left', [cx - 300, cy - 200], [cx - 250, cy - 160]);
    expect(classify(p0, await pose(page))).toBe('none');
    await drag(page, 'middle', [cx, cy], [cx + 150, cy + 60]);
    p1 = await pose(page);
    expect(classify(p0, p1)).toBe('orbit');
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40], { mods: ['Control'] });
    const p2 = await pose(page);
    expect(classify(p1, p2)).toBe('pan');
    await drag(page, 'right', [cx, cy], [cx + 100, cy + 40]);
    expect(classify(p2, await pose(page))).toBe('pan');
    await page.mouse.click(s.empty.x, s.empty.y, { button: 'right' });
    await expect(page.getByTestId('radial-menu')).toBeVisible();
    await page.keyboard.press('Escape');

    // It is still the preset after a reload.
    await boot(page);
    expect((await probe(page).navigation()).preset).toBe('middleOrbit');

    // Middle button pans: Shift + middle orbits.
    const panel2 = await openSettings(page);
    await panel2.getByRole('radio', { name: /Middle button pans/ }).check();
    await page.getByTestId('settings-close').click();
    p0 = await pose(page);
    await drag(page, 'middle', [cx, cy], [cx + 100, cy + 40]);
    p1 = await pose(page);
    expect(classify(p0, p1)).toBe('pan');
    await drag(page, 'middle', [cx, cy], [cx + 150, cy + 60], { mods: ['Shift'] });
    expect(classify(p1, await pose(page))).toBe('orbit');
    void a;
  });

  test('right click repeats the last command under "Right click repeats"; hold opens the menu', async ({
    page,
  }) => {
    const s = await boxSetup(page);
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    const a = app(page);
    const panel = await openSettings(page);
    await panel.getByRole('radio', { name: /Right click repeats/ }).check();
    await page.getByTestId('settings-close').click();
    await page.keyboard.press('f'); // fillet: asks for edges
    await expect.poll(async () => (await a.ui()).prompt).toBe('fillet');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await a.ui()).prompt).toBeNull();
    // A quick right click repeats it; no menu.
    await page.mouse.click(s.empty.x, s.empty.y, { button: 'right' });
    await expect.poll(async () => (await a.ui()).prompt).toBe('fillet');
    await expect(page.getByTestId('radial-menu')).toBeHidden();
    await page.keyboard.press('Escape');
    // A held one opens the menu.
    await page.mouse.move(s.empty.x, s.empty.y);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(450);
    await page.mouse.up({ button: 'right' });
    await expect(page.getByTestId('radial-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    // A drag still orbits.
    const p0 = await pose(page);
    await drag(page, 'right', [cx, cy], [cx + 120, cy + 40]);
    expect(classify(p0, await pose(page))).toBe('orbit');
  });

  test('left drag box-selects: left to right = window, right to left = crossing', async ({
    page,
  }) => {
    const s = await boxSetup(page);
    const a = app(page);
    const p0 = await pose(page);
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    // A rectangle over the box's upper-left half.
    const r = { x0: s.min.x - 10, y0: s.min.y - 10, x1: cx + 10, y1: cy + 10 };

    // Window (left to right): only what lies entirely inside.
    await page.mouse.move(r.x0, r.y0);
    await page.mouse.down();
    await page.mouse.move(r.x1, r.y1, { steps: 8 });
    const band = page.getByTestId('box-select');
    await expect(band).toBeVisible();
    await expect(band).toHaveAttribute('data-mode', 'window');
    expect((await a.ui()).box?.mode).toBe('window');
    await page.mouse.up();
    await expect(band).toBeHidden();
    await a.idle();
    const win = await selection(page);

    // Crossing (right to left) over the same rectangle: everything it touches.
    await page.mouse.move(r.x1, r.y1);
    await page.mouse.down();
    await page.mouse.move(r.x0, r.y0, { steps: 8 });
    await expect(band).toHaveAttribute('data-mode', 'crossing');
    // Crossing is dashed.
    expect(await band.evaluate((el) => getComputedStyle(el).borderStyle)).toContain('dashed');
    await page.mouse.up();
    await a.idle();
    const cross = await selection(page);
    expect(cross).toBeGreaterThan(win);
    expect(cross).toBeGreaterThan(0);

    // Shift adds, Ctrl toggles, a plain drag replaces.
    await page.mouse.move(s.max.x - 5, s.max.y - 5);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(s.max.x + 40, s.max.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await a.idle();
    expect(await selection(page)).toBeGreaterThanOrEqual(cross);

    await page.keyboard.down('ControlOrMeta');
    await page.mouse.move(r.x1, r.y1);
    await page.mouse.down();
    await page.mouse.move(r.x0, r.y0, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('ControlOrMeta');
    await a.idle();
    // Toggling what the crossing box touches removes those items.
    expect(await selection(page)).toBeLessThan(cross);

    // A plain drag over nothing replaces the selection with nothing.
    await page.mouse.move(r.x1 + 5, r.y1 + 5);
    await page.mouse.down();
    await page.mouse.move(r.x1 - 5, r.y1 - 5, { steps: 3 });
    await page.mouse.up();
    const cv = await page.getByTestId('viewport-canvas').boundingBox();
    if (!cv) throw new Error('no canvas');
    const ex = cv.x + cv.width - 250;
    const ey = cv.y + 120;
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.mouse.move(ex + 60, ey + 50, { steps: 4 });
    await page.mouse.up();
    await a.idle();
    expect(await selection(page)).toBe(0);
    // None of it moved the camera, and a plain click still picks.
    expect(classify(p0, await pose(page))).toBe('none');
    const face = await toPage(page, [
      s.b.max[0] as number,
      (s.b.max[1] as number) / 2,
      (s.b.max[2] as number) / 2,
    ]);
    await page.mouse.click(face.x, face.y);
    await a.idle();
    expect(await selection(page)).toBe(1);
  });

  test.describe('phone', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      userAgent: devices['iPhone 13'].userAgent,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    test('the phone shell reaches Settings from the command palette', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    await palette(page, 'Settings');
    const panel = page.getByTestId('settings-panel');
    await expect(panel).toBeVisible();
    const b = await panel.boundingBox();
    expect(b?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(390.5);
    await panel.getByRole('radio', { name: /Right click repeats/ }).check();
    expect((await probe(page).navigation()).preset).toBe('rightOrbitRepeat');
    await page.getByTestId('settings-close').click();
    await expect(panel).toBeHidden();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Radial menu
// ---------------------------------------------------------------------------------------------

test.describe('radial menu', () => {
  test('a flick runs its command before the menu draws; Space repeats; a held key opens it', async ({
    page,
  }) => {
    const s = await boxSetup(page);
    const a = app(page);
    // Empty space left of the box, at mid height (below it sits the command bar).
    const { x, y } = s.empty;

    // Right click on empty space, then flick north-east at once: Sketch (first item).
    let ran = false;
    for (let i = 0; i < 6 && !ran; i++) {
      await page.mouse.click(x, y, { button: 'right' });
      // A flick: quick moves toward north-east (the menu mounts during the first of them).
      for (let k = 1; k <= 4; k++) await page.mouse.move(x + k * 16, y - k * 16);
      // Nothing was drawn when the command ran (the draw delay is 250 ms).
      const drawn = (await page.getByTestId('radial-menu').count()) > 0;
      const prompt = (await a.ui()).prompt;
      if (!drawn && prompt === 'sketch') ran = true;
      else {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        await page.mouse.move(x, y);
      }
    }
    expect(ran, 'no flick ran before the menu drew').toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await a.ui()).prompt).toBeNull();

    // Space repeats the last command.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await a.ui()).prompt).toBe('sketch');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await a.ui()).prompt).toBe('sketch');
    await page.keyboard.press('Escape');

    // Once drawn, the menu stays until a click or Enter: moving the mouse is never a command.
    await page.mouse.click(x, y, { button: 'right' });
    const menu = page.getByTestId('radial-menu');
    await expect(menu).toBeVisible();
    // Repeat sits at the fixed north slot and names the last command.
    await expect(menu.locator('[data-slot="n"]')).toHaveAttribute('aria-label', /Repeat.*Sketch/i);
    await page.mouse.move(x + 70, y + 5, { steps: 4 });
    await page.waitForTimeout(100);
    await expect(menu).toBeVisible();
    expect((await a.ui()).prompt).toBeNull();
    await menu.locator('[data-slot="e"]').click(); // Measure
    await expect.poll(async () => (await a.ui()).measure?.active).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await a.ui()).measure?.active ?? false).toBe(false);

    // A face selects first, so the menu offers what fits it.
    const face = await toPage(page, [
      s.b.max[0] as number,
      (s.b.max[1] as number) / 2,
      (s.b.max[2] as number) / 2,
    ]);
    await page.mouse.click(face.x, face.y, { button: 'right' });
    await expect(menu).toBeVisible();
    const items = await menu
      .locator('[data-radial-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-item')));
    expect(items).toEqual(expect.arrayContaining(['sketch', 'pushPull', 'hole']));
    expect(items.length).toBeLessThanOrEqual(9); // seven items and Repeat
    await page.keyboard.press('Escape');
    expect((await app(page).ui()).selection).toEqual(['face']);

    // The held key (Q): opens at the pointer; letting go without a direction cancels it.
    await page.mouse.move(x, y);
    await page.keyboard.down('KeyQ');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-source', 'keyboard');
    await page.keyboard.up('KeyQ');
    await expect(menu).toBeHidden();
  });

  test('a long-press with a finger and with the Pencil opens it', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      hasTouch: true,
      baseURL: test.info().project.use.baseURL as string,
    });
    const page = await ctx.newPage();
    try {
      const s = await boxSetup(page);
      const a = app(page);
      const t = await touch(page);
      const { x, y } = s.empty;
      const menu = page.getByTestId('radial-menu');

      // Finger: hold, the menu draws at once (no blind flick on touch), lift in empty direction.
      await t.down([{ x, y }]);
      await expect(menu).toBeVisible({ timeout: 4000 });
      await expect(menu).toHaveAttribute('data-source', 'touch');
      await t.up();
      await expect(menu).toBeVisible(); // lifted with no direction: stays open for a tap
      await menu.locator('[data-slot="ne"]').tap();
      await expect.poll(async () => (await a.ui()).prompt).toBe('sketch');
      await page.keyboard.press('Escape');

      // Held finger dragged onto an item and lifted selects it.
      await t.down([{ x, y }]);
      await expect(menu).toBeVisible({ timeout: 4000 });
      await t.move([{ x: x + 90, y }]);
      await t.up();
      await expect.poll(async () => (await a.ui()).measure?.active).toBe(true);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      // Pencil: a still press opens it too.
      await t.pen.down({ x, y });
      await expect(menu).toBeVisible({ timeout: 4000 });
      await expect(menu).toHaveAttribute('data-source', 'pen');
      await t.pen.up({ x, y });
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Which one? and Tab
// ---------------------------------------------------------------------------------------------

test('Tab and Shift+Tab cycle overlapping candidates in a stable order', async ({ page }) => {
  const s = await boxSetup(page);
  const a = app(page);
  const corner = await toPage(page, [
    s.b.max[0] as number,
    s.b.max[1] as number,
    s.b.max[2] as number,
  ]);
  const order = async () => {
    await probe(page).pickReady();
    await page.mouse.move(corner.x + 40, corner.y + 40);
    await page.mouse.move(corner.x + 1, corner.y);
    await expect.poll(async () => (await a.ui()).tabOrder.length).toBeGreaterThan(2);
    return (await a.ui()).tabOrder;
  };
  const first = await order();
  // Vertices before edges before faces, as the chooser lists them.
  const kinds = first.map((k) => k.split('|')[1]);
  expect(kinds[0]).toBe('vertex');
  expect(kinds.indexOf('edge')).toBeLessThan(kinds.indexOf('face'));

  // Tab walks the list from the top; Shift+Tab walks back and wraps.
  await page.keyboard.press('Tab');
  expect((await a.ui()).hoverKey).toBe(first[0]);
  await page.keyboard.press('Tab');
  expect((await a.ui()).hoverKey).toBe(first[1]);
  await page.keyboard.press('Shift+Tab');
  expect((await a.ui()).hoverKey).toBe(first[0]);
  await page.keyboard.press('Shift+Tab');
  expect((await a.ui()).hoverKey).toBe(first[first.length - 1]);
  // Enter takes the preselection.
  await page.keyboard.press('Enter');
  await a.idle();
  expect((await a.ui()).selectionKeys).toEqual([first[first.length - 1]]);

  // The same view, the same pointer: the same order on a fresh run of the app.
  await boot(page);
  await page.keyboard.press('0');
  await cameraStill(page);
  const again = await order();
  expect(again).toEqual(first);
});

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

test.describe('keyboard', () => {
  /** A key event as a non-QWERTY layout makes it: the physical `code` stays, `key` follows the layout. */
  const press = (page: Page, code: string, key: string, shiftKey = false) =>
    page.evaluate(
      ([c, k, s]) => {
        for (const type of ['keydown', 'keyup'])
          window.dispatchEvent(
            new KeyboardEvent(type, {
              code: c,
              key: k,
              shiftKey: s,
              bubbles: true,
              cancelable: true,
            }),
          );
      },
      [code, key, shiftKey] as const,
    );

  test('shortcuts fire by physical key under a Dvorak-like layout', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    const a = app(page);
    // Physical S types "o" on Dvorak: the Sketch shortcut, never Hole (which "o" would be on QWERTY).
    await press(page, 'KeyS', 'o');
    await expect.poll(async () => (await a.ui()).prompt).toBe('sketch');
    await page.keyboard.press('Escape');
    // Physical E types "." and F types "u": Extrude and Fillet by position.
    await press(page, 'KeyE', '.');
    await expect.poll(async () => (await a.ui()).prompt).toBe('extrude');
    await page.keyboard.press('Escape');
    await press(page, 'KeyF', 'u');
    await expect.poll(async () => (await a.ui()).prompt).toBe('fillet');
    await page.keyboard.press('Escape');
    // AZERTY's digit row types symbols: Digit1 is still the front view.
    await press(page, 'Digit1', '&');
    await cameraStill(page);
    const c = await cameraState(page);
    expect(Math.abs((c.position[1] as number) - (c.target[1] as number))).toBeGreaterThan(
      Math.abs((c.position[2] as number) - (c.target[2] as number)) * 5,
    );
    // In a sketch: physical L is Line (types "p" on Dvorak).
    await press(page, 'KeyS', 'o');
    await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).click();
    await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
    await press(page, 'KeyL', 'p');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('line');
    await press(page, 'KeyC', 'j', true); // Shift + physical C: circle
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('circle');
  });

  test('the keymap editor flags Ctrl+W and Ctrl+T as browser shortcuts, and rebinding works', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // A Dvorak layout map: the editor labels physical keys with what they type.
      Object.defineProperty(navigator, 'keyboard', {
        configurable: true,
        value: { getLayoutMap: async () => new Map([['KeyS', 'o']]) },
      });
    });
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    const panel = await openSettings(page, 'Keyboard');
    const editor = panel.getByTestId('keymap-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel('Sketch bindings', { exact: true })).toContainText('O');

    for (const chord of ['Control+KeyW', 'Control+KeyT']) {
      await editor.getByRole('button', { name: 'Add shortcut for Extrude', exact: true }).click();
      await page.keyboard.press(chord);
      const note = editor.getByTestId('keymap-conflict');
      await expect(note).toBeVisible();
      await expect(note).toHaveAttribute('data-severity', 'blocked');
      await expect(note).toContainText('browser shortcut');
      await note.getByRole('button', { name: 'Cancel' }).click();
    }

    // A free key rebinds: Extrude to J, which then works and persists.
    await editor.getByRole('button', { name: 'Add shortcut for Extrude', exact: true }).click();
    await page.keyboard.press('KeyJ');
    await expect(editor.getByTestId('keymap-conflict')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('wren.keymap'))).toContain('KeyJ');
    await page.getByTestId('settings-close').click();
    await press(page, 'KeyJ', 'j');
    await expect.poll(async () => (await app(page).ui()).prompt).toBe('extrude');
    await boot(page); // survives a reload
    await press(page, 'KeyJ', 'j');
    await expect.poll(async () => (await app(page).ui()).prompt).toBe('extrude');
  });

  test('holding Ctrl for 600 ms shows the shortcuts available now', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    const overlay = page.getByTestId('shortcut-overlay');
    await expect(overlay).toBeHidden();
    await page.keyboard.down('Control');
    await page.waitForTimeout(300);
    await expect(overlay).toBeHidden();
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await expect(overlay).toContainText('Extrude');
    await page.keyboard.up('Control');
    await expect(overlay).toBeHidden();
    // A chord (Ctrl+K) is not a hold.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.waitForTimeout(800);
    await expect(overlay).toBeHidden();
    await page.keyboard.up('Control');
  });
});

// ---------------------------------------------------------------------------------------------
// Errors at their cause
// ---------------------------------------------------------------------------------------------

const S1 = fid('CS1');
const E1 = fid('CE1');
const S2 = fid('CS2');
const E2 = fid('CE2');
const FI = fid('CFI');
const FP = fid('CFP');
const face = (name: string): EntityRef => ({ name, kind: 'face' });

/** Plate (thickness `t`), a pocket cut `pd` deep, a fillet on the pocket floor, a fillet on the plate. */
function causeDoc(): WrenDoc {
  const plate = new Sk();
  const r = plate.rect('p', 'L', 0, 0, 80, 50, '80 mm', '50 mm');
  plate.geo({ kind: 'fix', entity: r.a });
  const pocket = new Sk();
  pocket.point('o', 0, 0, true);
  pocket.geo({ kind: 'fix', entity: 'o' });
  const q = pocket.rect('q', 'M', 30, 20, 50, 30, '20 mm', '10 mm');
  pocket.dim({ kind: 'hDistance', a: 'o', b: q.a }, 'px');
  pocket.dim({ kind: 'vDistance', a: 'o', b: q.a }, '20 mm');
  const top = `F${E1}:end`;
  const floorFront: EntityRef = {
    name: edgeName(`F${E2}:end`, side(E2, S2, 'M1')),
    kind: 'edge',
  };
  const plateFront: EntityRef = { name: edgeName(top, side(E1, S1, 'L1')), kind: 'edge' };
  return docWith('Cause plate', { t: '10 mm', pd: '6 mm', px: '30 mm' }, [
    plate.feature(S1, 'Plate sketch'),
    extrude(E1, 'Plate', [region(S1, 'L1,L2,L3,L4')], 't'),
    pocket.feature(S2, 'Pocket profile', face(top)),
    extrude(E2, 'Pocket cut', [region(S2, 'M1,M2,M3,M4')], 'pd', 'cut', 'reverse'),
    {
      id: FI,
      type: 'fillet',
      name: 'Floor fillet',
      suppressed: false,
      edges: [floorFront],
      radius: '1',
    },
    {
      id: FP,
      type: 'fillet',
      name: 'Plate fillet',
      suppressed: false,
      edges: [plateFront],
      radius: '1',
    },
  ]);
}

async function loadCause(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  const a = app(page);
  await a.load(causeDoc());
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(Array(6).fill('ok'));
  return a;
}

test.describe('errors at their cause', () => {
  test('shortening the extrude names it; selecting the message selects the extrude', async ({
    page,
  }) => {
    test.slow();
    const a = await loadCause(page);
    await page.getByRole('tab', { name: 'Params' }).click();
    const t = page.getByRole('textbox', { name: 'Expression for t' });
    await t.fill('4 mm'); // the 6 mm pocket now goes through: its floor and the floor edge are gone
    await t.press('Enter');
    await a.idle();
    const r = await a.regen();
    expect(r?.features.map((f) => f.state)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'needsAttention',
      'blocked',
    ]);

    await page.getByRole('tab', { name: 'Features' }).click();
    const tree = page.getByTestId('feature-tree');
    const row = tree.getByRole('treeitem', { name: /Floor fillet/ });
    await expect(row).toContainText('Floor fillet lost its edge because Plate changed');
    await expect(row).toContainText('depth 10 mm → 4 mm');
    // The blocked fillet waits on the one that needs attention (the root cause), by name.
    await expect(tree.getByRole('treeitem', { name: /Plate fillet/ })).toContainText(
      'Plate fillet is waiting because Floor fillet failed',
    );

    // Selecting the message in the tree selects the extrude...
    await row.locator('[data-cause-feature]').click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(E1);
    // ...and so does the inspector's, from the fillet.
    await row.click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(FI);
    const alert = page.getByTestId('feature-inspector').getByRole('alert');
    await expect(alert).toContainText('Floor fillet lost its edge because Plate changed');
    await alert.getByRole('button', { name: 'Select Plate' }).click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(E1);
    await expect(page.getByTestId('feature-inspector')).toContainText('Plate');
  });

  test('a deleted cause says so and offers Undo', async ({ page }) => {
    test.slow();
    const a = await loadCause(page);
    // Delete the pocket extrude: the floor fillet loses its edge.
    const tree = page.getByTestId('feature-tree');
    const partId = (await a.doc()).parts[0]?.id ?? '';
    await a.apply({ kind: 'removeFeature', partId, featureId: E2 }, 'Delete Pocket cut');
    await a.idle();
    expect((await a.regen())?.features.find((f) => f.id === FI)?.state).toBe('needsAttention');
    await tree.getByRole('treeitem', { name: /Floor fillet/ }).click();
    const alert = page.getByTestId('feature-inspector').getByRole('alert');
    await expect(alert).toContainText('Pocket cut was deleted');
    await expect(alert.getByRole('button', { name: /^Select/ })).toHaveCount(0);
    await alert.getByTestId('undo-cause').click();
    await a.idle();
    expect((await a.regen())?.features.map((f) => f.state)).toEqual(Array(6).fill('ok'));
  });

  test('without a cause the existing text stays', async ({ page }) => {
    test.slow();
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    const a = app(page);
    // A fillet whose edge was never there: nothing upstream to blame.
    const doc = causeDoc();
    const part = doc.parts[0];
    const fi = part?.features.find((f) => f.id === FI);
    if (!part || fi?.type !== 'fillet') throw new Error('no fillet');
    fi.edges = [{ name: `edge(F${E1}:end|F${E1}:side(S${S1}:e(nope)))`, kind: 'edge' }];
    await a.load(doc);
    await a.idle();
    await page
      .getByTestId('feature-tree')
      .getByRole('treeitem', { name: /Floor fillet/ })
      .click();
    const alert = page.getByTestId('feature-inspector').getByRole('alert');
    await expect(alert).toContainText('needs your attention');
    await expect(alert.getByTestId('attention-cause')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------------------------

test.describe('lineage', () => {
  test('a selected face says which feature made it; Edit opens the feature and its sketch', async ({
    page,
  }) => {
    test.slow();
    const a = await loadCause(page);
    await page.keyboard.press('0');
    await cameraStill(page);
    await probe(page).pickReady();
    const top = await toPage(page, [10, 10, 10]); // the plate's top face, clear of the pocket
    await page.mouse.click(top.x, top.y);
    await a.idle();
    const lineage = page.getByTestId('selection-lineage');
    await expect(lineage).toBeVisible();
    await expect(lineage.locator('[data-lineage="feature"]')).toContainText('Plate');
    await expect(lineage.locator('[data-lineage="sketch"]')).toContainText('Plate sketch');
    // Edit on the feature opens it in the inspector.
    await lineage.locator('[data-lineage="feature"]').getByRole('button', { name: /Edit/ }).click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(E1);
    // Edit on the sketch enters it.
    await page.mouse.click(top.x, top.y);
    await a.idle();
    await page
      .getByTestId('selection-lineage')
      .locator('[data-lineage="sketch"]')
      .getByRole('button', { name: /Edit/ })
      .click();
    await expect.poll(async () => (await a.ui()).sketch?.featureId).toBe(S1);
  });

  test('selecting a feature in the tree shows its parents and children', async ({ page }) => {
    test.slow();
    const a = await loadCause(page);
    const tree = page.getByTestId('feature-tree');
    await tree.getByRole('treeitem', { name: /Pocket cut/ }).click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(E2);
    const lin = page.getByTestId('feature-lineage');
    await expect(lin.locator('[data-lineage-group="parents"]')).toContainText('Pocket profile');
    await expect(lin.locator('[data-lineage-group="children"]')).toContainText('Floor fillet');
    // The tree marks them.
    await expect(tree.locator(`[data-lineage="parent"]`)).toContainText('Pocket profile');
    await expect(tree.locator(`[data-lineage="child"]`)).toContainText('Floor fillet');
    // A chip selects that feature.
    await lin
      .locator('[data-lineage-group="children"]')
      .getByRole('button', { name: 'Floor fillet' })
      .click();
    await expect.poll(async () => (await a.ui()).featureId).toBe(FI);
  });
});

// ---------------------------------------------------------------------------------------------
// Sketch: conflicts, curves, dimensions
// ---------------------------------------------------------------------------------------------

async function sketchOf(page: Page, index = 0): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features.filter((x) => x.type === 'sketch')[index];
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}

async function newSketch(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
}

test.describe('sketch', () => {
  test('an over-constrained sketch highlights the set and proposes removing the last constraint', async ({
    page,
  }) => {
    test.slow();
    await newSketch(page);
    const a = app(page);
    for (const [x, y] of [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
      [0, 0],
    ] as const)
      await clickAt(page, x, y);
    await expect.poll(async () => (await a.sketch())?.dof).toBe(2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await clickAt(page, 40, 15);
    await clickAt(page, 48, 15);
    const editor = page.getByTestId('dimension-editor').getByRole('textbox');
    await expect(editor).toBeFocused();
    await editor.press('Enter');
    await a.settled();
    await clickAt(page, 0, 15);
    await clickAt(page, -8, 15);
    await expect(editor).toBeFocused();
    await editor.fill('35');
    await editor.press('Enter');
    const panel = page.getByTestId('conflict-panel');
    await expect(panel).toBeVisible();

    // Named, never numbered: geometry and constraints read as "Line 2", not as ids.
    const card = panel.getByTestId('conflict-card').first();
    await expect(card).toContainText(/Line \d/);
    expect(await panel.textContent()).not.toMatch(/\b[0-9A-HJKMNP-TV-Z]{20,}\b|\bk\d+\b|\bd\d+\b/);
    // The first fix is the suggestion: removing the most recently added constraint of the set.
    await expect(card.getByText('Suggested')).toBeVisible();
    const conflicts = (await a.sketch())?.conflicts as {
      constraints: string[];
      entities?: string[];
      fixes: { action: { kind: string; constraint: string } }[];
    }[];
    const c = conflicts[0];
    expect(c?.fixes[0]?.action.kind).toBe('removeConstraint');
    const f = await sketchOf(page);
    const order = f.constraints.map((k) => k.id).filter((id) => c?.constraints.includes(id));
    expect(c?.fixes[0]?.action.constraint).toBe(order[order.length - 1]);
    // Hovering the card highlights the set on the canvas.
    await card.hover();
    await expect
      .poll(
        async () =>
          ((await a.ui()).sketch as { highlightEntities?: string[] } | null)?.highlightEntities
            ?.length ?? 0,
      )
      .toBeGreaterThan(0);
    await expect.poll(async () => (await a.ui()).sketch?.highlight?.length ?? 0).toBeGreaterThan(0);
    await card.getByRole('button').first().click();
    await expect(panel).toBeHidden();
    await expect.poll(async () => (await a.sketch())?.status).toBe('solved');
  });

  test('a spline through 5 points, closed with a line, extrudes; moving a through point updates the solid', async ({
    page,
  }) => {
    test.slow();
    await newSketch(page);
    const a = app(page);
    await page.keyboard.press('Shift+B'); // spline through points
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('splineThrough');
    const pts: [number, number][] = [
      [0, 0],
      [10, 14],
      [20, 6],
      [30, 15],
      [40, 0],
    ];
    for (const [x, y] of pts) await clickAt(page, x, y);
    // A preview follows the pointer while drawing.
    const p = await toPage(page, [45, 10, 0]);
    await page.mouse.move(p.x, p.y);
    await page.keyboard.press('Enter'); // end the spline (open)
    await a.settled();
    let sk = await sketchOf(page);
    const spline = sk.entities.find((e) => e.kind === 'bspline');
    expect(spline?.kind).toBe('bspline');
    if (spline?.kind !== 'bspline') throw new Error('no spline');
    expect(spline.through?.length).toBe(3); // the inner through points

    // Close it with a line between its end points.
    await page.keyboard.press('l');
    await clickAt(page, 40, 0);
    await clickAt(page, 0, 0);
    await a.settled();
    await page.keyboard.press('Escape'); // leave the line tool (a second Esc would finish the sketch)
    sk = await sketchOf(page);
    expect(sk.entities.some((e) => e.kind === 'line')).toBe(true);
    await page.getByTestId('finish-sketch').click();
    await page.keyboard.press('e');
    await a.idle();
    await clickAt(page, 20, 3); // inside the loop, under the spline
    const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
    await depth.fill('10');
    await depth.press('Enter');
    await a.idle();
    const v0 = (await a.regen())?.bodies[0]?.volume ?? 0;
    expect(v0).toBeGreaterThan(1000);

    // Moving a through point reshapes the curve and the solid follows.
    await page
      .getByTestId('feature-tree')
      .getByRole('treeitem', { name: /Sketch/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Edit sketch' }).click();
    await expect.poll(async () => (await a.ui()).sketch?.featureId).toBeTruthy();
    await cameraStill(page);
    const mid = (await sketchOf(page)).entities.find(
      (e) => e.kind === 'point' && Math.abs(e.x - 20) < 1e-3 && Math.abs(e.y - 6) < 1e-3,
    );
    expect(mid).toBeTruthy();
    const from = await toPage(page, [20, 6, 0]);
    const to = await toPage(page, [20, 16, 0]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await a.settled();
    await page.getByTestId('finish-sketch').click();
    await a.idle();
    const v1 = (await a.regen())?.bodies[0]?.volume ?? 0;
    expect(v1).toBeGreaterThan(v0 * 1.05);
  });

  test('ellipse, elliptic arc and control-point spline tools draw, with previews and a double-click finish', async ({
    page,
  }) => {
    test.slow();
    await newSketch(page);
    const a = app(page);
    // Ellipse: centre, axis end, then a point fixing the minor radius.
    await page.keyboard.press('Shift+E');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('ellipse');
    await clickAt(page, 0, 0);
    await clickAt(page, 30, 0);
    await clickAt(page, 30, 12);
    await a.settled();
    let sk = await sketchOf(page);
    const ell = sk.entities.find((e) => e.kind === 'ellipse');
    expect(ell?.kind === 'ellipse' && ell.majorRadius).toBeCloseTo(30, 1);
    expect(ell?.kind === 'ellipse' && ell.minorRadius).toBeCloseTo(12, 1);

    // Elliptic arc: centre, axis, minor, start, end.
    await page.keyboard.press('Shift+A');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('ellipticArc');
    for (const [x, y] of [
      [0, 60],
      [25, 60],
      [25, 72],
      [25, 60],
      [0, 72],
    ] as const)
      await clickAt(page, x, y);
    await a.settled();
    sk = await sketchOf(page);
    expect(sk.entities.some((e) => e.kind === 'ellipticArc')).toBe(true);

    // Control-point spline: taps, then a double-click ends it.
    await page.keyboard.press('b');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('splineControl');
    for (const [x, y] of [
      [-40, 0],
      [-30, 20],
      [-20, -10],
    ] as const)
      await clickAt(page, x, y);
    const last = await toPage(page, [-10, 12, 0]);
    await page.mouse.dblclick(last.x, last.y);
    await a.settled();
    sk = await sketchOf(page);
    const bs = sk.entities.filter((e) => e.kind === 'bspline');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.kind === 'bspline' && bs[0].poles.length).toBe(4);
    expect(bs[0]?.kind === 'bspline' && bs[0].periodic).toBe(false);

    // Closing by tapping the first point makes it periodic.
    await page.keyboard.press('Shift+B');
    for (const [x, y] of [
      [-40, 40],
      [-20, 40],
      [-20, 60],
      [-40, 60],
      [-40, 40],
    ] as const)
      await clickAt(page, x, y);
    await a.settled();
    sk = await sketchOf(page);
    expect(sk.entities.filter((e) => e.kind === 'bspline' && e.periodic)).toHaveLength(1);
  });

  test('a dimension label drags without changing its value; extension and dimension lines show', async ({
    page,
  }) => {
    test.slow();
    await newSketch(page);
    const a = app(page);
    await page.keyboard.press('Shift+C'); // circle: a radius/diameter leader
    await clickAt(page, 0, 0);
    await clickAt(page, 15, 0);
    await a.settled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
    await clickAt(page, 30, 10);
    await clickAt(page, 60, 10);
    await a.settled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await clickAt(page, 45, 10); // the line
    await clickAt(page, 45, 22); // label above: a length
    const editor = page.getByTestId('dimension-editor').getByRole('textbox');
    await expect(editor).toBeFocused();
    await editor.fill('30');
    await editor.press('Enter');
    await a.settled();
    await page.keyboard.press('Escape');

    const dimOf = async () => {
      const f = await sketchOf(page);
      const d = f.constraints.find(
        (c): c is DimensionConstraint => 'value' in c && c.kind === 'length',
      );
      if (!d) throw new Error('no dimension');
      return d;
    };
    const before = await dimOf();
    const label = page.locator('button[data-draggable]').first();
    await expect(label).toBeVisible();
    // Extension lines and a dimension line with arrows are drawn: several strokes plus arrowheads.
    const svg = page.getByTestId('dimension-annotation').first();
    await expect(svg).toBeVisible();
    const d = (await svg.locator('path').first().getAttribute('d')) ?? '';
    expect((d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(await svg.locator('path[fill="currentColor"]').count()).toBeGreaterThanOrEqual(2);

    // Drag the label up: the position moves live, the value does not.
    const lb = await label.boundingBox();
    if (!lb) throw new Error('no label');
    const sx = lb.x + lb.width / 2;
    const sy = lb.y + lb.height / 2;
    const undoDepth = (await a.history()).past.length;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy - 40, { steps: 6 });
    await page.mouse.move(sx + 20, sy - 80, { steps: 6 });
    expect((await app(page).ui()).sketch?.editDimension ?? null).toBeNull();
    await page.mouse.up();
    await a.settled();
    const after = await dimOf();
    expect(after.value).toBe(before.value);
    expect(after.label).toBeTruthy();
    expect(after.label?.[1]).toBeGreaterThan((before.label?.[1] ?? 22) + 1);
    const h = await a.history();
    expect(h.past.length).toBe(undoDepth + 1); // one undo step
    expect(h.past[h.past.length - 1]?.label).toBe('Move dimension');
    // The measured geometry is untouched: the line is still 30 mm.
    expect((await a.sketch())?.status).toBe('solved');
    await page.keyboard.press('ControlOrMeta+z');
    await a.settled();
    expect((await dimOf()).label?.[1]).toBeCloseTo(before.label?.[1] ?? 22, 6);
  });
});
