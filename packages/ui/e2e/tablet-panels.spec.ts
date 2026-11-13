import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * ADR-099: the tablet is the desktop shell at touch density. Landscape (1180) docks both panels;
 * portrait (820) overlays one at a time. A baseline per state, light and dark, plus axe.
 */
const themes = ['light', 'dark'] as const;

async function open(page: Page, theme: string) {
  await page.goto(`/?shell=tablet&theme=${theme}&data=1&status=ready`);
  await page.getByTestId('app-shell').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

async function toggle(page: Page, side: 'left' | 'right') {
  const t = page.getByTestId(`${side}-toggle`);
  if ((await t.getAttribute('aria-pressed')) !== 'true') await t.tap();
  await expect(t).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  expect(
    r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

for (const theme of themes) {
  test(`landscape docks both panels (${theme})`, async ({ page }, info) => {
    test.skip(info.project.name !== 'ipad-landscape');
    await open(page, theme);
    await expect(page.getByTestId('shell-body')).toHaveAttribute('data-panels', 'docked');
    await toggle(page, 'left');
    await toggle(page, 'right');
    await expect(page).toHaveScreenshot(`panels-landscape-both-${theme}.png`);
    await axe(page);
  });

  test(`portrait overlays one panel at a time (${theme})`, async ({ page }, info) => {
    test.skip(info.project.name !== 'ipad-portrait');
    await open(page, theme);
    await expect(page.getByTestId('shell-body')).toHaveAttribute('data-panels', 'overlay');
    await expect(page).toHaveScreenshot(`panels-portrait-closed-${theme}.png`);
    await toggle(page, 'left');
    await expect(page).toHaveScreenshot(`panels-portrait-tree-${theme}.png`);
    await axe(page);
    await toggle(page, 'right');
    await expect(page.getByTestId('left-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveScreenshot(`panels-portrait-inspector-${theme}.png`);
    await axe(page);
    // A tap outside closes it.
    await page.touchscreen.tap(60, 900);
    await expect(page.getByTestId('right-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
}
