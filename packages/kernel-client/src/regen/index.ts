/**
 * @whittle/kernel-client/regen — the parametric regeneration engine (runs in the kernel worker).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  type CompareOutput,
  DIFF_NOISE,
  type DiffKernel,
  type DiffSide,
  geometricDiff,
} from './compare';
export {
  type ExportResult,
  type ImportResult,
  MESH_QUALITY,
  type ReboundRef,
  RegenEngine,
  type RegenEngineDeps,
  type RegenEngineOptions,
  type RegenFeatureStatus,
  type RegenOutput,
  type RegenUnresolvedRef,
  type SketchSolve,
} from './engine';
export { ORIGIN_AXES, ORIGIN_PLANES, planeFrame } from './geometry';
export { hashKey, stableStringify } from './hash';
export {
  frameMatrix,
  importNamingTag,
  placeBrep,
  placeMesh,
  sha256Hex,
  translateName,
} from './imports';
export {
  baseName,
  type Candidate,
  type Resolution,
  type ResolveContext,
  type ResolvedTarget,
  resolveRef,
  TOLERANCE,
} from './resolve';
