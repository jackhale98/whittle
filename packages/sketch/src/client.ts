/**
 * Main-thread side of the sketch solver: spawns the sketch worker and wraps it with Comlink.
 * Never touches Wasm itself (golden rule). Inference is pure TS, so the UI may also call
 * `infer()` from the package root synchronously instead of round-tripping to the worker.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolverApi } from '@whittle/contracts';
import { type Remote, releaseProxy, wrap } from 'comlink';

export interface SketchSolverClientOptions {
  /** Override worker creation (tests, custom bundling). */
  createWorker?: () => Worker;
}

export interface SketchSolverClient {
  api: Remote<SketchSolverApi>;
  /** Terminates the worker; drag sessions are lost and the client is unusable afterwards. */
  dispose(): void;
}

function spawnSketchWorker(): Worker {
  // Literal `new Worker(new URL(...), { type: 'module' })` so Vite/Rollup bundle the worker.
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'whittle-sketch',
  });
}

export function createSketchSolverClient(
  options: SketchSolverClientOptions = {},
): SketchSolverClient {
  const worker = options.createWorker ? options.createWorker() : spawnSketchWorker();
  const api = wrap<SketchSolverApi>(worker);
  let disposed = false;
  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;
      api[releaseProxy]();
      worker.terminate();
    },
  };
}
