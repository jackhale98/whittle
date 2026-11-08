import { expect, test } from '@playwright/test';
import { app, boot, cameraStill, clickAt, sketchOn, toPage } from './helpers';

/**
 * Desktop tour at 1440 × 900: a plate with a hole (two regions), select-first fillet, the library
 * grid. Writes the review screenshots (mid-sketch, feature selected, library).
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('plate with a hole, select-first fillet, library grid; screenshots', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const a = app(page);

  // A rectangle on Top.
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  for (const [x, y] of [
    [-30, -20],
    [30, -20],
    [30, 20],
    [-30, 20],
    [-30, -20],
  ] as const) {
    await clickAt(page, x, y);
  }
  await expect.poll(async () => (await a.sketch())?.dof).toBe(4);

  // Circle tool, mid-draw: centre placed, rubber band to the cursor.
  await page.keyboard.press('Shift+C');
  await clickAt(page, 0, 0);
  const rim = await toPage(page, [8, 0.2, 0]);
  await page.mouse.move(rim.x, rim.y, { steps: 4 });
  await page.screenshot({ path: 'test-results/m1-sketch.png' });
  await clickAt(page, 8, 0);
  await page.getByTestId('finish-sketch').click();
  await a.idle();
  expect((await a.regen())?.sketches[0]?.regions).toHaveLength(2);

  // Extrude the plate (the ring region) 10 mm.
  await page.keyboard.press('e');
  await clickAt(page, 20, 10);
  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await depth.fill('10');
  await depth.press('Enter');
  await a.idle();
  const plate = (await a.regen())?.bodies[0]?.volume ?? 0;
  expect(plate).toBeGreaterThan(21_000); // 60 × 40 × 10 minus a ~R8 hole
  expect(plate).toBeLessThan(23_000);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('0');
  await cameraStill(page);

  // Select first, act second: an edge, then F.
  await page.evaluate(() =>
    (
      window as unknown as { __whittleViewport: { whenPickReady(): Promise<void> } }
    ).__whittleViewport.whenPickReady(),
  );
  const p = await toPage(page, [0, -20, 10]);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId('selection-inspector')).toContainText('1 edge');
  await page.keyboard.press('f');
  await expect(page.getByTestId('feature-inspector')).toContainText('Fillet 1');
  // While edges are being picked the model shows the fillet's input (rolled back to it).
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'rolledBack']);
  await page.screenshot({ path: 'test-results/m1-fillet-picking.png' });
  await page.keyboard.press('Escape');
  await a.idle();
  expect((await a.regen())?.features.map((f) => f.state)).toEqual(['ok', 'ok', 'ok']);
  await page.screenshot({ path: 'test-results/m1-fillet-selected.png' });

  await a.flushSave();
  await page.getByTestId('library-button').click();
  await expect(page.getByTestId('library-item').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/m1-library.png' });
});
