/**
 * Curve flattening within a chord tolerance (sheet mm): arcs, ellipses and (rational) B-splines
 * to polylines. Used by the R12 DXF profile, hatching and anything without exact curves.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2 } from '@wren-cad/contracts';
import type { Primitive } from './display';

/** Segments for an arc of `radius` spanning `sweep` with chord error ≤ `tol`. */
export function arcSegments(radius: number, sweep: number, tol: number): number {
  if (radius <= tol) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  return Math.max(1, Math.min(4096, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-6))));
}

export function flattenArc(
  center: Vec2,
  radius: number,
  start: number,
  end: number,
  tol: number,
): Vec2[] {
  const n = arcSegments(radius, end - start, tol);
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = start + ((end - start) * i) / n;
    pts.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return pts;
}

export function flattenEllipse(
  center: Vec2,
  major: Vec2,
  ratio: number,
  start: number,
  end: number,
  tol: number,
): Vec2[] {
  const a = Math.hypot(major[0], major[1]);
  const ux: Vec2 = [major[0] / a, major[1] / a];
  const uy: Vec2 = [-ux[1], ux[0]];
  const b = a * ratio;
  const n = arcSegments(a, end - start, tol);
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + ((end - start) * i) / n;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    pts.push([center[0] + ux[0] * x + uy[0] * y, center[1] + ux[1] * x + uy[1] * y]);
  }
  return pts;
}

/** de Boor evaluation of a (rational) B-spline at `u`. */
export function evalBSpline(
  degree: number,
  poles: readonly Vec2[],
  knots: readonly number[],
  u: number,
  weights?: readonly number[],
): Vec2 {
  const n = poles.length - 1;
  let k = degree;
  while (k < n && u >= (knots[k + 1] ?? 0)) k++;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= degree; j++) {
    const i = k - degree + j;
    const w = weights?.[i] ?? 1;
    const p = poles[i] ?? [0, 0];
    d.push([p[0] * w, p[1] * w, w]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const lo = knots[i] ?? 0;
      const hi = knots[i + degree - r + 1] ?? 1;
      const alpha = hi - lo === 0 ? 0 : (u - lo) / (hi - lo);
      const a = d[j - 1] as [number, number, number];
      const b = d[j] as [number, number, number];
      d[j] = [
        (1 - alpha) * a[0] + alpha * b[0],
        (1 - alpha) * a[1] + alpha * b[1],
        (1 - alpha) * a[2] + alpha * b[2],
      ];
    }
  }
  const r = d[degree] as [number, number, number];
  return [r[0] / r[2], r[1] / r[2]];
}

/** Samples a B-spline densely enough for `tol` (adaptive by control polygon length). */
export function flattenBSpline(
  degree: number,
  poles: readonly Vec2[],
  knots: readonly number[],
  tol: number,
  weights?: readonly number[],
): Vec2[] {
  const u0 = knots[degree] ?? 0;
  const u1 = knots[knots.length - degree - 1] ?? 1;
  let poly = 0;
  for (let i = 1; i < poles.length; i++) {
    const a = poles[i - 1] as Vec2;
    const b = poles[i] as Vec2;
    poly += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const n = Math.max(
    8 * (poles.length - 1),
    Math.min(4096, Math.ceil(Math.sqrt(poly / Math.max(tol, 1e-6)) * 4)),
  );
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i === n ? u1 - 1e-12 * Math.max(1, Math.abs(u1)) : u0 + ((u1 - u0) * i) / n;
    pts.push(evalBSpline(degree, poles, knots, u, weights));
  }
  pts[n] = evalBSpline(degree, poles, knots, u1 - 1e-12, weights);
  return pts;
}

/** A primitive's outline as a polyline (fills give their first loop); text gives nothing. */
export function flattenPrimitive(p: Primitive, tol: number): Vec2[][] {
  switch (p.kind) {
    case 'line':
      return [[p.a, p.b]];
    case 'polyline':
      return [p.closed && p.points.length > 0 ? [...p.points, p.points[0] as Vec2] : p.points];
    case 'arc':
      return [flattenArc(p.center, p.radius, p.start, p.end, tol)];
    case 'ellipse':
      return [flattenEllipse(p.center, p.major, p.ratio, p.start, p.end, tol)];
    case 'spline':
      return [flattenBSpline(p.degree, p.poles, p.knots, tol, p.weights)];
    case 'fill':
      return p.loops.map((l) => (l.length > 0 ? [...l, l[0] as Vec2] : l));
    case 'text':
      return [];
  }
}
