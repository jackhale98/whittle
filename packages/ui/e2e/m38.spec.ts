import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M3.8 UI: baselines for every state of the radial menu editor (desktop, tablet, phone; light and
 * dark; each with an axe check), plus the keyboard-only path and a drag from the command list.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;

async function open(page: Page, tier: string, theme: string, state = 'default') {
  await page.goto(
    `/?view=gallery&section=m38-radial-editor&shell=${tier}&theme=${theme}&state=${state}`,
  );
  await page.locator('[data-testid="g-m38-editor"]').waitFor();
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
  test.describe(`m38 radial editor ${theme}`, () => {
    for (const state of ['default', 'modified', 'notice', 'delay', 'off']) {
      test(`state ${state} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, state);
        await expect(page.getByTestId('g-m38-editor')).toHaveScreenshot(
          `m38-${tier}-${theme}-editor-${state}.png`,
        );
        await a11y(page);
      });
    }

    test(`slot chosen, search filtered (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme);
      await page.getByRole('button', { name: /^slot 5, south-west: empty/i }).click();
      await expect(page.getByRole('searchbox', { name: 'Search commands' })).toBeFocused();
      await page.keyboard.type('f');
      await expect(page.getByTestId('g-m38-editor')).toHaveScreenshot(
        `m38-${tier}-${theme}-editor-chosen.png`,
      );
      await a11y(page);
    });
  });
}

test('keyboard only: choose a slot, pick a command, clear it', async ({ page }, info) => {
  await open(page, info.project.name, 'light');
  const slot = page.getByRole('button', { name: /^slot 5, south-west: empty/i });
  await slot.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('fillet');
  await page.getByRole('button', { name: /^fillet, place in slot 5/i }).focus();
  await page.keyboard.press('Enter');
  const placed = page.getByRole('button', { name: /^slot 5, south-west: fillet/i });
  await expect(placed).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('button', { name: /^slot 5, south-west: empty/i })).toBeFocused();
});

test('a command dragged from the list lands in the slot', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'pointer drag is a desktop path');
  await open(page, 'desktop', 'light');
  await page
    .locator('[data-command-id="extrude"]')
    .dragTo(page.getByRole('button', { name: /^slot 5, south-west: empty/i }));
  await expect(page.getByRole('button', { name: /^slot 5, south-west: extrude/i })).toBeVisible();
});

test('touch targets are at least 44 px on the phone', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone only');
  await open(page, 'phone', 'light');
  const boxes = await page
    .locator('[data-testid="g-m38-editor"] button, [data-testid="g-m38-editor"] select')
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { n: e.textContent?.slice(0, 20) ?? '', h: r.height };
        }),
    );
  for (const b of boxes) expect(b.h, b.n).toBeGreaterThanOrEqual(43.5);
});
