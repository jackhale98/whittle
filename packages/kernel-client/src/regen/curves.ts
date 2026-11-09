/**
 * Exact evaluation of the M3.5 sketch curves (ADR-046): B-splines by de Boor (rational when
 * weighted) and elliptic arcs, plus their chord-tolerance sampling for display polylines.
 *
 * Knot conventions (the contract of `SketchBSpline`, shared with the kernel and sketch
 * workstreams; see the ADR "M3.5 regen of the new curves"):
 *  - `knots` are the **distinct** knot values and `multiplicities` their multiplicities (OCCT's
 *    `Geom_BSplineCurve` convention). Both omitted = the defaults below. `knots` given without
 *    `multiplicities` is read as a flat (expanded) knot vector when its length fits, otherwise the
 *    spline is invalid.
 *  - Default, non-periodic (clamped): n poles, degree p → distinct knots i/(n−p), i = 0…n−p, with
 *    multiplicities p+1, 1, …, 1, p+1. The curve starts at the first pole and ends at the last.
 *  - Default, periodic: distinct knots i/n, i = 0…n, all multiplicity 1 (period 1). Periodic flat
 *    knots follow OCCT's `BSplCLib::KnotSequence`: p+1−m₀ knots of the previous period before
 *    the first knot and as many of the next after the last, pole i (0-based, cyclic) supported on
 *    flat knots [i, i+p+1]. So the default periodic cubic starts at (P₀ + 4P₁ + P₂)/6.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2 } from '@wren-cad/contracts';

/** What a B-spline needs besides its pole positions (the `SketchBSpline` fields). */
export interface BSplineDef {
  degree: number;
  periodic: boolean;
  weights?: number[] | undefined;
  knots?: number[] | undefined;
  multiplicities?: number[] | undefined;
}

/** A B-spline ready for evaluation: flat knots, poles extended cyclically when periodic. */
export interface PreparedBSpline {
  degree: number;
  /** Flat knot vector (periodic: with the p+1−m₀ knots of the neighbouring periods). */
  flat: number[];
  /** Poles (periodic: the first ones repeated at the end so every span has p+1 of them). */
  poles: Vec2[];
  weights: number[] | null;
  /** Parameter domain. */
  t0: number;
  t1: number;
  /** Flat indices s with flat[s] < flat[s+1] inside the domain (the non-empty spans). */
  spans: number[];
}

/** Uniform default knots of `SketchBSpline` (distinct values and multiplicities). */
export function defaultKnots(
  poleCount: number,
  degree: number,
  periodic: boolean,
): { knots: number[]; multiplicities: number[] } {
  if (periodic) {
    const n = poleCount;
    return {
      knots: Array.from({ length: n + 1 }, (_, i) => i / n),
      multiplicities: Array.from({ length: n + 1 }, () => 1),
    };
  }
  const spans = poleCount - degree;
  const knots = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  const multiplicities = knots.map((_, i) => (i === 0 || i === spans ? degree + 1 : 1));
  return { knots, multiplicities };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Checks a spline definition and builds its flat knots; a reason string when it is not a valid
 * B-spline (the kernel reports the same cases as errors; the display falls back to the control
 * polygon).
 */
export function prepareBSpline(def: BSplineDef, poles: readonly Vec2[]): PreparedBSpline | string {
  const p = def.degree;
  const n = poles.length;
  if (!Number.isInteger(p) || p < 1) return 'the degree must be a whole number ≥ 1';
  if (n < 2) return 'a spline needs at least two control points';
  if (!def.periodic && n < p + 1)
    return `a degree ${p} spline needs at least ${p + 1} control points`;
  if (def.periodic && n < p)
    return `a closed degree ${p} spline needs at least ${p} control points`;
  let weights: number[] | null = null;
  if (def.weights !== undefined) {
    if (def.weights.length !== n || !def.weights.every((w) => isNum(w) && w > 0)) {
      return 'every control point needs a positive weight';
    }
    if (def.weights.some((w) => w !== def.weights?.[0])) weights = [...def.weights];
  }
  let knots: number[];
  let mults: number[];
  if (def.knots === undefined && def.multiplicities === undefined) {
    ({ knots, multiplicities: mults } = defaultKnots(n, p, def.periodic));
  } else if (def.knots !== undefined && def.multiplicities !== undefined) {
    knots = def.knots;
    mults = def.multiplicities;
  } else if (def.knots !== undefined && !def.periodic && def.knots.length === n + p + 1) {
    // A flat knot vector: collapse it to distinct values and multiplicities.
    knots = [];
    mults = [];
    for (const k of def.knots) {
      const last = mults.length - 1;
      if (last >= 0 && k === knots[last]) mults[last] = (mults[last] as number) + 1;
      else {
        knots.push(k);
        mults.push(1);
      }
    }
  } else {
    return 'the knots and their multiplicities must be given together';
  }
  if (knots.length < 2 || knots.length !== mults.length) {
    return 'every knot needs a multiplicity';
  }
  for (let i = 0; i < knots.length; i++) {
    const k = knots[i] as number;
    const m = mults[i] as number;
    if (!isNum(k) || !Number.isInteger(m) || m < 1 || m > p + 1) return 'invalid knot multiplicity';
    if (i > 0 && !(k > (knots[i - 1] as number))) return 'the knots must increase';
  }
  const sum = mults.reduce((s, m) => s + m, 0);
  let flat: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    for (let j = 0; j < (mults[i] as number); j++) flat.push(knots[i] as number);
  }
  const ext = [...poles];
  const extW = weights ? [...weights] : null;
  if (def.periodic) {
    const m0 = mults[0] as number;
    if (m0 !== mults[mults.length - 1]) return 'a closed spline needs equal end multiplicities';
    if (sum - m0 !== n) return `${n} control points need knot multiplicities adding up to ${n}`;
    const period = (knots[knots.length - 1] as number) - (knots[0] as number);
    const extra = p + 1 - m0;
    if (extra > sum - m0) return `a closed degree ${p} spline needs more knots`;
    // As OCCT's BSplCLib::KnotSequence: the `extra` flat knots before come from the end of the
    // period without its shared last knot, shifted back a period; those after from its start
    // without the shared first knot, shifted forward.
    const before = flat.slice(sum - m0 - extra, sum - m0).map((k) => k - period);
    const after = flat.slice(m0, m0 + extra).map((k) => k + period);
    flat = [...before, ...flat, ...after];
    for (let j = 0; j < p; j++) {
      ext.push(poles[j % n] as Vec2);
      if (extW && weights) extW.push(weights[j % n] as number);
    }
    const t0 = knots[0] as number;
    const t1 = knots[knots.length - 1] as number;
    return finish(p, flat, ext, extW, t0, t1, p, n + p);
  }
  if (sum !== n + p + 1) {
    return `${n} control points of degree ${p} need ${n + p + 1} knots (with multiplicity)`;
  }
  return finish(p, flat, ext, extW, flat[p] as number, flat[n] as number, p, n);
}

function finish(
  degree: number,
  flat: number[],
  poles: Vec2[],
  weights: number[] | null,
  t0: number,
  t1: number,
  lo: number,
  hi: number,
): PreparedBSpline | string {
  if (!(t1 > t0)) return 'the knots span no parameter range';
  const spans: number[] = [];
  for (let s = lo; s < hi; s++) if ((flat[s + 1] as number) > (flat[s] as number)) spans.push(s);
  return { degree, flat, poles, weights, t0, t1, spans };
}

/** The flat index s of the span holding `t` (clamped to the domain). */
function spanOf(b: PreparedBSpline, t: number): number {
  const spans = b.spans;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((b.flat[spans[mid] as number] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  return spans[lo] as number;
}

/** de Boor's algorithm (homogeneous coordinates when rational). */
export function evalBSpline(b: PreparedBSpline, t: number, span = spanOf(b, t)): Vec2 {
  const p = b.degree;
  const x: number[] = [];
  const y: number[] = [];
  const w: number[] = [];
  for (let j = 0; j <= p; j++) {
    const i = span - p + j;
    const P = b.poles[i] as Vec2;
    const wi = b.weights ? (b.weights[i] as number) : 1;
    x.push(P[0] * wi);
    y.push(P[1] * wi);
    w.push(wi);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = span - p + j;
      const a0 = b.flat[i] as number;
      const a1 = b.flat[i + p - r + 1] as number;
      const a = a1 > a0 ? (t - a0) / (a1 - a0) : 0;
      x[j] = (1 - a) * (x[j - 1] as number) + a * (x[j] as number);
      y[j] = (1 - a) * (y[j - 1] as number) + a * (y[j] as number);
      w[j] = (1 - a) * (w[j - 1] as number) + a * (w[j] as number);
    }
  }
  const wp = w[p] as number;
  return [(x[p] as number) / wp, (y[p] as number) / wp];
}

/** Display samples per span before refinement, and the refinement caps. */
const SPAN_START = 4;
const MAX_DEPTH = 10;
const MAX_SAMPLES = 4096;

const midDev = (a: Vec2, m: Vec2, b: Vec2): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-15) return Math.hypot(m[0] - a[0], m[1] - a[1]);
  return Math.abs((m[0] - a[0]) * dy - (m[1] - a[1]) * dx) / l;
};

/**
 * Exact points on the spline, no chord farther than `chord` from the curve (checked at the
 * middle and quarter points of each chord against 0.9 × `chord`, which also catches
 * inflections): every non-empty knot
 * span starts with `SPAN_START` equal steps (degree 1: one, it is straight) and chords that
 * deviate are halved, at most `MAX_DEPTH` times. Knots are always sample points, so the polyline
 * passes through the exact curve where its pieces join. Periodic splines close exactly.
 */
export function sampleBSpline(b: PreparedBSpline, chord: number): Vec2[] {
  const tol = Math.max(chord, 1e-9);
  const out: Vec2[] = [];
  const refine = (s: number, ta: number, pa: Vec2, tb: number, pb: Vec2, depth: number) => {
    const tm = (ta + tb) / 2;
    const pm = evalBSpline(b, tm, s);
    const q1 = evalBSpline(b, (ta + tm) / 2, s);
    const q3 = evalBSpline(b, (tm + tb) / 2, s);
    const dev = Math.max(midDev(pa, pm, pb), midDev(pa, q1, pb), midDev(pa, q3, pb));
    // 0.9: the three probes can slightly under-estimate a cubic's largest deviation.
    if (depth < MAX_DEPTH && dev > 0.9 * tol && out.length < MAX_SAMPLES) {
      refine(s, ta, pa, tm, pm, depth + 1);
      refine(s, tm, pm, tb, pb, depth + 1);
    } else out.push(pb);
  };
  for (const s of b.spans) {
    const a = b.flat[s] as number;
    const e = b.flat[s + 1] as number;
    const steps = b.degree === 1 ? 1 : SPAN_START;
    let ta = a;
    let pa = evalBSpline(b, a, s);
    if (out.length === 0) out.push(pa);
    for (let k = 1; k <= steps; k++) {
      const tb = k === steps ? e : a + ((e - a) * k) / steps;
      // The span's right end is evaluated in this span (continuity makes it the next one's start).
      const pb = evalBSpline(b, tb, s);
      refine(s, ta, pa, tb, pb, 0);
      ta = tb;
      pa = pb;
    }
  }
  return out;
}

/** An ellipse in a sketch frame: centre, radii and major-axis direction (radians). */
export interface EllipseGeom {
  c: Vec2;
  a: number;
  b: number;
  rotation: number;
}

/** The point at parametric angle `t` (counter-clockwise for positive radii). */
export function ellipsePoint(e: EllipseGeom, t: number): Vec2 {
  const cr = Math.cos(e.rotation);
  const sr = Math.sin(e.rotation);
  const u = e.a * Math.cos(t);
  const v = e.b * Math.sin(t);
  return [e.c[0] + u * cr - v * sr, e.c[1] + u * sr + v * cr];
}

/** Parametric angle of a point (on or near the ellipse). */
export function ellipseParam(e: EllipseGeom, p: Vec2): number {
  const cr = Math.cos(e.rotation);
  const sr = Math.sin(e.rotation);
  const dx = p[0] - e.c[0];
  const dy = p[1] - e.c[1];
  const u = dx * cr + dy * sr;
  const v = -dx * sr + dy * cr;
  return Math.atan2(v / e.b, u / e.a);
}

/** Start parameter and positive sweep (≤ 2π) of a counter-clockwise elliptic arc. */
export function ellipticArcRange(
  e: EllipseGeom,
  start: Vec2,
  end: Vec2,
): { t0: number; sweep: number } {
  const t0 = ellipseParam(e, start);
  let sweep = ellipseParam(e, end) - t0;
  while (sweep <= 1e-12) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  return { t0, sweep };
}
