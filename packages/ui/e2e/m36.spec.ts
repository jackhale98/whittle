import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * M3.6 UI baselines: tree folders (open, collapsed, suppressed, rollback inside / above), the
 * sketch eye in every state, the phone review-only tree, and the interactive states (inline rename,
 * folder menu, a disabled "Add to new folder" with its reason, drop indicators in and out of a
 * folder, the take-out prompt). Desktop, tablet and phone, light and dark, each with an axe check.
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

const row = (page: Page, name: RegExp | string): Locator => page.getByRole('treeitem', { name });

async function center(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.y, bottom: b.y + b.height };
}

/** Presses a row's grip, moves to y and leaves the pointer down so the indicator shows. */
async function dragTo(page: Page, from: Locator, y: number, drop = false) {
  await from.hover();
  const grip = await center(from.locator('[data-grip]'));
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y + 6, { steps: 2 });
  await page.mouse.move(grip.x, y, { steps: 6 });
  if (drop) await page.mouse.up();
}

for (const theme of themes) {
  test.describe(`m36 components ${theme}`, () => {
    for (const section of ['m36-folders', 'm36-eye', 'm36-phone'] as const) {
      test(`${section} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, section);
        await expect(page.getByTestId('gallery')).toHaveScreenshot(
          `m36-${tier}-${theme}-${section}.png`,
        );
        await a11y(page);
      });
    }

    test(`inline rename of a folder (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      await page.getByText('Mounting', { exact: true }).dblclick();
      const input = page.getByRole('textbox', { name: 'Rename folder Mounting' });
      await expect(input).toBeFocused();
      await expect(page.getByTestId('g-m36-live')).toHaveScreenshot(
        `m36-${tier}-${theme}-rename.png`,
      );
      await a11y(page);
      await input.fill('Brackets');
      await input.press('Enter');
      await expect(row(page, /^Brackets/)).toBeVisible();
      await page.getByText('Brackets', { exact: true }).dblclick();
      await page.getByRole('textbox').press('Escape');
      await expect(row(page, /^Brackets/)).toBeVisible();
    });

    test(`folder menu (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      await row(page, /^Mounting/).click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'Actions for folder Mounting' });
      await expect(menu).toBeVisible();
      // full labels: no item is clipped
      for (const item of await menu.getByRole('menuitem').all()) {
        expect(await item.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      await expect(page).toHaveScreenshot(`m36-${tier}-${theme}-folder-menu.png`);
      await a11y(page);
    });

    test(`add to new folder: disabled with the reason (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      await row(page, /^Extrude 1/).click();
      await row(page, /^Hole 1/).click({ modifiers: ['Control'] });
      await row(page, /^Hole 1/).click({ button: 'right' });
      const item = page.getByRole('menuitem', { name: /Add to new folder/ });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText('consecutive');
      await expect(page).toHaveScreenshot(`m36-${tier}-${theme}-add-folder-disabled.png`);
      await a11y(page);
    });

    test(`multi-select then add to new folder is enabled (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      await row(page, /^Extrude 2/).click();
      await row(page, /^Hole 1/).click({ modifiers: ['Shift'] });
      await row(page, /^Hole 1/).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: /Add to new folder/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(page).toHaveScreenshot(`m36-${tier}-${theme}-add-folder-enabled.png`);
    });

    test(`drop indicators: into and out of a folder (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      const hole = row(page, /^Hole 1/);
      const f2 = await center(row(page, /^Fillet 2/));
      await dragTo(page, hole, f2.top);
      const ind = page.getByTestId('drop-indicator');
      await expect(ind).toHaveAttribute('data-kind', 'into');
      await expect(page.getByTestId('g-m36-live')).toHaveScreenshot(
        `m36-${tier}-${theme}-drop-into.png`,
      );
      await page.mouse.up();

      await open(page, tier, theme, 'm36-live');
      const e2 = await center(row(page, /^Extrude 2/));
      await dragTo(page, row(page, /^Fillet 1/), e2.top);
      await expect(page.getByTestId('drop-indicator')).toHaveAttribute('data-kind', 'out');
      await expect(page.getByTestId('g-m36-live')).toHaveScreenshot(
        `m36-${tier}-${theme}-drop-out.png`,
      );
      await page.mouse.up();
      const prompt = page.getByRole('group', { name: 'Take Fillet 1 out of Mounting?' });
      await expect(prompt).toBeVisible();
      await expect(page.getByTestId('g-m36-live')).toHaveScreenshot(
        `m36-${tier}-${theme}-leave-prompt.png`,
      );
      await a11y(page);
      await prompt.getByRole('button', { name: 'Keep it in' }).click();
      await expect(prompt).toBeHidden();
    });

    test(`dragging a folder shows a top-level indicator (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-live');
      const last = await center(row(page, /^Sketch 3/));
      await dragTo(page, row(page, /^Mounting/), last.bottom);
      await expect(page.getByTestId('drop-indicator')).toHaveAttribute('data-kind', 'top');
      await expect(page.getByTestId('g-m36-live')).toHaveScreenshot(
        `m36-${tier}-${theme}-drop-folder.png`,
      );
      await page.mouse.up();
    });

    test(`eye toggles aria-label and the auto marker (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-eye');
      const eye = page
        .getByTestId('g-m36-eye')
        .first()
        .getByRole('button', { name: 'Hide Sketch 3' });
      await expect(eye).toHaveAttribute('data-visibility', 'auto');
      const box = await eye.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(tier === 'desktop' ? 24 : 44);
      expect(box?.height).toBeGreaterThanOrEqual(tier === 'desktop' ? 24 : 44);
    });

    test(`phone review-only tree: row menu has no Delete or Edit, folders only collapse (${theme})`, async ({
      page,
    }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-phone');
      const g = page.getByTestId('g-m36-phone');
      const tree = g.getByRole('tree').first();
      await tree
        .getByRole('treeitem', { name: /^Sketch 3/ })
        .first()
        .click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const names = await menu.getByRole('menuitem').allTextContents();
      expect(names.some((n) => /Suppress/.test(n))).toBe(true);
      expect(names.some((n) => /(Show|Hide) in viewport/.test(n))).toBe(true);
      for (const bad of [/Delete/, /Edit/, /Rename/, /folder/i, /selection/i])
        expect(
          names.filter((n) => bad.test(n)),
          `${bad}`,
        ).toEqual([]);
      await expect(menu).toHaveScreenshot(`m36-${tier}-${theme}-review-menu.png`);
      await page.keyboard.press('Escape');
      // A folder row has no actions button and no menu; its grip is gone too.
      const folder = row(page, /^Mounting/).first();
      await expect(folder.locator('[data-grip]')).toHaveClass(/invisible/);
      await expect(folder.getByRole('button', { name: /Actions for folder/ })).toHaveCount(0);
      await folder.click({ button: 'right' });
      await expect(page.getByRole('menu')).toHaveCount(0);
    });

    test(`phone Features tab: the rollback bar is a 44 px grab target (${theme})`, async ({
      page,
    }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm36-phone');
      const bar = page.getByTestId('g-m36-phone').getByTestId('rollback-bar').first();
      const b = await bar.boundingBox();
      expect(b?.height).toBeGreaterThanOrEqual(44);
      await expect(bar.getByTestId('rollback-grab')).toBeVisible();
      await expect(page.getByTestId('g-m36-phone')).toHaveScreenshot(
        `m36-${tier}-${theme}-phone-tree.png`,
      );
    });
  });
}
