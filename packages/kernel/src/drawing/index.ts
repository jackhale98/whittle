/**
 * @wren-cad/kernel/drawing — the drawing worker's kernel (ADR-090 amendment): the
 * `DrawingKernelApi` implementation over the trimmed HLR Wasm build, its request mapping and
 * result decoding, and a main-thread client. Importing this module never loads Wasm; only
 * `createDrawingKernelApi(...).init()` / `loadShape()` inside the drawing worker does.
 *
 * Subpaths: `@wren-cad/kernel/drawing/worker` (the worker entry), and the generated
 * `@wren-cad/kernel/drawing/{single,multi}/{init,wasm}`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  createDrawingKernelApi,
  type DrawingKernelDeps,
  type DrawingKernelInfo,
  type DrawingVariantSource,
  type DrawingWorkerApi,
  defaultCanUseThreads,
} from './api';
export { connectDrawingWorker, type DrawingClient } from './client';
export { type DecodedProjection, decodeCurve, decodeProjection } from './decode';
export {
  DRAWING_ARTEFACT,
  type DrawingInitModule,
  type DrawingKernelModule,
  type FacadeProjectRequest,
  instantiateDrawingKernel,
  type RawDrawingInfo,
  type RawLoadedShape,
  type RawProjectedCurve,
  type RawProjection,
} from './facade';
export { Lru, type LruLimits } from './lru';
export {
  canonicalJson,
  fnv1a64,
  orthonormalFrame,
  PROJECTION_FORMAT,
  projectionKey,
  toFacadeRequest,
  tolerancesFor,
  viewBounds,
} from './request';
