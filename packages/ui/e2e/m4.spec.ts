import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M4 UI baselines: every state of every drawing component (the sheet viewer, the tools, the
 * explicit standard choice, views, inspectors, import, needs attention, title block, export,
 * settings, the drawings list and the shell), each with an axe check. Desktop in light and dark,
 * the phone in light, the tablet where touch changes the layout.
 */

type Tier = 'desktop' | 'tablet' | 'phone';

const STATES: Record<string, string[]> = {
  'm4-choice': ['default', 'chosen', 'asme'],
  'm4-viewer': ['default', 'selected', 'attention', 'pending', 'hover'],
  'm4-toolbar': ['default', 'dimension', 'disabled', 'horizontal'],
  'm4-picker': ['default', 'disabled'],
  'm4-views': ['default', 'selected', 'empty', 'problem', 'review'],
  'm4-view-inspector': [
    'default',
    'own-scale',
    'section',
    'detail',
    'config',
    'missing',
    'dependents',
  ],
  'm4-annotation': [
    'default',
    'readonly',
    'attention',
    'tolerance',
    'frame',
    'datum',
    'datum-bad',
    'finish',
    'note',
    'hole',
    'suppressed',
    'radial',
  ],
  'm4-tolerance': ['default', 'stored', 'fit'],
  'm4-import': ['default', 'none', 'empty'],
  'm4-attention': ['default', 'selected', 'empty'],
  'm4-title': ['default', 'override', 'empty', 'warning', 'unused', 'inline'],
  'm4-list': ['default', 'empty', 'review', 'disabled', 'attention'],
  'm4-export': ['default', 'busy', 'sheets', 'attention', 'unavailable'],
  'm4-settings': ['default', 'asme', 'third', 'sheets', 'outdated', 'config', 'missing'],
  'm4-shell': ['default', 'attention', 'sheets'],
  'm4-sheet-tabs': ['default', 'review', 'drop'],
};

/** What touch changes: the other tiers only render these. */
const TOUCH_SECTIONS = new Set([
  'm4-choice',
  'm4-viewer',
  'm4-toolbar',
  'm4-shell',
  'm4-sheet-tabs',
]);

const root = (section: string) => `g-${section}`;

async function open(page: Page, tier: string, theme: string, section: string, state: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}&state=${state}`);
  await page.locator(`[data-testid="${root(section)}"]`).waitFor();
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

for (const theme of ['light', 'dark'] as const) {
  test.describe(`m4 components ${theme}`, () => {
    for (const [section, states] of Object.entries(STATES)) {
      for (const state of states) {
        test(`${section}: ${state} (${theme})`, async ({ page }, info) => {
          const tier = info.project.name as Tier;
          test.skip(theme === 'dark' && tier !== 'desktop', 'dark is baselined on the desktop');
          test.skip(tier === 'tablet' && !TOUCH_SECTIONS.has(section), 'same as the desktop');
          await open(page, tier, theme, section, state);
          await expect(page.getByTestId(root(section))).toHaveScreenshot(
            `m4-${tier}-${theme}-${section.slice(3)}-${state}.png`,
          );
          await a11y(page);
        });
      }
    }
  });
}

test.describe('m4 interactive states', () => {
  test('tolerance field: typed, understood, refused, reverted', async ({ page }, info) => {
    const tier = info.project.name as Tier;
    test.skip(tier !== 'desktop', 'desktop');
    await open(page, tier, 'light', 'm4-tolerance', 'default');
    const input = page.getByRole('textbox', { name: 'Tolerance' });
    await input.fill('+0.1/-0.05');
    await expect(page.getByTestId('tolerance-field')).toContainText('Reads as +0.1/-0.05');
    await expect(page.getByTestId('g-m4-tolerance')).toHaveScreenshot(
      'm4-desktop-light-tolerance-typed.png',
    );
    await a11y(page);
    await input.fill('plus minus');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('g-m4-tolerance')).toHaveScreenshot(
      'm4-desktop-light-tolerance-refused.png',
    );
    await a11y(page);
    await input.press('Escape');
    await expect(input).toHaveValue('');
  });

  test('toolbar: one tab stop, arrows move between tools', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    await open(page, 'desktop', 'light', 'm4-toolbar', 'default');
    await page.getByRole('button', { name: 'Select and move' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Add view' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: 'Import model annotations' })).toBeFocused();
    await page.keyboard.press('Enter');
  });

  test('standard choice: the button waits for an explicit projection', async ({ page }, info) => {
    const tier = info.project.name as Tier;
    await open(page, tier, 'light', 'm4-choice', 'default');
    await expect(page.getByTestId('standard-confirm')).toBeDisabled();
    await page.getByRole('radio', { name: /^Third angle/ }).check({ force: true });
    await expect(page.getByTestId('standard-confirm')).toBeEnabled();
    await expect(page.getByTestId('g-m4-choice')).toHaveScreenshot(
      `m4-${tier}-light-choice-picked.png`,
    );
    await a11y(page);
  });

  test('import: toggling rows moves the count', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    await open(page, 'desktop', 'light', 'm4-import', 'none');
    await expect(page.getByTestId('import-place')).toBeDisabled();
    await page.getByRole('checkbox', { name: /linear dimension/ }).check();
    await expect(page.getByTestId('import-place')).toHaveText('Place 1 annotation');
  });
});
