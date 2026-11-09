/**
 * `SketchBSpline.through` (ADR-050): the through-point tool writes it, the solver takes it as the
 * source of truth for knot points (geometric recognition only for documents without it), and
 * trim / mirror keep it consistent. Also the minor-axis dimension annotation (ADR-051/055).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  DimensionConstraint,
  Id,
  SketchBSpline,
  SketchEntity,
  Vec2,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { dimensionAnnotation } from '../src/annotation';
import { splinePoint } from '../src/bspline';
import { mirrorEntities, trimEntity } from '../src/edit';
import { indexEntities, splineGeom } from '../src/geometry';
import { type SketchFragment, splineThroughTool } from '../src/tools';
import { ids, ok } from './edit-helpers';
import { core, SketchBuilder } from './helpers';

const pts: Vec2[] = [
  [0, 0],
  [10, 8],
  [20, 6],
  [30, -6],
  [40, 0],
];

function tool(closed = false): SketchFragment & { spline: SketchBSpline } {
  const f = splineThroughTool(pts, { id: ids('t'), closed });
  if (!f) throw new Error('no spline');
  return { ...f, spline: f.entities.find((e) => e.kind === 'bspline') as SketchBSpline };
}

const move = (es: SketchEntity[], id: Id, by: Vec2) =>
  es.map((e) => (e.id === id && e.kind === 'point' ? { ...e, x: e.x + by[0], y: e.y + by[1] } : e));

describe('through', () => {
  it('the tool lists the through points at the inner knots (all of them when closed)', () => {
    const open = tool();
    const throughIds = open.entities
      .filter((e) => e.kind === 'point')
      .slice(0, 5)
      .map((e) => e.id);
    expect(open.spline.through).toEqual(throughIds.slice(1, 4));
    const closed = tool(true);
    expect(closed.spline.through).toHaveLength(5);
  });

  it('is the source of truth: a through point moved off its knot is pulled back to it', async () => {
    const f = tool();
    const mid = f.spline.through?.[1] as Id;
    const entities = move(f.entities, mid, [0, 2]);
    const res = (await core()).solve({ entities, constraints: f.constraints, values: {} });
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(2 * pts.length + 4);
    const g = splineGeom(
      indexEntities(res.entities),
      res.entities.find((e) => e.id === f.spline.id) as SketchBSpline,
    );
    const k = (f.spline.knots as number[])[2] as number;
    const at = splinePoint(g, k);
    const p = res.entities.find((e) => e.id === mid) as { x: number; y: number };
    expect(Math.hypot(at[0] - p.x, at[1] - p.y)).toBeLessThan(1e-9);
  });

  it('without `through`, the geometric fallback: an off-knot point slides instead (one DOF more)', async () => {
    const f = tool();
    const { through: _t, ...plain } = f.spline;
    const mid = f.spline.through?.[1] as Id;
    const entities = move(
      f.entities.map((e) => (e.id === plain.id ? plain : e)),
      mid,
      [0, 2],
    );
    const res = (await core()).solve({ entities, constraints: f.constraints, values: {} });
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(2 * pts.length + 5);
    // And with the geometry untouched the fallback finds every knot point.
    const same = (await core()).solve({
      entities: f.entities.map((e) => (e.id === plain.id ? plain : e)),
      constraints: f.constraints,
      values: {},
    });
    expect(same.dof).toBe(2 * pts.length + 4);
  });

  it('a `through` that doesn’t match the knots fails with a named reason', async () => {
    const f = tool();
    const bad = { ...f.spline, through: f.spline.through?.slice(1) };
    const res = (await core()).solve({
      entities: f.entities.map((e) => (e.id === bad.id ? bad : e)),
      constraints: f.constraints,
      values: {},
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/^Spline 1: it needs one through point per inner knot \(3\)/);
  });

  it('trim: each piece lists the through points at its own inner knots', async () => {
    const f = tool();
    const b = new SketchBuilder();
    b.entities = structuredClone(f.entities);
    b.constraints = structuredClone(f.constraints);
    b.segment([15, -10], [15, 10]);
    b.segment([25, -10], [25, 10]);
    const r = ok(
      trimEntity({ entities: b.entities, constraints: b.constraints }, f.spline.id, [20, 6], {
        id: ids(),
      }),
    );
    const splines = r.sketch.entities.filter((e): e is SketchBSpline => e.kind === 'bspline');
    const t = f.spline.through as Id[];
    expect(splines[0]?.through).toEqual([t[0]]);
    expect(splines[1]?.through).toEqual([t[2]]);
    const res = (await core()).solve({ ...r.sketch, values: {} });
    expect(res.status).toBe('solved');
  });

  it('mirror: the copy lists the copied through points (only when they were picked)', () => {
    const f = tool();
    const sketch = { entities: f.entities, constraints: f.constraints };
    const t = f.spline.through as Id[];
    const all = ok(mirrorEntities(sketch, [f.spline.id, ...t], '@y', { id: ids() }));
    const copy = all.sketch.entities.find(
      (e) => e.kind === 'bspline' && e.id !== f.spline.id,
    ) as SketchBSpline;
    expect(copy.through).toHaveLength(3);
    expect(copy.through?.some((id) => t.includes(id))).toBe(false);
    const alone = ok(mirrorEntities(sketch, [f.spline.id], '@y', { id: ids() }));
    const c2 = alone.sketch.entities.find(
      (e) => e.kind === 'bspline' && e.id !== f.spline.id,
    ) as SketchBSpline;
    expect(c2.through).toBeUndefined();
  });
});

describe('minor-axis dimension annotation', () => {
  it('a leader along the minor axis', () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(0, 0), 10, 4, 0);
    const c = {
      id: 'd',
      kind: 'radius',
      curve: e,
      axis: 'minor',
      value: '4',
      driving: true,
      label: [2, 9],
    } as DimensionConstraint;
    const a = dimensionAnnotation(b.entities, c, 4);
    expect(a?.kind).toBe('radial');
    const tip = a?.arrows[0]?.tip as Vec2;
    expect(tip[0]).toBeCloseTo(0, 9);
    expect(tip[1]).toBeCloseTo(4, 9);
  });
});
