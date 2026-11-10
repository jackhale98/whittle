import { devices, expect, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraStill, toPage, touch } from './helpers';

/**
 * Owner's tablet findings (2026-11-10, PLAN M3.5 "Owner additions"): a visible way to drop the
 * active sketch tool, a visible way to clear a selection, and a sketch hiding once the feature
 * that consumed it is no longer being edited. iPad emulation, touch only.
 */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

async function openTablet(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).tap();
}

async function newSketch(page: Page) {
  await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
  const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(tools).toBeVisible();
  await cameraStill(page);
  return tools;
}

test('Select tool and the Done ✕ return a sketch to selection; the Pencil still draws freehand', async ({
  page,
}) => {
  test.slow();
  await openTablet(page);
  const a = app(page);
  const t = await touch(page);
  const tools = await newSketch(page);
  const tool = async () => (await a.ui()).sketch?.tool ?? null;

  // A new sketch starts with the line tool; Select is first and not pressed, Done names the tool.
  expect(await tool()).toBe('line');
  const select = tools.getByRole('button', { name: 'Select', exact: true });
  await expect(select).toBeVisible();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  const done = tools.getByRole('button', { name: 'Done with Line' });
  await expect(done).toBeVisible();
  const first = await tools.getByRole('button').first().getAttribute('aria-label');
  expect(first).toBe('Select');

  // The Done ✕ drops the tool.
  await done.tap();
  await expect.poll(tool).toBeNull();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByTestId('tool-done')).toHaveCount(0);

  // Pick a tool, then the Select tool drops it.
  await tools.getByRole('button', { name: 'Rectangle', exact: true }).tap();
  await expect.poll(tool).toBe('rectangle');
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await select.tap();
  await expect.poll(tool).toBeNull();

  // With no tool the Pencil draws freehand: a rectangle stroke is recognised and committed.
  const corners: Array<[number, number]> = [
    [-30, -20],
    [30, -20],
    [30, 20],
    [-30, 20],
    [-30, -20],
  ];
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [x0, y0] = corners[i] as [number, number];
    const [x1, y1] = corners[i + 1] as [number, number];
    for (let k = 0; k < 12; k++) {
      const u = k / 12;
      pts.push(await toPage(page, [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, 0]));
    }
  }
  pts.push(await toPage(page, [-30, -20, 0]));
  await t.pen.down(pts[0] as { x: number; y: number });
  for (const p of pts.slice(1)) await t.pen.move(p);
  await t.pen.up(pts.at(-1) as { x: number; y: number });
  await a.settled();
  expect((await a.ui()).sketch?.lastStroke?.shape).toBe('rectangle');
  expect(await tool()).toBeNull();
});

test('tapping empty space clears the selection, and the ✕ Clear selection controls do too', async ({
  page,
}) => {
  test.slow();
  await openTablet(page);
  await addBox(page);
  await app(page).idle();
  await page.getByTestId('feature-inspector').getByRole('button', { name: 'Done' }).tap();
  await cameraStill(page);
  const a = app(page);
  const t = await touch(page);
  const face = async () =>
    toPage(page, [10, 10, (await a.regen())?.bodies[0]?.bbox.max[2] ?? 10] as [
      number,
      number,
      number,
    ]);
  const empty = async () => {
    const box = await page.getByTestId('viewport-canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.12 };
  };
  const bubble = page.getByTestId('context-bubble');

  // Tap a face: selected, with a bubble and an inspector, with a Clear selection ✕ on the bubble.
  await t.tap([await face()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(1);
  await expect(bubble.getByRole('button', { name: 'Clear selection' })).toBeVisible();
  // (The inspector's own ✕ is covered by the desktop component test.)

  // The bubble's ✕ clears it.
  await bubble.getByRole('button', { name: 'Clear selection' }).tap();
  await expect.poll(async () => (await a.ui()).selection.length).toBe(0);
  await expect(bubble).toBeHidden();

  // Tapping empty space clears too.
  await t.tap([await face()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(1);
  await t.tap([await empty()]);
  await expect.poll(async () => (await a.ui()).selection.length).toBe(0);
});
