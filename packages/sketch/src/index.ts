/**
 * @wren-cad/sketch — main-thread entry: the worker client, constraint inference, drawing-tool
 * helpers and geometry utilities. Pencil stroke recognition is its own entry,
 * `@wren-cad/sketch/recognize`: the app's initial route imports this root (constraint labels), and a
 * root re-export would pull the recogniser into it as soon as the lazy sketch chunk uses it.
 * Everything here is pure TS; planegcs (Wasm) only loads inside the sketch worker
 * (`@wren-cad/sketch/worker`) or via `@wren-cad/sketch/core` in Node.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  type AnnotationArc,
  type AnnotationArrow,
  type AnnotationOptions,
  type DimensionAnnotation,
  dimensionAnnotation,
  dragDimensionLabel,
} from './annotation';
export {
  closestSplineParam,
  DEFAULT_SPLINE_DEGREE,
  defaultKnots,
  type Interpolation,
  interpolate,
  reverseSpline,
  type SplineDef,
  type SplineGeom,
  sampleParams,
  splineAreaIntegral,
  splineAt,
  splineDefError,
  splinePoint,
  splitSpline,
  subSpline,
} from './bspline';
export {
  createSketchSolverClient,
  DEFAULT_SOLVER_TIMEOUT_MS,
  type SketchSolverCalls,
  type SketchSolverClient,
  type SketchSolverClientOptions,
  SketchSolverTimeout,
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
  closestParam,
  type EllipseGeom,
  type EllipticArcGeom,
  ellipseGeom,
  ellipseParam,
  ellipsePoint,
  ellipticArcGeom,
  indexEntities,
  type LineGeom,
  lineGeom,
  type ParamCurve,
  paramCurve,
  projectOnLine,
  type SampleOptions,
  sampleEntity,
  sampleSketch,
  sketchBounds,
  splineGeom,
} from './geometry';
export { AlignmentClasses, type Axis, reusePoints } from './implied';
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
  constraintRefs,
  isReservedSketchId,
  isSketchReference,
  referenceEntities,
  referenceName,
  SKETCH_ORIGIN,
  SKETCH_REFERENCES,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  usesReferences,
  X_AXIS_END,
  Y_AXIS_END,
} from './references';
export {
  loopPolygon,
  type RegionEdge,
  type RegionLoop,
  type RegionOptions,
  type SketchRegion,
  sketchRegions,
} from './regions';
export {
  arc3PointTool,
  arcCenterTool,
  arcTangentTool,
  circle3PointTool,
  circleCenterTool,
  ellipseFromRadii,
  ellipseTool,
  ellipticArcTool,
  lineTool,
  mergeFragment,
  newId,
  polygonTool,
  polylineTool,
  rectangle3PointTool,
  rectangleCenterTool,
  rectangleCornerTool,
  type SketchFragment,
  type SplineToolOptions,
  setConstruction,
  slotTool,
  splineControlTool,
  splineThroughTool,
  type ToolOptions,
} from './tools';
