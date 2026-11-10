import { devices, expect, test } from '@playwright/test';
import { app, boot, touch } from './helpers';
import { BOSS, CFG_LONG, configPartDoc, expectedMass } from './support/config-part';

/**
 * M3.7 acceptance, phone: the configuration chip switches the active configuration, and the
 * feature tree's menu suppresses a feature in the active configuration only (review mode never
 * touches the other configurations). Creating and managing configurations is desktop and tablet.
 */

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: devices['iPhone 13'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

test('phone: switch configuration with the chip and suppress in the active one only', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  const a = app(page);
  await a.load(configPartDoc());
  await a.idle();
  const chip = page.getByTestId('configuration-pill');
  await expect(chip).toHaveAttribute('data-variant', 'chip');
  // The chip has no "New configuration…" or "Manage…" on the phone.
  await chip.tap();
  const list = page.getByTestId('configuration-list');
  await expect(list).toBeVisible();
  await expect(list.getByRole('button', { name: /New configuration/ })).toHaveCount(0);
  await list.getByRole('button', { name: /^Long/ }).tap();
  await a.idle();
  await expect(chip).toContainText('Long');
  const mass = async () =>
    ((await a.regen())?.bodies ?? []).reduce((s, b) => s + (b.volume ?? 0), 0) * 1e-6;
  expect(await mass()).toBeCloseTo(expectedMass.long, 9);

  // Long-press the Boss row: one item, naming the configuration.
  await page
    .getByRole('group', { name: 'Viewer tools' })
    .getByRole('button', { name: 'Features' })
    .tap();
  const row = page.getByRole('treeitem', { name: /^Boss/ });
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) throw new Error('row not laid out');
  const t = await touch(page);
  await t.down([{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]);
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await t.up();
  const items = await menu.getByRole('menuitem').allTextContents();
  expect(items.some((n) => /Suppress in Long only/.test(n))).toBe(true);
  expect(items.some((n) => /all configurations/.test(n))).toBe(false);
  await menu.getByRole('menuitem', { name: /Suppress in Long only/ }).tap();
  await a.idle();
  const d = await a.doc();
  expect(d.parts[0]?.features.find((f) => f.id === BOSS)?.suppressed).toBe(false);
  expect(d.parts[0]?.configurations?.find((c) => c.id === CFG_LONG)?.features).toEqual({
    [BOSS]: { suppressed: true },
  });
  expect(await mass()).toBeLessThan(expectedMass.long);

  // Back on Default the boss is still there.
  await chip.tap();
  await page
    .getByTestId('configuration-list')
    .getByRole('button', { name: /^Default/ })
    .tap();
  await a.idle();
  expect(await mass()).toBeCloseTo(expectedMass.default, 9);
});
