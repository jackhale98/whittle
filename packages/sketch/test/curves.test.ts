/**
 * M3.5 sketch curves in the solver: ellipses, elliptic arcs and B-splines (control points and
 * through points), point-on, every tangent pair (G1 at shared ends and anywhere), the G2
 * curvature constraint, ellipse dimensions, DOF and drags.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchSolveResult, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { interpolate, splinePoint } from '../src/bspline';
import { closestParam, indexEntities, paramCurve, splineGeom } from '../src/geometry';
import {
  CURVE_KINDS,
  type CurveKind,
  contact,
  curvatureAt,
  curveAt,
  jointAngle,
  OPEN_KINDS,
} from './curve-check';
import { core, entity, pos, SketchBuilder } from './helpers';

const solved = (r: SketchSolveResult, what = '') => {
  expect(
    r.status,
    `${what} ${r.error ?? ''} ${r.conflicts.map((c) => c.explanation).join('; ')}`,
  ).toBe('solved');
};

/** A through-point spline the way the tool builds it (end poles shared, inner points at knots). */
function throughSpline(b: SketchBuilder, pts: Vec2[], closed = false) {
  const it = interpolate(pts, 3, closed);
  if (!it) throw new Error('no interpolation');
  const through = pts.map((p) => b.point(p[0], p[1]));
  const poles: Id[] = it.poles.map((p, i) => {
    if (!closed && i === 0) return through[0] as Id;
    if (!closed && i === it.poles.length - 1) return through[through.length - 1] as Id;
    return b.point(p[0], p[1]);
  });
  const s = b.bspline(poles, {
    degree: it.degree,
    periodic: closed,
    knots: it.knots,
    multiplicities: it.multiplicities,
  });
  const inner = closed ? through : through.slice(1, -1);
  const on = inner.map((p) => b.geo({ kind: 'pointOn', point: p, on: s }));
  return { s, through, poles, on, it };
}

describe('ellipses and elliptic arcs', () => {
  it('an unconstrained ellipse has 5 DOF; an elliptic arc 7', async () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(0, 0), 10, 5, 0.3);
    const c = b.point(30, 0);
    const s = b.pointOnEllipse([30, 0], 8, 3, 0, 0.2);
    const t = b.pointOnEllipse([30, 0], 8, 3, 0, 2.5);
    const ea = b.ellipticArc(c, 8, 3, 0, s, t);
    const res = (await core()).solve(b.input());
    solved(res);
    expect(res.dof).toBe(12);
    expect(res.entityDof[e]).toBe('free');
    expect(res.entityDof[ea]).toBe('free');
  });

  it('an elliptic arc keeps its ends on its ellipse when they are dragged', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    b.geo({ kind: 'fix', entity: c });
    const s = b.pointOnEllipse([0, 0], 10, 4, 0.4, 0.3);
    const t = b.pointOnEllipse([0, 0], 10, 4, 0.4, 2);
    const ea = b.ellipticArc(c, 10, 4, 0.4, s, t);
    const r0 = solver.solve(b.input());
    solved(r0);
    const grab = pos(r0, t);
    const { session } = solver.beginDrag(b.input(), t, grab);
    for (let i = 1; i <= 10; i++) {
      const r = solver.drag(session, [grab[0] - i * 0.5, grab[1] + i * 0.2]);
      expect(r.status).toBe('solved');
      const e = entity(r, ea, 'ellipticArc');
      for (const pid of [s, t]) {
        const p = pos(r, pid);
        const l = [
          (p[0] * Math.cos(e.rotation) + p[1] * Math.sin(e.rotation)) / e.majorRadius,
          (-p[0] * Math.sin(e.rotation) + p[1] * Math.cos(e.rotation)) / e.minorRadius,
        ] as const;
        expect(l[0] ** 2 + l[1] ** 2).toBeCloseTo(1, 9);
      }
    }
    solver.endDrag(session);
  });

  it('radius / diameter dimension the major radius; centre-to-curve distance the minor radius', async () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    b.geo({ kind: 'fix', entity: c });
    const e = b.ellipse(c, 10, 5, 0.3);
    const rad = b.dim({ kind: 'radius', curve: e }, 12);
    b.dim({ kind: 'distance', a: c, b: e }, 4);
    const ref = b.dim({ kind: 'diameter', curve: e }, 0, false);
    const res = (await core()).solve(b.input());
    solved(res);
    const g = entity(res, e, 'ellipse');
    expect(g.majorRadius).toBeCloseTo(12, 9);
    expect(g.minorRadius).toBeCloseTo(4, 9);
    expect(res.driven[ref]).toBeCloseTo(24, 9);
    // Only the rotation is left.
    expect(res.dof).toBe(1);
    void rad;
    // A distance from another point to an ellipse is refused with a plain reason.
    const p = b.point(30, 0);
    b.dim({ kind: 'distance', a: p, b: e }, 3);
    const bad = (await core()).solve(b.input());
    expect(
      bad.conflicts.some((k) => k.kind === 'unsupported' && /centre/.test(k.explanation)),
    ).toBe(true);
  });

  it('point on an elliptic arc, equal elliptic arcs, concentric', async () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.pointOnEllipse([0, 0], 10, 4, 0, 0.3);
    const t = b.pointOnEllipse([0, 0], 10, 4, 0, 2);
    const ea = b.ellipticArc(c, 10, 4, 0, s, t);
    const e = b.ellipse(b.point(1, 1), 7, 3, 0.5);
    const q = b.point(0, -6);
    b.geo({ kind: 'pointOn', point: q, on: ea });
    b.geo({ kind: 'equal', a: ea, b: e });
    b.geo({ kind: 'concentric', a: ea, b: e });
    const res = (await core()).solve(b.input());
    solved(res);
    const g1 = entity(res, ea, 'ellipticArc');
    const g2 = entity(res, e, 'ellipse');
    expect(g1.majorRadius).toBeCloseTo(g2.majorRadius, 9);
    expect(g1.minorRadius).toBeCloseTo(g2.minorRadius, 9);
    expect(pos(res, c)).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
  });
});

describe('B-splines by control points', () => {
  it('a spline has two DOF per pole; a pole-to-pole distance takes one', async () => {
    const b = new SketchBuilder();
    const poles = [b.point(0, 0), b.point(5, 8), b.point(12, 6), b.point(18, 0)];
    const s = b.bspline(poles);
    const r0 = (await core()).solve(b.input());
    solved(r0);
    expect(r0.dof).toBe(8);
    expect(r0.entityDof[s]).toBe('free');
    b.dim({ kind: 'distance', a: poles[0] as Id, b: poles[3] as Id }, 20);
    for (const p of poles) b.geo({ kind: 'fix', entity: p });
    b.constraints.pop();
    b.constraints.pop();
    const r1 = (await core()).solve(b.input());
    solved(r1);
    expect(Math.hypot(...(pos(r1, poles[3] as Id) as [number, number]))).toBeCloseTo(20, 9);
    // Poles 0 and 1 fixed, 2 and 3 free with one distance: 3 DOF.
    expect(r1.dof).toBe(3);
    expect(r1.entityDof[s]).toBe('partial');
  });

  it('a point on a spline slides along it (1 DOF) and stays on it', async () => {
    const b = new SketchBuilder();
    const poles = [b.point(0, 0), b.point(5, 8), b.point(12, 6), b.point(18, 0)];
    for (const p of poles) b.geo({ kind: 'fix', entity: p });
    const s = b.bspline(poles);
    const q = b.point(9, 7);
    b.geo({ kind: 'pointOn', point: q, on: s });
    b.dim({ kind: 'hDistance', a: poles[0] as Id, b: q }, 6);
    const res = (await core()).solve(b.input());
    solved(res);
    expect(res.dof).toBe(0);
    const g = splineGeom(indexEntities(res.entities), entity(res, s, 'bspline'));
    const p = pos(res, q);
    expect(p[0]).toBeCloseTo(6, 9);
    const curve = paramCurve(indexEntities(res.entities), entity(res, s, 'bspline'));
    if (!curve) throw new Error('no curve');
    const on = splinePoint(g, closestParam(curve, p));
    expect(Math.hypot(on[0] - p[0], on[1] - p[1])).toBeLessThan(1e-8);
  });

  it('closed (periodic) splines solve and drag', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const poles = [b.point(0, 0), b.point(10, 0), b.point(12, 8), b.point(4, 12), b.point(-3, 6)];
    const s = b.bspline(poles, { periodic: true });
    const q = b.point(6, 1);
    b.geo({ kind: 'pointOn', point: q, on: s });
    const r0 = solver.solve(b.input());
    solved(r0);
    expect(r0.dof).toBe(11);
    const { session } = solver.beginDrag(b.input(), s, pos(r0, q));
    const r = solver.drag(session, [pos(r0, q)[0] + 1, pos(r0, q)[1] - 2]);
    expect(r.status).toBe('solved');
    solver.endDrag(session);
  });

  it('invalid spline definitions fail with a named reason', async () => {
    const b = new SketchBuilder();
    const poles = [b.point(0, 0), b.point(5, 8), b.point(12, 6)];
    b.bspline(poles, { degree: 3 });
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/^Spline 1: a degree-3 spline needs at least 4 control points/);
  });
});

describe('B-splines through points', () => {
  const pts: Vec2[] = [
    [0, 0],
    [10, 6],
    [22, 4],
    [30, -5],
    [42, 0],
  ];

  it('through points are held at their knots; the handles stay free (DOF = 2m + 4)', async () => {
    const b = new SketchBuilder();
    const { s, through } = throughSpline(b, pts);
    const res = (await core()).solve(b.input());
    solved(res);
    expect(res.dof).toBe(2 * through.length + 4);
    // Nothing moved: the tool's geometry already satisfies the interpolation.
    through.forEach((t, i) => {
      expect(pos(res, t)).toEqual(pts[i]);
    });
    expect(res.entityDof[s]).toBe('free');
  });

  it('dragging a through point reshapes the curve and leaves the other through points', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const { s, through, it: interp } = throughSpline(b, pts);
    const mid = through[2] as Id;
    const grab = pts[2] as Vec2;
    const { session } = solver.beginDrag(b.input(), mid, grab);
    let last: SketchSolveResult | null = null;
    for (let i = 1; i <= 15; i++) {
      last = solver.drag(session, [grab[0] + i * 0.3, grab[1] + i * 0.5]);
      expect(last.status).toBe('solved');
    }
    if (!last) throw new Error('no drag');
    expect(pos(last, mid)[0]).toBeCloseTo(grab[0] + 4.5, 9);
    expect(pos(last, mid)[1]).toBeCloseTo(grab[1] + 7.5, 9);
    through.forEach((t, i) => {
      if (t !== mid) expect(pos(last as SketchSolveResult, t)).toEqual(pts[i]);
    });
    // The curve still interpolates every through point at its knot.
    const g = splineGeom(indexEntities(last.entities), entity(last, s, 'bspline'));
    through.forEach((t, i) => {
      const on = splinePoint(g, interp.params[i] as number);
      const p = pos(last as SketchSolveResult, t);
      expect(Math.hypot(on[0] - p[0], on[1] - p[1])).toBeLessThan(1e-9);
    });
    // Stable: dragging back restores the original curve.
    const back = solver.drag(session, grab);
    expect(back.status).toBe('solved');
    const g0 = splineGeom(indexEntities(back.entities), entity(back, s, 'bspline'));
    g0.poles.forEach((p, i) => {
      const q = interp.poles[i] as Vec2;
      expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-7);
    });
    const end = solver.endDrag(session);
    solved(end);
  });

  it('a dimension on a through point moves only that point', async () => {
    const b = new SketchBuilder();
    const { through } = throughSpline(b, pts);
    b.geo({ kind: 'fix', entity: through[0] as Id });
    b.dim({ kind: 'vDistance', a: through[0] as Id, b: through[2] as Id }, 9);
    const res = (await core()).solve(b.input());
    solved(res);
    expect(pos(res, through[2] as Id)[1]).toBeCloseTo(9, 9);
    through.forEach((t, i) => {
      if (i !== 2) expect(pos(res, t)).toEqual(pts[i]);
    });
  });

  it('closed through-point splines: every point at a knot; DOF = 2m', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const loop: Vec2[] = [
      [0, 0],
      [20, -2],
      [26, 12],
      [8, 18],
      [-4, 9],
    ];
    const { through, s } = throughSpline(b, loop, true);
    const r0 = solver.solve(b.input());
    solved(r0);
    expect(r0.dof).toBe(2 * loop.length);
    const { session } = solver.beginDrag(b.input(), through[1] as Id, loop[1] as Vec2);
    const r = solver.drag(session, [22, -6]);
    expect(r.status).toBe('solved');
    expect(pos(r, through[3] as Id)).toEqual(loop[3]);
    expect(entity(r, s, 'bspline').periodic).toBe(true);
    solver.endDrag(session);
  });
});

describe('tangency between every pair of curve kinds', () => {
  for (const ka of OPEN_KINDS) {
    for (const kb of [...OPEN_KINDS, 'circle', 'ellipse'] as CurveKind[]) {
      if (ka === 'line' && kb === 'line') continue;
      it(`G1 at a shared point: ${ka} → ${kb}`, async () => {
        const b = new SketchBuilder();
        const j = b.point(0, 0);
        const a = curveAt(b, ka, j, [0, 0], 'in', 0);
        const c = curveAt(b, kb, j, [0, 0], 'out', 0.35);
        b.geo({ kind: 'tangent', a, b: c });
        const res = (await core()).solve(b.input());
        solved(res, `${ka}→${kb}`);
        expect(jointAngle(res.entities, a, c, pos(res, j))).toBeLessThan(1e-7);
      });
    }
  }
  for (let i = 0; i < CURVE_KINDS.length; i++) {
    for (let k = i; k < CURVE_KINDS.length; k++) {
      const ka = CURVE_KINDS[i] as CurveKind;
      const kb = CURVE_KINDS[k] as CurveKind;
      if (ka === 'line' && kb === 'line') continue;
      it(`anywhere (no shared point): ${ka} and ${kb}`, async () => {
        const b = new SketchBuilder();
        const j1 = b.point(0, 0);
        const j2 = b.point(0, 1.5);
        const a = curveAt(b, ka, j1, [0, 0], 'out', 0);
        const c = curveAt(b, kb, j2, [0, 1.5], 'out', 0.25);
        b.geo({ kind: 'tangent', a, b: c });
        const res = (await core()).solve(b.input());
        solved(res, `${ka}/${kb}`);
        const t = contact(res.entities, a, c);
        expect(t.gap).toBeLessThan(1e-7);
        expect(t.angle).toBeLessThan(1e-6);
      });
    }
  }
});

describe('tangency inside the curves', () => {
  it('two splines touch mid-span, on their own extents', async () => {
    const b = new SketchBuilder();
    const hump = b.bspline([b.point(0, 0), b.point(5, 4), b.point(10, 4), b.point(15, 0)]);
    const valley = b.bspline([b.point(0, 9), b.point(5, 5.5), b.point(10, 5.5), b.point(15, 9)]);
    b.geo({ kind: 'tangent', a: hump, b: valley });
    const res = (await core()).solve(b.input());
    solved(res);
    const t = contact(res.entities, hump, valley, true);
    expect(t.gap).toBeLessThan(1e-7);
    expect(t.angle).toBeLessThan(1e-6);
  });

  it('an ellipse rests on a spline; a line touches an elliptic arc', async () => {
    const b = new SketchBuilder();
    const hump = b.bspline([b.point(0, 0), b.point(5, 4), b.point(10, 4), b.point(15, 0)]);
    const e = b.ellipse(b.point(7.5, 8), 6, 3, 0.1);
    b.geo({ kind: 'tangent', a: e, b: hump });
    const s = b.pointOnEllipse([30, 0], 8, 4, 0, 0.4);
    const t = b.pointOnEllipse([30, 0], 8, 4, 0, 2.6);
    const ea = b.ellipticArc(b.point(30, 0), 8, 4, 0, s, t);
    const l = b.segment([20, 5], [40, 5.5]);
    b.geo({ kind: 'tangent', a: l.line, b: ea });
    const res = (await core()).solve(b.input());
    solved(res);
    for (const [x, y] of [
      [e, hump],
      [l.line, ea],
    ] as const) {
      const c = contact(res.entities, x, y, x !== l.line);
      expect(c.gap).toBeLessThan(1e-7);
      expect(c.angle).toBeLessThan(1e-6);
    }
  });
});

describe('curvature continuity (G2)', () => {
  for (const kb of ['line', 'arc', 'ellipticArc', 'bspline'] as CurveKind[]) {
    it(`spline → ${kb}: tangent and equal curvature at the joint`, async () => {
      const b = new SketchBuilder();
      const j = b.point(0, 0);
      const a = curveAt(b, 'bspline', j, [0, 0], 'in', 0);
      const c = curveAt(b, kb, j, [0, 0], 'out', 0.2);
      b.geo({ kind: 'curvature', a, b: c });
      const res = (await core()).solve(b.input());
      solved(res, `G2 spline→${kb}`);
      const p = pos(res, j);
      expect(jointAngle(res.entities, a, c, p)).toBeLessThan(1e-7);
      const ka = curvatureAt(res.entities, a, p);
      const kc = curvatureAt(res.entities, c, p);
      expect(Math.hypot(ka[0] - kc[0], ka[1] - kc[1])).toBeLessThan(1e-6);
    });
  }

  it('G2 + tangent at the same joint: the tangent is redundant, not a conflict', async () => {
    const b = new SketchBuilder();
    const j = b.point(0, 0);
    const a = curveAt(b, 'bspline', j, [0, 0], 'in', 0);
    const c = curveAt(b, 'arc', j, [0, 0], 'out', 0.2);
    b.geo({ kind: 'curvature', a, b: c });
    const t = b.geo({ kind: 'tangent', a, b: c });
    const res = (await core()).solve(b.input());
    solved(res);
    expect(res.redundant).toContain(t);
  });

  it('is reported as unsupported (never dropped) without a shared end or a spline', async () => {
    const b = new SketchBuilder();
    const j = b.point(0, 0);
    const a = curveAt(b, 'bspline', j, [0, 0], 'out', 0);
    const l = b.segment([0, 5], [10, 5]);
    const g1 = b.geo({ kind: 'curvature', a, b: l.line });
    const arc = curveAt(b, 'arc', l.end, [10, 5], 'out', 0);
    const g2 = b.geo({ kind: 'curvature', a: l.line, b: arc });
    const res = (await core()).solve(b.input());
    expect(res.status).toBe('conflicting');
    const c1 = res.conflicts.find((c) => c.constraints.includes(g1));
    const c2 = res.conflicts.find((c) => c.constraints.includes(g2));
    expect(c1?.kind).toBe('unsupported');
    expect(c1?.explanation).toMatch(/^Curvature \(Spline 1, Line 1\): .*share an end point/);
    expect(c1?.entities).toEqual([a, l.line]);
    expect(c2?.explanation).toMatch(/needs a spline/);
    expect(c2?.fixes[0]?.action).toEqual({ kind: 'removeConstraint', constraint: g2 });
  });
});
