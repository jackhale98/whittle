import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * ADR-080, parameters you can find and apply: a baseline for every state (the autocomplete list,
 * the full fx list, the Make parameter form and its error, the linked field and dimension labels,
 * "Used by" open, and a parameter being dragged over a field and over a dimension label), light and
 * dark, on all three shells, each with an axe check; plus the touch target sizes.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;

async function open(page: Page, tier: string, theme: string, extra = '') {
  await page.goto(`/?view=gallery&section=params-link&shell=${tier}&theme=${theme}${extra}`);
  await page.locator('[data-testid="gallery"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The parameter list and form are lazy chunks: wait for the first field's fx button.
  await page.getByRole('button', { name: 'Parameters for Depth' }).waitFor();
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

/** Presses on a parameter's drag handle and moves over `target` (leaves the button down). */
async function dragOver(page: Page, name: string, target: ReturnType<Page['locator']>) {
  const handle = page.getByRole('button', { name: `Use ${name}` });
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y - 20, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
}

for (const theme of themes) {
  test.describe(`params ${theme}`, () => {
    test(`rest: linked field, dimension labels, Params tab (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme);
      await expect(page.getByTestId('param-link-badge').first()).toBeVisible();
      await expect(page.locator('button[data-param="width"]').first()).toContainText('width =');
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-rest.png`, { fullPage: true });
      await a11y(page);
    });

    test(`autocomplete list while typing (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, '&keypad=never');
      const depth = page.getByLabel('Depth', { exact: true });
      await depth.click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('w');
      const list = page.getByRole('listbox', { name: 'Parameters' });
      await expect(list.getByRole('option')).toHaveText(['width60 mm', 'wall5 mm']);
      await expect(page.getByRole('combobox', { name: 'Depth' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-autocomplete.png`);
      await a11y(page);
      // The keyboard works: down, Enter accepts.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(depth).toHaveValue('wall');
    });

    test(`full list from fx (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, '&keypad=never');
      await page.getByRole('button', { name: 'Parameters for Depth' }).click();
      const list = page.getByRole('listbox', { name: 'Parameters' });
      await expect(list.getByRole('option')).toHaveCount(6); // five parameters + Make parameter
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-fx-list.png`);
      await a11y(page);
    });

    test(`make parameter form and its error (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, '&keypad=never');
      await page.getByRole('button', { name: 'Parameters for Depth' }).click();
      await page.getByRole('option', { name: /Make parameter from/ }).click();
      const name = page.getByRole('textbox', { name: 'Name of the new parameter' });
      await expect(name).toBeFocused();
      await expect(name).toHaveValue('depth');
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-make.png`);
      await a11y(page);

      await name.fill('mm');
      await expect(page.getByRole('alert')).toContainText('is a unit');
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-make-error.png`);
      await a11y(page);

      // Esc goes back to the field without making anything.
      await page.keyboard.press('Escape');
      await expect(name).toBeHidden();
      await expect(page.getByLabel('Depth', { exact: true })).toBeFocused();
    });

    test(`used by, open (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme);
      const row = page.getByRole('listitem', { name: 'Parameter width' });
      await row.getByRole('button', { name: 'Used by 3' }).click();
      await expect(row.getByRole('list', { name: 'Used by, width' })).toBeVisible();
      await expect(page.getByTestId('params-table')).toHaveScreenshot(
        `params-${tier}-${theme}-used-by.png`,
      );
      await a11y(page);
    });

    test(`dragging a parameter over a field (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme);
      const field = page
        .getByLabel('Depth', { exact: true })
        .locator('xpath=ancestor::div[@data-param-drop]');
      await dragOver(page, 'wall', field);
      await expect(page.getByTestId('param-drag-ghost')).toHaveAttribute('data-over', 'true');
      await expect(field).toHaveAttribute('data-drop-hot', '');
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-drag-field.png`);
      await page.mouse.up();
      await expect(page.getByLabel('Depth', { exact: true })).toHaveValue('wall');
      await a11y(page);
    });

    test(`dragging a parameter over a dimension label (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme);
      const label = page.locator('button[data-kind="diameter"]');
      await dragOver(page, 'height', label);
      await expect(page.getByTestId('param-drag-ghost')).toHaveAttribute('data-over', 'true');
      await expect(label).toHaveAttribute('data-drop-hot', '');
      await expect(page).toHaveScreenshot(`params-${tier}-${theme}-drag-label.png`);
      await page.mouse.up();
      await expect(label).toContainText('height =');
    });
  });
}

test('touch tiers: the drag handle, the fx button and the used-by rows are 44 px targets', async ({
  page,
}, info) => {
  const tier = info.project.name as Tier;
  test.skip(tier === 'desktop');
  await open(page, tier, 'light', '&keypad=never');
  const h = async (loc: ReturnType<Page['locator']>) => (await loc.first().boundingBox())?.height;
  expect(await h(page.getByRole('button', { name: 'Use width' }))).toBeGreaterThanOrEqual(44);
  expect(
    await h(page.getByRole('button', { name: 'Parameters for Depth' })),
  ).toBeGreaterThanOrEqual(44);
  const row = page.getByRole('listitem', { name: 'Parameter width' });
  await row.getByRole('button', { name: 'Used by 3' }).click();
  for (const b of await row.getByTestId('param-use').all()) {
    expect((await b.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test('desktop: the drag handle and fx button meet the 24 px minimum target (WCAG 2.2)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop');
  await open(page, 'desktop', 'light');
  for (const loc of [
    page.getByRole('button', { name: 'Use width' }),
    page.getByRole('button', { name: 'Parameters for Depth' }),
  ]) {
    const b = await loc.boundingBox();
    expect(b?.width).toBeGreaterThanOrEqual(24);
    expect(b?.height).toBeGreaterThanOrEqual(24);
  }
});
