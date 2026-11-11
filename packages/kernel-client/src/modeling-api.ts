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

import type {
  Id,
  MeshQuality,
  ModelingApi,
  RegenRequest,
  RegenSlot,
  Result,
} from '@wren-cad/contracts';
import { createSketchSolverCore } from '@wren-cad/sketch/core';
import { transfer } from 'comlink';
import {
  createKernelApi,
  type KernelApiDeps,
  type KernelApiInternals,
  type KernelLowLevelApi,
} from './kernel-api';
import type { AnchorAnswer, AnchorQuery } from './regen/annotations';
import { meshListTransferables, regenTransferables } from './regen/buffers';
import type { CompareOutput } from './regen/compare';
import {
  RegenEngine,
  type RegenEngineOptions,
  type RegenOutput,
  type SketchSolve,
} from './regen/engine';
import type { ReprojectLinked } from './regen/linked';
import { reprojectLinkedSketch } from './regen/linked-sketch';

/**
 * Everything the kernel worker exposes over Comlink (M1): the contracts' `ModelingApi` (a subtype
 * of it — `regenerate` resolves to `RegenOutput`, which adds per-feature `warnings` and `ghosts`,
 * proposed for the contract) plus the low-level `KernelLowLevelApi` calls.
 */
export type ModelingWorkerApi = Omit<ModelingApi, 'regenerate' | 'compare'> &
  KernelLowLevelApi & {
    regenerate(request: RegenRequest): Promise<RegenOutput>;
    /** `GeometricDiff` plus `warnings` for bodies left out (proposed for the contract). */
    compare(
      partId: Id,
      a: RegenSlot,
      b: RegenSlot,
      quality: MeshQuality,
    ): Promise<Result<CompareOutput>>;
    /**
     * Changes the regen engine's cache budget (device tier): `maxSpareResults` applies from the
     * next regen, a lower `maxVersionSlots` (proposed for the contract) releases slots at once.
     */
    configureRegen(options: RegenWorkerOptions): Promise<void>;
    /**
     * M4 (ADR-092 proposal 2, proposed for the contract): anchors of arbitrary refs in the latest
     * regen of a part in `slot` (default `'main'`), resolved with the annotation rules; one answer
     * per query, in order. The drawing import places promoted fillet, chamfer and revolve values
     * with it. `INVALID_INPUT` when the slot has not been regenerated.
     */
    annotationAnchors(
      partId: Id,
      queries: AnchorQuery[],
      slot?: RegenSlot,
    ): Promise<Result<AnchorAnswer[]>>;
  };

/** Runtime-configurable regen engine options (structured-clonable). */
export type RegenWorkerOptions = Pick<RegenEngineOptions, 'maxSpareResults' | 'maxVersionSlots'>;

export interface ModelingApiDeps extends KernelApiDeps {
  /** Bundler-resolved URL of `planegcs.wasm` (browser). Omit in Node. */
  planegcsWasmUrl?: string;
  /** Override the sketch solver (tests). Default: `@wren-cad/sketch/core`, loaded on first use. */
  sketchSolver?: () => Promise<SketchSolve>;
  /**
   * Re-projection of linked (converted) sketch entities on regen. Default: packages/sketch's
   * `reprojectLinked` (`reprojectLinkedSketch`), with the engine's fallback for reference geometry.
   */
  reprojectLinked?: ReprojectLinked;
  regen?: RegenEngineOptions;
}

/**
 * Memory guard (PLAN H1): the kernel worker's memory in one structured-clonable snapshot, for
 * diagnostics and soak tests. In the contract as `ModelingApi.memoryStats()`.
 */
import type { KernelMemoryStats } from '@wren-cad/contracts';

export type { KernelMemoryStats };

/** Extra surface for tests and diagnostics; not part of the Comlink contract. */
export interface ModelingApiInternals extends KernelApiInternals {
  readonly engine: RegenEngine;
  /**
   * Memory guard snapshot (see `KernelMemoryStats`). With every part closed, `liveHandles` is back
   * to its baseline and `regen` holds no entries or handles.
   */
  memoryStats(): Promise<KernelMemoryStats>;
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
    reprojectLinked: deps.reprojectLinked ?? reprojectLinkedSketch,
    ...(deps.regen === undefined ? {} : { options: deps.regen }),
  });
  return {
    init: (options) => kernel.init(options),
    execFeature: (feature, inputs) => kernel.execFeature(feature, inputs),
    mesh: (shape, options) => kernel.mesh(shape, options),
    // Through the engine: cached per handle for regen-owned shapes, serialised with regens.
    massProperties: (shape, density) => engine.massProperties(shape, density),
    // Shapes in regen results belong to the engine's cache; releasing one would corrupt it.
    release: async (shape) => {
      if (!engine.ownsHandle(shape)) await kernel.release(shape);
    },
    fingerprints: (shape) => kernel.fingerprints(shape),
    bounds: (shape) => kernel.bounds(shape),
    exportShapes: (shapes, format, options) => kernel.exportShapes(shapes, format, options),
    importShapes: (bytes, format) => kernel.importShapes(bytes, format),
    configureThreads: (count) => kernel.configureThreads(count),
    measureShapes: (a, b) => kernel.measureShapes(a, b),
    subShapeGeometry: (shape, kind, index) => kernel.subShapeGeometry(shape, kind, index),
    projectEdges: (shape, edges, plane) => kernel.projectEdges(shape, edges, plane),
    projectFaceOutline: (shape, face, plane) => kernel.projectFaceOutline(shape, face, plane),
    liveHandleCount: () => kernel.liveHandleCount(),
    wasmHeapBytes: () => kernel.wasmHeapBytes(),
    engine,
    memoryStats: async () => ({
      liveHandles: kernel.liveHandleCount(),
      wasmHeapBytes: kernel.wasmHeapBytes(),
      regen: engine.memoryStats(),
    }),

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
    closePart: (partId, slot) => engine.closePart(partId, slot),
    configureRegen: (options) => engine.configure(options),
    measure: (partId, a, b) => engine.measure(partId, a, b),
    annotationAnchors: (partId, queries, slot) => engine.annotationAnchors(partId, queries, slot),
    // The diff meshes are fresh kernel buffers that nothing else holds: transferred, not copied.
    async compare(partId, a, b, quality) {
      const r = await engine.compare(partId, a, b, quality);
      return r.ok ? transfer(r, meshListTransferables([...r.value.added, ...r.value.removed])) : r;
    },
    // M4 (ADR-090): BREP bytes of the final shape plus persistent edge/face names. The bytes are
    // a fresh buffer read out of the kernel's file system: transferred, never copied.
    async shapeForDrawing(partId, slot) {
      const r = await engine.shapeForDrawing(partId, slot);
      return r.ok ? transfer(r, [r.value.brep.buffer as ArrayBuffer]) : r;
    },
  };
}
