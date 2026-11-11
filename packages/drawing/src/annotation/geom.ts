/**
 * Small 2D/3D vector helpers (plain tuples, no allocation tricks). Worker-safe.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2, Vec3 } from '@wren-cad/contracts';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Left normal (CCW 90°). */
export const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
export function norm2(a: Vec2): Vec2 {
  const l = Math.hypot(a[0], a[1]);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
}
export const dir2 = (angle: number): Vec2 => [Math.cos(angle), Math.sin(angle)];
export const angle2 = (a: Vec2): number => Math.atan2(a[1], a[0]);
export function rotate2(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function norm3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const neg3 = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** Normalise an angle to [0, 2π). */
export function wrapAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Axis-aligned 2D box. */
export interface Box2 {
  min: Vec2;
  max: Vec2;
}

export function boxOf(points: readonly Vec2[]): Box2 | null {
  const first = points[0];
  if (!first) return null;
  const min: Vec2 = [first[0], first[1]];
  const max: Vec2 = [first[0], first[1]];
  for (const p of points) {
    if (p[0] < min[0]) min[0] = p[0];
    if (p[1] < min[1]) min[1] = p[1];
    if (p[0] > max[0]) max[0] = p[0];
    if (p[1] > max[1]) max[1] = p[1];
  }
  return { min, max };
}

/** Round to `digits` decimals, half away from zero, without binary-fraction surprises (1.005 → 1.01). */
export function roundTo(x: number, digits: number): number {
  const m = 10 ** digits;
  const r = Math.round(Math.abs(x) * m * (1 + 2 * Number.EPSILON) + 1e-9) / m;
  return x < 0 ? -r : r;
}
