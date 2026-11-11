import { expect, test } from '@playwright/test';
import type { Drawing } from '@wren-cad/contracts';
import { buildDoc, PARTS } from '@wren-cad/test-fixtures/reference-parts';
import { app, boot } from './helpers';
import { PERF_FACTOR } from './perf/budgets';
import { built, drawing, newDrawing } from './support/drawing-ui';
import {
  addViews,
  bindImported,
  dimensionTool,
  importAll,
  loadPartSpec,
  showsValue,
  viewPlane,
} from './support/reference-drawing';
import { ATTENTION_BUGS, GAPS } from './support/reference-drawing-gaps';

/**
 * M4 acceptance, certification-style suite (PLAN section 12 M4 Accept, 12A): for every reference
 * part the spec drawing is recreated with Wren's drawing tools (views, the section cut, Import
 * model annotations, the Dimension tool) and checked against the spec's `drawing` section: every
 * requested view is present, every specified dimension is on its view with an equal resolved value,
 * nothing needs attention, and no dimension sits on another view.
 *
 * Setup. The part is built from the spec by the same builder the M3 UI script is generated from
 * (`buildDoc`) and loaded through the `load` hook: building a part through the UI takes minutes
 * (m3-reference-parts.spec.ts does that, and checks mass), far over this suite's per-part budget.
 * The hooks are otherwise only read.
 *
 * Product gaps are listed in `support/reference-drawing-gaps.ts`, each with the spec item and the
 * reason. The dimensions in it must stay unmet: the test fails when one starts to pass, so the table
 * cannot go stale. Each gap is also a `test.fixme` below, so it shows in the report.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const TOL = { mm: 0.005, deg: 0.05, '': 1e-9 } as const;

for (const part of PARTS) {
  test(`M4 reference drawing ${part.id}: views and dimensions of the spec drawing`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000 * PERF_FACTOR);
    const spec = loadPartSpec(part.id);
    const gaps = GAPS[part.id] ?? [];
    const gapNames = new Set(gaps.flatMap((g) => g.dims));

    await boot(page);
    await app(page).load(buildDoc(part));
    await app(page).idle();
    await newDrawing(page, {
      projection: spec.drawing.projection === 'third' ? 'Third angle' : 'First angle',
    });
    const views = await addViews(page, spec);
    await importAll(page);
    const bound = await bindImported(page, spec, views);
    const notes = new Map<string, string>();

    // What the import did not give, the Dimension tool adds on the view the spec shows it in.
    for (const d of spec.drawing.dimensions) {
      if (bound.has(d.name) || gapNames.has(d.name)) continue;
      const v = views.find((x) => x.spec.id === d.view);
      if (!v) throw new Error(`no view ${d.view}`);
      const r = await dimensionTool(page, spec, v, d);
      if ('id' in r) bound.set(d.name, r.id);
      else notes.set(d.name, r.note);
    }
    const state = await built(page);
    const placements = await drawing(page).placements();
    info.annotations.push({
      type: 'dimensions',
      description: `${spec.drawing.dimensions.length} on the spec drawing, ${bound.size} placed`,
    });

    // 1. Every requested view is present, as the spec says (kind, orientation, parent, side).
    const doc = ((await app(page).doc()).drawings[0] as Drawing).views;
    expect(state.views.length, 'views on the sheet').toBe(spec.drawing.views.length);
    for (const v of views) {
      const s = state.views.find((x) => x.id === v.id);
      const d = doc.find((x) => x.id === v.id);
      expect(s && d, `view ${v.spec.caption} exists`).toBeTruthy();
      expect(s?.problems, `${v.spec.caption} draws`).toEqual([]);
      expect(s?.curves, `${v.spec.caption} has edges`).toBeGreaterThan(0);
      expect(d?.kind, `${v.spec.caption} kind`).toBe(v.spec.kind);
      if (d?.kind === 'base')
        expect(d.orientation, `${v.spec.caption} orientation`).toEqual({
          kind: 'named',
          name: v.spec.orientation,
        });
      // A turned base view (the spec's `rotation`, degrees counter-clockwise).
      if (d?.kind === 'base' && v.spec.rotation !== undefined)
        expect(d.rotation, `${v.spec.caption} rotation`).toBe(String(v.spec.rotation));
      if (d?.kind === 'projected') {
        const parent = views.find((x) => x.spec.id === v.spec.parent) as (typeof views)[number];
        expect(d.parentId).toBe(parent.id);
        expect(d.from).toBe(v.spec.orientation);
        // Third angle: where the view lands relative to its parent is the spec's `side`.
        const p = state.views.find((x) => x.id === parent.id)?.position as [number, number];
        const q = s?.position as [number, number];
        const side = v.spec.side;
        if (side === 'above') expect(q[1], `${v.spec.caption} above`).toBeGreaterThan(p[1]);
        if (side === 'below') expect(q[1], `${v.spec.caption} below`).toBeLessThan(p[1]);
        if (side === 'right') expect(q[0], `${v.spec.caption} right`).toBeGreaterThan(p[0]);
        if (side === 'left') expect(q[0], `${v.spec.caption} left`).toBeLessThan(p[0]);
      }
      if (d?.kind === 'section') {
        const parent = views.find((x) => x.spec.id === v.spec.parent) as (typeof views)[number];
        expect(d.parentId).toBe(parent.id);
        expect(d.look).toBe(v.spec.section?.look);
        // The cut line is the spec's, vertex for vertex (a stepped cut is an offset section).
        const want = v.spec.section?.cut ?? [];
        expect(d.cut.length, `${v.spec.caption} cut line points`).toBe(want.length);
        // (A straight cut is dragged, so its two ends are only near the spec's: points are checked
        // for stepped and L-shaped cuts, which are typed.)
        if (want.length > 2)
          want.forEach((pt, i) => {
            const at = d.cut[i];
            const q = viewPlane(v.spec, pt as [number, number]);
            expect(at?.kind === 'free' ? at.at : null, `cut point ${i}`).toEqual([
              expect.closeTo(q[0], 2),
              expect.closeTo(q[1], 2),
            ]);
          });
      }
    }
    expect(state.projection).toBe(spec.drawing.projection);

    // 2. Every specified dimension appears on its view with an equal resolved value, or is a
    // listed gap (which must really be unmet).
    const unmet: string[] = [];
    for (const d of spec.drawing.dimensions) {
      const id = bound.get(d.name);
      const v = views.find((x) => x.spec.id === d.view) as (typeof views)[number];
      const res = state.resolutions.find((r) => r.id === id);
      const onView = placements.some((p) => p.annotationId === id && p.viewId === v.id);
      const equal =
        res?.state === 'ok' &&
        res.value !== null &&
        Math.abs(Math.abs(res.value) - Math.abs(d.value)) <= TOL[d.unit];
      const shown = equal && showsValue(state.texts, Math.abs(d.value));
      const met = id !== undefined && onView && equal && shown;
      if (gapNames.has(d.name)) {
        expect(met, `${d.name} is listed as a product gap but now works: remove it from GAPS`).toBe(
          false,
        );
        continue;
      }
      if (!met) {
        const why =
          notes.get(d.name) ??
          (id
            ? `resolved ${res?.state} ${res?.value}, on view ${onView}, shown ${shown}`
            : 'not placed');
        unmet.push(`${d.name} (${d.kind} ${d.value} on ${v.spec.caption}): ${why}`);
      }
    }
    expect(unmet, 'specified dimensions missing from the recreated drawing').toEqual([]);

    // 3. Nothing needs attention, apart from the annotations the known import bugs leave.
    const bad = state.resolutions.filter((r) => r.state !== 'ok');
    expect(
      bad.length,
      'annotations that need attention (known import bugs: see ATTENTION_BUGS)',
    ).toBe(ATTENTION_BUGS[part.id]?.count ?? 0);

    // 4. PENDING packages/drawing fix (dimension boxes overlapping other views, fixed in parallel):
    // no dimension's text box may sit on a view other than the one it dimensions. The box is the
    // text anchor from the placements hook with a generous size; it should pass once the fix merges.
    const overlaps: string[] = [];
    for (const p of placements) {
      if (!p.text) continue;
      for (const s of state.views) {
        if (s.id === p.viewId || !s.outline) continue;
        const [x, y] = p.text;
        const box = { x0: x - 4, x1: x + 4, y0: y - 2, y1: y + 2 };
        if (
          box.x1 > s.outline.min[0] &&
          box.x0 < s.outline.max[0] &&
          box.y1 > s.outline.min[1] &&
          box.y0 < s.outline.max[1]
        )
          overlaps.push(`${p.annotationId} (on ${p.viewId}) overlaps view ${s.id}`);
      }
    }
    expect
      .soft(overlaps, 'PENDING overlap fix in packages/drawing: no dimension box over another view')
      .toEqual([]);
  });
}

// Product gaps: a dimension or view the drawing tools cannot make yet. Skipped, with the reason;
// the test above fails if one of them starts to work (see GAPS).
for (const [id, gaps] of Object.entries(GAPS))
  for (const g of gaps)
    test.fixme(`M4 reference drawing ${id}: ${g.dims.join(', ')} (${g.what}): ${g.reason}`, () => {});
for (const [id, b] of Object.entries(ATTENTION_BUGS))
  test.fixme(`M4 reference drawing ${id}: nothing needs attention after Import: ${b.reason}`, () => {});
