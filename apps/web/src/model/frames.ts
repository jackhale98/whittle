/** Placement frames for the reserved origin references (naming.ts) and small vector helpers. */

import type { Frame, Vec2, Vec3 } from '@whittle/contracts';

/** A full plane frame (x, y, z axes), as `SketchResult.frame` and `screenToPlane` use. */
export interface PlaneFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/**
 * Origin planes. XY = Top (normal +Z), XZ = Front (normal −Y, so sketch-up is world +Z), YZ =
 * Right (normal +X, sketch-up +Z), matching the conventional CAD view orientations.
 */
export const ORIGIN_FRAMES: Record<'origin:XY' | 'origin:XZ' | 'origin:YZ', Frame> = {
  'origin:XY': { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
  'origin:XZ': { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] },
  'origin:YZ': { origin: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] },
};

/** Origin axes as frames whose z is the axis direction (revolve `axis`). */
export const ORIGIN_AXES: Record<'origin:X' | 'origin:Y' | 'origin:Z', Frame> = {
  'origin:X': { origin: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] },
  'origin:Y': { origin: [0, 0, 0], z: [0, 1, 0], x: [0, 0, 1] },
  'origin:Z': { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
};

export type OriginPlane = keyof typeof ORIGIN_FRAMES;

export function isOriginPlane(name: string): name is OriginPlane {
  return name in ORIGIN_FRAMES;
}

export function isOriginAxis(name: string): name is keyof typeof ORIGIN_AXES {
  return name in ORIGIN_AXES;
}

export function toPlaneFrame(f: Frame): PlaneFrame {
  const z = norm3(f.z);
  const x = norm3(sub3(f.x, scale3(z, dot3(f.x, z))));
  return { origin: f.origin, x, y: cross(z, x), z };
}

/** A frame on a plane through `origin` with normal `normal`; x is world X (or Y) projected. */
export function frameFromNormal(origin: Vec3, normal: Vec3): Frame {
  const z = norm3(normal);
  const ref: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = norm3(sub3(ref, scale3(z, dot3(ref, z))));
  return { origin, z, x };
}

export function toWorld(frame: PlaneFrame, p: Vec2): Vec3 {
  return [
    frame.origin[0] + frame.x[0] * p[0] + frame.y[0] * p[1],
    frame.origin[1] + frame.x[1] * p[0] + frame.y[1] * p[1],
    frame.origin[2] + frame.x[2] * p[0] + frame.y[2] * p[1],
  ];
}

export function offsetFrame(f: Frame, distance: number): Frame {
  return { ...f, origin: add3(f.origin, scale3(norm3(f.z), distance)) };
}
