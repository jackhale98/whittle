/**
 * PLAN M3.8 "Implied constraints on every tool": for every drawing tool, the glyphs shown while
 * hovering are exactly the constraints committed by the click (a point dropped on an existing
 * point reuses it and shows `coincident`; no duplicate point is made).
 */

import type { Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { constraintRefs, isSketchReference, lineTool } from '@wren-cad/sketch';
import { describe, expect, it } from 'vitest';
import {
  click,
  type DrawState,
  type DrawToolId,
  finishShape,
  finishTool,
  inProgress,
  move,
  nextRole,
  type SketchData,
  type SketchEdit,
  startDraw,
} from './draw';

// The base sketch: a line A–B and a free point Q, away from the origin and axes.
const base = (() => {
  const l = lineTool([100, 100], [140, 100]);
  const q: SketchEntity = { id: 'Q', kind: 'point', construction: false, x: 60, y: 40 };
  // E is as far from the origin as A: a centre arc about the origin from A can end on it.
  const e: SketchEntity = { id: 'E', kind: 'point', construction: false, x: 100, y: -100 };
  return { entities: [...l.entities, q, e], constraints: [] as SketchConstraint[] };
})();
const pointId = (x: number, y: number) =>
  (base.entities.find((e) => e.kind === 'point' && e.x === x && e.y === y) as SketchEntity).id;
const A = pointId(100, 100);
const B = pointId(140, 100);
const baseIds = new Set<Id>(base.entities.map((e) => e.id));

// Click positions (tolerance 1 mm): near A, B, Q, the origin, on L, at L's midpoint.
const nearA: Vec2 = [100.3, 100.2];
const nearB: Vec2 = [139.8, 100.3];
const nearQ: Vec2 = [60.2, 39.7];
const nearO: Vec2 = [0.3, -0.2];
const onL: Vec2 = [131, 100.4];
const midL: Vec2 = [120.2, 100.3];

interface Run {
  shown: string[];
  committed: string[];
  edits: SketchEdit[];
  data: SketchData;
  state: DrawState;
}

/**
 * The implied part of an edit: reused existing points (as `coincident`) and the constraints that
 * tie the new geometry to other existing geometry or the references. A tool's own constraints
 * (a rectangle's horizontals, a polygon's points on its circle, a tangent arc's tangency) may
 * mention a reused point, never other existing geometry.
 */
function implied(edit: SketchEdit, tool: DrawToolId): string[] {
  const reused = new Set<Id>(edit.reused ?? []);
  for (const id of reused) expect(baseIds.has(id), 'only visible points are reused').toBe(true);
  const other = (id: Id) => (baseIds.has(id) && !reused.has(id)) || isSketchReference(id);
  const out = edit.constraints
    .filter((c) => tool === 'line' || constraintRefs(c).some(other))
    // A tangent arc's tangency to the curve it leaves is the tool's own.
    .filter((c) => !(c.kind === 'tangent' && tool === 'arc'))
    .map((c) => c.kind as string);
  return [...out, ...[...reused].map(() => 'coincident')];
}

function drive(
  tool: DrawToolId,
  variant: string | undefined,
  clicks: readonly Vec2[],
  finish = false,
): Run {
  let s = startDraw(tool, variant);
  const data = { entities: [...base.entities], constraints: [...base.constraints] };
  const shown: string[] = [];
  const committed: string[] = [];
  const edits: SketchEdit[] = [];
  const land = (edit: SketchEdit | null) => {
    if (!edit) return;
    edits.push(edit);
    committed.push(...implied(edit, tool));
    data.entities.push(...edit.entities);
    data.constraints.push(...edit.constraints);
  };
  for (const p of clicks) {
    s = move(s, data, p, 1);
    shown.push(...s.glyphs);
    const r = click(s, data);
    s = r.state;
    land(r.edit);
  }
  if (finish) {
    const r = finishShape(s);
    if (r) {
      s = r.state;
      land(r.edit);
    }
  }
  return { shown: shown.sort(), committed: committed.sort(), edits, data, state: s };
}

/** No two points of the result share a position (no duplicate on top of an existing point). */
function noDuplicates(data: SketchData) {
  const pts = data.entities.filter(
    (e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point',
  );
  for (const p of [A, B, 'Q', 'E']) {
    const at = pts.find((e) => e.id === p) as { x: number; y: number };
    const twins = pts.filter((e) => Math.hypot(e.x - at.x, e.y - at.y) < 1e-6);
    expect(twins, `a duplicate of ${p}`).toHaveLength(1);
  }
}

const cases: Array<{
  name: string;
  tool: DrawToolId;
  variant?: string;
  clicks: Vec2[];
  finish?: boolean;
  /** Glyphs that must have been shown (so the case really exercises snaps). */
  expect: string[];
}> = [
  {
    name: 'line chain',
    tool: 'line',
    clicks: [nearO, [30, 30], [30.4, 60], midL],
    expect: ['coincident', 'vertical', 'midpoint'],
  },
  {
    name: 'line onto a curve',
    tool: 'line',
    clicks: [nearQ, onL],
    expect: ['coincident', 'pointOn'],
  },
  {
    name: 'corner rectangle',
    tool: 'rectangle',
    variant: 'corner',
    clicks: [nearA, nearQ],
    expect: ['coincident', 'coincident'],
  },
  {
    name: 'centre rectangle (construction centre)',
    tool: 'rectangle',
    variant: 'center',
    clicks: [nearQ, nearA],
    expect: ['coincident', 'coincident'],
  },
  {
    name: '3-point rectangle (depth click is free)',
    tool: 'rectangle',
    variant: 'threePoint',
    clicks: [nearA, midL, nearQ],
    expect: ['coincident', 'midpoint'],
  },
  {
    name: 'centre circle (rim through a point)',
    tool: 'circle',
    variant: 'center',
    clicks: [nearQ, nearA],
    expect: ['coincident', 'pointOn'],
  },
  {
    name: '3-point circle (through points)',
    tool: 'circle',
    variant: 'threePoint',
    clicks: [nearA, nearB, nearQ],
    expect: ['pointOn', 'pointOn', 'pointOn'],
  },
  {
    name: '3-point circle: a click on a curve has no glyph',
    tool: 'circle',
    variant: 'threePoint',
    clicks: [nearQ, onL, [40, 120]],
    expect: ['pointOn'],
  },
  {
    name: '3-point arc',
    tool: 'arc',
    variant: 'threePoint',
    clicks: [nearA, nearQ, nearB],
    expect: ['coincident', 'coincident', 'pointOn'],
  },
  {
    name: 'centre arc (end is a direction)',
    tool: 'arc',
    variant: 'center',
    clicks: [nearQ, nearA, nearB],
    expect: ['coincident', 'coincident'],
  },
  {
    name: 'centre arc ending on a point on its circle (reused)',
    tool: 'arc',
    variant: 'center',
    clicks: [nearO, nearA, [100.4, -99.7]],
    expect: ['coincident', 'coincident', 'coincident'],
  },
  {
    name: 'tangent arc',
    tool: 'arc',
    variant: 'tangent',
    clicks: [nearB, [170, 130.3]],
    expect: ['coincident'],
  },
  {
    name: 'tangent arc ending on the origin',
    tool: 'arc',
    variant: 'tangent',
    clicks: [nearA, nearO],
    expect: ['coincident', 'coincident'],
  },
  {
    name: 'slot (width is free)',
    tool: 'slot',
    clicks: [nearA, nearO, nearQ],
    expect: ['coincident', 'coincident'],
  },
  {
    name: 'polygon (construction centre)',
    tool: 'polygon',
    clicks: [nearQ, midL],
    expect: ['coincident', 'midpoint'],
  },
  {
    name: 'point on a curve',
    tool: 'point',
    clicks: [onL, nearO],
    expect: ['coincident', 'pointOn'],
  },
  {
    name: 'ellipse',
    tool: 'ellipse',
    clicks: [nearO, nearA, nearQ],
    expect: ['coincident', 'pointOn'],
  },
  {
    name: 'elliptic arc (only the centre binds)',
    tool: 'ellipticArc',
    clicks: [nearQ, [100, 40], [60, 60], nearA, nearB],
    expect: ['coincident'],
  },
  {
    name: 'control-point spline (inner poles bind)',
    tool: 'splineControl',
    clicks: [nearA, midL, [80, 140], nearO],
    finish: true,
    expect: ['coincident', 'midpoint', 'coincident'],
  },
  {
    name: 'through-point spline',
    tool: 'splineThrough',
    clicks: [nearQ, onL, [170, 60], nearB],
    finish: true,
    expect: ['coincident', 'pointOn', 'coincident'],
  },
];

describe('implied constraints: glyphs shown equal constraints committed (M3.8)', () => {
  for (const c of cases)
    it(c.name, () => {
      const r = drive(c.tool, c.variant, c.clicks, c.finish);
      expect(r.edits.length).toBeGreaterThan(0);
      expect(r.shown).toEqual([...c.expect].sort());
      expect(r.committed).toEqual(r.shown);
      noDuplicates(r.data);
    });

  it('a reused point is shared, not duplicated: a circle centred on Q uses Q', () => {
    const r = drive('circle', 'center', [nearQ, [80, 40]]);
    const circle = r.edits[0]?.entities.find((e) => e.kind === 'circle');
    expect(circle?.kind === 'circle' && circle.center).toBe('Q');
    expect(r.edits[0]?.entities.filter((e) => e.kind === 'point')).toHaveLength(0);
  });

  it('a spline pole on an existing point is that point', () => {
    const r = drive('splineControl', undefined, [[20, 20], nearQ, [90, 20]], true);
    const spline = r.edits[0]?.entities.find((e) => e.kind === 'bspline');
    expect(spline?.kind === 'bspline' && spline.poles[1]).toBe('Q');
  });

  it('the Point tool on an existing point adds nothing and selects it', () => {
    let s = move(startDraw('point'), base, nearA, 1);
    expect(s.glyphs).toEqual(['coincident']);
    const r = click(s, base);
    expect(r.edit).toBeNull();
    expect(r.select).toBe(A);
    s = r.state;
  });

  it('free clicks neither snap nor show glyphs', () => {
    const s0 = move(startDraw('slot'), base, nearA, 1);
    let s = click(s0, base).state;
    s = click(move(s, base, [0, 50], 1), base).state;
    expect(nextRole(s)).toBe('free');
    s = move(s, base, nearQ, 1);
    expect(s.glyphs).toEqual([]);
    expect(s.cursor).toEqual(nearQ);
  });

  it('an alignment guide snaps and commits its alignment, with its glyph', () => {
    // Level with A (y = 100) but far from it: the cursor snaps to y = 100 and shows the glyph.
    const s = move(startDraw('point'), base, [20, 100.4], 1);
    expect(s.cursor).toEqual([20, 100]);
    expect(s.glyphs).toEqual(['horizontalPoints']);
    expect(s.guides).toEqual([]); // committed: a solid glyph, not a dashed guide
    const r = click(s, base);
    const id = r.edit?.entities[0]?.id;
    expect(r.edit?.constraints).toEqual([
      expect.objectContaining({ kind: 'horizontalPoints', a: id, b: A }),
    ]);
  });

  it('a line rectangle closes without a redundant vertical (the corner alignment holds it)', () => {
    // Closing on the chain's own start (not a base point): driven by hand, glyphs per click.
    let s = startDraw('line');
    const data: SketchData = { entities: [], constraints: [] };
    const shown: string[] = [];
    const made: string[] = [];
    for (const p of [
      [10, 10],
      [50, 10.3],
      [50.2, 30],
      [10.3, 30.2],
      [10.2, 10.1],
    ] as Vec2[]) {
      s = move(s, data, p, 1);
      shown.push(...s.glyphs.filter((g) => g !== 'coincident'));
      const r = click(s, data);
      s = r.state;
      if (r.edit) {
        (data.entities as SketchEntity[]).push(...r.edit.entities);
        (data.constraints as SketchConstraint[]).push(...r.edit.constraints);
        made.push(...r.edit.constraints.map((c) => c.kind as string));
      }
    }
    expect(made.sort()).toEqual(shown.sort());
    const all = made;
    expect(all).toEqual(['horizontal', 'horizontal', 'vertical', 'verticalPoints']);
  });

  it('a line closing onto an already aligned point shows and commits no redundant vertical', () => {
    // A vertical pair (verticalPoints) already ties P to A: a line P → A needs no vertical.
    const P: SketchEntity = { id: 'P', kind: 'point', construction: false, x: 100, y: 60 };
    const sk: SketchData = {
      entities: [...base.entities, P],
      constraints: [{ id: 'vp', kind: 'verticalPoints', a: 'P', b: A }],
    };
    let s = click(move(startDraw('line'), sk, [100.2, 60.3], 1), sk).state;
    s = move(s, sk, nearA, 1);
    expect(s.glyphs).toEqual(['coincident']);
    const r = click(s, sk);
    expect(r.edit?.constraints).toEqual([]);
    // Without the pair, the same line is made vertical.
    const free: SketchData = { entities: sk.entities, constraints: [] };
    let t = click(move(startDraw('line'), free, [100.2, 60.3], 1), free).state;
    t = move(t, free, nearA, 1);
    expect(t.glyphs).toEqual(['coincident', 'vertical']);
    expect(click(t, free).edit?.constraints.map((c) => c.kind)).toEqual(['vertical']);
  });
});

describe('finish without Esc (M3.8)', () => {
  it('ends a line chain where it is, keeping the tool', () => {
    const r = drive('line', undefined, [
      [10, 10],
      [30, 10],
      [30, 40],
    ]);
    expect(inProgress(r.state)).toBe(true);
    const f = finishTool(r.state);
    expect(f?.edit).toBeNull();
    expect(f && inProgress(f.state)).toBe(false);
    expect(f?.state.tool).toBe('line');
    expect(r.edits).toHaveLength(2);
  });

  it('commits an open spline with the points so far (three points)', () => {
    const r = drive('splineThrough', undefined, [
      [10, 10],
      [30, 25],
      [50, 10],
    ]);
    const f = finishTool(r.state);
    const spline = f?.edit?.entities.find((e) => e.kind === 'bspline');
    expect(spline).toMatchObject({ kind: 'bspline', periodic: false });
  });

  it('drops a partly placed shape (nothing to finish) and is null with nothing in progress', () => {
    const r = drive('rectangle', 'corner', [[10, 10]]);
    const f = finishTool(r.state);
    expect(f?.edit).toBeNull();
    expect(f && inProgress(f.state)).toBe(false);
    expect(finishTool(startDraw('line'))).toBeNull();
  });

  it('two-point splines finish: a straight cubic through two points and a degree-1 segment', () => {
    const through = drive('splineThrough', undefined, [[10, 10], nearQ], true);
    const t = through.edits[0]?.entities.find((e) => e.kind === 'bspline');
    expect(t).toMatchObject({ degree: 3, periodic: false, through: [] });
    expect(t?.kind === 'bspline' && t.poles).toHaveLength(4);
    expect(t?.kind === 'bspline' && t.poles[3]).toBe('Q'); // the end reused Q
    const control = drive('splineControl', undefined, [
      [10, 10],
      [40, 30],
    ]);
    const c = finishTool(control.state)?.edit?.entities.find((e) => e.kind === 'bspline');
    expect(c).toMatchObject({ degree: 1, periodic: false });
    expect(c?.kind === 'bspline' && c.poles).toHaveLength(2);
  });
});
