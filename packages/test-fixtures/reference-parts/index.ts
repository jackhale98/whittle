/**
 * The Wren reference-part suite (PLAN section 12A): ten original parts, each with a spec
 * (JSON + Markdown), a spec drawing (SVG), CSWP-style modification stages, and a builder that
 * turns the spec into a `WrenDoc`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  baselineDims,
  buildDoc,
  buildFeatures,
  stageDims,
  stageDoc,
  stepTypes,
} from './lib/builder';
export { type PartSpec, specFor } from './lib/spec';
export type {
  DrawingDimKind,
  DrawingDimSpec,
  DrawingSpec,
  DrawingViewSpec,
  PartDef,
  Pick,
  SketchOp,
  Step,
  WorldAxis,
} from './lib/types';
export { PARTS } from './parts';
