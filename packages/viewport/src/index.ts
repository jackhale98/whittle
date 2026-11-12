export {
  ADDED_FILL_OPACITY,
  COMPARE_COLORS,
  compareBounds,
  DEFAULT_GHOST_OPACITY,
  effectiveOpacity,
  ghostOpacityOf,
  REMOVED_FILL_OPACITY,
  sameGeometry,
  sideVisibility,
} from './compare';
export * as gestureConstants from './constants';
export { edgesToSegments, meshBuffersToGeometry } from './geometry';
export type { GestureOutput, PointerKind, PointerSample } from './gestures';
export { GestureRecognizer } from './gestures';
export { closestOnPolyline, defaultTolerance, distPointSegment2D } from './pick';
export type { PlaneFrame } from './plane';
export { lookAtPlanePose, rayToPlane } from './plane';
export { boundaryEdges, buildPrism } from './prism';
export {
  axisEnds,
  dashDotSegments,
  MIN_ORIGIN_EXTENT,
  originReferences,
  outlineSegments,
  planeCorners,
  rayHitsPlane,
} from './refgeom';
export { entityColor } from './sketchStyle';
export type {
  BodyMaterialState,
  CameraState,
  CompareStats,
  FitOptions,
  PickStats,
  ReferenceFrame,
  ReferenceStats,
  TouchStats,
  ViewportEngine,
  ViewportEngineOptions,
  ViewportEventMap,
  ViewportReference,
} from './viewport';
export { createViewport } from './viewport';
export {
  boundsCenter,
  boundsRadius,
  cameraPositionFor,
  clipPlanes,
  type FrameInsets,
  fitDistance,
  fitInsetFrame,
  gridCellSize,
  unionBounds,
  VIEW_DIRECTIONS,
} from './views';
export {
  DEFAULT_FULL_SCALE,
  findMotionDevice,
  MOTION_DEVICES,
  MOTION_USAGE,
  MOTION_USAGE_PAGE,
  MOTION_VENDOR_IDS,
  type MotionDeviceInfo,
  motionDeviceFilters,
} from './motion/devices';
export {
  createMotionInput,
  type HIDDeviceLike,
  type HIDInputReportEventLike,
  type HIDLike,
  hasWebHID,
  isMotionDevice,
  type MotionInput,
  type MotionInputOptions,
  NO_REPORTS_MS,
  PAIRED_FLAG_KEY,
  STATE_THROTTLE_MS,
} from './motion/hid';
export {
  isWheelEcho,
  MOTION_MAX_DT_S,
  MOTION_WHEEL_ECHO_MS,
  MotionIntegrator,
} from './motion/integrate';
export {
  AxisAccumulator,
  buttonChanges,
  conditionAxes,
  deviceToScreen,
  normalizeCounts,
  type ParsedReport,
  parseReport,
  pressedButtons,
} from './motion/report';
