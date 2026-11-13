import type { Vec3 } from '@wren-cad/contracts';
import { Vector3 } from 'three/webgpu';
import { bodyBoundsList } from './bodies';
import {
  WHEEL_MAX_DISTANCE_RADII,
  WHEEL_MIN_DISTANCE_RADII,
  WHEEL_SMOOTH_TAU_S,
} from './constants';
import { WHEEL_SYNC_BVH_TRIANGLES, type WheelState } from './internal';
import { isWheelEcho } from './motion/integrate';
import { navSurfaceHit } from './navControl';
import { rayAt } from './picking';
import { zoomFrameAbout } from './projection';
import { requestRender } from './renderLoop';
import type { ViewportImpl } from './viewport';
import { boundsCenter } from './views';
import {
  anchorStillValid,
  easeDistance,
  missAnchor,
  nextGoalDistance,
  wheelNotches,
  zoomPose,
} from './zoom';

export function wheelPoseIntact(vp: ViewportImpl, w: WheelState): boolean {
  const p = vp.controls.getPosition(new Vector3(), false);
  const tol = 1e-6 * Math.max(1, w.current);
  return (
    Math.abs(p.x - w.lastPos[0]) <= tol &&
    Math.abs(p.y - w.lastPos[1]) <= tol &&
    Math.abs(p.z - w.lastPos[2]) <= tol
  );
}

export function onWheel(vp: ViewportImpl, e: WheelEvent): void {
  if (vp.disposed) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (vp.nav) return; // a drag owns the camera
  // A vendor driver also turns push/pull into wheel events: while 3D mouse motion is arriving and
  // the pointer is still, they are echoes of the same push (ADR-096 item 3).
  const at = performance.now();
  if (isWheelEcho(at, vp.motionState.lastMotionAt, vp.lastPointerMoveAt)) return;
  const notches = wheelNotches(e.deltaY, e.deltaMode, vp.navigation.invertZoom);
  if (notches === 0) return;
  const rect = vp.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const now = performance.now();
  vp.lastActivityAt = now;
  clearTimeout(vp.restTimer);
  vp.restTimer = 0;

  let w = vp.wheel;
  if (w && !(anchorStillValid(w.anchor, x, y, now) && wheelPoseIntact(vp, w))) w = null;
  if (!w) w = beginWheel(vp, x, y, now);
  if (!w) return;
  w.anchor.t = now;
  w.goal = nextGoalDistance(w.goal, notches, w.min, w.max);
  w.settled = false;
  vp.wheel = w;
  vp.cameraAwake = true;
  if (vp.reducedMotion) {
    stepWheel(vp, 0);
    vp.controls.update(0);
  }
  requestRender(vp);
}

/** Resolve the anchor under the cursor and capture the camera frame for a wheel gesture. */
export function beginWheel(vp: ViewportImpl, x: number, y: number, now: number): WheelState | null {
  // Take over from anything in flight (a view transition): continue from where it is heading.
  const pos = vp.controls.getPosition(new Vector3(), true);
  const tgt = vp.controls.getTarget(new Vector3(), true);
  const fwd = tgt.clone().sub(pos);
  if (fwd.lengthSq() < 1e-18) vp.camera.getWorldDirection(fwd);
  fwd.normalize();
  const f: Vec3 = [fwd.x, fwd.y, fwd.z];
  const cam: Vec3 = [pos.x, pos.y, pos.z];
  const dist = pos.distanceTo(tgt);
  if (vp.controls.active) {
    void vp.controls.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
    vp.controls.update(0);
  }
  const ray = rayAt(vp, x, y);
  const hit = navSurfaceHit(vp, x, y, WHEEL_SYNC_BVH_TRIANGLES);
  const centre = bodyBoundsList(vp).length > 0 ? boundsCenter(vp.sceneBounds) : null;
  const point: Vec3 = hit
    ? [hit.point[0], hit.point[1], hit.point[2]]
    : missAnchor(ray.origin, ray.dir, f, centre, dist);
  const frame = zoomFrameAbout(vp, cam, f, point, dist);
  if (!frame) return null;
  const d0 = Math.hypot(cam[0] - point[0], cam[1] - point[1], cam[2] - point[2]);
  const r = Math.max(vp.sceneRadius, 1e-3);
  return {
    anchor: { point, x, y, t: now, source: hit ? 'surface' : 'scene' },
    frame,
    current: d0,
    goal: d0,
    min: Math.min(d0, r * WHEEL_MIN_DISTANCE_RADII),
    max: Math.max(d0, r * WHEEL_MAX_DISTANCE_RADII),
    lastPos: cam,
    settled: true,
  };
}

/** One frame of the wheel ease. Returns true while the camera is still travelling. */
export function stepWheel(vp: ViewportImpl, dt: number, land = false): boolean {
  const w = vp.wheel;
  if (!w || w.settled) return false;
  if (!wheelPoseIntact(vp, w)) {
    vp.wheel = null; // another source moved the camera: drop the gesture
    return false;
  }
  const tau = vp.reducedMotion ? 0 : WHEEL_SMOOTH_TAU_S;
  const next = land ? { value: w.goal, done: true } : easeDistance(w.current, w.goal, dt, tau);
  w.current = next.value;
  const pose = zoomPose(w.frame, w.current);
  w.lastPos = pose.position;
  void vp.controls.setLookAt(
    pose.position[0],
    pose.position[1],
    pose.position[2],
    pose.target[0],
    pose.target[1],
    pose.target[2],
    false,
  );
  if (next.done) {
    w.settled = true;
    vp.cameraAwake = false;
  }
  return true;
}
