/**
 * ADR-083: a regen integrates mass properties only where it must. The bounding-box prefilters and
 * "the cut left the body unchanged" checks read the kernel's cheap `bounds` (the same box and
 * counts), so a regen that does not ask for mass properties integrates nothing, except the two
 * bodies of a cut that agrees with its body on every cheap invariant (then their volumes decide,
 * as before). `massProperties(shape)` afterwards is served from the engine's per-handle cache.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  region,
  relClose,
  Sk,
  skipNote,
  states,
} from './helpers';

const PART = fid('MASSPART');
const PI = Math.PI;

function circleSketch(id: string, x: number, y: number, r: number): Feature {
  const s = new Sk();
  s.circle('C', x, y, r);
  s.geo({ kind: 'fix', entity: 'Cc' });
  s.dim({ kind: 'radius', curve: 'C' }, String(r));
  return s.feature(fid(id));
}

/** Plate 60 × 40 × 10; a through hole r10; a blind r4 cut inside that hole (touches nothing); a
 * through hole r3; a blind r3 pocket 4 deep. */
function features(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 60, 40, '60', '40');
  s.geo({ kind: 'fix', entity: r.a });
  return [
    s.feature(fid('MS0')),
    extrude(fid('ME0'), [region(fid('MS0'), 'L1,L2,L3,L4')], '10'),
    circleSketch('MS1', 30, 20, 10),
    extrude(fid('MC1'), [region(fid('MS1'), 'C')], 'throughAll', 'cut'),
    circleSketch('MS2', 30, 20, 4),
    extrude(fid('MC2'), [region(fid('MS2'), 'C')], '5', 'cut'),
    circleSketch('MS3', 10, 10, 3),
    extrude(fid('MC3'), [region(fid('MS3'), 'C')], 'throughAll', 'cut'),
    circleSketch('MS4', 50, 30, 3),
    extrude(fid('MC4'), [region(fid('MS4'), 'C')], '4', 'cut'),
  ];
}

const VOLUME = 60 * 40 * 10 - PI * 100 * 10 - PI * 9 * 10 - PI * 9 * 4;

describe.skipIf(!built)(`regen: mass properties on demand (ADR-083)${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  const massEntries = async () => (await api.memoryStats()).regen.shapeCaches.massProperties;

  it('integrates nothing it is not asked for; massProperties() afterwards is cached', async () => {
    const doc = makeDoc({}, features(), PART);
    const r = await api.regenerate({ doc, partId: PART, quality: 'coarse' });
    expect(states(r), describeFailures(r)).toEqual(Array(10).fill('ok'));
    // The cut inside the hole still reports that it touches nothing (the volume check decided).
    expect(r.features[5]?.warnings?.map((w) => w.message)).toEqual([
      'The cut does not touch any body',
    ]);
    expect(r.bodies).toHaveLength(1);
    const body = r.bodies[0];
    expect(body?.massProperties).toBeUndefined();
    // Only that cut's body was integrated (its unchanged result was released with its entry).
    expect(await massEntries()).toBe(1);

    const mp = await api.massProperties(body?.shape ?? 0);
    if (!mp.ok) throw new Error(JSON.stringify(mp.error));
    relClose(mp.value.volume, VOLUME, 1e-9);
    expect(mp.value.faceCount).toBe((body?.mesh.faceRanges.length ?? 0) / 2);
    expect(await massEntries()).toBe(2);
    // Again, and from a regen that asks for them: the same values, no new integration.
    const again = await api.massProperties(body?.shape ?? 0);
    expect(again).toEqual(mp);
    const withMass = await api.regenerate({
      doc,
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(withMass.cache.misses).toBe(0);
    expect(withMass.bodies[0]?.massProperties).toEqual(mp.value);
    expect(await massEntries()).toBe(2);

    // A shape the engine does not own goes straight to the kernel (and is not cached).
    const own = await api.execFeature(
      {
        id: fid('MBOX'),
        type: 'primitive',
        name: 'Box',
        suppressed: false,
        op: 'new',
        shape: 'box',
        dx: '1 mm',
        dy: '2 mm',
        dz: '3 mm',
      } as Feature,
      { values: { '/dx': 1, '/dy': 2, '/dz': 3 } },
    );
    if (!own.ok) throw new Error(JSON.stringify(own.error));
    const boxMass = await api.massProperties(own.value.shape);
    expect(boxMass.ok && boxMass.value.volume).toBeCloseTo(6, 9);
    expect(await massEntries()).toBe(2);
    await api.release(own.value.shape);
  }, 60_000);

  it('bounds equal the massProperties box and counts', async () => {
    const doc = makeDoc({}, features(), PART);
    const r = await api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });
    const body = r.bodies[0];
    const b = await api.bounds(body?.shape ?? 0);
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    const mp = body?.massProperties;
    expect(b.value).toEqual({
      bbox: mp?.bbox,
      faceCount: mp?.faceCount,
      edgeCount: mp?.edgeCount,
      vertexCount: mp?.vertexCount,
    });
    const bad = await api.bounds(987_654);
    expect(bad.ok ? 'ok' : bad.error.code).toBe('INVALID_HANDLE');
  }, 60_000);
});
