import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M2.5 connections, sync status, versions, compare and merge. Every component state is a
 * visual baseline on desktop, tablet and phone, light and dark; touch tiers also check 44 px
 * targets and 16 px inputs.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;
const sections = ['sync', 'connections', 'versions', 'compare', 'merge'] as const;

async function gallery(page: Page, tier: string, theme: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}`);
  await page.getByTestId('gallery').waitFor();
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
  test.describe(`sync ${theme}`, () => {
    for (const section of sections) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await gallery(page, tier, theme, section);
        await expect(page.getByTestId('gallery')).toHaveScreenshot(
          `sync-${tier}-${theme}-${section}.png`,
        );
        expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
      });
    }

    test(`versions: expanded row and release form (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await gallery(page, tier, theme, 'versions');
      const panel = page.getByTestId('versions-panel').first();
      await panel.getByRole('button', { name: /Fillet the inner corners/ }).click();
      await panel.getByRole('button', { name: 'Mark as release…' }).click();
      await panel.getByLabel('Release name').fill('Rev A');
      await expect(panel).toHaveScreenshot(`sync-${tier}-${theme}-versions-release.png`);
      expect(serious(await new AxeBuilder({ page }).analyze())).toEqual([]);
    });

    test(`versions: try an idea (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await gallery(page, tier, theme, 'versions');
      const panel = page.getByTestId('versions-panel').first();
      await panel.getByRole('button', { name: 'Try an idea' }).click();
      await panel.getByLabel('Name your idea').fill('main');
      await panel.getByRole('button', { name: 'Create branch' }).click();
      await expect(panel).toHaveScreenshot(`sync-${tier}-${theme}-versions-idea.png`);
    });

    test(`merge: edit an expression inline (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await gallery(page, tier, theme, 'merge');
      const panel = page.getByTestId('merge-panel').first();
      await panel.getByRole('button', { name: 'Edit value' }).first().click();
      const input = panel.getByLabel('New value for Parameter width');
      await input.fill('height + 20mm');
      await expect(panel.getByTestId('expr-readout')).toBeVisible();
      await expect(panel).toHaveScreenshot(`sync-${tier}-${theme}-merge-edit.png`);
    });
  });
}

test('touch tiers: 44 px targets and 16 px inputs', async ({ page }, info) => {
  const tier = info.project.name as Tier;
  test.skip(tier === 'desktop', 'touch only');
  for (const section of ['connections', 'versions', 'merge', 'compare'] as const) {
    await gallery(page, tier, 'light', section);
    if (section === 'merge') await page.getByRole('button', { name: 'Edit value' }).first().click();
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      const root = document.querySelector('[data-testid="gallery"]');
      for (const el of root?.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), select, [role="radio"], [role="switch"]',
      ) ?? []) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const name = el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName;
        if (r.height < 43.5 || r.width < 43.5) out.push(`${name}: ${r.width}x${r.height}`);
        if (el.matches('input, select') && Number.parseFloat(getComputedStyle(el).fontSize) < 16)
          out.push(`${name}: font ${getComputedStyle(el).fontSize}`);
      }
      return out;
    });
    expect(bad, section).toEqual([]);
  }
});
