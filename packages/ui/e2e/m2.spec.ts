import AxeBuilder from '@axe-core/playwright';
import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';

/**
 * M2 touch & tablet specs. Projects: ipad-landscape (1180x820), ipad-portrait (820x1180) and
 * iphone (390x844), all with touch. Every component state gets a visual baseline.
 */

const isPhone = (name: string) => name === 'iphone';
const tierFor = (name: string) => (isPhone(name) ? 'phone' : 'tablet');

async function open(page: Page, project: string, extra = '', theme = 'light') {
  await page.goto(`/?shell=${tierFor(project)}&theme=${theme}&data=1&status=ready${extra}`);
  await page.getByTestId('app-shell').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function gallery(page: Page, project: string, section: string) {
  await page.goto(`/?view=gallery&section=${section}&shell=${tierFor(project)}&theme=light`);
  await page.getByTestId('gallery').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(120);
}

/** Opens a tablet side panel from its top-bar button (docked at 1180, an overlay at 820). */
async function openPanel(page: Page, side: 'left' | 'right') {
  const toggle = page.getByTestId(`${side}-toggle`);
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
}

async function noSeriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

/** Every visible, non-inert button / slider / text field inside `root` is at least 44x44. */
async function expectTouchTargets(root: Locator, skip: (name: string) => boolean = () => false) {
  const sizes = await root.evaluate((el) => {
    const out: Array<{ name: string; w: number; h: number }> = [];
    for (const b of el.querySelectorAll<HTMLElement>(
      'button, input:not([type="hidden"]), [role="switch"], [role="radio"]',
    )) {
      if (b.closest('[inert]')) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({
        name: b.getAttribute('aria-label') ?? b.textContent?.trim() ?? b.tagName,
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  });
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) {
    if (skip(s.name)) continue;
    expect(s.w, `${s.name} width`).toBeGreaterThanOrEqual(44);
    expect(s.h, `${s.name} height`).toBeGreaterThanOrEqual(44);
  }
}

/** A real touch drag through CDP (pointerType "touch"), with small waits so velocity is sane. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { steps = 12, stepMs = 16 } = {},
) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const at = (k: number) => [
    {
      x: from.x + ((to.x - from.x) * k) / steps,
      y: from.y + ((to.y - from.y) * k) / steps,
      id: 1,
    },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= steps; k++) {
    await page.waitForTimeout(stepMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const centre = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

const settle = (page: Page) => page.waitForTimeout(450);

/* ------------------------------------------------------------------ bottom sheet */

// The bottom sheet is the phone's alone (ADR-099); the tablet's panels are in tablet-panels.spec.ts.
test.describe('bottom sheet', () => {
  const sheetId = () => 'tools-sheet';

  test('snap points: tap cycles peek/half, keys reach full, shots per state', async ({
    page,
  }, info) => {
    const p = info.project.name;
    test.skip(!isPhone(p), 'the phone sheet only');
    await open(page, p);
    const sheet = page.getByTestId(sheetId());
    await expect(sheet).toHaveAttribute('data-snap', 'peek');
    await expect(page).toHaveScreenshot(`m2-${p}-sheet-peek.png`);

    await sheet.getByRole('button', { name: /expand/ }).tap();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-sheet-half.png`);

    const handle = sheet.getByRole('button', { name: /collapse/ });
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect(sheet).toHaveAttribute('data-snap', 'full');
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-sheet-full.png`);
    // full never runs under the top bar / notch
    const top = (await sheet.boundingBox())?.y ?? 0;
    expect(top).toBeGreaterThanOrEqual(56);
    await noSeriousViolations(page);

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-snap', 'peek');
  });

  test('drag with a finger: slow drag settles on the nearest snap, fling goes further', async ({
    page,
  }, info) => {
    const p = info.project.name;
    test.skip(!isPhone(p), 'the phone sheet only');
    await open(page, p);
    const sheet = page.getByTestId(sheetId());
    const grip = page.getByTestId(`${sheetId()}-grip`);
    const vh = page.viewportSize()?.height ?? 800;

    // slow drag up to roughly the half height
    let from = await centre(sheet.getByRole('button', { name: /expand/ }));
    await touchDrag(page, from, { x: from.x, y: from.y - vh * 0.3 }, { steps: 20, stepMs: 30 });
    await settle(page);
    await expect(sheet).toHaveAttribute('data-snap', 'half');

    // a quick fling upward reaches full
    from = await centre(grip);
    await touchDrag(page, from, { x: from.x, y: from.y - vh * 0.4 }, { steps: 4, stepMs: 6 });
    await settle(page);
    await expect(sheet).toHaveAttribute('data-snap', 'full');

    // and a fling down collapses it all the way
    from = await centre(grip);
    await touchDrag(page, from, { x: from.x, y: from.y + vh * 0.85 }, { steps: 6, stepMs: 6 });
    await settle(page);
    await expect(sheet).toHaveAttribute('data-snap', 'peek');
    // the viewport behind never shrank
    const slot = await page.getByTestId('viewport-slot').boundingBox();
    expect(Math.round(slot?.height ?? 0)).toBe(vh);
  });

  test('a tap on a header button is not swallowed by the drag surface', async ({ page }, info) => {
    const p = info.project.name;
    test.skip(!isPhone(p));
    await open(page, p);
    await page.getByRole('button', { name: 'Measure' }).tap();
    await expect(page.getByTestId('tools-sheet')).toHaveAttribute('data-snap', 'half');
    await expect(page.getByRole('button', { name: 'Measure' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/* ------------------------------------------------------------------ command bar (tablet, touch density) */

test.describe('tablet command bar', () => {
  test('groups, flyout, tool selection, touch targets, axe', async ({ page }, info) => {
    const p = info.project.name;
    test.skip(isPhone(p));
    await open(page, p);
    const rail = page.getByRole('toolbar', { name: 'Modeling tools' });
    for (const name of ['Sketch', 'Solid tools', 'Modify tools', 'Inspect tools', 'More']) {
      await expect(rail.getByRole('button', { name })).toBeVisible();
    }
    await expectTouchTargets(rail);
    await expect(page).toHaveScreenshot(`m2-${p}-commandbar.png`);

    await rail.getByRole('button', { name: 'Solid tools' }).tap();
    const flyout = page.getByTestId('tool-flyout');
    await expect(flyout).toBeVisible();
    await expectTouchTargets(flyout);
    await page.waitForTimeout(120);
    await expect(page).toHaveScreenshot(`m2-${p}-commandbar-flyout.png`);
    await noSeriousViolations(page);

    await flyout.getByRole('button', { name: /^Extrude(?!d)/ }).tap();
    await expect(flyout).toBeHidden();
    await expect(rail.getByRole('button', { name: 'Solid tools' })).toHaveAttribute('data-active');
    // an outside tap closes a flyout
    await rail.getByRole('button', { name: 'Modify tools' }).tap();
    await expect(page.getByTestId('tool-flyout')).toBeVisible();
    await page.mouse.click(700, 300);
    await expect(page.getByTestId('tool-flyout')).toBeHidden();
  });
});

/* ------------------------------------------------------------------ context bubble */

test.describe('context bubble', () => {
  test('follows the anchor, never covers it, flips at the edges', async ({ page }, info) => {
    const p = info.project.name;
    const win = page.viewportSize() ?? { width: 0, height: 0 };
    // Anchors are in view (stage) px: the tablet's stage sits below the top bar (ADR-099).
    await open(page, p);
    const stage = (await page.getByTestId('viewport-slot').boundingBox()) ?? {
      x: 0,
      y: 0,
      width: win.width,
      height: win.height,
    };
    const vp = { width: stage.width, height: stage.height };
    const anchors = [
      { name: 'centre', x: vp.width / 2, y: vp.height / 2, side: 'above' },
      { name: 'top', x: vp.width / 2, y: 90, side: 'below' },
      { name: 'left', x: 14, y: vp.height / 2, side: 'above' },
      { name: 'right', x: vp.width - 10, y: vp.height / 2, side: 'above' },
    ];
    for (const a of anchors) {
      await open(page, p, `&bubble=${Math.round(a.x)},${Math.round(a.y)}`);
      const bubble = page.getByTestId('context-bubble');
      await expect(bubble).toHaveAttribute('data-anchored', '');
      await expect(bubble).toHaveAttribute('data-side', a.side);
      const b = await bubble.boundingBox();
      if (!b) throw new Error('no bubble box');
      // fully on screen
      expect(b.x).toBeGreaterThanOrEqual(stage.x);
      expect(b.y).toBeGreaterThanOrEqual(stage.y);
      expect(b.x + b.width).toBeLessThanOrEqual(stage.x + vp.width);
      expect(b.y + b.height).toBeLessThanOrEqual(stage.y + vp.height);
      // the anchor point is never inside the bubble
      const ax = stage.x + a.x;
      const ay = stage.y + a.y;
      const inside = ax >= b.x && ax <= b.x + b.width && ay >= b.y && ay <= b.y + b.height;
      expect(inside, `anchor ${a.name} covered`).toBe(false);
      if (a.name === 'centre' || a.name === 'top') {
        await page.waitForTimeout(150);
        await expect(page).toHaveScreenshot(`m2-${p}-bubble-${a.name}.png`);
      }
    }
    await open(page, p, `&bubble=${Math.round(vp.width / 2)},${Math.round(vp.height / 2)}`);
    const bar = page.getByRole('toolbar', { name: 'Face actions' });
    await expectTouchTargets(bar);
    await noSeriousViolations(page);
    await bar.getByRole('button', { name: 'Extrude' }).tap();
    await expect(page.getByTestId('context-bubble')).toBeVisible();
  });
});

/* ------------------------------------------------------------------ keypad */

test.describe('inline keypad', () => {
  test('opens below a field near the top, above one near the bottom, never covers it', async ({
    page,
  }, info) => {
    const p = info.project.name;
    await gallery(page, p, 'keypad');
    const pad = page.getByTestId('keypad');
    const vp = page.viewportSize() ?? { width: 0, height: 0 };

    const top = page.getByRole('textbox', { name: 'Top field' });
    await top.tap();
    await expect(pad).toBeVisible();
    await expect(pad).toHaveAttribute('data-placement', 'below');
    await expect(top).toHaveAttribute('inputmode', 'none');
    const tb = await top.boundingBox();
    const pb = await pad.boundingBox();
    expect((pb?.y ?? 0) >= (tb?.y ?? 0) + (tb?.height ?? 0)).toBe(true);
    expect((pb?.x ?? 0) + (pb?.width ?? 0)).toBeLessThanOrEqual(vp.width);
    expect(pb?.x ?? -1).toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`m2-${p}-keypad-below.png`);

    // every key is a comfortable touch target (the keyboard toggle too)
    await expectTouchTargets(pad);
    await noSeriousViolations(page);
    await page.keyboard.press('Escape');
    await expect(pad).toBeHidden();

    const bottom = page.getByRole('textbox', { name: 'Bottom field' });
    await bottom.tap();
    await expect(pad).toBeVisible();
    await expect(pad).toHaveAttribute('data-placement', 'above');
    const bb = await bottom.boundingBox();
    const pb2 = await pad.boundingBox();
    expect((pb2?.y ?? 0) + (pb2?.height ?? 0)).toBeLessThanOrEqual(bb?.y ?? 0);
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`m2-${p}-keypad-above.png`);
  });

  test('expression row, units, parameter names and the keyboard toggle drive the field', async ({
    page,
  }, info) => {
    const p = info.project.name;
    await gallery(page, p, 'keypad');
    const field = page.getByRole('textbox', { name: 'Top field' });
    await field.tap();
    const pad = page.getByTestId('keypad');
    const key = (name: string) => pad.getByRole('button', { name, exact: true });
    await key('AC (clear)').tap();
    await key('2').tap();
    await key('parameter width').tap();
    await key('plus').tap();
    await key('open parenthesis').tap();
    await key('1').tap();
    await key('divide').tap();
    await key('8').tap();
    await key('close parenthesis').tap();
    await key('in (inches)').tap();
    await expect(field).toHaveValue('2 * width + (1 / 8)in');
    await expect(field).toBeFocused();
    await key('Backspace').tap();
    await key('Backspace').tap();
    await expect(field).toHaveValue('2 * width + (1 / 8)');
    await key('Move cursor left').tap();
    await key('7').tap();
    await expect(field).toHaveValue('2 * width + (1 / 87)');

    // hand over to the system keyboard and back
    await pad.getByRole('button', { name: 'Use the system keyboard' }).tap();
    await expect(pad).toBeHidden();
    await expect(field).toHaveAttribute('inputmode', 'text');
    await page.getByRole('button', { name: 'Use the numeric keypad' }).tap();
    await expect(pad).toBeVisible();
    await expect(field).toHaveAttribute('inputmode', 'none');
  });
});

/* ------------------------------------------------------------------ push/pull value chip */

test.describe('value chip', () => {
  test('floats beside the drag point while dragging; tap to type an exact value', async ({
    page,
  }, info) => {
    const p = info.project.name;
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    const at = `${Math.round(vp.width / 2)},${Math.round(vp.height * 0.4)}`;
    await open(page, p, `&chip=${at}&chipstate=drag`);
    const chip = page.getByTestId('value-chip');
    await expect(chip).toHaveAttribute('data-dragging', 'true');
    await expect(chip).toContainText('12.5 mm');
    const [px, py] = at.split(',').map(Number) as [number, number];
    const cb = await chip.boundingBox();
    if (!cb) throw new Error('no chip');
    expect(px >= cb.x && px <= cb.x + cb.width && py >= cb.y && py <= cb.y + cb.height).toBe(false);
    await page.waitForTimeout(120);
    await expect(page).toHaveScreenshot(`m2-${p}-chip-dragging.png`);

    await open(page, p, `&chip=${at}`);
    const button = page.getByRole('button', { name: /Distance 12\.5 mm\. Tap to type/ });
    await expectTouchTargets(page.getByTestId('value-chip'));
    await page.waitForTimeout(120);
    await expect(page).toHaveScreenshot(`m2-${p}-chip-rest.png`);
    await button.tap();
    const field = page.getByRole('textbox', { name: 'Distance' });
    await expect(field).toBeFocused();
    await expect(page.getByTestId('keypad')).toBeVisible();
    // keypad never covers the field
    const fb = await field.boundingBox();
    const kb = await page.getByTestId('keypad').boundingBox();
    const overlap =
      !!fb &&
      !!kb &&
      fb.x < kb.x + kb.width &&
      fb.x + fb.width > kb.x &&
      fb.y < kb.y + kb.height &&
      fb.y + fb.height > kb.y;
    expect(overlap).toBe(false);
    await page.waitForTimeout(150);
    await expect(page).toHaveScreenshot(`m2-${p}-chip-typing.png`);
    await noSeriousViolations(page);
    const pad = page.getByTestId('keypad');
    await pad.getByRole('button', { name: 'AC (clear)' }).tap();
    await pad.getByRole('button', { name: '2', exact: true }).tap();
    await pad.getByRole('button', { name: '0', exact: true }).tap();
    await pad.getByRole('button', { name: 'mm (millimetres)' }).tap();
    await pad.getByRole('button', { name: 'Enter' }).tap();
    await expect(page.getByRole('button', { name: /Distance 20 mm/ })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ phone panels */

test.describe('phone viewer panels', () => {
  test.beforeEach(({ page: _page }, info) => {
    test.skip(!isPhone(info.project.name), 'phone sheet only');
  });

  test('Parts, Measure, Section and Export tabs: content, targets, axe, baselines', async ({
    page,
  }, info) => {
    const p = info.project.name;
    await open(page, p, '&sheet=half');
    const sheet = page.getByTestId('tools-sheet');
    const tab = (name: string) => sheet.getByRole('button', { name, exact: true });

    await tab('Parts').tap();
    await expect(page.getByTestId('parts-list')).toBeVisible();
    await expectTouchTargets(page.getByTestId('sheet-content'));
    await page.getByRole('button', { name: 'Show Mounting plate' }).tap();
    await expect(page.getByRole('button', { name: 'Hide Mounting plate' })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-tab-parts.png`);
    await noSeriousViolations(page);

    await tab('Measure').tap();
    const reading = page.getByTestId('measure-reading');
    await expect(reading).toHaveAttribute('data-kind', 'distance');
    await expect(reading).toContainText('42.50');
    await expect(reading).toContainText('mm');
    await expect(page.getByTestId('measure-targets').getByRole('listitem')).toHaveCount(2);
    await expectTouchTargets(page.getByTestId('sheet-content'));
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-tab-measure.png`);
    await noSeriousViolations(page);
    await page.getByRole('radio', { name: 'in' }).tap();
    await expect(reading).toContainText('1.6732');
    await page.getByRole('button', { name: 'Remove Edge 4' }).tap();
    await expect(page.getByTestId('measure-targets').getByRole('listitem')).toHaveCount(1);

    await tab('Section').tap();
    const panel = page.getByTestId('section-panel');
    await expect(panel).toBeVisible();
    await expectTouchTargets(panel);
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-tab-section.png`);
    await noSeriousViolations(page);
    await panel.getByRole('radio', { name: 'Y' }).tap();
    await expect(panel.getByRole('radio', { name: 'Y' })).toHaveAttribute('aria-checked', 'true');
    await panel.getByRole('radio', { name: 'Face' }).tap();
    await expect(page.getByTestId('section-face')).toHaveText('Face · Top');
    await panel.getByRole('switch', { name: 'Flip side' }).tap();
    await expect(panel.getByRole('switch', { name: 'Flip side' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await panel.getByRole('switch', { name: 'Section view' }).tap();
    await expect(panel.getByRole('switch', { name: 'Section view' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    await tab('Export').tap();
    await expect(page.getByTestId('export-form')).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-tab-export.png`);
    await noSeriousViolations(page);
  });

  test('Section offset: slider and exact value (keypad, units) stay in sync', async ({
    page,
  }, info) => {
    await open(page, info.project.name, '&sheet=full');
    await page.getByRole('button', { name: 'Section', exact: true }).tap();
    const slider = page.getByRole('slider', { name: 'Section offset' });
    const value = page.getByRole('textbox', { name: 'Section offset value' });
    await expect(value).toHaveValue('12.00mm');
    const box = await slider.boundingBox();
    if (!box) throw new Error('no slider');
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height / 2);
    await expect(value).not.toHaveValue('12.00mm');
    const v = Number.parseFloat(await value.inputValue());
    expect(v).toBeGreaterThan(20);
    expect(v).toBeLessThan(40);

    await value.tap();
    const pad = page.getByTestId('keypad');
    await expect(pad).toBeVisible();
    await pad.getByRole('button', { name: 'AC (clear)' }).tap();
    await pad.getByRole('button', { name: '1', exact: true }).tap();
    await pad.getByRole('button', { name: 'in (inches)' }).tap();
    await pad.getByRole('button', { name: 'Enter' }).tap();
    await expect(value).toHaveValue('25.40mm');
    expect(Number(await slider.inputValue())).toBeCloseTo(25.4, 1);
  });
});

/* ------------------------------------------------------------------ long-press */

test('long-press on a history row opens its menu (touch), a quick tap does not', async ({
  page,
}, info) => {
  const p = info.project.name;
  test.skip(isPhone(p), 'the phone has no history tree');
  await open(page, p);
  await openPanel(page, 'left');
  const row = page.locator('[role="treeitem"][data-feature-id]').nth(1);
  const c = await centre(row);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: c.x + 40, y: c.y, id: 1 }],
  });
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: c.x + 40, y: c.y, id: 1 }],
  });
  await expect(page.getByRole('menu')).toBeVisible({ timeout: 2000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page).toHaveScreenshot(`m2-${p}-tree-longpress-menu.png`);
  await noSeriousViolations(page);
  await cdp.detach();
});

/* ------------------------------------------------------------------ tutorial */

test.describe('tutorial coach marks', () => {
  test('non-modal, advances on a condition, never covers its target, Skip ends it', async ({
    page,
  }, info) => {
    const p = info.project.name;
    await open(page, p, '&tutorial=1');
    const card = page.getByTestId('tutorial-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-step', 'sketch');
    await expect(card.getByRole('heading')).toHaveText('Start with a sketch');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    // no modal: the page below is still operable
    await expect(page.getByRole('dialog')).toHaveCount(0);

    if (!isPhone(p)) {
      // pointing at the Sketch tool on the command bar, and not on top of it
      const ring = page.getByTestId('tutorial-ring');
      await expect(ring).toBeVisible();
      const [cb, tb] = await Promise.all([
        card.boundingBox(),
        page.locator('[data-tool="sketch"]').first().boundingBox(),
      ]);
      if (!cb || !tb) throw new Error('boxes');
      const overlap =
        cb.x < tb.x + tb.width &&
        cb.x + cb.width > tb.x &&
        cb.y < tb.y + tb.height &&
        cb.y + cb.height > tb.y;
      expect(overlap).toBe(false);
    }
    const vp = page.viewportSize() ?? { width: 0, height: 0 };
    const cb = await card.boundingBox();
    expect((cb?.x ?? -1) >= 0 && (cb?.x ?? 0) + (cb?.width ?? 0) <= vp.width).toBe(true);
    await expect(page).toHaveScreenshot(`m2-${p}-tutorial-step1.png`);
    await noSeriousViolations(page);

    // a button is not the way forward: the app's condition is
    await expect(card.getByRole('button', { name: /next|continue/i })).toHaveCount(0);
    await page.evaluate(() => window.__harness?.advance('sketch'));
    await expect(card).toHaveAttribute('data-step', 'rectangle');
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    // a stale condition does nothing
    await page.evaluate(() => window.__harness?.advance('sketch'));
    await expect(card).toHaveAttribute('data-step', 'rectangle');
    await expectTouchTargets(card);

    await card.getByRole('button', { name: 'Skip tutorial' }).tap();
    await expect(page.getByTestId('tutorial-card')).toHaveCount(0);
  });

  test('the closing card', async ({ page }, info) => {
    const p = info.project.name;
    await open(page, p, '&tutorial=1');
    for (const id of [
      'sketch',
      'rectangle',
      'dimension',
      'extrude',
      'holes',
      'fillet',
      'params',
      'export',
    ]) {
      await page.evaluate((s) => window.__harness?.advance(s), id);
    }
    const card = page.getByTestId('tutorial-card');
    await expect(card).toHaveAttribute('data-step', 'done');
    await expect(page).toHaveScreenshot(`m2-${p}-tutorial-done.png`);
    await card.getByRole('button', { name: 'Done' }).tap();
    await expect(card).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ polish */

test.describe('polish', () => {
  test('dark theme: sheet or panel, command bar and bubble', async ({ page }, info) => {
    const p = info.project.name;
    await open(page, p, '&sheet=half&bubble=300,300', 'dark');
    if (!isPhone(p)) await openPanel(page, 'left');
    await settle(page);
    await expect(page).toHaveScreenshot(`m2-${p}-dark-sheet-bubble.png`);
    await noSeriousViolations(page);
  });

  test('no horizontal overflow with every overlay on', async ({ page }, info) => {
    const p = info.project.name;
    await open(page, p, '&sheet=full&bubble=100,200&chip=200,300&tutorial=1');
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.sh).toBeLessThanOrEqual(m.ch);
  });

  test('reduced motion: the sheet and the panels snap without animating', async ({
    page,
  }, info) => {
    const p = info.project.name;
    await open(page, p);
    // The phone's sheet, the tablet's overlay (a panel that opens over the view, 820 wide) or
    // docked panel (it resizes the view): the next frame is the final position.
    const sheet = page.getByTestId(isPhone(p) ? 'tools-sheet' : 'left-panel');
    const key = isPhone(p) ? 'y' : 'x';
    const pos = async () => (await sheet.boundingBox())?.[key] ?? 0;
    const y0 = await pos();
    if (isPhone(p)) await sheet.getByRole('button', { name: /expand/ }).tap();
    else await openPanel(page, 'left');
    // reducedMotion: 'reduce' is set globally: the very next frame is already the final position
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const y1 = await pos();
    await page.waitForTimeout(500);
    const y2 = await pos();
    if (isPhone(p)) expect(y1).toBeLessThan(y0);
    expect(Math.abs(y1 - y2)).toBeLessThan(2);
  });
});
