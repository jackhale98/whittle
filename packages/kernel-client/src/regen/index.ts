/**
 * @wren-cad/kernel-client/regen — the parametric regeneration engine (runs in the kernel worker).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export { changeCause, nameTags, structuralCause, type Walk, type WalkEntry } from './cause';
export { chainOrder } from './chain';
export {
  type CompareOutput,
  DIFF_NOISE,
  type DiffKernel,
  type DiffSide,
  geometricDiff,
} from './compare';
export {
  type BSplineDef,
  defaultKnots,
  ellipsePoint,
  evalBSpline,
  type PreparedBSpline,
  prepareBSpline,
  sampleBSpline,
} from './curves';
export {
  canonicalDir,
  edgeCircle,
  edgeLine,
  faceAxis,
  type GeoQuery,
  type Line,
  lineFrame,
  planeThroughPoints,
} from './datums';
export {
  type ExportResult,
  type ImportResult,
  MESH_QUALITY,
  type ReboundRef,
  RegenEngine,
  type RegenEngineDeps,
  type RegenEngineOptions,
  type RegenFeatureStatus,
  type RegenMemoryStats,
  type RegenOutput,
  type RegenSlotStats,
  type RegenUnresolvedRef,
  type SketchSolve,
} from './engine';
export { ORIGIN_AXES, ORIGIN_PLANES, planeFrame, sampleEntity } from './geometry';
export { hashKey, stableStringify } from './hash';
export { frameMatrix, placeMesh, sha256Hex } from './imports';
export {
  type LinkedCurve,
  type LinkedSource,
  type ProjectedBSpline,
  type ProjectedCurve,
  type ProjectedEllipse,
  type ProjectedEllipticArc,
  type ProjectionApi,
  planeMap,
  projectSketchEntity,
  type ReprojectLinked,
  type ReprojectResult,
  reprojectLinkedFallback,
} from './linked';
export { reprojectLinkedSketch } from './linked-sketch';
export {
  baseName,
  type Candidate,
  isOtherCopy,
  type Resolution,
  type ResolveContext,
  type ResolvedTarget,
  resolveRef,
  TOLERANCE,
} from './resolve';
