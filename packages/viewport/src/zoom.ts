/**
 * Pure wheel-zoom logic (no DOM, no three.js). The viewport zooms by moving the camera along the
 * ray through the cursor toward an anchor point (the surface under the cursor, or a point at the
 * scene's depth on a miss), so the anchor stays under the cursor and every notch scales the
 * camera-to-anchor distance by the same factor.
 */

import type { Vec3 } from '@wren-cad/contracts';
import {
  WHEEL_ANCHOR_HOLD_MS,
  WHEEL_ANCHOR_SLOP_PX,
  WHEEL_LINES_PER_NOTCH,
  WHEEL_MAX_NOTCHES_PER_EVENT,
  WHEEL_NOTCH_PX,
  WHEEL_ZOOM_PER_NOTCH,
} from './constants';

/**
 * Signed notches of a wheel event, positive = zoom in (wheel away from the user, `deltaY < 0`).
 * `deltaMode` 0 = pixels, 1 = lines, 2 = pages. Clamped per event; `invert` flips the direction.
 */
export function wheelNotches(deltaY: number, deltaMode: number, invert = false): number {
  let notches: number;
  if (deltaMode === 1) notches = -deltaY / WHEEL_LINES_PER_NOTCH;
  else if (deltaMode === 2) notches = -deltaY * 3;
  else notches = -deltaY / WHEEL_NOTCH_PX;
  if (!Number.isFinite(notches)) return 0;
  notches = Math.max(-WHEEL_MAX_NOTCHES_PER_EVENT, Math.min(WHEEL_MAX_NOTCHES_PER_EVENT, notches));
  return invert ? -notches : notches;
}

/** Distance multiplier for `notches` (positive = closer). */
export function zoomScale(notches: number): number {
  return WHEEL_ZOOM_PER_NOTCH ** notches;
}

/** New goal distance after `notches`, clamped to [min, max]. */
export function nextGoalDistance(goal: number, notches: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  return Math.max(lo, Math.min(max, goal * zoomScale(notches)));
}

/**
 * One frame of the frame-rate independent ease in log distance. `tau <= 0` jumps to the goal.
 * Returns the new distance and whether it has arrived.
 */
export function easeDistance(
  current: number,
  goal: number,
  dt: number,
  tau: number,
): { value: number; done: boolean } {
  if (tau <= 0) return { value: goal, done: true };
  const a = 1 - Math.exp(-Math.max(dt, 0) / tau);
  const value = Math.exp(Math.log(current) + (Math.log(goal) - Math.log(current)) * a);
  if (Math.abs(Math.log(goal / value)) < 2e-4) return { value: goal, done: true };
  return { value, done: false };
}

export interface WheelAnchor {
  /** World point the camera moves toward. */
  point: Vec3;
  /** Cursor position (CSS px) the anchor was resolved for. */
  x: number;
  y: number;
  /** `performance.now()` of the last wheel event that used it. */
  t: number;
  /** `surface`: a pick; `scene`: depth fallback on a miss. */
  source: 'surface' | 'scene';
}

/** The anchor of the previous wheel event still applies: same cursor spot, wheel still turning. */
export function anchorStillValid(
  a: WheelAnchor | null,
  x: number,
  y: number,
  now: number,
): a is WheelAnchor {
  return (
    a !== null &&
    now - a.t <= WHEEL_ANCHOR_HOLD_MS &&
    Math.hypot(x - a.x, y - a.y) <= WHEEL_ANCHOR_SLOP_PX
  );
}

/**
 * Anchor on a miss: the point on the cursor ray at the depth of the scene centre (along the view
 * direction), or at `fallbackDepth` when the centre is behind the camera or unknown.
 */
export function missAnchor(
  origin: Vec3,
  dir: Vec3,
  forward: Vec3,
  centre: Vec3 | null,
  fallbackDepth: number,
): Vec3 {
  let depth = fallbackDepth;
  if (centre) {
    const d =
      (centre[0] - origin[0]) * forward[0] +
      (centre[1] - origin[1]) * forward[1] +
      (centre[2] - origin[2]) * forward[2];
    if (d > 1e-6) depth = d;
  }
  // Distance along the ray that reaches that depth along `forward`.
  const cos = dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2];
  const t = depth / Math.max(cos, 0.05);
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

export interface ZoomFrame {
  anchor: Vec3;
  /** Unit vector from the anchor to the camera at the start of the gesture. */
  away: Vec3;
  forward: Vec3;
  /** Depth of the anchor along `forward` divided by its distance: how far off-axis it is. */
  cos: number;
}

export function zoomFrame(camera: Vec3, forward: Vec3, anchor: Vec3): ZoomFrame | null {
  const ax = camera[0] - anchor[0];
  const ay = camera[1] - anchor[1];
  const az = camera[2] - anchor[2];
  const d = Math.hypot(ax, ay, az);
  if (d < 1e-9) return null;
  const away: Vec3 = [ax / d, ay / d, az / d];
  const cos = -(away[0] * forward[0] + away[1] * forward[1] + away[2] * forward[2]);
  return { anchor, away, forward, cos: Math.max(cos, 0.05) };
}

/** Camera position, and the view-axis target at the anchor's depth, when `distance` from the anchor. */
export function zoomPose(f: ZoomFrame, distance: number): { position: Vec3; target: Vec3 } {
  const position: Vec3 = [
    f.anchor[0] + f.away[0] * distance,
    f.anchor[1] + f.away[1] * distance,
    f.anchor[2] + f.away[2] * distance,
  ];
  const depth = distance * f.cos;
  return {
    position,
    target: [
      position[0] + f.forward[0] * depth,
      position[1] + f.forward[1] * depth,
      position[2] + f.forward[2] * depth,
    ],
  };
}
