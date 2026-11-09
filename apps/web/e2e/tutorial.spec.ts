import { devices, expect, type Page, test } from '@playwright/test';
import { app, boot, cameraStill, toPage, touch } from './helpers';

/**
 * PLAN §12 M2 acceptance: on an iPad a new user completes the "make a bracket" tutorial without a
 * keyboard. iPad emulation (1180 × 820, touch, mobile), and not a single keyboard event: every
 * value is typed on the inline keypad, every tool is reached by tapping. The tutorial advances on
 * the real document only. The run's duration is logged.
 */

const SHOTS = process.env.WREN_SHOTS;

test.use({
  viewport: { width: 1180, height: 820 },
  userAgent: devices['iPad Pro 11'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

/** Types on the inline keypad of the focused field: clear, then the keys. */
async function keypad(page: Page, keys: string[]) {
  const pad = page.getByTestId('keypad');
  await expect(pad).toBeVisible();
  await pad.getByRole('button', { name: 'AC (clear)' }).tap();
  for (const k of keys) await pad.getByRole('button', { name: k, exact: true }).tap();
  await pad.getByRole('button', { name: 'Enter' }).tap();
  await expect(pad).toHaveCount(0);
}

test('the bracket tutorial, touch only, on an iPad', async ({ page }) => {
  test.setTimeout(300_000);
  // Downloads, not the File System Access picker (headless has no dialogs).
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  // No keyboard: any key event fails the test.
  await page.addInitScript(() => {
    for (const type of ['keydown', 'keyup', 'keypress'])
      window.addEventListener(
        type,
        (e) => {
          if ((e as KeyboardEvent).isTrusted)
            (window as unknown as { __keys: number }).__keys =
              ((window as unknown as { __keys?: number }).__keys ?? 0) + 1;
        },
        true,
      );
  });
  await boot(page);
  const a = app(page);
  const t = await touch(page);
  expect(await page.getByTestId('app-shell').getAttribute('data-tier')).toBe('tablet');
  const card = page.getByTestId('tutorial-card');
  const step = (id: string) => expect(card).toHaveAttribute('data-step', id, { timeout: 30_000 });
  /**
   * A world point on screen once it is the bare viewport: sheets and the coach card animate
   * (260 ms), so this waits for whatever covers the point to move off, and fails if it never does.
   */
  const onView = async (p: [number, number, number]) => {
    const q = await toPage(page, p);
    const covering = () =>
      page.evaluate((q) => {
        const e = document.elementFromPoint(q.x, q.y);
        const id = e?.getAttribute('data-testid');
        return id === 'viewport-canvas'
          ? id
          : `${e?.tagName}.${e?.className} in ${e?.closest('[data-testid]')?.getAttribute('data-testid')}`;
      }, q);
    await expect.poll(covering, { message: `${p} stays covered` }).toBe('viewport-canvas');
    return q;
  };
  const tapWorld = async (p: [number, number, number]) => t.tap([await onView(p)]);
  const bubbleAction = (id: string) =>
    page.getByTestId('context-bubble').locator(`[data-action="${id}"]`);
  const inspector = page.getByTestId('feature-inspector');
  const sheet = page.getByTestId('history-sheet');
  const sheetTab = (name: string) =>
    sheet.getByRole('radiogroup', { name: 'Sheet section' }).getByRole('radio', { name });

  // Offered from the welcome card.
  const started = Date.now();
  await page.getByTestId('take-tour').tap();
  await step('sketch');

  // 1. Sketch on Top.
  await page.getByRole('button', { name: 'Sketch', exact: true }).tap();
  await page.getByTestId('plane-chooser').getByRole('button', { name: /Top/ }).tap();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await cameraStill(page);
  await step('rectangle');

  // 2. Rectangle: one finger drag from corner to corner.
  await page.locator('[data-tool="rectangle"]').tap();
  // The plate: x 0..60, y −10..30, drawn right of the coach card.
  await t.drag(await onView([0, -10, 0]), await onView([60, 30, 0]), 16);
  await a.settled();
  await step('dimension');

  // 3. Dimension the bottom edge, placed below it, 60 on the keypad.
  await page.locator('[data-tool="dimension"]').tap();
  await tapWorld([15, -10, 0]); // a quarter along: the constraint glyph sits mid-edge
  await tapWorld([15, -22, 0]);
  if (SHOTS) {
    await expect(page.getByTestId('keypad')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/ipad-tutorial-step.png` });
  }
  await keypad(page, ['6', '0']);
  await a.settled();
  await step('extrude');

  // 4. Finish, tap the rectangle, Extrude from the bubble, depth 6 mm on the keypad.
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Finish sketch' })
    .tap();
  await a.idle();
  await tapWorld([30, 10, 0]);
  await a.idle();
  await bubbleAction('extrude').tap();
  await a.idle();
  await page.getByTestId('extrude-depth-input').getByRole('textbox').tap();
  await keypad(page, ['6', 'mm (millimetres)']);
  await a.idle();
  await step('holes');
  await inspector.getByRole('button', { name: 'Done' }).tap();
  await expect(sheet).toHaveAttribute('data-snap', 'peek');

  // 5. Holes: sketch on the top face, two circles, finish; tap one, Cut, tap the other.
  await tapWorld([30, 10, 6]);
  await a.idle();
  await bubbleAction('sketch').tap();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await a.idle();
  await cameraStill(page);
  await page.locator('[data-tool="circle"]').tap();
  for (const x of [10, 50]) {
    await tapWorld([x, 18, 6]);
    await tapWorld([x + 4, 18, 6]);
  }
  await a.settled();
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Finish sketch' })
    .tap();
  await a.idle();
  await tapWorld([10, 18, 6]);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['region']);
  await bubbleAction('cut').tap();
  await a.idle();
  await tapWorld([50, 18, 6]);
  await a.idle();
  await step('fillet');
  const cut = (await a.doc()).parts[0]?.features.at(-1);
  expect(cut?.type === 'extrude' && cut.profile.length).toBe(2);
  await inspector.getByRole('button', { name: 'Done' }).tap();

  // 6. Fillet: tap the plate's front top edge (the view still looks down on the plate), Fillet,
  // 3 mm.
  await cameraStill(page);
  await tapWorld([30, -10, 6]);
  await a.idle();
  expect((await a.ui()).selection).toEqual(['edge']);
  await bubbleAction('fillet').tap();
  await a.idle();
  await inspector.getByRole('textbox', { name: /Radius/ }).tap();
  await keypad(page, ['3', 'mm (millimetres)']);
  await a.idle();
  await step('params');
  await inspector.getByRole('button', { name: 'Done' }).tap();

  // 7. A parameter, used in the plate's depth (a keypad key), then changed.
  await sheet
    .getByRole('button', { name: /History/ })
    .first()
    .tap();
  await expect(sheet).toHaveAttribute('data-snap', 'half');
  await sheetTab('Params').tap();
  await sheet.getByRole('button', { name: 'Add parameter' }).tap();
  await expect(sheet.getByRole('textbox', { name: 'Expression for param1' })).toBeVisible();
  await sheetTab('History').tap();
  await sheet.getByRole('treeitem', { name: /Extrude 1/ }).tap();
  await sheetTab('Inspector').tap();
  await inspector.getByRole('textbox', { name: /Depth/ }).tap();
  await keypad(page, ['parameter param1']);
  await a.idle();
  await sheetTab('Params').tap();
  await sheet.getByRole('textbox', { name: 'Expression for param1' }).tap();
  await keypad(page, ['8', 'mm (millimetres)']);
  await a.idle();
  await step('export');
  expect((await a.regen())?.features.every((f) => f.state === 'ok')).toBe(true);
  expect((await a.regen())?.bodies[0]?.bbox.max[2]).toBeCloseTo(8, 6);

  // 8. Export an STL from the top bar.
  await page.getByTestId('export-trigger').tap();
  const form = page.getByTestId('export-form');
  await form.getByText('STL', { exact: true }).tap();
  const download = page.waitForEvent('download');
  await form.getByRole('button', { name: /^Export STL/ }).tap();
  expect((await download).suggestedFilename()).toMatch(/\.stl$/);
  await expect(card).toHaveAttribute('data-step', 'done');
  const seconds = (Date.now() - started) / 1000;
  console.log(`tutorial on iPad emulation: ${seconds.toFixed(1)} s, touch only`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipad-tutorial-done.png` });
  expect(await page.evaluate(() => (window as unknown as { __keys?: number }).__keys ?? 0)).toBe(0);
  expect(seconds).toBeLessThan(300);
});
