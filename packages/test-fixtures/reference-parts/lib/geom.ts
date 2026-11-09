/**
 * Closed-form helpers shared by the part models. Everything here is textbook geometry (Pappus,
 * prismatoid and sphere formulas); nothing is taken from any published exam.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Pick, Term } from './types';

const PI = Math.PI;

/** Area of the gap between a square corner and a fillet of radius r: (1 - pi/4) r^2. */
export const gapArea = (r: number): number => (1 - PI / 4) * r * r;

/**
 * Distance of the gap's centroid from each of the two walls: r (10 - 3 pi) / (3 (4 - pi))
 * (about 0.2234 r). Used with Pappus for fillets that run along curved edges.
 */
export const gapCentroid = (r: number): number => (r * (10 - 3 * PI)) / (3 * (4 - PI));

/** Area of a right-isosceles chamfer triangle with legs c. */
export const chamferArea = (c: number): number => (c * c) / 2;

/** Centroid distance of that triangle from both legs. */
export const chamferCentroid = (c: number): number => c / 3;

/** Volume swept by a profile of area a whose centroid is at radius rho, over `angle` radians. */
export const pappusRevolve = (a: number, rho: number, angle = 2 * PI): number => a * rho * angle;

/** Circle area from a diameter. */
export const discArea = (d: number): number => (PI * d * d) / 4;

/** Sphere cap of height h on a sphere of radius R. */
export const capVolume = (R: number, h: number): number => (PI * h * h * (3 * R - h)) / 3;

/** Frustum of a cone, radii r1 and r2, height h. */
export const frustumVolume = (r1: number, r2: number, h: number): number =>
  (PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;

/** The part of a cone frustum (radii r1 > r2, height h) outside the cylinder of radius r2. */
export const frustumVolumeBeyond = (r1: number, r2: number, h: number): number =>
  frustumVolume(r1, r2, h) - PI * r2 * r2 * h;

/** Lateral area of a cone/cylinder of revolution: profile segment (r1, z1) to (r2, z2). */
export const coneArea = (r1: number, z1: number, r2: number, z2: number): number =>
  PI * (r1 + r2) * Math.hypot(r2 - r1, z2 - z1);

/** Area of a quarter-circle surface of revolution: arc radius r, arc centroid at radius rho. */
export const quarterArcArea = (r: number, rho: number): number => ((PI * r) / 2) * 2 * PI * rho;

/** Signed term helper for derivations. */
export function term(label: string, formula: string, value: number): Term {
  return { label, formula, value };
}

export const sum = (terms: Term[]): number => terms.reduce((s, t) => s + t.value, 0);

// ---- picks and names --------------------------------------------------------------------------

export const face = (name: string, at?: [number, number, number]): Pick =>
  at === undefined ? { pick: 'face', name } : { pick: 'face', name, at };
export const edge = (name: string, at?: [number, number, number]): Pick =>
  at === undefined ? { pick: 'edge', name } : { pick: 'edge', name, at };
export const origin = (name: string): Pick =>
  name === 'origin:X' || name === 'origin:Y' || name === 'origin:Z'
    ? { pick: 'axis', name }
    : { pick: 'plane', name };

/** `edge(a|b)` with the two face names sorted, as the kernel names edges. */
export const edgeName = (a: string, b: string): string => `edge(${[a, b].sort().join('|')})`;

/** `F{ex}:side(S{sk}:e(L1))`. */
export const side = (extrude: string, sketch: string, entity: string): string =>
  `F{${extrude}}:side(S{${sketch}}:e(${entity}))`;

/** Region pick of closed curves of a sketch. */
export const region = (
  sketch: string,
  curves: string[],
  at: [number, number, number],
  inner?: string[][],
): Pick =>
  inner === undefined
    ? { pick: 'region', sketch, curves, at }
    : { pick: 'region', sketch, curves, inner, at };

/** Round for the spec JSON: 12 significant digits keeps recomputation exact to 1e-9 relative. */
export const r12 = (x: number): number => Number(x.toPrecision(12));
