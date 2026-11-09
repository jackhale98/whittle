/**
 * M3.5 drawing tools (ellipse, elliptic arc, spline by control points / through points) and
 * inference while drawing the new kinds.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchBSpline, SketchEllipse, SketchEllipticArc, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { splinePoint } from '../src/bspline';
import { indexEntities, splineGeom } from '../src/geometry';
import { DRAWING_ENTITY, infer } from '../src/inference';
import {
  ellipseTool,
  ellipticArcTool,
  lineTool,
  type SketchFragment,
  splineControlTool,
  splineThroughTool,
} from '../src/tools';
import { core } from './helpers';

const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};
const solve = async (f: SketchFragment) => (await core()).solve({ ...f, values: {} });
const pointAt = (f: SketchFragment, id: string): Vec2 => {
  const p = f.entities.find((e) => e.id === id);
  if (p?.kind !== 'point') throw new Error('not a point');
  return [p.x, p.y];
};

describe('ellipse tools', () => {
  it('centre, axis point and minor-radius point; the larger radius is the major one', async () => {
    const f = ellipseTool([0, 0], [10, 0], [3, 4], { id: ids() });
    const e = f?.entities.find((x) => x.kind === 'ellipse') as SketchEllipse;
    expect(e.majorRadius).toBe(10);
    expect(e.minorRadius).toBe(4);
    expect(e.rotation).toBe(0);
    const g = ellipseTool([0, 0], [0, 3], [8, 1], { id: ids() });
    const e2 = g?.entities.find((x) => x.kind === 'ellipse') as SketchEllipse;
    expect(e2.majorRadius).toBe(8);
    expect(e2.minorRadius).toBe(3);
    expect(Math.abs(e2.rotation)).toBeCloseTo(0, 12);
    expect(ellipseTool([0, 0], [0, 0], [1, 1])).toBeNull();
    expect(ellipseTool([0, 0], [5, 0], [7, 0])).toBeNull();
    const res = await solve(f as SketchFragment);
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(5);
  });

  it('elliptic arc: ends projected onto the ellipse, counter-clockwise; it solves in place', async () => {
    const f = ellipticArcTool([0, 0], [10, 0], [0, 5], [10, 10], [-10, 10], { id: ids() });
    if (!f) throw new Error('no arc');
    const a = f.entities.find((x) => x.kind === 'ellipticArc') as SketchEllipticArc;
    for (const pid of [a.start, a.end]) {
      const p = pointAt(f, pid);
      expect((p[0] / 10) ** 2 + (p[1] / 5) ** 2).toBeCloseTo(1, 12);
    }
    expect(pointAt(f, a.start)[0]).toBeGreaterThan(0); // CCW from the first pick
    const cw = ellipticArcTool([0, 0], [10, 0], [0, 5], [10, 10], [-10, 10], {
      id: ids(),
      clockwise: true,
    });
    const b = cw?.entities.find((x) => x.kind === 'ellipticArc') as SketchEllipticArc;
    expect(pointAt(cw as SketchFragment, b.start)[0]).toBeLessThan(0);
    const res = await solve(f);
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(7);
  });
});

describe('spline tools', () => {
  const pts: Vec2[] = [
    [0, 0],
    [10, 8],
    [20, 2],
    [30, 9],
  ];

  it('by control points: poles are the picks (inner ones construction), uniform knots', async () => {
    const f = splineControlTool(pts, { id: ids() });
    if (!f) throw new Error('none');
    const s = f.entities.find((x) => x.kind === 'bspline') as SketchBSpline;
    expect(s.degree).toBe(3);
    expect(s.knots).toBeUndefined();
    expect(s.poles.map((id) => pointAt(f, id))).toEqual(pts);
    const cons = s.poles.map((id) => f.entities.find((e) => e.id === id)?.construction);
    expect(cons).toEqual([false, true, true, false]);
    expect(
      splineControlTool(pts.slice(0, 3), { id: ids() })?.entities.find((x) => x.kind === 'bspline'),
    ).toMatchObject({ degree: 2 });
    const closed = splineControlTool(pts, { id: ids(), closed: true });
    expect(closed?.entities.find((x) => x.kind === 'bspline')).toMatchObject({ periodic: true });
    const res = await solve(f);
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(8);
  });

  it('through points: the curve passes through every pick; inner picks held on it', async () => {
    const f = splineThroughTool(pts, { id: ids() });
    if (!f) throw new Error('none');
    const s = f.entities.find((x) => x.kind === 'bspline') as SketchBSpline;
    expect(s.poles).toHaveLength(pts.length + 2);
    expect(f.constraints.filter((c) => c.kind === 'pointOn')).toHaveLength(pts.length - 2);
    const g = splineGeom(indexEntities(f.entities), s);
    const k = s.knots as number[];
    pts.forEach((p, i) => {
      const q = splinePoint(g, k[i] as number);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1e-9);
    });
    const res = await solve(f);
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(2 * pts.length + 4);
    const closed = splineThroughTool(pts, { id: ids(), closed: true });
    expect(closed?.constraints.filter((c) => c.kind === 'pointOn')).toHaveLength(pts.length);
    expect((await solve(closed as SketchFragment)).dof).toBe(2 * pts.length);
    expect(
      splineThroughTool([
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull();
  });
});

describe('inference for the new kinds', () => {
  it('a line leaving a spline end along its tangent infers tangent; near the curve, point on', () => {
    const f = splineControlTool(
      [
        [0, 0],
        [10, 10],
        [20, 10],
        [30, 0],
      ],
      { id: ids() },
    ) as SketchFragment;
    const s = f.entities.find((x) => x.kind === 'bspline') as SketchBSpline;
    const input = { ...f, values: {} };
    // End tangent at (30, 0) runs along (30,0) − (20,10) = (1, −1).
    const c = infer(input, [40, -10.2], { kind: 'line', from: [30, 0] }, 1);
    expect(
      c.some(
        (k) => k.constraint.kind === 'tangent' && 'b' in k.constraint && k.constraint.b === s.id,
      ),
    ).toBe(true);
    const on = infer(input, [15, 7.6], null, 1);
    expect(on.some((k) => k.constraint.kind === 'pointOn' && k.constraint.on === s.id)).toBe(true);
  });

  it('a spline drawn from a line end continues it tangentially', () => {
    const f = lineTool([0, 0], [10, 0], { id: ids() });
    const line = f.entities.find((x) => x.kind === 'line');
    const c = infer({ ...f, values: {} }, [20, 0.3], { kind: 'bspline', from: [10, 0] }, 1);
    const t = c.find((k) => k.constraint.kind === 'tangent');
    expect(t?.constraint).toMatchObject({ a: DRAWING_ENTITY, b: line?.id });
    expect(t?.snapped[1]).toBeCloseTo(0, 12);
  });

  it('a line from an elliptic arc end along its tangent', () => {
    const f = ellipticArcTool([0, 0], [10, 0], [0, 5], [10, 0], [0, 5], {
      id: ids(),
    }) as SketchFragment;
    const a = f.entities.find((x) => x.kind === 'ellipticArc') as SketchEllipticArc;
    // At (0, 5) the CCW tangent is (−1, 0).
    const c = infer({ ...f, values: {} }, [-10, 5.2], { kind: 'line', from: [0, 5] }, 1);
    expect(
      c.some(
        (k) => k.constraint.kind === 'tangent' && 'b' in k.constraint && k.constraint.b === a.id,
      ),
    ).toBe(true);
  });
});
