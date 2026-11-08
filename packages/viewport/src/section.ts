/** Section-plane maths (pure): clipping tests for picking and the plane in three.js form. */

import type { SectionPlane, Vec3 } from '@whittle/contracts';

/** Normalised section: geometry with `n·p > offset` (the +normal side) is clipped away. */
export interface SectionEq {
  n: Vec3;
  offset: number;
}

export function sectionEq(s: SectionPlane): SectionEq | null {
  const len = Math.hypot(s.normal[0], s.normal[1], s.normal[2]);
  if (len < 1e-12) return null;
  const n: Vec3 = [s.normal[0] / len, s.normal[1] / len, s.normal[2] / len];
  return { n, offset: n[0] * s.origin[0] + n[1] * s.origin[1] + n[2] * s.origin[2] };
}

/** Signed distance to the plane; positive = clipped side. */
export function sectionDistance(eq: SectionEq, p: Vec3): number {
  return eq.n[0] * p[0] + eq.n[1] * p[1] + eq.n[2] * p[2] - eq.offset;
}

export function isClipped(eq: SectionEq | null, p: Vec3, eps = 0): boolean {
  return eq !== null && sectionDistance(eq, p) > eps;
}

/**
 * The part of the ray `origin + t·dir` (t in [0, maxT]) that survives the section, as [near, far],
 * or null when none of it does. Picking restricts BVH ray casts to this range.
 */
export function keptRayRange(
  eq: SectionEq | null,
  origin: Vec3,
  dir: Vec3,
  maxT = Number.POSITIVE_INFINITY,
): [number, number] | null {
  if (!eq) return [0, maxT];
  const s0 = sectionDistance(eq, origin);
  const ds = eq.n[0] * dir[0] + eq.n[1] * dir[1] + eq.n[2] * dir[2];
  if (Math.abs(ds) < 1e-12) return s0 <= 0 ? [0, maxT] : null;
  const t = -s0 / ds; // s(t) = s0 + t·ds = 0
  if (ds > 0) {
    // distance grows along the ray: kept while s <= 0, i.e. t <= tc
    return t < 0 ? null : [0, Math.min(t, maxT)];
  }
  // distance shrinks: kept for t >= tc
  if (t > maxT) return null;
  return [Math.max(t, 0), maxT];
}

/** The plane as three.js `Plane` parameters: points with negative signed distance are clipped. */
export function threePlane(eq: SectionEq): { normal: Vec3; constant: number } {
  return { normal: [-eq.n[0], -eq.n[1], -eq.n[2]], constant: eq.offset };
}
