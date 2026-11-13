import { devices, expect, type Page, test } from '@playwright/test';
import { boot, palette } from './helpers';

/** M4.5: the 3D mouse section on the tablet shell has 44 px touch targets. */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

const attach = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __wrenApp: { motion(): Promise<{ attach(): void }> } }).__wrenApp
      .motion()
      .then((m) => m.attach()),
  );

async function settings(page: Page) {
  await palette(page, 'Settings');
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await page.getByTestId('settings-panel').getByRole('radio', { name: '3D mouse' }).tap();
}

test('3D mouse section on the tablet shell: 44 px targets', async ({ page }) => {
  await boot(page);
  await attach(page);
  await settings(page);
  const sec = page.getByTestId('motion-settings');
  await sec.scrollIntoViewIfNeeded();
  for (const loc of [
    sec.getByRole('button', { name: 'Pair a 3D mouse' }),
    sec.getByRole('switch', { name: 'Rotate' }),
    sec.getByRole('switch', { name: 'Reverse slide left/right (X)' }),
  ]) {
    const b = await loc.boundingBox();
    expect(b?.height).toBeGreaterThanOrEqual(44);
  }
});
