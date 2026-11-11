/**
 * ADR-093 golden: `RegenResult.references` carries every evaluated plane, axis and point feature
 * in its final position with a part-sized extent; suppressed, failed and rolled-back ones are
 * left out; showing or hiding one never changes a cache key. Runs on the current real kernel.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AxisFeature,
  Feature,
  PlaneFeature,
  PointFeature,
  PrimitiveFeature,
  ReferenceResult,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Api, built, fid, loadApi, makeDoc as makeDocFor, skipNote } from './helpers';

const PART = fid('RFPART');
const makeDoc = (features: Feature[]) => makeDocFor({}, features, PART);
let api: Api;
beforeAll(async () => {
  if (built) api = await loadApi();
}, 60_000);
const regen = (doc: WrenDoc) => api.regenerate({ doc, partId: PART, quality: 'coarse' });

const box: PrimitiveFeature = {
  id: fid('RFBOX'),
  type: 'primitive',
  name: 'Box',
  suppressed: false,
  op: 'new',
  shape: 'box',
  dx: '120 mm',
  dy: '80 mm',
  dz: '60 mm',
};
const DIAG = Math.hypot(120, 80, 60);
const v = (s: string) => ({ name: `F${box.id}:vertex(${s})`, kind: 'vertex' as const });
const offset = (id: string, distance: string, extra: Partial<PlaneFeature> = {}): PlaneFeature => ({
  id: fid(id),
  type: 'plane',
  name: 'Offset',
  suppressed: false,
  definition: { kind: 'offset', from: { name: 'origin:XY', kind: 'face' }, distance },
  ...extra,
});
const close = (a: Vec3 | undefined, b: Vec3) => {
  expect(a).toBeDefined();
  for (let i = 0; i < 3; i++)
    expect(Math.abs(((a as Vec3)[i] as number) - (b[i] as number))).toBeLessThan(1e-6);
};
const ref = (refs: ReferenceResult[] | undefined, id: string) =>
  refs?.find((r) => r.featureId === fid(id));

describe.skipIf(!built)(`regen golden (ADR-093): reference results${skipNote}`, () => {
  it('an offset plane is reported at its final frame, sized to the part', async () => {
    const r = await regen(makeDoc([box, offset('RFP1', '25 mm')]));
    expect(r.references).toHaveLength(1);
    const p = ref(r.references, 'RFP1') as ReferenceResult;
    expect(p.kind).toBe('plane');
    close(p.frame.origin, [0, 0, 25]);
    close(p.frame.z, [0, 0, 1]);
    close(p.frame.x, [1, 0, 0]);
    close(p.frame.y, [0, 1, 0]);
    expect(p.extent).toBeCloseTo(0.6 * DIAG, 6);
  }, 60_000);

  it('a flipped offset plane reports the flipped normal; an empty part gets the minimum extent', async () => {
    const r = await regen(makeDoc([offset('RFP2', '5 mm', { flip: true })]));
    const p = ref(r.references, 'RFP2') as ReferenceResult;
    close(p.frame.z, [0, 0, -1]);
    close(p.frame.origin, [0, 0, 5]);
    expect(p.extent).toBe(50);
  }, 60_000);

  it('a three-point plane, a two-point axis and a coordinate point', async () => {
    const three: PlaneFeature = {
      id: fid('RFP3'),
      type: 'plane',
      name: 'Top',
      suppressed: false,
      definition: {
        kind: 'threePoints',
        points: [v('min,min,max'), v('max,min,max'), v('min,max,max')],
      },
    };
    const axis: AxisFeature = {
      id: fid('RFAX'),
      type: 'axis',
      name: 'Axis',
      suppressed: false,
      definition: { kind: 'twoPoints', a: v('min,min,min'), b: v('max,min,min') },
    };
    const pt: PointFeature = {
      id: fid('RFPT'),
      type: 'point',
      name: 'Point',
      suppressed: false,
      definition: { kind: 'coordinates', x: '12 mm', y: '-4 mm', z: '30 mm' },
    };
    const r = await regen(makeDoc([box, three, axis, pt]));
    expect(r.references?.map((x) => [x.featureId, x.kind])).toEqual([
      [three.id, 'plane'],
      [axis.id, 'axis'],
      [pt.id, 'point'],
    ]);
    const plane = ref(r.references, 'RFP3') as ReferenceResult;
    close(plane.frame.origin, [0, 0, 60]);
    expect(Math.abs(plane.frame.z[2])).toBeCloseTo(1, 9);
    const ax = ref(r.references, 'RFAX') as ReferenceResult;
    close(ax.frame.origin, [0, 0, 0]);
    close(ax.frame.z, [1, 0, 0]);
    const p = ref(r.references, 'RFPT') as ReferenceResult;
    close(p.frame.origin, [12, -4, 30]);
  }, 60_000);

  it('suppressed, failed and rolled-back references are left out', async () => {
    const doc = makeDoc([
      box,
      offset('RFOK', '1 mm'),
      offset('RFSUP', '2 mm', { suppressed: true }),
      offset('RFBAD', 'nope + 1'),
      offset('RFLATE', '3 mm'),
    ]);
    const r = await regen(doc);
    expect(r.references?.map((x) => x.featureId)).toEqual([fid('RFOK'), fid('RFLATE')]);
    const part = doc.parts[0];
    if (part) part.rollbackIndex = 2;
    const rolled = await regen(doc);
    expect(rolled.references?.map((x) => x.featureId)).toEqual([fid('RFOK')]);
  }, 60_000);

  it('visibility is not part of any cache key', async () => {
    const first = await regen(makeDoc([box, offset('RFV', '10 mm')]));
    const second = await regen(makeDoc([box, offset('RFV', '10 mm', { visibility: 'hidden' })]));
    expect(second.cache.misses).toBe(0);
    expect(second.cache.hits).toBe(first.cache.hits + first.cache.misses);
    expect(second.references).toHaveLength(1);
  }, 60_000);
});
