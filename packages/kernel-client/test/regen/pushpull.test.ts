/**
 * Regen golden (M2): push/pull end to end through the regen engine — persistent names per
 * naming.ts "M2 additions", upstream dimension edits re-running the push/pull with its faces
 * resolved by name, downstream features on moved faces and on push/pull walls, failure surfacing,
 * and `ModelingApi.measure` on the latest regen.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BodyResult, EntityRef, Feature, PushPullFeature } from '@whittle/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  chamfer,
  describeFailures,
  edge,
  edgeName,
  extrude,
  faceCentroid,
  fid,
  fillet,
  loadApi,
  makeDoc as makeDocFor,
  region,
  relClose,
  Sk,
  side,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const PART = fid('PPART');
const S1 = fid('PS1');
const E1 = fid('PE1');
const CH = fid('PCH');
const PP = fid('PPP');
const FI = fid('PFI');
const S2 = fid('PS2');
const E2 = fid('PE2');
const CYL = fid('PCYL');

const K = 1 - Math.PI / 4;
const top = `F${E1}:end`;
const front = side(E1, S1, 'L1');
const right = side(E1, S1, 'L2');

/** A w × d × 10 plate from the origin, w and d from the document parameters. */
function plate(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 80, 50, 'w', 'd');
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10')];
}

function pushPull(id: string, faces: EntityRef[], distance: string): PushPullFeature {
  return { id, type: 'pushPull', name: 'Push/pull', suppressed: false, faces, distance };
}

const face = (name: string): EntityRef => ({ name, kind: 'face' });

const makeDoc = (params: Record<string, string>, features: Feature[]) =>
  makeDocFor(params, features, PART);

const regen = (api: Api, doc: ReturnType<typeof makeDoc>) =>
  api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });

const only = (bodies: BodyResult[]): BodyResult => {
  expect(bodies).toHaveLength(1);
  return bodies[0] as BodyResult;
};

describe.skipIf(!built)(`regen golden: push/pull${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterEach(async () => {
    await api.closePart(PART);
  });

  it('the top pulled +5; a width edit upstream re-runs it with the face resolved by name', async () => {
    const doc = makeDoc({ w: '80 mm', d: '50 mm' }, [
      ...plate(),
      pushPull(PP, [face(top)], '5 mm'),
    ]);
    const r1 = await regen(api, doc);
    expect(states(r1), describeFailures(r1)).toEqual(['ok', 'ok', 'ok']);
    const b1 = only(r1.bodies);
    expect(b1.id).toBe(`B${E1}`);
    relClose(totalVolume(r1.bodies), 80 * 50 * 15, 1e-9);
    expect([...b1.mesh.faceNames].sort()).toEqual(
      [top, `F${E1}:start`, ...['L1', 'L2', 'L3', 'L4'].map((l) => side(E1, S1, l))].sort(),
    );
    const c = await faceCentroid(api, b1, top);
    for (const [i, v] of [40, 25, 15].entries()) expect(c?.[i]).toBeCloseTo(v, 9);

    const r2 = await regen(api, withParams(doc, { w: '100 mm' }));
    expect(states(r2), describeFailures(r2)).toEqual(['ok', 'ok', 'ok']);
    relClose(totalVolume(r2.bodies), 100 * 50 * 15, 1e-9);
    expect(r2.features[2]?.cached).toBe(false);
    expect(r2.features[2]?.rebound).toBeUndefined();
    // Unchanged document: everything from the cache.
    const r3 = await regen(api, withParams(doc, { w: '100 mm' }));
    expect(r3.cache).toEqual({ hits: 3, misses: 0 });
  });

  it('a side face pulled out survives depth and width edits; a fillet on its edge follows', async () => {
    const doc = makeDoc({ w: '80 mm', d: '50 mm', grow: '10 mm' }, [
      ...plate(),
      pushPull(PP, [face(right)], 'grow'),
      fillet(FI, [edge(edgeName(top, right))], '2 mm'),
    ]);
    const r1 = await regen(api, doc);
    expect(states(r1), describeFailures(r1)).toEqual(['ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(r1.bodies), 90 * 50 * 10 - K * 4 * 50, 1e-9);
    expect(only(r1.bodies).mesh.faceNames).toContain(`F${FI}:fillet(${edgeName(top, right)})`);

    for (const [changes, volume] of [
      [{ d: '60 mm' }, 90 * 60 * 10 - K * 4 * 60],
      [{ w: '70 mm', d: '60 mm' }, 80 * 60 * 10 - K * 4 * 60],
      [{ w: '70 mm', d: '60 mm', grow: '-20 mm' }, 50 * 60 * 10 - K * 4 * 60],
    ] as const) {
      const r = await regen(api, withParams(doc, changes));
      expect(states(r), `${JSON.stringify(changes)} ${describeFailures(r)}`).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
      ]);
      relClose(totalVolume(r.bodies), volume, 1e-9);
      expect(r.features[3]?.rebound).toBeUndefined();
    }
  });

  it('a wall created by push/pull is named after its edge; a fillet on it survives edits', async () => {
    // Chamfer the front-top edge, then pull the (narrowed) top up: the wall above the chamfer
    // edge is new — F<pp>:side(edge(<chamfer>|<top>)) — and gets a fillet along the moved top.
    const chamferFace = `F${CH}:chamfer(${edgeName(top, front)})`;
    const wall = `F${PP}:side(${edgeName(chamferFace, top)})`;
    const doc = makeDoc({ w: '80 mm', d: '50 mm' }, [
      ...plate(),
      chamfer(CH, [edge(edgeName(top, front))], '2 mm'),
      pushPull(PP, [face(top)], '5 mm'),
      fillet(FI, [edge(edgeName(top, wall))], '1 mm'),
    ]);
    const volume = (w: number, d: number) => w * d * 10 - 2 * w + 5 * w * (d - 2) - K * w;
    const r1 = await regen(api, doc);
    expect(states(r1), describeFailures(r1)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const b1 = only(r1.bodies);
    expect(b1.mesh.faceNames).toContain(wall);
    expect(b1.mesh.faceNames).toContain(chamferFace);
    relClose(totalVolume(r1.bodies), volume(80, 50), 1e-9);

    const r2 = await regen(api, withParams(doc, { d: '60 mm', w: '90 mm' }));
    expect(states(r2), describeFailures(r2)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(r2.bodies), volume(90, 60), 1e-9);
    expect(r2.features[4]?.rebound).toBeUndefined();
    expect(only(r2.bodies).mesh.faceNames).toContain(`F${FI}:fillet(${edgeName(top, wall)})`);
  });

  it('a pocket floor pulled flush swallows the pocket; a ref to the floor then needs attention', async () => {
    const s = new Sk();
    const r = s.rect('q', 'M', 20, 10, 60, 40);
    s.geo({ kind: 'fix', entity: r.a });
    s.geo({ kind: 'fix', entity: r.c });
    const floor = `F${E2}:end`;
    const doc = makeDoc({ w: '80 mm', d: '50 mm', lift: '4 mm' }, [
      ...plate(),
      s.feature(S2, face(top), 'Pocket'),
      extrude(E2, [region(S2, 'M1,M2,M3,M4')], '4', 'cut', 'reverse'),
      pushPull(PP, [face(floor)], 'lift'),
      pushPull(fid('PPQ'), [face(floor)], '1 mm'),
    ]);
    const half = await regen(api, withParams(doc, { lift: '2 mm' }));
    expect(states(half), describeFailures(half)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(half.bodies), 40000 - 40 * 30 * 4 + 40 * 30 * 3, 1e-9);

    const flush = await regen(api, doc);
    expect(states(flush)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'needsAttention']);
    relClose(totalVolume(flush.bodies), 40000, 1e-9);
    expect(only(flush.bodies).mesh.faceNames.filter((n) => n.startsWith(`F${E2}:`))).toEqual([]);
    expect(flush.features[5]?.unresolved?.[0]?.ref.name).toBe(floor);
  });

  describe('faces with different normals (ADR-013 addendum: one step per normal group)', () => {
    const back = side(E1, S1, 'L3');
    const bottom = `F${E1}:start`;
    const box = [top, bottom, ...['L1', 'L2', 'L3', 'L4'].map((l) => side(E1, S1, l))].sort();

    it('top + side pulled +5 is the uniform offset: the corner is filled, names kept', async () => {
      const doc = makeDoc({ w: '80 mm', d: '50 mm' }, [
        ...plate(),
        pushPull(PP, [face(top), face(right)], '5 mm'),
      ]);
      const r = await regen(api, doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
      const b = only(r.bodies);
      // 85 × 50 × 15; per-face prisms in one boolean left out the 5 × 5 × 50 corner (62500).
      relClose(totalVolume(r.bodies), 85 * 50 * 15, 1e-9);
      expect([...b.mesh.faceNames].sort()).toEqual(box);
      const c = await faceCentroid(api, b, right);
      for (const [i, v] of [85, 25, 7.5].entries()) expect(c?.[i]).toBeCloseTo(v, 9);

      // The selection order does not change the result or its naming.
      const swapped = await regen(
        api,
        makeDoc({ w: '80 mm', d: '50 mm' }, [
          ...plate(),
          pushPull(PP, [face(right), face(top)], '5 mm'),
        ]),
      );
      relClose(totalVolume(swapped.bodies), 85 * 50 * 15, 1e-9);
      expect(only(swapped.bodies).mesh.faceNames).toEqual(b.mesh.faceNames);
      expect(only(swapped.bodies).mesh.edgeNames).toEqual(b.mesh.edgeNames);

      // A width edit upstream re-runs both steps with the faces resolved by name.
      const wide = await regen(api, withParams(doc, { w: '100 mm' }));
      expect(states(wide), describeFailures(wide)).toEqual(['ok', 'ok', 'ok']);
      relClose(totalVolume(wide.bodies), 105 * 50 * 15, 1e-9);
    });

    it('top + side pushed −3 stays the uniform inset (77 × 50 × 7)', async () => {
      const r = await regen(
        api,
        makeDoc({ w: '80 mm', d: '50 mm' }, [
          ...plate(),
          pushPull(PP, [face(top), face(right)], '-3 mm'),
        ]),
      );
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
      relClose(totalVolume(r.bodies), 77 * 50 * 7, 1e-9);
      expect([...only(r.bodies).mesh.faceNames].sort()).toEqual(box);
    });

    it('two opposite parallel faces pulled +5 widen the plate as before', async () => {
      const r = await regen(
        api,
        makeDoc({ w: '80 mm', d: '50 mm' }, [
          ...plate(),
          pushPull(PP, [face(front), face(back)], '5 mm'),
        ]),
      );
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
      relClose(totalVolume(r.bodies), 80 * 60 * 10, 1e-9);
      const b = only(r.bodies);
      expect([...b.mesh.faceNames].sort()).toEqual(box);
      expect((await faceCentroid(api, b, front))?.[1]).toBeCloseTo(-5, 9);
      expect((await faceCentroid(api, b, back))?.[1]).toBeCloseTo(55, 9);
    });

    it('a face swallowed by an earlier step fails the feature with that face named', async () => {
      // A 4 mm pocket: its floor (+z) moves first and fills it, so the pocket wall facing +x
      // (the second group) no longer exists.
      const s = new Sk();
      const q = s.rect('q', 'M', 20, 10, 60, 40);
      s.geo({ kind: 'fix', entity: q.a });
      s.geo({ kind: 'fix', entity: q.c });
      const floor = `F${E2}:end`;
      const wall = side(E2, S2, 'M4');
      const r = await regen(
        api,
        makeDoc({ w: '80 mm', d: '50 mm' }, [
          ...plate(),
          s.feature(S2, face(top), 'Pocket'),
          extrude(E2, [region(S2, 'M1,M2,M3,M4')], '4', 'cut', 'reverse'),
          pushPull(PP, [face(wall), face(floor)], '4 mm'),
        ]),
      );
      expect(states(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'error']);
      const e = r.features[4]?.error;
      expect(e?.code).toBe('UNRESOLVED_REFERENCE');
      expect(e?.message).toMatch(/face 1 is gone/);
      expect(e?.entityRefs).toEqual([wall]);
      // The body keeps the pocketed geometry.
      relClose(totalVolume(r.bodies), 40000 - 40 * 30 * 4, 1e-9);
    });
  });

  it('failures surface as feature errors with the face named; the body keeps its geometry', async () => {
    const cyl: Feature = {
      id: CYL,
      type: 'primitive',
      name: 'Cylinder',
      suppressed: false,
      op: 'new',
      shape: 'cylinder',
      radius: '5 mm',
      height: '10 mm',
    };
    const doc = makeDoc({}, [
      cyl,
      pushPull(PP, [face(`F${CYL}:face.side`)], '2 mm'),
      pushPull(fid('PPQ'), [face(`F${CYL}:face.zmax`)], '2 mm'),
    ]);
    const r = await regen(api, doc);
    expect(states(r)).toEqual(['ok', 'error', 'blocked']);
    const e = r.features[1]?.error;
    expect(e?.code).toBe('UNSUPPORTED_FEATURE');
    expect(e?.message).toMatch(/face 1 .*curved/i);
    expect(e?.entityRefs).toEqual([`F${CYL}:face.side`]);
    relClose(totalVolume(r.bodies), Math.PI * 25 * 10, 1e-9);

    // Pushing the whole body away is an error too, never an empty or invalid body.
    const gone = await regen(
      api,
      makeDoc({}, [cyl, pushPull(PP, [face(`F${CYL}:face.zmax`)], '-10 mm')]),
    );
    expect(states(gone)).toEqual(['ok', 'error']);
    expect(gone.features[1]?.error?.message).toMatch(/removes the whole body/);
    relClose(totalVolume(gone.bodies), Math.PI * 25 * 10, 1e-9);

    // Faces of two bodies at once.
    const two = await regen(
      api,
      makeDoc({ w: '80 mm', d: '50 mm' }, [
        ...plate(),
        { ...cyl, id: CYL },
        pushPull(PP, [face(top), face(`F${CYL}:face.zmax`)], '2 mm'),
      ]),
    );
    expect(states(two)).toEqual(['ok', 'ok', 'ok', 'error']);
    expect(two.features[3]?.error?.message).toMatch(/one body/);
  });

  describe('measure', () => {
    it('measures faces, edges, vertices and points of the latest regen', async () => {
      const doc = makeDoc({ w: '80 mm', d: '50 mm' }, [
        ...plate(),
        pushPull(PP, [face(top)], '5 mm'),
      ]);
      expect((await api.measure(PART, { point: [0, 0, 0] })).ok).toBe(false);
      const r = await regen(api, doc);
      const body = only(r.bodies);
      const fi = (name: string) => body.mesh.faceNames.indexOf(name);
      const ei = (name: string) => body.mesh.edgeNames.indexOf(name);
      const at = (kind: 'face' | 'edge' | 'vertex', index: number) => ({
        bodyId: body.id,
        kind,
        index,
      });

      const area = await api.measure(PART, at('face', fi(top)));
      if (!area.ok) throw new Error(JSON.stringify(area.error));
      relClose(area.value.area ?? 0, 80 * 50, 1e-12);

      const thickness = await api.measure(
        PART,
        at('face', fi(top)),
        at('face', fi(`F${E1}:start`)),
      );
      if (!thickness.ok) throw new Error(JSON.stringify(thickness.error));
      relClose(thickness.value.distance?.value ?? 0, 15, 1e-12);
      relClose(thickness.value.angle ?? 0, Math.PI, 1e-12);

      const length = await api.measure(PART, at('edge', ei(edgeName(top, front))));
      if (!length.ok) throw new Error(JSON.stringify(length.error));
      relClose(length.value.length ?? 0, 80, 1e-12);

      const corner = await api.measure(PART, at('vertex', 0), { point: [0, 0, 100] });
      if (!corner.ok) throw new Error(JSON.stringify(corner.error));
      expect(corner.value.distance?.value).toBeGreaterThan(0);

      // The same face resolves to the same index as refFor does.
      const ref = await api.refFor(PART, { bodyId: body.id, kind: 'face', index: fi(top) });
      expect(ref?.name).toBe(top);

      const missing = await api.measure(PART, { bodyId: 'Bnope', kind: 'face', index: 0 });
      expect(missing.ok ? null : missing.error.code).toBe('UNRESOLVED_REFERENCE');
      const range = await api.measure(PART, at('face', 9999));
      expect(range.ok ? null : range.error.code).toBe('UNRESOLVED_REFERENCE');
      const bad = await api.measure(PART, { point: [0, Number.NaN, 0] });
      expect(bad.ok ? null : bad.error.code).toBe('INVALID_INPUT');
    });
  });
});
