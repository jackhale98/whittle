/**
 * Import model annotations on the demo bracket (M4 gate findings 1–3): three standard views and
 * a section, the kernel's anchors from one query batch, then the real layout of every placed
 * dimension checked against the sheet: no item may cross another view's outline, a cutting
 * plane or the title block, before and after a 10 % model resize.
 */

import type { Annotation, Command, Drawing, DrawingView, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  anchorLookup,
  type ImportPlan,
  importAnchorQueries,
  importCommands,
  planImport,
} from '../src/import';
import {
  buildDrawing,
  type DrawingBuild,
  primitiveShapes,
  shapeHitsBox,
  sheetObstacles,
} from '../src/sheet';
import { solveViews, viewOutline } from '../src/view';
import {
  bracketAnchor,
  bracketBounds,
  bracketDrawing,
  bracketFrames,
  bracketPart,
  bracketResolutions,
  ID,
} from './bracket';
import { evaluate } from './fixtures';

function plan(d: Drawing, k: number, over: { moveViews?: boolean } = {}): ImportPlan {
  const part = bracketPart(k);
  const frames = bracketFrames(k);
  const queries = importAnchorQueries(part, frames);
  const answers = queries.map((q) => bracketAnchor(q, k));
  let n = 0;
  return planImport({
    drawing: d,
    part,
    views: solveViews({ drawing: d, bounds: bracketBounds(k), evaluate }),
    resolutions: new Map(),
    sketchFrames: frames,
    anchors: anchorLookup(queries, answers),
    moveViews: over.moveViews ?? true,
    newId: () => `N${String(++n).padStart(3, '0')}`,
  });
}

/** Applies the import's commands the way the store does (enough for these tests). */
function apply(d: Drawing, cmds: Command[]): { drawing: Drawing; annotations: Annotation[] } {
  let views = d.views;
  const annotations: Annotation[] = [];
  let placements = d.placements;
  for (const c of cmds) {
    if (c.kind === 'updateView') views = views.map((v) => (v.id === c.view.id ? c.view : v));
    else if (c.kind === 'placeAnnotations') {
      placements = [...placements, ...c.items.map((i) => i.placement)];
      for (const i of c.items) if (i.annotation) annotations.push(i.annotation);
    } else throw new Error(`unexpected ${c.kind}`);
  }
  return { drawing: { ...d, views, placements }, annotations };
}

function build(d: Drawing, annotations: Annotation[], k: number): DrawingBuild {
  const res = bracketResolutions(annotations, k);
  return buildDrawing({
    drawing: d,
    annotations,
    configurationIds: new Set(),
    bounds: bracketBounds(k),
    evaluate,
    evaluateAnnotation: (e) => evaluate(e, 'ratio'),
    projections: new Map(),
    resolutions: () => res,
    annotationIssues: () => [],
    titleBlock: (_s, index, count) => ({
      title: 'Bracket',
      partNumber: 'BRK-001',
      projection: d.projection,
      units: 'mm',
      standard: d.standard,
      sheet: { index, count },
    }),
  });
}

/** Every placed item that crosses another view's outline, a cut line or the title block. */
function collisions(b: DrawingBuild, d: Drawing): string[] {
  const out: string[] = [];
  const sheet = sheetObstacles({ drawing: d, sheetId: 'S1', views: b.views });
  for (const p of b.placed) {
    if (p.suppressed) continue;
    for (const it of p.items) {
      for (const shape of primitiveShapes(it)) {
        for (const ob of sheet.obstacles) {
          const relevant =
            (ob.kind === 'view' && ob.viewId !== p.viewId) ||
            ob.kind === 'titleBlock' ||
            ob.kind === 'cutLine' ||
            (ob.kind === 'viewLabel' && ob.viewId !== p.viewId);
          if (!relevant) continue;
          const hit =
            ob.shape.kind === 'box'
              ? shapeHitsBox(shape, ob.shape.box)
              : shape.kind === 'box' && shapeHitsBox(ob.shape, shape.box);
          if (hit)
            out.push(`${p.annotationId}@${p.viewId} ${it.kind} × ${ob.kind}:${ob.viewId ?? ''}`);
        }
      }
      // And the frame.
      for (const shape of primitiveShapes(it)) {
        const pts: Vec2[] =
          shape.kind === 'box' ? [shape.box.min, shape.box.max] : [shape.a, shape.b];
        for (const q of pts)
          if (
            q[0] < sheet.frame.min[0] ||
            q[1] < sheet.frame.min[1] ||
            q[0] > sheet.frame.max[0] ||
            q[1] > sheet.frame.max[1]
          )
            out.push(`${p.annotationId}@${p.viewId} ${it.kind} outside the frame`);
      }
    }
  }
  return out;
}

const checkAll = (p: ImportPlan) =>
  new Set(p.candidates.filter((c) => c.placement).map((c) => c.key));

/** Placed dimension texts (the value lines), sorted. */
function texts(b: DrawingBuild): string[] {
  return b.placed
    .flatMap((p) =>
      p.items.filter((i) => i.kind === 'text').map((i) => (i.kind === 'text' ? i.text : '')),
    )
    .sort();
}

describe('import on the bracket: three standard views and a section', () => {
  for (const projection of ['first', 'third'] as const) {
    describe(`${projection} angle`, () => {
      const d0 = bracketDrawing(projection);

      it('no dimension crosses another view, a cut line or the title block', () => {
        const p = plan(d0, 1);
        const cmds = importCommands(p, 'D1', checkAll(p));
        const { drawing, annotations } = apply(d0, cmds);
        expect(annotations.length).toBeGreaterThanOrEqual(12);
        const b = build(drawing, annotations, 1);
        expect(collisions(b, drawing)).toEqual([]);
        // Nothing reported as not fitting on this sheet.
        expect(
          p.candidates.filter((c) => c.reason === 'layoutDoesNotFit').map((c) => c.key),
        ).toEqual([]);
      });

      it('the check sees a lane pushed into the neighbouring view (the gate finding)', () => {
        const p = plan(d0, 1);
        const { drawing, annotations } = apply(d0, importCommands(p, 'D1', checkAll(p)));
        // The plate width in the top view, forced to lane 5 on the side facing the front view.
        const facing = projection === 'first' ? 'top' : 'bottom';
        const width = p.candidates.find((c) => c.key === `sketch:${ID.S1}:d1`);
        const forced = {
          ...drawing,
          placements: drawing.placements.map((pl) =>
            pl.id === width?.placement?.id
              ? { ...pl, layout: { kind: 'lane' as const, side: facing, lane: 5 } }
              : pl,
          ),
        } as Drawing;
        expect(width?.viewId).toBe('VT');
        expect(collisions(build(forced, annotations, 1), forced).length).toBeGreaterThan(0);
      });

      it('and still none after the model grows by 10 %', () => {
        const p = plan(d0, 1);
        const { drawing, annotations } = apply(d0, importCommands(p, 'D1', checkAll(p)));
        const b = build(drawing, annotations, 1.1);
        expect(collisions(b, drawing)).toEqual([]);
      });

      it('an import on the 10 % larger model keeps clear too (narrower gaps)', () => {
        const p = plan(d0, 1.1);
        const { drawing, annotations } = apply(d0, importCommands(p, 'D1', checkAll(p)));
        const b = build(drawing, annotations, 1.1);
        expect(collisions(b, drawing)).toEqual([]);
        expect(collisions(build(drawing, annotations, 1.21), drawing)).toEqual([]);
      });
    });
  }

  /** The side view pulled in to 12 mm from the front view; the front's left side is the frame. */
  function cramped(): Drawing {
    const d = bracketDrawing('third');
    d.views = d.views.map((v) =>
      v.id === 'VS' && v.kind === 'projected'
        ? { ...v, layout: { kind: 'aligned', distance: 40 + 25 + 12 } }
        : v,
    ) as DrawingView[];
    return d;
  }

  it('lists a dimension that fits nowhere as layoutDoesNotFit when views may not move', () => {
    const d = cramped();
    const p = plan(d, 1, { moveViews: false });
    expect(p.viewMoves).toEqual([]);
    const failed = p.candidates.filter((c) => c.reason === 'layoutDoesNotFit');
    // The plate's and the upright's depths: vertical, in the front view, between the frame and
    // the side view.
    expect(failed.map((c) => c.key)).toContain(`feature:${ID.E3}:/end/depth`);
    for (const c of failed) {
      expect(c.placement).toBeUndefined();
      expect(c.viewId).toBeUndefined();
      expect(c.checked).toBe(false);
    }
    const { drawing, annotations } = apply(d, importCommands(p, 'D1', checkAll(p)));
    expect(collisions(build(drawing, annotations, 1), drawing)).toEqual([]);
  });

  it('pushes the aligned view out instead, as part of the same import', () => {
    const d = cramped();
    const p = plan(d, 1, { moveViews: true });
    expect(p.candidates.filter((c) => c.reason === 'layoutDoesNotFit')).toEqual([]);
    expect(p.viewMoves.map((m) => m.view.id)).toEqual(['VS']);
    const move = p.viewMoves[0];
    const before = d.views.find((v) => v.id === 'VS');
    const moved = move?.view;
    if (before?.kind !== 'projected' || moved?.kind !== 'projected') throw new Error('no move');
    if (before.layout.kind !== 'aligned' || moved.layout.kind !== 'aligned')
      throw new Error('free');
    expect(moved.layout.distance).toBeGreaterThan(before.layout.distance);
    expect(move?.for).toContain(`feature:${ID.E3}:/end/depth`);
    // One step: the view moves first, then the placements.
    const cmds = importCommands(p, 'D1', checkAll(p));
    expect(cmds.map((c) => c.kind)).toEqual(['updateView', 'placeAnnotations']);
    const { drawing, annotations } = apply(d, cmds);
    expect(collisions(build(drawing, annotations, 1), drawing)).toEqual([]);
    // The pushed view is still on the sheet and clear of the title block.
    const views = solveViews({ drawing, bounds: bracketBounds(1), evaluate });
    const vs = views.get('VS');
    if (!vs?.ok) throw new Error('VS');
    const sheet = sheetObstacles({ drawing, sheetId: 'S1', views });
    const o = viewOutline(vs);
    expect(o.max[0]).toBeLessThanOrEqual(sheet.frame.max[0]);
    // Without any candidate that needs it, the view stays where it was.
    const only = importCommands(p, 'D1', new Set([`sketch:${ID.S2}:d1`]));
    expect(only.map((c) => c.kind)).toEqual(['placeAnnotations']);
  });
});

describe('import on the bracket: duplicates', () => {
  it('places each measurement once, keeping the driving dimension', () => {
    const p = plan(bracketDrawing('first'), 1);
    const dup = p.candidates.filter((c) => c.reason === 'duplicate');
    // 20 and 60 (two holes per column), 11 and 31 (two per row), and the upright's 80.
    expect(dup.map((c) => c.key).sort()).toEqual(
      [
        `sketch:${ID.S2}:d8`, // H3 x = 20 (H1's d2 kept)
        `sketch:${ID.S2}:d5`, // H2 x = 60 (H4's d11 kept: key order)
        `sketch:${ID.S2}:d6`, // H2 y = 11 (H1's d3 kept)
        `sketch:${ID.S2}:d9`, // H3 y = 31 (H4's d12 kept)
        `sketch:${ID.S3}:d1`, // upright width 80 (the plate's kept)
      ].sort(),
    );
    for (const c of dup) {
      expect(c.placement).toBeUndefined();
      expect(c.duplicateOf).toMatch(/^sketch:/);
    }
    const { drawing, annotations } = apply(
      bracketDrawing('first'),
      importCommands(p, 'D1', checkAll(p)),
    );
    const t = texts(build(drawing, annotations, 1));
    for (const v of ['20', '60', '80', '31', '11'])
      expect(
        t.filter((x) => x === v),
        v,
      ).toHaveLength(1);
  });

  it('an annotation already placed wins, and a second import offers nothing new', () => {
    const d0 = bracketDrawing('first');
    const first = plan(d0, 1);
    const { drawing, annotations } = apply(d0, importCommands(first, 'D1', checkAll(first)));
    const part = { ...bracketPart(1), annotations };
    const frames = bracketFrames(1);
    const queries = importAnchorQueries(part, frames);
    let n = 100;
    const second = planImport({
      drawing,
      part,
      views: solveViews({ drawing, bounds: bracketBounds(1), evaluate }),
      resolutions: bracketResolutions(annotations, 1),
      sketchFrames: frames,
      anchors: anchorLookup(
        queries,
        queries.map((q) => bracketAnchor(q, 1)),
      ),
      moveViews: true,
      newId: () => `M${++n}`,
    });
    expect(second.candidates.filter((c) => c.placement)).toEqual([]);
    for (const c of second.candidates.filter((x) => x.reason === 'duplicate'))
      expect(c.duplicateOf).toMatch(/^annotation:/);
  });

  it('keeps the driving one over an existing annotation of the same measurement', () => {
    const d = bracketDrawing('first');
    const part = bracketPart(1);
    const width: Annotation = {
      id: 'A1',
      kind: 'linear',
      origin: { kind: 'drawing', drawingId: 'D0' },
      refs: [
        { name: `F${ID.E1}:side(S${ID.S1}:e(L4))`, kind: 'face' },
        { name: `F${ID.E1}:side(S${ID.S1}:e(L2))`, kind: 'face' },
      ],
      direction: [1, 0, 0],
    };
    part.annotations = [width];
    const frames = bracketFrames(1);
    const queries = importAnchorQueries(part, frames);
    const res = new Map([
      [
        'A1',
        {
          annotationId: 'A1',
          state: 'ok' as const,
          value: 80,
          anchors: [
            {
              kind: 'plane' as const,
              origin: [0, 0, 0] as [number, number, number],
              normal: [-1, 0, 0] as [number, number, number],
              outline: [],
            },
            {
              kind: 'plane' as const,
              origin: [80, 0, 0] as [number, number, number],
              normal: [1, 0, 0] as [number, number, number],
              outline: [],
            },
          ],
        },
      ],
    ]);
    let n = 0;
    const p = planImport({
      drawing: d,
      part,
      views: solveViews({ drawing: d, bounds: bracketBounds(1), evaluate }),
      resolutions: res,
      sketchFrames: frames,
      anchors: anchorLookup(
        queries,
        queries.map((q) => bracketAnchor(q, 1)),
      ),
      newId: () => `N${++n}`,
    });
    const a1 = p.candidates.find((c) => c.key === 'annotation:A1');
    const plate = p.candidates.find((c) => c.key === `sketch:${ID.S1}:d1`);
    expect(a1).toMatchObject({
      reason: 'duplicate',
      duplicateOf: `sketch:${ID.S1}:d1`,
      checked: false,
    });
    // It replaces a checked candidate, so it is checked itself.
    expect(plate?.checked).toBe(true);
    expect(plate?.placement).toBeDefined();
  });
});

describe('import on the bracket: promotions placed from one anchor query', () => {
  it('asks every ref once, with the annotation kind', () => {
    const q = importAnchorQueries(bracketPart(1), bracketFrames(1));
    const keys = q.map((x) => `${x.ref.name}|${x.annotationKind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`F${ID.E3}:start|linear`);
    expect(keys).toContain(`F${ID.E1}:end|linear`); // the upright sketch's own placement
    expect(keys.some((k) => k.startsWith(`F${ID.F1}:fillet(`) && k.endsWith('|radius'))).toBe(true);
    expect(keys.some((k) => k.startsWith(`F${ID.C1}:chamfer(`) && k.endsWith('|chamfer'))).toBe(
      true,
    );
  });

  it('places fillet and chamfer values and measures the upright from its own placement', () => {
    const p = plan(bracketDrawing('first'), 1);
    const c = new Map(p.candidates.map((x) => [x.key, x]));
    const upright = c.get(`feature:${ID.E3}:/end/depth`);
    // The start face is fused into the plate: the sketch's plane (the plate top) stands in.
    expect(upright?.annotation.refs.map((r) => r.name)).toEqual([`F${ID.E1}:end`, `F${ID.E3}:end`]);
    expect(upright?.placement).toBeDefined();
    const plate = c.get(`feature:${ID.E1}:/end/depth`);
    expect(plate?.annotation.refs.map((r) => r.name)).toEqual([`F${ID.E1}:start`, `F${ID.E1}:end`]);
    const corner = c.get(`feature:${ID.F1}:/radius`);
    expect(corner?.reason).toBeUndefined();
    expect(corner?.viewId).toBe('VT'); // the corner arc is face-on from above
    // The leader goes out through the arc's middle (down-left from the centre).
    expect(corner?.placement?.layout).toMatchObject({ kind: 'radial' });
    const bend = c.get(`feature:${ID.F2}:/radius`);
    expect(bend?.viewId).toBe('VS'); // the bend runs along x: face-on from the side
    expect(c.get(`feature:${ID.C1}:`)?.placement).toBeDefined();

    // After the import every promoted dimension resolves.
    const { annotations } = apply(bracketDrawing('first'), importCommands(p, 'D1', checkAll(p)));
    const res = bracketResolutions(annotations, 1);
    const bad = annotations.filter((a) => res.get(a.id)?.state !== 'ok').map((a) => a.id);
    expect(bad).toEqual([]);
  });

  it('without answers the upright still measures from its placement, never from a guess', () => {
    const d = bracketDrawing('first');
    const part = bracketPart(1);
    let n = 0;
    const p = planImport({
      drawing: d,
      part,
      views: solveViews({ drawing: d, bounds: bracketBounds(1), evaluate }),
      resolutions: new Map(),
      sketchFrames: bracketFrames(1),
      newId: () => `N${++n}`,
    });
    const c = new Map(p.candidates.map((x) => [x.key, x]));
    expect(c.get(`feature:${ID.E3}:/end/depth`)?.annotation.refs.map((r) => r.name)).toEqual([
      `F${ID.E1}:end`,
      `F${ID.E3}:end`,
    ]);
    // Fillets and chamfers need anchors: listed, not placed.
    expect(c.get(`feature:${ID.F1}:/radius`)?.reason).toBe('noGeometry');
    expect(c.get(`feature:${ID.C1}:`)?.reason).toBe('noGeometry');
  });

  it('keeps the honest needs-attention refs when neither choice resolves', () => {
    const d = bracketDrawing('first');
    const part = bracketPart(1);
    const frames = bracketFrames(1);
    const queries = importAnchorQueries(part, frames);
    const answers = queries.map((q) =>
      q.ref.name === `F${ID.E3}:end` || q.ref.name === `F${ID.E3}:start`
        ? { anchor: null }
        : bracketAnchor(q, 1),
    );
    let n = 0;
    const p = planImport({
      drawing: d,
      part,
      views: solveViews({ drawing: d, bounds: bracketBounds(1), evaluate }),
      resolutions: new Map(),
      sketchFrames: frames,
      anchors: anchorLookup(queries, answers),
      newId: () => `N${++n}`,
    });
    const up = p.candidates.find((x) => x.key === `feature:${ID.E3}:/end/depth`);
    // The preferred refs, unchanged: the regen then shows it as needs attention.
    expect(up?.annotation.refs.map((r) => r.name)).toEqual([`F${ID.E1}:end`, `F${ID.E3}:end`]);
  });

  it('skips a merged answer when an unmerged choice exists', () => {
    const d = bracketDrawing('first');
    const part = bracketPart(1);
    // The plate is a new body: its own start and end come first, unless the start was merged.
    const frames = bracketFrames(1);
    const queries = importAnchorQueries(part, frames);
    const answers = queries.map((q) => {
      const a = bracketAnchor(q, 1);
      return q.ref.name === `F${ID.E1}:start`
        ? { ...a, merged: { path: '/0', name: q.ref.name, into: 'Fother:end' } }
        : a;
    });
    let n = 0;
    const p = planImport({
      drawing: d,
      part,
      views: solveViews({ drawing: d, bounds: bracketBounds(1), evaluate }),
      resolutions: new Map(),
      sketchFrames: frames,
      anchors: anchorLookup(queries, answers),
      newId: () => `N${++n}`,
    });
    const plate = p.candidates.find((x) => x.key === `feature:${ID.E1}:/end/depth`);
    expect(plate?.annotation.refs.map((r) => r.name)).toEqual(['origin:XY', `F${ID.E1}:end`]);
  });
});
