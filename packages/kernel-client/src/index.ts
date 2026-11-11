/**
 * @wren-cad/kernel-client — main-thread entry. Import this from the app; it spawns the kernel
 * worker (./worker.ts) and never loads Wasm on the main thread.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type { AnchorAnswer, AnchorQuery } from '@wren-cad/contracts';
export {
  createKernelClient,
  type KernelClient,
  type KernelClientOptions,
  type KernelStatusStream,
} from './client';
export type {
  ExportedFile,
  ExportShape,
  ImportedBody,
  KernelLowLevelApi,
  KernelProjectionApi,
  KernelWorkerApi,
  ProjectedCurve,
  ProjectedEdge,
  ProjectedLoopEdge,
  ShapeBounds,
  ShapeImportFormat,
} from './kernel-api';
export type { KernelMemoryStats, ModelingWorkerApi, RegenWorkerOptions } from './modeling-api';
export { isStatusMessage, STATUS_MESSAGE_TAG, type StatusMessage } from './protocol';
export type { CompareOutput } from './regen/compare';
export type {
  ReboundRef,
  RegenFeatureStatus,
  RegenMemoryStats,
  RegenOutput,
  RegenSlotStats,
  RegenUnresolvedRef,
} from './regen/engine';
