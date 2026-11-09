/**
 * Test helpers for the M3.5 curves: builders for each curve kind around a shared joint point, and
 * numeric checks of tangency (G1) and curvature (G2) on solved geometry.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { closestParam, indexEntities, type ParamCurve, paramCurve } from '../src/geometry';
import type { SketchBuilder } from './helpers';

export type CurveKind = 'line' | 'circle' | 'arc' | 'ellipse' | 'ellipticArc' | 'bspline';
export const CURVE_KINDS: CurveKind[] = ['line', 'circle', 'arc', 'ellipse', 'ellipticArc', 'bspline'];
export const OPEN_KINDS: CurveKind[] = ['line', 'arc', 'ellipticArc', 'bspline'];

const rot = (p: Vec2, a: number): Vec2 => [
  p[0] * Math.cos(a) - p[1] * Math.sin(a),
  p[0] * Math.sin(a) + p[1] * Math.cos(a),
];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];

/** Minor radius so that `p` lies on the ellipse (centre c, major a, rotation). */
function minorThrough(c: Vec2, a: number, rotation: number, p: Vec2): number {
  const l = rot([p[0] - c[0], p[1] - c[1]], -rotation);
  return Math.abs(l[1]) / Math.sqrt(1 - (l[0] / a) ** 2);
}

/**
 * A curve of `kind` ending (side 'in') or starting (side 'out') at point `j` (at `at`), heading
 * roughly along +x; closed kinds pass through `j` (held by pointOn). `tilt` turns the curve about
 * the joint so the pair starts off tangent. Returns the curve id.
 */
export function curveAt(
  b: SketchBuilder,
  kind: CurveKind,
  j: Id,
  at: Vec2,
  side: 'in' | 'out',
  tilt: number,
): Id {
  const s = side === 'in' ? -1 : 1;
  const P = (q: Vec2) => {
    const r = add(at, rot([s * q[0], q[1]], tilt));
    return b.point(r[0], r[1]);
  };
  const W = (q: Vec2): Vec2 => add(at, rot([s * q[0], q[1]], tilt));
  switch (kind) {
    case 'line': {
      const o = P([10, 3]);
      return side === 'in' ? b.line(o, j) : b.line(j, o);
    }
    case 'circle': {
      const c = P([0, 8]);
      const id = b.circle(c, 8);
      b.geo({ kind: 'pointOn', point: j, on: id });
      return id;
    }
    case 'arc': {
      // Centre above the joint; the arc leaves (or reaches) the joint along ±x.
      const cw = W([0, 8]);
      const c = b.point(cw[0], cw[1]);
      const other = add(cw, rot(rot([0, -8], s * 1.1), tilt));
      const o = b.point(other[0], other[1]);
      return s > 0 ? b.arc(c, j, o) : b.arc(c, o, j);
    }
    case 'ellipse': {
      const cw = W([1, 5]);
      const c = b.point(cw[0], cw[1]);
      const a = 9;
      const r = tilt + 0.2;
      const id = b.ellipse(c, a, minorThrough(cw, a, r, at), r);
      b.geo({ kind: 'pointOn', point: j, on: id });
      return id;
    }
    case 'ellipticArc': {
      const cw = W([1, 4]);
      const c = b.point(cw[0], cw[1]);
      const a = 8;
      const r = tilt + 0.15;
      const bb = minorThrough(cw, a, r, at);
      const l = rot([at[0] - cw[0], at[1] - cw[1]], -r);
      const tj = Math.atan2(l[1] / bb, l[0] / a);
      const t = tj + s * 1.2;
      const q = add(cw, rot([a * Math.cos(t), bb * Math.sin(t)], r));
      const o = b.point(q[0], q[1]);
      return s > 0 ? b.ellipticArc(c, a, bb, r, j, o) : b.ellipticArc(c, a, bb, r, o, j);
    }
    case 'bspline': {
      const q = [P([4, 3]), P([8, -2]), P([12, 2])];
      return side === 'in' ? b.bspline([q[2], q[1], q[0], j] as Id[]) : b.bspline([j, ...q]);
    }
  }
}

/**
 * A curve's carrier, which tangency and point-on hold to (planegcs' convention): lines are
 * infinite, arcs their circle, elliptic arcs their ellipse, clamped splines continue polynomially
 * past their ends. `own` = the entity's own extent instead.
 */
export function curveOf(entities: readonly SketchEntity[], id: Id, own = false): ParamCurve {
  const index = indexEntities(entities);
  const e = index.get(id);
  if (!e) throw new Error(`no ${id}`);
  const c = paramCurve(index, e);
  if (!c) throw new Error(`${id} is not a curve`);
  if (own) return c;
  if (e.kind === 'arc') return { ...c, t0: 0, t1: 2 * Math.PI, closed: true };
  if (e.kind === 'ellipticArc') return { ...c, t0: 0, t1: 2 * Math.PI, closed: true };
  if (e.kind === 'line') return { ...c, t0: -2, t1: 3 };
  if (e.kind === 'bspline' && !c.closed) return { ...c, t0: c.t0 - 0.5, t1: c.t1 + 0.5 };
  return c;
}

const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
};
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/** |sin| of the angle between the curves' tangents at point p (on both). */
export function jointAngle(entities: readonly SketchEntity[], a: Id, b: Id, p: Vec2): number {
  const ca = curveOf(entities, a);
  const cb = curveOf(entities, b);
  const ta = unit(ca.d1(closestParam(ca, p, 400)));
  const tb = unit(cb.d1(closestParam(cb, p, 400)));
  return Math.abs(cross(ta, tb));
}

/** Distance from point p to curve c and the parameter of the foot point. */
function project(c: ParamCurve, p: Vec2): { d: number; t: number } {
  const t = closestParam(c, p, 400);
  const q = c.at(t);
  return { d: Math.hypot(q[0] - p[0], q[1] - p[1]), t };
}

/**
 * Distance between two curves at their closest approach and |sin| of the tangent angle there:
 * the distance from A's points to B, minimised over A's parameter by golden-section search (the
 * distance is flat at a tangency, so alternating projections would crawl).
 */
export function contact(
  entities: readonly SketchEntity[],
  a: Id,
  b: Id,
  own = false,
): { gap: number; angle: number } {
  const ca = curveOf(entities, a, own);
  const cb = curveOf(entities, b, own);
  const f = (t: number) => project(cb, ca.at(t)).d;
  const n = 400;
  let bestI = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= n; i++) {
    const d = f(ca.t0 + ((ca.t1 - ca.t0) * i) / n);
    if (d < best) {
      best = d;
      bestI = i;
    }
  }
  const h = (ca.t1 - ca.t0) / n;
  let lo = ca.t0 + h * (bestI - 1);
  let hi = ca.t0 + h * (bestI + 1);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 80; it++) {
    const m1 = hi - g * (hi - lo);
    const m2 = lo + g * (hi - lo);
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  const ta = (lo + hi) / 2;
  const pb = project(cb, ca.at(ta));
  return {
    gap: pb.d,
    angle: Math.abs(cross(unit(ca.d1(ta)), unit(cb.d1(pb.t)))),
  };
}

/** Signed curvature of a curve at point p (CCW positive along its parameter). */
export function curvatureAt(entities: readonly SketchEntity[], id: Id, p: Vec2): Vec2 {
  const c = curveOf(entities, id);
  const t = closestParam(c, p, 400);
  const d1 = c.d1(t);
  const d2 = c.d2(t);
  const l2 = d1[0] * d1[0] + d1[1] * d1[1];
  const along = (d2[0] * d1[0] + d2[1] * d1[1]) / l2;
  return [(d2[0] - along * d1[0]) / l2, (d2[1] - along * d1[1]) / l2];
}
