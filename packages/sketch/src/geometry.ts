/**
 * Pure 2D geometry helpers for sketches (mm / rad, sketch-local frame): vector math, entity
 * lookup, curve sampling for overlays and the kernel, closest points and circle constructions.
 * No Wasm, safe on the main thread.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Id,
  SketchArc,
  SketchCircle,
  SketchEntity,
  SketchLine,
  Vec2,
} from '@whittle/contracts';

export const TAU = Math.PI * 2;

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
/** Counter-clockwise perpendicular. */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const fromAngle = (angle: number, r = 1): Vec2 => [Math.cos(angle) * r, Math.sin(angle) * r];

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}

/** Angle normalised to [0, 2π). */
export function angle0(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Angle normalised to (-π, π]. */
export function anglePi(a: number): number {
  let r = angle0(a);
  if (r > Math.PI) r -= TAU;
  return r;
}

/** CCW angle from direction `a` to direction `b`, in [0, 2π). */
export function ccwAngle(a: Vec2, b: Vec2): number {
  return angle0(Math.atan2(cross(a, b), dot(a, b)));
}

// ---------------------------------------------------------------------------------------------
// Entity access
// ---------------------------------------------------------------------------------------------

export type EntityIndex = ReadonlyMap<Id, SketchEntity>;

export function indexEntities(entities: readonly SketchEntity[]): Map<Id, SketchEntity> {
  const map = new Map<Id, SketchEntity>();
  for (const e of entities) map.set(e.id, e);
  return map;
}

export function pointPos(index: EntityIndex, id: Id): Vec2 {
  const p = index.get(id);
  if (p?.kind !== 'point') throw new Error(`Entity ${id} is not a point`);
  return [p.x, p.y];
}

export interface LineGeom {
  a: Vec2;
  b: Vec2;
}
export interface CircleGeom {
  c: Vec2;
  r: number;
}
export interface ArcGeom extends CircleGeom {
  start: Vec2;
  end: Vec2;
  /** Start angle in [0, 2π) and CCW sweep in (0, 2π]. */
  a0: number;
  sweep: number;
}

export function lineGeom(index: EntityIndex, l: SketchLine): LineGeom {
  return { a: pointPos(index, l.start), b: pointPos(index, l.end) };
}

export function circleGeom(index: EntityIndex, c: SketchCircle): CircleGeom {
  return { c: pointPos(index, c.center), r: c.radius };
}

export function arcGeom(index: EntityIndex, a: SketchArc): ArcGeom {
  const c = pointPos(index, a.center);
  const start = pointPos(index, a.start);
  const end = pointPos(index, a.end);
  const a0 = angle0(Math.atan2(start[1] - c[1], start[0] - c[0]));
  const a1 = angle0(Math.atan2(end[1] - c[1], end[0] - c[0]));
  let sweep = angle0(a1 - a0);
  if (sweep < 1e-12) sweep = TAU;
  return { c, r: dist(c, start), start, end, a0, sweep };
}

/** Whether angle `t` lies within the CCW sweep of an arc (with angular slack `eps`). */
export function angleInArc(arc: ArcGeom, t: number, eps = 0): boolean {
  const d = angle0(t - arc.a0);
  return d <= arc.sweep + eps || d >= TAU - eps;
}

/** The centre point id of a circle/arc/ellipse, or the id itself for a point. */
export function centerOf(e: SketchEntity): Id | null {
  switch (e.kind) {
    case 'point':
      return e.id;
    case 'circle':
    case 'arc':
    case 'ellipse':
      return e.center;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Sampling (overlays, kernel wires)
// ---------------------------------------------------------------------------------------------

export interface SampleOptions {
  /** Max chord deviation from the true curve, mm (default 0.01). */
  chordTolerance?: number;
  /** Segment count limits for curved entities (defaults 8 and 512). */
  minSegments?: number;
  maxSegments?: number;
}

function segmentsFor(r: number, sweep: number, o: SampleOptions): number {
  const tol = Math.max(o.chordTolerance ?? 0.01, 1e-9);
  const min = o.minSegments ?? 8;
  const max = o.maxSegments ?? 512;
  // Chord sagitta s = r(1 - cos(θ/2)) ≤ tol  →  θ ≤ 2 acos(1 - tol/r).
  const step = r <= tol ? sweep : 2 * Math.acos(Math.max(-1, 1 - tol / r));
  const n = Math.ceil(sweep / Math.max(step, 1e-6));
  return Math.min(max, Math.max(Math.ceil((min * sweep) / TAU), n, 1));
}

/**
 * Samples an entity as a polyline in sketch space. Points give one vertex; lines two; circles a
 * closed loop (first vertex repeated at the end); arcs run CCW from start to end; ellipses close.
 */
export function sampleEntity(
  index: EntityIndex,
  e: SketchEntity,
  options: SampleOptions = {},
): Vec2[] {
  switch (e.kind) {
    case 'point':
      return [[e.x, e.y]];
    case 'line': {
      const { a, b } = lineGeom(index, e);
      return [a, b];
    }
    case 'circle': {
      const { c, r } = circleGeom(index, e);
      const n = segmentsFor(r, TAU, options);
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) out.push(add(c, fromAngle((i / n) * TAU, r)));
      out[n] = out[0] as Vec2;
      return out;
    }
    case 'arc': {
      const g = arcGeom(index, e);
      const n = segmentsFor(g.r, g.sweep, options);
      const out: Vec2[] = [g.start];
      for (let i = 1; i < n; i++) out.push(add(g.c, fromAngle(g.a0 + (i / n) * g.sweep, g.r)));
      out.push(g.end);
      return out;
    }
    case 'ellipse': {
      const c = pointPos(index, e.center);
      const n = segmentsFor(Math.max(e.majorRadius, e.minorRadius), TAU, options);
      const out: Vec2[] = [];
      const cr = Math.cos(e.rotation);
      const sr = Math.sin(e.rotation);
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * TAU;
        const x = Math.cos(t) * e.majorRadius;
        const y = Math.sin(t) * e.minorRadius;
        out.push([c[0] + x * cr - y * sr, c[1] + x * sr + y * cr]);
      }
      out[n] = out[0] as Vec2;
      return out;
    }
  }
}

/** Samples every entity; returns id → polyline. Construction entities are included. */
export function sampleSketch(
  entities: readonly SketchEntity[],
  options: SampleOptions = {},
): Map<Id, Vec2[]> {
  const index = indexEntities(entities);
  const out = new Map<Id, Vec2[]>();
  for (const e of entities) out.set(e.id, sampleEntity(index, e, options));
  return out;
}

/** Exact axis-aligned bounds of the sketch geometry, or null when empty. */
export function sketchBounds(entities: readonly SketchEntity[]): { min: Vec2; max: Vec2 } | null {
  const index = indexEntities(entities);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = ([x, y]: Vec2) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const e of entities) {
    if (e.kind === 'point') grow([e.x, e.y]);
    else if (e.kind === 'circle') {
      const { c, r } = circleGeom(index, e);
      grow([c[0] - r, c[1] - r]);
      grow([c[0] + r, c[1] + r]);
    } else if (e.kind === 'arc') {
      const g = arcGeom(index, e);
      grow(g.start);
      grow(g.end);
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2;
        if (angleInArc(g, t)) grow(add(g.c, fromAngle(t, g.r)));
      }
    } else if (e.kind === 'ellipse') {
      for (const p of sampleEntity(index, e, { chordTolerance: 1e-4 })) grow(p);
    }
  }
  return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
}

// ---------------------------------------------------------------------------------------------
// Closest points (inference, hit-testing)
// ---------------------------------------------------------------------------------------------

/** Closest point on segment ab to p, with the segment parameter t ∈ [0, 1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return { point: lerp(a, b, t), t };
}

/** Closest point on the infinite line through ab. */
export function projectOnLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return a;
  return add(a, scale(ab, dot(sub(p, a), ab) / l2));
}

/** Closest point on an entity's curve (points: the point; arcs clamp to their span). */
export function closestOnEntity(index: EntityIndex, e: SketchEntity, p: Vec2): Vec2 | null {
  switch (e.kind) {
    case 'point':
      return [e.x, e.y];
    case 'line': {
      const { a, b } = lineGeom(index, e);
      return closestOnSegment(p, a, b).point;
    }
    case 'circle': {
      const { c, r } = circleGeom(index, e);
      const d = sub(p, c);
      return len(d) === 0 ? add(c, [r, 0]) : add(c, scale(normalize(d), r));
    }
    case 'arc': {
      const g = arcGeom(index, e);
      const t = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
      if (angleInArc(g, t)) return add(g.c, fromAngle(t, g.r));
      return dist(p, g.start) <= dist(p, g.end) ? g.start : g.end;
    }
    case 'ellipse': {
      // Coarse: nearest sample. Ellipses are P1.
      let best: Vec2 | null = null;
      let bd = Number.POSITIVE_INFINITY;
      for (const q of sampleEntity(index, e, { minSegments: 256 })) {
        const d = dist(p, q);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      return best;
    }
  }
}

/** Circle through three points, or null when they are (nearly) collinear. */
export function circumcircle(a: Vec2, b: Vec2, c: Vec2): CircleGeom | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scaleRef = Math.max(dist(a, b), dist(b, c), dist(a, c));
  if (Math.abs(d) < 1e-12 * scaleRef * scaleRef || scaleRef === 0) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const center: Vec2 = [ux, uy];
  return { c: center, r: dist(center, a) };
}
