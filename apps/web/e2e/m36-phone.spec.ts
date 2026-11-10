import { devices, expect, type Page, test } from '@playwright/test';
import { app, boot, touch } from './helpers';

/**
 * M3.6 acceptance, phone: the Features tab is the feature tree (as on the tablet) with a rollback
 * bar the finger can drag. Dragging it writes a real, undoable `setRollback` (asserted on the
 * regen result: bodies, volume, face count); a long press on a row opens its menu, and Suppress
 * there is one undoable edit. (ADR-068 amendment: the step-through preview mode is gone.)
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

/** The demo bracket's dimensions (src/samples/bracket.ts `BRACKET_PARAMS`), in mm. */
const DIM: Record<string, number> = {
  width: 80,
  depth: 50,
  thickness: 8,
  hole_d: 6,
  height: 40,
  corner_r: 5,
  bend_r: 3,
  chamfer_d: 2,
};
const num = (key: string) => DIM[key] ?? 0;

/** Analytic volume of the finished bracket (src/samples/bracket.ts `demoBracketVolume`). */
function bracketVolume(): number {
  const k = 1 - Math.PI / 4;
  return (
    num('width') * num('depth') * num('thickness') -
    4 * Math.PI * (num('hole_d') / 2) ** 2 * num('thickness') -
    2 * k * num('corner_r') ** 2 * num('thickness') +
    num('width') * num('thickness') * num('height') +
    k * num('bend_r') ** 2 * num('width') -
    0.5 * num('chamfer_d') ** 2 * num('width')
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

/** Undo with the keyboard until the history is back at `past` entries. */
async function undoTo(page: Page, a: ReturnType<typeof app>, past: number) {
  for (let k = 0; k < 20 && (await a.history()).past.length > past; k++) {
    await page.keyboard.press('Control+z');
    await a.idle();
  }
  expect((await a.history()).past.length).toBe(past);
}

test('phone: dragging the rollback bar by touch rolls the model back, undoably', async ({
  page,
}) => {
  test.slow();
  const a = await openDemo(page);
  const doc0 = await a.doc();
  const n = doc0.parts[0]?.features.length ?? 0;
  expect(n).toBe(9);
  const past0 = (await a.history()).past.length;
  const full = await a.regen();
  expect(full?.bodies[0]?.volume).toBeCloseTo(bracketVolume(), 1);

  await tab(page, 'Features').tap();
  await expect(page.getByTestId('feature-tree')).toBeVisible();
  // The stepper is gone: only the tree and its rollback bar.
  await expect(page.getByTestId('feature-stepper')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next feature' })).toHaveCount(0);

  const bar = page.getByTestId('rollback-bar');
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox?.height).toBeGreaterThanOrEqual(44);

  // Drag the bar up to just below "Holes" (the model after the first four features).
  const holes = page.getByRole('treeitem', { name: /^Holes/ });
  await holes.scrollIntoViewIfNeeded();
  const holesBox = await holes.boundingBox();
  const grab = await page.getByTestId('rollback-grab').boundingBox();
  if (!(holesBox && grab)) throw new Error('rows not laid out');
  const t = await touch(page);
  await t.drag(
    { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 },
    { x: grab.x + grab.width / 2, y: holesBox.y + holesBox.height },
    16,
  );
  await expect.poll(async () => (await a.doc()).parts[0]?.rollbackIndex).toBe(4);
  await a.idle();
  const r = await a.regen();
  expect(r?.rollback).toBe(4);
  expect(r?.source).toBe('live');
  expect(r?.bodies.length).toBe(1);
  // Plate with four through-holes: a box (6 faces) plus a cylinder face per hole.
  expect(r?.bodies[0]?.faces).toBe(10);
  expect(r?.bodies[0]?.volume).toBeCloseTo(
    num('width') * num('depth') * num('thickness') -
      4 * Math.PI * (num('hole_d') / 2) ** 2 * num('thickness'),
    2,
  );
  expect((await a.shownBodies()).sort()).toEqual((r?.bodies ?? []).map((b) => b.id).sort());
  // A real edit: it is in the history and the document says so.
  expect((await a.history()).past.length).toBeGreaterThan(past0);
  expect((await a.history()).past.at(-1)?.label).toMatch(/roll/i);

  // Undo puts the model back.
  await undoTo(page, a, past0);
  expect((await a.doc()).parts[0]?.rollbackIndex).toBe(n);
  await a.idle();
  const back = await a.regen();
  expect(back?.rollback).toBe(n);
  expect(back?.bodies[0]?.volume).toBeCloseTo(full?.bodies[0]?.volume ?? 0, 6);
});

test('phone: a long press on a row opens its menu; Suppress is one undo entry', async ({
  page,
}) => {
  test.slow();
  const a = await openDemo(page);
  const doc0 = await a.doc();
  const past0 = (await a.history()).past.length;
  const full = await a.regen();
  await tab(page, 'Features').tap();
  const chamfer = page.getByRole('treeitem', { name: /^Top chamfer/ });
  await chamfer.scrollIntoViewIfNeeded();
  const box = await chamfer.boundingBox();
  if (!box) throw new Error('row not laid out');
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const t = await touch(page);
  await t.down([at]);
  await page.waitForTimeout(700);
  await t.up();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Suppress/ }).tap();
  const feature = doc0.parts[0]?.features.find((f) => f.name === 'Top chamfer');
  await expect
    .poll(
      async () => (await a.doc()).parts[0]?.features.find((f) => f.id === feature?.id)?.suppressed,
    )
    .toBe(true);
  expect((await a.history()).past.length).toBe(past0 + 1);
  await a.idle();
  const r = await a.regen();
  expect(r?.bodies[0]?.volume).toBeGreaterThan(full?.bodies[0]?.volume ?? 0);
  expect(r?.features.find((f) => f.id === feature?.id)?.state).toBe('suppressed');
  // One undo brings it back.
  await page.keyboard.press('Control+z');
  await expect
    .poll(
      async () => (await a.doc()).parts[0]?.features.find((f) => f.id === feature?.id)?.suppressed,
    )
    .toBeFalsy();
  await a.idle();
  expect((await a.regen())?.bodies[0]?.volume).toBeCloseTo(full?.bodies[0]?.volume ?? 0, 6);
});
