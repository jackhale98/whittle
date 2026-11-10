/**
 * The M3.7 reference part with configurations: a 40 × 20 × 10 mm plate with a 10 × 8 mm boss on one
 * side and a through hole, in three configurations that vary a parameter, a feature field and a
 * suppression. Masses are exact closed forms (density 1000 kg/m³ = 1e-6 kg/mm³), recorded here
 * with their derivation; the golden test regenerates each configuration and compares.
 *
 *   plate  box L × 20 × T          (op new)
 *   boss   box 10 × 8 × T at y = 20 (op add, touches the plate's +Y face)
 *   hole   cylinder radius R, height 40 at (20, 10) (op cut, through the plate)
 *
 *   Default      L = 40, T = 10, R = 4:   V = 8000 + 800 − π·16·10  = 8297.35 mm³
 *   Long         L = 60 (parameter):      V = 12000 + 800 − π·16·10 = 12297.35 mm³
 *   Thick        T = 15 (parameter), boss suppressed, R = 6 (field):
 *                                         V = 40·20·15 − π·36·15    = 10303.54 mm³
 */

import type { Feature, WrenDoc } from '@wren-cad/contracts';
import { SCHEMA_VERSION } from '@wren-cad/contracts';
import { fid } from '../fixtures';

export const PLATE = fid('CPLATE');
export const BOSS = fid('CBOSS');
export const HOLE = fid('CHOLE');
export const P_LENGTH = fid('CPL');
export const P_THICK = fid('CPT');
export const CFG_LONG = fid('CLONG');
export const CFG_THICK = fid('CTHICK');
export const PART = fid('CPART');

/** kg per mm³ for 1000 kg/m³. */
const DENSITY = 1e-6;
const PI = Math.PI;

export const expectedMass = {
  default: (8000 + 800 - PI * 16 * 10) * DENSITY,
  long: (12000 + 800 - PI * 16 * 10) * DENSITY,
  thick: (40 * 20 * 15 - PI * 36 * 15) * DENSITY,
} as const;

export function configPartDoc(withConfigurations = true): WrenDoc {
  const features: Feature[] = [
    {
      id: PLATE,
      type: 'primitive',
      name: 'Plate',
      suppressed: false,
      op: 'new',
      shape: 'box',
      dx: 'length',
      dy: '20 mm',
      dz: 'thick',
    },
    {
      id: BOSS,
      type: 'primitive',
      name: 'Boss',
      suppressed: false,
      op: 'add',
      shape: 'box',
      dx: '10 mm',
      dy: '8 mm',
      dz: 'thick',
      frame: { origin: [0, 20, 0], z: [0, 0, 1], x: [1, 0, 0] },
    },
    {
      id: HOLE,
      type: 'primitive',
      name: 'Hole',
      suppressed: false,
      op: 'cut',
      shape: 'cylinder',
      radius: '4 mm',
      height: '40 mm',
      frame: { origin: [20, 10, 0], z: [0, 0, 1], x: [1, 0, 0] },
    },
  ];
  const now = '2026-11-10T00:00:00.000Z';
  return {
    schemaVersion: SCHEMA_VERSION,
    units: { length: 'mm', angle: 'deg' },
    params: [
      { id: P_LENGTH, name: 'length', expr: '40 mm' },
      { id: P_THICK, name: 'thick', expr: '10 mm' },
    ],
    parts: [
      {
        id: PART,
        name: 'Plate family',
        features,
        rollbackIndex: features.length,
        material: { name: 'Test 1000 kg/m³', density: '1000 kg/m^3' },
        ...(withConfigurations
          ? {
              configurations: [
                { id: CFG_LONG, name: 'Long', params: { [P_LENGTH]: '60 mm' } },
                {
                  id: CFG_THICK,
                  name: 'Thick',
                  params: { [P_THICK]: '15 mm' },
                  features: {
                    [BOSS]: { suppressed: true },
                    [HOLE]: { fields: { '/radius': '6 mm' } },
                  },
                },
              ],
            }
          : {}),
      },
    ],
    assemblies: [],
    drawings: [],
    meta: { id: fid('DOCCFG'), name: 'Plate', created: now, modified: now, app: 'wren/e2e' },
  };
}
