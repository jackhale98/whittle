import { devices, expect, type Locator, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraStill, palette, touch, touchStats } from './helpers';
import { expectTouchTarget } from './targets';

/**
 * Section view fixes (owner, 2026-11-10): the persistent Exit / Flip / Edit chip, Esc, and the
 * rotatable cut plane (tilt fields that take angles with units, and the in-viewport manipulator:
 * an offset arrow and two rotation arcs). The plane is checked through the viewport probe
 * (`sectionNormal`, `sectionOffset`, `capsDrawn`), not by pixels. Desktop (mouse + keyboard),
 * tablet and phone (touch).
 */

const D = Math.PI / 180;

type V3 = [number, number, number];

/** The tilted base-Z normal: (sin b, -cos b sin a, cos b cos a), a about X, b about Y. */
const normalZ = (a: number, b: number): V3 => [
  Math.sin(b),
  -Math.cos(b) * Math.sin(a),
  Math.cos(b) * Math.cos(a),
];

const chip = (page: Page) => page.getByTestId('section-chip');
const panel = (page: Page) => page.getByTestId('section-panel');

const probe = (page: Page) => touchStats(page);

async function expectPlane(page: Page, tiltU: number, tiltV: number) {
  const n = normalZ(tiltU, tiltV);
  await expect
    .poll(async () => {
      const p = (await probe(page)).sectionNormal;
      return p ? Math.hypot(p[0] - n[0], p[1] - n[1], p[2] - n[2]) : 9;
    })
    .toBeLessThan(1e-6);
  expect((await probe(page)).capsDrawn).toBeGreaterThan(0); // the cut is capped
}

/** Types an angle expression into a tilt field of the panel. */
async function typeTilt(page: Page, which: 'u' | 'v', text: string) {
  const field = panel(page).getByTestId(`section-tilt-${which}`).getByRole('textbox');
  await field.fill(text);
  await field.press('Enter');
}

/** No overlap between two boxes. */
async function apart(a: Locator, b: Locator, what: string) {
  if ((await b.count()) === 0) return; // not in this shell
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  if (!(x && y)) return;
  const overlap =
    x.x < y.x + y.width && x.x + x.width > y.x && x.y < y.y + y.height && x.y + x.height > y.y;
  expect(overlap, `chip overlaps ${what}`).toBe(false);
}

/** The chip clears the view cube, the top bar and the sheet (when there is one). */
async function chipIsClear(page: Page) {
  const c = chip(page);
  await expect(c).toBeVisible();
  await apart(c, page.locator('[aria-label="View cube"]'), 'the view cube');
  await apart(c, page.getByTestId('top-bar'), 'the top bar');
  await apart(c, page.getByTestId('tools-sheet'), 'the sheet');
  await apart(c, page.getByTestId('library-button'), 'the Library button');
  const box = await c.boundingBox();
  const vp = page.viewportSize();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(vp?.width ?? 0);
  for (const name of ['Flip', 'Edit', 'Exit section']) {
    // Full labels, nothing truncated.
    const b = c.getByRole('button', { name });
    const clipped = await b.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, `${name} is clipped`).toBe(false);
  }
}

async function boxScene(page: Page, tap = false) {
  await boot(page);
  const close = page.getByRole('button', { name: 'Close welcome' });
  await (tap ? close.tap() : close.click());
  await addBox(page);
  await app(page).idle();
  if (tap) await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  else await page.keyboard.press('Escape');
  await cameraStill(page);
}

/** Canvas-relative to page coordinates. */
async function pagePoint(page: Page, p: { x: number; y: number }) {
  const b = await page.getByTestId('viewport-canvas').boundingBox();
  if (!b) throw new Error('no canvas');
  return { x: b.x + p.x, y: b.y + p.y };
}

test('desktop: chip, Edit, typed angles, arc and arrow drags, Shift snap, Esc and Exit', async ({
  page,
}) => {
  test.slow();
  await boxScene(page);
  const a = app(page);
  await expect(chip(page)).toHaveCount(0);

  await palette(page, 'Section view');
  await panel(page).getByRole('switch', { name: 'Section view' }).click();
  await expect.poll(async () => (await probe(page)).sectionActive).toBe(true);
  await expect(chip(page)).toBeVisible();
  await chipIsClear(page);
  await expectPlane(page, 0, 0);
  const bb = (await a.regen())?.bodies[0]?.bbox;
  const centre: V3 = [
    ((bb?.min[0] ?? 0) + (bb?.max[0] ?? 0)) / 2,
    ((bb?.min[1] ?? 0) + (bb?.max[1] ?? 0)) / 2,
    ((bb?.min[2] ?? 0) + (bb?.max[2] ?? 0)) / 2,
  ];
  // Mid-part at zero tilt: z = centre z, so n . p = centre z.
  expect((await probe(page)).sectionOffset ?? 0).toBeCloseTo(centre[2], 5);

  // Closing the panel (Edit toggles it) leaves the cut and the chip.
  await chip(page).getByRole('button', { name: 'Edit' }).click();
  await expect(panel(page)).toHaveCount(0);
  expect((await a.ui()).section.open).toBe(false);
  await expect(chip(page)).toBeVisible();
  expect((await probe(page)).sectionActive).toBe(true);
  await chip(page).getByRole('button', { name: 'Edit' }).click();
  await expect(panel(page)).toBeVisible();

  // Flip from the chip reverses the normal.
  await chip(page).getByRole('button', { name: 'Flip' }).click();
  await expect.poll(async () => (await probe(page)).sectionNormal?.[2]).toBeCloseTo(-1, 6);
  await chip(page).getByRole('button', { name: 'Flip' }).click();
  await expectPlane(page, 0, 0);

  // Typed angles (units accepted): the plane normal and the offset follow.
  await typeTilt(page, 'u', '30deg');
  await expect.poll(async () => (await a.ui()).section.tiltU).toBeCloseTo(30 * D, 9);
  await expectPlane(page, 30 * D, 0);
  const n30 = normalZ(30 * D, 0);
  const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  // Offset (centre z) along the tilted normal through the centre: n . p = n . centre.
  expect((await probe(page)).sectionOffset ?? 0).toBeCloseTo(dot(n30, centre), 5);
  await typeTilt(page, 'v', '0.2rad');
  await expect.poll(async () => (await a.ui()).section.tiltV).toBeCloseTo(0.2, 9);
  await expectPlane(page, 30 * D, 0.2);
  await typeTilt(page, 'v', '0');
  await typeTilt(page, 'u', '0');
  await expectPlane(page, 0, 0);

  // The manipulator: drag the arc about X along its screen tangent; the plane tilts with it.
  const grips = await a.sectionGrips();
  const arc = grips?.['sec:arc-u'];
  if (!arc) throw new Error('no manipulator');
  const from = await pagePoint(page, arc);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + arc.dx * 20, from.y + arc.dy * 20, { steps: 4 });
  await page.mouse.move(from.x + arc.dx * 60, from.y + arc.dy * 60, { steps: 6 });
  await page.mouse.up();
  await a.idle();
  const u1 = (await a.ui()).section.tiltU;
  expect(u1).toBeGreaterThan(0.2);
  expect((await a.ui()).section.tiltV).toBeCloseTo(0, 9);
  await expectPlane(page, u1, 0);
  await expect(panel(page).getByTestId('section-tilt-u').getByRole('textbox')).not.toHaveValue(
    '0deg',
  );

  // Shift snaps both angles to 15 degree steps.
  const grips2 = await a.sectionGrips();
  const arc2 = grips2?.['sec:arc-u'];
  if (!arc2) throw new Error('no manipulator');
  const f2 = await pagePoint(page, arc2);
  await page.keyboard.down('Shift');
  await page.mouse.move(f2.x, f2.y);
  await page.mouse.down();
  await page.mouse.move(f2.x + arc2.dx * 17, f2.y + arc2.dy * 17, { steps: 4 });
  await page.mouse.move(f2.x + arc2.dx * 31, f2.y + arc2.dy * 31, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await a.idle();
  const u2 = (await a.ui()).section.tiltU / D;
  expect(Math.abs(u2 / 15 - Math.round(u2 / 15))).toBeLessThan(1e-6);
  await expectPlane(page, (await a.ui()).section.tiltU, (await a.ui()).section.tiltV);

  // The second arc tilts about the other in-plane axis.
  const arcV = (await a.sectionGrips())?.['sec:arc-v'];
  if (!arcV) throw new Error('no second arc');
  const fv = await pagePoint(page, arcV);
  await page.mouse.move(fv.x, fv.y);
  await page.mouse.down();
  await page.mouse.move(fv.x + arcV.dx * 20, fv.y + arcV.dy * 20, { steps: 4 });
  await page.mouse.move(fv.x + arcV.dx * 50, fv.y + arcV.dy * 50, { steps: 5 });
  await page.mouse.up();
  await a.idle();
  const s2 = (await a.ui()).section;
  expect(Math.abs(s2.tiltV)).toBeGreaterThan(0.1);
  await expectPlane(page, s2.tiltU, s2.tiltV);

  // The offset arrow moves the plane along its (tilted) normal.
  const before = (await a.ui()).section.offset;
  const arrow = (await a.sectionGrips())?.['sec:offset'];
  if (!arrow) throw new Error('no offset arrow');
  const fo = await pagePoint(page, arrow);
  await page.mouse.move(fo.x, fo.y);
  await page.mouse.down();
  await page.mouse.move(fo.x + arrow.dx * 15, fo.y + arrow.dy * 15, { steps: 4 });
  await page.mouse.move(fo.x + arrow.dx * 30, fo.y + arrow.dy * 30, { steps: 4 });
  await page.mouse.up();
  await a.idle();
  expect(Math.abs((await a.ui()).section.offset - before)).toBeGreaterThan(0.5);
  await expectPlane(page, s2.tiltU, s2.tiltV);

  // Esc: the panel first, then the section itself.
  await page.keyboard.press('Escape');
  expect((await a.ui()).section.open).toBe(false);
  await expect(chip(page)).toBeVisible();
  expect((await probe(page)).sectionActive).toBe(true);
  await page.keyboard.press('Escape');
  await expect(chip(page)).toHaveCount(0);
  await expect.poll(async () => (await probe(page)).sectionActive).toBe(false);
  expect((await a.ui()).section.enabled).toBe(false);
  expect(await a.sectionGrips()).toBeNull();
  expect((await probe(page)).capsDrawn).toBe(0);

  // Again, and out through the chip's button.
  await palette(page, 'Section view');
  await panel(page).getByRole('switch', { name: 'Section view' }).click();
  await expect(chip(page)).toBeVisible();
  expect((await a.ui()).section.tiltU).toBe(0); // a new section starts level
  await chip(page).getByRole('button', { name: 'Exit section' }).click();
  await expect(chip(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => (await probe(page)).sectionActive).toBe(false);
});

test.describe('tablet', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });

  test('tablet: chip with 44 px targets, typed angle, finger drag of an arc, Exit', async ({
    page,
  }) => {
    test.slow();
    await boxScene(page, true);
    const a = app(page);
    await palette(page, 'Section view');
    await panel(page).getByRole('switch', { name: 'Section view' }).tap();
    await expect.poll(async () => (await probe(page)).sectionActive).toBe(true);
    await chipIsClear(page);
    for (const name of ['Flip', 'Edit', 'Exit section'])
      await expectTouchTarget(chip(page).getByRole('button', { name }), name);

    await typeTilt(page, 'u', '20deg');
    await expectPlane(page, 20 * D, 0);

    // Edit closes the panel; the chip stays.
    await chip(page).getByRole('button', { name: 'Edit' }).tap();
    await expect(panel(page)).toHaveCount(0);
    await expect(chip(page)).toBeVisible();

    // A finger on the arc rotates the plane.
    const arc = (await a.sectionGrips())?.['sec:arc-v'];
    if (!arc) throw new Error('no manipulator');
    const from = await pagePoint(page, arc);
    const t = await touch(page);
    await t.drag(from, { x: from.x + arc.dx * 50, y: from.y + arc.dy * 50 }, 10);
    await a.idle();
    const s = (await a.ui()).section;
    expect(s.tiltU).toBeCloseTo(20 * D, 6);
    expect(Math.abs(s.tiltV)).toBeGreaterThan(0.1);
    await expectPlane(page, s.tiltU, s.tiltV);

    await chip(page).getByRole('button', { name: 'Exit section' }).tap();
    await expect(chip(page)).toHaveCount(0);
    await expect.poll(async () => (await probe(page)).sectionActive).toBe(false);
  });
});

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test('phone: chip above the sheet, typed angle in the sheet, Edit, Exit', async ({ page }) => {
    test.slow();
    await boot(page);
    const a = app(page);
    await page.getByTestId('open-demo').tap();
    await expect.poll(async () => (await a.doc()).parts[0]?.features.length).toBeGreaterThan(0);
    await a.idle();
    await page
      .getByRole('group', { name: 'Viewer tools' })
      .getByRole('button', { name: 'Section' })
      .tap();
    await panel(page).getByRole('switch', { name: 'Section view' }).tap();
    await expect.poll(async () => (await probe(page)).sectionActive).toBe(true);
    await chipIsClear(page);
    for (const name of ['Flip', 'Edit', 'Exit section'])
      await expectTouchTarget(chip(page).getByRole('button', { name }), name);

    await typeTilt(page, 'v', '15deg');
    await expect.poll(async () => (await a.ui()).section.tiltV).toBeCloseTo(15 * D, 9);
    await expectPlane(page, 0, 15 * D);
    await chipIsClear(page);

    await chip(page).getByRole('button', { name: 'Flip' }).tap();
    await expect.poll(async () => (await a.ui()).section.flipped).toBe(true);
    await chip(page).getByRole('button', { name: 'Exit section' }).tap();
    await expect(chip(page)).toHaveCount(0);
    await expect.poll(async () => (await probe(page)).sectionActive).toBe(false);
    expect((await a.ui()).section.open).toBe(false);
  });
});
