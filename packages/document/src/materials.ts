// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Built-in material library (ADR-004). Entries are templates: assigning one copies it inline into
 * `Part.material` (with `libraryId` recording its origin) so documents stay self-contained.
 *
 * Mechanical figures are typical handbook values for the named alloy/grade/condition, intended
 * for estimates (mass, rough stiffness) — not for certified engineering. Printed/injection-moulded
 * plastics and woods vary widely with process and species.
 */

import type { EvalScope, ExpressionEngine, Material } from '@whittle/contracts';
import { expressionEngine } from './expressions';

export const LIBRARY_PREFIX = 'whittle:';

interface Def {
  slug: string;
  name: string;
  density: string;
  appearance: string;
  E?: string;
  nu?: string;
  yield?: string;
}

const DEFS: Def[] = [
  {
    slug: 'structural-steel',
    name: 'Structural steel (S235/A36)',
    density: '7.85 g/cm^3',
    appearance: '#8a9099',
    E: '200 GPa',
    nu: '0.29',
    yield: '250 MPa',
  },
  {
    slug: 'stainless-steel-304',
    name: 'Stainless steel 304',
    density: '8.00 g/cm^3',
    appearance: '#b9bec5',
    E: '193 GPa',
    nu: '0.29',
    yield: '215 MPa',
  },
  {
    slug: 'aluminium-6061-t6',
    name: 'Aluminium 6061-T6',
    density: '2.70 g/cm^3',
    appearance: '#c6cbd1',
    E: '68.9 GPa',
    nu: '0.33',
    yield: '276 MPa',
  },
  {
    slug: 'aluminium-7075-t6',
    name: 'Aluminium 7075-T6',
    density: '2.81 g/cm^3',
    appearance: '#b3bbc7',
    E: '71.7 GPa',
    nu: '0.33',
    yield: '503 MPa',
  },
  {
    slug: 'brass-c360',
    name: 'Brass C360',
    density: '8.50 g/cm^3',
    appearance: '#c9a64e',
    E: '97 GPa',
    nu: '0.34',
    yield: '310 MPa',
  },
  {
    slug: 'copper',
    name: 'Copper',
    density: '8.96 g/cm^3',
    appearance: '#b87333',
    E: '117 GPa',
    nu: '0.34',
    yield: '70 MPa',
  },
  {
    slug: 'titanium-ti-6al-4v',
    name: 'Titanium Ti-6Al-4V',
    density: '4.43 g/cm^3',
    appearance: '#8e9096',
    E: '113.8 GPa',
    nu: '0.342',
    yield: '880 MPa',
  },
  {
    slug: 'cast-iron',
    name: 'Cast iron (grey)',
    density: '7.20 g/cm^3',
    appearance: '#5b5e63',
    E: '110 GPa',
    nu: '0.26',
  },
  {
    slug: 'abs',
    name: 'ABS',
    density: '1.04 g/cm^3',
    appearance: '#d8d4c6',
    E: '2.3 GPa',
    nu: '0.35',
    yield: '40 MPa',
  },
  {
    slug: 'pla',
    name: 'PLA',
    density: '1.24 g/cm^3',
    appearance: '#dcb36a',
    E: '3.5 GPa',
    nu: '0.36',
    yield: '50 MPa',
  },
  {
    slug: 'petg',
    name: 'PETG',
    density: '1.27 g/cm^3',
    appearance: '#86bccb',
    E: '2.1 GPa',
    nu: '0.38',
    yield: '50 MPa',
  },
  {
    slug: 'nylon-pa12',
    name: 'Nylon PA12',
    density: '1.01 g/cm^3',
    appearance: '#ebe7de',
    E: '1.7 GPa',
    nu: '0.39',
    yield: '45 MPa',
  },
  {
    slug: 'polycarbonate',
    name: 'Polycarbonate',
    density: '1.20 g/cm^3',
    appearance: '#cde0e8',
    E: '2.4 GPa',
    nu: '0.37',
    yield: '62 MPa',
  },
  {
    slug: 'acetal-pom',
    name: 'Acetal (POM)',
    density: '1.41 g/cm^3',
    appearance: '#f2efe6',
    E: '2.9 GPa',
    nu: '0.35',
    yield: '65 MPa',
  },
  { slug: 'oak', name: 'Oak', density: '0.75 g/cm^3', appearance: '#b08a5b', E: '11 GPa' },
  { slug: 'pine', name: 'Pine', density: '0.50 g/cm^3', appearance: '#d9bb8c', E: '9 GPa' },
];

function toMaterial(d: Def): Material {
  const properties: NonNullable<Material['properties']> = {};
  if (d.E) properties.youngsModulus = d.E;
  if (d.nu) properties.poissonsRatio = d.nu;
  if (d.yield) properties.yieldStrength = d.yield;
  const m: Material = {
    libraryId: `${LIBRARY_PREFIX}${d.slug}`,
    name: d.name,
    density: d.density,
    appearance: d.appearance,
  };
  if (Object.keys(properties).length > 0) m.properties = properties;
  return m;
}

/** The built-in library, in display order. Treat as read-only; use `materialFromLibrary` to copy. */
export const MATERIALS: readonly Material[] = Object.freeze(DEFS.map(toMaterial));

export function findMaterial(libraryId: string): Material | undefined {
  return MATERIALS.find((m) => m.libraryId === libraryId);
}

/** A deep copy of a library entry, ready to assign to `Part.material`. */
export function materialFromLibrary(libraryId: string): Material | undefined {
  const m = findMaterial(libraryId);
  return m ? structuredClone(m) : undefined;
}

const NO_PARAMS: EvalScope = { params: {}, defaultLengthUnit: 'mm', defaultAngleUnit: 'deg' };

export type DensityResult = { ok: true; value: number } | { ok: false; message: string };

/** Density in kg/mm³ (the canonical unit), or a human error. Bare numbers mean g/cm³. */
export function tryResolveDensity(
  material: Pick<Material, 'density'>,
  engine: ExpressionEngine = expressionEngine,
  scope: EvalScope = NO_PARAMS,
): DensityResult {
  const r = engine.evaluate(material.density, 'density', scope);
  if (!r.ok) return { ok: false, message: r.error.message };
  if (!(r.value > 0)) return { ok: false, message: 'Density must be greater than zero' };
  return { ok: true, value: r.value };
}

/** Density in kg/mm³. Throws an `Error` with a human message when the expression is invalid. */
export function resolveDensity(
  material: Pick<Material, 'density'>,
  engine: ExpressionEngine = expressionEngine,
  scope: EvalScope = NO_PARAMS,
): number {
  const r = tryResolveDensity(material, engine, scope);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}
