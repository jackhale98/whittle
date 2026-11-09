/**
 * planegcs adapter: loads a `SketchModel` into a `GcsWrapper`, solves, and reads the solution
 * back into our parameter vector. Owns no policy (that's solver.ts).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  Algorithm,
  DebugMode,
  GcsWrapper,
  type ModuleStatic,
  type SketchPrimitive,
  SolveStatus,
} from '@salusoft89/planegcs';
import type { Id } from '@wren-cad/contracts';
import { gid, type SketchModel } from './model';

export type PlanegcsModule = ModuleStatic;

/** Convergence threshold handed to planegcs (squared-error based; tighter than its 1e-10). */
const CONVERGENCE = 1e-14;
const MAX_ITERATIONS = 200;

export class GcsSession {
  readonly wrapper: GcsWrapper;
  /** Our param index → planegcs p-param index. */
  private map: Int32Array = new Int32Array(0);

  constructor(mod: PlanegcsModule) {
    this.wrapper = new GcsWrapper(new mod.GcsSystem(), mod);
    this.wrapper.debug_mode = DebugMode.NoDebug;
  }

  /**
   * Clears the system and pushes the model's primitives (positions from `x`), plus `extra`
   * primitives (e.g. temporary drag constraints) at the end.
   */
  load(model: SketchModel, x: Float64Array, extra: SketchPrimitive[] = []) {
    const w = this.wrapper;
    w.clear_data();
    w.set_convergence_threshold(CONVERGENCE);
    w.set_max_iterations(MAX_ITERATIONS);
    for (const p of model.primitives) w.push_primitive(withPositions(p, model, x));
    for (const p of extra) w.push_primitive(p);

    const map = new Int32Array(x.length).fill(-1);
    for (const [id, i] of model.pointIdx) {
      const at = w.p_param_index.get(gid(id));
      if (at === undefined) continue;
      map[i] = at;
      map[i + 1] = at + 1;
    }
    for (const [id, i] of model.radiusIdx) {
      const at = w.p_param_index.get(gid(id));
      if (at !== undefined) map[i] = at;
    }
    for (const [id, el] of model.ellipseIdx) {
      const at = w.p_param_index.get(gid(id));
      if (at !== undefined) map[el.radmin] = at;
    }
    // Grounded scalars (radii) are fixed p-params; grounded points were pushed `fixed`.
    for (let i = 0; i < x.length; i++) {
      const at = map[i] as number;
      if (model.grounded[i] && at >= 0) w.gcs.set_p_param(at, x[i] as number, true);
    }
    this.map = map;
  }

  /** planegcs p-param index of a model param (or -1). */
  paramIndex(i: number): number {
    return this.map[i] ?? -1;
  }

  /** p-param index of an extra (non-model) point pushed via `load(…, extra)`. */
  extraPointIndex(id: string): number {
    const at = this.wrapper.p_param_index.get(id);
    if (at === undefined) throw new Error(`No planegcs point ${id}`);
    return at;
  }

  setFixedParam(at: number, value: number) {
    this.wrapper.gcs.set_p_param(at, value, true);
  }

  /** Solves and applies the solution inside planegcs. */
  solve(algorithm: Algorithm = Algorithm.DogLeg): SolveStatus {
    const status = this.wrapper.solve(algorithm);
    this.wrapper.gcs.apply_solution();
    return status;
  }

  /** Copies planegcs' current parameter values into `x` (in place). */
  read(x: Float64Array) {
    const gcs = this.wrapper.gcs;
    const map = this.map;
    for (let i = 0; i < x.length; i++) {
      const at = map[i] as number;
      if (at >= 0) x[i] = gcs.get_p_param(at);
    }
  }

  conflicting(): Id[] {
    return this.wrapper.get_gcs_conflicting_constraints();
  }

  dispose() {
    this.wrapper.destroy_gcs_module();
  }
}

/** Copies a primitive with positions/radii taken from `x` (so we can re-solve from any state). */
function withPositions(p: SketchPrimitive, model: SketchModel, x: Float64Array): SketchPrimitive {
  if (p.type === 'point') {
    const i = model.pointIdx.get(p.id.slice(2));
    return i === undefined ? { ...p } : { ...p, x: x[i] as number, y: x[i + 1] as number };
  }
  if (p.type === 'circle') {
    const i = model.radiusIdx.get(p.id.slice(2));
    return i === undefined ? { ...p } : { ...p, radius: x[i] as number };
  }
  if (p.type === 'ellipse') {
    const el = model.ellipseIdx.get(p.id.slice(2));
    return el === undefined ? { ...p } : { ...p, radmin: x[el.radmin] as number };
  }
  if (p.type === 'arc') {
    const e = model.index.get(p.id.slice(2));
    if (e?.kind !== 'arc') return { ...p };
    const c = model.pointIdx.get(e.center) as number;
    const s = model.pointIdx.get(e.start) as number;
    const t = model.pointIdx.get(e.end) as number;
    const cx = x[c] as number;
    const cy = x[c + 1] as number;
    const a0 = Math.atan2((x[s + 1] as number) - cy, (x[s] as number) - cx);
    let a1 = Math.atan2((x[t + 1] as number) - cy, (x[t] as number) - cx);
    while (a1 <= a0) a1 += 2 * Math.PI;
    return {
      ...p,
      start_angle: a0,
      end_angle: a1,
      radius: Math.hypot((x[s] as number) - cx, (x[s + 1] as number) - cy),
    };
  }
  return { ...p };
}

export { Algorithm, SolveStatus };
