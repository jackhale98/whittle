// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit table and dimension algebra for the expression engine.
 *
 * Canonical internal units: length mm, angle rad, mass kg, time s. Dimensions are exponent
 * vectors `[length, mass, angle, time]`. The contract's `DimensionVector` is the first three
 * entries; the fourth (time) exists so pressure units (MPa/GPa) used by material properties can
 * be parsed and checked. Everything user-visible in the contract (named dimensions) has time 0.
 */

import { DIMENSIONS, type NamedDimension } from '@wren-cad/contracts';

/** Exponents of [length, mass, angle, time]. */
export type Dim = readonly [length: number, mass: number, angle: number, time: number];

export const SCALAR: Dim = [0, 0, 0, 0];

export interface UnitDef {
  /** Value of one unit in canonical units (mm, kg, rad, s). */
  factor: number;
  dim: Dim;
}

const LENGTH: Dim = [1, 0, 0, 0];
const ANGLE: Dim = [0, 0, 1, 0];
const MASS: Dim = [0, 1, 0, 0];
const TIME: Dim = [0, 0, 0, 1];
const FORCE: Dim = [1, 1, 0, -2];
const PRESSURE: Dim = [-1, 1, 0, -2];

/** `Pa` = 1 kg / (m s²) = 1e-3 kg / (mm s²). */
const PA = 1e-3;

const UNIT_ENTRIES: [string, UnitDef][] = [
  ['um', { factor: 1e-3, dim: LENGTH }],
  ['µm', { factor: 1e-3, dim: LENGTH }],
  ['mm', { factor: 1, dim: LENGTH }],
  ['cm', { factor: 10, dim: LENGTH }],
  ['m', { factor: 1000, dim: LENGTH }],
  ['in', { factor: 25.4, dim: LENGTH }],
  ['ft', { factor: 304.8, dim: LENGTH }],
  ['deg', { factor: Math.PI / 180, dim: ANGLE }],
  ['°', { factor: Math.PI / 180, dim: ANGLE }],
  ['rad', { factor: 1, dim: ANGLE }],
  ['g', { factor: 1e-3, dim: MASS }],
  ['kg', { factor: 1, dim: MASS }],
  ['lb', { factor: 0.45359237, dim: MASS }],
  ['s', { factor: 1, dim: TIME }],
  ['N', { factor: 1000, dim: FORCE }],
  ['Pa', { factor: PA, dim: PRESSURE }],
  ['kPa', { factor: PA * 1e3, dim: PRESSURE }],
  ['MPa', { factor: PA * 1e6, dim: PRESSURE }],
  ['GPa', { factor: PA * 1e9, dim: PRESSURE }],
];

/** All named units. A `Map` so identifiers like `constructor` never hit the prototype chain. */
export const UNITS: ReadonlyMap<string, UnitDef> = new Map(UNIT_ENTRIES);

export function lengthFactor(unit: 'mm' | 'cm' | 'm' | 'in' | 'ft'): number {
  return UNITS.get(unit)?.factor ?? 1;
}

export function angleFactor(unit: 'deg' | 'rad'): number {
  return UNITS.get(unit)?.factor ?? 1;
}

// ---------------------------------------------------------------------------------------------
// Dimension algebra
// ---------------------------------------------------------------------------------------------

const EPS = 1e-9;

export function dimEquals(a: Dim, b: Dim): boolean {
  return (
    Math.abs(a[0] - b[0]) < EPS &&
    Math.abs(a[1] - b[1]) < EPS &&
    Math.abs(a[2] - b[2]) < EPS &&
    Math.abs(a[3] - b[3]) < EPS
  );
}

export function dimIsScalar(a: Dim): boolean {
  return dimEquals(a, SCALAR);
}

function clean(x: number): number {
  const r = Math.round(x * 1e9) / 1e9;
  return r === 0 ? 0 : r;
}

export function dimMul(a: Dim, b: Dim): Dim {
  return [clean(a[0] + b[0]), clean(a[1] + b[1]), clean(a[2] + b[2]), clean(a[3] + b[3])];
}

export function dimDiv(a: Dim, b: Dim): Dim {
  return [clean(a[0] - b[0]), clean(a[1] - b[1]), clean(a[2] - b[2]), clean(a[3] - b[3])];
}

export function dimPow(a: Dim, e: number): Dim {
  return [clean(a[0] * e), clean(a[1] * e), clean(a[2] * e), clean(a[3] * e)];
}

/** Contract dimension (3-vector) widened with time 0. */
export function namedDim(name: NamedDimension): Dim {
  const v = DIMENSIONS[name];
  return [v[0], v[1], v[2], 0];
}

/** First three entries, as the contract's `DimensionVector`. */
export function toContractDim(d: Dim): readonly [number, number, number, number] {
  return [d[0], d[1], d[2], d[3]];
}

const DIM_NAMES: [Dim, string][] = [
  [SCALAR, 'a plain number'],
  [LENGTH, 'a length'],
  [ANGLE, 'an angle'],
  [[2, 0, 0, 0], 'an area'],
  [[3, 0, 0, 0], 'a volume'],
  [MASS, 'a mass'],
  [[-3, 1, 0, 0], 'a density'],
  [TIME, 'a time'],
  [FORCE, 'a force'],
  [PRESSURE, 'a pressure'],
];

/** Human description with article, e.g. "a length", "an angle". */
export function describeDim(d: Dim): string {
  for (const [dim, name] of DIM_NAMES) if (dimEquals(d, dim)) return name;
  const parts: string[] = [];
  const names = ['length', 'mass', 'angle', 'time'];
  d.forEach((e, i) => {
    if (e !== 0) parts.push(e === 1 ? (names[i] ?? '') : `${names[i]}^${e}`);
  });
  return `a quantity of ${parts.join('·')}`;
}

/**
 * Factor to convert a bare (unit-less) number into canonical units for dimension `d`, using the
 * document's default units. `undefined` when no sensible default exists.
 *
 * Defaults: length/area/volume → document length unit; angle → document angle unit; mass → g;
 * density → g/cm^3; pressure → MPa.
 */
export function defaultFactor(
  d: Dim,
  defaults: { length: number; angle: number },
): number | undefined {
  if (dimEquals(d, [-3, 1, 0, 0])) return 1e-6; // g/cm^3 in kg/mm^3
  if (dimEquals(d, PRESSURE)) return PA * 1e6; // MPa
  if (dimEquals(d, MASS)) return 1e-3; // g
  if (d[1] === 0 && d[3] === 0) return defaults.length ** d[0] * defaults.angle ** d[2];
  return undefined;
}
