import { expect, test } from '@playwright/test';
import { app, boot } from './helpers';
import { configPartDoc, expectedMass } from './support/config-part';

test('scratch', async ({ page }) => {
  page.on('console', (m) => console.log('[console]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await boot(page);
  await app(page).load(configPartDoc());
  await app(page).idle();
  console.log(JSON.stringify(await app(page).configurations()));
  await app(page).configurationsBuilt();
  console.log(JSON.stringify(await app(page).configurations()), JSON.stringify(expectedMass));
  await page.screenshot({ path: 'test-results/scratch.png' });
  expect(1).toBe(1);
});
