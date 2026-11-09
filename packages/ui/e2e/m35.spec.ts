import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * M3.5 UI: baselines for every state of the radial menu, Which-one chooser, keymap editor, shortcut
 * overlay, navigation settings, error-at-cause messages, conflict panel, curvature glyph and curve
 * tools (desktop, tablet, phone; light and dark; each with an axe check), plus the interactions:
 * a flick before the menu draws, Tab cycling, keymap conflict flags and the 600 ms overlay.
 */

type Tier = 'desktop' | 'tablet' | 'phone';
const themes = ['light', 'dark'] as const;

async function open(page: Page, tier: string, theme: string, section: string, extra = '') {
  await page.goto(`/?view=gallery&section=${section}&shell=${tier}&theme=${theme}${extra}`);
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

for (const theme of themes) {
  test.describe(`m35 states ${theme}`, () => {
    for (const state of ['open', 'edge', 'touch', 'repeat-disabled', 'norepeat']) {
      test(`radial menu: ${state} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, 'm35-radial', `&state=${state}`);
        await expect(page.getByRole('menu', { name: 'Commands' })).toBeVisible();
        await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-radial-${state}.png`);
        await a11y(page);
      });
    }

    test(`radial menu: hovered item (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-radial', '&state=open');
      await page.getByRole('menuitem', { name: 'Measure' }).hover();
      await expect(page.getByRole('menuitem', { name: 'Measure' })).toHaveAttribute(
        'data-active',
        '',
      );
      await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-radial-hover.png`);
    });

    for (const state of ['md', 'touch']) {
      test(`which-one chooser: ${state} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, 'm35-chooser', `&state=${state}`);
        await expect(page.getByRole('listbox')).toBeVisible();
        await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-chooser-${state}.png`);
        await a11y(page);
      });
    }

    test(`which-one chooser: preselected by Tab (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-chooser');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('preselect')).toHaveText('preselected: e2');
      await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-chooser-tab.png`);
    });

    test(`keymap editor (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-keymap');
      await expect(page.getByTestId('g-m35-keymap')).toHaveScreenshot(
        `m35-${tier}-${theme}-keymap.png`,
      );
      await a11y(page);
    });

    test(`keymap editor: browser-blocked key (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-keymap');
      await page.getByRole('button', { name: 'Add shortcut for Extrude' }).click();
      await page.keyboard.press('Control+KeyW');
      await expect(page.getByTestId('keymap-conflict')).toHaveAttribute('data-severity', 'blocked');
      await expect(page.getByTestId('g-m35-keymap')).toHaveScreenshot(
        `m35-${tier}-${theme}-keymap-blocked.png`,
      );
      await a11y(page);
    });

    test(`keymap editor: command conflict (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-keymap');
      await page.getByRole('button', { name: 'Add shortcut for Extrude' }).click();
      await page.keyboard.press('KeyF');
      await expect(page.getByTestId('keymap-conflict')).toContainText('already used by Fillet');
      await expect(page.getByTestId('g-m35-keymap')).toHaveScreenshot(
        `m35-${tier}-${theme}-keymap-conflict.png`,
      );
      await a11y(page);
    });

    for (const state of ['sketch', 'model']) {
      test(`shortcut overlay: ${state} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, 'm35-overlay', `&state=${state}&forced=1`);
        await expect(page.getByTestId('shortcut-overlay')).toBeVisible();
        await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-overlay-${state}.png`);
        await a11y(page);
      });
    }

    for (const state of ['default', 'custom']) {
      test(`navigation settings: ${state} (${theme})`, async ({ page }, info) => {
        const tier = info.project.name as Tier;
        await open(page, tier, theme, 'm35-nav', `&state=${state}`);
        await expect(page.getByTestId('g-m35-nav')).toHaveScreenshot(
          `m35-${tier}-${theme}-nav-${state}.png`,
        );
        await a11y(page);
      });
    }

    test(`errors at their cause (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-errors');
      await expect(page.getByTestId('g-m35-errors')).toHaveScreenshot(
        `m35-${tier}-${theme}-errors.png`,
      );
      await a11y(page);
    });

    test(`sketch: curve tools, G2 glyph, conflicts (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-sketch');
      await expect(page.getByTestId('g-m35-sketch')).toHaveScreenshot(
        `m35-${tier}-${theme}-sketch.png`,
      );
      await a11y(page);
    });

    test(`sketch: Curves menu (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, 'm35-sketch');
      await page.getByRole('button', { name: 'Curves' }).click();
      await expect(page.getByRole('menu', { name: 'Curve tools' })).toBeVisible();
      await expect(page).toHaveScreenshot(`m35-${tier}-${theme}-curves-menu.png`);
      await a11y(page);
    });
  });
}

for (const theme of themes) {
  for (const section of ['m35-dim', 'm35-lineage'] as const) {
    test(`${section} (${theme})`, async ({ page }, info) => {
      const tier = info.project.name as Tier;
      await open(page, tier, theme, section);
      await expect(page.getByTestId(`g-${section}`)).toHaveScreenshot(
        `m35-${tier}-${theme}-${section}.png`,
      );
      await a11y(page);
    });
  }
}

test.describe('m35 interactions', () => {
  test('dragging a dimension label moves it without editing; a tap edits', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'mouse');
    await open(page, 'desktop', 'light', 'm35-dim');
    const stage = page.getByTestId('dim-drag-stage');
    const label = stage.getByRole('button', { name: /Dimension/ });
    const box = (await label.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy + 25, { steps: 5 });
    await page.mouse.up();
    await expect(stage.getByTestId('dim-pos')).toHaveText('170,95');
    await expect(page.getByTestId('dimension-editor')).toHaveCount(0);
    await label.click();
    await expect(page.getByTestId('dimension-editor')).toBeVisible();
  });

  test('lineage: Edit and select buttons call back', async ({ page }) => {
    await open(page, 'desktop', 'light', 'm35-lineage');
    await page.getByRole('button', { name: 'Edit Sketch 1' }).click();
    await expect(page.getByTestId('lineage-log')).toContainText('edit S0');
    await page.getByRole('button', { name: 'Fillet 2', exact: true }).click();
    await expect(page.getByTestId('lineage-log')).toContainText('select F2');
  });

  test('a flick on the radial menu runs its command before the menu draws; Repeat then repeats it', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'mouse flick');
    await open(page, 'desktop', 'light', 'm35-radial-live');
    const surface = page.getByTestId('radial-surface');
    const box = (await surface.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Right click, then flick east within 100 ms: nothing has been drawn yet.
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.mouse.move(cx + 70, cy);
    await expect(page.getByTestId('radial-log')).toContainText('select sketch');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('radial-last')).toHaveText('last command: sketch');

    // Now there is a last command: the fixed north slot repeats it, again by a blind flick.
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.mouse.move(cx, cy - 70);
    await expect(page.getByTestId('radial-log')).toContainText('select repeat');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('the menu draws after about 250 ms, with Repeat in the north slot', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'mouse');
    await open(page, 'desktop', 'light', 'm35-radial-live');
    const box = (await page.getByTestId('radial-surface').boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.mouse.move(cx + 70, cy);
    await expect(page.getByTestId('radial-last')).toHaveText('last command: sketch');
    await page.mouse.click(cx, cy, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Commands' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Repeat sketch' })).toHaveAttribute(
      'data-slot',
      'n',
    );
  });

  test('Esc cancels, and a click outside cancels without reaching the canvas', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'mouse');
    await open(page, 'desktop', 'light', 'm35-radial-live');
    const box = (await page.getByTestId('radial-surface').boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.waitForTimeout(350);
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    await page.mouse.click(cx, cy, { button: 'right' });
    await page.waitForTimeout(350);
    await expect(page.getByRole('menu')).toBeVisible();
    await page.mouse.click(cx - 100, cy); // a left click on the canvas, outside every item
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('radial-log')).not.toContainText('canvas click');
    await page.mouse.click(cx - 100, cy); // the swallow is one-shot
    await expect(page.getByTestId('radial-log')).toContainText('canvas click');
  });

  test('the radial menu is operable by keyboard: digits and arrows', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'keyboard');
    await open(page, 'desktop', 'light', 'm35-radial-live');
    const surface = page.getByTestId('radial-surface');
    await surface.focus();
    const box = (await surface.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await page.mouse.click(box.x + 40, box.y + 40, { button: 'right' });
    await page.waitForTimeout(350);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Sketch' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('radial-log')).toContainText('select sketch');
  });

  test('Tab / Shift+Tab cycle the chooser preselection in a stable order, identical across runs', async ({
    page,
  }) => {
    const readOrder = async () => {
      await open(page, 'desktop', 'light', 'm35-chooser');
      return page
        .getByRole('option')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    };
    const first = await readOrder();
    expect(first).toEqual(['v1', 'e1', 'e2', 'f1', 'b1']);
    for (let i = 0; i < 3; i++) expect(await readOrder()).toEqual(first);

    const pre = page.getByTestId('preselect');
    await expect(pre).toHaveText('preselected: v1');
    for (const want of ['e1', 'e2', 'f1', 'b1', 'v1']) {
      await page.keyboard.press('Tab');
      await expect(pre).toHaveText(`preselected: ${want}`);
    }
    await page.keyboard.press('Shift+Tab');
    await expect(pre).toHaveText('preselected: b1');
  });

  test('hovering a chooser row preselects it', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'hover');
    await open(page, 'desktop', 'light', 'm35-chooser');
    await page.getByRole('option', { name: /Top face/ }).hover();
    await expect(page.getByTestId('preselect')).toHaveText('preselected: f1');
  });

  test('keymap editor flags Ctrl+W and Ctrl+T as browser shortcuts and refuses them', async ({
    page,
  }) => {
    await open(page, 'desktop', 'light', 'm35-keymap');
    for (const [chord, action] of [
      ['Control+KeyW', 'Close tab'],
      ['Control+KeyT', 'New tab'],
      ['Control+KeyN', 'New window'],
    ] as const) {
      await page.getByRole('button', { name: 'Add shortcut for Extrude' }).click();
      await page.keyboard.press(chord);
      const note = page.getByTestId('keymap-conflict');
      await expect(note).toHaveAttribute('data-severity', 'blocked');
      await expect(note).toContainText(`browser shortcut (${action})`);
      await expect(note.getByRole('button', { name: /Use anyway|Reassign/ })).toHaveCount(0);
      await note.getByRole('button', { name: 'Cancel' }).click();
    }
    await expect(page.locator('[data-command="tool:extrude"] [data-binding]')).toHaveCount(1);
  });

  test('keymap editor flags a conflict with another command and reassigns on request', async ({
    page,
  }) => {
    await open(page, 'desktop', 'light', 'm35-keymap');
    await page.getByRole('button', { name: 'Add shortcut for Extrude' }).click();
    await page.keyboard.press('KeyF');
    await page
      .getByTestId('keymap-conflict')
      .getByRole('button', { name: 'Reassign here' })
      .click();
    await expect(page.locator('[data-command="tool:extrude"] [data-binding="KeyF"]')).toHaveCount(
      1,
    );
    await expect(page.locator('[data-command="tool:fillet"] [data-binding]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reset all' }).click();
    await expect(page.locator('[data-command="tool:fillet"] [data-binding="KeyF"]')).toHaveCount(1);
  });

  test('holding Ctrl for 600 ms shows the overlay of the shortcuts available now', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'keyboard');
    await open(page, 'desktop', 'light', 'm35-overlay');
    const overlay = page.getByTestId('shortcut-overlay');
    await page.keyboard.down('Control');
    await page.waitForTimeout(350);
    await expect(overlay).toHaveCount(0);
    await expect(overlay).toBeVisible({ timeout: 1500 });
    await expect(overlay.getByText('Line', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Extrude', { exact: true })).toHaveCount(0);
    await page.keyboard.up('Control');
    await expect(overlay).toHaveCount(0);

    // A chord is not a hold.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.waitForTimeout(800);
    await expect(overlay).toHaveCount(0);
    await page.keyboard.up('Control');
  });

  test('sketch shortcuts follow the physical key, whatever character it types', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'keyboard');
    await open(page, 'desktop', 'light', 'm35-sketch');
    // AZERTY: the physical B key types "b"; the physical key that types "n" on QWERTY is KeyN.
    // Dispatch KeyB while the layout would type a different character.
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyE', key: 'x', shiftKey: true, bubbles: true }),
      );
    });
    await page.getByRole('button', { name: 'Curves' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /Ellipse/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('selecting the cause in an error message selects that feature', async ({ page }) => {
    await open(page, 'desktop', 'light', 'm35-errors');
    await expect(page.getByTestId('selected-feature')).toHaveText('selected: F2');
    await page.getByRole('alert').getByRole('button', { name: 'Select Extrude 1' }).click();
    await expect(page.getByTestId('selected-feature')).toHaveText('selected: X1');
  });

  test('hovering a conflict highlights its constraints through the callback', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'hover');
    await open(page, 'desktop', 'light', 'm35-sketch');
    await page.getByTestId('conflict-card').first().hover();
    await expect(page.getByTestId('highlight')).toHaveText('highlighted: C3,C7');
    await expect(page.getByRole('button', { name: /Remove “Angle 30°/ })).toHaveAttribute(
      'data-suggested',
      '',
    );
  });
});
