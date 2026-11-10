import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Section view fixes: baselines for the persistent section chip (default, flipped, editing, both)
 * and the panel's tilt fields (axis plane, face plane, off), light and dark on all three shells,
 * each with an axe check; plus the chip's 44 px touch targets and its keyboard behaviour.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;

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
  test.describe(`section ${theme}`, () => {
    for (const section of ['section-chip', 'section-panel'] as const) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, section);
        await expect(page.getByTestId(`g-${section}`)).toHaveScreenshot(
          `section-${tier}-${theme}-${section}.png`,
        );
        await a11y(page);
      });
    }

    test(`chip: full labels, targets of 44 px on touch, focus ring on Tab (${theme})`, async ({
      page,
    }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'section-chip');
      const chip = page.getByTestId('section-chip').first();
      for (const name of ['Flip', 'Edit', 'Exit section']) {
        const b = await chip.getByRole('button', { name }).boundingBox();
        expect(b?.height).toBeGreaterThanOrEqual(tier === 'desktop' ? 32 : 44);
        expect(b?.width).toBeGreaterThanOrEqual(tier === 'desktop' ? 32 : 44);
      }
      // No label is clipped.
      const clipped = await chip.evaluate((el) =>
        [...el.querySelectorAll('button, span')].some((n) => n.scrollWidth > n.clientWidth + 1),
      );
      expect(clipped).toBe(false);
      await page.keyboard.press('Tab');
      await expect(chip.getByRole('button', { name: 'Flip' })).toBeFocused();
      await expect(page.getByTestId('g-section-chip')).toHaveScreenshot(
        `section-${tier}-${theme}-chip-focus.png`,
      );
    });

    test(`panel: tilt fields take expressions with units (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'section-panel');
      const u = page.getByTestId('section-panel-axis').getByTestId('section-tilt-u');
      const field = u.getByRole('textbox');
      await expect(field).toHaveValue('15deg');
      await field.fill('0.2rad');
      await field.press('Enter');
      await expect(field).toHaveValue('11.46deg');
      await field.fill('banana');
      await expect(page.getByTestId('section-panel-axis')).toHaveScreenshot(
        `section-${tier}-${theme}-tilt-invalid.png`,
      );
      await a11y(page);
    });
  });
}
