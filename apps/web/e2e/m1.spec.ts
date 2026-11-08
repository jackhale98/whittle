import { expect, test } from '@playwright/test';
import { app, boot, clickAt, palette, sketchOn } from './helpers';

/**
 * M1 modeling flow against the production build with the real regen engine (kernel worker,
 * OCCT + planegcs): sketch → dimension → extrude by a parameter expression → tree
 * edits → undo/redo → autosave + reload → export.
 */

test.describe.configure({ mode: 'serial' });

test('sketch a rectangle, dimension it, extrude by width/2, edit history, reload, export', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Downloads, not the File System Access picker (headless has no dialogs).
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  await boot(page);
  const a = app(page);
  /** Midpoint of the sketch's rightmost vertical line (sketch mm). */
  const rightEdge = async () => {
    const f = (await a.doc()).parts[0]?.features[0];
    if (f?.type !== 'sketch') throw new Error('no sketch');
    const pt = (id: string) => {
      const p = f.entities.find((e) => e.id === id);
      return p?.kind === 'point' ? p : { x: 0, y: 0 };
    };
    let best = { x: Number.NEGATIVE_INFINITY, y: 0 };
    for (const e of f.entities) {
      if (e.kind !== 'line') continue;
      const s = pt(e.start);
      const t = pt(e.end);
      if (Math.abs(s.x - t.x) < 1e-6 && s.x > best.x) best = { x: s.x, y: (s.y + t.y) / 2 };
    }
    return best;
  };

  // 1. Sketch on the Top (XY) plane: S → plane chooser.
  await page.keyboard.press('s');
  await expect(page.getByTestId('prompt-chip')).toContainText('Select a plane');
  await sketchOn(page, 'Top');

  // 2. Line tool (active by default for a new sketch): a closed rectangle, click-click. It starts
  // on the sketch origin and runs along both axes, so its corners snap to them (ADR-017).
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
    [0, 0],
  ] as const) {
    await clickAt(page, x, y);
  }
  await expect.poll(async () => (await a.sketch())?.dof).toBe(2);
  const sketch = (await a.doc()).parts[0]?.features[0];
  expect(sketch?.type).toBe('sketch');
  if (sketch?.type !== 'sketch') throw new Error('no sketch');
  expect(sketch.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
  // Corner at the origin, corners on the axes; the edges along the axes need no H/V of their own.
  expect(sketch.constraints.map((c) => c.kind).sort()).toEqual([
    'coincident',
    'horizontal',
    'pointOn',
    'pointOn',
    'vertical',
  ]);
  expect(JSON.stringify(sketch.constraints)).toContain('"@origin"');
  await expect(page.getByTestId('constraint-glyph')).toHaveCount(2);

  // 3. Dimension tool: bottom edge → 60, right edge → 30.
  await page.keyboard.press('Escape'); // leave the line tool
  await page.keyboard.press('d');
  await clickAt(page, 20, 0);
  await clickAt(page, 20, -8);
  const editor = page.getByTestId('dimension-editor').getByRole('textbox');
  await expect(editor).toBeFocused();
  await editor.fill('60');
  await editor.press('Enter');
  // The edit lands in the document only after its solve (the DOF count is already 1 after the
  // placement, before the 60 mm solve): wait for the sketch to settle, then read the geometry.
  await a.settled();
  await expect.poll(async () => (await a.sketch())?.dof).toBe(1);
  // The right edge moved with the solve: find it from the document.
  const right = await rightEdge();
  await clickAt(page, right.x, right.y);
  await clickAt(page, right.x + 10, right.y);
  await expect(editor).toBeFocused();
  await editor.fill('30 mm');
  await editor.press('Enter');
  await expect.poll(async () => (await a.sketch())?.dof).toBe(0);
  await expect(page.getByTestId('sketch-status').first()).toContainText('Fully constrained');

  // 4. Finish.
  await page.getByTestId('finish-sketch').click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeHidden();
  await a.idle();
  expect((await a.regen())?.sketches[0]?.regions).toHaveLength(1);

  // 5. A parameter, then Extrude (act first, select second) with depth `width/2`.
  await page.getByRole('tab', { name: 'Params' }).click();
  await page.getByRole('button', { name: 'Add parameter' }).click();
  const name = page.getByRole('textbox', { name: /^Name of parameter/ });
  await name.fill('width');
  await name.press('Enter');
  const expr = page.getByRole('textbox', { name: 'Expression for width' });
  await expr.fill('80 mm');
  await expr.press('Enter');
  await expect(page.getByTestId('param-value')).toHaveText('80 mm');
  await page.getByRole('tab', { name: 'Features' }).click();

  await page.getByRole('button', { name: 'Extrude', exact: true }).click();
  await expect(page.getByTestId('prompt-chip')).toContainText('Select a sketch region');
  await a.idle();
  await clickAt(page, 30, 15);
  const depth = page.getByTestId('extrude-depth-input').getByRole('textbox');
  await expect(depth).toBeVisible();
  await depth.fill('width/2');
  await depth.press('Enter');
  await a.idle();
  let regen = await a.regen();
  expect(regen?.features.map((f) => f.state)).toEqual(['ok', 'ok']);
  expect(regen?.bodies[0]?.volume ?? 0).toBeCloseTo(60 * 30 * 40, 1);
  const tree = page.getByTestId('feature-tree');
  await expect(tree.getByRole('treeitem')).toHaveCount(2);
  await expect(tree).toContainText('Extrude 1');

  // 6. Rename in the tree (Enter on the row).
  await tree.getByRole('treeitem', { name: /Extrude 1/ }).focus();
  await page.keyboard.press('Enter');
  const rename = page.getByRole('textbox', { name: 'Rename Extrude 1' });
  await rename.fill('Base plate');
  await rename.press('Enter');
  await expect(tree).toContainText('Base plate');

  // 7. Roll back above the extrude, then forward again.
  const bar = page.getByRole('separator', { name: 'Rollback bar' });
  await bar.focus();
  await page.keyboard.press('ArrowUp');
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await a.idle();
  regen = await a.regen();
  expect(regen?.features.map((f) => f.state)).toEqual(['ok', 'rolledBack']);
  expect(regen?.bodies).toHaveLength(0);
  await expect(bar).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await a.idle();
  expect((await a.regen())?.bodies).toHaveLength(1);

  // 8. Undo / redo (keyboard + top bar).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z'); // roll forward undone
  await page.keyboard.press('ControlOrMeta+z'); // roll back undone
  await page.keyboard.press('ControlOrMeta+z'); // rename undone
  await expect(tree).toContainText('Extrude 1');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(tree).toContainText('Base plate');

  // 9. Autosave → reload → the document comes back from the library.
  await a.flushSave();
  await page.reload();
  await page.evaluate(() =>
    (
      window as unknown as { __whittle: { firstBodyRendered(): Promise<unknown> } }
    ).__whittle.firstBodyRendered(),
  );
  await a.idle();
  await expect(page.getByTestId('feature-tree')).toContainText('Base plate');
  regen = await a.regen();
  expect(regen?.bodies[0]?.volume ?? 0).toBeCloseTo(72_000, 1);
  expect((await a.doc()).params[0]?.name).toBe('width');

  // 10. Export STL → a download.
  await page.getByRole('button', { name: 'Export' }).click();
  const form = page.getByTestId('export-form');
  await form.getByRole('radio', { name: /STL/ }).click();
  const download = page.waitForEvent('download');
  await form.getByRole('button', { name: /^Export/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.stl$/);
  await page.screenshot({ path: 'test-results/m1-feature-selected.png' });
});

test('library lists, renames and opens documents; palette adds primitives', async ({ page }) => {
  await boot(page);
  const a = app(page);
  await palette(page, 'Box');
  await a.idle();
  expect((await a.regen())?.bodies[0]?.volume).toBeCloseTo(24_000, 3);
  await a.flushSave();
  await page.getByTestId('library-button').click();
  const panel = page.getByTestId('library-panel');
  await expect(panel.getByTestId('library-item').first()).toBeVisible();
  await panel.getByRole('button', { name: 'New' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('feature-tree')).toHaveCount(0);
  await page.getByTestId('library-button').click();
  await panel.getByTestId('library-item').first().getByRole('button', { name: /^Open/ }).click();
  await expect(page.getByTestId('feature-tree')).toContainText('Box 1');
  await a.idle();
  expect((await a.regen())?.bodies).toHaveLength(1);
});
