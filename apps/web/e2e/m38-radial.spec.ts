import { devices, expect, type Page, test } from '@playwright/test';
import { addBox, app, boot, cameraStill, palette, toPage } from './helpers';

/**
 * M3.8 acceptance (PLAN "Radial menu customization"): customise the face ring in Settings, reload,
 * then a right click on a face shows the custom ring (a command that does not apply stays in its
 * slot, disabled) and a flick runs the custom item. The editor fits a phone-width panel.
 */

test.use({ viewport: { width: 1280, height: 720 } });

async function openRadialSettings(page: Page) {
  await palette(page, 'Radial menu settings');
  await expect(page.getByTestId('radial-editor')).toBeVisible();
}

async function assign(page: Page, slot: RegExp, command: string) {
  await page.getByRole('button', { name: slot }).click();
  await page.getByRole('searchbox', { name: 'Search commands' }).fill(command);
  await page.getByRole('button', { name: new RegExp(`^${command}, place in slot`, 'i') }).click();
}

test('customise the face ring, reload, right click shows it and a flick runs it', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  await openRadialSettings(page);
  await page.getByRole('combobox', { name: 'Wheel context' }).selectOption('face');
  // Slot 1 (north-east) becomes Measure; slot 2 (east) becomes Fillet, which a face cannot use.
  await assign(page, /^slot 1, north-east/i, 'Measure');
  await assign(page, /^slot 2, east/i, 'Fillet');
  await expect(page.getByRole('button', { name: /^slot 1, north-east: measure/i })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('wren.radial'))).toContain('"fillet"');
  await app(page).flushSave();

  await page.reload();
  await boot(page);
  await page.keyboard.press('0');
  await cameraStill(page);
  const b = (await app(page).regen())?.bodies[0]?.bbox;
  if (!b) throw new Error('no body');
  const face = await toPage(page, [
    b.max[0] as number,
    (b.max[1] as number) / 2,
    (b.max[2] as number) / 2,
  ]);

  const menu = page.getByTestId('radial-menu');
  await page.mouse.click(face.x, face.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-slot="ne"]')).toHaveAttribute('data-item', 'measure');
  await expect(menu.locator('[data-slot="e"]')).toHaveAttribute('data-item', 'fillet');
  await expect(menu.locator('[data-slot="e"]')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // A flick north-east runs the custom item (Measure). The 250 ms window needs a retry or two.
  let ran = false;
  for (let i = 0; i < 6 && !ran; i++) {
    await page.mouse.click(face.x, face.y, { button: 'right' });
    for (let k = 1; k <= 4; k++) await page.mouse.move(face.x + k * 16, face.y - k * 16);
    ran = (await app(page).ui()).measure?.active === true;
    if (!ran) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await page.mouse.move(face.x, face.y);
    }
  }
  expect(ran, 'the flick did not run the custom item').toBe(true);
});

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: devices['iPhone 13'].userAgent,
    isMobile: true,
    hasTouch: true,
  });

  test('the editor fits a phone-width panel and keeps 44 px targets', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Close welcome' }).click();
    await openRadialSettings(page);
    const panel = page.getByTestId('settings-panel');
    const box = await panel.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    const overflow = await page
      .getByTestId('radial-editor')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    const slot = await page.getByRole('button', { name: /^slot 1, north-east/i }).boundingBox();
    expect(slot?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  });
});
