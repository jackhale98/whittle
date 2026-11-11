/**
 * ADR-084: the live result's mass readouts never show a partial sum or stale values while the
 * deferred mass fetch runs, and stop being pending once it settled (even if a fetch failed).
 */
import type { MassProperties, RegenResult } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { RegenView } from './state';
import { massPending, massSummary } from './tree-actions';
import type { Workbench } from './workbench';

const mp = (volume: number, mass?: number): MassProperties => ({
  volume,
  area: 1,
  centroid: [0, 0, 0],
  ...(mass === undefined ? {} : { mass }),
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  faceCount: 6,
  edgeCount: 12,
  vertexCount: 8,
});

function wbWith(bodies: RegenResult['bodies'], source: RegenView['source'] = 'live') {
  const view = {
    source,
    quality: 'coarse',
    doc: {},
    result: {
      partId: 'P',
      revision: 3,
      features: [],
      bodies,
      sketches: [],
      totalMs: 1,
      cache: { hits: 0, misses: 0 },
    },
  } as unknown as RegenView;
  return { regen: { get: () => view }, massSettledRevision: -1 } as unknown as Workbench & {
    massSettledRevision: number;
  };
}

const body = (shape: number, m?: MassProperties) =>
  ({
    id: `B${shape}`,
    shape,
    mesh: {},
    ...(m ? { massProperties: m } : {}),
  }) as RegenResult['bodies'][number];

describe('mass readouts while mass properties are pending', () => {
  it('is pending (no summary) while any live body lacks them', () => {
    const wb = wbWith([body(1, mp(10, 0.01)), body(2)]);
    expect(massPending(wb)).toBe(true);
    expect(massSummary(wb)).toBeUndefined();
  });

  it('sums once every body has them', () => {
    const wb = wbWith([body(1, mp(10, 0.01)), body(2, mp(5, 0.02))]);
    expect(massPending(wb)).toBe(false);
    expect(massSummary(wb)?.volume).toBe(15);
    expect(massSummary(wb)?.mass).toBeCloseTo(0.03, 12);
  });

  it('settles after the fetch even when it failed; cached meshes are never pending', () => {
    const wb = wbWith([body(1)]);
    wb.massSettledRevision = 3;
    expect(massPending(wb)).toBe(false);
    expect(massSummary(wb)).toBeUndefined();
    expect(massPending(wbWith([body(0)], 'cache'))).toBe(false);
  });
});
