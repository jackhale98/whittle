/**
 * Final Newton polish after planegcs converges (DECISIONS ADR-008 item 9).
 *
 * planegcs stops once the squared error is small, and `isSatisfied` accepts residuals up to
 * 1e-7 × sketch size, so a "solved" sketch can be ~1e-5 mm off. Two sketches dimensioned to
 * meet then leave sliver faces where their faces should be coplanar. The polish drives every
 * active residual row (driving dimensions, coincidences, all geometric rows) to ≤ ~1e-11 mm
 * (≤ 1e-13 rad for angular rows) with minimum-norm Gauss–Newton steps:
 *
 *   dx = argmin ‖dx‖  subject to  J dx = −r      (J: variable parameters only)
 *
 * solved as CG on J Jᵀ y = −r, dx = Jᵀ y (Craig's method / CGNE). That keeps the correction as
 * small as possible (under-constrained geometry does not drift), tolerates redundant consistent
 * rows (J Jᵀ singular, but −r lies in its range), and costs O(nnz) per iteration, so it fits the
 * drag budget. Rows are scaled to unit gradient norm first, which does not change the
 * minimum-norm solution of a consistent system but improves conditioning.
 *
 * Contract: geometry that already satisfies every row to the polish tolerance is returned
 * unchanged (bit for bit); a step is only kept when it lowers the worst residual.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Row, SketchModel } from './model';

/** Length rows: absolute target, mm (well inside the 1e-10 mm coplanarity requirement). */
const LEN_TOL = 1e-11;
/** Angular / dimensionless rows, rad. */
const ANG_TOL = 1e-13;
const MAX_NEWTON = 4;
const MAX_CG = 400;

export interface PolishStats {
  /** Newton steps taken (0 when already exact). */
  steps: number;
  /** Worst residual / tolerance before and after (≤ 1 means within tolerance). */
  before: number;
  after: number;
}

function tolerances(model: SketchModel, rows: readonly Row[]): Float64Array {
  // Allow for rounding of coordinates far from the origin (≈ a few ulps of the sketch size).
  const len = LEN_TOL + 4e-16 * model.lengthScale;
  const tol = new Float64Array(rows.length);
  rows.forEach((r, i) => {
    tol[i] = r.angular ? ANG_TOL : len;
  });
  return tol;
}

/** max |f_i| / tol_i; NaN when any row can't be evaluated. */
function worstExcess(rows: readonly Row[], tol: Float64Array, x: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = Math.abs((rows[i] as Row).f(x)) / (tol[i] as number);
    if (!Number.isFinite(v)) return Number.NaN;
    if (v > worst) worst = v;
  }
  return worst;
}

/**
 * Returns polished parameters (a new array). `stats` (optional) receives what happened.
 * Never throws; on degenerate input (NaN residuals) it returns a copy of `x`.
 */
export function polish(
  model: SketchModel,
  xIn: Float64Array,
  rows: readonly Row[] = model.rows,
  stats?: PolishStats,
): Float64Array {
  let x = Float64Array.from(xIn);
  const m = rows.length;
  const tol = tolerances(model, rows);
  let worst = m ? worstExcess(rows, tol, x) : 0;
  if (stats) {
    stats.steps = 0;
    stats.before = worst;
    stats.after = worst;
  }
  if (!(worst > 1)) return x;

  const grounded = model.grounded;
  // CSR Jacobian (scaled rows); rebuilt every Newton step.
  const start = new Int32Array(m + 1);
  let cap = 0;
  for (const r of rows) cap += r.params.length;
  const cols = new Int32Array(cap);
  const vals = new Float64Array(cap);
  const rhs = new Float64Array(m);
  const scaleOf = new Float64Array(m);
  const n = x.length;
  const dx = new Float64Array(n);
  const y = new Float64Array(m);
  const res = new Float64Array(m);
  const p = new Float64Array(m);
  const ap = new Float64Array(m);
  const jtp = new Float64Array(n);

  const jt = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let i = 0; i < m; i++) {
      const vi = v[i] as number;
      if (vi === 0) continue;
      for (let k = start[i] as number; k < (start[i + 1] as number); k++) {
        const c = cols[k] as number;
        out[c] = (out[c] as number) + (vals[k] as number) * vi;
      }
    }
  };
  const jmul = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let k = start[i] as number; k < (start[i + 1] as number); k++) {
        s += (vals[k] as number) * (v[cols[k] as number] as number);
      }
      out[i] = s;
    }
  };

  for (let step = 0; step < MAX_NEWTON; step++) {
    // 1. Scaled Jacobian (central differences of our own residuals) and right-hand side.
    let nnz = 0;
    for (let i = 0; i < m; i++) {
      start[i] = nnz;
      const row = rows[i] as Row;
      const f0 = row.f(x);
      const first = nnz;
      let norm = 0;
      for (const j of row.params) {
        if (grounded[j]) continue;
        const xj = x[j] as number;
        const h = 1e-6 * Math.max(1, Math.abs(xj));
        x[j] = xj + h;
        const fp = row.f(x);
        x[j] = xj - h;
        const fm = row.f(x);
        x[j] = xj;
        const g = (fp - fm) / (2 * h);
        if (!Number.isFinite(g) || g === 0) continue;
        cols[nnz] = j;
        vals[nnz] = g;
        nnz++;
        norm += g * g;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let k = first; k < nnz; k++) vals[k] = (vals[k] as number) / norm;
        scaleOf[i] = norm;
        rhs[i] = -f0 / norm;
      } else {
        // No variable parameter moves this row: it is what it is.
        nnz = first;
        scaleOf[i] = 0;
        rhs[i] = 0;
      }
    }
    start[m] = nnz;

    // 2. CG on (J Jᵀ) y = rhs. The CG residual is the linearised row residual after the step,
    //    so stop when every row would be well inside its tolerance.
    y.fill(0);
    res.set(rhs);
    p.set(rhs);
    let rs = 0;
    for (let i = 0; i < m; i++) rs += (res[i] as number) ** 2;
    const done = () => {
      for (let i = 0; i < m; i++) {
        if (Math.abs((res[i] as number) * (scaleOf[i] as number)) > 0.01 * (tol[i] as number))
          return false;
      }
      return true;
    };
    for (let it = 0; it < MAX_CG && rs > 0 && !done(); it++) {
      jt(p, jtp);
      jmul(jtp, ap);
      let pap = 0;
      for (let i = 0; i < m; i++) pap += (p[i] as number) * (ap[i] as number);
      if (!(pap > 0)) break;
      const alpha = rs / pap;
      let rsNew = 0;
      for (let i = 0; i < m; i++) {
        y[i] = (y[i] as number) + alpha * (p[i] as number);
        res[i] = (res[i] as number) - alpha * (ap[i] as number);
        rsNew += (res[i] as number) ** 2;
      }
      const beta = rsNew / rs;
      rs = rsNew;
      for (let i = 0; i < m; i++) p[i] = (res[i] as number) + beta * (p[i] as number);
    }

    // 3. Step, kept only when it lowers the worst residual.
    jt(y, dx);
    const next = Float64Array.from(x);
    for (let j = 0; j < n; j++) if (!grounded[j]) next[j] = (next[j] as number) + (dx[j] as number);
    const w = worstExcess(rows, tol, next);
    if (!(w < worst)) break;
    x = next;
    worst = w;
    if (stats) {
      stats.steps = step + 1;
      stats.after = w;
    }
    if (worst <= 1) break;
  }
  return x;
}
