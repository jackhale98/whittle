/**
 * Screen-space pick math (pure; the engine supplies the projection). All distances are CSS px.
 */

import type { PickKind } from '@wren-cad/contracts';

/** Projects a world point to CSS px. Returns false when the point is behind the camera. */
export type ProjectFn = (x: number, y: number, z: number, out: { x: number; y: number }) => boolean;

export interface SegmentDistance {
  d: number;
  /** Parameter 0..1 of the closest point along the segment. */
  t: number;
}

export function distPointSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): SegmentDistance {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}

export interface PolylineHit {
  distancePx: number;
  /** Index of the closest segment (0 = points[first]..points[first+1]). */
  segment: number;
  t: number;
  /** World point on the polyline closest to the query in screen space. */
  point: [number, number, number];
}

/**
 * Closest approach of the projected polyline `points[first .. first+count)` (xyz triplets) to the
 * screen point (qx, qy). Single-point polylines are treated as points. Segments with an endpoint
 * behind the camera are skipped.
 */
export function closestOnPolyline(
  points: ArrayLike<number>,
  first: number,
  count: number,
  project: ProjectFn,
  qx: number,
  qy: number,
): PolylineHit | null {
  if (count < 1) return null;
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 0 };
  const px = (i: number) => points[3 * (first + i)] as number;
  const py = (i: number) => points[3 * (first + i) + 1] as number;
  const pz = (i: number) => points[3 * (first + i) + 2] as number;
  if (count === 1) {
    if (!project(px(0), py(0), pz(0), a)) return null;
    return {
      distancePx: Math.hypot(qx - a.x, qy - a.y),
      segment: 0,
      t: 0,
      point: [px(0), py(0), pz(0)],
    };
  }
  let best: PolylineHit | null = null;
  let prevOk = project(px(0), py(0), pz(0), a);
  for (let i = 1; i < count; i++) {
    const ok = project(px(i), py(i), pz(i), b);
    if (prevOk && ok) {
      const r = distPointSegment2D(qx, qy, a.x, a.y, b.x, b.y);
      if (!best || r.d < best.distancePx) {
        best = {
          distancePx: r.d,
          segment: i - 1,
          t: r.t,
          point: [
            px(i - 1) + (px(i) - px(i - 1)) * r.t,
            py(i - 1) + (py(i) - py(i - 1)) * r.t,
            pz(i - 1) + (pz(i) - pz(i - 1)) * r.t,
          ],
        };
      }
    }
    a.x = b.x;
    a.y = b.y;
    prevOk = ok;
  }
  return best;
}

/** Selection priority when several things lie within tolerance (lower wins). */
export const KIND_PRIORITY: Readonly<Record<PickKind, number>> = {
  handle: -1, // M2 drag handles sit above everything
  sketchPoint: 0,
  vertex: 1,
  sketchCurve: 2,
  edge: 3,
  region: 4,
  face: 5,
};

export interface Candidate {
  kind: PickKind;
  distancePx: number;
}

/** "Which one?" ordering: nearest first, ties broken by kind priority. */
export function sortByDistance<T extends Candidate>(list: T[]): T[] {
  return list.sort(
    (a, b) => a.distancePx - b.distancePx || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind],
  );
}

/**
 * The single best candidate: points/curves/edges within tolerance beat faces and regions (CAD
 * convention: thin things win over the surface behind them); among equal-priority kinds the
 * nearest wins.
 */
export function bestCandidate<T extends Candidate>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of list) {
    if (
      !best ||
      KIND_PRIORITY[c.kind] < KIND_PRIORITY[best.kind] ||
      (KIND_PRIORITY[c.kind] === KIND_PRIORITY[best.kind] && c.distancePx < best.distancePx)
    ) {
      best = c;
    }
  }
  return best;
}

/** Default pick tolerance (CSS px) by pointer type. */
export function defaultTolerance(pointerType: 'mouse' | 'pen' | 'touch'): number {
  return pointerType === 'touch' ? 22 : pointerType === 'pen' ? 10 : 6;
}

export interface TriangleHit {
  /** Distance along the ray. */
  t: number;
  /** Triangle ordinal. */
  tri: number;
  /** Barycentric coordinates: weight u on vertex b and v on vertex c (a gets 1 - u - v). */
  u: number;
  v: number;
}

/**
 * Brute-force ray vs indexed triangles `[firstTri, firstTri + triCount)` (Moller-Trumbore,
 * front faces only when `cullBack`). Used for single faces and small sketch-region meshes; whole
 * bodies go through the BVH.
 */
export function raycastTriangles(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  firstTri: number,
  triCount: number,
  cullBack: boolean,
): TriangleHit | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  let best: TriangleHit | null = null;
  for (let t = firstTri; t < firstTri + triCount; t++) {
    const ia = 3 * (indices[3 * t] as number);
    const ib = 3 * (indices[3 * t + 1] as number);
    const ic = 3 * (indices[3 * t + 2] as number);
    const ax = positions[ia] as number;
    const ay = positions[ia + 1] as number;
    const az = positions[ia + 2] as number;
    const e1x = (positions[ib] as number) - ax;
    const e1y = (positions[ib + 1] as number) - ay;
    const e1z = (positions[ib + 2] as number) - az;
    const e2x = (positions[ic] as number) - ax;
    const e2y = (positions[ic + 1] as number) - ay;
    const e2z = (positions[ic + 2] as number) - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (cullBack ? det <= 1e-12 : Math.abs(det) <= 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - ax;
    const sy = oy - ay;
    const sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist <= 0) continue;
    if (!best || dist < best.t) best = { t: dist, tri: t, u, v };
  }
  return best;
}
