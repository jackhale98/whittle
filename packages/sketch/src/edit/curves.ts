/**
 * Plain curve geometry for the sketch-editing operations: lines (segments with an infinite
 * carrier), circles and CCW arcs, their intersections and parameters. Pure, no Wasm.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2 } from '@wren-cad/contracts';
import {
  add,
  angle0,
  anglePi,
  cross,
  dist,
  dot,
  fromAngle,
  len,
  scale,
  sub,
  TAU,
} from '../geometry';

export type Curve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  /** CCW from angle `a0` through `sweep` (0, 2π]. */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number };

export const arcStart = (k: Extract<Curve, { kind: 'arc' }>): Vec2 =>
  add(k.c, fromAngle(k.a0, k.r));
export const arcEnd = (k: Extract<Curve, { kind: 'arc' }>): Vec2 =>
  add(k.c, fromAngle(k.a0 + k.sweep, k.r));

/** Intersections of the curves' carriers (infinite lines, full circles). */
export function carrierIntersections(p: Curve, q: Curve): Vec2[] {
  if (p.kind === 'line' && q.kind === 'line') {
    const r = lineLine(p.a, p.b, q.a, q.b);
    return r ? [r] : [];
  }
  if (p.kind === 'line') return lineCircle(p.a, p.b, (q as { c: Vec2 }).c, (q as { r: number }).r);
  if (q.kind === 'line') return lineCircle(q.a, q.b, p.c, p.r);
  return circleCircle(p.c, p.r, q.c, q.r);
}

/** Intersection of the infinite lines ab and cd, or null when (nearly) parallel. */
export function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12 * len(r) * len(s) || len(r) === 0 || len(s) === 0) return null;
  const t = cross(sub(c, a), s) / den;
  return add(a, scale(r, t));
}

export function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2[] {
  const d = sub(b, a);
  const l = len(d);
  if (l === 0) return [];
  const u = scale(d, 1 / l);
  const t0 = dot(sub(c, a), u);
  const foot = add(a, scale(u, t0));
  const h = dist(foot, c);
  const tol = 1e-9 * Math.max(1, r);
  if (h > r + tol) return [];
  if (h > r - tol) return [foot];
  const k = Math.sqrt(r * r - h * h);
  return [add(foot, scale(u, -k)), add(foot, scale(u, k))];
}

export function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  const tol = 1e-9 * Math.max(1, r1, r2);
  if (d < tol) return [];
  if (d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const u = scale(sub(c2, c1), 1 / d);
  const m = add(c1, scale(u, a));
  if (h2 <= tol * tol) return [m];
  const h = Math.sqrt(h2);
  const n: Vec2 = [-u[1], u[0]];
  return [add(m, scale(n, h)), add(m, scale(n, -h))];
}

/**
 * Parameter of a point (assumed on the carrier): lines t along a→b (0 at a, 1 at b); arcs the
 * CCW angle from the start, in [0, 2π); circles the angle in [0, 2π).
 */
export function paramOf(k: Curve, p: Vec2): number {
  if (k.kind === 'line') {
    const d = sub(k.b, k.a);
    const l2 = dot(d, d);
    return l2 === 0 ? 0 : dot(sub(p, k.a), d) / l2;
  }
  const t = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  return k.kind === 'arc' ? angle0(t - k.a0) : angle0(t);
}

/** Parameter range of the curve's own extent ([0, 1], [0, sweep] or [0, 2π)). */
export function paramRange(k: Curve): number {
  return k.kind === 'line' ? 1 : k.kind === 'arc' ? k.sweep : TAU;
}

/** Point at a parameter. */
export function pointAt(k: Curve, t: number): Vec2 {
  if (k.kind === 'line') return add(k.a, scale(sub(k.b, k.a), t));
  return add(k.c, fromAngle((k.kind === 'arc' ? k.a0 : 0) + t, k.r));
}

/** Parameter tolerance equivalent to `tol` mm on the curve. */
export function paramTol(k: Curve, tol: number): number {
  if (k.kind === 'line') return tol / Math.max(dist(k.a, k.b), 1e-12);
  return tol / Math.max(k.r, 1e-12);
}

/** Whether a carrier point lies on the curve's own extent (within `tol` mm). */
export function onExtent(k: Curve, p: Vec2, tol: number): boolean {
  if (k.kind === 'circle') return true;
  const t = paramOf(k, p);
  const e = paramTol(k, tol);
  if (k.kind === 'line') return t >= -e && t <= 1 + e;
  return t <= k.sweep + e || t >= TAU - e;
}

/** Intersections of the curves' own extents (segments, arcs, circles). */
export function extentIntersections(p: Curve, q: Curve, tol: number): Vec2[] {
  return carrierIntersections(p, q).filter((x) => onExtent(p, x, tol) && onExtent(q, x, tol));
}

/** Unit tangent at a parameter, in the curve's own direction (CCW for arcs and circles). */
export function tangentAt(k: Curve, t: number): Vec2 {
  if (k.kind === 'line') {
    const d = sub(k.b, k.a);
    const l = len(d);
    return l === 0 ? [1, 0] : scale(d, 1 / l);
  }
  const a = (k.kind === 'arc' ? k.a0 : 0) + t;
  return [-Math.sin(a), Math.cos(a)];
}

/** Distance from a point to the curve's own extent. */
export function distanceTo(k: Curve, p: Vec2): number {
  if (k.kind === 'line') {
    const t = Math.min(1, Math.max(0, paramOf(k, p)));
    return dist(p, pointAt(k, t));
  }
  if (k.kind === 'circle') return Math.abs(dist(p, k.c) - k.r);
  const t = paramOf(k, p);
  if (t <= k.sweep) return Math.abs(dist(p, k.c) - k.r);
  return Math.min(dist(p, arcStart(k)), dist(p, arcEnd(k)));
}

/** Signed angle (−π, π] turning from direction a to direction b. */
export function turnAngle(a: Vec2, b: Vec2): number {
  return anglePi(Math.atan2(cross(a, b), dot(a, b)));
}

/** Arc through CCW from `start` to `end` around `c` (radius from `start`). */
export function arcFromPoints(c: Vec2, start: Vec2, end: Vec2): Extract<Curve, { kind: 'arc' }> {
  const a0 = angle0(Math.atan2(start[1] - c[1], start[0] - c[0]));
  const a1 = angle0(Math.atan2(end[1] - c[1], end[0] - c[0]));
  let sweep = angle0(a1 - a0);
  if (sweep < 1e-12) sweep = TAU;
  return { kind: 'arc', c, r: dist(c, start), a0, sweep };
}
