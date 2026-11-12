import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M4.5 3D mouse UI: baselines for the diagnostics panel in each of its five states and for the
 * settings section with the button mapping, light and dark on all shells, each with an axe check;
 * touch targets of 44 px on the touch shells.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;
const states = ['unsupported', 'notPaired', 'disconnected', 'noReports', 'live'] as const;

async function open(page: Page, tier: string, theme: string, section: string) {
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

const a11y = async (page: Page) =>
  expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);

for (const theme of themes) {
  test.describe(`motion ${theme}`, () => {
    for (const s of states) {
      test(`diagnostics ${s} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, 'motion-states');
        await expect(page.getByTestId(`motion-state-${s}`)).toHaveScreenshot(
          `motion-${tier}-${theme}-${s}.png`,
        );
        await a11y(page);
      });
    }

    test(`settings section and button mapping (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'motion-settings');
      await expect(page.getByTestId('g-motion-settings')).toHaveScreenshot(
        `motion-${tier}-${theme}-settings.png`,
      );
      await a11y(page);
    });
  });
}

test('touch targets are 44 px on the touch shells', async ({ page }, info) => {
  const tier = info.project.name as Tier;
  test.skip(tier === 'desktop');
  await open(page, tier, 'light', 'motion-settings');
  const root = page.getByTestId('g-motion-settings');
  for (const loc of [
    root.getByRole('button', { name: 'Pair a 3D mouse' }),
    root.getByRole('switch', { name: 'Rotate' }),
    root.getByRole('switch', { name: 'Reverse slide left/right (X)' }),
    root.getByRole('combobox', { name: 'Button 1' }),
  ]) {
    const b = await loc.boundingBox();
    expect(b?.height).toBeGreaterThanOrEqual(44);
  }
});
