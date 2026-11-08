import type { Feature, FeatureInputs } from '@whittle/contracts';

/** M0 demo body: a 40 × 30 × 20 mm box made by the OCCT kernel. Replaced by documents in M1. */
export const DEMO_BOX: Feature = {
  id: '01JCM0DEM0B0X0000000000001',
  type: 'primitive',
  name: 'Box 1',
  suppressed: false,
  op: 'new',
  shape: 'box',
  dx: '40mm',
  dy: '30mm',
  dz: '20mm',
};

export const DEMO_BOX_INPUTS: FeatureInputs = { values: { '/dx': 40, '/dy': 30, '/dz': 20 } };
