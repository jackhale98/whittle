/**
 * Pure view / framing math. No three.js dependency so it is trivially unit-testable.
 *
 * Wren is Z-up (CAD convention). "Front" looks along +Y from the -Y side, so +X is screen
 * right and +Z is screen up. Directions are camera offsets from the orbit target.
 */

import type { StandardView } from '@wren-cad/contracts';

export type Vec3 = [number, number, number];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

const ISO = 1 / Math.sqrt(3);

/** Unit vectors from target to camera for each standard view. */
export const VIEW_DIRECTIONS: Readonly<Record<StandardView, Readonly<Vec3>>> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  iso: [ISO, -ISO, ISO],
};

/** Default framing used when nothing is loaded. */
export const EMPTY_BOUNDS: Bounds = { min: [-50, -50, 0], max: [50, 50, 0] };

export function boundsCenter(b: Bounds): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** Radius of the bounding sphere around the box centre. */
export function boundsRadius(b: Bounds): number {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
}

export function unionBounds(list: readonly Bounds[]): Bounds | null {
  const first = list[0];
  if (!first) return null;
  const min: Vec3 = [...first.min];
  const max: Vec3 = [...first.max];
  for (const b of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, b.min[k] as number);
      max[k] = Math.max(max[k] as number, b.max[k] as number);
    }
  }
  return { min, max };
}

/**
 * Camera distance at which a sphere of `radius` fits entirely in a perspective view with vertical
 * field of view `vfovDeg` and the given aspect ratio (width / height), with `padding` margin.
 */
export function fitDistance(
  radius: number,
  vfovDeg: number,
  aspect: number,
  padding = 1.2,
): number {
  const halfV = (vfovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const half = Math.min(halfV, halfH);
  return (Math.max(radius, 1e-6) * padding) / Math.sin(half);
}

/** Camera position for looking at `target` along `direction` from `distance`. */
export function cameraPositionFor(target: Vec3, direction: Readonly<Vec3>, distance: number): Vec3 {
  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  return [
    target[0] + (direction[0] / len) * distance,
    target[1] + (direction[1] / len) * distance,
    target[2] + (direction[2] / len) * distance,
  ];
}

/** Near/far clip planes for a scene of `sceneRadius` viewed from `distance` away. */
export function clipPlanes(distance: number, sceneRadius: number): { near: number; far: number } {
  const r = Math.max(sceneRadius, 1e-3);
  const near = Math.max(r * 0.002, (distance - r * 2) * 0.5);
  const far = distance + r * 25;
  return { near, far };
}

/** Grid cell size (a power of ten) suited to a scene of this radius. */
export function gridCellSize(sceneRadius: number): number {
  const r = Math.max(sceneRadius, 1e-3);
  return 10 ** Math.floor(Math.log10(r / 2));
}

/** Pixels of the canvas covered by floating chrome (sheet, top bar): the model is framed in the rest. */
export interface FrameInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_FRAME_INSETS: FrameInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Camera distance and the target shift that centre a sphere of `radius` in the part of a
 * `w` x `h` px canvas the insets leave free. `shiftRight` / `shiftUp` are in world units along the
 * camera's right and up axes, to add to the sphere's centre to get the look-at target.
 */
export function fitInsetFrame(
  radius: number,
  vfovDeg: number,
  w: number,
  h: number,
  insets: FrameInsets,
  padding = 1.2,
): { distance: number; shiftRight: number; shiftUp: number } {
  const fw = Math.max(w - insets.left - insets.right, 1);
  const fh = Math.max(h - insets.top - insets.bottom, 1);
  const tanHalf = Math.tan((vfovDeg * Math.PI) / 360);
  // The free area is the fraction fh/h of the full vertical field at any distance.
  const effV = (2 * Math.atan(tanHalf * (fh / h)) * 180) / Math.PI;
  const distance = fitDistance(radius, effV, fw / fh, padding);
  const perPx = (2 * distance * tanHalf) / h;
  const dx = (insets.left - insets.right) / 2;
  const dy = (insets.top - insets.bottom) / 2;
  return { distance, shiftRight: -dx * perPx, shiftUp: dy * perPx };
}

/**
 * The camera truck (world units along the camera's right and up axes) that keeps what was in the
 * middle of the free area visible when the insets change: the content moves on screen by the shift
 * of the free area's centre, so the camera moves the opposite way (right) / the same way (up).
 * Distance and orientation are untouched. `distance` is the camera-to-target distance.
 */
export function insetPan(
  prev: FrameInsets,
  next: FrameInsets,
  vfovDeg: number,
  h: number,
  distance: number,
): { right: number; up: number } {
  const perPx = (2 * distance * Math.tan((vfovDeg * Math.PI) / 360)) / Math.max(h, 1);
  const dx = (next.left - next.right - (prev.left - prev.right)) / 2;
  const dy = (next.top - next.bottom - (prev.top - prev.bottom)) / 2;
  return { right: -dx * perPx || 0, up: dy * perPx || 0 };
}
