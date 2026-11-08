/**
 * Wasm-backed solver entry: `createSketchSolver()` returns a `SketchSolverApi` that lazily loads
 * planegcs. Used by the sketch worker and directly in Node (tests, headless regen). Never import
 * this on the main thread — use `createSketchSolverClient()` from the package root instead.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { init_planegcs_module } from '@salusoft89/planegcs';
import type { SketchSolverApi } from '@whittle/contracts';
import type { PlanegcsModule } from './gcs';
import { SketchSolverCore } from './solver';

export interface SketchSolverOptions {
  /** Bundler-resolved URL of `planegcs.wasm` (browser). Omit in Node. */
  wasmUrl?: string;
}

export interface SketchSolver extends SketchSolverApi {
  /** Resolves once planegcs is loaded (calls also wait for it). */
  ready(): Promise<void>;
  /** Frees the Wasm solver systems. The solver is unusable afterwards. */
  dispose(): void;
}

export async function loadPlanegcs(wasmUrl?: string): Promise<PlanegcsModule> {
  return init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
}

/** Synchronous core once planegcs is loaded (benchmarks, Node tools). */
export async function createSketchSolverCore(
  options: SketchSolverOptions = {},
): Promise<SketchSolverCore> {
  return new SketchSolverCore(await loadPlanegcs(options.wasmUrl));
}

export function createSketchSolver(options: SketchSolverOptions = {}): SketchSolver {
  let core: Promise<SketchSolverCore> | null = null;
  let disposed = false;
  const get = (): Promise<SketchSolverCore> => {
    if (disposed) return Promise.reject(new Error('The sketch solver was disposed'));
    core ??= createSketchSolverCore(options);
    return core;
  };
  return {
    async ready() {
      await get();
    },
    async solve(input) {
      return (await get()).solve(input);
    },
    async beginDrag(input, entity, grab) {
      return (await get()).beginDrag(input, entity, grab);
    },
    async drag(session, to) {
      return (await get()).drag(session, to);
    },
    async endDrag(session) {
      return (await get()).endDrag(session);
    },
    async infer(input, cursor, drawing, tolerance) {
      return (await get()).infer(input, cursor, drawing, tolerance);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void core?.then((c) => c.dispose());
    },
  };
}

export { SketchSolverCore } from './solver';
