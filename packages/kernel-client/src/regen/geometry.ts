/**
 * Small, dependency-free geometry helpers for the regen engine: vectors, placement frames
 * (origin planes, sketch-on-face frames), bounding boxes and sketch-curve sampling.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Frame, SketchEntity, Vec2, Vec3 } from '@wren-cad/contracts';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** Zeroes components below 1e-12 and renormalises, so frames don't jitter with float noise. */
export function clean(a: Vec3): Vec3 {
  const c: Vec3 = [
    Math.abs(a[0]) < 1e-12 ? 0 : a[0],
    Math.abs(a[1]) < 1e-12 ? 0 : a[1],
    Math.abs(a[2]) < 1e-12 ? 0 : a[2],
  ];
  return normalize(c).map((v) => (v === 0 ? 0 : v)) as Vec3; // no -0
}

/** Reserved origin planes (naming.ts). Right-handed, Y = Z × X; XZ and YZ have v pointing up (+Z). */
export const ORIGIN_PLANES: Record<string, Frame> = {
  'origin:XY': { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
  'origin:XZ': { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] },
  'origin:YZ': { origin: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] },
};

/** Reserved origin axes as frames (z = axis direction), for revolve `frames.axis`. */
export const ORIGIN_AXES: Record<string, Frame> = {
  'origin:X': { origin: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] },
  'origin:Y': { origin: [0, 0, 0], z: [0, 1, 0], x: [0, 0, 1] },
  'origin:Z': { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
};

/** Within this of ±Z (|n·Z| > cos 0.81°) a face counts as horizontal for its X axis choice. */
const HORIZONTAL = 0.9999;

/**
 * Deterministic frame of a plane given by a point on it and its (outward) normal. Depends only on
 * the plane, never on the face's extent or OCCT parametrisation, so a sketch on a face neither
 * moves within the plane nor spins when upstream edits resize or split that face:
 *  - origin = the world origin projected onto the plane;
 *  - x = normalize(Z × n) for non-horizontal planes (so the sketch's v axis points up, matching
 *    `origin:XZ`/`origin:YZ`), else world X projected into the plane (matching `origin:XY`).
 */
export function planeFrame(point: Vec3, normal: Vec3): Frame {
  const z = clean(normal);
  const d = dot(point, z);
  const origin = scale(z, d).map((v) => (Math.abs(v) < 1e-12 ? 0 : v)) as Vec3;
  let x: Vec3;
  if (Math.abs(z[2]) > HORIZONTAL) {
    x = clean(sub([1, 0, 0], scale(z, z[0])));
  } else {
    x = clean(cross([0, 0, 1], z));
  }
  return { origin, z, x };
}

export function frameY(f: Frame): Vec3 {
  return cross(f.z, f.x);
}

/** Local sketch (u, v) → world. */
export function toWorld(f: Frame, u: number, v: number): Vec3 {
  const y = frameY(f);
  return [
    f.origin[0] + f.x[0] * u + y[0] * v,
    f.origin[1] + f.x[1] * u + y[1] * v,
    f.origin[2] + f.x[2] * u + y[2] * v,
  ];
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export const emptyBox = (): Box3 => ({
  min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
});

export function extendBox(b: Box3, p: Vec3): void {
  for (let i = 0; i < 3; i++) {
    const v = p[i] as number;
    if (v < (b.min[i] as number)) b.min[i] = v;
    if (v > (b.max[i] as number)) b.max[i] = v;
  }
}

export function boxDiagonal(b: Box3): number {
  if (!(b.max[0] >= b.min[0])) return 0;
  return dist(b.max, b.min);
}

/** Axis-aligned boxes overlap (or touch) within `tol`. */
export function boxesOverlap(a: Box3, b: Box3, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a.min[i] as number) > (b.max[i] as number) + tol) return false;
    if ((b.min[i] as number) > (a.max[i] as number) + tol) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Sketch curve sampling (display polylines; the kernel builds the exact B-rep separately)
// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;

function segments(r: number, sweep: number, chord: number): number {
  const step = r <= chord ? sweep : 2 * Math.acos(Math.max(-1, 1 - chord / r));
  const n = Math.ceil(sweep / Math.max(step, 1e-6));
  return Math.min(512, Math.max(Math.ceil((8 * sweep) / TAU), n, 1));
}

/** Samples one sketch entity in its local (u, v) frame. Points yield one sample. */
export function sampleEntity(
  e: SketchEntity,
  points: ReadonlyMap<string, Vec2>,
  chord: number,
): Vec2[] {
  const p = (id: string): Vec2 => points.get(id) ?? [0, 0];
  switch (e.kind) {
    case 'point':
      return [[e.x, e.y]];
    case 'line':
      return [p(e.start), p(e.end)];
    case 'circle': {
      const c = p(e.center);
      const n = segments(e.radius, TAU, chord);
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (TAU * i) / n;
        out.push([c[0] + e.radius * Math.cos(t), c[1] + e.radius * Math.sin(t)]);
      }
      return out;
    }
    case 'arc': {
      const c = p(e.center);
      const s = p(e.start);
      const t = p(e.end);
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      let sweep = Math.atan2(t[1] - c[1], t[0] - c[0]) - a0;
      while (sweep <= 0) sweep += TAU;
      const n = segments(r, sweep, chord);
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      }
      return out;
    }
    case 'ellipse': {
      const c = p(e.center);
      const n = segments(Math.max(e.majorRadius, e.minorRadius), TAU, chord);
      const cr = Math.cos(e.rotation);
      const sr = Math.sin(e.rotation);
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (TAU * i) / n;
        const u = e.majorRadius * Math.cos(t);
        const v = e.minorRadius * Math.sin(t);
        out.push([c[0] + u * cr - v * sr, c[1] + u * sr + v * cr]);
      }
      return out;
    }
    case 'ellipticArc':
      // M3.5 placeholder (ADR-046): the modeling workstream samples the exact curve.
      return [p(e.start), p(e.end)];
    case 'bspline':
      return e.poles.map(p); // M3.5 placeholder: control polygon until exact sampling lands.
  }
}

/**
 * Push/pull (ADR-013 addendum): items grouped by outward normal — equal within `tol` per component
 * after normalising — with the groups sorted by normal (x, then y, then z, ascending) so the
 * sequence of per-group steps is deterministic. Items keep their input order inside a group.
 * Returns null when an item has no normal (a curved face: the kernel reports it).
 */
export function groupByNormal<T extends { normal?: Vec3 | undefined }>(
  items: readonly T[],
  tol = 1e-6,
): Array<{ normal: Vec3; items: T[] }> | null {
  const groups: Array<{ normal: Vec3; items: T[] }> = [];
  for (const it of items) {
    if (!it.normal) return null;
    const n = normalize(it.normal);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return null;
    const g = groups.find((x) => x.normal.every((v, k) => Math.abs(v - (n[k] as number)) <= tol));
    if (g) g.items.push(it);
    else groups.push({ normal: n, items: [it] });
  }
  return groups.sort((a, b) => {
    for (let k = 0; k < 3; k++) {
      const d = (a.normal[k] as number) - (b.normal[k] as number);
      if (Math.abs(d) > tol) return d;
    }
    return 0;
  });
}
