import { expect, test } from '@playwright/test';
import type { Drawing } from '@wren-cad/contracts';
import { buildDoc, PARTS } from '@wren-cad/test-fixtures/reference-parts';
import { app, boot } from './helpers';
import { PERF_FACTOR } from './perf/budgets';
import { built, drawing, type Extent, newDrawing } from './support/drawing-ui';
import {
  addViews,
  bindImported,
  dimensionTool,
  importAll,
  loadPartSpec,
  showsValue,
  viewPlane,
} from './support/reference-drawing';
import { GAPS } from './support/reference-drawing-gaps';

/**
 * M4 acceptance, certification-style suite (PLAN section 12 M4 Accept, 12A): for every reference
 * part the spec drawing is recreated with Wren's drawing tools (views, the section cut, Import
 * model annotations, the Dimension and Chamfer tools) and checked against the spec's `drawing`
 * section: every requested view is present, every specified dimension is on its view with a
 * resolved value equal to the spec's and to the model's geometry, every instance count is drawn as
 * `N×` on its view, nothing needs attention, and no annotation is drawn over another view.
 *
 * Setup. The part is built from the spec by the same builder the M3 UI script is generated from
 * (`buildDoc`) and loaded through the `load` hook: building a part through the UI takes minutes
 * (m3-reference-parts.spec.ts does that, and checks mass), far over this suite's per-part budget.
 * The hooks are otherwise only read.
 *
 * Product gaps are listed in `support/reference-drawing-gaps.ts`, each with a gap id and the
 * reason. The dimensions in it must stay unmet: the test fails when one starts to pass, so the
 * table cannot go stale. Each gap is also a `test.fixme` below, so it shows in the report.
 *
 * `WREN_CERT_ALL=1` tries the listed gaps too and reports every dimension met or not (as test
 * annotations) instead of failing on the first: for re-baselining the table.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const TOL = { mm: 0.005, deg: 0.05, '': 1e-9 } as const;
const ALL = !!process.env.WREN_CERT_ALL;

type Box = { min: [number, number]; max: [number, number] };
const overlaps = (a: Box, b: Box) =>
  a.max[0] > b.min[0] && a.min[0] < b.max[0] && a.max[1] > b.min[1] && a.min[1] < b.max[1];

/** Does segment p–q enter box `b` (Liang–Barsky clip)? */
function segmentInBox(p: [number, number], q: [number, number], b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  for (let i = 0; i < 2; i++) {
    const di = d[i] as number;
    const pi = p[i] as number;
    for (const [lim, sign] of [
      [b.min[i] as number, -1],
      [b.max[i] as number, 1],
    ] as const) {
      const num = sign * (lim - pi);
      const den = sign * di;
      if (Math.abs(den) < 1e-12) {
        if (num < 0) return false;
      } else {
        const t = num / den;
        if (den < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
  }
  return t1 - t0 > 1e-9;
}

/** Strictly inside: a line that only touches a view's outline does not count. */
const shrink = (b: Box, by: number): Box => ({
  min: [b.min[0] + by, b.min[1] + by],
  max: [b.max[0] - by, b.max[1] - by],
});

type Built = Awaited<ReturnType<typeof built>>;
type Placements = Awaited<ReturnType<ReturnType<typeof drawing>['placements']>>;
type SpecDim = ReturnType<typeof loadPartSpec>['drawing']['dimensions'][number];

/**
 * A specified dimension is met when annotation `id` is placed on the spec's view with a resolved
 * value equal to the spec's and to the geometry, and the value is shown on the sheet.
 */
function dimensionMet(
  d: SpecDim,
  viewId: string,
  id: string,
  state: Built,
  placements: Placements,
): boolean {
  const res = state.resolutions.find((r) => r.id === id);
  const onView = placements.some((p) => p.annotationId === id && p.viewId === viewId);
  const tol = TOL[d.unit];
  const equal =
    res?.state === 'ok' &&
    res.value !== null &&
    Math.abs(Math.abs(res.value) - Math.abs(d.value)) <= tol &&
    (res.measured === null || Math.abs(Math.abs(res.measured) - Math.abs(res.value)) <= tol);
  return onView && equal && showsValue(state.texts, Math.abs(d.value));
}

function describe(id: string, viewId: string, state: Built, placements: Placements): string {
  const res = state.resolutions.find((r) => r.id === id);
  const onView = placements.some((p) => p.annotationId === id && p.viewId === viewId);
  return `resolved ${res?.state} ${res?.value} (measured ${res?.measured}), on view ${onView}`;
}

for (const part of PARTS) {
  test(`M4 reference drawing ${part.id}: views and dimensions of the spec drawing`, async ({
    page,
  }, info) => {
    test.setTimeout((ALL ? 300_000 : 120_000) * PERF_FACTOR);
    const spec = loadPartSpec(part.id);
    const gaps = GAPS[part.id] ?? [];
    const gapNames = ALL ? new Set<string>() : new Set(gaps.flatMap((g) => g.dims));

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await boot(page);
    await app(page).load(buildDoc(part));
    await app(page).idle();
    await newDrawing(page, {
      projection: spec.drawing.projection === 'third' ? 'Third angle' : 'First angle',
    });
    const views = await addViews(page, spec);
    const imported = await importAll(page);
    const bound = await bindImported(page, spec, views);
    const notes = new Map<string, string>();

    // What the import did not give, the Dimension (or Chamfer) tool adds on the view the spec
    // shows it in. An instance count is not a dimension of its own: it is the `N×` of a callout
    // or a dimension (checked below).
    for (const d of spec.drawing.dimensions) {
      if (d.kind === 'count' || bound.has(d.name) || gapNames.has(d.name)) continue;
      const v = views.find((x) => x.spec.id === d.view);
      if (!v) throw new Error(`no view ${d.view}`);
      const r = await dimensionTool(page, spec, v, d);
      if ('id' in r) bound.set(d.name, r.id);
      else notes.set(d.name, r.note);
    }
    const state = await built(page);
    const placements = await drawing(page).placements();
    const extents = await drawing(page).extents();
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

    // 2. Every specified dimension appears on its view with a resolved value equal to the spec's
    // and to the geometry (a sourced value the model no longer has, "differs from the model", is
    // not met), shown on the sheet; every count is a drawn `N×` on its view. Or it is a listed gap
    // (which must really be unmet).
    const unmet: string[] = [];
    const met: string[] = [];
    for (const d of spec.drawing.dimensions) {
      const v = views.find((x) => x.spec.id === d.view) as (typeof views)[number];
      let ok: boolean;
      let why: string;
      if (d.kind === 'count') {
        const n = Math.abs(d.value);
        const re = new RegExp(`(^|\\s)${n}×`);
        const on = extents.filter((e) => e.viewId === v.id && re.test(e.text));
        ok = on.length > 0;
        why = `no label on ${v.spec.caption} shows ${n}× (labels: ${extents
          .filter((e) => e.viewId === v.id && /×/.test(e.text))
          .map((e) => JSON.stringify(e.text))
          .join(', ')})`;
      } else {
        const id = bound.get(d.name);
        ok = id !== undefined && dimensionMet(d, v.id, id, state, placements);
        why = notes.get(d.name) ?? (id ? describe(id, v.id, state, placements) : 'not placed');
      }
      if (ok) met.push(d.name);
      if (gapNames.has(d.name)) {
        expect(ok, `${d.name} is listed as a product gap but now works: remove it from GAPS`).toBe(
          false,
        );
        continue;
      }
      if (!ok) unmet.push(`${d.name} (${d.kind} ${d.value} on ${v.spec.caption}): ${why}`);
    }
    info.annotations.push({ type: 'met', description: met.join(', ') });
    if (ALL) {
      info.annotations.push({ type: 'errors', description: errors.join(' | ') });
      info.annotations.push({
        type: 'labels',
        description: await (async () => {
          const anns = (await app(page).doc()).parts[0]?.annotations ?? [];
          return extents
            .map((e) => {
              const a = anns.find((x) => x.id === e.annotationId);
              const r = state.resolutions.find((x) => x.id === e.annotationId);
              return `${e.viewId.slice(-4)}:${JSON.stringify(e.text)}[${a?.kind} ${a?.refs.map((x) => `${x.kind}:${x.name.slice(-30)}`).join(',')} v=${r?.value} m=${r?.measured}]`;
            })
            .join(' ');
        })(),
      });
      info.annotations.push({ type: 'unmet', description: unmet.join(' | ') });
      info.annotations.push({
        type: 'import',
        description: imported.plan
          .filter((r) => r.reason)
          .map((r) => `${r.key} ${r.annotationKind}: ${r.reason} ${r.duplicateOf ?? ''}`)
          .join(' | '),
      });
    } else expect(unmet, 'specified dimensions missing from the recreated drawing').toEqual([]);

    // 3. Nothing needs attention.
    const bad = state.resolutions.filter((r) => r.state !== 'ok');
    expect(bad, 'annotations that need attention').toEqual([]);

    // 4. No annotation is drawn over another view: its text boxes and its lines (dimension,
    // extension and leader lines), as the display list draws them, stay off every other view's
    // outline.
    const crossing: string[] = [];
    const who = (e: Extent) => `${e.annotationId} ${JSON.stringify(e.text)} (on ${e.viewId})`;
    for (const e of extents)
      for (const s of state.views) {
        if (s.id === e.viewId || !s.outline) continue;
        const o = shrink(s.outline, 0.01);
        if (e.texts.some((t) => overlaps(t, o))) crossing.push(`${who(e)}: text over view ${s.id}`);
        else if (e.segments.some(([p, q]) => segmentInBox(p, q, o)))
          crossing.push(`${who(e)}: a line over view ${s.id}`);
      }
    expect(crossing, 'annotations drawn over another view').toEqual([]);

    // 5. Every listed product gap is tried with the drawing tools (the same pick the spec needs),
    // after the checks above so a wrong attempt cannot disturb them, and must still fail: a gap
    // that starts working fails this test, so it is moved out of GAPS and checked for real.
    if (!ALL) {
      const tried: { d: SpecDim; viewId: string; id?: string }[] = [];
      for (const d of spec.drawing.dimensions) {
        if (d.kind === 'count' || !gapNames.has(d.name) || bound.has(d.name)) continue;
        const v = views.find((x) => x.spec.id === d.view);
        if (!v) throw new Error(`no view ${d.view}`);
        const r = await dimensionTool(page, spec, v, d);
        tried.push({ d, viewId: v.id, ...('id' in r ? { id: r.id } : {}) });
      }
      const after = await built(page);
      const afterPlacements = await drawing(page).placements();
      const nowWorking = tried
        .filter(
          (t) => t.id !== undefined && dimensionMet(t.d, t.viewId, t.id, after, afterPlacements),
        )
        .map((t) => t.d.name);
      expect(nowWorking, 'listed product gaps that now work: remove them from GAPS').toEqual([]);
    }
  });
}

// Product gaps (PLAN M4.1): listed as fixme entries for the report. The part tests above try every
// gap with the drawing tools (check 5) and fail when one starts to work.
for (const [id, gaps] of Object.entries(GAPS))
  for (const g of gaps)
    test.fixme(`M4 reference drawing ${id}: ${g.dims.join(', ')} (${g.what}): ${g.reason}`, () => {});
