import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M3 UI baselines: inspectors for the new features, the hole wizard, reference geometry, the
 * sketch-editing chrome, the feature tree and the new command-bar categories. Desktop, tablet and
 * phone, light and dark, each with an axe check (serious and critical violations fail).
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;
const sections = [
  'm3-features',
  'm3-patterns',
  'm3-reference',
  'm3-hole',
  'm3-sketch',
  'm3-tree',
] as const;

async function gallery(page: Page, tier: string, theme: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}`);
  await page.locator('[data-testid="gallery"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

const serious = (r: {
  violations: Array<{ impact?: string | null; id: string; nodes: Array<{ target: unknown[] }> }>;
}) =>
  r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

for (const theme of themes) {
  test.describe(`m3 components ${theme}`, () => {
    for (const section of sections) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await gallery(page, tier, theme, section);
        await expect(page.getByTestId('gallery')).toHaveScreenshot(
          `m3-${tier}-${theme}-${section}.png`,
        );
        expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
      });
    }

    test(`edit-tools menu on the sketch toolbar (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await gallery(page, tier, theme, 'm3-sketch');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Edit tools' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitemcheckbox', { name: /Offset/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(page).toHaveScreenshot(`m3-${tier}-${theme}-sketch-edit-menu.png`);
      expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
    });

    for (const group of ['pattern', 'reference'] as const) {
      test(`${group} flyout (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        test.skip(tier === 'phone', 'the phone is a viewer: no modeling tools');
        await gallery(page, tier, theme, 'm3-bar');
        await page.locator(`[data-tool-group="${group}"]`).click();
        await expect(page.getByTestId('tool-flyout')).toBeVisible();
        await expect(page.getByTestId('g-m3-bar')).toHaveScreenshot(
          `m3-${tier}-${theme}-bar-${group}.png`,
        );
        expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
      });
    }
  });
}
