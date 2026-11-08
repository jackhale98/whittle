// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  expressionEngine,
  findMaterial,
  MATERIALS,
  materialFromLibrary,
  resolveDensity,
  tryResolveDensity,
  validateDoc,
} from '../src';
import { req, sampleDoc } from './fixtures';

/** g/cm³ → kg/mm³ */
const toKgMm3 = (gcm3: number) => gcm3 * 1e-6;

const EXPECTED: Record<string, number> = {
  'structural-steel': 7.85,
  'stainless-steel-304': 8.0,
  'aluminium-6061-t6': 2.7,
  'aluminium-7075-t6': 2.81,
  'brass-c360': 8.5,
  copper: 8.96,
  'titanium-ti-6al-4v': 4.43,
  'cast-iron': 7.2,
  abs: 1.04,
  pla: 1.24,
  petg: 1.27,
  'nylon-pa12': 1.01,
  polycarbonate: 1.2,
  'acetal-pom': 1.41,
  oak: 0.75,
  pine: 0.5,
};

describe('material library', () => {
  it('has every required material with the right density', () => {
    expect(MATERIALS).toHaveLength(Object.keys(EXPECTED).length);
    for (const [slug, gcm3] of Object.entries(EXPECTED)) {
      const m = findMaterial(`whittle:${slug}`);
      expect(m, slug).toBeDefined();
      expect(resolveDensity(req(m)), slug).toBeCloseTo(toKgMm3(gcm3), 15);
    }
  });

  it('ids are unique, namespaced and lower-kebab', () => {
    const ids = MATERIALS.map((m) => m.libraryId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ids) expect(i).toMatch(/^whittle:[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('every entry has a name, an appearance colour and parseable properties', () => {
    for (const m of MATERIALS) {
      expect(m.name.length, m.libraryId).toBeGreaterThan(1);
      expect(m.appearance, m.libraryId).toMatch(/^#[0-9a-f]{6}$/);
      const scope = { params: {}, defaultLengthUnit: 'mm', defaultAngleUnit: 'deg' } as const;
      for (const [k, v] of Object.entries(m.properties ?? {})) {
        const r = expressionEngine.evaluateAny(v, scope);
        expect(r.ok, `${m.libraryId}.${k} = ${v}`).toBe(true);
        if (r.ok && k === 'poissonsRatio') {
          expect(r.value).toBeGreaterThan(0);
          expect(r.value).toBeLessThan(0.5);
          expect(r.dimension).toEqual([0, 0, 0, 0]);
        }
        if (r.ok && k === 'youngsModulus') expect(r.value).toBeGreaterThan(1e5); // ≥ 0.1 GPa in kg/(mm s²)
      }
    }
    expect(findMaterial('whittle:aluminium-6061-t6')?.properties).toEqual({
      youngsModulus: '68.9 GPa',
      poissonsRatio: '0.33',
      yieldStrength: '276 MPa',
    });
  });

  it('Young’s modulus and yield strength carry pressure dimensions and convert correctly', () => {
    const e = expressionEngine.evaluateAny('200 GPa', {
      params: {},
      defaultLengthUnit: 'mm',
      defaultAngleUnit: 'deg',
    });
    const y = expressionEngine.evaluateAny('1 MPa', {
      params: {},
      defaultLengthUnit: 'mm',
      defaultAngleUnit: 'deg',
    });
    expect(e.ok && y.ok && e.value / y.value).toBeCloseTo(200_000, 6);
    expect(e.ok && y.ok && e.dimension).toEqual(y.ok ? y.dimension : null);
  });

  it('materialFromLibrary returns an independent deep copy', () => {
    const a = materialFromLibrary('whittle:pla');
    const b = materialFromLibrary('whittle:pla');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    req(a).density = '99 g/cm^3';
    expect(findMaterial('whittle:pla')?.density).toBe('1.24 g/cm^3');
    expect(materialFromLibrary('whittle:unobtainium')).toBeUndefined();
  });

  it('assigning a library material yields a valid document', () => {
    const d = sampleDoc();
    req(d.parts[1]).material = materialFromLibrary('whittle:oak');
    expect(validateDoc(d)).toEqual([]);
  });
});

describe('resolveDensity', () => {
  it('handles alternative units and bare numbers', () => {
    expect(resolveDensity({ density: '2700 kg/m^3' })).toBeCloseTo(2.7e-6, 15);
    expect(resolveDensity({ density: '0.0975 lb/in^3' })).toBeCloseTo(
      (0.0975 * 0.45359237) / 25.4 ** 3,
      15,
    );
    expect(resolveDensity({ density: '7.85' })).toBeCloseTo(7.85e-6, 15); // bare = g/cm^3
    expect(resolveDensity({ density: '7850 kg/m^3' })).toBeCloseTo(
      resolveDensity({ density: '7.85 g/cm^3' }),
      15,
    );
  });

  it('can reference document parameters through a scope', () => {
    const scope = {
      params: { rho: '8 g/cm^3' },
      defaultLengthUnit: 'mm',
      defaultAngleUnit: 'deg',
    } as const;
    expect(resolveDensity({ density: 'rho * 0.5' }, expressionEngine, scope)).toBeCloseTo(4e-6, 15);
  });

  it('reports bad densities with human messages', () => {
    expect(tryResolveDensity({ density: '5 mm' })).toEqual({
      ok: false,
      message: 'Expected a density, but this is a length',
    });
    expect(tryResolveDensity({ density: '0 g/cm^3' })).toEqual({
      ok: false,
      message: 'Density must be greater than zero',
    });
    expect(tryResolveDensity({ density: '-1 g/cm^3' }).ok).toBe(false);
    expect(() => resolveDensity({ density: 'heavy' })).toThrow(/Unknown parameter ‘heavy’/);
  });

  it('mass of a 100 mm cube of aluminium 6061 is 2.7 kg', () => {
    const rho = resolveDensity(req(findMaterial('whittle:aluminium-6061-t6')));
    expect(rho * 100 ** 3).toBeCloseTo(2.7, 10);
  });
});
