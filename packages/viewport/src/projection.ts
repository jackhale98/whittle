import type { Vec3 } from '@wren-cad/contracts';
import { worldPerPixel } from './handles';
import type { ViewportImpl } from './viewport';
import { boundsCenter, clipPlanes, orthoClipPlanes } from './views';

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
