import type { CameraChange, StandardView, Vec2, Vec3 } from '@wren-cad/contracts';
import CameraControls from 'camera-controls';
import { Vector3 } from 'three/webgpu';
import { bodyBoundsList } from './bodies';
import { compareBounds } from './compare';
import { rayAt, syncCameraMatrices } from './picking';
import { lookAtPlanePose, type PlaneFrame, rayToPlane } from './plane';
import { requestRender } from './renderLoop';
import type { FitOptions } from './types';
import { type CubeHit, ViewCube } from './viewcube';
import type { ViewportImpl } from './viewport';
import {
  type Bounds,
  boundsCenter,
  boundsRadius,
  cameraPositionFor,
  fitDistance,
  fitInsetFrame,
  unionBounds,
  VIEW_DIRECTIONS,
} from './views';

export function fitAll(vp: ViewportImpl, animate = true, options: FitOptions = {}): void {
  let bounds: Bounds | undefined;
  if (options.includeOverlay && vp.compare) {
    const ob = compareBounds(vp.compare.overlay);
    if (ob) bounds = unionBounds([...bodyBoundsList(vp), ob]) ?? undefined;
  }
  fitTo(vp, currentDirection(vp), animate, true, bounds);
}

export function setView(vp: ViewportImpl, view: StandardView, animate = true): void {
  fitTo(vp, VIEW_DIRECTIONS[view], animate);
}

export function setViewDirection(vp: ViewportImpl, dir: Vec3, animate = true): void {
  fitTo(vp, dir, animate);
}

export function setReducedMotion(vp: ViewportImpl, reduced: boolean): void {
  vp.reducedMotion = reduced;
  configureControls(vp);
}

export function screenToPlane(
  vp: ViewportImpl,
  x: number,
  y: number,
  plane: PlaneFrame,
): Vec2 | null {
  const ray = rayAt(vp, x, y);
  return rayToPlane(ray.origin, ray.dir, plane)?.local ?? null;
}

export function worldToScreen(
  vp: ViewportImpl,
  point: Vec3,
): { x: number; y: number; visible: boolean } {
  syncCameraMatrices(vp);
  const v = new Vector3(point[0], point[1], point[2]).project(vp.camera);
  const w = vp.canvas.clientWidth;
  const h = vp.canvas.clientHeight;
  const eye = new Vector3(point[0], point[1], point[2]).applyMatrix4(vp.camera.matrixWorldInverse);
  return {
    x: (v.x * 0.5 + 0.5) * w,
    y: (1 - (v.y * 0.5 + 0.5)) * h,
    visible: eye.z < 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
  };
}

export function lookAtPlane(vp: ViewportImpl, plane: PlaneFrame, animate = true): void {
  const target = vp.controls.getTarget(new Vector3());
  const pos = vp.controls.getPosition(new Vector3());
  const pose = lookAtPlanePose(
    plane,
    [target.x, target.y, target.z],
    Math.max(pos.distanceTo(target), vp.sceneRadius * 0.2),
  );
  const rolled = resetRoll(vp);
  const transition = animate && !vp.reducedMotion && !rolled;
  vp.cameraAwake = true;
  void vp.controls.setLookAt(
    pose.position[0],
    pose.position[1],
    pose.position[2],
    pose.target[0],
    pose.target[1],
    pose.target[2],
    transition,
  );
  if (!transition) vp.controls.update(0);
  requestRender(vp);
}

export function createViewCube(vp: ViewportImpl): void {
  const host = vp.canvas.parentElement ?? document.body;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const touch =
    typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches === true;
  vp.cube = new ViewCube({
    host,
    colors: vp.ui,
    touch,
    onSelect: (hit: CubeHit) => vp.setViewDirection(hit.dir, true),
  });
  vp.cube.place(vp.canvas, vp.frameInsets);
}

export function configureControls(vp: ViewportImpl): void {
  const c = vp.controls;
  const A = CameraControls.ACTION;
  // M3.5 (ADR-046): camera-controls only handles the wheel and two/three-finger touch. Every
  // mouse button (and one-finger / pen orbit) is driven by NavigationMachine in this file, so
  // the pivot is picked at the cursor, left drag never navigates and a drag follows the
  // pointer 1:1.
  c.mouseButtons.left = A.NONE;
  c.mouseButtons.right = A.NONE;
  c.mouseButtons.middle = A.NONE;
  // The wheel is ours (`onWheel`): zoom toward the surface under the cursor, one ratio per
  // notch. camera-controls' own wheel dolly scales the distance to its *target* and eases with
  // `draggingSmoothTime`, which is 0 here, so it jumped and crawled near the target.
  c.mouseButtons.wheel = A.NONE;
  c.touches.one = A.NONE;
  c.touches.two = A.TOUCH_DOLLY_TRUCK;
  c.touches.three = A.TOUCH_TRUCK;
  c.dollyToCursor = true;
  c.dollySpeed = vp.navigation.invertZoom ? -1 : 1;
  // Programmatic moves (fit, setView, lookAtPlane, wheel) ease; dragging never does.
  c.smoothTime = vp.reducedMotion ? 0 : 0.18;
  c.draggingSmoothTime = 0;
}

export function zoomTo(vp: ViewportImpl, point: Vec3, radius: number, animate = true): void {
  const distance = fitDistance(Math.max(radius, 1e-6) * 2, vp.camera.fov, vp.camera.aspect || 1, 1);
  const pos = cameraPositionFor(point, currentDirection(vp), distance);
  const transition = animate && !vp.reducedMotion;
  vp.cameraAwake = true;
  void vp.controls.setLookAt(pos[0], pos[1], pos[2], point[0], point[1], point[2], transition);
  if (!transition) vp.controls.update(0);
  requestRender(vp);
}

export function getRoll(vp: ViewportImpl): number {
  const t = vp.controls.getTarget(new Vector3());
  const f = vp.controls.getPosition(new Vector3()).sub(t).negate().normalize();
  const z = new Vector3(0, 0, 1);
  const zp = z.addScaledVector(f, -f.dot(z));
  if (zp.lengthSq() < 1e-8) return 0;
  zp.normalize();
  const up = vp.camera.up.clone().addScaledVector(f, -f.dot(vp.camera.up)).normalize();
  return Math.atan2(new Vector3().crossVectors(zp, up).dot(f), zp.dot(up));
}

/** Two-finger twist: roll the camera around its view axis. */
export function applyRoll(vp: ViewportImpl, delta: number): void {
  const t = vp.controls.getTarget(new Vector3());
  const axis = vp.controls.getPosition(new Vector3()).sub(t).negate().normalize();
  vp.camera.up.applyAxisAngle(axis, -delta).normalize();
  vp.controls.applyCameraUp();
  requestRender(vp);
}

/** Back to world +Z up. Returns true when the camera was rolled (the caller then cuts, not tweens). */
export function resetRoll(vp: ViewportImpl): boolean {
  const up = vp.camera.up;
  if (up.x === 0 && up.y === 0 && up.z === 1) return false;
  up.set(0, 0, 1);
  vp.controls.updateCameraUp();
  return true;
}

export function emitCamera(vp: ViewportImpl): void {
  const moving = vp.isCameraMoving();
  if (
    vp.cameraListeners.size > 0 &&
    (vp.cameraChangedSinceEmit || moving !== vp.lastEmittedMoving)
  ) {
    const p = vp.camera.position;
    const t = vp.controls.getTarget(new Vector3());
    const change: CameraChange = {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      moving,
    };
    for (const l of [...vp.cameraListeners]) l(change);
  }
  vp.cameraChangedSinceEmit = false;
  vp.lastEmittedMoving = moving;
}

export function currentDirection(vp: ViewportImpl): Readonly<[number, number, number]> {
  const p = vp.controls.getPosition(new Vector3());
  const t = vp.controls.getTarget(new Vector3());
  const d = p.sub(t);
  if (d.lengthSq() < 1e-12) return VIEW_DIRECTIONS.iso;
  return [d.x, d.y, d.z];
}

export function fitTo(
  vp: ViewportImpl,
  direction: Readonly<[number, number, number]>,
  animate: boolean,
  keepRoll = false,
  bounds?: Bounds,
): void {
  let target = boundsCenter(bounds ?? vp.sceneBounds);
  const radius = bounds ? boundsRadius(bounds) : vp.sceneRadius;
  const ins = vp.frameInsets;
  const w = vp.canvas.clientWidth;
  const h = vp.canvas.clientHeight;
  let distance: number;
  if (w > 0 && h > 0 && (ins.top || ins.right || ins.bottom || ins.left)) {
    const f = fitInsetFrame(radius, vp.camera.fov, w, h, ins);
    distance = f.distance;
    // Camera axes for this direction (and the current roll): right = f x up, up = right x f.
    const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const fwd = new Vector3(-direction[0] / len, -direction[1] / len, -direction[2] / len);
    const right = new Vector3().crossVectors(fwd, vp.camera.up);
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, fwd).normalize();
    target = [
      target[0] + right.x * f.shiftRight + up.x * f.shiftUp,
      target[1] + right.y * f.shiftRight + up.y * f.shiftUp,
      target[2] + right.z * f.shiftRight + up.z * f.shiftUp,
    ];
  } else {
    distance = fitDistance(radius, vp.camera.fov, vp.camera.aspect || 1);
  }
  const pos = cameraPositionFor(target, direction, distance);
  // Standard views are level: undo any twist-roll (cut, since a tween would swing through it).
  const rolled = !keepRoll && resetRoll(vp);
  const transition = animate && !vp.reducedMotion && !rolled;
  // setLookAt is synchronous when transition is false (smoothing is bypassed via a jump).
  vp.cameraAwake = true;
  void vp.controls.setLookAt(pos[0], pos[1], pos[2], target[0], target[1], target[2], transition);
  if (!transition) vp.controls.update(0);
  requestRender(vp);
}
