/**
 * @whittle/sketch — main-thread entry: the worker client, constraint inference, drawing-tool
 * helpers and geometry utilities. Everything here is pure TS; planegcs (Wasm) only loads inside
 * the sketch worker (`@whittle/sketch/worker`) or via `@whittle/sketch/core` in Node.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  createSketchSolverClient,
  type SketchSolverClient,
  type SketchSolverClientOptions,
} from './client';
export {
  constraintLabel,
  describeFor,
  formatAngle,
  formatLength,
  Namer,
} from './explain';
export {
  type ArcGeom,
  angle0,
  anglePi,
  arcGeom,
  type CircleGeom,
  ccwAngle,
  circleGeom,
  circumcircle,
  closestOnEntity,
  closestOnSegment,
  indexEntities,
  type LineGeom,
  lineGeom,
  projectOnLine,
  type SampleOptions,
  sampleEntity,
  sampleSketch,
  sketchBounds,
} from './geometry';
export {
  ANGLE_TOLERANCE,
  bindCandidate,
  type ConstraintDraft,
  CURSOR_POINT,
  DRAWING_ENTITY,
  type DrawingState,
  infer,
} from './inference';
export {
  arc3PointTool,
  arcCenterTool,
  arcTangentTool,
  circle3PointTool,
  circleCenterTool,
  lineTool,
  mergeFragment,
  newId,
  polygonTool,
  polylineTool,
  rectangle3PointTool,
  rectangleCenterTool,
  rectangleCornerTool,
  type SketchFragment,
  setConstruction,
  slotTool,
  type ToolOptions,
} from './tools';
