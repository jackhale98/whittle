import { uniform } from 'three/tsl';
import { Vector3 } from 'three/webgpu';

/**
 * Per-frame view state read by shaders (ADR-098). `ortho` is 1 while the projection is
 * orthographic; `back` is the camera's back axis (the direction from the scene to the eye
 * everywhere in an orthographic view). Module level, like `overlayDepthBias`, so every material
 * shares them and switching projection recompiles nothing.
 */
export const viewUniforms = {
  ortho: uniform(0),
  back: uniform(new Vector3(0, 0, 1)),
};
