import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M3.7 UI baselines: the configuration pill (every state, bar and phone chip), override markers, the
 * scope chip and notice, the tree's suppress scope, and the configuration table (rows, transposed,
 * collapsed groups), plus interactive states (open list, inline new-configuration form, an editing
 * cell, a TSV paste, the suppress menus). Desktop, tablet and phone, light and dark, each with axe.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;

async function open(page: Page, tier: string, theme: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}`);
  await page.locator('[data-testid="gallery"]').waitFor();
  if (section.startsWith('m37-table') || section === 'm37-live')
    await page.locator('[data-testid="configuration-table"]').waitFor();
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
  test.describe(`m37 components ${theme}`, () => {
    for (const section of [
      'm37-pill',
      'm37-markers',
      'm37-review',
      'm37-table',
      'm37-table-transposed',
      'm37-table-collapsed',
    ] as const) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, section);
        await expect(page.getByTestId('gallery')).toHaveScreenshot(
          `m37-${tier}-${theme}-${section}.png`,
        );
        await a11y(page);
      });
    }

    test(`pill list and inline new configuration (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm37-live');
      const pill = page.getByTestId('configuration-pill');
      await pill.click();
      await expect(page.getByTestId('configuration-list')).toBeVisible();
      await expect(page).toHaveScreenshot(`m37-${tier}-${theme}-pill-list.png`);
      await a11y(page);
      await page.getByRole('button', { name: 'New configuration…' }).click();
      await expect(page.getByRole('textbox', { name: 'New configuration name' })).toBeFocused();
      await expect(page).toHaveScreenshot(`m37-${tier}-${theme}-pill-new.png`);
      await a11y(page);
      await page.keyboard.type('Wide');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('log')).toContainText('created Wide from active');
      // the new configuration inherited Long's overrides (From Active) and shows in the table
      await expect(page.getByRole('rowheader', { name: /Wide/ })).toBeVisible();
    });

    test(`pill status text is complete and 44px on touch (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm37-live');
      await page.getByTestId('configuration-pill').click();
      const list = page.getByTestId('configuration-list');
      for (const t of ['OK', 'Needs attention', 'Failed', 'Not yet built'])
        await expect(list.getByText(t, { exact: true })).toBeVisible();
      for (const b of await list.getByRole('button').all()) {
        const box = await b.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(tier === 'desktop' ? 30 : 43.5);
        expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
    });

    test(`table: edit a cell, reset, collapse (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm37-live');
      const cell = page.locator('[data-cell="1:0"]');
      await cell.focus();
      await page.keyboard.press('Enter');
      const input = page.getByRole('textbox', { name: 'Long, Width' });
      await expect(input).toBeFocused();
      await expect(page.getByTestId('g-m37-live')).toHaveScreenshot(
        `m37-${tier}-${theme}-table-editing.png`,
      );
      await a11y(page);
      await input.fill('100 mm');
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-cell="1:0"]')).toContainText('100 mm');
      await page.getByRole('button', { name: 'Reset Long, Width to default' }).click();
      await expect(page.locator('[data-cell="1:0"]')).toContainText('40 mm');
      await page.getByTestId('group-parameters').click();
      await expect(page.getByTestId('group-parameters')).toHaveAttribute('aria-expanded', 'false');
      await page.getByTestId('transpose').click();
      await expect(page.getByRole('columnheader', { name: /Long/ })).toBeVisible();
    });

    test(`table: TSV paste creates configurations (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm37-live');
      await page.locator('[data-cell="1:0"]').focus();
      await page.evaluate(() => {
        const region = document.querySelector(
          '[data-testid="configuration-table"] [role="presentation"]',
        );
        const dt = new DataTransfer();
        dt.setData(
          'text/plain',
          '\tWidth\tHeight\nLong\t90 mm\t25 mm\nShort\t30 mm\t10 mm\nTall\t45 mm\t20 mm',
        );
        region?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
      await expect(page.getByRole('rowheader', { name: /Short/ })).toBeVisible();
      await expect(page.getByTestId('paste-note')).toContainText('created 1 configuration');
      await expect(page.locator('[data-cell="1:0"]')).toContainText('90 mm');
      await expect(page.getByTestId('g-m37-live')).toHaveScreenshot(
        `m37-${tier}-${theme}-table-pasted.png`,
      );
      await a11y(page);
    });

    test(`tree suppress menu, full and review (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm37-markers');
      const row = page.getByRole('treeitem', { name: /^Extrude 1/ });
      await row.click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'Actions for Extrude 1' });
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole('menuitem', { name: /Suppress in this configuration only/ }),
      ).toBeVisible();
      await expect(
        menu.getByRole('menuitem', { name: /Suppress in all configurations/ }),
      ).toBeVisible();
      for (const item of await menu.getByRole('menuitem').all())
        expect(await item.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(page).toHaveScreenshot(`m37-${tier}-${theme}-suppress-menu.png`);
      await a11y(page);
      await page.keyboard.press('Escape');

      await open(page, tier, theme, 'm37-review');
      await page.getByRole('treeitem', { name: /^Extrude 1/ }).click({ button: 'right' });
      const rmenu = page.getByRole('menu', { name: 'Actions for Extrude 1' });
      await expect(rmenu.getByRole('menuitem', { name: /Suppress in Long only/ })).toBeVisible();
      await expect(page).toHaveScreenshot(`m37-${tier}-${theme}-suppress-review.png`);
      await a11y(page);
    });
  });
}
