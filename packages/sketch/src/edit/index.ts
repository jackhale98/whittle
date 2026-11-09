/**
 * @whittle/sketch/edit — sketch-editing operations (PLAN §12 M3): offset, convert (linked
 * projections), trim / extend, fillet / chamfer and mirror. Pure functions on `SketchData`
 * (no Wasm, safe on the main thread); each returns a new sketch with a patch summary and an undo
 * label, or a plain-language refusal. Its own entry so the app's initial route doesn't load it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  type ConvertOptions,
  convertEntities,
  fitPolyline,
  type LostSource,
  type ProjectedCurve,
  type ProjectedEdge,
  type ReprojectResult,
  relinkEntities,
  reprojectLinked,
  unlinkEntities,
} from './convert';
export {
  type ChamferOptions,
  type CornerPick,
  chamferCorner,
  type FilletOptions,
  filletCorner,
} from './corner';
export type { EditOptions, SketchData, SketchEdit, SketchEditResult } from './draft';
export { type MirrorOptions, mirrorEntities } from './mirror';
export { type OffsetOptions, type OffsetSide, offsetEntities } from './offset';
export { extendEntity, trimEntity } from './trim';
