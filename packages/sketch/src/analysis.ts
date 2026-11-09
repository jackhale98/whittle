/**
 * Degrees-of-freedom analysis at a solved configuration.
 *
 * Method (documented in the package README section of the report / DECISIONS):
 *  1. Build the Jacobian of every active residual row with respect to the *variable* parameters
 *     (grounded ones are constants), by central finite differences of our own residuals.
 *  2. Reduce the unit-normalised rows, in greedy priority order (internal → coincident … →
 *     dimensions, then input order), into a sparse reduced row-echelon form with partial
 *     pivoting. A row that reduces to ~0 is linearly dependent on earlier rows: the constraint
 *     owning it adds no restriction (redundant if *all* its rows are dependent). Rank = number of
 *     pivots; sketch DOF = #variable params − rank. Sparse elimination keeps chain-like sketches
 *     near-linear in cost.
 *  3. Per entity with variable parameter group G, the motions still available to it are the
 *     null space N of J restricted to G. Its rank (pivoted Cholesky of N_G N_Gᵀ) is the entity's
 *     remaining DOF: 0 → `fixed`, equal to the entity's unconstrained DOF → `free`, otherwise
 *     `partial`. (Any null-space basis gives the same rank; the RREF one is sparse.)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DofState, Id } from '@wren-cad/contracts';
import type { Row, SketchModel } from './model';

/** A reduced row whose largest entry is below this is dependent (rows start at unit norm). */
const RANK_TOL = 1e-7;
/** Entries below this are dropped during elimination (keeps rows sparse, removes FD noise). */
const DROP_TOL = 1e-11;
/** Pivot threshold of the per-entity Gram matrix. */
const NULL_TOL = 1e-10;

export interface DofAnalysis {
  dof: number;
  entityDof: Record<Id, DofState>;
  /** Constraints all of whose rows are dependent on earlier ones. */
  redundant: Id[];
}

interface SparseRow {
  row: Row;
  order: number;
  cols: number[];
  vals: number[];
}

function gradient(
  row: Row,
  x: Float64Array,
  grounded: Uint8Array,
): { cols: number[]; vals: number[] } {
  const cols: number[] = [];
  const vals: number[] = [];
  for (const i of row.params) {
    if (grounded[i]) continue;
    const xi = x[i] as number;
    const h = 1e-6 * Math.max(1, Math.abs(xi));
    x[i] = xi + h;
    const fp = row.f(x);
    x[i] = xi - h;
    const fm = row.f(x);
    x[i] = xi;
    const g = (fp - fm) / (2 * h);
    if (Number.isFinite(g) && g !== 0) {
      cols.push(i);
      vals.push(g);
    }
  }
  return { cols, vals };
}

/** Rank of a small symmetric PSD matrix (row-major n×n) by pivoted Cholesky. */
export function psdRank(m: Float64Array, n: number, tol = NULL_TOL): number {
  const a = Float64Array.from(m);
  const used = new Uint8Array(n);
  let rank = 0;
  for (let step = 0; step < n; step++) {
    let p = -1;
    let best = tol;
    for (let i = 0; i < n; i++) {
      const d = a[i * n + i] as number;
      if (!used[i] && d > best) {
        best = d;
        p = i;
      }
    }
    if (p < 0) break;
    used[p] = 1;
    rank++;
    const piv = Math.sqrt(a[p * n + p] as number);
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = used[i] && i !== p ? 0 : (a[i * n + p] as number) / piv;
    for (let i = 0; i < n; i++) {
      if (used[i] && i !== p) continue;
      for (let j = 0; j < n; j++) {
        if (used[j] && j !== p) continue;
        a[i * n + j] = (a[i * n + j] as number) - (col[i] as number) * (col[j] as number);
      }
    }
  }
  return rank;
}

export function analyzeDof(
  model: SketchModel,
  xIn: Float64Array,
  rows: Row[] = model.rows,
): DofAnalysis {
  const x = Float64Array.from(xIn);
  const n = x.length;
  const { grounded } = model;

  // 1. Sparse, unit-normalised gradients, in greedy (priority, input) order.
  const sparse: SparseRow[] = [];
  rows.forEach((row, order) => {
    const g = gradient(row, x, grounded);
    let norm = 0;
    for (const v of g.vals) norm += v * v;
    norm = Math.sqrt(norm);
    sparse.push({ row, order, cols: g.cols, vals: norm > 0 ? g.vals.map((v) => v / norm) : [] });
  });
  sparse.sort((a, b) => a.row.priority - b.row.priority || a.order - b.order);

  // 2. Incremental sparse reduced row-echelon form (partial pivoting on the largest entry).
  //    pivotRow: column → reduced row having a 1 there; every reduced row is zero in the other
  //    pivot columns, so a single pass eliminates all pivots from a new row.
  const pivotRow = new Map<number, Map<number, number>>();
  const colRows = new Map<number, Set<Map<number, number>>>();
  const dependentRows = new Set<Row>();
  const touch = (col: number, r: Map<number, number>) => {
    let set = colRows.get(col);
    if (!set) {
      set = new Set();
      colRows.set(col, set);
    }
    set.add(r);
  };
  for (const r of sparse) {
    const v = new Map<number, number>();
    for (let k = 0; k < r.cols.length; k++) v.set(r.cols[k] as number, r.vals[k] as number);
    for (const col of [...v.keys()]) {
      const pr = pivotRow.get(col);
      if (!pr) continue;
      const a = v.get(col) ?? 0;
      if (a === 0) continue;
      for (const [c, val] of pr) {
        const nv = (v.get(c) ?? 0) - a * val;
        if (Math.abs(nv) < DROP_TOL) v.delete(c);
        else v.set(c, nv);
      }
      v.delete(col);
    }
    let pivot = -1;
    let best = RANK_TOL;
    for (const [c, val] of v) {
      if (Math.abs(val) > best) {
        best = Math.abs(val);
        pivot = c;
      }
    }
    if (pivot < 0) {
      dependentRows.add(r.row);
      continue;
    }
    const pv = v.get(pivot) as number;
    for (const [c, val] of v) v.set(c, val / pv);
    v.set(pivot, 1);
    // Keep the form reduced: clear the new pivot column from earlier rows.
    for (const other of colRows.get(pivot) ?? []) {
      const a = other.get(pivot) ?? 0;
      if (a === 0) continue;
      for (const [c, val] of v) {
        if (c === pivot) continue;
        const nv = (other.get(c) ?? 0) - a * val;
        if (Math.abs(nv) < DROP_TOL) other.delete(c);
        else {
          other.set(c, nv);
          touch(c, other);
        }
      }
      other.delete(pivot);
    }
    colRows.delete(pivot);
    pivotRow.set(pivot, v);
    for (const c of v.keys()) if (c !== pivot) touch(c, v);
  }

  let variable = 0;
  for (let i = 0; i < n; i++) if (!grounded[i]) variable++;
  const rank = pivotRow.size;

  // 3. Per-entity null-space rank. Null-space basis from the RREF: one vector per free column f
  //    (1 at f, −R_i[f] at pivot i). Restricted to an entity's params, row g is e_g for a free g
  //    and −R_i (its free part) for a pivot g; the Gram matrix of those rows has the entity's DOF
  //    as its rank.
  const entityDof: Record<Id, DofState> = {};
  for (const e of model.input.entities) {
    const params = [...new Set(model.entityParams.get(e.id) ?? [])].filter((i) => !grounded[i]);
    if (params.length === 0) {
      entityDof[e.id] = 'fixed';
      continue;
    }
    const vecs = params.map((p): Map<number, number> => {
      const r = pivotRow.get(p);
      if (!r) return new Map([[p, 1]]);
      const out = new Map<number, number>();
      for (const [c, val] of r) if (c !== p) out.set(c, -val);
      return out;
    });
    const g = params.length;
    const m = new Float64Array(g * g);
    for (let i = 0; i < g; i++) {
      for (let j = i; j < g; j++) {
        const a = vecs[i] as Map<number, number>;
        const b = vecs[j] as Map<number, number>;
        const [small, big] = a.size <= b.size ? [a, b] : [b, a];
        let d = 0;
        for (const [c, val] of small) {
          const o = big.get(c);
          if (o !== undefined) d += val * o;
        }
        m[i * g + j] = d;
        m[j * g + i] = d;
      }
    }
    const r = psdRank(m, g);
    const max = model.entityMaxDof.get(e.id) ?? g;
    entityDof[e.id] = r === 0 ? 'fixed' : r >= max ? 'free' : 'partial';
  }

  // Redundant: every row of the constraint is dependent on earlier ones.
  const redundant: Id[] = [];
  for (const c of model.active) {
    const rs = model.rowsByOwner.get(c.id);
    if (!rs || rs.length === 0) continue;
    if (rs.every((r) => dependentRows.has(r))) redundant.push(c.id);
  }

  return { dof: variable - rank, entityDof, redundant };
}
