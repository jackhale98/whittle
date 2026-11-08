import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * The grouped desktop command bar (PLAN 9.1) and the nested feature tree's inline delete prompt:
 * baselines (collapsed, flyout open, light and dark), the width bound, keyboard navigation, axe.
 */

/** The old flat bar was about 620 px wide (nine tools and More at 58 px). Grouping must not exceed it. */
const LEGACY_BAR_WIDTH = 621;

async function shell(page: Page, theme: string) {
  await page.goto(`/?shell=desktop&theme=${theme}&data=1`);
  await page.locator('[data-testid="app-shell"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Modeling tools' });

async function noSeriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`command bar (${theme})`, () => {
    test('collapsed: one button per category, inside the old width, flyout indicators', async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'desktop');
      await shell(page, theme);
      const b = bar(page);
      await expect(b.getByRole('button')).toHaveCount(6);
      const box = await b.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(LEGACY_BAR_WIDTH);
      await expect(page.getByTestId('flyout-indicator')).toHaveCount(3);
      await expect(b).toHaveScreenshot(`cb-desktop-${theme}-collapsed.png`);
      await noSeriousViolations(page);
    });

    for (const group of ['solid', 'modify', 'inspect'] as const) {
      test(`${group} flyout open`, async ({ page }, info) => {
        test.skip(info.project.name !== 'desktop');
        await shell(page, theme);
        await page.locator(`[data-tool-group="${group}"]`).click();
        const flyout = page.getByTestId('tool-flyout');
        await expect(flyout).toBeVisible();
        const fb = await flyout.boundingBox();
        const bb = await bar(page).boundingBox();
        if (!fb || !bb) throw new Error('no boxes');
        const clip = {
          x: Math.min(fb.x, bb.x) - 12,
          y: fb.y - 12,
          width: Math.max(fb.x + fb.width, bb.x + bb.width) - Math.min(fb.x, bb.x) + 24,
          height: bb.y + bb.height - fb.y + 24,
        };
        await expect(page).toHaveScreenshot(`cb-desktop-${theme}-${group}-open.png`, { clip });
        await noSeriousViolations(page);
      });
    }
  });
}

test.describe('command bar behaviour', () => {
  test('keyboard: roving focus, ArrowUp opens, arrows move, Escape returns, Enter picks', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await shell(page, 'light');
    const sketch = page.locator('[data-tool="sketch"]');
    await sketch.focus();
    await page.keyboard.press('ArrowRight');
    const solid = page.locator('[data-tool-group="solid"]');
    await expect(solid).toBeFocused();
    await page.keyboard.press('ArrowUp');
    const flyout = page.getByTestId('tool-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout.locator('[data-tool="extrude"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(flyout.locator('[data-tool="pushPull"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(flyout).toBeHidden();
    await expect(solid).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-tool="revolve"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(flyout).toBeHidden();
    // the chosen tool is now the category's face, and persists
    await expect(page.getByRole('button', { name: 'Revolve, Solid tools' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('whittle.lastTools'))).toContain(
      '"solid":"revolve"',
    );
    await page.reload();
    await page.locator('[data-testid="app-shell"]').waitFor();
    await expect(page.getByRole('button', { name: 'Revolve, Solid tools' })).toBeVisible();
  });

  test('disabled tools show their own hint', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await shell(page, 'light');
    await page.locator('[data-tool-group="modify"]').click();
    const shellTool = page.locator('[data-tool="shell"]');
    await expect(shellTool).toHaveAttribute('aria-disabled', 'true');
    await expect(shellTool).toContainText('Coming in M3');
    await expect(page.getByText('Coming in M1')).toHaveCount(0);
  });

  test('an outside click closes the flyout; a second click on the category toggles it', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await shell(page, 'light');
    const modify = page.locator('[data-tool-group="modify"]');
    await modify.click();
    await expect(page.getByTestId('tool-flyout')).toBeVisible();
    await modify.click();
    await expect(page.getByTestId('tool-flyout')).toBeHidden();
    await modify.click();
    await page.mouse.click(300, 300);
    await expect(page.getByTestId('tool-flyout')).toBeHidden();
  });
});

test.describe('nested tree: inline delete prompt', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`prompt (${theme})`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop');
      await page.goto(`/?view=gallery&section=nested&shell=desktop&theme=${theme}`);
      await page.locator('[data-testid="gallery"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const tree = page.getByTestId('feature-tree').first();
      const row = tree.getByRole('treeitem', { name: /Extrude 1/ });
      await row.focus();
      await page.keyboard.press('Delete');
      const prompt = page.getByTestId('delete-prompt');
      await expect(prompt).toBeVisible();
      await expect(prompt.getByRole('button', { name: 'Delete sketch too' })).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.waitForTimeout(200);
      await expect(tree).toHaveScreenshot(`i-desktop-${theme}-tree-delete-prompt.png`);
      await noSeriousViolations(page);
      await page.keyboard.press('Escape');
      await expect(prompt).toBeHidden();
      await expect(row).toBeFocused();
    });
  }
});
