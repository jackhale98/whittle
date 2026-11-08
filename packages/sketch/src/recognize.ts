/**
 * Pencil primitive recognition (PLAN §2.1, §12 M2; ADR-009 item 5). A pure function, with no
 * Wasm and no allocation-heavy work, so the app can run it on the main thread on every pointer
 * move or at pen-up and show the clean-up in the same frame. Entry: `@whittle/sketch/recognize`
 * (also re-exported from the package root); `strokeFragment` turns the result into entities +
 * constraints like a drawing tool.
 *
 * Pipeline:
 *  1. Clean the samples (finite, de-duplicated) and reject degenerate strokes (too few samples,
 *     too short for the tolerance).
 *  2. Resample to equal arc-length spacing (ShortStraw: bounding-box diagonal / 40), so speed
 *     variation no longer matters. The stroke length L, which scales the relative error
 *     thresholds, is measured on the resampled polyline (raw jitter inflates the raw length).
 *  3. Corner candidates from "straws" (Wolin et al., ShortStraw 2008): the chord across ±3
 *     resampled points is short at corners. Dense, long reversals = a scribble (erase gesture).
 *  4. Closure: endpoints within `tolerance` (an overshoot past the start is trimmed first).
 *  5. Whole-stroke line fit (worst deviation ≤ 3% of L), then circle/arc fit (Pratt algebraic
 *     least squares, Chernov's Newton solve). Curvature must be uniform (turning not bunched at
 *     corners) and an arc must beat a two-line model, so polylines aren't arcs. A circle must
 *     also be round (principal-axis aspect ≤ 1.2), so ovals are not circles.
 *  6. Otherwise segment at the corners. Each segment gets a total-least-squares line fit (its
 *     ends trimmed so rounded or overshot corners don't tilt it). Split segments that are neither
 *     a line nor an arc at their point of maximum deviation; drop tiny hooks and rounded
 *     corners; merge nearly collinear neighbours. Thresholds are relative to L, with a floor of
 *     0.3 × tolerance for hand noise on short strokes.
 *  7. Classify: line, rectangle (4 sides, right angles within 2 × angleTolerance), or polyline.
 *     Clean-up: a rectangle gets the least-squares rectangle (snapped axis-aligned within
 *     angleTolerance); polyline segments snap to horizontal/vertical and corners to 90° within
 *     angleTolerance; vertices are intersections of the fitted lines, so snapped coordinates
 *     are exact (a horizontal edge has bit-identical y at both ends).
 *
 * `implied` lists the constraint kinds the clean-up stands for. `coincident` there means the
 * ends were joined (the fragment shares the point, so it needs no coincident constraint).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  GeometricConstraint,
  RecognizedShape,
  RecognizeStroke,
  StrokeRecognition,
  StrokeSample,
  Vec2,
} from '@whittle/contracts';

export { strokeFragment } from './stroke-fragment';

type ConstraintKind = GeometricConstraint['kind'];

const DEG = Math.PI / 180;
/** Default `angleTolerance` (contract: ≈ 6°). */
export const DEFAULT_STROKE_ANGLE_TOLERANCE = 6 * DEG;

const MIN_SAMPLES = 5;
/** Straw half-window, resampled points. */
const W = 3;
const MIN_POINTS = 16;
const MAX_POINTS = 200;

// Thresholds. "L" = stroke length; radial errors are relative to the radius.
/** Circle/arc: RMS radial error / r. */
const ROUND_RMS = 0.055;
/** Circle/arc: worst radial error / r. */
const ROUND_MAX = 0.14;
/** A circle's principal-axis aspect ratio (an oval of 1.3 must not pass). */
const CIRCLE_ASPECT = 1.2;
/** An open stroke sweeping at least this much is a circle (not an arc); a closed one 300°. */
const CIRCLE_SWEEP = 320 * DEG;
const CLOSED_CIRCLE_SWEEP = 300 * DEG;
const ARC_MIN_SWEEP = 25 * DEG;
/** Arc/circle: at most this share of the turning within 15% of the length (else: a corner). */
const TURN_CONCENTRATION = 0.6;
/** Open arcs: share of turning within 8% of the length ≤ 4.3 × 8% (uniform: ≈ 1 × 8%). */
const ARC_PEAK_WINDOW = 0.08;
const ARC_PEAK = 4.3;
/** …or ≤ 6.5 × 8% when the circle fits within 1.2% of the radius (RMS). */
const ARC_GOOD_RMS = 0.012;
const ARC_PEAK_GOOD = 6.5;
/** A whole-stroke line: worst deviation / L. */
const LINE_MAX = 0.03;
/** Segments: split when the worst deviation from the fitted line exceeds this × L. */
const SPLIT_DEV = 0.018;
/** Segments shorter than this × L are hooks (corner overshoot, pen-down/up ticks). */
const TINY = 0.04;
/** …or shorter than this × both neighbours (and under 2.5 × TINY × L). */
const HOOK_RELATIVE = 0.3;
/** Merge neighbours whose turn is below max(this, 1.5 × angleTolerance)… */
const MERGE_ANGLE = 8 * DEG;
/** …or below this when the merged fit stays within MERGE_DEV × L. */
const MERGE_WIDE = 22 * DEG;
const MERGE_DEV = 0.009;
/** Scribble: reversals (turns ≥ this) between long passes. */
const REVERSAL = 140 * DEG;
const SCRIBBLE_REVERSALS = 3;
/** Scribble: path length / bounding-box diagonal. */
const SCRIBBLE_DENSITY = 2.6;
/** Closure: at most this share of the stroke is trimmed as an overshoot past the start. */
const OVERSHOOT = 0.12;
/** Deviation floor as a share of `tolerance` (hand noise on short strokes). */
const NOISE = 0.3;

// ---------------------------------------------------------------------------------------------
// Small vector helpers (local: the recogniser depends on nothing but the contracts)
// ---------------------------------------------------------------------------------------------

const at = <T>(a: readonly T[], i: number): T => a[i] as T;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function angleBetween(u: Vec2, v: Vec2): number {
  return Math.atan2(cross(u, v), dot(u, v));
}

function pathLength(p: readonly Vec2[], closed = false): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(at(p, i - 1), at(p, i));
  if (closed && p.length > 1) s += dist(at(p, p.length - 1), at(p, 0));
  return s;
}

function bboxDiag(p: readonly Vec2[]): number {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const q of p) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  return Math.hypot(x1 - x0, y1 - y0);
}

/** `n` points at equal arc-length spacing; a closed path is cyclic (no repeated end point). */
function resample(p: readonly Vec2[], n: number, closed: boolean): Vec2[] {
  const path = closed ? [...p, at(p, 0)] : p;
  const total = pathLength(path);
  const steps = closed ? n : n - 1;
  const spacing = total / steps;
  const out: Vec2[] = [at(path, 0)];
  let i = 1;
  let prev = at(path, 0);
  let acc = 0;
  while (out.length < n && i < path.length) {
    const cur = at(path, i);
    const d = dist(prev, cur);
    if (acc + d >= spacing && d > 0) {
      const t = (spacing - acc) / d;
      const q: Vec2 = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += d;
      prev = cur;
      i++;
    }
  }
  // Rounding can leave the last point(s) short.
  while (out.length < n) out.push(closed ? prev : at(path, path.length - 1));
  if (!closed) out[n - 1] = at(path, path.length - 1);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fits
// ---------------------------------------------------------------------------------------------

interface LineFit {
  /** Centroid (a point on the line). */
  c: Vec2;
  /** Unit direction, oriented along the stroke. */
  u: Vec2;
  /** RMS / worst perpendicular deviation of all segment points, mm. */
  rms: number;
  max: number;
  /** Extent of the points along `u`, mm. */
  len: number;
}

/**
 * Total-least-squares line through p[a..b] (inclusive). The direction is fitted on the points
 * with `trim` of each end dropped (rounded or overshot corners), errors use all points.
 */
function fitLine(p: readonly Vec2[], a: number, b: number, trim = 0.12): LineFit {
  const count = b - a + 1;
  const k = count >= 8 ? Math.floor(count * trim) : 0;
  const lo = a + k;
  const hi = b - k;
  let mx = 0;
  let my = 0;
  for (let i = lo; i <= hi; i++) {
    mx += at(p, i)[0];
    my += at(p, i)[1];
  }
  const m = hi - lo + 1;
  mx /= m;
  my /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = at(p, i)[0] - mx;
    const dy = at(p, i)[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let u: Vec2 = [Math.cos(theta), Math.sin(theta)];
  if (dot(u, sub(at(p, b), at(p, a))) < 0) u = [-u[0], -u[1]];
  let s2 = 0;
  let max = 0;
  let tMin = Number.POSITIVE_INFINITY;
  let tMax = Number.NEGATIVE_INFINITY;
  for (let i = a; i <= b; i++) {
    const d: Vec2 = [at(p, i)[0] - mx, at(p, i)[1] - my];
    const e = Math.abs(cross(u, d));
    const t = dot(u, d);
    s2 += e * e;
    if (e > max) max = e;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return { c: [mx, my], u, rms: Math.sqrt(s2 / count), max, len: tMax - tMin };
}

export interface CircleFit {
  c: Vec2;
  r: number;
  /** RMS / worst radial deviation, mm. */
  rms: number;
  max: number;
}

/**
 * Pratt's algebraic circle fit (Pratt 1987) via Chernov's Newton iteration on the
 * characteristic polynomial; falls back to Kasa (the `x = 0` root) when Newton misbehaves.
 * Null for (nearly) collinear points.
 */
export function fitCircle(p: readonly Vec2[], a = 0, b = p.length - 1): CircleFit | null {
  const n = b - a + 1;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = a; i <= b; i++) {
    mx += at(p, i)[0];
    my += at(p, i)[1];
  }
  mx /= n;
  my /= n;
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  let mxz = 0;
  let myz = 0;
  let mzz = 0;
  for (let i = a; i <= b; i++) {
    const x = at(p, i)[0] - mx;
    const y = at(p, i)[1] - my;
    const z = x * x + y * y;
    mxx += x * x;
    myy += y * y;
    mxy += x * y;
    mxz += x * z;
    myz += y * z;
    mzz += z * z;
  }
  mxx /= n;
  myy /= n;
  mxy /= n;
  mxz /= n;
  myz /= n;
  mzz /= n;
  const mz = mxx + myy;
  const covXY = mxx * myy - mxy * mxy;
  const a2 = 4 * covXY - 3 * mz * mz - mzz;
  const a1 = mzz * mz + 4 * covXY * mz - mxz * mxz - myz * myz - mz * mz * mz;
  const a0 =
    mxz * mxz * myy + myz * myz * mxx - mzz * covXY - 2 * mxz * myz * mxy + mz * mz * covXY;
  let x = 0;
  let y = Number.POSITIVE_INFINITY;
  for (let iter = 0; iter < 20; iter++) {
    const yOld = y;
    y = a0 + x * (a1 + x * (a2 + 4 * x * x));
    if (Math.abs(y) > Math.abs(yOld)) {
      x = 0;
      break;
    }
    const dy = a1 + x * (2 * a2 + 16 * x * x);
    const xOld = x;
    x = xOld - y / dy;
    if (!Number.isFinite(x) || x < 0) {
      x = 0;
      break;
    }
    if (Math.abs((x - xOld) / x) < 1e-12) break;
  }
  const det = x * x - x * mz + covXY;
  if (!(Math.abs(det) > 1e-12 * mz * mz)) return null;
  const cx = (mxz * (myy - x) - myz * mxy) / det / 2;
  const cy = (myz * (mxx - x) - mxz * mxy) / det / 2;
  const r = Math.sqrt(cx * cx + cy * cy + mz + 2 * x);
  if (!Number.isFinite(r) || r <= 0) return null;
  const c: Vec2 = [cx + mx, cy + my];
  let s2 = 0;
  let max = 0;
  for (let i = a; i <= b; i++) {
    const e = Math.abs(dist(at(p, i), c) - r);
    s2 += e * e;
    if (e > max) max = e;
  }
  return { c, r, rms: Math.sqrt(s2 / n), max };
}

/** Signed angle swept around `c` walking p[a..b] (CCW positive). */
function sweep(p: readonly Vec2[], c: Vec2, a = 0, b = p.length - 1, closed = false): number {
  let total = 0;
  let prev = Math.atan2(at(p, a)[1] - c[1], at(p, a)[0] - c[0]);
  const step = (i: number) => {
    const ang = Math.atan2(at(p, i)[1] - c[1], at(p, i)[0] - c[0]);
    let d = ang - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = ang;
  };
  for (let i = a + 1; i <= b; i++) step(i);
  if (closed) step(a);
  return total;
}

/** Principal-axis aspect ratio (≥ 1) of the points' spread. */
function aspect(p: readonly Vec2[]): number {
  let mx = 0;
  let my = 0;
  for (const q of p) {
    mx += q[0];
    my += q[1];
  }
  mx /= p.length;
  my /= p.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of p) {
    sxx += (q[0] - mx) ** 2;
    syy += (q[1] - my) ** 2;
    sxy += (q[0] - mx) * (q[1] - my);
  }
  const tr = sxx + syy;
  const disc = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  return l2 > 0 ? Math.sqrt(l1 / l2) : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------------------------
// Corners
// ---------------------------------------------------------------------------------------------

/**
 * ShortStraw corner candidates: local minima of the straw |p[i+W] − p[i−W]| below 0.95 × its
 * median. Cyclic for closed strokes. Returns indices, sorted.
 */
function strawCorners(
  p: readonly Vec2[],
  cyclic: boolean,
): { corners: number[]; straw: Float64Array } {
  const n = p.length;
  const straw = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cyclic) straw[i] = dist(at(p, (i - W + n) % n), at(p, (i + W) % n));
    else if (i >= W && i < n - W) straw[i] = dist(at(p, i - W), at(p, i + W));
    else continue;
    vals.push(straw[i] as number);
  }
  if (vals.length === 0) return { corners: [], straw };
  vals.sort((x, y) => x - y);
  const t = 0.95 * at(vals, vals.length >> 1);
  const corners: number[] = [];
  // Start scanning at a point above the threshold so a run never wraps.
  let s = 0;
  if (cyclic) {
    while (s < n && (straw[s] as number) < t) s++;
    if (s === n) return { corners: [], straw };
  }
  let k = 0;
  while (k < n) {
    const i = (s + k) % n;
    if ((straw[i] as number) < t) {
      let best = i;
      while (k < n && (straw[(s + k) % n] as number) < t) {
        const j = (s + k) % n;
        if ((straw[j] as number) < (straw[best] as number)) best = j;
        k++;
      }
      corners.push(best);
    } else k++;
  }
  corners.sort((x, y) => x - y);
  return { corners, straw };
}

interface Seg {
  a: number;
  b: number;
  line: LineFit;
  /** Arc-like segment (fits a circle much better than a line). */
  curved: boolean;
}

function makeSeg(p: readonly Vec2[], a: number, b: number, L: number, noise: number): Seg {
  const line = fitLine(p, a, b);
  let curved = false;
  if (line.max > Math.max(SPLIT_DEV * L, noise) && b - a >= 6) {
    const c = fitCircle(p, a, b);
    if (c && c.rms <= 0.03 * c.r && c.rms < line.rms / 3) {
      // Same tests as a whole-stroke arc: uniform turning, and better than two lines (a gently
      // rounded corner also fits a big circle).
      const sub = p.slice(a, b + 1);
      curved =
        Math.abs(sweep(p, c.c, a, b)) >= ARC_MIN_SWEEP &&
        turningConcentration(sub, false) <= TURN_CONCENTRATION &&
        c.rms < twoLineRms(sub);
    }
  }
  return { a, b, line, curved };
}

/** Index of the point of p[a..b] farthest from the chord p[a]→p[b]. */
function farthestFromChord(p: readonly Vec2[], a: number, b: number): number {
  const pa = at(p, a);
  const d = sub(at(p, b), pa);
  const l = Math.hypot(d[0], d[1]);
  let best = -1;
  let bestD = -1;
  for (let i = a + 1; i < b; i++) {
    const v = sub(at(p, i), pa);
    const e = l > 0 ? Math.abs(cross(d, v)) / l : Math.hypot(v[0], v[1]);
    if (e > bestD) {
      bestD = e;
      best = i;
    }
  }
  return best;
}

/**
 * Segments p (a resampled open polyline; a closed stroke is rotated to start at a corner and
 * has its first point repeated at the end) at `cuts`, then splits, drops hooks and merges.
 */
function segmentStroke(
  p: readonly Vec2[],
  cuts: readonly number[],
  L: number,
  angleTolerance: number,
  noise: number,
): Seg[] {
  const last = p.length - 1;
  const bounds = [...new Set([0, ...cuts.filter((c) => c > 0 && c < last), last])].sort(
    (x, y) => x - y,
  );
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < bounds.length; i++)
    segs.push(makeSeg(p, at(bounds, i), at(bounds, i + 1), L, noise));

  // Split: neither a line nor an arc → cut at the farthest point from the chord.
  for (let guard = 0; guard < 32; guard++) {
    const k = segs.findIndex(
      (s) => !s.curved && s.line.max > Math.max(SPLIT_DEV * L, noise) && s.b - s.a >= 4,
    );
    if (k < 0) break;
    const s = at(segs, k);
    const m = farthestFromChord(p, s.a, s.b);
    if (m <= s.a || m >= s.b) break;
    segs.splice(k, 1, makeSeg(p, s.a, m, L, noise), makeSeg(p, m, s.b, L, noise));
  }

  // Hooks: tiny segments (corner overshoot, rounded corners, ticks at pen-down/up) are dropped;
  // their neighbours' fitted lines meet at the corner instead. Tiny = short against the stroke,
  // or short against both neighbours (a rounded corner of a small rectangle).
  const segLen = (s: Seg) => pathLength(p.slice(s.a, s.b + 1));
  for (let guard = 0; guard < 32 && segs.length > 1; guard++) {
    const lens = segs.map(segLen);
    let k = -1;
    let shortest = Number.POSITIVE_INFINITY;
    lens.forEach((l, i) => {
      const near = Math.min(
        lens[i - 1] ?? Number.POSITIVE_INFINITY,
        lens[i + 1] ?? Number.POSITIVE_INFINITY,
      );
      const tiny = l < TINY * L || (l < HOOK_RELATIVE * near && l < 2.5 * TINY * L);
      if (tiny && l < shortest) {
        shortest = l;
        k = i;
      }
    });
    if (k < 0) break;
    segs.splice(k, 1);
  }

  // Merge nearly collinear neighbours, smallest turn first.
  const mergeAngle = Math.max(MERGE_ANGLE, 1.5 * angleTolerance);
  for (let guard = 0; guard < 64 && segs.length > 1; guard++) {
    let k = -1;
    let bestTurn = Number.POSITIVE_INFINITY;
    let merged: Seg | null = null;
    for (let i = 0; i + 1 < segs.length; i++) {
      const s = at(segs, i);
      const t = at(segs, i + 1);
      if (s.curved || t.curved) continue;
      const turn = Math.abs(angleBetween(s.line.u, t.line.u));
      if (turn >= MERGE_WIDE || turn >= bestTurn) continue;
      const m = makeSeg(p, s.a, t.b, L, noise);
      if (turn < mergeAngle || (m.line.max <= Math.max(MERGE_DEV * L, noise) && !m.curved)) {
        k = i;
        bestTurn = turn;
        merged = m;
      }
    }
    if (k < 0 || !merged) break;
    segs.splice(k, 2, merged);
  }
  return segs;
}

// ---------------------------------------------------------------------------------------------
// Clean-up
// ---------------------------------------------------------------------------------------------

interface CleanLine {
  /** A point on the line. */
  c: Vec2;
  u: Vec2;
  snap: 'h' | 'v' | null;
}

/** Intersection of two lines; exact coordinates for snapped (horizontal/vertical) lines. */
function intersect(l1: CleanLine, l2: CleanLine, fallback: Vec2): Vec2 {
  if (l1.snap === 'h' && l2.snap === 'v') return [l2.c[0], l1.c[1]];
  if (l1.snap === 'v' && l2.snap === 'h') return [l1.c[0], l2.c[1]];
  const den = cross(l1.u, l2.u);
  let q: Vec2;
  if (Math.abs(den) < Math.sin(4 * DEG)) {
    // Nearly parallel: the corner sample projected onto both, averaged.
    const a = project(l1, fallback);
    const b = project(l2, fallback);
    q = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  } else {
    const t = cross(sub(l2.c, l1.c), l2.u) / den;
    q = [l1.c[0] + l1.u[0] * t, l1.c[1] + l1.u[1] * t];
  }
  return exactOn(exactOn(q, l1), l2);
}

function project(l: CleanLine, p: Vec2): Vec2 {
  if (l.snap === 'h') return [p[0], l.c[1]];
  if (l.snap === 'v') return [l.c[0], p[1]];
  const t = dot(sub(p, l.c), l.u);
  return [l.c[0] + l.u[0] * t, l.c[1] + l.u[1] * t];
}

function exactOn(q: Vec2, l: CleanLine): Vec2 {
  if (l.snap === 'h') return [q[0], l.c[1]];
  if (l.snap === 'v') return [l.c[0], q[1]];
  return q;
}

function axisSnap(u: Vec2, angleTolerance: number): 'h' | 'v' | null {
  const a = Math.abs(Math.atan2(u[1], u[0]));
  const toH = Math.min(a, Math.PI - a);
  if (toH <= angleTolerance) return 'h';
  if (Math.abs(a - Math.PI / 2) <= angleTolerance) return 'v';
  return null;
}

function snappedDir(u: Vec2, snap: 'h' | 'v' | null): Vec2 {
  if (snap === 'h') return [u[0] >= 0 ? 1 : -1, 0];
  if (snap === 'v') return [0, u[1] >= 0 ? 1 : -1];
  return u;
}

/** Fitted segment lines → snapped lines + which snaps happened. */
function cleanLines(
  segs: readonly Seg[],
  closed: boolean,
  angleTolerance: number,
  implied: Set<ConstraintKind>,
): CleanLine[] {
  const lines: CleanLine[] = segs.map((s) => {
    const snap = axisSnap(s.line.u, angleTolerance);
    if (snap === 'h') implied.add('horizontal');
    if (snap === 'v') implied.add('vertical');
    return { c: s.line.c, u: snappedDir(s.line.u, snap), snap };
  });
  // Right-angle snap between neighbours that aren't both axis-aligned. A line is rotated (about
  // its centroid) at most once and never after serving as a reference, so a chain of right
  // angles stays exact. Squared against a horizontal/vertical line, a line becomes vertical/
  // horizontal itself (reported as such: the simpler constraint).
  const locked = lines.map((l) => l.snap !== null);
  const square = (ref: CleanLine, line: CleanLine, s: number) => {
    line.u = [-s * ref.u[1], s * ref.u[0]];
    if (ref.snap) {
      line.snap = ref.snap === 'h' ? 'v' : 'h';
      line.u = snappedDir(line.u, line.snap);
      implied.add(line.snap === 'h' ? 'horizontal' : 'vertical');
    } else implied.add('perpendicular');
  };
  const pairs = lines.length - 1 + (closed && lines.length > 2 ? 1 : 0);
  for (let i = 0; i < pairs; i++) {
    const a = at(lines, i);
    const j = (i + 1) % lines.length;
    const b = at(lines, j);
    const turn = angleBetween(a.u, b.u);
    if (Math.abs(Math.abs(turn) - Math.PI / 2) > angleTolerance) continue;
    if (a.snap && b.snap) continue; // H + V is already perpendicular
    if (!locked[j]) square(a, b, Math.sign(turn));
    else if (!locked[i]) square(b, a, -Math.sign(turn));
    else continue;
    locked[i] = true;
    locked[j] = true;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Rectangle
// ---------------------------------------------------------------------------------------------

/**
 * Least-squares rectangle for four sides: common orientation from the circular mean of 4θ
 * (length-weighted), each side's offset from its points. Corners CCW. Null if the sides don't
 * alternate between the two axes.
 */
function fitRectangle(
  p: readonly Vec2[],
  segs: readonly Seg[],
  angleTolerance: number,
): { corners: [Vec2, Vec2, Vec2, Vec2]; axisAligned: boolean } | null {
  let sx = 0;
  let sy = 0;
  for (const s of segs) {
    const th = Math.atan2(s.line.u[1], s.line.u[0]);
    sx += s.line.len * Math.cos(4 * th);
    sy += s.line.len * Math.sin(4 * th);
  }
  let theta = Math.atan2(sy, sx) / 4; // in (−45°, 45°]
  const axisAligned = Math.abs(theta) <= angleTolerance;
  if (axisAligned) theta = 0;
  const e1: Vec2 = axisAligned ? [1, 0] : [Math.cos(theta), Math.sin(theta)];
  const e2: Vec2 = axisAligned ? [0, 1] : [-Math.sin(theta), Math.cos(theta)];
  const axis = segs.map((s) =>
    Math.abs(dot(s.line.u, e1)) >= Math.abs(dot(s.line.u, e2)) ? 0 : 1,
  );
  if (at(axis, 0) === at(axis, 1) || at(axis, 0) !== at(axis, 2) || at(axis, 1) !== at(axis, 3))
    return null;
  // Offset of each side along its normal: mean over its (trimmed) points.
  const offset = segs.map((s, i) => {
    const n = at(axis, i) === 0 ? e2 : e1;
    const count = s.b - s.a + 1;
    const k = count >= 8 ? Math.floor(count * 0.12) : 0;
    let sum = 0;
    for (let j = s.a + k; j <= s.b - k; j++) sum += dot(at(p, j), n);
    return sum / (count - 2 * k);
  });
  const corner = (i: number, j: number): Vec2 => {
    // u along e1 from the e2-side's offset, v along e2 from the e1-side's offset.
    const [ci, cj] = at(axis, i) === 0 ? [j, i] : [i, j];
    const q = at(offset, ci);
    const o = at(offset, cj);
    if (axisAligned) return [q, o];
    return [q * e1[0] + o * e2[0], q * e1[1] + o * e2[1]];
  };
  let corners = [corner(3, 0), corner(0, 1), corner(1, 2), corner(2, 3)];
  let area = 0;
  for (let i = 0; i < 4; i++) area += cross(at(corners, i), at(corners, (i + 1) % 4));
  if (area < 0) corners = [at(corners, 0), at(corners, 3), at(corners, 2), at(corners, 1)];
  return { corners: corners as [Vec2, Vec2, Vec2, Vec2], axisAligned };
}

// ---------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------

/**
 * Whether the stroke closes within `tolerance`; trims an overshoot past the start (or a tail
 * before the end) so the closed path doesn't double back.
 */
function closeStroke(p: readonly Vec2[], tolerance: number, L: number): Vec2[] | null {
  const first = at(p, 0);
  const lastP = at(p, p.length - 1);
  let best = dist(first, lastP);
  let cutEnd = p.length - 1;
  let cutStart = 0;
  // Overshoot: the end runs past the start. Look along the last OVERSHOOT × L (an overshoot is short; an end landing on the first edge further in stays open).
  let s = 0;
  for (let i = p.length - 1; i > 0 && s < OVERSHOOT * L; i--) {
    const d = dist(at(p, i), first);
    if (d < best) {
      best = d;
      cutEnd = i;
      cutStart = 0;
    }
    s += dist(at(p, i), at(p, i - 1));
  }
  s = 0;
  for (let i = 0; i + 1 < p.length && s < OVERSHOOT * L; i++) {
    const d = dist(at(p, i), lastP);
    if (d < best) {
      best = d;
      cutStart = i;
      cutEnd = p.length - 1;
    }
    s += dist(at(p, i), at(p, i + 1));
  }
  if (best > tolerance || best > 0.2 * L) return null;
  const out = p.slice(cutStart, cutEnd + 1);
  return out.length >= MIN_SAMPLES ? out : null;
}

/** Douglas–Peucker simplification (keeps both ends). */
function simplify(p: readonly Vec2[], eps: number): Vec2[] {
  if (p.length <= 2) return [...p];
  const keep = new Uint8Array(p.length);
  keep[0] = 1;
  keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const m = farthestFromChord(p, a, b);
    if (m < 0) continue;
    const pa = at(p, a);
    const d = sub(at(p, b), pa);
    const l = Math.hypot(d[0], d[1]);
    const v = sub(at(p, m), pa);
    const e = l > 0 ? Math.abs(cross(d, v)) / l : Math.hypot(v[0], v[1]);
    if (e > eps) {
      keep[m] = 1;
      stack.push([a, m], [m, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function result(
  shape: RecognizedShape,
  confidence: number,
  implied: Iterable<ConstraintKind> = [],
): StrokeRecognition {
  return { shape, confidence: clamp01(confidence), implied: [...new Set(implied)] };
}

function cleanSamples(samples: readonly StrokeSample[]): Vec2[] {
  const out: Vec2[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === s.x && prev[1] === s.y) continue;
    out.push([s.x, s.y]);
  }
  return out;
}

/**
 * Recognises a freehand stroke (sketch-local mm) as a line, polyline, rectangle, circle, arc or
 * scribble, with clean-up applied. Null for degenerate strokes. See the module comment.
 */
export const recognizeStroke: RecognizeStroke = (samples, options) => {
  const tolerance =
    Number.isFinite(options.tolerance) && options.tolerance > 0 ? options.tolerance : 0;
  const angTol = options.angleTolerance ?? DEFAULT_STROKE_ANGLE_TOLERANCE;
  const raw = cleanSamples(samples);
  if (raw.length < MIN_SAMPLES) return null;
  const D = bboxDiag(raw);
  const rawL = pathLength(raw);
  if (!(rawL > 1e-9) || !(D > 1e-9) || D < 0.75 * tolerance) return null;

  // Resample at ShortStraw spacing. Per-sample jitter inflates the raw path length (slow,
  // densely sampled strokes most), so L — the scale of every relative threshold — is measured on
  // the resampled polyline, whose chords average the jitter out; then resample once more for L.
  const spacing = D / 40;
  const count = (len: number) =>
    Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.round(len / spacing) + 1));
  let open = resample(raw, count(rawL), false);
  let L = pathLength(open);
  const nOpen = count(L);
  if (nOpen !== open.length) {
    open = resample(raw, nOpen, false);
    L = pathLength(open);
  }
  if (L < 1.5 * tolerance) return null;

  // Deviations below this are hand noise whatever the stroke length (tolerance ≈ 2 × pick radius).
  const noise = NOISE * tolerance;

  // --- Scribble: several long, antiparallel passes over the same area -------------------------
  const scribble = scribbleScore(open, L, D);
  if (scribble > 0) return result({ kind: 'scribble', points: open }, scribble);

  // --- Closure --------------------------------------------------------------------------------
  const closedRaw = closeStroke(raw, tolerance, L);
  const closed = closedRaw !== null;
  const loop = closedRaw ? resample(closedRaw, nOpen, true) : open;
  const Lc = closedRaw ? pathLength(loop, true) : L;

  // --- Line -----------------------------------------------------------------------------------
  if (!closed) {
    const f = fitLine(open, 0, open.length - 1, 0);
    if (f.max <= Math.max(LINE_MAX * L, noise) && f.len > 0) {
      const line = lineShape(open, f, angTol);
      if (line) return line;
    }
  }

  // --- Circle / arc ---------------------------------------------------------------------------
  const round = fitCircle(loop);
  if (
    round &&
    round.rms <= ROUND_RMS * round.r &&
    round.max <= ROUND_MAX * round.r &&
    turningConcentration(loop, closed) <= TURN_CONCENTRATION
  ) {
    const sw = sweep(loop, round.c, 0, loop.length - 1, closed);
    const quality = 1 - round.rms / round.r / (ROUND_RMS * 1.6);
    if (Math.abs(sw) >= (closed ? CLOSED_CIRCLE_SWEEP : CIRCLE_SWEEP)) {
      if (aspect(loop) <= CIRCLE_ASPECT) {
        return result({ kind: 'circle', center: round.c, radius: round.r }, 0.55 + 0.45 * quality);
      }
    } else if (
      !closed &&
      Math.abs(sw) >= ARC_MIN_SWEEP &&
      monotonic(loop, round.c, sw) &&
      round.rms < twoLineRms(loop) &&
      // A polyline whose corners all turn one way can fit a circle; its turning still bunches
      // at the corners (measured over a finer window than the circle test). Short arcs are
      // noisy here, so a very good circle fit earns a looser limit.
      turningConcentration(loop, false, ARC_PEAK_WINDOW) <=
        (round.rms <= ARC_GOOD_RMS * round.r ? ARC_PEAK_GOOD : ARC_PEAK) * ARC_PEAK_WINDOW
    ) {
      const toCircle = (q: Vec2): Vec2 => {
        const d = Math.hypot(q[0] - round.c[0], q[1] - round.c[1]);
        return [
          round.c[0] + ((q[0] - round.c[0]) * round.r) / d,
          round.c[1] + ((q[1] - round.c[1]) * round.r) / d,
        ];
      };
      const s = toCircle(at(open, 0));
      const e = toCircle(at(open, open.length - 1));
      // Contract: CCW from start to end. A clockwise stroke swaps the ends.
      const [start, end] = sw >= 0 ? [s, e] : [e, s];
      return result(
        { kind: 'arc', center: round.c, radius: round.r, start, end },
        0.5 + 0.45 * quality,
      );
    }
  }

  // --- Segments -------------------------------------------------------------------------------
  let pts = loop;
  let cuts: number[];
  if (closed) {
    // Rotate the loop to start at its sharpest corner so no side straddles the seam.
    const { corners, straw } = strawCorners(loop, true);
    let start = 0;
    for (const c of corners) if ((straw[c] as number) < (straw[start] as number)) start = c;
    pts = [...loop.slice(start), ...loop.slice(0, start), at(loop, start)];
    const n = loop.length;
    cuts = corners.map((c) => (c - start + n) % n);
  } else {
    cuts = strawCorners(open, false).corners;
  }
  const segs = segmentStroke(pts, cuts, Lc, angTol, noise);
  if (segs.length === 0) return null;

  if (segs.some((s) => s.curved) || (closed && segs.length < 3)) {
    // Curves mixed with lines, or a smooth closed curve that isn't a circle (an oval): a
    // simplified polyline, low confidence (the app keeps the raw stroke).
    const poly = simplify(closed ? pts.slice(0, -1) : pts, 0.004 * Lc);
    return result({ kind: 'polyline', points: poly, closed }, 0.3, closed ? ['coincident'] : []);
  }

  const implied = new Set<ConstraintKind>();
  const worst = Math.max(...segs.map((s) => s.line.rms / Lc));
  const fitQuality = clamp01(1 - worst / 0.01);

  if (!closed && segs.length === 1) {
    const line = lineShape(pts, at(segs, 0).line, angTol);
    if (line) return line;
  }

  if (closed && segs.length === 4) {
    const rectTol = 2 * angTol;
    let worstCorner = 0;
    for (let i = 0; i < 4; i++) {
      const turn = Math.abs(angleBetween(at(segs, i).line.u, at(segs, (i + 1) % 4).line.u));
      worstCorner = Math.max(worstCorner, Math.abs(turn - Math.PI / 2));
    }
    if (worstCorner <= rectTol) {
      const rect = fitRectangle(pts, segs, angTol);
      if (rect) {
        const conf = 0.6 + 0.2 * fitQuality + 0.2 * (1 - worstCorner / rectTol);
        return result(
          { kind: 'rectangle', corners: rect.corners },
          conf,
          rect.axisAligned
            ? ['horizontal', 'vertical', 'coincident']
            : ['parallel', 'perpendicular', 'coincident'],
        );
      }
    }
  }

  // --- Polyline -------------------------------------------------------------------------------
  const lines = cleanLines(segs, closed, angTol, implied);
  const points: Vec2[] = [];
  if (closed) {
    for (let i = 0; i < lines.length; i++) {
      const prev = at(lines, (i - 1 + lines.length) % lines.length);
      points.push(intersect(prev, at(lines, i), at(pts, at(segs, i).a)));
    }
    implied.add('coincident');
  } else {
    points.push(project(at(lines, 0), at(pts, 0)));
    for (let i = 1; i < lines.length; i++) {
      const s = at(segs, i);
      const corner = at(pts, Math.round((at(segs, i - 1).b + s.a) / 2));
      points.push(intersect(at(lines, i - 1), at(lines, i), corner));
    }
    points.push(project(at(lines, lines.length - 1), at(pts, pts.length - 1)));
  }
  return result({ kind: 'polyline', points, closed }, 0.55 + 0.4 * fitQuality, implied);
};

function lineShape(p: readonly Vec2[], f: LineFit, angTol: number): StrokeRecognition | null {
  const snap = axisSnap(f.u, angTol);
  const l: CleanLine = { c: f.c, u: snappedDir(f.u, snap), snap };
  const from = project(l, at(p, 0));
  const to = project(l, at(p, p.length - 1));
  if (dist(from, to) <= 0) return null;
  const quality = clamp01(1 - f.rms / (f.len * 0.012));
  return result(
    { kind: 'line', from, to },
    0.6 + 0.4 * quality,
    snap === 'h' ? ['horizontal'] : snap === 'v' ? ['vertical'] : [],
  );
}

/**
 * Largest share of the stroke's total turning that happens within any window of `frac` of its
 * length: ≈ frac for an arc or circle (uniform curvature), → 1 for a single corner.
 */
function turningConcentration(p: readonly Vec2[], closed: boolean, frac = 0.15): number {
  // Directions of chords over W points (single steps are dominated by jitter), unwrapped. The
  // turning within a window is then the difference of two directions.
  const n = p.length;
  const count = closed ? n : n - W;
  if (count < 2) return 1;
  const theta = new Float64Array(count + (closed ? count : 0));
  let prev = 0;
  for (let i = 0; i < theta.length; i++) {
    const a = at(p, i % n);
    const b = at(p, (i + W) % n);
    const raw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let v = raw;
    if (i > 0) {
      v = prev + anglePi(raw - prev);
    }
    theta[i] = v;
    prev = v;
  }
  const total = closed
    ? (theta[count] as number) - (theta[0] as number)
    : (theta[count - 1] as number) - (theta[0] as number);
  if (Math.abs(total) < 1e-9) return 1;
  const w = Math.max(W + 1, Math.ceil(frac * count));
  let best = 0;
  for (let i = 0; i + w < theta.length && (closed ? i < count : true); i++) {
    best = Math.max(best, Math.abs((theta[i + w] as number) - (theta[i] as number)));
  }
  return best / Math.abs(total);
}

const anglePi = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
};

/** RMS deviation of the best two-line model split at the point farthest from the chord. */
function twoLineRms(p: readonly Vec2[]): number {
  const m = farthestFromChord(p, 0, p.length - 1);
  if (m < 2 || m > p.length - 3) return Number.POSITIVE_INFINITY;
  const a = fitLine(p, 0, m, 0);
  const b = fitLine(p, m, p.length - 1, 0);
  const na = m + 1;
  const nb = p.length - m;
  return Math.sqrt((a.rms * a.rms * na + b.rms * b.rms * nb) / (na + nb));
}

/** The angle around `c` progresses one way (no back-and-forth beyond noise). */
function monotonic(p: readonly Vec2[], c: Vec2, total: number): boolean {
  const sign = Math.sign(total);
  let back = 0;
  let prev = Math.atan2(at(p, 0)[1] - c[1], at(p, 0)[0] - c[0]);
  for (let i = 1; i < p.length; i++) {
    const ang = Math.atan2(at(p, i)[1] - c[1], at(p, i)[0] - c[0]);
    let d = ang - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    if (d * sign < 0) back -= d * sign;
    prev = ang;
  }
  return back <= 0.1 * Math.abs(total);
}

/**
 * > 0 (the confidence) when the stroke is a scribble: ≥ 3 reversals between passes that are
 * each a good part of the stroke's extent, and a path much longer than its bounding box.
 */
function scribbleScore(p: readonly Vec2[], L: number, D: number): number {
  if (L < SCRIBBLE_DENSITY * D) return 0;
  const { corners } = strawCorners(p, false);
  const bounds = [0, ...corners, p.length - 1];
  const dirs: { u: Vec2; len: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const d = sub(at(p, at(bounds, i + 1)), at(p, at(bounds, i)));
    const l = Math.hypot(d[0], d[1]);
    if (l > 0) dirs.push({ u: [d[0] / l, d[1] / l], len: l });
  }
  const longest = Math.max(0, ...dirs.map((d) => d.len));
  const passes = dirs.filter((d) => d.len >= 0.3 * longest);
  let reversals = 0;
  for (let i = 0; i + 1 < passes.length; i++) {
    if (Math.abs(angleBetween(at(passes, i).u, at(passes, i + 1).u)) >= REVERSAL) reversals++;
  }
  if (reversals < SCRIBBLE_REVERSALS || reversals < 0.6 * (passes.length - 1)) return 0;
  return clamp01(0.6 + 0.08 * (reversals - SCRIBBLE_REVERSALS) + 0.05 * (L / D - SCRIBBLE_DENSITY));
}
