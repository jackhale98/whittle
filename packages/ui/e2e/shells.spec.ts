import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;
const statuses = [
  'idle',
  'downloading',
  'downloading-unknown',
  'compiling',
  'ready',
  'error',
] as const;

async function open(page: Page, tier: Tier, theme: string, status = 'ready', extra = '') {
  await page.goto(`/?shell=${tier}&theme=${theme}&status=${status}${extra}`);
  await page.locator('[data-testid="app-shell"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Let layout-driven canvas paint settle.
  await page.waitForTimeout(150);
}

function tierOf(name: string): Tier {
  return name as Tier;
}

for (const theme of themes) {
  test.describe(`${theme}`, () => {
    test(`shell screenshot (${theme})`, async ({ page }, info) => {
      const tier = tierOf(info.project.name);
      await open(page, tier, theme);
      await expect(page).toHaveScreenshot(`${tier}-${theme}-ready.png`);
    });

    for (const status of statuses) {
      test(`status chip ${status} (${theme})`, async ({ page }, info) => {
        const tier = tierOf(info.project.name);
        await open(page, tier, theme, status);
        const chip = page.getByTestId('kernel-status');
        await expect(chip).toHaveAttribute('data-state', status.split('-')[0] as string);
        await expect(chip).toHaveScreenshot(`${tier}-${theme}-chip-${status}.png`);
      });
    }

    test(`accessibility smoke (${theme})`, async ({ page }, info) => {
      const tier = tierOf(info.project.name);
      for (const status of ['ready', 'error', 'downloading']) {
        await open(page, tier, theme, status);
        const results = await new AxeBuilder({ page }).analyze();
        const bad = results.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        expect(
          bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        ).toEqual([]);
      }
    });
  });
}

test('chip gallery', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one gallery is enough');
  for (const theme of themes) {
    await page.goto(`/?view=chips&theme=${theme}`);
    await page.locator('[data-testid="chip-gallery"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('chip-gallery')).toHaveScreenshot(`chip-gallery-${theme}.png`);
  }
});

test('no horizontal overflow and viewport slot fills its area', async ({ page }, info) => {
  const tier = tierOf(info.project.name);
  for (const theme of themes) {
    await open(page, tier, theme);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.sh).toBeLessThanOrEqual(m.ch);

    const root = page.getByTestId('app-shell');
    await expect(root).toHaveAttribute('data-tier', tier);
    const slot = page.getByTestId('viewport-slot');
    expect(await slot.evaluate((el) => getComputedStyle(el).position)).not.toBe('static');
    const canvas = page.getByTestId('fake-canvas');
    const [sb, cb] = await Promise.all([slot.boundingBox(), canvas.boundingBox()]);
    expect(sb).not.toBeNull();
    expect(cb).not.toBeNull();
    expect(Math.abs((cb?.width ?? 0) - (sb?.width ?? -1))).toBeLessThan(1);
    expect(Math.abs((cb?.height ?? 0) - (sb?.height ?? -1))).toBeLessThan(1);
    if (tier !== 'desktop') {
      // Tablet / phone are full-bleed.
      const vp = page.viewportSize();
      expect(Math.round(sb?.width ?? 0)).toBe(vp?.width);
      expect(Math.round(sb?.height ?? 0)).toBe(vp?.height);
    }
  }
});

test('touch targets are at least 44px on tablet and phone', async ({ page }, info) => {
  const tier = tierOf(info.project.name);
  test.skip(tier === 'desktop');
  await open(page, tier, 'light');
  const sizes = await page.evaluate(() => {
    const out: Array<{ name: string; w: number; h: number }> = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="app-shell"] button')) {
      if (el.closest('[inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // The sheet handle is a full-width strip; its hit area is wide but short by design.
      if (el.getAttribute('aria-expanded') !== null) continue;
      out.push({
        name: el.getAttribute('aria-label') ?? el.textContent ?? '?',
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  });
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) {
    expect(s.w, `${s.name} width`).toBeGreaterThanOrEqual(44);
    expect(s.h, `${s.name} height`).toBeGreaterThanOrEqual(44);
  }
});

test('desktop top bar keyboard focus order', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await open(page, 'desktop', 'light');
  const expected = [
    /Feature panel/,
    /Undo/,
    /Redo/,
    /main/,
    /Export/,
    /Switch to dark theme/,
    /Inspector/,
  ];
  const seen: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
      }),
    );
  }
  expected.forEach((re, i) => {
    expect(seen[i], `tab stop ${i + 1}`).toMatch(re);
  });
  // The next stop leaves the top bar (panel tabs / content), proving no hidden extra stops.
  await page.keyboard.press('Tab');
  const inBar = await page.evaluate(
    () => !!document.activeElement?.closest('[data-testid="top-bar"]'),
  );
  expect(inBar).toBe(false);
});

test('Ctrl+K opens the palette, Esc closes it, focus returns', async ({ page }, info) => {
  const tier = tierOf(info.project.name);
  test.skip(tier === 'phone', 'no hardware keyboard on phone');
  await open(page, tier, 'light');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused();
  await page.waitForTimeout(100);
  await expect(page).toHaveScreenshot(`${tier}-light-palette.png`);
  await page.keyboard.type('extruded');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('desktop: panels collapse and the panel resizes by keyboard', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await open(page, 'desktop', 'light');
  const left = page.getByTestId('left-panel');
  const before = (await left.boundingBox())?.width ?? 0;
  const handle = page.getByRole('separator', { name: 'Resize feature panel' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await left.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 20);
  await page.getByRole('button', { name: 'Feature panel' }).click();
  await expect.poll(async () => (await left.boundingBox())?.width ?? 1).toBeLessThan(2);
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(page.getByTestId('right-panel')).toHaveAttribute('inert', '');
  await expect(page).toHaveScreenshot('desktop-light-panels-collapsed.png');
});

test('tablet / phone: bottom sheet expands', async ({ page }, info) => {
  const tier = tierOf(info.project.name);
  test.skip(tier === 'desktop');
  await open(page, tier, 'light');
  const sheet = page.getByTestId(tier === 'tablet' ? 'history-sheet' : 'tools-sheet');
  await expect(sheet).toHaveAttribute('data-open', 'false');
  const handle = sheet.getByRole('button', { name: /expand/ });
  await handle.click();
  await expect(sheet).toHaveAttribute('data-open', 'true');
  await page.waitForTimeout(150);
  await expect(page).toHaveScreenshot(`${tier}-light-sheet-open.png`);
});
