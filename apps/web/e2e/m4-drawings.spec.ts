import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { Annotation, Drawing, WrenDoc } from '@wren-cad/contracts';
import { app, palette } from './helpers';
import {
  built,
  drag,
  drawing,
  newDrawing,
  openDemo,
  panelTab,
  sheetToPage,
  viewOf,
} from './support/drawing-ui';

/**
 * M4 drawings (PLAN §12 M4 Accept) on the demo bracket, desktop, with the PLACEHOLDER drawing
 * kernel (ADR-092): the geometry of the views is approximate, the dimensions are exact (the real
 * regen resolves them). Tablet and phone are in m4-touch.spec.ts.
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
    // The placeholder says what it is.
    await expect(page.getByTestId('placeholder-badge')).toBeVisible();
    await a11y(page);

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
    await click(page, right.at);
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
    const from = await sheetToPage(page, lane.text);
    const to = await sheetToPage(page, [lane.text[0] + out[0], lane.text[1] + out[1]]);
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
    expect(bytes.length).toBeGreaterThan(20_000);
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
