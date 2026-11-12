import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { Annotation, Drawing, HoleFeature, WrenDoc } from '@wren-cad/contracts';
import { docWith, extrude, fid, region, Sk } from './fixtures';
import { app, boot, palette } from './helpers';
import { CFG_LONG, configPartDoc } from './support/config-part';
import {
  built,
  cornerEdges,
  drag,
  drawing,
  type Edge,
  newDrawing,
  openDemo,
  panelTab,
  sheetToPage,
  viewOf,
} from './support/drawing-ui';

/**
 * M4 drawings (PLAN §12 M4 Accept) on the demo bracket, desktop, against the real HLR drawing
 * kernel (ADR-090 amendment, ADR-092 amendment): its worker and Wasm run in the page. Tablet and
 * phone are in m4-touch.spec.ts.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.slow();

const part = async (page: Page) => (await app(page).doc()).parts[0] as WrenDoc['parts'][number];
const drawings = async (page: Page): Promise<Drawing[]> => (await app(page).doc()).drawings;
const annotations = async (page: Page): Promise<Annotation[]> =>
  (await part(page)).annotations ?? [];

const serious = (r: {
  violations: Array<{ impact?: string | null; id: string; nodes: Array<{ target: unknown[] }> }>;
}) =>
  r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
const a11y = async (page: Page) =>
  expect(
    serious(await new AxeBuilder({ page }).include('[data-testid="drawing-route"]').analyze()),
  ).toEqual([]);

/** Imports every model annotation from the Import panel (one step). */
async function importAll(page: Page): Promise<void> {
  await panelTab(page, 'Import').click();
  await page.getByTestId('import-open').click();
  await page.getByRole('button', { name: 'Check all' }).click();
  await page.getByTestId('import-place').click();
  await expect(page.getByTestId('drawing-toast')).toContainText('Placed');
  await built(page);
}

async function addStandardViews(page: Page): Promise<void> {
  await panelTab(page, 'Views').click();
  await page.getByTestId('add-standard-views').click();
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
  await built(page);
}

const click = async (page: Page, p: [number, number]) => {
  const at = await sheetToPage(page, p);
  await page.mouse.click(at.x, at.y);
};

test.describe('create a drawing (D10)', () => {
  test('the first drawing asks for the standard and projection, inline, and remembers it', async ({
    page,
  }) => {
    await openDemo(page);
    await palette(page, 'New drawing');
    const card = page.getByTestId('standard-choice');
    await expect(card).toBeVisible();
    // Inline in the route, never a dialog; nothing is chosen for the user.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('standard-confirm')).toBeDisabled();
    await a11y(page);

    await card.getByRole('radio', { name: 'ASME / ANSI' }).click();
    await card.getByRole('radio', { name: /^Third angle/ }).check({ force: true });
    await page.getByTestId('standard-confirm').click();
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    const s = await built(page);
    expect(s.projection).toBe('third');
    expect(s.views.map((v) => v.kind)).toEqual(['base']);

    const doc = await app(page).doc();
    // Remembered for the project, and the template, sheet and style follow the standard.
    expect(doc.drawingDefaults).toMatchObject({
      projection: 'third',
      standard: { family: 'asme', gps: 'ASME Y14.5-2018' },
    });
    const d = doc.drawings[0] as Drawing;
    expect(d.template.id).toBe('asme-y14.1');
    expect(d.sheets[0]?.format).toEqual({ size: 'ANSI-B', orientation: 'landscape' });
    expect(d.style.lineGroup).toBe('asme-0.6');
    expect(d.standard.family).toBe('asme');
    // The title block shows the model's bound values.
    expect(s.texts).toContain('Aluminium 6061-T6');

    // The second drawing does not ask again.
    await page.getByTestId('drawing-back').click();
    await expect(page.getByTestId('drawing-route')).toHaveCount(0);
    await palette(page, 'New drawing');
    await expect(page.getByTestId('sheet-viewer')).toBeVisible();
    await expect(page.getByTestId('standard-choice')).toHaveCount(0);
    await expect.poll(async () => (await drawings(page)).length).toBe(2);
  });

  test('the drawings of a document are listed: open, rename and delete, inline', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('drawing-back').click();
    const section = page.getByTestId('drawings-section');
    await expect(section.getByTestId('drawing-open')).toHaveCount(1);
    await section.getByRole('button', { name: /^Rename/ }).click();
    const input = section.getByRole('textbox', { name: 'New drawing name' });
    await input.fill('Plate A');
    await input.press('Enter');
    await expect.poll(async () => (await drawings(page))[0]?.name).toBe('Plate A');
    await section.getByTestId('drawing-open').click();
    await expect(page.getByTestId('drawing-title')).toHaveText('Plate A');
    await page.getByTestId('drawing-back').click();
    await section.getByTestId('drawing-delete').click();
    await section.getByTestId('drawing-delete-confirm').click();
    await expect.poll(async () => (await drawings(page)).length).toBe(0);
  });
});

test('a drawing kernel that fails to load says so on the sheet; nothing is faked', async ({
  page,
}) => {
  await openDemo(page);
  await newDrawing(page);
  await addStandardViews(page);
  await expect(page.getByTestId('projection-problem')).toHaveCount(0);
  // As a failed fetch of the Wasm would leave it.
  await drawing(page).failKernel();
  await expect(page.getByTestId('projection-problem')).toBeVisible();
  await expect(page.getByTestId('projection-problem')).toContainText('could not be drawn');
  await expect(page.getByTestId('placeholder-badge')).toHaveCount(0);
  const s = await built(page);
  expect(s.views.every((v) => v.curves === 0)).toBe(true);
  // The sheet and the model's values are still there.
  expect(s.texts).toContain('Aluminium 6061-T6');
  await a11y(page);
});

test.describe('views', () => {
  test('standard views align to the parent and follow the projection method', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    let s = await drawing(page).state();
    const front = viewOf(s, 'base');
    const top = viewOf(s, 'projected', 'top');
    const side = viewOf(s, 'projected', 'left');
    expect(front && top && side).toBeTruthy();
    // First angle: the top view hangs below the front; the view from the left sits to its right.
    expect((top?.position?.[1] ?? 0) < (front?.position?.[1] ?? 0)).toBe(true);
    expect(top?.position?.[0] ?? 0).toBeCloseTo(front?.position?.[0] ?? 0, 3);
    expect((side?.position?.[0] ?? 0) > (front?.position?.[0] ?? 0)).toBe(true);
    expect(side?.position?.[1] ?? 0).toBeCloseTo(front?.position?.[1] ?? 0, 3);
    expect(s.views.every((v) => v.problems.length === 0 && v.curves > 0)).toBe(true);
    // The real kernel: nothing says "approximate", nothing failed to project.
    await expect(page.getByTestId('placeholder-badge')).toHaveCount(0);
    await expect(page.getByTestId('projection-problem')).toHaveCount(0);
    expect((await drawing(page).state()).projectionProblems).toEqual([]);
    await a11y(page);

    // Draft first, exact when idle: the exact output is what the plate's holes are measured from.
    await drawing(page).exact();
    await expect.poll(async () => (await drawing(page).state()).quality).toBe('exact');
    await expect.poll(async () => (await drawing(page).state()).refining).toBe(false);
    const topProj = await drawing(page).projection(top?.id ?? '');
    expect(topProj?.quality).toBe('exact');
    // The bracket's four Ø6 holes, seen along their axes: whole circles of exact radius 3, named
    // after their model edge, not polylines fitted to a tessellation.
    const holes = (topProj?.curves ?? []).filter(
      (k) =>
        k.role === 'visible' && k.kind === 'arc' && Math.abs((k.sweep ?? 0) - 2 * Math.PI) < 1e-6,
    );
    const rims = holes.filter((k) => Math.abs((k.radius ?? 0) - 3) < 1e-6);
    expect(rims.length).toBeGreaterThanOrEqual(4);
    expect(rims.every((k) => (k.name ?? '').length > 0)).toBe(true);
    // Exact output has no polylines for what has an exact form.
    expect((topProj?.curves ?? []).filter((k) => k.kind === 'polyline')).toEqual([]);

    // An isometric view and the base-view picker.
    await page.getByTestId('add-iso-view').click();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(4);
    s = await built(page);
    expect(viewOf(s, 'iso')?.layout).toBe('free');
    await page.locator('[data-view="back"]').click();
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(5);
  });

  test('drag a projected view out of its parent; a section and a detail are drawn on the sheet', async ({
    page,
  }) => {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front?.outline) throw new Error('no front view');
    const [minX, minY] = front.outline.min;
    const [maxX, maxY] = front.outline.max;
    const edges = await drawing(page).edges(front.id);
    const pick = edges.find((e) => e.kind === 'line');
    if (!pick) throw new Error('no edge');

    // Select the view (a click on its edge), then drag the lower arrow out: a view from above.
    await click(page, pick.at);
    await expect.poll(async () => (await drawing(page).state()).selected?.kind).toBe('view');
    const handle = page.locator('[data-testid="view-handle"][data-dir="0,-1"] circle').first();
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('no handle');
    const to = await sheetToPage(page, [(minX + maxX) / 2, minY - 70]);
    await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, to);
    await expect.poll(async () => (await drawing(page).state()).views.length).toBe(2);
    let s = await built(page);
    const dragged = viewOf(s, 'projected');
    // First angle: dragged below, so it is the top view; aligned and still on the axis.
    expect(dragged?.from).toBe('top');
    expect(dragged?.layout).toBe('aligned');
    expect(dragged?.position?.[0]).toBeCloseTo(front.position?.[0] ?? 0, 3);
    expect((dragged?.position?.[1] ?? 0) < minY).toBe(true);

    // Section: draw the cut line across the front view with the Section tool.
    await page.locator('[data-tool="section"]').click();
    const y = (minY + maxY) / 2;
    await drag(
      page,
      await sheetToPage(page, [minX + 1, y]),
      await sheetToPage(page, [maxX - 1, y]),
    );
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
      .toBe(true);
    s = await built(page);
    const section = viewOf(s, 'section');
    expect(section?.problems).toEqual([]);
    expect((section?.curves ?? 0) > 0).toBe(true);
    // The cut line's letters are on the parent view.
    expect(s.texts.filter((t) => t === 'A').length).toBeGreaterThanOrEqual(2);
    const sec = ((await drawings(page))[0] as Drawing).views.find((v) => v.kind === 'section');
    expect(sec && 'cut' in sec && sec.cut.length).toBe(2);
    // The cut face is hatched from the kernel's section loops. The faces carry synthetic ids
    // (`section:<segment>#<k>`), which are not model names.
    await drawing(page).exact();
    const secProj = await drawing(page).projection(section?.id ?? '');
    expect(secProj?.quality).toBe('exact');
    expect(secProj?.sectionFaces.length).toBeGreaterThan(0);
    for (const f of secProj?.sectionFaces ?? []) {
      expect(f.face).toMatch(/^section:\d+#\d+$/);
      expect(f.loops).toBeGreaterThan(0);
    }
    expect((await drawing(page).state()).hatchLines).toBeGreaterThan(10);

    // Detail: a circle dragged on the top view, enlarged beyond its parent's scale.
    await page.locator('[data-tool="detail"]').click();
    const tv = viewOf(s, 'projected', 'top');
    if (!tv?.outline) throw new Error('no top view');
    const cx = tv.outline.min[0] + 12;
    const cy = (tv.outline.min[1] + tv.outline.max[1]) / 2;
    await drag(page, await sheetToPage(page, [cx, cy]), await sheetToPage(page, [cx + 8, cy]));
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'detail'))
      .toBe(true);
    s = await built(page);
    const detail = viewOf(s, 'detail');
    expect((detail?.scale ?? 0) > (front.scale ?? 1)).toBe(true);
    expect(detail?.problems).toEqual([]);
  });

  test('a view has an inline scale (1:2, expressions) and a configuration choice', async ({
    page,
  }) => {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front) throw new Error('no view');
    await panelTab(page, 'Views').click();
    await page.locator(`[data-view-row="${front.id}"]`).click();
    const scale = page.getByLabel('View scale');
    await expect(page.getByTestId('view-inspector')).toBeVisible();
    await scale.fill('1:2');
    await scale.press('Enter');
    await expect
      .poll(async () => (await drawing(page).state()).views[0]?.scale)
      .toBeCloseTo(0.5, 6);
    expect(((await drawings(page))[0] as Drawing).views[0]?.scale).toBe('1/2');
    // An expression works too.
    await scale.fill('1/4');
    await scale.press('Enter');
    await expect
      .poll(async () => (await drawing(page).state()).views[0]?.scale)
      .toBeCloseTo(0.25, 6);
    await expect(page.getByLabel('Configuration of this view')).toHaveValue('inherit');
    await a11y(page);
  });
});

test('views move: a free view goes where it is dragged, an aligned one slides along its axis only', async ({
  page,
}) => {
  await openDemo(page);
  await newDrawing(page);
  await addStandardViews(page);
  const s0 = await drawing(page).state();
  const front = viewOf(s0, 'base');
  const top = viewOf(s0, 'projected', 'top');
  if (!front || !top) throw new Error('no views');
  const grab = async (id: string) => {
    const e = (await drawing(page).edges(id)).find((x) => x.kind === 'line');
    if (!e) throw new Error('no edge');
    return sheetToPage(page, e.at);
  };
  // The front view is free: it follows the pointer in both directions.
  const f0 = await grab(front.id);
  await drag(page, f0, { x: f0.x + 60, y: f0.y + 40 });
  await expect
    .poll(async () => viewOf(await drawing(page).state(), 'base')?.position?.[0])
    .toBeGreaterThan((front.position?.[0] ?? 0) + 5);
  let s = await built(page);
  const moved = viewOf(s, 'base');
  expect((moved?.position?.[1] ?? 0) < (front.position?.[1] ?? 0)).toBe(true);
  // The top view hangs on its parent: it moved with it, and keeps its alignment.
  const top1 = viewOf(s, 'projected', 'top');
  expect(top1?.position?.[0]).toBeCloseTo(moved?.position?.[0] ?? 0, 3);
  expect((await app(page).history()).past.at(-1)?.label).toBe('Move view');

  // Dragging the aligned top view sideways does nothing; dragging it along the axis changes its distance.
  const t0 = await grab(top.id);
  await drag(page, t0, { x: t0.x + 80, y: t0.y + 50 });
  s = await built(page);
  const top2 = viewOf(s, 'projected', 'top');
  expect(top2?.position?.[0]).toBeCloseTo(moved?.position?.[0] ?? 0, 3);
  expect((top2?.position?.[1] ?? 0) < (top1?.position?.[1] ?? 0)).toBe(true);
  const d = ((await drawings(page))[0] as Drawing).views.find((v) => v.id === top.id);
  expect(d?.layout.kind).toBe('aligned');
});

test('switching the projection mirrors the aligned views with no edits to them', async ({
  page,
}) => {
  await openDemo(page);
  await newDrawing(page);
  await addStandardViews(page);
  const before = await drawing(page).state();
  const front = viewOf(before, 'base');
  const top = viewOf(before, 'projected', 'top');
  const side = viewOf(before, 'projected', 'left');
  const storedBefore = JSON.stringify(((await drawings(page))[0] as Drawing).views);

  await panelTab(page, 'Sheet').click();
  await page.getByRole('radio', { name: 'Third angle' }).click();
  await expect.poll(async () => (await drawing(page).state()).projection).toBe('third');
  const after = await built(page);

  // Same stored views, byte for byte: only the drawing's projection changed.
  expect(JSON.stringify(((await drawings(page))[0] as Drawing).views)).toBe(storedBefore);
  const top2 = viewOf(after, 'projected', 'top');
  const side2 = viewOf(after, 'projected', 'left');
  // Third angle: the top view is above the front, the left view is on the left.
  expect((top2?.position?.[1] ?? 0) > (front?.position?.[1] ?? 0)).toBe(true);
  expect((side2?.position?.[0] ?? 0) < (front?.position?.[0] ?? 0)).toBe(true);
  // Mirrored about the parent, at the same distances.
  expect((top2?.position?.[1] ?? 0) - (front?.position?.[1] ?? 0)).toBeCloseTo(
    (front?.position?.[1] ?? 0) - (top?.position?.[1] ?? 0),
    3,
  );
  expect((front?.position?.[0] ?? 0) - (side2?.position?.[0] ?? 0)).toBeCloseTo(
    (side?.position?.[0] ?? 0) - (front?.position?.[0] ?? 0),
    3,
  );
  expect((await app(page).history()).past.at(-1)?.label).toBe('Change projection method');
});

test.describe('annotations', () => {
  test('Import model annotations places them in one step, with the model’s values', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const stepsBefore = (await app(page).history()).past.length;
    await importAll(page);

    const d = (await drawings(page))[0] as Drawing;
    expect(d.placements.length).toBeGreaterThanOrEqual(15);
    // One undo step for the whole import (annotations promoted from the model included).
    const h = await app(page).history();
    expect(h.past.length).toBe(stepsBefore + 1);
    expect(h.past.at(-1)?.label).toBe('Import model annotations');

    // Every dimension is a part annotation with references; promoted ones are bound to the model.
    const list = await annotations(page);
    expect(list.length).toBe(d.placements.length);
    expect(list.every((a) => a.refs.length > 0 || a.kind === 'note')).toBe(true);
    expect(list.some((a) => 'source' in a && a.source?.kind === 'sketchDimension')).toBe(true);

    const s = await built(page);
    const ok = s.resolutions.filter((r) => r.state === 'ok').map((r) => r.value);
    // Width 80, depth 50, thickness 8, the 6 mm holes.
    for (const v of [80, 50, 8, 6]) expect(ok).toContain(v);
    expect(s.texts).toContain('80');
    expect(s.texts).toContain('Ø6');

    // No label sits on another view: each is clear of every view but its own.
    for (const p of await drawing(page).placements()) {
      if (!p.box) continue;
      for (const v of s.views) {
        if (v.id === p.viewId || !v.outline) continue;
        const apart =
          p.box.max[0] <= v.outline.min[0] ||
          p.box.min[0] >= v.outline.max[0] ||
          p.box.max[1] <= v.outline.min[1] ||
          p.box.min[1] >= v.outline.max[1];
        expect(apart, `label of ${p.id} overlaps view ${v.id}`).toBe(true);
      }
    }

    // Nothing is placed twice: a second import has nothing new to offer.
    await panelTab(page, 'Import').click();
    await page.getByTestId('import-open').click();
    await expect(page.getByTestId('import-place')).toHaveText('Place 0 annotations');
    await expect(page.getByTestId('import-place')).toBeDisabled();
    await a11y(page);

    // Undo takes the whole import back.
    await page.getByTestId('drawing-undo').click();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).placements.length).toBe(0);
    expect((await annotations(page)).length).toBe(0);
  });

  test('editing the model updates the dimensions; a promoted value is read-only here', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    let s = await drawing(page).state();
    const widthId = (await annotations(page)).find(
      (a) =>
        a.kind === 'linear' &&
        s.resolutions.find((r) => r.id === a.id)?.value === 80 &&
        'source' in a &&
        a.source?.kind === 'sketchDimension',
    )?.id;
    expect(widthId).toBeTruthy();

    // Edit the parameter behind it: the drawing follows by itself, and never shows the old value.
    const doc = await app(page).doc();
    const width = doc.params.find((p) => p.name === 'width');
    if (!width) throw new Error('no width');
    expect(await app(page).apply({ kind: 'updateParam', paramId: width.id, expr: '100 mm' })).toBe(
      true,
    );
    await expect
      .poll(
        async () => (await drawing(page).state()).resolutions.find((r) => r.id === widthId)?.value,
      )
      .toBe(100);
    s = await built(page);
    expect(s.texts).toContain('100');
    expect(s.texts).not.toContain('80');

    // Select it: the value is read from the model, so there is no field for it here.
    const pl = (await drawing(page).placements()).find((p) => p.annotationId === widthId);
    if (!pl?.text) throw new Error('no placement');
    await click(page, pl.text);
    await expect(page.getByTestId('annotation-inspector')).toBeVisible();
    await expect(page.getByTestId('annotation-readonly')).toBeVisible();
    await expect(page.getByTestId('annotation-value')).toHaveText('100 mm');
    await expect(page.getByLabel('Stated value')).toHaveCount(0);
    await expect(page.getByTestId('annotation-source')).toContainText('Plate sketch');
  });

  test('deleting a referenced feature shows needs attention with no value', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    let s = await drawing(page).state();
    const before = (await annotations(page)).length;
    expect(s.texts).toContain('Ø6');

    // Delete the hole sketch's extrude and the sketch itself: the hole dimensions lose their source.
    const p = await part(page);
    const holeSketch = p.features.find((f) => f.name === 'Hole sketch');
    const holes = p.features.find((f) => f.name === 'Holes');
    if (!holeSketch || !holes) throw new Error('no hole features');
    expect(
      await app(page).apply({ kind: 'removeFeature', partId: p.id, featureId: holes.id }),
    ).toBe(true);
    expect(
      await app(page).apply({ kind: 'removeFeature', partId: p.id, featureId: holeSketch.id }),
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (await drawing(page).state()).resolutions.filter((r) => r.state === 'needsAttention')
            .length,
      )
      .toBeGreaterThanOrEqual(3);
    s = await built(page);

    // They are flagged and carry no value: the old Ø6 is nowhere on the sheet.
    const bad = s.resolutions.filter((r) => r.state === 'needsAttention');
    expect(bad.every((r) => r.value === null)).toBe(true);
    expect(s.texts).not.toContain('Ø6');
    expect((await annotations(page)).length).toBe(before);
    expect(s.texts).toContain('?');
    expect((await drawing(page).placements()).some((x) => x.attention)).toBe(true);

    await panelTab(page, 'Attention').click();
    await expect(page.getByTestId('attention-count')).toContainText('need');
    await expect(page.locator('[data-severity="attention"]').first()).toContainText(
      'Needs attention',
    );
    await expect(page.getByTestId('attention-panel')).not.toContainText('Ø6');
    // Selecting one: the inspector shows no number either (T1 holds in the tolerance field too).
    const flagged = (await drawing(page).placements()).find((x) => x.attention && x.text);
    if (flagged?.text) {
      await panelTab(page, 'Inspector').click();
      await click(page, flagged.text);
      await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(flagged.id);
      const inspector = page.getByTestId('annotation-inspector');
      await expect(inspector).toHaveAttribute('data-state', 'needsAttention');
      await expect(inspector).not.toContainText('Ø6');
      await expect(inspector.getByTestId('tolerance-field').getByRole('textbox')).not.toHaveValue(
        /\d/,
      );
    }
    await a11y(page);
  });

  test('a dimension whose geometry is gone is reattached by picking the edge again', async ({
    page,
  }) => {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front) throw new Error('no front view');
    const p = await part(page);
    const d = (await drawings(page))[0] as Drawing;
    const edges = await drawing(page).edges(front.id);
    const real = edges.filter((e) => e.kind === 'line' && e.a && e.b);
    const [e0, e1] = [real[0], real.find((e) => e.name !== real[0]?.name)];
    if (!e0 || !e1) throw new Error('no edges');
    // A hand-made dimension on two edges that do not exist (a model that has since changed).
    const id = '01J0000000000000000000R001';
    expect(
      await app(page).apply({
        kind: 'addAnnotation',
        partId: p.id,
        annotation: {
          id: id,
          kind: 'aligned',
          origin: { kind: 'drawing', drawingId: d.id },
          refs: [
            { name: 'edge(gone|1)', kind: 'edge' },
            { name: 'edge(gone|2)', kind: 'edge' },
          ],
          at: ['start', 'start'],
        },
        place: {
          drawingId: d.id,
          placement: {
            id: '01J0000000000000000000R002',
            viewId: front.id,
            annotationId: id,
            layout: { kind: 'offset', distance: 10 },
          },
        },
      }),
    ).toBe(true);
    await expect
      .poll(async () => (await drawing(page).state()).resolutions.find((r) => r.id === id)?.state)
      .toBe('needsAttention');
    await built(page);
    await panelTab(page, 'Attention').click();
    await page.locator('[data-reattach]').first().click();
    await expect(page.getByTestId('prompt-chip')).toContainText(
      'Pick the new edge for reference 1 of 2',
    );
    await click(page, e0.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('reference 2 of 2');
    await click(page, e1.at);
    // One `reattachAnnotation` step; the value is measured from the new geometry.
    await expect
      .poll(async () => (await drawing(page).state()).resolutions.find((r) => r.id === id)?.state)
      .toBe('ok');
    const a = (await annotations(page)).find((x) => x.id === id);
    expect(a?.refs.map((r) => r.name)).toEqual([e0.name, e1.name]);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Reattach annotation');
  });

  test('the dimension tool picks edges; a tolerance is typed inline; frames, datums and finishes attach', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const s = await built(page);
    const top = viewOf(s, 'projected', 'top');
    if (!top) throw new Error('no top view');

    // Two vertical edges of the plate in the top view: the width.
    const edges = (await drawing(page).edges(top.id)).filter(
      (e) =>
        e.kind === 'line' &&
        e.a &&
        e.b &&
        Math.abs(e.a[0] - e.b[0]) < 0.01 &&
        Math.abs(e.a[1] - e.b[1]) > 30,
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const sorted = [...edges].sort((p, q) => p.at[0] - q.at[0]);
    const left = sorted[0];
    const right = sorted.at(-1);
    if (!left || !right) throw new Error('no edges');
    await page.locator('[data-tool="dimension"]').click();
    await expect(page.getByTestId('prompt-chip')).toContainText('Pick');
    await click(page, left.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('second edge');
    await click(page, right.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const a = (await annotations(page))[0] as Annotation;
    expect(a.kind).toBe('linear');
    // A drawing dimension: a part annotation with resolved references.
    expect(a.origin.kind).toBe('drawing');
    expect(a.refs).toHaveLength(2);
    expect(a.refs.every((r) => r.kind === 'edge' && r.name.length > 0)).toBe(true);
    await expect
      .poll(async () => (await drawing(page).state()).resolutions.find((r) => r.id === a.id)?.value)
      .toBe(80);

    // The new dimension is selected: type a tolerance as written on a drawing.
    const tol = page.getByTestId('tolerance-field').getByRole('textbox');
    await tol.fill('+0.1/-0.05');
    await expect(page.getByTestId('tolerance-field')).toContainText('Reads as');
    await tol.press('Enter');
    await expect
      .poll(
        async () =>
          ((await annotations(page))[0] as { tolerance?: { kind: string } }).tolerance?.kind,
      )
      .toBe('bilateral');
    await tol.fill('plus minus');
    await expect(page.getByTestId('tolerance-field').getByRole('alert')).toBeVisible();
    await tol.press('Escape');

    // A datum on an edge: the next free letter, never I, O or Q.
    await page.locator('[data-tool="datum"]').click();
    await click(page, left.at);
    await expect
      .poll(async () => (await annotations(page)).filter((x) => x.kind === 'datumFeature').length)
      .toBe(1);
    expect(
      ((await annotations(page)).find((x) => x.kind === 'datumFeature') as { label: string }).label,
    ).toBe('A');
    // A tolerance frame, a surface finish.
    await page.locator('[data-tool="gdt"]').click();
    await click(page, right.at);
    await expect
      .poll(
        async () => (await annotations(page)).filter((x) => x.kind === 'geometricTolerance').length,
      )
      .toBe(1);
    await expect(page.getByLabel('Geometric characteristic')).toBeVisible();
    await page.locator('[data-tool="finish"]').click();
    // A quarter of the way along the edge: the frame's leader sits at its middle.
    if (!right.a || !right.b) throw new Error('no edge ends');
    await click(page, [
      right.a[0] + (right.b[0] - right.a[0]) * 0.25,
      right.a[1] + (right.b[1] - right.a[1]) * 0.25,
    ]);
    await expect
      .poll(async () => (await annotations(page)).filter((x) => x.kind === 'surfaceFinish').length)
      .toBe(1);
    await built(page);
    await a11y(page);
  });

  test('a dimension can be dragged between lanes (and set inline); one undo step', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const s = await drawing(page).state();
    const top = viewOf(s, 'projected', 'top');
    if (!top?.outline) throw new Error('no top view');
    const placements = await drawing(page).placements();
    const lane = placements.find((p) => p.viewId === top.id && p.layout.kind === 'lane');
    if (!lane?.text || lane.layout.kind !== 'lane') throw new Error('no lane placement');
    // One lane and a bit further out, on the side the dimension is on.
    const out: [number, number] =
      lane.layout.side === 'bottom'
        ? [0, -9]
        : lane.layout.side === 'top'
          ? [0, 9]
          : lane.layout.side === 'left'
            ? [-9, 0]
            : [9, 0];
    // Press on the dimension line (the text drags apart from it, ADR-094).
    if (!lane.line) throw new Error('no dimension line');
    const at: [number, number] = [
      (lane.line[0][0] * 3 + lane.line[1][0]) / 4,
      (lane.line[0][1] * 3 + lane.line[1][1]) / 4,
    ];
    const from = await sheetToPage(page, at);
    const to = await sheetToPage(page, [at[0] + out[0], at[1] + out[1]]);
    await drag(page, from, to);
    await expect
      .poll(async () => {
        const d = (await drawings(page))[0] as Drawing;
        const p = d.placements.find((x) => x.id === lane.id);
        return p?.layout.kind === 'lane' ? p.layout.lane : -1;
      })
      .toBeGreaterThan(lane.layout.lane ?? 0);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move annotation');
    // The inline alternative to dragging (WCAG 2.5.7).
    await expect(page.getByLabel('Lane (0 is nearest the view)')).toBeVisible();
  });
});

test('the title block is edited inline: bound values show, overrides are badged and reversible', async ({
  page,
}) => {
  await openDemo(page);
  await newDrawing(page);
  await panelTab(page, 'Title block').click();
  const editor = page.getByTestId('title-block-editor');
  const row = editor.locator('[data-slot="partNumber"]');
  await expect(row).toHaveAttribute('data-source', 'bound');
  await expect(row.getByRole('textbox')).toHaveValue('Demo bracket');
  await expect(page.getByTestId('slot-badge-partNumber')).toHaveText('From the model');
  await expect(editor.locator('[data-slot="material"] input')).toHaveValue('Aluminium 6061-T6');

  // Override on the sheet itself: click the cell, type, Enter.
  await panelTab(page, 'Inspector').click();
  const cell = page.locator('[data-source="titleBlock:partNumber"]').first();
  const box = await cell.boundingBox();
  if (!box) throw new Error('no cell');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('cell-editor')).toBeVisible();
  const field = page.getByTestId('cell-editor').getByRole('textbox');
  await field.fill('BR-100');
  await field.press('Enter');
  await expect
    .poll(async () => {
      const d = (await drawings(page))[0] as Drawing;
      return d.template.fields?.partNumber ?? d.sheets[0]?.fields?.partNumber;
    })
    .toBe('BR-100');
  await built(page);
  await panelTab(page, 'Title block').click();
  await expect(page.getByTestId('slot-badge-partNumber')).toHaveText('Overrides the model');
  await expect(row.getByRole('textbox')).toHaveValue('BR-100');
  await expect(row).toContainText('The model says: Demo bracket');
  expect((await drawing(page).state()).texts).toContain('BR-100');
  await a11y(page);

  // One tap back to the model's value.
  await page
    .getByRole('button', { name: /Use the model’s value for/ })
    .first()
    .click();
  await expect(row).toHaveAttribute('data-source', 'bound');
  await expect(row.getByRole('textbox')).toHaveValue('Demo bracket');
});

test('pan and zoom: wheel zoom, drag pan, fit, and keyboard', async ({ page }) => {
  await openDemo(page);
  await newDrawing(page);
  const viewer = page.getByTestId('sheet-viewer');
  const box = await viewer.boundingBox();
  if (!box) throw new Error('no viewer');
  const zoom = async () => Number(await viewer.getAttribute('data-zoom'));
  const z0 = await zoom();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(zoom).toBeGreaterThan(z0);
  const content = page.getByTestId('drawing-sheet-content');
  const t0 = await content.getAttribute('transform');
  // The middle button pans anywhere (a drag on a view moves the view); so do the arrow keys.
  await drag(
    page,
    { x: box.x + 200, y: box.y + 200 },
    { x: box.x + 260, y: box.y + 240 },
    10,
    'middle',
  );
  expect(await content.getAttribute('transform')).not.toBe(t0);
  await page.getByRole('button', { name: 'Fit sheet to window' }).click();
  await expect.poll(zoom).toBe(100);
  await viewer.focus();
  await page.keyboard.press('+');
  await expect.poll(zoom).toBeGreaterThan(100);
  await page.keyboard.press('0');
  await expect.poll(zoom).toBe(100);
});

test.describe('export', () => {
  test('PDF is a vector page of the sheet size, at true scale', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    await panelTab(page, 'Export').click();
    await a11y(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-export="pdf"]').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const bytes = readFileSync(await download.path());
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    // The MediaBox is the A3 landscape sheet in points: 420 x 297 mm.
    const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeCloseTo((420 * 72) / 25.4, 1);
    expect(Number(m?.[2])).toBeCloseTo((297 * 72) / 25.4, 1);
    expect(text).toContain('/PrintScaling /None');
    expect(bytes.length).toBeGreaterThan(12_000);
    // Exported from the exact edges (waited for, never the draft).
    expect((await drawing(page).state()).quality).toBe('exact');
    await expect(page.getByTestId('drawing-toast')).toContainText('.pdf');
  });

  test('SVG and DXF (R12 and R2000) download', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await panelTab(page, 'Export').click();
    const get = async (id: string) => {
      const [d] = await Promise.all([
        page.waitForEvent('download'),
        page.locator(`[data-export="${id}"]`).click(),
      ]);
      return { name: d.suggestedFilename(), text: readFileSync(await d.path()).toString('utf8') };
    };
    const svg = await get('svg');
    expect(svg.name).toMatch(/\.svg$/);
    expect(svg.text).toContain('<svg');
    expect(svg.text).toContain('width="420mm"');
    const r12 = await get('dxf-r12');
    expect(r12.name).toMatch(/r12\.dxf$/);
    expect(r12.text).toContain('AC1009');
    expect(r12.text.trimEnd().endsWith('EOF')).toBe(true);
    const r2000 = await get('dxf-r2000');
    expect(r2000.text).toContain('AC1015');
    expect(r2000.text).toContain('$INSUNITS');
    // An export is made from the exact edges, and those have exact circles: the bracket's Ø6 holes
    // are CIRCLE entities of radius 3 (at 1:1; scaled otherwise), not polylines.
    expect((await drawing(page).state()).quality).toBe('exact');
    expect(r2000.text).toMatch(/\n\s*0\nCIRCLE\n/);
    expect(r2000.text).toMatch(/\n\s*40\n3(\.0*)?\n/);
  });
});

test('Escape leaves a tool; deleting a view takes what derives from it, and undo restores it', async ({
  page,
}) => {
  await openDemo(page);
  await newDrawing(page);
  await addStandardViews(page);
  await page.locator('[data-tool="dimension"]').click();
  await expect(page.getByTestId('prompt-chip')).toBeVisible();
  await page.getByTestId('sheet-viewer').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('prompt-chip')).toHaveCount(0);
  await panelTab(page, 'Views').click();
  const front = viewOf(await drawing(page).state(), 'base');
  await page.locator(`[data-view-row="${front?.id}"]`).click();
  await page.getByTestId('delete-view').click();
  // The top and side views derive from it: they go with it.
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(0);
  await page.getByTestId('drawing-undo').click();
  await expect.poll(async () => (await drawing(page).state()).views.length).toBe(3);
});

test('configurations: per drawing and per view, badged; a missing one is never a quiet fallback', async ({
  page,
}) => {
  await boot(page);
  await app(page).load(configPartDoc());
  await app(page).idle();
  const s0 = await newDrawing(page);
  const front = viewOf(s0, 'base');
  if (!front) throw new Error('no front view');

  // A width dimension picked on two vertical edges of the front view: 40 in Default.
  const edges = (await drawing(page).edges(front.id)).filter(
    (e) =>
      e.kind === 'line' &&
      e.a &&
      e.b &&
      Math.abs((e.a[0] ?? 0) - (e.b[0] ?? 0)) < 0.01 &&
      Math.abs((e.a[1] ?? 0) - (e.b[1] ?? 0)) > 5,
  );
  const sorted = [...edges].sort((p, q) => p.at[0] - q.at[0]);
  const [left, right] = [sorted[0], sorted.at(-1)];
  if (!left || !right) throw new Error('no vertical edges');
  await page.locator('[data-tool="dimension"]').click();
  await click(page, left.at);
  await click(page, right.at);
  await expect.poll(async () => (await annotations(page)).length).toBe(1);
  await expect.poll(async () => (await drawing(page).state()).texts).toContain('40');

  // The drawing's configuration: Long is 60 wide. Title block and header say which one it is.
  await panelTab(page, 'Sheet').click();
  await page.getByLabel('Configuration of this drawing').selectOption({ label: 'Long' });
  await expect.poll(async () => (await drawing(page).state()).texts).toContain('60');
  await expect(page.getByTestId('config-badge').first()).toHaveText('Long');
  expect((await drawing(page).state()).texts).toContain('Long');
  expect((await drawing(page).state()).texts).not.toContain('40');
  expect(((await drawings(page))[0] as Drawing).configurationId).toBe(CFG_LONG);
  // The model itself is untouched: the active configuration is still Default.
  expect((await part(page)).activeConfigurationId ?? null).toBeNull();

  // Back to Default for the drawing, Long for the view alone: a badge on the view, 60 on the sheet.
  await page.getByLabel('Configuration of this drawing').selectOption({ label: 'Default' });
  await expect.poll(async () => (await drawing(page).state()).texts).toContain('40');
  await panelTab(page, 'Views').click();
  await page.locator(`[data-view-row="${front.id}"]`).click();
  await page.getByLabel('Configuration of this view').selectOption({ label: 'Long' });
  await expect.poll(async () => (await drawing(page).state()).texts).toContain('60');
  await panelTab(page, 'Views').click();
  await expect(
    page.locator(`[data-view-row="${front.id}"]`).getByTestId('config-badge'),
  ).toHaveText('Long');
  await a11y(page);

  // The configuration is deleted: the view needs attention. It does not fall back to Default.
  const p = await part(page);
  expect(
    await app(page).apply({ kind: 'removeConfiguration', partId: p.id, configurationId: CFG_LONG }),
  ).toBe(true);
  await expect
    .poll(async () =>
      (await drawing(page).state()).attention.some((e) => /configuration/i.test(e.message)),
    )
    .toBe(true);
  const after = await built(page);
  expect(after.texts).not.toContain('60');
  expect(after.texts).not.toContain('40');
  await expect(
    page.locator(`[data-view-row="${front.id}"]`).getByTestId('config-badge'),
  ).toHaveAttribute('data-missing', 'true');
});

/** A plate with one ISO M6 clearance hole (normal fit, through all) on a sketch point. */
function holeDoc(): WrenDoc {
  const S1 = fid('S1');
  const E1 = fid('E1');
  const S2 = fid('S2');
  const H = fid('H1');
  const plate = new Sk();
  const r = plate.rect('p', 'L', 0, 0, 80, 50, '80 mm', '50 mm');
  plate.geo({ kind: 'fix', entity: r.a });
  const top = { name: `F${E1}:end`, kind: 'face' as const };
  const pts = new Sk();
  pts.point('p', 15, 25);
  pts.dim({ kind: 'hDistance', a: '@origin', b: 'p' }, '15 mm');
  pts.dim({ kind: 'vDistance', a: '@origin', b: 'p' }, '25 mm');
  const hole: HoleFeature = {
    id: H,
    type: 'hole',
    name: 'Hole',
    suppressed: false,
    points: [{ name: `S${S2}:p(p)`, kind: 'vertex' }],
    face: top,
    standard: 'ISO',
    kind: 'simple',
    size: 'M6',
    fit: 'normal',
    end: { kind: 'throughAll' },
  };
  return docWith('Hole plate', {}, [
    plate.feature(S1, 'Plate sketch'),
    extrude(E1, 'Plate', [region(S1, 'L1,L2,L3,L4')], '10'),
    pts.feature(S2, 'Hole point', top),
    hole,
  ]);
}

test('a hole feature is imported as a hole callout: size, fit and depth come from the feature', async ({
  page,
}) => {
  await boot(page);
  await app(page).load(holeDoc());
  await app(page).idle();
  await newDrawing(page);
  await addStandardViews(page);
  await importAll(page);
  const list = await annotations(page);
  const callout = list.find((a) => a.kind === 'holeCallout');
  expect(callout).toBeTruthy();
  expect(callout && 'source' in callout ? callout.source : null).toMatchObject({
    kind: 'feature',
    featureId: fid('H1'),
  });
  const s = await built(page);
  // ISO 273 M6 normal clearance is 6.6 mm, through all.
  expect(s.texts.some((t) => t.includes('Ø6.6'))).toBe(true);
  expect(s.texts.some((t) => /THRU/.test(t))).toBe(true);
  // The callout is on the view that shows the hole face-on, and the model value is not stated.
  const row = s.resolutions.find((r) => r.id === callout?.id);
  expect(row?.state).toBe('ok');
  // Changing the hole's size changes the callout: one source of truth.
  const doc = await app(page).doc();
  const feature = doc.parts[0]?.features.find((f) => f.id === fid('H1')) as HoleFeature;
  expect(
    await app(page).apply({
      kind: 'updateFeature',
      partId: doc.parts[0]?.id,
      featureId: feature.id,
      feature: { ...feature, size: 'M8' },
    }),
  ).toBe(true);
  await expect
    .poll(async () => (await drawing(page).state()).texts.some((t) => t.includes('Ø9')))
    .toBe(true);
});

// ------------------------------------------------------------------------------------------------
// M4 gate follow-ups (ADR-092 amendment): placement fields, drag cancel, and the P1 drawing tools.
// ------------------------------------------------------------------------------------------------

const historyLen = async (page: Page) => (await app(page).history()).past.length;

const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prints: number }).__prints);
const stubPrint = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });

const placementOf = async (page: Page, id: string) =>
  ((await drawings(page))[0] as Drawing).placements.find((x) => x.id === id);

test.describe('placement fields (gate 1)', () => {
  test('a placement field takes an expression, commits on Enter, and is one undo step', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const radial = (await drawing(page).placements()).find(
      (p) => p.layout.kind === 'radial' && p.text,
    );
    if (!radial?.text) throw new Error('no radial placement');
    await click(page, radial.text);
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(radial.id);
    const field = page.getByLabel('Text distance (mm)');
    const before = await historyLen(page);
    const distance = async () => {
      const p = await placementOf(page, radial.id);
      return p?.layout.kind === 'radial' ? p.layout.distance : null;
    };
    // Typing alone commits nothing: no step per keystroke.
    await field.fill('1');
    await page.keyboard.type('2+3');
    expect(await historyLen(page)).toBe(before);
    await field.press('Enter');
    await expect.poll(distance).toBe(15);
    expect(await historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move annotation');
    // Units are accepted too: sheet millimetres, whatever the document's default unit.
    await field.fill('0.5in');
    await field.press('Enter');
    await expect.poll(distance).toBeCloseTo(12.7, 3);
    // One undo undoes one edit.
    await page.getByTestId('drawing-undo').click();
    await expect.poll(distance).toBe(15);
    await a11y(page);
  });
});

test.describe('drag cancel (gate 2)', () => {
  test('Escape in the middle of a drag restores the placement and leaves nothing in history', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const top = viewOf(await drawing(page).state(), 'projected', 'top');
    const lane = (await drawing(page).placements()).find(
      (p) => p.viewId === top?.id && p.layout.kind === 'lane' && p.text,
    );
    if (!lane?.text || lane.layout.kind !== 'lane') throw new Error('no lane placement');
    const before = await historyLen(page);
    const future0 = (await app(page).history()).future.length;
    const layoutOf = async () => JSON.stringify((await placementOf(page, lane.id))?.layout);
    const original = await layoutOf();
    const from = await sheetToPage(page, lane.text);
    const away = lane.layout.side === 'bottom' ? 3 : -3;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x, from.y + i * away);
    // The drag is a preview (ADR-094): the dimension is redrawn under the pointer, and the stored
    // placement is not touched until release.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-transient="model"]')?.childElementCount ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    expect(await layoutOf()).toBe(original);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-transient="model"]')?.childElementCount ?? 0,
        ),
      )
      .toBe(0);
    await expect.poll(layoutOf).toBe(original);
    const h = await app(page).history();
    expect(h.past.length).toBe(before);
    expect(h.future.length).toBe(future0);
  });

  test('Escape in the middle of dragging a view restores it', async ({ page }) => {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front?.outline || !front.position) throw new Error('no front view');
    const x0 = front.position[0];
    const edge = (await drawing(page).edges(front.id)).find((e) => e.kind === 'line');
    if (!edge) throw new Error('no edge');
    const before = await historyLen(page);
    const from = await sheetToPage(page, edge.at);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + i * 6, from.y + i * 4);
    const x = async () => viewOf(await drawing(page).state(), 'base')?.position?.[0] ?? 0;
    const moved = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll<SVGElement>('[data-host]')].filter(
            (e) => e.style.transform !== '',
          ).length,
      );
    // The view is previewed under the pointer; its stored position is untouched (ADR-094).
    await expect.poll(moved).toBeGreaterThan(0);
    expect(Math.abs((await x()) - x0)).toBeLessThan(0.001);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(moved).toBe(0);
    await expect.poll(async () => Math.abs((await x()) - x0)).toBeLessThan(0.001);
    expect(await historyLen(page)).toBe(before);
    expect((await app(page).history()).future.length).toBe(0);
  });
});

test.describe('angular dimension (P1)', () => {
  test('the Angle tool picks two edges that meet; the arc is placed and typed inline', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const front = viewOf(await built(page), 'base');
    if (!front) throw new Error('no front view');
    const [e1, e2] = await cornerEdges(page, front.id);
    await page.locator('[data-tool="angle"]').click();
    await expect(page.getByTestId('prompt-chip')).toContainText('first');
    await click(page, e1.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('second edge');
    await click(page, e2.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const a = (await annotations(page))[0] as Annotation;
    expect(a.kind).toBe('angle');
    expect(a.origin.kind).toBe('drawing');
    expect(a.refs).toHaveLength(2);
    const p = ((await drawings(page))[0] as Drawing).placements[0];
    expect(p?.layout.kind).toBe('arc');
    const row = async () => (await drawing(page).state()).resolutions.find((r) => r.id === a.id);
    await expect.poll(async () => (await row())?.state).toBe('ok');
    const v = (await row())?.value ?? 0;
    expect(Math.abs(v - 90) < 0.01 || Math.abs(v - Math.PI / 2) < 1e-4).toBe(true);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Add angle dimension');
    await expect
      .poll(async () => (await drawing(page).state()).texts.some((t) => t.includes('90')))
      .toBe(true);
    // The arc radius is an inline field with units; the other sector is a switch.
    const radius = page.getByLabel('Arc radius (mm)');
    await radius.fill('14+2');
    await radius.press('Enter');
    const arc = async () => {
      const q = ((await drawings(page))[0] as Drawing).placements[0];
      return q?.layout.kind === 'arc' ? q.layout : null;
    };
    await expect.poll(async () => (await arc())?.radius).toBe(16);
    await page.getByRole('switch', { name: 'Opposite angle (same value)' }).click();
    await expect.poll(async () => (await arc())?.opposite).toBe(true);
    await a11y(page);
  });

  test('the Dimension tool on two edges that meet makes an angle', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const front = viewOf(await built(page), 'base');
    if (!front) throw new Error('no front view');
    const [e1, e2] = await cornerEdges(page, front.id);
    await page.locator('[data-tool="dimension"]').click();
    await click(page, e1.at);
    await click(page, e2.at);
    await expect.poll(async () => (await annotations(page)).map((a) => a.kind)).toEqual(['angle']);
  });
});

test.describe('print (P1)', () => {
  test('Print writes the sheet at true scale into a print stylesheet and calls the browser print', async ({
    page,
  }) => {
    await stubPrint(page);
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    await panelTab(page, 'Export').click();
    await a11y(page);
    await page.locator('[data-export="print"]').click();
    await expect.poll(() => printCalls(page)).toBe(1);
    const root = page.locator('#wren-print');
    await expect(root).toHaveCount(1);
    const svg = root.locator('svg').first();
    // A3 landscape, in millimetres.
    await expect(svg).toHaveAttribute('width', '420mm');
    await expect(svg).toHaveAttribute('height', '297mm');
    const css = await root.locator('style').textContent();
    expect(css).toContain('size: 420mm 297mm');
    expect(css).toContain('margin: 0');
    // Invisible on screen; in print media the only thing shown, 420 mm wide at 96 dpi.
    await expect(root).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await expect(root).toBeVisible();
    const box = await svg.boundingBox();
    expect(box?.width).toBeCloseTo((420 * 96) / 25.4, 0);
    expect(box?.height).toBeCloseTo((297 * 96) / 25.4, 0);
    await expect(page.getByTestId('drawing-route')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(root).toHaveCount(0);
    // From the exact edges, as the exports are.
    expect((await drawing(page).state()).quality).toBe('exact');
  });

  test('Ctrl+P prints the sheet instead of the app around it', async ({ page }) => {
    await stubPrint(page);
    await openDemo(page);
    await newDrawing(page);
    await page.getByTestId('sheet-viewer').focus();
    await page.keyboard.press('Control+p');
    await expect.poll(() => printCalls(page)).toBe(1);
    await expect(page.locator('#wren-print svg')).toHaveCount(1);
  });
});

test.describe('part properties table (P1)', () => {
  const tableOf = async (page: Page) =>
    ((await drawings(page))[0] as Drawing).tables[0] as
      | { columns: string[]; massUnit?: string; position: [number, number] }
      | undefined;

  test('added from the toolbar in one step; columns, mass unit and position are inline; delete and undo', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    const before = await historyLen(page);
    await page.locator('[data-tool="table"]').click();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).tables.length).toBe(1);
    expect(await historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Add part properties table');
    expect(((await drawings(page))[0] as Drawing).tables[0]?.kind).toBe('partProperties');
    await built(page);
    expect((await drawing(page).state()).texts).toEqual(
      expect.arrayContaining(['PART NO.', 'MATERIAL', 'MASS']),
    );
    await expect(page.getByTestId('table-inspector')).toBeVisible();
    await a11y(page);

    // Columns: the configuration column is added, mass goes to kg.
    await page.getByRole('switch', { name: 'Configuration' }).click();
    await expect.poll(async () => (await tableOf(page))?.columns).toContain('configuration');
    await page.getByRole('radio', { name: 'kg' }).click();
    await expect.poll(async () => (await tableOf(page))?.massUnit).toBe('kg');
    // The position is typed, with expressions (the alternative to dragging).
    const x = page.getByLabel('Table position X (mm)');
    await x.fill('300+20');
    await x.press('Enter');
    await expect.poll(async () => (await tableOf(page))?.position[0]).toBe(320);
    // Dragging it: Escape restores.
    const table = await tableOf(page);
    if (!table) throw new Error('no table');
    const n = await historyLen(page);
    const start = await sheetToPage(page, [320 - 8, table.position[1] - 3]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(start.x - i * 8, start.y + i * 6);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(async () => (await tableOf(page))?.position[0]).toBe(320);
    expect(await historyLen(page)).toBe(n);
    // Dragged for real: the table is previewed under the pointer (ADR-094), one step on release.
    await built(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(start.x - i * 8, start.y + i * 6);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<SVGElement>('[data-source^="table:"]')].filter(
              (e) => e.style.transform !== '',
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    expect((await tableOf(page))?.position[0]).toBe(320);
    await page.mouse.up();
    await expect.poll(async () => (await tableOf(page))?.position[0]).toBeLessThan(310);
    expect(await historyLen(page)).toBe(n + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move table');
    await built(page);
    // Delete and undo.
    await page.getByTestId('delete-table').click();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).tables.length).toBe(0);
    await page.getByTestId('drawing-undo').click();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).tables.length).toBe(1);
  });

  test('a second table is not added: the sheet’s own is selected', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await page.locator('[data-tool="table"]').click();
    await expect.poll(async () => ((await drawings(page))[0] as Drawing).tables.length).toBe(1);
    await page.locator('[data-tool="table"]').click();
    expect(((await drawings(page))[0] as Drawing).tables).toHaveLength(1);
    await expect(page.getByTestId('drawing-toast')).toContainText('already has');
  });
});

test.describe('half and offset sections (P1)', () => {
  /** A section across the middle of the front view, drawn with the Section tool. */
  async function drawSection(page: Page) {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front?.outline) throw new Error('no front view');
    const [minX, minY] = front.outline.min;
    const [maxX, maxY] = front.outline.max;
    await page.locator('[data-tool="section"]').click();
    const y = (minY + maxY) / 2;
    await drag(
      page,
      await sheetToPage(page, [minX + 1, y]),
      await sheetToPage(page, [maxX - 1, y]),
    );
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'section'))
      .toBe(true);
    await built(page);
    return async () => {
      const v = ((await drawings(page))[0] as Drawing).views.find((x) => x.kind === 'section');
      return v && 'cut' in v ? v.cut : [];
    };
  }

  test('a straight cut becomes a half section, then an offset one; vertices are typed or dragged', async ({
    page,
  }) => {
    const cutOf = await drawSection(page);
    const cutLen = async () => (await cutOf()).length;
    expect(await cutLen()).toBe(2);
    await expect(page.getByTestId('cut-kind')).toContainText('full section');
    await page.getByTestId('cut-half').click();
    await expect.poll(cutLen).toBe(3);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Make half section');
    await expect(page.getByTestId('cut-kind')).toContainText('half section');
    const sec = viewOf(await built(page), 'section');
    expect(sec?.problems).toEqual([]);
    expect((sec?.curves ?? 0) > 0).toBe(true);
    // Back to straight with one undo; then an offset section.
    await page.getByTestId('drawing-undo').click();
    await expect.poll(cutLen).toBe(2);
    await page.getByTestId('cut-offset').click();
    await expect.poll(cutLen).toBe(4);
    await expect(page.getByTestId('cut-kind')).toContainText('offset section');
    expect(viewOf(await built(page), 'section')?.problems).toEqual([]);

    // A vertex is typed inline: one undo step.
    const before = await historyLen(page);
    const x = page.getByLabel('Cut vertex 2 X (mm)');
    const old = (await cutOf())[1];
    if (old?.kind !== 'free') throw new Error('vertex is not free');
    await x.fill(`${old.at[0]}+4`);
    await x.press('Enter');
    await expect
      .poll(async () => {
        const p = (await cutOf())[1];
        return p?.kind === 'free' ? Math.round((p.at[0] - old.at[0]) * 1000) / 1000 : null;
      })
      .toBe(4);
    expect(await historyLen(page)).toBe(before + 1);

    // A vertex is dragged on the sheet; Escape restores it.
    const handle = page.locator('[data-testid="cut-handle"][data-index="2"]');
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('no cut handle');
    const hx = hb.x + hb.width / 2;
    const hy = hb.y + hb.height / 2;
    const n = await historyLen(page);
    const was = JSON.stringify(await cutOf());
    const cutJson = async () => JSON.stringify(await cutOf());
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(hx + i * 4, hy);
    // The cut line follows the pointer as a preview; nothing is stored until release (ADR-094).
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-transient="overlay"]')?.childElementCount ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    expect(await cutJson()).toBe(was);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('[data-transient="overlay"]')?.childElementCount ?? 0,
        ),
      )
      .toBe(0);
    await expect.poll(cutJson).toBe(was);
    expect(await historyLen(page)).toBe(n);
    // The sheet is rebuilt from the restored cut before the next press.
    await built(page);
    // And dragged for real: one step.
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(hx + i * 4, hy);
    await page.mouse.up();
    await expect.poll(cutJson).not.toBe(was);
    expect(await historyLen(page)).toBe(n + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Edit cut line');

    // Add and remove a vertex.
    await page.getByTestId('cut-add').click();
    await expect.poll(cutLen).toBe(5);
    await page.getByRole('button', { name: 'Remove vertex 3' }).click();
    await expect.poll(cutLen).toBe(4);
    await a11y(page);
  });
});

test.describe('ordinate and chamfer dimensions (P1)', () => {
  test('the Ordinate tool reads coordinates from one origin; they share a lane', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const s0 = await built(page);
    // A view with vertical edges at three different places: the origin and two features.
    let found: { left: Edge; right: Edge; mid: Edge } | undefined;
    for (const v of s0.views) {
      const verticals = (await drawing(page).edges(v.id))
        .filter((e) => e.kind === 'line' && e.a && e.b && Math.abs(e.a[0] - e.b[0]) < 0.01)
        .sort((p, q) => p.at[0] - q.at[0]);
      const left = verticals[0];
      const right = verticals.at(-1);
      const mid = verticals.find(
        (e) => left && right && e.at[0] > left.at[0] + 3 && e.at[0] < right.at[0] - 3,
      );
      if (left && right && mid && !found) found = { left, right, mid };
    }
    if (!found) throw new Error('no view with vertical edges at three places');
    const { left, right, mid } = found;
    await page.locator('[data-tool="ordinate"]').click();
    await expect(page.getByTestId('prompt-chip')).toContainText('origin');
    await click(page, left.at);
    await expect(page.getByTestId('prompt-chip')).toContainText('feature');
    await click(page, right.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const a = (await annotations(page))[0] as Annotation;
    expect(a.kind).toBe('ordinate');
    expect(a.refs).toHaveLength(2);
    expect(a.origin.kind).toBe('drawing');
    // Along one of the view's axes: a unit vector.
    const dir = 'direction' in a && a.direction ? a.direction : [0, 0, 0];
    expect(Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0)).toBeCloseTo(1, 6);
    await expect
      .poll(async () => (await drawing(page).state()).resolutions.find((r) => r.id === a.id)?.state)
      .toBe('ok');
    expect((await app(page).history()).past.at(-1)?.label).toBe('Add ordinate dimension');
    // The origin stays picked: another feature joins the same group, in the same lane.
    await expect(page.getByTestId('prompt-chip')).toContainText('next');
    await click(page, mid.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(2);
    const lanes = ((await drawings(page))[0] as Drawing).placements.map((p) =>
      p.layout.kind === 'lane' ? `${p.layout.side}:${p.layout.lane}` : p.layout.kind,
    );
    expect(new Set(lanes).size).toBe(1);
    await a11y(page);
  });

  test('the Chamfer tool attaches a callout to the chamfer feature; other edges are refused', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const s = await built(page);
    let pick: { viewId: string; at: [number, number]; name: string } | undefined;
    for (const v of s.views) {
      for (const e of await drawing(page).edges(v.id)) {
        if (e.kind === 'line' && /:chamfer\(/.test(e.name))
          pick ??= { viewId: v.id, at: e.at, name: e.name };
      }
    }
    if (!pick) throw new Error('no chamfer edge on any view');
    await page.locator('[data-tool="chamfer"]').click();
    await expect(page.getByTestId('prompt-chip')).toContainText('chamfer');
    // An edge that is not on a chamfer is refused, with the reason.
    const plain = (await drawing(page).edges(pick.viewId)).find(
      (e) => e.kind === 'line' && !/:chamfer\(/.test(e.name),
    );
    if (plain) {
      await click(page, plain.at);
      await expect(page.getByTestId('drawing-toast')).toContainText('not on a chamfer');
      expect(await annotations(page)).toHaveLength(0);
    }
    await click(page, pick.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    const a = (await annotations(page))[0] as Annotation;
    expect(a.kind).toBe('chamfer');
    expect(a.refs[0]?.kind).toBe('face');
    expect('source' in a && a.source?.kind).toBe('feature');
    await expect
      .poll(async () => (await drawing(page).state()).resolutions.find((r) => r.id === a.id)?.state)
      .toBe('ok');
    expect((await app(page).history()).past.at(-1)?.label).toBe('Add chamfer callout');
    // The numbers are the feature's: distance and angle, never a placeholder.
    await expect
      .poll(async () =>
        (await drawing(page).state()).texts.some((t) => /^[\d.]+ × [\d.]+°$/.test(t)),
      )
      .toBe(true);
    // A second callout for the same chamfer is not made.
    await click(page, pick.at);
    await expect(page.getByTestId('drawing-toast')).toContainText('already has a callout');
    expect(await annotations(page)).toHaveLength(1);
    await a11y(page);
  });
});

test.describe('rotate a base view (P1)', () => {
  test('a base view turns by an angle expression; views from it follow; one undo step', async ({
    page,
  }) => {
    await openDemo(page);
    const s0 = await newDrawing(page);
    const front = viewOf(s0, 'base');
    if (!front?.outline) throw new Error('no front view');
    const w0 = front.outline.max[0] - front.outline.min[0];
    const h0 = front.outline.max[1] - front.outline.min[1];
    const edge = (await drawing(page).edges(front.id)).find((e) => e.kind === 'line');
    if (!edge) throw new Error('no edge');
    await click(page, edge.at);
    await expect.poll(async () => (await drawing(page).state()).selected?.kind).toBe('view');
    const before = await historyLen(page);
    const field = page.getByLabel('View rotation');
    await field.fill('45+45');
    await field.press('Enter');
    await expect
      .poll(async () => {
        const v = ((await drawings(page))[0] as Drawing).views[0];
        return v?.kind === 'base' ? v.rotation : null;
      })
      .toBe('45+45');
    expect(await historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Rotate view');
    // A quarter turn swaps the view's width and height on the sheet.
    await built(page);
    const o = viewOf(await drawing(page).state(), 'base')?.outline;
    if (!o) throw new Error('no outline');
    expect(o.max[0] - o.min[0]).toBeCloseTo(h0, 1);
    expect(o.max[1] - o.min[1]).toBeCloseTo(w0, 1);
    await a11y(page);
    // Not an angle: refused inline, nothing stored.
    await field.fill('5 mm');
    await field.press('Enter');
    expect(await historyLen(page)).toBe(before + 1);
  });
});

// ------------------------------------------------------------------------------------------------
// Drawing usability after the M4 release (ADR-094): drags are previews, dimension text moves, and a
// detail's circle can be resized.
// ------------------------------------------------------------------------------------------------

type P2 = [number, number];
const unit = (a: P2, b: P2): P2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};
/** A screen-pixel step along a sheet direction (sheet y is up, the page's is down). */
const step = (u: P2, px: number) => ({ x: u[0] * px, y: -u[1] * px });
const mid = (b: { min: P2; max: P2 }): P2 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
const transientCount = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-transient="model"]')?.childElementCount ?? 0);
const movedGroups = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<SVGElement>('[data-host]')].filter(
        (e) => e.style.transform !== '',
      ).length,
  );
/** Screen pixels per sheet mm. */
const pxPerMm = async (page: Page) => {
  const a = await sheetToPage(page, [0, 0]);
  const b = await sheetToPage(page, [10, 0]);
  return (b.x - a.x) / 10;
};

test.describe('drag previews (ADR-094)', () => {
  test('a view drag writes nothing and rebuilds nothing until release, then is one undo step', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const s0 = await built(page);
    const front = viewOf(s0, 'base');
    if (!front?.position) throw new Error('no front view');
    const edge = (await drawing(page).edges(front.id)).find((e) => e.kind === 'line');
    if (!edge) throw new Error('no edge');
    const from = await sheetToPage(page, edge.at);
    const before = await historyLen(page);
    const doc0 = JSON.stringify(((await drawings(page))[0] as Drawing).views);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + i * 5, from.y + i * 3);
    // The preview: the view's groups (lines, dimensions, handles) are translated on the sheet.
    await expect.poll(() => movedGroups(page)).toBeGreaterThan(3);
    // Nothing stored, nothing rebuilt, nothing in history.
    expect(await historyLen(page)).toBe(before);
    expect(JSON.stringify(((await drawings(page))[0] as Drawing).views)).toBe(doc0);
    const builds = (await drawing(page).state()).builds;
    await page.mouse.move(from.x + 90, from.y + 50);
    expect((await drawing(page).state()).builds).toBe(builds);
    await page.mouse.up();
    // Release: one commit, one step, and the preview gives way to the rebuilt sheet.
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move view');
    const s1 = await built(page);
    expect(viewOf(s1, 'base')?.position?.[0]).toBeGreaterThan(front.position[0] + 5);
    await expect.poll(() => movedGroups(page)).toBe(0);
    await page.getByTestId('drawing-undo').click();
    await expect
      .poll(async () => viewOf(await drawing(page).state(), 'base')?.position?.[0])
      .toBeCloseTo(front.position[0], 3);
  });

  test('a dimension line drags as a preview too: the stored placement is unchanged until release', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const pl = (await drawing(page).placements()).find(
      (p) => p.layout.kind === 'lane' && p.line && p.text,
    );
    if (!pl?.line || !pl.text || pl.layout.kind !== 'lane') throw new Error('no linear dimension');
    const u = unit(pl.line[0], pl.line[1]);
    // Press on the line itself (not the text): near its first arrow.
    const grab = await sheetToPage(page, [pl.line[0][0] + u[0] * 2, pl.line[0][1] + u[1] * 2]);
    // Outwards: up for a top lane, left for a left one (the line's left normal), the other way else.
    const away = pl.layout.side === 'top' || pl.layout.side === 'left' ? 1 : -1;
    const across: P2 = [-u[1] * away, u[0] * away];
    const before = await historyLen(page);
    const layout0 = JSON.stringify(pl.layout);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    const d = step(across, 1);
    for (let i = 1; i <= 24; i++) await page.mouse.move(grab.x + d.x * i * 4, grab.y + d.y * i * 4);
    await expect.poll(() => transientCount(page)).toBeGreaterThan(0);
    expect(await historyLen(page)).toBe(before);
    expect(JSON.stringify((await placementOf(page, pl.id))?.layout)).toBe(layout0);
    await page.mouse.up();
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    expect(JSON.stringify((await placementOf(page, pl.id))?.layout)).not.toBe(layout0);
    await built(page);
    await expect.poll(() => transientCount(page)).toBe(0);
  });
});

test.describe('dimension text (ADR-094)', () => {
  /** The first imported linear dimension with a line. */
  async function linearDimension(page: Page) {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const pl = (await drawing(page).placements()).find(
      (p) => p.layout.kind === 'lane' && p.line && p.box,
    );
    if (!pl?.line || !pl.box) throw new Error('no linear dimension');
    return pl;
  }
  const textOf = async (page: Page, id: string) => {
    const p = (await drawing(page).placements()).find((x) => x.id === id);
    if (!p?.box || !p.line) throw new Error('no placement');
    return { centre: mid(p.box), line: p.line, stored: p.textPlacement };
  };
  /** Signed distance of a point from the dimension line (positive: its left, which reads "above"). */
  const across = (line: [P2, P2], p: P2) => {
    const u = unit(line[0], line[1]);
    return (p[0] - line[0][0]) * -u[1] + (p[1] - line[0][1]) * u[0];
  };
  const along = (line: [P2, P2], p: P2) => {
    const u = unit(line[0], line[1]);
    return (p[0] - line[0][0]) * u[0] + (p[1] - line[0][1]) * u[1];
  };

  test('dragging the text along its line shifts it; past an extension line it goes outside', async ({
    page,
  }) => {
    const pl = await linearDimension(page);
    const t0 = await textOf(page, pl.id);
    const u = unit(t0.line[0], t0.line[1]);
    const span = Math.hypot(t0.line[1][0] - t0.line[0][0], t0.line[1][1] - t0.line[0][1]);
    const grab = await sheetToPage(page, t0.centre);
    const before = await historyLen(page);
    const k = await pxPerMm(page);
    // A short drag along the line: the text shifts by that much and the line is unchanged.
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    const d = step(u, 6 * k);
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(grab.x + (d.x * i) / 8, grab.y + (d.y * i) / 8);
    await expect(page.getByTestId('text-side-hint')).toBeVisible();
    expect(await historyLen(page)).toBe(before);
    await page.mouse.up();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.shift).toBeCloseTo(6, 0);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move dimension text');
    await built(page);
    const t1 = await textOf(page, pl.id);
    expect(along(t1.line, t1.centre) - along(t0.line, t0.centre)).toBeCloseTo(6, 0);
    expect(t1.line).toEqual(t0.line);

    // Past the extension line: the text sits outside the measured span, the line reaching it.
    const grab1 = await sheetToPage(page, t1.centre);
    const far = step(u, (span / 2 + 14) * k);
    await page.mouse.move(grab1.x, grab1.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(grab1.x + (far.x * i) / 10, grab1.y + (far.y * i) / 10);
    await page.mouse.up();
    await expect
      .poll(async () => (await placementOf(page, pl.id))?.text?.shift ?? 0)
      .toBeGreaterThan(span / 2);
    await built(page);
    const t2 = await textOf(page, pl.id);
    expect(along(t2.line, t2.centre)).toBeGreaterThan(along(t2.line, t2.line[1]));
    // The measured span did not change: the arrows stay on the extension lines.
    expect(t2.line[0][0]).toBeCloseTo(t0.line[0][0], 6);
    expect(t2.line[1][1]).toBeCloseTo(t0.line[1][1], 6);
  });

  test('dragging it across the line snaps to above, inline or below, with a hint', async ({
    page,
  }) => {
    const pl = await linearDimension(page);
    const t0 = await textOf(page, pl.id);
    const u = unit(t0.line[0], t0.line[1]);
    const n: P2 = [-u[1], u[0]];
    const k = await pxPerMm(page);
    // The text starts above the line (ISO).
    expect(across(t0.line, t0.centre)).toBeGreaterThan(0);
    const hint = page.getByTestId('text-side-hint');
    const dragBy = async (mm: number) => {
      const g = await sheetToPage(page, (await textOf(page, pl.id)).centre);
      const d = step(n, mm * k);
      await page.mouse.move(g.x, g.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + (d.x * i) / 8, g.y + (d.y * i) / 8);
    };
    await dragBy(-9);
    await expect(hint).toHaveAttribute('data-side', 'below');
    await page.mouse.up();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('below');
    await built(page);
    const t1 = await textOf(page, pl.id);
    expect(across(t1.line, t1.centre)).toBeLessThan(-1);
    // Back onto the line: inline.
    await dragBy(Math.abs(across(t1.line, t1.centre)));
    await expect(hint).toHaveAttribute('data-side', 'inline');
    await page.mouse.up();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('inline');
    await built(page);
    // Each drag was one undo step; undo walks back.
    const h = await app(page).history();
    expect(h.past.filter((e) => e.label === 'Move dimension text').length).toBe(2);
    await page.getByTestId('drawing-undo').click();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('below');
    await page.getByTestId('drawing-undo').click();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBeUndefined();
  });

  test('the arrow keys move the selected dimension text, and a run of them is one undo step', async ({
    page,
  }) => {
    const pl = await linearDimension(page);
    const t0 = await textOf(page, pl.id);
    const g = await sheetToPage(page, t0.centre);
    await page.mouse.click(g.x, g.y);
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(pl.id);
    const u = unit(t0.line[0], t0.line[1]);
    const horizontal = Math.abs(u[0]) >= Math.abs(u[1]);
    const key = horizontal ? 'ArrowRight' : 'ArrowUp';
    const before = await historyLen(page);
    await page.keyboard.press(key);
    await page.keyboard.press(key);
    await page.keyboard.press(`Shift+${key}`);
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.shift).toBeCloseTo(7, 1);
    expect(await historyLen(page)).toBe(before + 1);
    await built(page);
    const t1 = await textOf(page, pl.id);
    expect(Math.abs(along(t1.line, t1.centre) - along(t0.line, t0.centre))).toBeCloseTo(7, 0);
    // Across the line: the text steps from above, through inline, to below.
    const down = horizontal ? 'ArrowDown' : 'ArrowRight';
    await page.keyboard.press(down);
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('inline');
    await page.keyboard.press(down);
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('below');
    // Without a dimension selected, the arrows pan the sheet again.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await drawing(page).state()).selected).toBeNull();
  });

  test('the inspector places the text without dragging: above, inline, below, and a typed shift', async ({
    page,
  }) => {
    const pl = await linearDimension(page);
    const t0 = await textOf(page, pl.id);
    const g = await sheetToPage(page, t0.centre);
    await page.mouse.click(g.x, g.y);
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(pl.id);
    const group = page.getByRole('radiogroup', { name: 'Dimension text position' });
    await group.getByRole('radio', { name: 'Below' }).click();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBe('below');
    await built(page);
    const t1 = await textOf(page, pl.id);
    expect(across(t1.line, t1.centre)).toBeLessThan(-1);
    const shift = page.getByLabel('Text shift along the line (mm)');
    await shift.fill('2*5');
    await shift.press('Enter');
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.shift).toBe(10);
    await group.getByRole('radio', { name: 'Auto' }).click();
    await expect.poll(async () => (await placementOf(page, pl.id))?.text?.side).toBeUndefined();
    await a11y(page);
  });

  test('a radial dimension and a leader drag their text freely', async ({ page }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    await importAll(page);
    const all = await drawing(page).placements();
    let tried = 0;
    for (const kind of ['radial', 'leader']) {
      const pl = all.find((p) => p.layout.kind === kind && p.text);
      if (!pl?.text) continue;
      tried++;
      const from = await sheetToPage(page, pl.text);
      const layout0 = JSON.stringify((await placementOf(page, pl.id))?.layout);
      const before = await historyLen(page);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + i * 5, from.y - i * 4);
      expect(JSON.stringify((await placementOf(page, pl.id))?.layout)).toBe(layout0);
      await page.mouse.up();
      await expect.poll(() => historyLen(page)).toBe(before + 1);
      expect(JSON.stringify((await placementOf(page, pl.id))?.layout)).not.toBe(layout0);
      await built(page);
    }
    expect(tried).toBeGreaterThan(0);
  });

  test('an angle dimension drags its text along the arc and its radius in and out', async ({
    page,
  }) => {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const front = viewOf(await built(page), 'base');
    if (!front) throw new Error('no front view');
    const [e1, e2] = await cornerEdges(page, front.id);
    await page.locator('[data-tool="angle"]').click();
    await click(page, e1.at);
    await click(page, e2.at);
    await expect.poll(async () => (await annotations(page)).length).toBe(1);
    await built(page);
    const pl = (await drawing(page).placements()).find((p) => p.layout.kind === 'arc');
    if (!pl?.box) throw new Error('no angle');
    const r0 = (await placementOf(page, pl.id))?.layout;
    const from = await sheetToPage(page, mid(pl.box));
    await page.locator('[data-tool="select"]').click();
    const before = await historyLen(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + i * 8, from.y - i * 6);
    expect(await historyLen(page)).toBe(before);
    await page.mouse.up();
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    const p1 = await placementOf(page, pl.id);
    expect(JSON.stringify(p1?.layout)).not.toBe(JSON.stringify(r0));
  });
});

test.describe('detail circle (ADR-094)', () => {
  async function withDetail(page: Page) {
    await openDemo(page);
    await newDrawing(page);
    await addStandardViews(page);
    const s = await built(page);
    const tv = viewOf(s, 'projected', 'top');
    if (!tv?.outline) throw new Error('no top view');
    await page.locator('[data-tool="detail"]').click();
    const cx = tv.outline.min[0] + 14;
    const cy = (tv.outline.min[1] + tv.outline.max[1]) / 2;
    await drag(page, await sheetToPage(page, [cx, cy]), await sheetToPage(page, [cx + 8, cy]));
    await expect
      .poll(async () => (await drawing(page).state()).views.some((v) => v.kind === 'detail'))
      .toBe(true);
    const s2 = await built(page);
    const detail = viewOf(s2, 'detail');
    if (!detail) throw new Error('no detail');
    // Select it from the Views panel.
    await panelTab(page, 'Views').click();
    await page.locator(`[data-view-row="${detail.id}"]`).click();
    await expect.poll(async () => (await drawing(page).state()).selected?.id).toBe(detail.id);
    // Settled on the exact edges, so no refinement lands during a drag.
    await drawing(page).exact();
    await expect.poll(async () => (await drawing(page).state()).refining).toBe(false);
    return detail;
  }
  const circle = async (page: Page, id: string) =>
    (await drawing(page).state()).views.find((v) => v.id === id)?.clip;
  const grip = (page: Page, kind: 'radius' | 'center') =>
    page.locator(`[data-testid="detail-handle"][data-kind="${kind}"] circle`).first();
  const centreOf = async (el: ReturnType<typeof grip>) => {
    const b = await el.boundingBox();
    if (!b) throw new Error('no handle');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  test('the selected detail shows a radius and a centre handle on its parent; the radius drags live and commits once', async ({
    page,
  }) => {
    const detail = await withDetail(page);
    const c0 = await circle(page, detail.id);
    if (!c0) throw new Error('no circle');
    await expect(page.getByTestId('detail-handle')).toHaveCount(2);
    const from = await centreOf(grip(page, 'radius'));
    const before = await historyLen(page);
    const builds = (await drawing(page).state()).builds;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + i * 3, from.y);
    // Live: the detail view is redrawn clipped to the new circle, with nothing stored or rebuilt.
    await expect.poll(() => transientCount(page)).toBeGreaterThan(0);
    await expect(page.locator('[data-transient="model"] [clip-path]')).toHaveCount(1);
    expect(await historyLen(page)).toBe(before);
    expect((await circle(page, detail.id))?.radius).toBeCloseTo(c0.radius, 6);
    expect((await drawing(page).state()).builds).toBe(builds);
    await page.mouse.up();
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Change detail size');
    await built(page);
    const c1 = await circle(page, detail.id);
    expect(c1?.radius ?? 0).toBeGreaterThan(c0.radius + 1);
    expect(c1?.center[0]).toBeCloseTo(c0.center[0], 6);
    await expect.poll(() => transientCount(page)).toBe(0);
    // Escape in the middle leaves nothing behind.
    const r2 = c1?.radius ?? 0;
    const f2 = await centreOf(grip(page, 'radius'));
    const h2 = await historyLen(page);
    await page.mouse.move(f2.x, f2.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(f2.x - i * 4, f2.y);
    await expect.poll(() => transientCount(page)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => transientCount(page)).toBe(0);
    expect(await historyLen(page)).toBe(h2);
    expect((await circle(page, detail.id))?.radius).toBeCloseTo(r2, 6);
  });

  test('the centre handle moves the circle; the inspector has typed radius and centre fields', async ({
    page,
  }) => {
    const detail = await withDetail(page);
    const c0 = await circle(page, detail.id);
    if (!c0) throw new Error('no circle');
    const from = await centreOf(grip(page, 'center'));
    const before = await historyLen(page);
    await drag(page, from, { x: from.x + 24, y: from.y + 10 });
    await expect.poll(() => historyLen(page)).toBe(before + 1);
    expect((await app(page).history()).past.at(-1)?.label).toBe('Move detail circle');
    await built(page);
    const c1 = await circle(page, detail.id);
    expect(c1?.center[0] ?? 0).toBeGreaterThan(c0.center[0] + 1);
    expect(c1?.radius).toBeCloseTo(c0.radius, 6);
    // Typed, with units and expressions.
    const rf = page.getByLabel('Detail circle radius');
    await rf.fill('2*5');
    await rf.press('Enter');
    await expect.poll(async () => (await circle(page, detail.id))?.radius).toBeCloseTo(10, 3);
    const cx = page.getByLabel('Detail circle centre X');
    await cx.fill('1in');
    await cx.press('Enter');
    await expect.poll(async () => (await circle(page, detail.id))?.center[0]).toBeCloseTo(25.4, 3);
    await expect(page.getByLabel('Detail circle centre Y')).toBeVisible();
    await a11y(page);
  });
});
