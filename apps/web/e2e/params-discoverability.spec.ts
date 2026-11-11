// SPDX-License-Identifier: GPL-3.0-or-later
// Owner feedback (2026-11-10): "how do we apply parameters to actual dimensions? I couldn't find a
// way to utilize them." ADR-080: autocomplete in value fields, Make parameter, the link shown on
// dimensions and fields, "Used by" in the Params tab, and dragging a parameter onto a value.
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { DimensionConstraint, SketchFeature } from '@wren-cad/contracts';
import { addBox, app, boot, clickAt, sketchOn, tool } from './helpers';

async function sketchOf(page: Page): Promise<SketchFeature> {
  const f = (await app(page).doc()).parts[0]?.features.find((x) => x.type === 'sketch');
  if (f?.type !== 'sketch') throw new Error('no sketch');
  return f;
}
const dimOf = (f: SketchFeature) =>
  f.constraints.find((c): c is DimensionConstraint => 'value' in c);
const radiusOf = (f: SketchFeature) => {
  const c = f.entities.find((e) => e.kind === 'circle');
  return c?.kind === 'circle' ? c.radius : Number.NaN;
};

/** Expands a parameter's "Used by" list (it may already be open). */
async function openUses(row: Locator) {
  const toggle = row.getByRole('button', { name: /^Used by/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Adds a parameter in the Params tab (which stays open next to the sketch). */
async function addParam(page: Page, name: string, expr: string) {
  await page.getByRole('tab', { name: 'Params' }).click();
  await page.getByRole('button', { name: 'Add parameter' }).click();
  const field = page.getByRole('textbox', { name: /^Name of parameter/ }).last();
  await field.fill(name);
  await field.press('Enter');
  const e = page.getByRole('textbox', { name: `Expression for ${name}` });
  await e.fill(expr);
  await e.press('Enter');
  await expect(page.getByRole('listitem', { name: `Parameter ${name}` })).toBeVisible();
}

test('dimension a circle by typing a parameter name; changing the parameter resizes it', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addParam(page, 'dia', '30 mm');
  await addParam(page, 'dia2', '44 mm');
  await page.getByRole('tab', { name: 'Features' }).click(); // leaves the text field: `s` is a shortcut again

  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const a = app(page);
  await page.keyboard.press('Shift+C');
  await clickAt(page, 10, 10);
  await clickAt(page, 25, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, 25, 10);
  await clickAt(page, 35, 20);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();

  // Typing an identifier offers the parameters, with their values.
  await editor.fill('');
  await editor.pressSequentially('di');
  const list = page.getByRole('listbox', { name: 'Parameters' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveText(['dia30 mm', 'dia244 mm']);
  await expect(page.getByRole('combobox', { name: 'diameter dimension' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('ArrowDown'); // highlight `dia`; Enter alone would commit the typed text
  await page.keyboard.press('Enter'); // accepts `dia`
  await expect(editor).toHaveValue('dia');
  await expect(list).toBeHidden();
  await page.keyboard.press('Enter'); // commits
  await a.settled();

  const f1 = await sketchOf(page);
  expect(dimOf(f1)?.value).toBe('dia');
  expect(radiusOf(f1)).toBeCloseTo(15, 6);
  // The label shows the link, and its accessible name says so.
  const label = page.locator('button[data-kind="diameter"]');
  await expect(label).toContainText('dia =');
  await expect(label).toHaveAccessibleName(/dia = Ø30, dimension/);

  // Used by: the Params tab lists the dimension; choosing it selects the dimension.
  await page.getByRole('tab', { name: 'Params' }).click();
  const row = page.getByRole('listitem', { name: 'Parameter dia' });
  await openUses(row);
  await row.getByRole('button', { name: /Sketch 1/ }).click();
  await expect(label).toHaveAttribute('aria-pressed', 'true');

  // Drag `dia2` from the Params tab onto the label: one undo step.
  const before = (await a.history()).past.length;
  const handle = page.getByRole('button', { name: 'Use dia2' });
  const from = await handle.boundingBox();
  const to = await label.boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(page.getByTestId('param-drag-ghost')).toHaveAttribute('data-over', 'true');
  await page.mouse.up();
  await a.settled();
  expect(dimOf(await sketchOf(page))?.value).toBe('dia2');
  await expect.poll(async () => radiusOf(await sketchOf(page))).toBeCloseTo(22, 6);
  const hist = await a.history();
  expect(hist.past.length).toBe(before + 1);
  expect(hist.past.at(-1)?.label).toBe('Edit dimension');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => dimOf(await sketchOf(page))?.value).toBe('dia');

  // Finish the sketch, extrude the circle, change the parameter: the body follows.
  await page.getByTestId('finish-sketch').click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeHidden();
  await a.idle();
  await tool(page, 'extrude');
  await a.idle();
  await clickAt(page, 10, 10);
  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await depth.fill('10');
  await depth.press('Enter');
  await a.idle();
  const volume = async () => (await a.regen())?.bodies[0]?.volume ?? 0;
  expect(await volume()).toBeCloseTo(Math.PI * 15 ** 2 * 10, 0);
  await page.getByRole('tab', { name: 'Params' }).click();
  const diaExpr = page.getByRole('textbox', { name: 'Expression for dia', exact: true });
  await diaExpr.fill('50 mm');
  await diaExpr.press('Enter');
  await a.idle();
  await expect.poll(volume).toBeCloseTo(Math.PI * 25 ** 2 * 10, 0);

  // "Used by" opens the sketch again at the dimension.
  await page.getByRole('tab', { name: 'Params' }).click();
  await openUses(row);
  await row.getByRole('button', { name: /Sketch 1/ }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await expect(page.locator('button[data-kind="diameter"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('make a parameter from a box height; used by selects the feature; drag onto a field', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addBox(page);
  const a = app(page);
  await a.idle();
  const height = page.getByRole('textbox', { name: 'Height (Z)' });
  await expect(height).toBeVisible();
  const before = (await a.history()).past.length;

  // fx menu: "Make parameter from ..." with an inline, validated name.
  await page.getByRole('button', { name: 'Parameters for Height (Z)' }).click();
  await page.getByRole('option', { name: /Make parameter from/ }).click();
  const name = page.getByRole('textbox', { name: 'Name of the new parameter' });
  await expect(name).toBeFocused();
  await name.fill('mm');
  await expect(page.getByRole('alert').filter({ hasText: 'is a unit' })).toBeVisible();
  await name.fill('sin');
  await expect(page.getByRole('alert').filter({ hasText: 'built-in' })).toBeVisible();
  await name.fill('tall');
  await name.press('Enter');

  await a.idle();
  await expect(page.getByRole('textbox', { name: 'Height (Z)' })).toHaveValue('tall');
  const doc = await a.doc();
  expect(doc.params.map((p) => [p.name, p.expr])).toEqual([['tall', '20 mm']]);
  const hist = await a.history();
  expect(hist.past.length).toBe(before + 1); // one undo step for the parameter and the link
  expect(hist.past.at(-1)?.label).toBe('Make parameter tall');
  // The field shows the link.
  await expect(page.getByTestId('param-link-badge')).toBeVisible();

  // Undo is one step.
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await a.doc()).params.length).toBe(0);
  const f0 = (await a.doc()).parts[0]?.features[0];
  expect(f0?.type === 'primitive' && f0.shape === 'box' && f0.dz).toBe('20 mm');
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(async () => (await a.doc()).params.length).toBe(1);

  // Used by: choosing the entry selects the feature and shows its inspector.
  await page.getByRole('tab', { name: 'Params' }).click();
  const row = page.getByRole('listitem', { name: 'Parameter tall' });
  await openUses(row);
  await row.getByRole('button', { name: /Box/ }).click();
  await expect(page.getByRole('textbox', { name: 'Height (Z)' })).toHaveValue('tall');

  // Drag a parameter onto another field of the inspector.
  await addParam(page, 'wide', '55 mm');
  const handle = page.getByRole('button', { name: 'Use wide' });
  const field = page.getByRole('textbox', { name: 'Width (X)' });
  const from = await handle.boundingBox();
  const to = await field.boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await a.idle();
  await expect(page.getByRole('textbox', { name: 'Width (X)' })).toHaveValue('wide');
  const f = (await a.doc()).parts[0]?.features[0];
  expect(f?.type === 'primitive' && f.shape === 'box' && f.dx).toBe('wide');
});

test('changing a parameter with the sketch open redraws it at once, in the same undo step', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addParam(page, 'dia', '30 mm');
  await page.getByRole('tab', { name: 'Features' }).click();
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const a = app(page);
  await page.keyboard.press('Shift+C');
  await clickAt(page, 10, 10);
  await clickAt(page, 25, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, 25, 10);
  await clickAt(page, 35, 20);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await editor.fill('dia');
  await editor.press('Enter');
  await a.settled();
  expect(radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);

  // Still in the sketch: change the parameter.
  const before = (await a.history()).past.length;
  await page.getByRole('tab', { name: 'Params' }).click();
  const expr = page.getByRole('textbox', { name: 'Expression for dia', exact: true });
  await expr.fill('50 mm');
  await expr.press('Enter');
  await expect.poll(async () => radiusOf(await sketchOf(page))).toBeCloseTo(25, 6);
  await expect(page.locator('button[data-kind="diameter"]')).toContainText('50');
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  expect((await a.history()).past.length).toBe(before + 1); // the edit and the redraw: one step

  // Undo restores both.
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);
  expect((await a.doc()).params[0]?.expr).toBe('30 mm');
});

test('make a parameter from a sketch dimension: one undo step', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  const a = app(page);
  await page.keyboard.press('Shift+C');
  await clickAt(page, 10, 10);
  await clickAt(page, 25, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, 25, 10);
  await clickAt(page, 35, 20);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill('30');
  await page.getByRole('button', { name: /parameters for diameter dimension/i }).click();
  await page.getByRole('option', { name: /Make parameter from/ }).click();
  const name = page.getByRole('textbox', { name: 'Name of the new parameter' });
  await name.fill('dia');
  const before = (await a.history()).past.length;
  await name.press('Enter');
  await a.settled();
  const doc = await a.doc();
  expect(doc.params.map((p) => [p.name, p.expr])).toEqual([['dia', '30 mm']]);
  expect(dimOf(await sketchOf(page))?.value).toBe('dia');
  expect((await a.history()).past.length).toBe(before + 1);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await a.doc()).params.length).toBe(0);
  await expect.poll(async () => dimOf(await sketchOf(page))?.value).toMatch(/mm$/);
});

test('a configuration-only edit with the sketch open redraws it without writing Default geometry', async ({
  page,
}) => {
  test.slow();
  await boot(page);
  await page.getByRole('button', { name: 'Close welcome' }).click();
  await addParam(page, 'dia', '30 mm');
  const pill = page.getByTestId('configuration-pill');
  await pill.click();
  const list = page.getByTestId('configuration-list');
  await list.getByRole('button', { name: 'New configuration…' }).click();
  await list.getByRole('textbox', { name: 'New configuration name' }).fill('Big');
  await list.getByRole('radio', { name: 'From Default' }).click();
  await list.getByRole('button', { name: 'Create' }).click();
  await expect(pill).toContainText('Big');
  const a = app(page);
  await a.idle();

  await page.getByRole('tab', { name: 'Features' }).click();
  await page.keyboard.press('s');
  await sketchOn(page, 'Top');
  await page.keyboard.press('Shift+C');
  await clickAt(page, 10, 10);
  await clickAt(page, 25, 10);
  await a.settled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, 25, 10);
  await clickAt(page, 35, 20);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await editor.fill('dia');
  await editor.press('Enter');
  await a.settled();
  const label = page.locator('button[data-kind="diameter"]');
  await expect(label).toContainText('Ø30');
  expect(radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);

  // Params: "This configuration only", dia = 50 mm, with the sketch still open.
  const before = (await a.history()).past.length;
  await page.getByRole('tab', { name: 'Params' }).click();
  const row = page.getByRole('listitem', { name: 'Parameter dia' });
  await row.getByTestId('scope-chip').click();
  const expr = page.getByRole('textbox', { name: 'Expression for dia', exact: true });
  await expr.fill('50 mm');
  await expr.press('Enter');
  await a.idle();
  // Drawn at the new size ...
  await expect(label).toContainText('Ø50');
  // ... but Default's stored geometry is untouched, and the edit is its one override step.
  expect(radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);
  const hist = await a.history();
  expect(hist.past.length).toBe(before + 1);
  expect(hist.past.at(-1)?.label).toBe('Set dia in Big');
  expect((await a.doc()).params[0]?.expr).toBe('30 mm');

  // Back to Default with the sketch open: drawn at Default's size, under Default's value.
  await pill.click();
  await list.getByRole('button', { name: /^Default/ }).click();
  await expect(label).toContainText('Ø30');
  expect(radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);
  // And to Big again: the display follows.
  await pill.click();
  await list.getByRole('button', { name: /^Big/ }).click();
  await expect(label).toContainText('Ø50');
  expect(radiusOf(await sketchOf(page))).toBeCloseTo(15, 6);
});
