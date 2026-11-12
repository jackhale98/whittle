import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { addBox, boot, cameraStill, palette } from './helpers';

/**
 * M4.5 (3D mice) UI acceptance, with a fake MotionInput injected through the app's test hook (the
 * real device layer needs hardware): the Settings section persists across reload, the diagnostics
 * panel shows each state (axe clean), button remapping persists and a mapped button runs fit.
 */

test.use({ viewport: { width: 1280, height: 720 } });

type Fake = {
  emit(s: unknown): void;
  pairs(): number;
  press(b: number): void;
};
type W = {
  __wrenApp: {
    motion(): Promise<{
      attach(): void;
      log(): string[];
      prefs(): { settings: Record<string, unknown>; buttons: Record<string, string> };
    }>;
  };
  __wrenMotionFake: Fake;
  __wrenViewport: { getCameraState(): unknown };
};

const attach = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__wrenApp.motion().then((m) => m.attach()));
const emit = (page: Page, s: unknown) =>
  page.evaluate((x) => (window as unknown as W).__wrenMotionFake.emit(x), s);
const press = (page: Page, b: number) =>
  page.evaluate((x) => (window as unknown as W).__wrenMotionFake.press(x), b);
const log = (page: Page) =>
  page.evaluate(async () => (window as unknown as W).__wrenApp.motion().then((m) => m.log()));
const dev = { name: 'Example 6-DoF controller', vendorId: 1, productId: 2 };

const serious = (r: {
  violations: Array<{ impact?: string | null; id: string; nodes: Array<{ target: unknown[] }> }>;
}) =>
  r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

async function settings(
  page: Page,
  tab: 'Settings' | 'Keyboard shortcuts' | '3D mouse diagnostics',
) {
  await palette(page, tab);
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('Settings -> Navigation -> 3D mouse: pair from a click, values persist across reload', async ({
  page,
}) => {
  await boot(page);
  await attach(page);
  let panel = await settings(page, 'Settings');
  const section = panel.getByTestId('motion-settings');
  await expect(section).toBeVisible();
  await section.getByRole('button', { name: 'Pair a 3D mouse' }).click();
  expect(await page.evaluate(() => (window as unknown as W).__wrenMotionFake.pairs())).toBe(1);

  await section.getByRole('switch', { name: 'Reverse twist (Rz)' }).click();
  await section.getByRole('switch', { name: 'Dominant axis only' }).click();
  await section.getByRole('switch', { name: 'Rotate' }).click();
  const sens = section.getByRole('slider', { name: '3D mouse sensitivity' });
  await sens.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  const stored = JSON.parse(
    (await page.evaluate(() => localStorage.getItem('wren.motion'))) ?? '{}',
  );
  expect(stored.invert.rz).toBe(true);
  expect(stored.dominant).toBe(true);
  expect(stored.rotate).toBe(false);
  expect(stored.sensitivity).toBeGreaterThan(1);

  await page.reload();
  await boot(page);
  panel = await settings(page, 'Settings');
  const s2 = panel.getByTestId('motion-settings');
  await expect(s2.getByRole('switch', { name: 'Reverse twist (Rz)' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(s2.getByRole('switch', { name: 'Rotate' })).toHaveAttribute('aria-checked', 'false');
  await expect(s2.getByRole('switch', { name: 'Dominant axis only' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('diagnostics panel: every state, never silent, axe clean', async ({ page }) => {
  await boot(page);
  await attach(page);
  const panel = await settings(page, '3D mouse diagnostics');
  const diag = panel.getByTestId('motion-diagnostics');
  const states: Array<[unknown, string, RegExp]> = [
    [{ path: 'none', state: 'unsupported' }, 'unsupported', /can't read a 3D mouse/],
    [{ path: 'none', state: 'notPaired' }, 'notPaired', /Pair your 3D mouse/],
    [{ path: 'none', state: 'disconnected' }, 'disconnected', /Plug the 3D mouse in/],
    [
      { path: 'webhid', state: 'noReports', device: dev, buttons: [] },
      'noReports',
      /vendor driver may be holding the device/,
    ],
    [
      {
        path: 'webhid',
        state: 'live',
        device: dev,
        buttons: [2],
        last: { t: [0.5, 0, 0], r: [0, 0, -0.5], time: 0 },
      },
      'live',
      /Move the cap/,
    ],
  ];
  for (const [s, key, text] of states) {
    await emit(page, s);
    await expect(diag).toHaveAttribute('data-state', key);
    await expect(diag.getByTestId('motion-state-detail')).toContainText(text);
    await expect(diag.getByTestId('motion-wheel-note')).toContainText('wheel emulation');
    expect(
      serious(await new AxeBuilder({ page }).include('[data-testid="settings-panel"]').analyze()),
    ).toEqual([]);
  }
  await expect(diag.getByRole('meter')).toHaveCount(6);
  await expect(diag.getByTestId('motion-buttons')).toContainText('Button 2');
  await emit(page, { path: 'none', state: 'notPaired' });
  await diag.getByRole('button', { name: 'Pair a 3D mouse' }).click();
  expect(await page.evaluate(() => (window as unknown as W).__wrenMotionFake.pairs())).toBe(1);
});

test('button mapping: defaults, remap persists across reload, a mapped button runs fit', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await addBox(page);
  await attach(page);
  await emit(page, { path: 'webhid', state: 'live', device: dev, buttons: [], last: undefined });
  let panel = await settings(page, 'Keyboard shortcuts');
  const map = panel.getByTestId('motion-button-map');
  await expect(map.getByRole('combobox', { name: 'Button 1' })).toHaveValue('radialMenu');
  await expect(map.getByRole('combobox', { name: 'Button 2' })).toHaveValue('fit');
  // Buttons are discovered live: pressing button 4 lists it.
  await emit(page, { path: 'webhid', state: 'live', device: dev, buttons: [4] });
  await expect(map.getByRole('combobox', { name: 'Button 4' })).toBeVisible();
  await emit(page, { path: 'webhid', state: 'live', device: dev, buttons: [] });
  await map.getByRole('combobox', { name: 'Button 4' }).selectOption('viewTop');
  await page.getByTestId('settings-close').click();

  // Fit: zoom away with the wheel, press the button mapped to fit.
  const canvas = page.getByTestId('viewport-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 900);
  await cameraStill(page);
  const cam = () =>
    page.evaluate(() => JSON.stringify((window as unknown as W).__wrenViewport.getCameraState()));
  const zoomed = await cam();
  await press(page, 2);
  await cameraStill(page);
  expect(await log(page)).toEqual(['fit']);
  expect(await cam()).not.toEqual(zoomed);

  // Button 4 -> Top view.
  const before = await cam();
  await press(page, 4);
  await cameraStill(page);
  expect(await log(page)).toEqual(['fit', 'viewTop']);
  expect(await cam()).not.toEqual(before);

  // Button 1 -> radial menu (default), toggled by the same button.
  await press(page, 1);
  await expect(page.getByTestId('radial-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // Remap button 2 and reload: the mapping persists.
  panel = await settings(page, 'Keyboard shortcuts');
  await panel
    .getByTestId('motion-button-map')
    .getByRole('combobox', { name: 'Button 2' })
    .selectOption('viewIso');
  await page.reload();
  await boot(page);
  await attach(page);
  panel = await settings(page, 'Keyboard shortcuts');
  const m2 = panel.getByTestId('motion-button-map');
  await expect(m2.getByRole('combobox', { name: 'Button 2' })).toHaveValue('viewIso');
  await expect(m2.getByRole('combobox', { name: 'Button 1' })).toHaveValue('radialMenu');
  expect(
    await page.evaluate(
      async () =>
        (await (window as unknown as W).__wrenApp.motion().then((m) => m.prefs())).buttons,
    ),
  ).toMatchObject({ 2: 'viewIso', 4: 'viewTop' });
});
