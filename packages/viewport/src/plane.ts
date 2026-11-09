/** Sketch-plane math (pure). */

import type { Vec2, Vec3 } from '@wren-cad/contracts';

export interface PlaneFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Ray/plane intersection; null when parallel or the plane is behind the ray origin. */
export function rayToPlane(
  origin: Vec3,
  dir: Vec3,
  plane: PlaneFrame,
): { local: Vec2; point: Vec3; t: number } | null {
  const denom = dot(dir, plane.z);
  if (Math.abs(denom) < 1e-9) return null;
  const rel: Vec3 = [
    plane.origin[0] - origin[0],
    plane.origin[1] - origin[1],
    plane.origin[2] - origin[2],
  ];
  const t = dot(rel, plane.z) / denom;
  if (t <= 0) return null;
  const point: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const d: Vec3 = [
    point[0] - plane.origin[0],
    point[1] - plane.origin[1],
    point[2] - plane.origin[2],
  ];
  return { local: [dot(d, plane.x), dot(d, plane.y)], point, t };
}

/**
 * Camera placement for looking straight at a plane from its +z side. `target` is the current
 * orbit target projected onto the plane so the thing being looked at stays centred. The camera
 * keeps world +Z as up; for horizontal planes it is nudged toward -plane.y so plane.y points up.
 */
export function lookAtPlanePose(
  plane: PlaneFrame,
  currentTarget: Vec3,
  distance: number,
): { position: Vec3; target: Vec3 } {
  const rel: Vec3 = [
    currentTarget[0] - plane.origin[0],
    currentTarget[1] - plane.origin[1],
    currentTarget[2] - plane.origin[2],
  ];
  const h = dot(rel, plane.z);
  const target: Vec3 = [
    currentTarget[0] - plane.z[0] * h,
    currentTarget[1] - plane.z[1] * h,
    currentTarget[2] - plane.z[2] * h,
  ];
  const horizontal = Math.abs(plane.z[2]) > 0.9999;
  const nudge = horizontal ? distance * 1e-3 : 0;
  const position: Vec3 = [
    target[0] + plane.z[0] * distance - plane.y[0] * nudge,
    target[1] + plane.z[1] * distance - plane.y[1] * nudge,
    target[2] + plane.z[2] * distance - plane.y[2] * nudge,
  ];
  return { position, target };
}
