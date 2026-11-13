import type { Vec3 } from '@wren-cad/contracts';
import { worldPerPixel } from './handles';
import { orthoOverlayDelta, overlayBiasFor, overlayDepthBias, overlayDepthDelta } from './overlays';
import type { ViewportImpl } from './viewport';
import {
  boundsCenter,
  clipPlanes,
  type FrameInsets,
  fitDistance,
  fitInsetFrame,
  insetPan,
  orthoClipPlanes,
} from './views';
import { viewUniforms } from './viewUniforms';
import { type ZoomFrame, zoomFrame } from './zoom';

/**
 * THE projection module (ADR-098). Everything in the viewport that depends on how the camera
 * projects (perspective or orthographic) is here: callers ask for world-per-pixel at a point, the
 * ray through a pixel, a fit distance, a zoom frame, the depth pull, "is this in front of the eye".
 * They never read `camera.fov` or `camera.orthographic`. A new projection changes this file (and
 * `ViewCamera`), nothing else.
 */

/**
 * Keep the camera's projection matrix current for its pose (ADR-098). Orthographic: the view height
 * follows the camera-to-target distance and near/far are derived from the scene bounds. Perspective:
 * the existing distance-based planes. Cheap and idempotent; called before anything reads the matrix.
 */
export function syncProjection(vp: ViewportImpl): void {
  const cam = vp.camera;
  const distance = vp.controls.distance;
  let near: number;
  let far: number;
  if (cam.orthographic) {
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const c = boundsCenter(vp.sceneBounds);
    const centreDepth =
      -((c[0] - (e[12] as number)) * (e[8] as number)) -
      (c[1] - (e[13] as number)) * (e[9] as number) -
      (c[2] - (e[14] as number)) * (e[10] as number);
    ({ near, far } = orthoClipPlanes(centreDepth, vp.sceneRadius));
  } else {
    ({ near, far } = clipPlanes(distance, vp.sceneRadius));
  }
  const focus = cam.orthographic ? distance : cam.focusDistance;
  if (near !== cam.near || far !== cam.far || focus !== cam.focusDistance) {
    cam.near = near;
    cam.far = far;
    cam.focusDistance = focus;
    cam.updateProjectionMatrix();
  }
}

/** Switch projection. Same pose and target, so the apparent size at the target is unchanged. */
export function setProjection(vp: ViewportImpl, orthographic: boolean): void {
  if (vp.camera.orthographic === orthographic) return;
  vp.camera.orthographic = orthographic;
  vp.camera.near = Number.NaN; // force syncProjection to rebuild the matrix
  syncProjection(vp);
  vp.viewVersion++;
}

/** World units per CSS px at `depth` in front of the camera plane (depth is ignored in ortho). */
export function cameraWorldPerPixel(vp: ViewportImpl, depth: number): number {
  return worldPerPixel(
    depth,
    vp.camera.projectionMatrix.elements[5] as number,
    vp.canvas.clientHeight || 1,
    vp.camera.orthographic,
  );
}

/** Unit view direction of the camera. */
export function viewForward(vp: ViewportImpl): Vec3 {
  vp.camera.updateMatrixWorld();
  const e = vp.camera.matrixWorld.elements;
  return [-(e[8] as number), -(e[9] as number), -(e[10] as number)];
}

/**
 * Where a sight line to `point` starts: the camera position in perspective; in orthographic the
 * point straight back along the view direction, just outside the scene's bounding sphere on the
 * camera side (or the point itself when it already is in front of the whole scene). An occlusion
 * test from here to `point` asks "is anything between the point and the eye" without a long
 * segment, which would make the test's tolerance (a fraction of its length) coarse.
 */
export function eyeFor(vp: ViewportImpl, point: Vec3): Vec3 {
  const cam = vp.camera;
  const p = cam.position;
  if (!cam.orthographic) return [p.x, p.y, p.z];
  const f = viewForward(vp);
  const depth = (q: Vec3) => (q[0] - p.x) * f[0] + (q[1] - p.y) * f[1] + (q[2] - p.z) * f[2];
  const r = Math.max(vp.sceneRadius, 1e-3);
  const front = depth(boundsCenter(vp.sceneBounds)) - r * 1.05;
  const t = depth(point) - Math.min(depth(point), front);
  return [point[0] - f[0] * t, point[1] - f[1] * t, point[2] - f[2] * t];
}

/** Distance of `point` from the eye in perspective, from the near plane in orthographic. */
export function depthFromEye(vp: ViewportImpl, point: Vec3): number {
  const cam = vp.camera;
  const p = cam.position;
  if (!cam.orthographic) return Math.hypot(point[0] - p.x, point[1] - p.y, point[2] - p.z);
  const f = viewForward(vp);
  return (point[0] - p.x) * f[0] + (point[1] - p.y) * f[1] + (point[2] - p.z) * f[2] - cam.near;
}

/** The ray through CSS px (x, y): from the camera in perspective, parallel from the near plane in orthographic. */
export function screenRay(vp: ViewportImpl, x: number, y: number): { origin: Vec3; dir: Vec3 } {
  const cam = vp.camera;
  const w = vp.canvas.clientWidth || 1;
  const h = vp.canvas.clientHeight || 1;
  const nx = (x / w) * 2 - 1;
  const ny = -(y / h) * 2 + 1;
  const m = cam.matrixWorld.elements;
  if (cam.orthographic) {
    // Parallel rays along the view direction, starting on the near plane, so everything in the
    // depth range is in front of the origin.
    const pm = cam.projectionMatrix.elements;
    const sx = nx / (pm[0] as number);
    const sy = ny / (pm[5] as number);
    return {
      origin: [
        (m[12] as number) +
          (m[0] as number) * sx +
          (m[4] as number) * sy -
          (m[8] as number) * cam.near,
        (m[13] as number) +
          (m[1] as number) * sx +
          (m[5] as number) * sy -
          (m[9] as number) * cam.near,
        (m[14] as number) +
          (m[2] as number) * sx +
          (m[6] as number) * sy -
          (m[10] as number) * cam.near,
      ],
      dir: [-(m[8] as number), -(m[9] as number), -(m[10] as number)],
    };
  }
  const p = cam.position;
  const e = cam.projectionMatrixInverse.elements;
  // Unproject the NDC point (nx, ny, 0.5) to world space and aim from the camera at it.
  const ux =
    (e[0] as number) * nx + (e[4] as number) * ny + (e[8] as number) * 0.5 + (e[12] as number);
  const uy =
    (e[1] as number) * nx + (e[5] as number) * ny + (e[9] as number) * 0.5 + (e[13] as number);
  const uz =
    (e[2] as number) * nx + (e[6] as number) * ny + (e[10] as number) * 0.5 + (e[14] as number);
  const uw =
    (e[3] as number) * nx + (e[7] as number) * ny + (e[11] as number) * 0.5 + (e[15] as number);
  const vx = ux / uw;
  const vy = uy / uw;
  const vz = uz / uw;
  const dx = (m[0] as number) * vx + (m[4] as number) * vy + (m[8] as number) * vz;
  const dy = (m[1] as number) * vx + (m[5] as number) * vy + (m[9] as number) * vz;
  const dz = (m[2] as number) * vx + (m[6] as number) * vy + (m[10] as number) * vz;
  const l = Math.hypot(dx, dy, dz) || 1;
  return { origin: [p.x, p.y, p.z], dir: [dx / l, dy / l, dz / l] };
}

/** Is a point at view-space z `eyeZ` (negative = in front of the camera plane) drawn at all, depth-wise? */
export function inFrontOfEye(vp: ViewportImpl, eyeZ: number): boolean {
  const cam = vp.camera;
  return cam.orthographic ? -eyeZ >= cam.near && -eyeZ <= cam.far : eyeZ < 0;
}

/** Camera-to-target distance that fits a sphere of `radius` (see `fitDistance`). */
export function fitDistanceFor(vp: ViewportImpl, radius: number, padding = 1.2): number {
  return fitDistance(radius, vp.camera.fov, vp.camera.aspect || 1, padding, vp.camera.orthographic);
}

/** Fit distance and target shift for a sphere in the part of the canvas the insets leave free. */
export function fitInsetFrameFor(
  vp: ViewportImpl,
  radius: number,
  w: number,
  h: number,
  insets: FrameInsets,
) {
  return fitInsetFrame(radius, vp.camera.fov, w, h, insets, 1.2, vp.camera.orthographic);
}

/** Camera truck that keeps the view's content centred when the insets change. */
export function insetPanFor(
  vp: ViewportImpl,
  prev: FrameInsets,
  next: FrameInsets,
  h: number,
  distance: number,
) {
  return insetPan(prev, next, vp.camera.fov, h, distance);
}

/** Zoom-about-an-anchor frame for the wheel: orthographic scales the target distance with the zoom. */
export function zoomFrameAbout(
  vp: ViewportImpl,
  camera: Vec3,
  forward: Vec3,
  anchor: Vec3,
  targetDistance: number,
): ZoomFrame | null {
  return zoomFrame(camera, forward, anchor, vp.camera.orthographic ? targetDistance : undefined);
}

/** The on-screen scale value constant-pixel sprites and dots use (1 / half view height), see `sizeDots`. */
export function pixelScaleP11(vp: ViewportImpl): number {
  return vp.camera.projectionMatrix.elements[5] as number;
}

/** Changes whenever the projection or the view scale does (the ID image and the cube follow it). */
export function projectionKey(vp: ViewportImpl): number[] {
  const e = vp.camera.projectionMatrix.elements;
  return [e[0] as number, e[5] as number, e[11] as number];
}

/** Per-frame shader state: the overlay depth pull (either form) and the orthographic uniforms. */
export function applyProjectionUniforms(vp: ViewportImpl): void {
  const cam = vp.camera;
  if (cam.orthographic) {
    // `clip.z += P22 * delta`: a view-space depth shift (ADR-098).
    overlayDepthBias.value = 0;
    overlayDepthDelta.value = orthoOverlayDelta(cam.focusDistance, cam.far - cam.near);
  } else {
    overlayDepthBias.value = overlayBiasFor();
    overlayDepthDelta.value = 0;
  }
  viewUniforms.ortho.value = cam.orthographic ? 1 : 0;
  const mw = cam.matrixWorld.elements;
  viewUniforms.back.value.set(mw[8] as number, mw[9] as number, mw[10] as number);
}
