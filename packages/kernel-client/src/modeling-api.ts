/**
 * The kernel worker's full Comlink surface from M1 on: the contracts' `ModelingApi` (regen engine,
 * references, part export/import) plus the low-level `KernelLowLevelApi` calls. Independent of the
 * worker global so Node tests can drive it directly; src/worker.ts wires it to Comlink.
 *
 * Every mesh / byte buffer in a result is a fresh copy registered with Comlink's `transfer()`, so
 * crossing the worker boundary moves it instead of cloning it, and the engine's caches stay intact.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ModelingApi, RegenRequest } from '@whittle/contracts';
import { createSketchSolverCore } from '@whittle/sketch/core';
import { transfer } from 'comlink';
import {
  createKernelApi,
  type KernelApiDeps,
  type KernelApiInternals,
  type KernelLowLevelApi,
} from './kernel-api';
import { meshListTransferables, regenTransferables } from './regen/buffers';
import {
  RegenEngine,
  type RegenEngineOptions,
  type RegenOutput,
  type SketchSolve,
} from './regen/engine';

/**
 * Everything the kernel worker exposes over Comlink (M1): the contracts' `ModelingApi` (a subtype
 * of it — `regenerate` resolves to `RegenOutput`, which adds per-feature `warnings` and `ghosts`,
 * proposed for the contract) plus the low-level `KernelLowLevelApi` calls.
 */
export type ModelingWorkerApi = Omit<ModelingApi, 'regenerate'> &
  KernelLowLevelApi & {
    regenerate(request: RegenRequest): Promise<RegenOutput>;
  };

export interface ModelingApiDeps extends KernelApiDeps {
  /** Bundler-resolved URL of `planegcs.wasm` (browser). Omit in Node. */
  planegcsWasmUrl?: string;
  /** Override the sketch solver (tests). Default: `@whittle/sketch/core`, loaded on first use. */
  sketchSolver?: () => Promise<SketchSolve>;
  regen?: RegenEngineOptions;
}

/** Extra surface for tests and diagnostics; not part of the Comlink contract. */
export interface ModelingApiInternals extends KernelApiInternals {
  readonly engine: RegenEngine;
}

/** What `createModelingApi` returns: the Comlink surface plus test/diagnostic internals. */
export type ModelingApiImpl = ModelingWorkerApi & ModelingApiInternals;

// Compile-time proof that the worker surface implements the contract exactly.
type Implements<T, U extends T> = U;
export type _ContractCheck = Implements<ModelingApi & KernelLowLevelApi, ModelingWorkerApi>;

export function createModelingApi(deps: ModelingApiDeps): ModelingApiImpl {
  const kernel = createKernelApi(deps);
  const solverOptions = deps.planegcsWasmUrl === undefined ? {} : { wasmUrl: deps.planegcsWasmUrl };
  const engine = new RegenEngine({
    kernel,
    sketchSolver: deps.sketchSolver ?? (() => createSketchSolverCore(solverOptions)),
    ...(deps.regen === undefined ? {} : { options: deps.regen }),
  });
  return {
    init: (options) => kernel.init(options),
    execFeature: (feature, inputs) => kernel.execFeature(feature, inputs),
    mesh: (shape, options) => kernel.mesh(shape, options),
    massProperties: (shape, density) => kernel.massProperties(shape, density),
    // Shapes in regen results belong to the engine's cache; releasing one would corrupt it.
    release: async (shape) => {
      if (!engine.ownsHandle(shape)) await kernel.release(shape);
    },
    fingerprints: (shape) => kernel.fingerprints(shape),
    exportShapes: (shapes, format, options) => kernel.exportShapes(shapes, format, options),
    importShapes: (bytes, format) => kernel.importShapes(bytes, format),
    configureThreads: (count) => kernel.configureThreads(count),
    liveHandleCount: () => kernel.liveHandleCount(),
    engine,

    async regenerate(request) {
      const result = await engine.regenerate(request);
      return transfer(result, regenTransferables(result));
    },
    refFor: (partId, query) => engine.refFor(partId, query),
    async exportPart(partId, format, options) {
      const r = await engine.exportPart(partId, format, options);
      return r.ok ? transfer(r, [r.bytes.buffer as ArrayBuffer]) : r;
    },
    async importFile(bytes, format) {
      const r = await engine.importFile(bytes, format);
      return r.ok ? transfer(r, meshListTransferables(r.bodies.map((b) => b.mesh))) : r;
    },
    closePart: (partId) => engine.closePart(partId),
  };
}
