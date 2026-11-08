import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type Tier = 'desktop' | 'tablet' | 'phone';
type Box = { x: number; y: number; width: number; height: number };

async function gallery(page: Page, tier: string, theme: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}`);
  await page.locator('[data-testid="gallery"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
}

async function noSeriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

const label = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return (
      el?.getAttribute('aria-label') ??
      el?.getAttribute('data-feature-id') ??
      el?.textContent?.trim().slice(0, 40) ??
      ''
    );
  });

test.describe('feature tree', () => {
  test('keyboard-only: Tab enters on the selected row, arrows move, rollback bar is its own stop', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'tree');
    await page.keyboard.press('Tab');
    // the selected feature (F2) is the roving tab stop
    expect(await label(page)).toBe('F2');
    await page.keyboard.press('ArrowDown');
    expect(await label(page)).toBe('F3');
    await page.keyboard.press('End');
    expect(await label(page)).toBe('F6');
    await page.keyboard.press('Home');
    expect(await label(page)).toBe('F1');
    // one Tab leaves the tree rows and lands on the rollback bar, the next leaves the tree
    await page.keyboard.press('Tab');
    expect(await label(page)).toBe('Rollback bar');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('separator', { name: 'Rollback bar' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    await page.keyboard.press('Home');
    await expect(page.getByRole('separator', { name: 'Rollback bar' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    await page.keyboard.press('End');
    await expect(page.getByRole('separator', { name: 'Rollback bar' })).toHaveAttribute(
      'aria-valuenow',
      '6',
    );
  });

  test('rollback bar follows a pointer drag', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'tree');
    const bar = page.getByRole('separator', { name: 'Rollback bar' });
    const box = (await bar.boundingBox()) as NonNullable<
      Awaited<ReturnType<typeof bar.boundingBox>>
    >;
    const target = (await page.getByRole('treeitem').nth(1).boundingBox()) as NonNullable<
      Awaited<ReturnType<typeof bar.boundingBox>>
    >;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, target.y + target.height - 2, { steps: 8 });
    await page.mouse.up();
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('treeitem', { name: /Chamfer 1/ })).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('gallery')).toHaveScreenshot('i-desktop-tree-rolled.png');
  });

  test('a refused reorder shakes and explains (keyboard)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    for (const theme of ['light', 'dark']) {
      await gallery(page, 'desktop', theme, 'tree');
      await page.getByRole('treeitem', { name: /Fillet 1/ }).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect(page.getByTestId('tree-notice')).toContainText('needs Extrude 1 above it');
      await page.waitForTimeout(500);
      await expect(page.getByTestId('gallery')).toHaveScreenshot(
        `i-desktop-${theme}-tree-refused.png`,
      );
      await noSeriousViolations(page);
    }
  });

  test('a legal reorder moves the row; the context menu opens at the row', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'tree');
    await page.getByRole('treeitem', { name: /Chamfer 1/ }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    const names = await page
      .getByRole('treeitem')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-feature-id')));
    expect(names.slice(2, 5)).toEqual(['F3', 'F5', 'F4']);
    await page.getByRole('treeitem', { name: /Extrude 1/ }).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.waitForTimeout(150);
    await expect(page.getByTestId('gallery')).toHaveScreenshot('i-desktop-tree-menu.png');
    await noSeriousViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
  });

  test('drag a row by its grip to reorder, and a refused drop is explained', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'tree');
    const order = () =>
      page
        .getByRole('treeitem')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-feature-id')));
    const drag = async (id: string, toRowIndex: number) => {
      const row = page.locator(`[data-feature-id="${id}"]`);
      await row.hover();
      const grip = (await row.locator('[data-grip]').boundingBox()) as Box;
      const target = (await page.getByRole('treeitem').nth(toRowIndex).boundingBox()) as Box;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + 2, target.y + target.height - 3, { steps: 10 });
      await page.mouse.up();
    };
    await drag('F4', 4); // Chamfer 1 below Mounting hole
    await expect.poll(order).toEqual(['F1', 'F2', 'F3', 'F5', 'F4', 'F6']);
    await drag('F3', 0); // Fillet above its solid: refused
    await expect(page.getByTestId('tree-notice')).toContainText('needs Extrude 1 above it');
    expect(await order()).toEqual(['F1', 'F2', 'F3', 'F5', 'F4', 'F6']);
  });

  test('touch density rows are at least 44px tall', async ({ page }, info) => {
    test.skip(info.project.name === 'desktop');
    await gallery(page, info.project.name, 'light', 'tree');
    for (const row of await page.getByRole('treeitem').all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('inspector keyboard', () => {
  test('every control in the extrude inspector is reachable by Tab, radio groups are one stop', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'inspectors');
    const card = page.locator('[data-testid="feature-inspector"]').first();
    await card.evaluate((el) => el.setAttribute('data-first', ''));
    await card.getByRole('button', { name: 'Done' }).focus();
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[data-first]'));
      if (!inside) break;
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return `${el.getAttribute('role') ?? (el.tagName === 'INPUT' ? 'textbox' : el.tagName.toLowerCase())}:${el.getAttribute('aria-label') ?? el.textContent?.trim()}`;
        }),
      );
    }
    expect(seen).toEqual([
      'button:Remove Region F1:region(0)',
      'button:Add',
      'radio:Normal',
      'radio:Blind',
      'textbox:Depth',
      'textbox:Draft angle',
      'radio:New',
    ]);
    // arrows inside a radio group select
    await page.getByRole('radio', { name: 'New' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Add' }).first()).toBeFocused();
    await expect(page.getByRole('radio', { name: 'Add' }).first()).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('material picker opens inline and filters', async ({ page }, info) => {
    await gallery(page, info.project.name, 'light', 'inspectors');
    await page.getByRole('button', { name: 'Assign material' }).click();
    await page.getByRole('searchbox').fill('al');
    await expect(page.locator('[data-material]').first()).toBeVisible();
    await page.waitForTimeout(150);
    await expect(page.getByTestId('gallery')).toHaveScreenshot(
      `i-${info.project.name}-material-picker.png`,
    );
    await noSeriousViolations(page);
  });
});

test.describe('expression input', () => {
  test('desktop: typing shows the span error live', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'expr');
    const input = page.getByRole('textbox', { name: 'Locked' });
    await expect(input).toBeDisabled();
    const live = page.getByRole('textbox', { name: 'Depth' });
    await live.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('12mm +');
    await expect(live).toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('ArrowUp'); // no-op on a non-literal without crashing
    await page.keyboard.press('Escape');
    await expect(live).toHaveValue('25mm');
    await page.keyboard.press('ArrowUp');
    await expect(live).toHaveValue('26mm');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(live).toHaveValue('16mm');
  });

  test('touch: focusing opens the inline keypad instead of the OS keyboard', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'desktop');
    await gallery(page, info.project.name, 'light', 'expr');
    const field = page.getByRole('textbox', { name: 'Angle' });
    await field.tap();
    const pad = page.getByTestId('keypad');
    await expect(pad).toBeVisible();
    await expect(field).toHaveAttribute('inputmode', 'none');
    await pad.getByRole('button', { name: '4', exact: true }).tap();
    await pad.getByRole('button', { name: '5', exact: true }).tap();
    await pad.getByRole('button', { name: 'deg (degrees)' }).tap();
    await expect(field).toHaveValue('45deg');
    await expect(field).toBeFocused();
    // every key is a comfortable touch target
    for (const b of await pad.getByRole('button').all()) {
      const box = await b.boundingBox();
      if ((await b.getAttribute('aria-label')) === 'Use the system keyboard') continue;
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    const vp = page.viewportSize();
    const pb = await pad.boundingBox();
    expect((pb?.x ?? 0) + (pb?.width ?? 0)).toBeLessThanOrEqual(vp?.width ?? 0);
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`i-${info.project.name}-keypad.png`);
    await noSeriousViolations(page);
    await pad.getByRole('button', { name: 'Enter' }).tap();
    await expect(pad).toBeHidden();
  });
});

test.describe('popovers', () => {
  test('export menu: non-modal, keyboard operable, within the viewport', async ({ page }, info) => {
    const tier = info.project.name as Tier;
    for (const theme of tier === 'desktop' ? ['light', 'dark'] : ['light']) {
      await gallery(page, tier, theme, 'popovers');
      const trigger = page.getByRole('button', { name: 'Export' });
      await trigger.click();
      const pop = page.getByTestId('export-popover');
      await expect(pop.getByTestId('export-form')).toBeVisible();
      await page.waitForTimeout(200);
      const vp = page.viewportSize();
      const b = await pop.boundingBox();
      expect(b?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(vp?.width ?? 0);
      expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(vp?.height ?? 0);
      await pop.getByRole('radio', { name: /STL/ }).click();
      await page.waitForTimeout(150);
      await expect(page).toHaveScreenshot(`i-${tier}-${theme}-export.png`);
      await noSeriousViolations(page);
      await pop.getByRole('radio', { name: 'Fine' }).click();
      await pop.getByRole('button', { name: 'Export STL' }).click();
      await expect(pop).toBeHidden();
      await expect(page.getByTestId('last-export')).toContainText('"quality":"fine"');
      await expect(page.getByTestId('last-export')).toContainText('"target":"stl"');
    }
  });

  test('export menu closes with Esc and returns focus to the button', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'popovers');
    const trigger = page.getByRole('button', { name: 'Export' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('export-form')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-form')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('which-one chooser: keyboard pick', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'chooser');
    await expect(page.getByRole('option').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option').nth(1)).toBeFocused();
  });
});

test.describe('sketch UI', () => {
  test('toolbar shortcuts toggle tools in the browser', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await gallery(page, 'desktop', 'light', 'sketch');
    const tool = (n: string) => page.getByRole('button', { name: n, exact: true });
    await page.keyboard.press('a');
    await expect(tool('Arc')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Shift+C');
    await expect(tool('Circle')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('d');
    await expect(tool('Dimension')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(tool('Dimension')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('x');
    await expect(page.getByRole('button', { name: 'Construction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('constraints menu screenshot', async ({ page }, info) => {
    test.skip(info.project.name === 'phone');
    await gallery(page, info.project.name, 'light', 'sketch');
    await page.getByRole('button', { name: 'Constraints' }).click();
    await expect(page.getByRole('menu', { name: 'Constraints' })).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot(`i-${info.project.name}-constraints-menu.png`);
    await noSeriousViolations(page);
  });
});

test.describe('data-driven shells', () => {
  test('desktop: select a feature, edit depth, see the inspector update; Params tab works', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop');
    await page.goto('/?shell=desktop&theme=light&data=1');
    await page.getByTestId('app-shell').waitFor();
    await page.getByRole('treeitem', { name: /Fillet 1/ }).click();
    await expect(page.getByTestId('feature-inspector')).toContainText('Fillet 1');
    await expect(page.getByTestId('feature-inspector').getByRole('alert')).toContainText(
      'too large',
    );
    await page.getByRole('tab', { name: 'Params' }).click();
    await expect(page.getByRole('list', { name: 'Parameters' })).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('s-desktop-light-params-tab.png');
    await noSeriousViolations(page);
  });

  test('desktop: part inspector with material', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await page.goto('/?shell=desktop&theme=dark&data=1&inspector=part');
    await page.getByTestId('app-shell').waitFor();
    await page.waitForTimeout(250);
    await expect(page).toHaveScreenshot('s-desktop-dark-part.png');
  });

  test('tablet: history sheet shows the tree', async ({ page }, info) => {
    test.skip(info.project.name !== 'tablet');
    await page.goto('/?shell=tablet&theme=light&data=1');
    await page.getByTestId('app-shell').waitFor();
    await page.getByRole('button', { name: /History, expand/ }).click();
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('s-tablet-light-history.png');
    await noSeriousViolations(page);
  });

  test('phone: params and export tabs', async ({ page }, info) => {
    test.skip(info.project.name !== 'phone');
    await page.goto('/?shell=phone&theme=light&data=1');
    await page.getByTestId('app-shell').waitFor();
    await page.getByRole('button', { name: 'Params' }).click();
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot('s-phone-light-params.png');
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByTestId('export-form')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('s-phone-light-export.png');
    await noSeriousViolations(page);
  });
});
