/**
 * 3D mouse motion in the viewport (ADR-096): rotation about the same pivot a mouse orbit would
 * use (the surface under the last known cursor, falling back like `resolvePivot`), translation as
 * a view-plane pan, push/pull as a zoom toward that same surface point.
 *
 * A "session" is a run of non-zero samples. Its pivot is resolved once at the start (like a mouse
 * orbit at press time); every frame applies the amounts integrated since the previous frame in one
 * camera write. Nothing here animates (no easing), so reduced motion needs no special case: the
 * view moves exactly as far as the user deflects the device.
 */

import type { MotionSample, Vec3 } from '@wren-cad/contracts';
import { Vector3 } from 'three/webgpu';
import { WHEEL_MAX_DISTANCE_RADII, WHEEL_MIN_DISTANCE_RADII } from '../constants';
import { worldPerPixel } from '../handles';
import {
  hidePivotMarker,
  readPose,
  resolveNavPivot,
  showPivotMarker,
  writePose,
} from '../navControl';
import { orbitTrackball, orbitTurntable, type Pose, rotatePose } from '../navigation';
import { requestRender } from '../renderLoop';
import type { ViewportImpl } from '../viewport';
import { stepWheel } from '../wheel';
import {
  isZeroDelta,
  isZeroSample,
  MOTION_PAN_VIEWS_PER_S,
  MOTION_ROTATE_RAD_PER_S,
  MOTION_TIMEOUT_MS,
  MOTION_ZOOM_PER_S,
  type MotionDelta,
  MotionIntegrator,
} from './integrate';

export interface MotionState {
  readonly integ: MotionIntegrator;
  /** Pivot and zoom anchor of the session in progress. */
  pivot: Vec3 | null;
  markerShown: boolean;
  /** `performance.now()` of the last sample, and of the last non-zero one (wheel echo rule). */
  lastSampleAt: number;
  lastMotionAt: number;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** Camera writes made by motion and the CPU ms they took (diagnostics, perf probes). */
  frames: number;
  applyMs: number;
}

export function createMotionState(): MotionState {
  return {
    integ: new MotionIntegrator(),
    pivot: null,
    markerShown: false,
    lastSampleAt: 0,
    lastMotionAt: 0,
    watchdog: null,
    frames: 0,
    applyMs: 0,
  };
}

/** A pointer gesture (a press anywhere on the canvas, a navigation drag, touch controls) is in flight. */
export function pointerGestureInFlight(vp: ViewportImpl): boolean {
  return vp.nav !== null || vp.pointersDown.size > 0 || vp.navMachine.tracking() || vp.interacting;
}

export function motionSample(vp: ViewportImpl, s: MotionSample): void {
  if (vp.disposed) return;
  const mo = vp.motionState;
  if (pointerGestureInFlight(vp)) {
    // Never fight a drag: drop the session and the samples until the pointer is up.
    if (mo.integ.active) endMotion(vp);
    return;
  }
  const r = mo.integ.push(s);
  const now = performance.now();
  mo.lastSampleAt = now;
  if (!r.started && !mo.integ.active && !r.ended) return; // a zero sample at rest
  if (!isZeroSample(s)) mo.lastMotionAt = now;
  if (r.started) beginMotion(vp);
  armWatchdog(vp);
  vp.cameraAwake = true;
  requestRender(vp);
}

function armWatchdog(vp: ViewportImpl): void {
  const mo = vp.motionState;
  if (mo.watchdog !== null) return;
  mo.watchdog = setTimeout(function check() {
    mo.watchdog = null;
    if (vp.disposed || !mo.integ.active) return;
    const idle = performance.now() - mo.lastSampleAt;
    if (idle >= MOTION_TIMEOUT_MS) {
      mo.integ.stop();
      requestRender(vp);
    } else {
      mo.watchdog = setTimeout(check, MOTION_TIMEOUT_MS - idle + 1);
    }
  }, MOTION_TIMEOUT_MS);
}

function beginMotion(vp: ViewportImpl): void {
  const mo = vp.motionState;
  // Take over from a zoom or view transition in flight: continue from where it is heading.
  if (vp.wheel && !vp.wheel.settled) {
    vp.wheel.current = vp.wheel.goal;
    stepWheel(vp, 0, true);
    vp.controls.update(0);
  }
  vp.wheel = null;
  if (vp.controls.active) {
    const pos = vp.controls.getPosition(new Vector3(), true);
    const tgt = vp.controls.getTarget(new Vector3(), true);
    void vp.controls.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
    vp.controls.update(0);
  }
  const w = vp.canvas.clientWidth || 1;
  const h = vp.canvas.clientHeight || 1;
  const cur = vp.cursor ?? { x: w / 2, y: h / 2 };
  const t0 = performance.now();
  const r = resolveNavPivot(vp, cur.x, cur.y);
  vp.lastPivotMs = performance.now() - t0;
  mo.pivot = r.point;
  mo.markerShown = false;
  vp.lastPivot = r;
}

/** Called every frame before the camera controls update. True while a session is running. */
export function stepMotion(vp: ViewportImpl): boolean {
  const mo = vp.motionState;
  const delta = mo.integ.take();
  if (!isZeroDelta(delta) && mo.pivot && !pointerGestureInFlight(vp)) applyMotion(vp, delta);
  if (mo.integ.consumeEnded()) {
    finishMotion(vp);
    return false;
  }
  return mo.integ.active;
}

/** End the session now (a pointer gesture started, or the viewport is going away). */
export function endMotion(vp: ViewportImpl): void {
  const mo = vp.motionState;
  mo.integ.stop();
  mo.integ.take();
  mo.integ.consumeEnded();
  finishMotion(vp);
}

function finishMotion(vp: ViewportImpl): void {
  const mo = vp.motionState;
  if (mo.watchdog !== null) {
    clearTimeout(mo.watchdog);
    mo.watchdog = null;
  }
  mo.pivot = null;
  if (mo.markerShown) {
    mo.markerShown = false;
    if (!vp.nav) hidePivotMarker(vp);
  }
  requestRender(vp);
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Turns the integrated amounts into one camera move. Sense of each axis (`MotionSample`):
 * - r.x > 0 tips the model's top away from the viewer (same as dragging a mouse orbit down),
 * - r.y > 0 turns the model to the right (a mouse orbit drag right),
 * - r.z > 0 turns the model clockwise on screen: roll under trackball; under turntable (which keeps
 *   +Z up and cannot roll) it adds to the yaw so a twist still turns the model,
 * - t.x > 0 / t.y > 0 move the model right / up on screen (grabbing it, like a pan drag),
 * - t.z > 0 (pull toward the viewer) zooms out about the pivot, t.z < 0 zooms in.
 */
export function applyMotion(vp: ViewportImpl, d: MotionDelta): void {
  const t0 = performance.now();
  const mo = vp.motionState;
  const pivot = mo.pivot as Vec3;
  const { pose, dist } = readPose(vp);
  let p: Pose = pose;
  let dd = dist;

  const k = MOTION_ROTATE_RAD_PER_S * vp.navigation.rotateSpeed;
  const rx = d.r[0] * k;
  const ry = d.r[1] * k;
  const rz = d.r[2] * k;
  let setUp = false;
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    if (!mo.markerShown && vp.navigation.showPivot) {
      showPivotMarker(vp, pivot);
      mo.markerShown = true;
    }
    if (vp.navigation.orbit === 'trackball') {
      p = orbitTrackball(p, pivot, ry, rx, 1);
      if (rz !== 0) p = rotatePose(p, pivot, p.fwd, -rz);
      setUp = true;
    } else {
      const u = vp.camera.up;
      p = orbitTurntable(p, pivot, [u.x, u.y, u.z], ry + rz, rx, 1);
    }
  }

  const tx = d.t[0];
  const ty = d.t[1];
  if (tx !== 0 || ty !== 0) {
    const depth = dot([pivot[0] - p.pos[0], pivot[1] - p.pos[1], pivot[2] - p.pos[2]], p.fwd);
    const h = vp.canvas.clientHeight || 1;
    const wpp = worldPerPixel(depth, vp.camera.projectionMatrix.elements[5] as number, h);
    const viewWidth = wpp * (vp.canvas.clientWidth || 1);
    const s = MOTION_PAN_VIEWS_PER_S * viewWidth;
    const right = crossV(p.fwd, p.up);
    p = {
      ...p,
      pos: [
        p.pos[0] + (-right[0] * tx - p.up[0] * ty) * s,
        p.pos[1] + (-right[1] * tx - p.up[1] * ty) * s,
        p.pos[2] + (-right[2] * tx - p.up[2] * ty) * s,
      ],
    };
    vp.pivotOverride = null; // the view moved: a remembered pivot no longer means "here"
  }

  const tz = d.t[2];
  if (tz !== 0) {
    const off: Vec3 = [p.pos[0] - pivot[0], p.pos[1] - pivot[1], p.pos[2] - pivot[2]];
    const cur = Math.hypot(off[0], off[1], off[2]);
    if (cur > 1e-9) {
      const r = Math.max(vp.sceneRadius, 1e-3);
      const min = Math.min(cur, r * WHEEL_MIN_DISTANCE_RADII);
      const max = Math.max(cur, r * WHEEL_MAX_DISTANCE_RADII);
      const next = Math.min(max, Math.max(min, cur * Math.exp(tz * MOTION_ZOOM_PER_S)));
      const f = next / cur;
      p = {
        ...p,
        pos: [pivot[0] + off[0] * f, pivot[1] + off[1] * f, pivot[2] + off[2] * f],
      };
      dd *= f;
    }
  }

  writePose(vp, p, dd, setUp);
  mo.frames++;
  mo.applyMs += performance.now() - t0;
}
