import { devices, expect, type Page, test } from '@playwright/test';
import type { SketchFeature } from '@wren-cad/contracts';
import { app, boot, cameraState, cameraStill, clickAt, sketchOn, toPage, touch } from './helpers';

/**
 * M3.8 sketch input: finish a tool without Esc. A right click (press and release, no drag) ends
 * a line chain where it is and commits an open spline; with nothing in progress it opens the
 * radial menu; right-drag still navigates. On touch, Finish beside Done ends a chain. A two-point
 * spline finishes and regenerates.
 */

async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features.find((x) => x.type === 'sketch');
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}

const count = async (page: Page, kind: string) => {
  await app(page).settled();
  return (await sketchOf(page)).entities.filter((e) => e.kind === kind).length;
};

async function rightClickAt(page: Page, x: number, y: number): Promise<void> {
  const p = await toPage(page, [x, y, 0]);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

/** The sketch regenerated without errors (the regen saw the sketch's current geometry). */
async function regenerated(page: Page, splines: number): Promise<void> {
  const a = app(page);
  await expect
    .poll(
      async () => {
        await a.idle();
        const f = await sketchOf(page);
        const r = await a.regen();
        const state = r?.features.find((x) => x.id === f.id)?.state;
        return { state, splines: f.entities.filter((e) => e.kind === 'bspline').length };
      },
      { timeout: 30_000 },
    )
    .toEqual({ state: 'ok', splines });
}

test.describe('mouse', () => {
  test('a right click ends a line chain and a three-point spline; idle it opens the radial menu; right-drag navigates', async ({
    page,
  }) => {
    test.slow();
    await boot(page);
    const a = app(page);
    await page.keyboard.press('s');
    await sketchOn(page, 'Top');
    expect((await a.ui()).sketch?.tool).toBe('line');

    // A chain of two segments, then a right click ends it where it is.
    for (const [x, y] of [
      [10, 10],
      [40, 10],
      [40, 30],
    ] as const)
      await clickAt(page, x, y);
    await rightClickAt(page, 50, 50);
    await expect(page.getByTestId('radial-menu')).toBeHidden();
    expect(await count(page, 'line')).toBe(2);
    // The next click starts a new chain (no segment from the old end); the tool stays.
    await clickAt(page, -20, 20);
    expect(await count(page, 'line')).toBe(2);
    await clickAt(page, -20, 40);
    expect(await count(page, 'line')).toBe(3);
    expect((await a.ui()).sketch?.tool).toBe('line');

    // Right-drag with the chain in progress still orbits, and does not end the chain.
    const before = await cameraState(page);
    const from = await toPage(page, [20, -20, 0]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + i * 6, from.y + i * 3);
    await page.mouse.up({ button: 'right' });
    await expect(page.getByTestId('radial-menu')).toBeHidden();
    await cameraStill(page);
    expect(JSON.stringify(await cameraState(page))).not.toBe(JSON.stringify(before));
    await clickAt(page, 0, 40); // still chained from (-20, 40)
    expect(await count(page, 'line')).toBe(4);
    await rightClickAt(page, 0, 40);
    await expect(page.getByTestId('radial-menu')).toBeHidden();

    // Nothing in progress: a right click opens the radial menu, as before.
    await rightClickAt(page, 0, 40);
    await expect(page.getByTestId('radial-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('radial-menu')).toBeHidden();

    // A three-point through spline, finished by a right click (open, all three points).
    await page.keyboard.press('Shift+B');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('splineThrough');
    for (const [x, y] of [
      [-40, -10],
      [-25, 10],
      [-10, -5],
    ] as const)
      await clickAt(page, x, y);
    await rightClickAt(page, -30, -30);
    await expect(page.getByTestId('radial-menu')).toBeHidden();
    await a.settled();
    const s = (await sketchOf(page)).entities.find((e) => e.kind === 'bspline');
    expect(s?.kind === 'bspline' && s.periodic).toBe(false);
    expect(s?.kind === 'bspline' && s.through).toHaveLength(1); // the inner one
    await regenerated(page, 1);
  });

  test('a two-point spline finishes (Enter, right click) and regenerates', async ({ page }) => {
    test.slow();
    await boot(page);
    const a = app(page);
    await page.keyboard.press('s');
    await sketchOn(page, 'Top');
    // Through points: two taps and Enter → a straight cubic.
    await page.keyboard.press('Shift+B');
    await clickAt(page, -30, 10);
    await clickAt(page, 20, 30);
    await page.keyboard.press('Enter');
    await regenerated(page, 1);
    // Control points: two poles and a right click → a degree-1 segment.
    await page.keyboard.press('b');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('splineControl');
    await clickAt(page, -30, -20);
    await clickAt(page, 25, -35);
    await rightClickAt(page, 0, 0);
    await regenerated(page, 2);
    const degrees = (await sketchOf(page)).entities
      .filter((e) => e.kind === 'bspline')
      .map((e) => (e.kind === 'bspline' ? e.degree : 0));
    expect(degrees).toEqual([3, 1]);
  });

  test('with the setting off, a right click mid-chain opens the radial menu', async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      localStorage.setItem('wren.sketchInput', JSON.stringify({ rightClickFinishes: false })),
    );
    await boot(page);
    await page.keyboard.press('s');
    await sketchOn(page, 'Top');
    await clickAt(page, 10, 10);
    await rightClickAt(page, 30, 30);
    await expect(page.getByTestId('radial-menu')).toBeVisible();
  });
});

test.describe('touch', () => {
  test.use({
    viewport: { width: 1180, height: 820 },
    userAgent: devices['iPad Pro 11'].userAgent,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test('Finish beside Done ends a line chain and a two-point spline', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).tap();
    const a = app(page);
    const t = await touch(page);
    await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
    await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
    // The toolbar is a lazy chunk: allow for a busy machine.
    await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible({
      timeout: 20_000,
    });
    await cameraStill(page);
    const finish = page.getByTestId('tool-finish');
    await expect(finish).toBeHidden(); // nothing in progress
    const tapAt = async (x: number, y: number) => {
      await t.tap([await toPage(page, [x, y, 0])]);
      await page.waitForTimeout(500); // never a double-tap
    };
    await tapAt(10, 10);
    await expect(finish).toBeVisible();
    await tapAt(40, 10);
    await tapAt(40, 30);
    expect(await count(page, 'line')).toBe(2);
    await finish.tap();
    await expect(finish).toBeHidden();
    expect((await a.ui()).sketch?.tool).toBe('line');
    await tapAt(60, 60); // a new chain: no segment yet
    expect(await count(page, 'line')).toBe(2);
    await finish.tap();

    // A two-point through spline, finished with Finish.
    await page.keyboard.press('Shift+B');
    await expect.poll(async () => (await a.ui()).sketch?.tool).toBe('splineThrough');
    await tapAt(-30, -10);
    await tapAt(0, -30);
    await finish.tap();
    await expect(finish).toBeHidden();
    await regenerated(page, 1);
  });
});
