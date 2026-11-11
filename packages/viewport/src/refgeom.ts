/**
 * Pure geometry of reference planes, axes and points (ADR-093): no three.js, unit-testable in
 * Node. The layer in `references.ts` draws and picks with these.
 */

import type { ReferenceFrame, ViewportReference } from './types';

type V3 = readonly [number, number, number];

const add = (a: V3, b: V3): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): [number, number, number] => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Smallest half-size (mm) of a reference plane or axis drawn by the viewport itself. */
export const MIN_ORIGIN_EXTENT = 50;

/** The four corners of a plane's square, counter-clockwise seen from +z. */
export function planeCorners(f: ReferenceFrame, extent: number): [V3, V3, V3, V3] {
  const c = (sx: number, sy: number): V3 =>
    add(add(f.origin, mul(f.x, sx * extent)), mul(f.y, sy * extent));
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
}

/** Segment pairs (x0 y0 z0 x1 y1 z1 ...) of a plane's outline. */
export function outlineSegments(f: ReferenceFrame, extent: number): Float32Array {
  const q = planeCorners(f, extent);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) out.push(...(q[i] as V3), ...(q[(i + 1) % 4] as V3));
  return Float32Array.from(out);
}

/**
 * A dash-dot line along the frame's z axis over `[-extent, extent]`: a long dash, a gap, a dot,
 * a gap, repeated (unit u = extent / 24).
 */
export function dashDotSegments(f: ReferenceFrame, extent: number): Float32Array {
  const u = extent / 24;
  const pattern: Array<[number, boolean]> = [
    [5 * u, true],
    [1.5 * u, false],
    [0.7 * u, true],
    [1.5 * u, false],
  ];
  const out: number[] = [];
  let t = -extent;
  let i = 0;
  while (t < extent - 1e-9) {
    const [len, on] = pattern[i % pattern.length] as [number, boolean];
    const end = Math.min(t + len, extent);
    if (on) out.push(...add(f.origin, mul(f.z, t)), ...add(f.origin, mul(f.z, end)));
    t = end;
    i++;
  }
  return Float32Array.from(out);
}

/**
 * Where a ray meets a plane's square: the distance `t` along the (unit) ray, or null when it is
 * parallel, behind the origin, or outside the square.
 */
export function rayHitsPlane(
  origin: V3,
  dir: V3,
  f: ReferenceFrame,
  extent: number,
): { t: number; point: [number, number, number] } | null {
  const denom = dot(dir, f.z);
  if (Math.abs(denom) < 1e-9) return null;
  const toPlane: V3 = [f.origin[0] - origin[0], f.origin[1] - origin[1], f.origin[2] - origin[2]];
  const t = dot(toPlane, f.z) / denom;
  if (t <= 0) return null;
  const point = add(origin, mul(dir, t));
  const rel: V3 = [point[0] - f.origin[0], point[1] - f.origin[1], point[2] - f.origin[2]];
  if (Math.abs(dot(rel, f.x)) > extent || Math.abs(dot(rel, f.y)) > extent) return null;
  return { t, point };
}

/** The end points of an axis over `[-extent, extent]`. */
export function axisEnds(f: ReferenceFrame, extent: number): [V3, V3] {
  return [add(f.origin, mul(f.z, -extent)), add(f.origin, mul(f.z, extent))];
}

const frame = (x: V3, y: V3, z: V3): ReferenceFrame => ({
  origin: [0, 0, 0],
  x: [...x],
  y: [...y],
  z: [...z],
});

/**
 * The world origin planes and axes with the reserved names of naming.ts (`origin:XY`, `origin:XZ`,
 * `origin:YZ`, `origin:X`, `origin:Y`, `origin:Z`, `origin:O`), frames as the regen defines them.
 */
export function originReferences(extent: number): ViewportReference[] {
  const r = (
    name: string,
    kind: ViewportReference['kind'],
    label: string,
    f: ReferenceFrame,
  ): ViewportReference => ({ name, kind, label, frame: f, extent, origin: true });
  return [
    r('origin:XY', 'plane', 'XY', frame([1, 0, 0], [0, 1, 0], [0, 0, 1])),
    r('origin:XZ', 'plane', 'XZ', frame([1, 0, 0], [0, 0, 1], [0, -1, 0])),
    r('origin:YZ', 'plane', 'YZ', frame([0, 1, 0], [0, 0, 1], [1, 0, 0])),
    r('origin:X', 'axis', 'X', frame([0, 1, 0], [0, 0, 1], [1, 0, 0])),
    r('origin:Y', 'axis', 'Y', frame([0, 0, 1], [1, 0, 0], [0, 1, 0])),
    r('origin:Z', 'axis', 'Z', frame([1, 0, 0], [0, 1, 0], [0, 0, 1])),
    r('origin:O', 'point', 'O', frame([1, 0, 0], [0, 1, 0], [0, 0, 1])),
  ];
}
