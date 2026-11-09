/**
 * B-spline curves for sketches (M3.5, ADR-046 and DECISIONS "Sketch B-splines"): knot defaults,
 * validation, evaluation with derivatives (rational or not), interpolation through points, knot
 * insertion, splitting, closest points and the area integral. Pure TS, no Wasm, safe on the main
 * thread. The conventions here are the ones the kernel uses for exact OCCT edges
 * (`Geom_BSplineCurve(poles, weights, knots, multiplicities, degree, periodic)`):
 *
 *  - **Clamped (non-periodic)**, n poles, degree p (1 ≤ p ≤ n − 1). Default knots 0, 1, …, n − p
 *    with multiplicities p + 1, 1, …, 1, p + 1 (uniform clamped). The curve starts at the first
 *    pole and ends at the last. Given knots must be strictly increasing with end multiplicities
 *    p + 1, interior ones 1…p, and Σ multiplicities = n + p + 1.
 *  - **Periodic (closed)**, n poles (n ≥ p + 1). Default knots 0, 1, …, n with every
 *    multiplicity 1 (uniform periodic; the period is knots[last] − knots[0]). The first and last
 *    multiplicities must be 1 and Σ multiplicities − last = n. The span [k0, k1] uses poles
 *    0…p (OCCT's and planegcs' convention), so a uniform cubic starts at (P0 + 4 P1 + P2) / 6.
 *  - **Weights** omitted = all 1 (non-rational). Given weights must be positive, one per pole.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2 } from '@wren-cad/contracts';

/** The shape data of a spline without its poles (as stored on `SketchBSpline`). */
export interface SplineDef {
  degree: number;
  periodic: boolean;
  weights?: readonly number[];
  knots?: readonly number[];
  multiplicities?: readonly number[];
}

/** A spline with explicit pole positions (sketch space, mm). */
export interface SplineGeom extends SplineDef {
  poles: readonly Vec2[];
}

/** Default degree for the drawing tools and recognition. */
export const DEFAULT_SPLINE_DEGREE = 3;

/** Uniform knots for `n` poles (clamped, or periodic). */
export function defaultKnots(
  n: number,
  degree: number,
  periodic: boolean,
): { knots: number[]; multiplicities: number[] } {
  if (periodic) {
    const knots = Array.from({ length: n + 1 }, (_, i) => i);
    return { knots, multiplicities: knots.map(() => 1) };
  }
  const spans = Math.max(1, n - degree);
  const knots = Array.from({ length: spans + 1 }, (_, i) => i);
  const multiplicities = knots.map((_, i) => (i === 0 || i === spans ? degree + 1 : 1));
  return { knots, multiplicities };
}

/** Why a spline definition is invalid for `n` poles (plain language), or null. */
export function splineDefError(n: number, def: SplineDef): string | null {
  const p = def.degree;
  if (!Number.isInteger(p) || p < 1 || p > 25) return 'its degree must be a whole number from 1';
  if (n < p + 1) return `a degree-${p} spline needs at least ${p + 1} control points`;
  if (def.weights) {
    if (def.weights.length !== n) return 'it needs one weight per control point';
    if (!def.weights.every((w) => Number.isFinite(w) && w > 0)) return 'its weights must be > 0';
  }
  if ((def.knots === undefined) !== (def.multiplicities === undefined))
    return 'knots and multiplicities go together';
  if (!def.knots || !def.multiplicities) return null;
  const k = def.knots;
  const m = def.multiplicities;
  if (k.length !== m.length || k.length < 2) return 'it needs matching knots and multiplicities';
  for (let i = 0; i < k.length; i++) {
    if (!Number.isFinite(k[i] as number)) return 'its knots must be finite';
    if (i > 0 && !((k[i] as number) > (k[i - 1] as number)))
      return 'its knots must be strictly increasing';
    const mi = m[i] as number;
    if (!Number.isInteger(mi) || mi < 1) return 'its multiplicities must be whole numbers ≥ 1';
  }
  const sum = m.reduce((a, b) => a + b, 0);
  if (def.periodic) {
    if (m[0] !== 1 || m[m.length - 1] !== 1)
      return 'a closed spline needs multiplicity 1 at its first and last knot';
    if (m.some((x) => x > p)) return `its multiplicities can't exceed the degree (${p})`;
    if (sum - 1 !== n) return 'its knots do not match its control points';
    return null;
  }
  if (m[0] !== p + 1 || m[m.length - 1] !== p + 1)
    return `an open spline is clamped: its end knots need multiplicity ${p + 1}`;
  for (let i = 1; i + 1 < m.length; i++)
    if ((m[i] as number) > p) return `its multiplicities can't exceed the degree (${p})`;
  if (sum !== n + p + 1) return 'its knots do not match its control points';
  return null;
}

/** Expands distinct knots by multiplicity. */
export function flatKnots(knots: readonly number[], mults: readonly number[]): number[] {
  const out: number[] = [];
  knots.forEach((k, i) => {
    for (let j = 0; j < (mults[i] as number); j++) out.push(k);
  });
  return out;
}

/** Distinct knots and multiplicities of a flat knot vector (values within `eps` merge). */
export function compressKnots(flat: readonly number[], eps = 0): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const k of flat) {
    const last = knots[knots.length - 1];
    if (last !== undefined && Math.abs(k - last) <= eps) mults[mults.length - 1] = (mults[mults.length - 1] as number) + 1;
    else {
      knots.push(k);
      mults.push(1);
    }
  }
  return { knots, mults };
}

/**
 * The evaluation basis of a spline: an open ("unwrapped") flat knot vector and the pole index
 * each of its control points refers to. A periodic spline becomes n + p control points (the first
 * p repeated) over n + 2p + 1 knots; its valid range is one period.
 */
export class SplineBasis {
  readonly degree: number;
  readonly periodic: boolean;
  /** Pole count. */
  readonly n: number;
  /** Unwrapped control point → pole index. */
  readonly ext: Int32Array;
  readonly flat: Float64Array;
  /** Weight per pole, or null (non-rational). */
  readonly weights: Float64Array | null;
  /** Parameter range (one period when periodic). */
  readonly lo: number;
  readonly hi: number;
  readonly knots: readonly number[];
  readonly mults: readonly number[];
  private readonly nd = new Float64Array(3 * 26);
  private readonly ndu: Float64Array;
  private readonly left: Float64Array;
  private readonly right: Float64Array;
  private readonly a: Float64Array;

  constructor(n: number, def: SplineDef) {
    const p = def.degree;
    this.degree = p;
    this.periodic = def.periodic;
    this.n = n;
    const dk = def.knots && def.multiplicities ? null : defaultKnots(n, p, def.periodic);
    this.knots = def.knots ?? (dk as { knots: number[] }).knots;
    this.mults = def.multiplicities ?? (dk as { multiplicities: number[] }).multiplicities;
    const w = def.weights;
    this.weights = w && w.some((x) => x !== 1) ? Float64Array.from(w) : null;
    if (def.periodic) {
      const T = (this.knots[this.knots.length - 1] as number) - (this.knots[0] as number);
      const s = flatKnots(this.knots.slice(0, -1), this.mults.slice(0, -1));
      const flat: number[] = [];
      for (let i = n - p; i < n; i++) flat.push((s[i] as number) - T);
      flat.push(...s);
      for (let i = 0; i <= p; i++) flat.push((s[i] as number) + T);
      this.flat = Float64Array.from(flat);
      this.ext = Int32Array.from({ length: n + p }, (_, i) => i % n);
      this.lo = this.knots[0] as number;
      this.hi = this.knots[this.knots.length - 1] as number;
    } else {
      this.flat = Float64Array.from(flatKnots(this.knots, this.mults));
      this.ext = Int32Array.from({ length: n }, (_, i) => i);
      this.lo = this.flat[p] as number;
      this.hi = this.flat[n] as number;
    }
    const q = p + 1;
    this.ndu = new Float64Array(q * q);
    this.left = new Float64Array(q);
    this.right = new Float64Array(q);
    this.a = new Float64Array(2 * q);
  }

  /** Periodic: `u` brought into [lo, hi); clamped: unchanged (outside = polynomial extension). */
  wrap(u: number): number {
    if (!this.periodic) return u;
    const T = this.hi - this.lo;
    let v = (u - this.lo) % T;
    if (v < 0) v += T;
    return this.lo + v;
  }

  /** Index i of the knot span [flat[i], flat[i+1]) holding `u` (clamped to the valid spans). */
  span(u: number): number {
    const p = this.degree;
    const N = this.ext.length;
    const f = this.flat;
    if (u >= (f[N] as number)) {
      let i = N - 1;
      while (i > p && (f[i] as number) >= (f[i + 1] as number)) i--;
      return i;
    }
    if (u <= (f[p] as number)) {
      let i = p;
      while (i < N - 1 && (f[i] as number) >= (f[i + 1] as number)) i++;
      return i;
    }
    let lo = p;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (u < (f[mid] as number)) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  /**
   * Basis functions and derivatives (Piegl & Tiller A2.3) at `u` up to `order` (≤ 2): returns the
   * span; `this.nd[k * (p + 1) + j]` is the k-th derivative of the function of control point
   * span − p + j. The table is reused by the next call.
   */
  basis(u: number, order: number): number {
    const p = this.degree;
    const q = p + 1;
    const i = this.span(u);
    const f = this.flat;
    const { ndu, left, right, a, nd } = this;
    ndu[0] = 1;
    for (let j = 1; j <= p; j++) {
      left[j] = u - (f[i + 1 - j] as number);
      right[j] = (f[i + j] as number) - u;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        ndu[j * q + r] = (right[r + 1] as number) + (left[j - r] as number);
        const temp = (ndu[r * q + j - 1] as number) / (ndu[j * q + r] as number);
        ndu[r * q + j] = saved + (right[r + 1] as number) * temp;
        saved = (left[j - r] as number) * temp;
      }
      ndu[j * q + j] = saved;
    }
    for (let j = 0; j <= p; j++) nd[j] = ndu[j * q + p] as number;
    const top = Math.min(order, p);
    for (let k = 1; k <= order; k++) for (let j = 0; j <= p; j++) nd[k * q + j] = 0;
    for (let r = 0; r <= p; r++) {
      let s1 = 0;
      let s2 = q;
      a[0] = 1;
      for (let k = 1; k <= top; k++) {
        let d = 0;
        const rk = r - k;
        const pk = p - k;
        if (r >= k) {
          a[s2] = (a[s1] as number) / (ndu[(pk + 1) * q + rk] as number);
          d = (a[s2] as number) * (ndu[rk * q + pk] as number);
        }
        const j1 = rk >= -1 ? 1 : -rk;
        const j2 = r - 1 <= pk ? k - 1 : p - r;
        for (let j = j1; j <= j2; j++) {
          a[s2 + j] =
            ((a[s1 + j] as number) - (a[s1 + j - 1] as number)) /
            (ndu[(pk + 1) * q + rk + j] as number);
          d += (a[s2 + j] as number) * (ndu[(rk + j) * q + pk] as number);
        }
        if (r <= pk) {
          a[s2 + k] = -(a[s1 + k - 1] as number) / (ndu[(pk + 1) * q + r] as number);
          d += (a[s2 + k] as number) * (ndu[r * q + pk] as number);
        }
        nd[k * q + r] = d;
        const t = s1;
        s1 = s2;
        s2 = t;
      }
    }
    let fac = p;
    for (let k = 1; k <= top; k++) {
      for (let j = 0; j <= p; j++) nd[k * q + j] = (nd[k * q + j] as number) * fac;
      fac *= p - k;
    }
    return i;
  }

  /** The basis table of the last `basis` call. */
  get table(): Float64Array {
    return this.nd;
  }

  /**
   * Point and derivatives at `u` (periodic: wrapped) into `out` = [x, y, x′, y′, x″, y″], with
   * pole coordinates read through `px` / `py` (pole index → mm).
   */
  evaluate(
    u: number,
    order: number,
    px: (i: number) => number,
    py: (i: number) => number,
    out: Float64Array = new Float64Array(6),
  ): Float64Array {
    const p = this.degree;
    const q = p + 1;
    const uu = this.wrap(u);
    const i = this.basis(uu, order);
    const nd = this.nd;
    const w = this.weights;
    const ax = [0, 0, 0];
    const ay = [0, 0, 0];
    const aw = [0, 0, 0];
    for (let j = 0; j <= p; j++) {
      const pole = this.ext[i - p + j] as number;
      const x = px(pole);
      const y = py(pole);
      const wt = w ? (w[pole] as number) : 1;
      for (let k = 0; k <= order; k++) {
        const b = (nd[k * q + j] as number) * wt;
        ax[k] = (ax[k] as number) + b * x;
        ay[k] = (ay[k] as number) + b * y;
        aw[k] = (aw[k] as number) + b;
      }
    }
    if (!w) {
      out[0] = ax[0] as number;
      out[1] = ay[0] as number;
      out[2] = ax[1] as number;
      out[3] = ay[1] as number;
      out[4] = ax[2] as number;
      out[5] = ay[2] as number;
      return out;
    }
    const W = aw[0] as number;
    const cx = (ax[0] as number) / W;
    const cy = (ay[0] as number) / W;
    out[0] = cx;
    out[1] = cy;
    if (order >= 1) {
      const dx = ((ax[1] as number) - (aw[1] as number) * cx) / W;
      const dy = ((ay[1] as number) - (aw[1] as number) * cy) / W;
      out[2] = dx;
      out[3] = dy;
      if (order >= 2) {
        out[4] = ((ax[2] as number) - 2 * (aw[1] as number) * dx - (aw[2] as number) * cx) / W;
        out[5] = ((ay[2] as number) - 2 * (aw[1] as number) * dy - (aw[2] as number) * cy) / W;
      } else {
        out[4] = 0;
        out[5] = 0;
      }
    } else {
      out[2] = out[3] = out[4] = out[5] = 0;
    }
    return out;
  }

  /** Pole indices whose basis functions are non-zero at `u` (its span's support). */
  support(u: number): number[] {
    const i = this.span(this.wrap(u));
    const out = new Set<number>();
    for (let j = 0; j <= this.degree; j++) out.add(this.ext[i - this.degree + j] as number);
    return [...out];
  }

  /** Distinct knots strictly inside the range (periodic: every knot but the last). */
  innerKnots(): number[] {
    if (this.periodic) return this.knots.slice(0, -1);
    return this.knots.slice(1, -1);
  }
}

const basisCache = new WeakMap<object, { basis: SplineBasis; def: SplineDef }>();

/** A basis for a spline definition with `n` poles (cached per definition object). */
export function splineBasis(n: number, def: SplineDef): SplineBasis {
  const hit = basisCache.get(def);
  if (
    hit &&
    hit.basis.n === n &&
    hit.def.degree === def.degree &&
    hit.def.periodic === def.periodic &&
    hit.def.knots === def.knots &&
    hit.def.multiplicities === def.multiplicities &&
    hit.def.weights === def.weights
  )
    return hit.basis;
  const basis = new SplineBasis(n, def);
  basisCache.set(def, {
    basis,
    def: {
      degree: def.degree,
      periodic: def.periodic,
      ...(def.knots ? { knots: def.knots } : {}),
      ...(def.multiplicities ? { multiplicities: def.multiplicities } : {}),
      ...(def.weights ? { weights: def.weights } : {}),
    },
  });
  return basis;
}

/** Point (and derivatives) of a spline with explicit poles. */
export function splineAt(g: SplineGeom, u: number, order = 0): Float64Array {
  const b = splineBasis(g.poles.length, g);
  return b.evaluate(
    u,
    order,
    (i) => (g.poles[i] as Vec2)[0],
    (i) => (g.poles[i] as Vec2)[1],
  );
}

export function splinePoint(g: SplineGeom, u: number): Vec2 {
  const r = splineAt(g, u, 0);
  return [r[0] as number, r[1] as number];
}

// ---------------------------------------------------------------------------------------------
// Dense linear solve (interpolation)
// ---------------------------------------------------------------------------------------------

/** Solves A X = B (A n×n row-major, B n×2) by Gaussian elimination; null when singular. */
function solveDense(A: Float64Array, B: Float64Array, n: number): Float64Array | null {
  const a = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let c = 0; c < n; c++) {
    let piv = c;
    let best = Math.abs(a[c * n + c] as number);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(a[r * n + c] as number);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (!(best > 1e-12)) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = a[c * n + k] as number;
        a[c * n + k] = a[piv * n + k] as number;
        a[piv * n + k] = t;
      }
      for (let k = 0; k < 2; k++) {
        const t = b[c * 2 + k] as number;
        b[c * 2 + k] = b[piv * 2 + k] as number;
        b[piv * 2 + k] = t;
      }
    }
    const d = a[c * n + c] as number;
    for (let r = c + 1; r < n; r++) {
      const f = (a[r * n + c] as number) / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[r * n + k] = (a[r * n + k] as number) - f * (a[c * n + k] as number);
      for (let k = 0; k < 2; k++) b[r * 2 + k] = (b[r * 2 + k] as number) - f * (b[c * 2 + k] as number);
    }
  }
  const x = new Float64Array(n * 2);
  for (let r = n - 1; r >= 0; r--) {
    for (let k = 0; k < 2; k++) {
      let s = b[r * 2 + k] as number;
      for (let c = r + 1; c < n; c++) s -= (a[r * n + c] as number) * (x[c * 2 + k] as number);
      x[r * 2 + k] = s / (a[r * n + r] as number);
    }
  }
  return x;
}

// ---------------------------------------------------------------------------------------------
// Interpolation (spline through points)
// ---------------------------------------------------------------------------------------------

export interface Interpolation {
  poles: Vec2[];
  degree: number;
  knots: number[];
  multiplicities: number[];
  /** Curve parameter of each through point (one of `knots`). */
  params: number[];
}

/** Handle poles of an open interpolating spline: ceil((p − 1) / 2) after the start, the rest before the end. */
export function handleCounts(degree: number): [number, number] {
  return [Math.ceil((degree - 1) / 2), Math.floor((degree - 1) / 2)];
}

/**
 * Spline through `points` with its knots at the points' (chord-length, normalised) parameters,
 * so each through point sits exactly at a knot (DECISIONS "Sketch B-splines"):
 *
 *  - open: n = m + p − 1 poles; the ends are the first and last poles; the remaining p − 1 rows
 *    fix the ends: for a cubic, Bessel end tangents (the parabola through the first / last three
 *    points), for other degrees the derivatives of order 2, 3, … vanish there;
 *  - closed: periodic, n = m poles, every through point at a knot (the closing chord ends the
 *    period). Even degrees need an odd point count; the degree drops to fit small point counts.
 *
 * Null when the points are degenerate (repeated consecutive points, or too few).
 */
export function interpolate(
  points: readonly Vec2[],
  degreeIn: number = DEFAULT_SPLINE_DEGREE,
  closed = false,
): Interpolation | null {
  const m = points.length;
  if (m < 2 || (closed && m < 3)) return null;
  const pts = points.map((p) => [p[0], p[1]] as Vec2);
  const loop = closed ? [...pts, pts[0] as Vec2] : pts;
  const chords: number[] = [];
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1] as Vec2;
    const b = loop[i] as Vec2;
    chords.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = chords.reduce((s, c) => s + c, 0);
  if (!(total > 0) || chords.some((c) => !(c > 1e-12 * total))) return null;
  const t: number[] = [0];
  for (const c of chords) t.push((t[t.length - 1] as number) + c / total);
  t[t.length - 1] = 1;

  let p = Math.max(1, Math.floor(degreeIn));
  if (closed) {
    p = Math.min(p, m - 1);
    if (p % 2 === 0 && m % 2 === 0) p = p + 1 <= m - 1 ? p + 1 : p - 1;
    const n = m;
    const def: SplineDef = {
      degree: p,
      periodic: true,
      knots: t,
      multiplicities: t.map(() => 1),
    };
    const basis = new SplineBasis(n, def);
    const A = new Float64Array(n * n);
    const B = new Float64Array(n * 2);
    for (let r = 0; r < m; r++) {
      const i = basis.basis(t[r] as number, 0);
      for (let j = 0; j <= p; j++) {
        const pole = basis.ext[i - p + j] as number;
        A[r * n + pole] = (A[r * n + pole] as number) + (basis.table[j] as number);
      }
      B[r * 2] = (pts[r] as Vec2)[0];
      B[r * 2 + 1] = (pts[r] as Vec2)[1];
    }
    const x = solveDense(A, B, n);
    if (!x) return null;
    return {
      poles: Array.from({ length: n }, (_, i) => [x[i * 2] as number, x[i * 2 + 1] as number]),
      degree: p,
      knots: t,
      multiplicities: t.map(() => 1),
      params: t.slice(0, -1),
    };
  }

  const n = m + p - 1;
  const mults = t.map((_, i) => (i === 0 || i === t.length - 1 ? p + 1 : 1));
  const def: SplineDef = { degree: p, periodic: false, knots: t, multiplicities: mults };
  const basis = new SplineBasis(n, def);
  const q = p + 1;
  const A = new Float64Array(n * n);
  const B = new Float64Array(n * 2);
  let row = 0;
  const put = (u: number, order: number, target: Vec2) => {
    const i = basis.basis(u, order);
    for (let j = 0; j <= p; j++) A[row * n + (i - p + j)] = basis.table[order * q + j] as number;
    B[row * 2] = target[0];
    B[row * 2 + 1] = target[1];
    row++;
  };
  for (let r = 0; r < m; r++) put(t[r] as number, 0, pts[r] as Vec2);
  const [h1, h2] = handleCounts(p);
  if (p === 3) {
    // Bessel ends: the end tangents of the parabolas through the first / last three points.
    putDerivative(basis, A, B, n, row++, 0, 1, besselTangent(pts, t, 0));
    putDerivative(basis, A, B, n, row++, 1, 1, besselTangent(pts, t, 1));
  } else {
    // Other degrees: the derivatives of order 2, 3, … vanish at the ends.
    for (let k = 0; k < h1; k++) putDerivative(basis, A, B, n, row++, 0, k + 2);
    for (let k = 0; k < h2; k++) putDerivative(basis, A, B, n, row++, 1, k + 2);
  }
  const x = solveDense(A, B, n);
  if (!x) return null;
  const poles = Array.from({ length: n }, (_, i): Vec2 => [x[i * 2] as number, x[i * 2 + 1] as number]);
  poles[0] = pts[0] as Vec2;
  poles[n - 1] = pts[m - 1] as Vec2;
  return { poles, degree: p, knots: t, multiplicities: mults, params: t };
}

/** Row `row`: the `order`-th derivative at the start (0) or end (1) of a clamped spline is `value`. */
function putDerivative(
  basis: SplineBasis,
  A: Float64Array,
  B: Float64Array,
  n: number,
  row: number,
  end: 0 | 1,
  order: number,
  value: Vec2 = [0, 0],
) {
  for (const [pole, c] of endDerivativeCoefficients(basis, order, end)) A[row * n + pole] = c;
  B[row * 2] = value[0];
  B[row * 2 + 1] = value[1];
}

/** dC/dt at the start (0) or end (1) of the parabola through the first / last three points. */
function besselTangent(pts: readonly Vec2[], t: readonly number[], end: 0 | 1): Vec2 {
  const m = pts.length;
  const P = (i: number) => pts[end === 0 ? i : m - 1 - i] as Vec2;
  const T = (i: number) => Math.abs((t[end === 0 ? i : m - 1 - i] as number) - (t[end === 0 ? 0 : m - 1] as number));
  const s = end === 0 ? 1 : -1;
  const d01 = sub2(P(1), P(0));
  if (m < 3) return [(s * d01[0]) / T(1), (s * d01[1]) / T(1)];
  const h0 = T(1);
  const h1 = T(2) - T(1);
  const d12 = sub2(P(2), P(1));
  const a = (2 * h0 + h1) / (h0 * (h0 + h1));
  const b = h0 / (h1 * (h0 + h1));
  return [s * (a * d01[0] - b * d12[0]), s * (a * d01[1] - b * d12[1])];
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

/**
 * Coefficients c_i with C^(order)(end) = Σ c_i P_i for a non-rational clamped spline, from the
 * derivative control points Q_i = d (P_{i+1} − P_i) / (u_{i+d+1} − u_{i+1}) (Piegl & Tiller 3.3):
 * a clamped curve's derivative is clamped too, so at an end it is its first (last) control point.
 */
function endDerivativeCoefficients(
  basis: SplineBasis,
  order: number,
  end: 0 | 1,
): Map<number, number> {
  const p = basis.degree;
  const f = basis.flat;
  if (order > p) return new Map();
  let ctrl: Map<number, number>[] = Array.from({ length: basis.n }, (_, i) => new Map([[i, 1]]));
  for (let k = 1; k <= order; k++) {
    const deg = p - k + 1;
    const first = k - 1;
    const next: Map<number, number>[] = [];
    for (let i = 0; i + 1 < ctrl.length; i++) {
      const den = (f[first + i + deg + 1] as number) - (f[first + i + 1] as number);
      const m = new Map<number, number>();
      if (den > 0) {
        const s = deg / den;
        for (const [j, c] of ctrl[i + 1] as Map<number, number>) m.set(j, (m.get(j) ?? 0) + s * c);
        for (const [j, c] of ctrl[i] as Map<number, number>) m.set(j, (m.get(j) ?? 0) - s * c);
      }
      next.push(m);
    }
    ctrl = next;
  }
  return (end === 0 ? ctrl[0] : ctrl[ctrl.length - 1]) as Map<number, number>;
}

// ---------------------------------------------------------------------------------------------
// Knot insertion, splitting, sub-curves
// ---------------------------------------------------------------------------------------------

/** Open B-spline in flat form with homogeneous control points (x·w, y·w, w). */
interface OpenForm {
  p: number;
  flat: number[];
  cw: [number, number, number][];
}

function openForm(g: SplineGeom, periods = 1): OpenForm {
  const n = g.poles.length;
  const b = new SplineBasis(n, g);
  const w = (i: number) => (g.weights ? (g.weights[i] as number) : 1);
  if (!g.periodic) {
    return {
      p: g.degree,
      flat: [...b.flat],
      cw: g.poles.map((q, i) => [q[0] * w(i), q[1] * w(i), w(i)]),
    };
  }
  // Unwrapped over `periods` periods (so a range across the seam is one open piece).
  const p = g.degree;
  const T = b.hi - b.lo;
  const s = flatKnots(b.knots.slice(0, -1), b.mults.slice(0, -1));
  const flat: number[] = [];
  for (let i = n - p; i < n; i++) flat.push((s[i] as number) - T);
  for (let k = 0; k < periods; k++) for (const v of s) flat.push(v + k * T);
  for (let i = 0; i <= p; i++) flat.push((s[i] as number) + periods * T);
  const cw: [number, number, number][] = [];
  for (let i = 0; i < n * periods + p; i++) {
    const j = i % n;
    const q = g.poles[j] as Vec2;
    cw.push([q[0] * w(j), q[1] * w(j), w(j)]);
  }
  return { p, flat, cw };
}

/** Inserts `u` into an open form until its multiplicity is `target` (Boehm, Piegl A5.1). */
function insertKnot(f: OpenForm, u: number, target: number) {
  const p = f.p;
  for (let guard = 0; guard < p + 1; guard++) {
    let s = 0;
    for (const k of f.flat) if (k === u) s++;
    if (s >= target) return;
    // Span k: flat[k] <= u < flat[k+1].
    let k = -1;
    for (let i = 0; i + 1 < f.flat.length; i++) {
      if ((f.flat[i] as number) <= u && u < (f.flat[i + 1] as number)) {
        k = i;
        break;
      }
    }
    if (k < 0) return;
    const out: [number, number, number][] = [];
    for (let i = 0; i <= f.cw.length; i++) {
      if (i <= k - p) out.push(f.cw[i] as [number, number, number]);
      else if (i > k - s) out.push(f.cw[i - 1] as [number, number, number]);
      else {
        const a = (u - (f.flat[i] as number)) / ((f.flat[i + p] as number) - (f.flat[i] as number));
        const P = f.cw[i] as [number, number, number];
        const Q = f.cw[i - 1] as [number, number, number];
        out.push([
          a * P[0] + (1 - a) * Q[0],
          a * P[1] + (1 - a) * Q[1],
          a * P[2] + (1 - a) * Q[2],
        ]);
      }
    }
    f.cw = out;
    f.flat.splice(k + 1, 0, u);
  }
}

/** Clamped spline over [a, b] of an open form (a < b inside its valid range). */
function extract(f: OpenForm, a: number, b: number): SplineGeom {
  const p = f.p;
  insertKnot(f, a, p);
  insertKnot(f, b, p);
  let last = -1;
  for (let i = 0; i < f.flat.length; i++) if (f.flat[i] === a) last = i;
  let firstB = f.flat.indexOf(b);
  if (firstB < 0) firstB = f.flat.length - 1;
  const k = last - p + 1;
  const l = firstB;
  const cw = f.cw.slice(k - 1, l);
  const flat = [
    ...Array.from({ length: p + 1 }, () => a),
    ...f.flat.slice(last + 1, firstB),
    ...Array.from({ length: p + 1 }, () => b),
  ];
  const { knots, mults } = compressKnots(flat);
  const rational = cw.some((c) => Math.abs(c[2] - 1) > 1e-15);
  return {
    poles: cw.map((c): Vec2 => [c[0] / c[2], c[1] / c[2]]),
    degree: p,
    periodic: false,
    knots,
    multiplicities: mults,
    ...(rational ? { weights: cw.map((c) => c[2]) } : {}),
  };
}

/**
 * The part of a spline between parameters `a` and `b` as a clamped spline (the knots inside are
 * kept, the curve is unchanged). For a periodic spline, `b < a` (or b ≤ a) runs across the seam.
 */
export function subSpline(g: SplineGeom, a: number, b: number): SplineGeom {
  const basis = new SplineBasis(g.poles.length, g);
  if (g.periodic) {
    const T = basis.hi - basis.lo;
    const aa = basis.wrap(a);
    let bb = basis.wrap(b);
    if (bb <= aa) bb += T;
    return extract(openForm(g, 2), aa, bb);
  }
  const aa = Math.max(basis.lo, Math.min(a, b));
  const bb = Math.min(basis.hi, Math.max(a, b));
  return extract(openForm(g), aa, bb);
}

/** Splits a clamped spline at `u` (inside its range) into two clamped splines. */
export function splitSpline(g: SplineGeom, u: number): [SplineGeom, SplineGeom] {
  const basis = new SplineBasis(g.poles.length, g);
  return [subSpline(g, basis.lo, u), subSpline(g, u, basis.hi)];
}

// ---------------------------------------------------------------------------------------------
// Closest point, sampling, area
// ---------------------------------------------------------------------------------------------

/** Parameter of the point of the spline nearest `p` (clamped to the range; periodic: wrapped). */
export function closestSplineParam(g: SplineGeom, p: Vec2, samplesPerSpan = 12): number {
  const basis = splineBasis(g.poles.length, g);
  const knots = basis.knots;
  let best = basis.lo;
  let bd = Number.POSITIVE_INFINITY;
  for (let s = 0; s + 1 < knots.length; s++) {
    const k0 = knots[s] as number;
    const k1 = knots[s + 1] as number;
    for (let j = 0; j <= samplesPerSpan; j++) {
      const u = k0 + ((k1 - k0) * j) / samplesPerSpan;
      const q = splinePoint(g, u);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
  }
  return refineParam(g, p, best);
}

/** Newton on f(u) = C′(u)·(C(u) − p), from `u0`. */
export function refineParam(g: SplineGeom, p: Vec2, u0: number): number {
  const basis = splineBasis(g.poles.length, g);
  let u = u0;
  for (let it = 0; it < 12; it++) {
    const r = splineAt(g, u, 2);
    const dx = (r[0] as number) - p[0];
    const dy = (r[1] as number) - p[1];
    const f = (r[2] as number) * dx + (r[3] as number) * dy;
    const df =
      (r[2] as number) ** 2 + (r[3] as number) ** 2 + (r[4] as number) * dx + (r[5] as number) * dy;
    if (!(Math.abs(df) > 1e-300)) break;
    let next = u - f / df;
    if (!basis.periodic) next = Math.max(basis.lo, Math.min(basis.hi, next));
    if (Math.abs(next - u) < 1e-14 * Math.max(1, Math.abs(u))) {
      u = next;
      break;
    }
    u = next;
  }
  return basis.periodic ? basis.wrap(u) : u;
}

/** Parameter values to sample a spline at for a polyline within `tol` mm (ends included). */
export function sampleParams(g: SplineGeom, tol = 0.01, maxSegments = 2048): number[] {
  const basis = splineBasis(g.poles.length, g);
  const knots = basis.knots;
  const spans: { a: number; b: number; n: number }[] = [];
  let total = 0;
  for (let s = 0; s + 1 < knots.length; s++) {
    const a = knots[s] as number;
    const b = knots[s + 1] as number;
    let m2 = 0;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const r = splineAt(g, a + (b - a) * f, 2);
      m2 = Math.max(m2, Math.hypot(r[4] as number, r[5] as number));
    }
    const h = b - a;
    const n = Math.max(2, Math.min(256, Math.ceil(h * Math.sqrt(m2 / (8 * Math.max(tol, 1e-9))))));
    spans.push({ a, b, n });
    total += n;
  }
  const shrink = total > maxSegments ? maxSegments / total : 1;
  const out: number[] = [];
  for (const s of spans) {
    const n = Math.max(1, Math.floor(s.n * shrink));
    for (let j = 0; j < n; j++) out.push(s.a + ((s.b - s.a) * j) / n);
  }
  out.push(basis.hi);
  return out;
}

const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

/** Gauss–Legendre (8 points) of `fn` over [a, b]. */
export function gauss8(fn: (t: number) => number, a: number, b: number): number {
  const h = (b - a) / 2;
  const m = (a + b) / 2;
  let s = 0;
  for (let i = 0; i < 8; i++) s += (GL_W[i] as number) * fn(m + h * (GL_X[i] as number));
  return s * h;
}

/**
 * ½ ∫ (x y′ − y x′) du from `a` to `b` (Green's theorem: the signed area swept from the origin;
 * summed over a closed loop it is the enclosed area, CCW positive). Exact for non-rational
 * splines up to degree 8 (one 8-point rule per knot span).
 */
export function splineAreaIntegral(g: SplineGeom, a: number, b: number): number {
  if (a === b) return 0;
  if (b < a) return -splineAreaIntegral(g, b, a);
  const basis = splineBasis(g.poles.length, g);
  const f = (u: number) => {
    const r = splineAt(g, u, 1);
    return 0.5 * ((r[0] as number) * (r[3] as number) - (r[1] as number) * (r[2] as number));
  };
  // Breakpoints: the knots inside (a, b), across periods for a periodic spline.
  const T = basis.hi - basis.lo;
  const cuts: number[] = [a];
  const ks = basis.knots;
  const k0 = basis.periodic ? Math.floor((a - basis.lo) / T) - 1 : 0;
  const k1 = basis.periodic ? Math.ceil((b - basis.lo) / T) + 1 : 0;
  for (let period = k0; period <= k1; period++) {
    for (const k of ks) {
      const v = k + period * T;
      if (v > a && v < b) cuts.push(v);
    }
  }
  cuts.push(b);
  cuts.sort((x, y) => x - y);
  let s = 0;
  const rational = basis.weights !== null;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i] as number;
    const hi = cuts[i + 1] as number;
    if (hi <= lo) continue;
    if (!rational) s += gauss8(f, lo, hi);
    else {
      // Rational: subdivide for accuracy.
      for (let j = 0; j < 8; j++) s += gauss8(f, lo + ((hi - lo) * j) / 8, lo + ((hi - lo) * (j + 1)) / 8);
    }
  }
  return s;
}

/** The same spline traversed backwards (parameter u ↦ lo + hi − u). */
export function reverseSpline(g: SplineGeom): SplineGeom {
  const basis = new SplineBasis(g.poles.length, g);
  const knots = [...basis.knots].reverse().map((k) => basis.lo + basis.hi - k);
  const mults = [...basis.mults].reverse();
  if (g.periodic) {
    // Reversing a periodic spline shifts its poles: rebuild through an open sub-curve instead.
    return reverseSpline(subSpline(g, basis.lo, basis.hi));
  }
  return {
    poles: [...g.poles].reverse(),
    degree: g.degree,
    periodic: false,
    knots,
    multiplicities: mults,
    ...(g.weights ? { weights: [...g.weights].reverse() } : {}),
  };
}
