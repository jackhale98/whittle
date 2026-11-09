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
  SketchBSpline,
  SketchCircle,
  SketchEllipse,
  SketchEllipticArc,
  SketchEntity,
  SketchLine,
  Vec2,
} from '@wren-cad/contracts';
import {
  closestSplineParam,
  type SplineGeom,
  sampleParams,
  splineAt,
  splineBasis,
  splinePoint,
} from './bspline';

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
    case 'ellipticArc':
      return e.center;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Ellipses, elliptic arcs and splines
// ---------------------------------------------------------------------------------------------

export interface EllipseGeom {
  c: Vec2;
  /** Major and minor radius (a ≥ b in a valid sketch). */
  a: number;
  b: number;
  /** Major axis direction, radians. */
  rotation: number;
  /** Unit major / minor axis directions (minor = major turned CCW by 90°). */
  u: Vec2;
  v: Vec2;
}

export interface EllipticArcGeom extends EllipseGeom {
  start: Vec2;
  end: Vec2;
  /** Eccentric angle of the start in [0, 2π) and the CCW sweep in (0, 2π]. */
  t0: number;
  sweep: number;
}

export function ellipseGeom(index: EntityIndex, e: SketchEllipse | SketchEllipticArc): EllipseGeom {
  const u: Vec2 = [Math.cos(e.rotation), Math.sin(e.rotation)];
  return {
    c: pointPos(index, e.center),
    a: e.majorRadius,
    b: e.minorRadius,
    rotation: e.rotation,
    u,
    v: perp(u),
  };
}

/** Point at eccentric angle `t`: c + a cos t · u + b sin t · v. */
export function ellipsePoint(g: EllipseGeom, t: number): Vec2 {
  const x = g.a * Math.cos(t);
  const y = g.b * Math.sin(t);
  return [g.c[0] + x * g.u[0] + y * g.v[0], g.c[1] + x * g.u[1] + y * g.v[1]];
}

/** Eccentric angle of a point (exact for points on the ellipse), in [0, 2π). */
export function ellipseParam(g: EllipseGeom, p: Vec2): number {
  const d = sub(p, g.c);
  return angle0(
    Math.atan2(dot(d, g.v) / Math.max(g.b, 1e-300), dot(d, g.u) / Math.max(g.a, 1e-300)),
  );
}

export function ellipticArcGeom(index: EntityIndex, e: SketchEllipticArc): EllipticArcGeom {
  const g = ellipseGeom(index, e);
  const start = pointPos(index, e.start);
  const end = pointPos(index, e.end);
  const t0 = ellipseParam(g, start);
  let sweep = angle0(ellipseParam(g, end) - t0);
  if (sweep < 1e-12) sweep = TAU;
  return { ...g, start, end, t0, sweep };
}

/** A spline entity with its pole positions. */
export function splineGeom(index: EntityIndex, e: SketchBSpline): SplineGeom {
  return {
    poles: e.poles.map((id) => pointPos(index, id)),
    degree: e.degree,
    periodic: e.periodic,
    ...(e.weights ? { weights: e.weights } : {}),
    ...(e.knots ? { knots: e.knots } : {}),
    ...(e.multiplicities ? { multiplicities: e.multiplicities } : {}),
  };
}

/**
 * A curve entity as a parametric curve over [t0, t1]: lines t ∈ [0, 1] from start to end;
 * circles and ellipses the (eccentric) angle over [0, 2π] (closed, CCW); arcs and elliptic arcs
 * CCW from their start; splines their knot range (closed when periodic). Directions are the ones
 * planegcs uses for curve normals (ADR-pending "Sketch curves in the solver").
 */
export interface ParamCurve {
  t0: number;
  t1: number;
  closed: boolean;
  at(t: number): Vec2;
  d1(t: number): Vec2;
  d2(t: number): Vec2;
}

export function paramCurve(index: EntityIndex, e: SketchEntity): ParamCurve | null {
  switch (e.kind) {
    case 'point':
      return null;
    case 'line': {
      const { a, b } = lineGeom(index, e);
      const d = sub(b, a);
      return {
        t0: 0,
        t1: 1,
        closed: false,
        at: (t) => add(a, scale(d, t)),
        d1: () => d,
        d2: () => [0, 0],
      };
    }
    case 'circle':
    case 'arc': {
      const g = e.kind === 'circle' ? circleGeom(index, e) : arcGeom(index, e);
      const a0 = e.kind === 'arc' ? (g as ArcGeom).a0 : 0;
      const sweep = e.kind === 'arc' ? (g as ArcGeom).sweep : TAU;
      return {
        t0: a0,
        t1: a0 + sweep,
        closed: e.kind === 'circle',
        at: (t) => add(g.c, fromAngle(t, g.r)),
        d1: (t) => [-g.r * Math.sin(t), g.r * Math.cos(t)],
        d2: (t) => [-g.r * Math.cos(t), -g.r * Math.sin(t)],
      };
    }
    case 'ellipse':
    case 'ellipticArc': {
      const g = e.kind === 'ellipse' ? ellipseGeom(index, e) : ellipticArcGeom(index, e);
      const t0 = e.kind === 'ellipticArc' ? (g as EllipticArcGeom).t0 : 0;
      const sweep = e.kind === 'ellipticArc' ? (g as EllipticArcGeom).sweep : TAU;
      const comb = (x: number, y: number): Vec2 => [
        x * g.u[0] + y * g.v[0],
        x * g.u[1] + y * g.v[1],
      ];
      return {
        t0,
        t1: t0 + sweep,
        closed: e.kind === 'ellipse',
        at: (t) => ellipsePoint(g, t),
        d1: (t) => comb(-g.a * Math.sin(t), g.b * Math.cos(t)),
        d2: (t) => comb(-g.a * Math.cos(t), -g.b * Math.sin(t)),
      };
    }
    case 'bspline': {
      const g = splineGeom(index, e);
      const basis = splineBasis(g.poles.length, g);
      return {
        t0: basis.lo,
        t1: basis.hi,
        closed: g.periodic,
        at: (t) => splinePoint(g, t),
        d1: (t) => {
          const r = splineAt(g, t, 1);
          return [r[2] as number, r[3] as number];
        },
        d2: (t) => {
          const r = splineAt(g, t, 2);
          return [r[4] as number, r[5] as number];
        },
      };
    }
  }
}

/** Parameter of the point of `curve` nearest `p` (within [t0, t1]; closed curves wrap). */
export function closestParam(curve: ParamCurve, p: Vec2, samples = 64): number {
  let best = curve.t0;
  let bd = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= samples; i++) {
    const t = curve.t0 + ((curve.t1 - curve.t0) * i) / samples;
    const q = curve.at(t);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return refineCurveParam(curve, p, best);
}

/** Newton on C′(t)·(C(t) − p) = 0 from `t`. */
export function refineCurveParam(curve: ParamCurve, p: Vec2, tIn: number): number {
  let t = tIn;
  const span = curve.t1 - curve.t0;
  for (let it = 0; it < 16; it++) {
    const q = sub(curve.at(t), p);
    const d1 = curve.d1(t);
    const d2 = curve.d2(t);
    const f = dot(d1, q);
    const df = dot(d1, d1) + dot(d2, q);
    if (!(Math.abs(df) > 1e-300)) break;
    let next = t - f / df;
    if (curve.closed) {
      while (next < curve.t0) next += span;
      while (next > curve.t1) next -= span;
    } else next = Math.min(curve.t1, Math.max(curve.t0, next));
    const done = Math.abs(next - t) <= 1e-14 * Math.max(1, Math.abs(t));
    t = next;
    if (done) break;
  }
  return t;
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
    case 'ellipticArc': {
      const g = ellipticArcGeom(index, e);
      const n = segmentsFor(Math.max(g.a, g.b), g.sweep, options);
      const out: Vec2[] = [g.start];
      for (let i = 1; i < n; i++) out.push(ellipsePoint(g, g.t0 + (i / n) * g.sweep));
      out.push(g.end);
      return out;
    }
    case 'bspline': {
      const g = splineGeom(index, e);
      const ts = sampleParams(g, options.chordTolerance ?? 0.01, options.maxSegments ?? 2048);
      const out = ts.map((t) => splinePoint(g, t));
      // Exact ends: a clamped spline starts and ends at its end poles; a periodic one closes.
      if (g.periodic) out[out.length - 1] = out[0] as Vec2;
      else {
        out[0] = g.poles[0] as Vec2;
        out[out.length - 1] = g.poles[g.poles.length - 1] as Vec2;
      }
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
    } else if (e.kind === 'ellipse' || e.kind === 'ellipticArc' || e.kind === 'bspline') {
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
      const g = ellipseGeom(index, e);
      if (!(g.a > 0) || !(g.b > 0)) return g.c;
      const curve = paramCurve(index, e) as ParamCurve;
      return curve.at(closestParam(curve, p));
    }
    case 'ellipticArc': {
      const g = ellipticArcGeom(index, e);
      if (!(g.a > 0) || !(g.b > 0)) return g.start;
      // Closest on the whole ellipse; outside the arc's sweep, the nearer end.
      const full: ParamCurve = {
        ...(paramCurve(index, e) as ParamCurve),
        t0: 0,
        t1: TAU,
        closed: true,
      };
      const t = closestParam(full, p);
      if (angle0(t - g.t0) <= g.sweep) return full.at(t);
      return dist(p, g.start) <= dist(p, g.end) ? g.start : g.end;
    }
    case 'bspline': {
      const g = splineGeom(index, e);
      return splinePoint(g, closestSplineParam(g, p));
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
