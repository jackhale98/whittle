/**
 * Reference geometry for the regen engine (M3): frames of construction planes, axes and points,
 * and the TypeScript fallbacks that recover lines, circles and cylinder axes of model geometry
 * from the façade's fingerprints and exact measurements (no façade change needed).
 *
 * Conventions (deterministic, so cache keys and sketch placements don't jitter):
 *  - An axis is a `Line` with a unit `dir`; its frame (`lineFrame`) has origin = the foot of the
 *    perpendicular from the world origin, z = dir, x = `planeFrame`'s x for that normal.
 *  - Directions without an intrinsic sense (cylinder axes, circle normals) are canonical: the first
 *    component with |v| > 1e-9 is positive. A straight edge points from its endpoint with the
 *    smaller geometric key (x, then y, then z, 1e-6 mm) to the other.
 *  - A point's frame is { origin: p, z: +Z, x: +X }.
 *  - Frames are snapped to 1e-10 so float noise in exact measurements can't change a cache key.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Frame,
  Measurement,
  Result,
  ShapeFingerprints,
  ShapeHandle,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import type { MeasureSubject } from '../kernel-api';
import { add, cross, dist, dot, norm, normalize, planeFrame, scale, sub } from './geometry';

export interface Line {
  origin: Vec3;
  /** Unit direction. */
  dir: Vec3;
}

const SNAP = 1e-10;
const snap = (v: number): number => {
  const r = Math.round(v / SNAP) * SNAP;
  return r === 0 ? 0 : Number(r.toFixed(10));
};
const snapV = (v: Vec3): Vec3 => [snap(v[0]), snap(v[1]), snap(v[2])];

export function snapFrame(f: Frame): Frame {
  return { origin: snapV(f.origin), z: snapV(f.z), x: snapV(f.x) };
}

/** Geometric key order (x, then y, then z, rounded to 1e-6 mm). */
export function compareKey(a: Vec3, b: Vec3): number {
  for (let k = 0; k < 3; k++) {
    const d = Math.round((a[k] as number) * 1e6) - Math.round((b[k] as number) * 1e6);
    if (d !== 0) return d;
  }
  return 0;
}

/** `d` with its first significant component positive. */
export function canonicalDir(d: Vec3): Vec3 {
  const n = normalize(d);
  for (const v of n) {
    if (Math.abs(v) > 1e-9) return v < 0 ? scale(n, -1) : n;
  }
  return n;
}

export function footOnLine(l: Line, p: Vec3): Vec3 {
  return add(l.origin, scale(l.dir, dot(sub(p, l.origin), l.dir)));
}

export function distanceToLine(l: Line, p: Vec3): number {
  return dist(p, footOnLine(l, p));
}

export function lineFrame(l: Line): Frame {
  const z = normalize(l.dir);
  const origin = footOnLine({ origin: l.origin, dir: z }, [0, 0, 0]);
  return snapFrame({ origin, z, x: planeFrame([0, 0, 0], z).x });
}

export function frameLine(f: Frame): Line {
  return { origin: f.origin, dir: normalize(f.z) };
}

export function pointFrame(p: Vec3): Frame {
  return snapFrame({ origin: p, z: [0, 0, 1], x: [1, 0, 0] });
}

/** Reverses the normal and keeps x (so y flips too and the frame stays right-handed). */
export function flipFrame(f: Frame): Frame {
  return { origin: f.origin, z: scale(f.z, -1).map((v) => (v === 0 ? 0 : v)) as Vec3, x: f.x };
}

/** Rodrigues rotation of `v` about the unit `axis` by `angle` rad. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

type Geo<T> = T | { error: string };

/** Plane through three points; normal = (b − a) × (c − a). */
export function planeThroughPoints(a: Vec3, b: Vec3, c: Vec3): Geo<Frame> {
  const n = cross(sub(b, a), sub(c, a));
  const scaleLen = Math.max(norm(sub(b, a)), norm(sub(c, a)), 1e-9);
  if (norm(n) <= 1e-9 * scaleLen * scaleLen) {
    return { error: 'The three points lie on one line' };
  }
  return snapFrame(planeFrame(a, normalize(n)));
}

/**
 * Plane through `axis`, at `angle` from `from` (rotated about the axis, right-handed). The axis
 * must be parallel to the reference plane.
 */
export function anglePlane(from: Frame, axis: Line, angle: number): Geo<Frame> {
  const n = normalize(from.z);
  if (Math.abs(dot(n, axis.dir)) > 1e-9) {
    return { error: 'The axis must be parallel to the reference plane' };
  }
  return snapFrame(planeFrame(axis.origin, rotateAbout(n, axis.dir, angle)));
}

/** Midway between two parallel planes; normal of `a`. */
export function midPlane(a: Frame, b: Frame): Geo<Frame> {
  const n = normalize(a.z);
  if (Math.abs(Math.abs(dot(n, normalize(b.z))) - 1) > 1e-9) {
    return { error: 'The two planes are not parallel' };
  }
  const d = (dot(a.origin, n) + dot(b.origin, n)) / 2;
  return snapFrame(planeFrame(scale(n, d), n));
}

export function planeThroughPoint(from: Frame, p: Vec3): Frame {
  return snapFrame(planeFrame(p, normalize(from.z)));
}

export function normalPlane(p: Vec3, tangent: Vec3): Frame {
  return snapFrame(planeFrame(p, normalize(tangent)));
}

/** Line where two planes meet (dir = na × nb, origin nearest the world origin). */
export function planesIntersection(a: Frame, b: Frame): Geo<Line> {
  const na = normalize(a.z);
  const nb = normalize(b.z);
  const d = cross(na, nb);
  if (norm(d) <= 1e-9) return { error: 'The two planes are parallel' };
  const da = dot(na, a.origin);
  const db = dot(nb, b.origin);
  // Point on both planes nearest the origin: p = (da (nb × d) + db (d × na)) / |d|².
  const p = scale(add(scale(cross(nb, d), da), scale(cross(d, na), db)), 1 / dot(d, d));
  return { origin: p, dir: normalize(d) };
}

export function linePlaneIntersection(l: Line, f: Frame): Geo<Vec3> {
  const n = normalize(f.z);
  const den = dot(n, l.dir);
  if (Math.abs(den) <= 1e-9) return { error: 'The line is parallel to the plane' };
  const t = dot(n, sub(f.origin, l.origin)) / den;
  return add(l.origin, scale(l.dir, t));
}

/** Where two lines meet (within `tol`), else an error. */
export function lineLineIntersection(a: Line, b: Line, tol: number): Geo<Vec3> {
  const w = sub(a.origin, b.origin);
  const aa = dot(a.dir, a.dir);
  const bb = dot(b.dir, b.dir);
  const ab = dot(a.dir, b.dir);
  const den = aa * bb - ab * ab;
  if (Math.abs(den) <= 1e-12) return { error: 'The two lines are parallel' };
  const s = (ab * dot(b.dir, w) - bb * dot(a.dir, w)) / den;
  const t = (aa * dot(b.dir, w) - ab * dot(a.dir, w)) / den;
  const pa = add(a.origin, scale(a.dir, s));
  const pb = add(b.origin, scale(b.dir, t));
  if (dist(pa, pb) > tol) return { error: 'The two lines do not meet' };
  return scale(add(pa, pb), 0.5);
}

/** World point → the frame's local (u, v). */
export function toLocal(f: Frame, p: Vec3): Vec2 {
  const d = sub(p, f.origin);
  const y = cross(f.z, f.x);
  return [dot(d, normalize(f.x)), dot(d, normalize(y))];
}

/** Signed distance of `p` above the frame's plane. */
export function heightAbove(f: Frame, p: Vec3): number {
  return dot(sub(p, f.origin), normalize(f.z));
}

export function isGeoError<T>(g: Geo<T>): g is { error: string } {
  return typeof g === 'object' && g !== null && 'error' in g;
}

// ---------------------------------------------------------------------------------------------
// Model geometry from fingerprints + exact measurement (façade fallback)
// ---------------------------------------------------------------------------------------------

/** The two façade calls the probes need (the engine passes cached versions). */
export interface GeoQuery {
  fingerprints(shape: ShapeHandle): Promise<ShapeFingerprints | null>;
  measure(a: MeasureSubject, b?: MeasureSubject): Promise<Result<Measurement>>;
}

/** The 26 directions of {−1, 0, 1}³ \ 0, normalised, in a fixed order. */
const PROBES: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1]) if (x || y || z) out.push(normalize([x, y, z]));
  return out;
})();

/** Closest points on a sub-shape from far probes around `c` (exact, from BRepExtrema). */
async function probe(
  q: GeoQuery,
  subject: MeasureSubject,
  c: Vec3,
  reach: number,
): Promise<{ q: Vec3; s: Vec3 }[]> {
  const out: { q: Vec3; s: Vec3 }[] = [];
  for (const d of PROBES) {
    const p = add(c, scale(d, reach));
    const m = await q.measure(subject, { point: p });
    if (m.ok && m.value.distance) out.push({ q: p, s: m.value.distance.a });
  }
  return out;
}

/** End points of a straight edge, ordered by geometric key; null for other curves. */
export async function edgeLine(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
): Promise<{ a: Vec3; b: Vec3 } | null> {
  const fp = await q.fingerprints(shape);
  const e = fp?.edges[index];
  if (e?.curve !== 'line' || !(e.length > 0)) return null;
  const pts = await probe(q, { shape, kind: 'edge', index }, e.centroid, 4 * e.length + 1);
  let best: [Vec3, Vec3] | null = null;
  let bestD = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = dist((pts[i] as { s: Vec3 }).s, (pts[j] as { s: Vec3 }).s);
      if (d > bestD) {
        bestD = d;
        best = [(pts[i] as { s: Vec3 }).s, (pts[j] as { s: Vec3 }).s];
      }
    }
  }
  if (!best || Math.abs(bestD - e.length) > 1e-6 * Math.max(1, e.length)) return null;
  const [a, b] = compareKey(best[0], best[1]) <= 0 ? best : [best[1], best[0]];
  return { a, b };
}

export async function edgeLineOf(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
): Promise<Line | null> {
  const l = await edgeLine(q, shape, index);
  return l ? { origin: l.a, dir: normalize(sub(l.b, l.a)) } : null;
}

/** Circumcentre of a 3D triangle. */
export function circumcentre(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn <= 1e-24) return null;
  const t = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  return add(a, scale(t, 1 / (2 * nn)));
}

export interface Circle {
  centre: Vec3;
  /** Canonical unit normal of the circle's plane. */
  normal: Vec3;
  radius: number;
  /** A full circle (closed edge) rather than an arc. */
  full: boolean;
}

/** Centre, normal and radius of a circular edge (full circle or arc); null for other curves. */
export async function edgeCircle(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
): Promise<Circle | null> {
  const fp = await q.fingerprints(shape);
  const e = fp?.edges[index];
  if (e?.curve !== 'circle') return null;
  const one = await q.measure({ shape, kind: 'edge', index });
  const r = one.ok ? one.value.radius : undefined;
  if (r === undefined || !(r > 0)) return null;
  const pts = (await probe(q, { shape, kind: 'edge', index }, e.centroid, 10 * (r + 1))).map(
    (p) => p.s,
  );
  // The best-conditioned triangle of probe points.
  let tri: [Vec3, Vec3, Vec3] | null = null;
  let area = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let k = j + 1; k < pts.length; k++) {
        const a = pts[i] as Vec3;
        const b = pts[j] as Vec3;
        const c = pts[k] as Vec3;
        const s = norm(cross(sub(b, a), sub(c, a)));
        if (s > area) {
          area = s;
          tri = [a, b, c];
        }
      }
  if (!tri) return null;
  const centre = circumcentre(...tri);
  if (!centre) return null;
  const tol = 1e-6 * (1 + r);
  if (pts.some((p) => Math.abs(dist(p, centre) - r) > tol)) return null;
  const normal = canonicalDir(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
  const full = Math.abs(e.length - 2 * Math.PI * r) <= 1e-6 * (1 + e.length);
  return { centre, normal, radius: r, full };
}

/** Axis of a cylindrical face; null for other surfaces or when the probes can't find it. */
export async function faceAxis(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
): Promise<(Line & { radius: number }) | null> {
  const fp = await q.fingerprints(shape);
  const f = fp?.faces[index];
  if (f?.surface !== 'cylinder') return null;
  const one = await q.measure({ shape, kind: 'face', index });
  const r = one.ok ? one.value.radius : undefined;
  if (r === undefined || !(r > 0)) return null;
  const size = Math.sqrt(Math.max(f.area, 0));
  const pts = await probe(q, { shape, kind: 'face', index }, f.centroid, 10 * (size + r + 1));
  // Where a closest point is interior, q − s is the surface normal: the axis is at s − r·u and
  // perpendicular to every such u. Boundary points give wrong candidates, which the check rejects.
  const cands = pts
    .filter((p) => dist(p.q, p.s) > 1e-9)
    .map((p) => {
      const u = normalize(sub(p.q, p.s));
      return { u, a: sub(p.s, scale(u, r)) };
    });
  const tol = 1e-6 * (1 + r + size);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const ci = cands[i] as { u: Vec3; a: Vec3 };
      const cj = cands[j] as { u: Vec3; a: Vec3 };
      const d = cross(ci.u, cj.u);
      if (norm(d) < 0.1) continue;
      const line: Line = { origin: ci.a, dir: canonicalDir(d) };
      if (distanceToLine(line, cj.a) > tol) continue;
      if (pts.some((p) => Math.abs(distanceToLine(line, p.s) - r) > tol)) continue;
      return { origin: footOnLine(line, [0, 0, 0]), dir: line.dir, radius: r };
    }
  }
  return null;
}

/** Centre of a spherical face; null for other surfaces. */
export async function sphereCentre(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
): Promise<Vec3 | null> {
  const fp = await q.fingerprints(shape);
  const f = fp?.faces[index];
  if (f?.surface !== 'sphere') return null;
  const one = await q.measure({ shape, kind: 'face', index });
  const r = one.ok ? one.value.radius : undefined;
  if (r === undefined || !(r > 0)) return null;
  const pts = await probe(q, { shape, kind: 'face', index }, f.centroid, 10 * (r + 1));
  const tol = 1e-6 * (1 + r);
  for (const p of pts) {
    if (dist(p.q, p.s) <= 1e-9) continue;
    const c = sub(p.s, scale(normalize(sub(p.q, p.s)), r));
    if (pts.every((x) => Math.abs(dist(x.s, c) - r) <= tol)) return c;
  }
  return null;
}

/** The vertices of `shape` that bound edge `index` (0, 1 or 2 points), by exact distance. */
export async function edgeEndpoints(
  q: GeoQuery,
  shape: ShapeHandle,
  index: number,
  tol: number,
): Promise<Vec3[]> {
  const fp = await q.fingerprints(shape);
  const e = fp?.edges[index];
  if (!fp || !e) return [];
  const out: Vec3[] = [];
  for (let v = 0; v < fp.vertices.length; v++) {
    const p = (fp.vertices[v] as { point: Vec3 }).point;
    if (dist(p, e.centroid) > e.length + tol) continue;
    const m = await q.measure({ shape, kind: 'edge', index }, { shape, kind: 'vertex', index: v });
    if (m.ok && m.value.distance && m.value.distance.value <= tol) out.push(p);
  }
  return out.sort(compareKey);
}
