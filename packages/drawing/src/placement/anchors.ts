/**
 * Annotation anchors (`AnnotationResolution.anchors`, part coordinates) → sheet geometry for one
 * solved view: measured points per `RefPoint`, projected circles, lines and planes seen edge-on.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { AnnotationAnchor, RefPoint, Vec2, Vec3 } from '@wren-cad/contracts';
import {
  add3,
  cross3,
  dist2,
  dot2,
  dot3,
  len3,
  lerp2,
  norm2,
  norm3,
  scale3,
  sub2,
} from '../annotation/geom';
import { partToSheet, type SolvedView } from '../view/solve';

/** Part-space points an anchor contributes for a measurement from `at`. */
export function anchorPoints(a: AnnotationAnchor, at: RefPoint = 'self'): Vec3[] {
  switch (a.kind) {
    case 'point':
      return [a.at];
    case 'line':
      if (at === 'start') return [a.a];
      if (at === 'end') return [a.b];
      if (at === 'mid') return [scale3(add3(a.a, a.b), 0.5)];
      return [a.a, a.b];
    case 'circle':
      if (at === 'start' && a.start) return [a.start];
      if (at === 'end' && a.end) return [a.end];
      return [a.center];
    case 'axis': {
      const p0 = add3(a.origin, scale3(a.direction, a.extent[0]));
      const p1 = add3(a.origin, scale3(a.direction, a.extent[1]));
      if (at === 'start') return [p0];
      if (at === 'end') return [p1];
      if (at === 'mid' || at === 'center') return [scale3(add3(p0, p1), 0.5)];
      return [p0, p1];
    }
    case 'plane':
      return a.outline.length > 0 ? a.outline : [a.origin];
    case 'curve':
      if (at === 'start') return a.points.slice(0, 1);
      if (at === 'end') return a.points.slice(-1);
      return a.points;
  }
}

/** Sheet points of an anchor in a view. */
export function sheetPoints(v: SolvedView, a: AnnotationAnchor, at?: RefPoint): Vec2[] {
  return anchorPoints(a, at).map((p) => partToSheet(v, p));
}

export type ProjectedCircle =
  | { kind: 'faceOn'; center: Vec2; radius: number }
  /** Seen side-on (a cylinder's circle seen edge-on): silhouettes at center ± radius · across. */
  | { kind: 'sideOn'; center: Vec2; radius: number; across: Vec2 }
  | { kind: 'oblique' };

/** How a circle anchor appears in a view (tolerance 1e-6 on the normal). */
export function projectCircle(
  v: SolvedView,
  a: Extract<AnnotationAnchor, { kind: 'circle' }>,
): ProjectedCircle {
  const n = norm3(a.normal);
  const c = dot3(n, v.frame.n);
  const center = partToSheet(v, a.center);
  const radius = a.radius * v.scale;
  if (Math.abs(Math.abs(c) - 1) < 1e-6) return { kind: 'faceOn', center, radius };
  if (Math.abs(c) < 1e-6) {
    const axis = norm2([dot3(n, v.frame.x), dot3(n, v.frame.y)]);
    return { kind: 'sideOn', center, radius, across: [-axis[1], axis[0]] };
  }
  return { kind: 'oblique' };
}

/** A projected straight segment of a line, axis, or a plane seen edge-on; null otherwise. */
export function projectedSegment(v: SolvedView, a: AnnotationAnchor): [Vec2, Vec2] | null {
  if (a.kind === 'line') return [partToSheet(v, a.a), partToSheet(v, a.b)];
  if (a.kind === 'axis') {
    const [p0, p1] = anchorPoints(a, 'self') as [Vec3, Vec3];
    return [partToSheet(v, p0), partToSheet(v, p1)];
  }
  if (a.kind === 'plane') {
    // Edge-on: the normal lies in the view plane.
    if (Math.abs(dot3(norm3(a.normal), v.frame.n)) > 1e-6) return null;
    return extremePair(a.outline.map((p) => partToSheet(v, p)));
  }
  return null;
}

/** The two points farthest apart (a projected edge-on outline is a segment). */
export function extremePair(pts: Vec2[]): [Vec2, Vec2] | null {
  if (pts.length === 0) return null;
  let best: [Vec2, Vec2] = [pts[0] as Vec2, pts[0] as Vec2];
  let d = -1;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const e = dist2(pts[i] as Vec2, pts[j] as Vec2);
      if (e > d) {
        d = e;
        best = [pts[i] as Vec2, pts[j] as Vec2];
      }
    }
  return best;
}

/** True when the anchor is a plane seen face-on (a leader then ends in a dot, ISO 128-3). */
export function isSurfaceFaceOn(v: SolvedView, a: AnnotationAnchor): boolean {
  return a.kind === 'plane' && Math.abs(Math.abs(dot3(norm3(a.normal), v.frame.n)) - 1) < 1e-6;
}

/** A point on an anchor for a leader, `t` ∈ [0, 1] along it (absent = auto). */
export function attachPoint(v: SolvedView, a: AnnotationAnchor, t?: number): Vec2 {
  switch (a.kind) {
    case 'point':
      return partToSheet(v, a.at);
    case 'circle': {
      const pc = projectCircle(v, a);
      if (pc.kind === 'faceOn') {
        const ang = 2 * Math.PI * (t ?? 0.125);
        return [pc.center[0] + pc.radius * Math.cos(ang), pc.center[1] + pc.radius * Math.sin(ang)];
      }
      if (pc.kind === 'sideOn') {
        const s = (t ?? 1) * 2 - 1;
        return [
          pc.center[0] + pc.across[0] * pc.radius * s,
          pc.center[1] + pc.across[1] * pc.radius * s,
        ];
      }
      return partToSheet(v, a.center);
    }
    case 'plane': {
      const seg = projectedSegment(v, a);
      if (seg) return lerp2(seg[0], seg[1], t ?? 0.5);
      const pts = a.outline.map((p) => partToSheet(v, p));
      if (pts.length === 0) return partToSheet(v, a.origin);
      const c = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as Vec2, [0, 0] as Vec2);
      return [c[0] / pts.length, c[1] / pts.length];
    }
    case 'line':
    case 'axis': {
      const seg = projectedSegment(v, a) as [Vec2, Vec2];
      return lerp2(seg[0], seg[1], t ?? 0.5);
    }
    case 'curve': {
      const pts = a.points.map((p) => partToSheet(v, p));
      if (pts.length < 2) return pts[0] ?? v.position;
      const lens = pts.slice(1).map((p, i) => dist2(pts[i] as Vec2, p));
      const total = lens.reduce((s, l) => s + l, 0);
      let target = total * (t ?? 0.5);
      for (let i = 0; i < lens.length; i++) {
        const l = lens[i] as number;
        if (target <= l || i === lens.length - 1)
          return lerp2(pts[i] as Vec2, pts[i + 1] as Vec2, l > 0 ? Math.min(1, target / l) : 0);
        target -= l;
      }
      return pts[0] as Vec2;
    }
  }
}

/** Direction of a 3D segment in the view, or null when it is seen end-on. */
export function viewDirection(v: SolvedView, d: Vec3): Vec2 | null {
  const p: Vec2 = [dot3(d, v.frame.x), dot3(d, v.frame.y)];
  const l = Math.hypot(p[0], p[1]);
  return l < 1e-6 * Math.max(1, len3(d)) ? null : [p[0] / l, p[1] / l];
}

/** The 3D direction of an anchor that has one (line, axis), for angles and natural separations. */
export function anchorDirection(a: AnnotationAnchor): Vec3 | null {
  if (a.kind === 'line') return norm3([a.b[0] - a.a[0], a.b[1] - a.a[1], a.b[2] - a.a[2]]);
  if (a.kind === 'axis') return norm3(a.direction);
  return null;
}

/** Normal of the plane two directions span (for angles), or null when parallel. */
export function spanNormal(a: Vec3, b: Vec3): Vec3 | null {
  const n = cross3(a, b);
  return len3(n) < 1e-9 ? null : norm3(n);
}

/** Signed coordinate of a point along a unit direction. */
export const along = (p: Vec2, u: Vec2): number => dot2(p, u);
export const minus = sub2;
