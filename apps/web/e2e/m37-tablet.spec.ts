import { devices, expect, test } from '@playwright/test';
import { app, boot } from './helpers';
import { CFG_THICK, configPartDoc, expectedMass } from './support/config-part';

/** M3.7 on the tablet: the pill sits in the top bar, switches, and opens the table panel. */

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

test('tablet: the pill is in the top bar; switch and open the configuration table', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await a.load(configPartDoc());
  await a.idle();
  const pill = page.getByTestId('top-bar').getByTestId('configuration-pill');
  await expect(pill).toBeVisible();
  await pill.tap();
  const list = page.getByTestId('configuration-list');
  await list.getByRole('button', { name: /^Thick/ }).tap();
  await a.idle();
  expect((await a.doc()).parts[0]?.activeConfigurationId).toBe(CFG_THICK);
  const mass = ((await a.regen())?.bodies ?? []).reduce((s, b) => s + (b.volume ?? 0), 0) * 1e-6;
  expect(mass).toBeCloseTo(expectedMass.thick, 9);
  await pill.tap();
  await page.getByTestId('configuration-list').getByRole('button', { name: 'Manage…' }).tap();
  const panel = page.getByTestId('configuration-panel');
  await expect(panel.getByTestId('configuration-table')).toBeVisible();
  await expect(panel).toContainText('Thick');
  await panel.getByRole('button', { name: 'Close configurations' }).tap();
  await expect(panel).toHaveCount(0);
});
