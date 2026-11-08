import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;
const sections = ['tree', 'params', 'expr', 'inspectors', 'sketch', 'chooser'] as const;

async function gallery(page: Page, tier: string, theme: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}`);
  await page.locator('[data-testid="gallery"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function dataShell(page: Page, tier: string, theme: string, extra = '') {
  await page.goto(`/?shell=${tier}&theme=${theme}&data=1${extra}`);
  await page.locator('[data-testid="app-shell"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

const serious = (r: {
  violations: Array<{ impact?: string | null; id: string; nodes: Array<{ target: unknown[] }> }>;
}) =>
  r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

for (const theme of themes) {
  test.describe(`components ${theme}`, () => {
    for (const section of sections) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await gallery(page, tier, theme, section);
        await expect(page.getByTestId('gallery')).toHaveScreenshot(
          `c-${tier}-${theme}-${section}.png`,
        );
        expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
      });
    }

    test(`data-driven shell (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await dataShell(page, tier, theme);
      await expect(page).toHaveScreenshot(`s-${tier}-${theme}-data.png`);
      expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
    });
  });
}
