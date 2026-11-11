import { expect, test } from '@playwright/test';
import { app, boot, palette } from './helpers';

/**
 * In-app welcome (first launch): open the demo bracket (real regen engine), change `width` in the
 * params table, see it regenerate and the mass in the inspector change.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('welcome → demo bracket → edit width → mass updates @smoke', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const a = app(page);
  const welcome = page.getByTestId('welcome');
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText('Free, open-source parametric CAD');
  await expect(welcome.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
    'href',
    'https://github.com/jackhale98/wren-cad',
  );
  await page.screenshot({ path: 'test-results/m1-welcome.png' });

  await welcome.getByTestId('open-demo').click();
  await expect(welcome).toBeHidden();
  await expect(page.getByTestId('feature-tree')).toContainText('Top chamfer');
  await a.idle();
  let r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
  expect(r?.bodies).toHaveLength(1);
  const v1 = r?.bodies[0]?.volume ?? 0;
  const mass = page.getByTestId('mass-readout').locator('[data-prop="mass"]');
  await expect(mass).not.toHaveText('—');
  const m1 = await mass.textContent();
  await page.screenshot({ path: 'test-results/m1-demo-bracket.png' });

  await page.getByRole('tab', { name: 'Params' }).click();
  const width = page.getByRole('textbox', { name: 'Expression for width' });
  await width.fill('100 mm');
  await width.press('Enter');
  await a.idle();
  r = await a.regen();
  expect(r?.features.map((f) => f.state)).toEqual(Array(9).fill('ok'));
  expect(r?.bodies[0]?.volume ?? 0).toBeGreaterThan(v1);
  await expect(mass).not.toHaveText(m1 ?? '');

  // The welcome can be reopened from the palette, and the demo is now in the library.
  await palette(page, 'Welcome');
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('welcome')).toBeHidden();
  await a.flushSave();
  await page.getByTestId('library-button').click();
  await expect(page.getByTestId('library-item-name').first()).toHaveText('Demo bracket');
});
