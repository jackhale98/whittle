/**
 * Regen golden 3 (PLAN §7.3): upstream edits that split, merge or remove the topology downstream
 * features reference. Resolution must follow the geometry or report "needs attention" — never a
 * wrong guess.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BodyResult, EntityRef, Feature } from '@wren-cad/contracts';
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
  facesStartingWith,
  fid,
  fillet,
  loadApi,
  makeDoc,
  region,
  relClose,
  Sk,
  side,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const PART = fid('PART');
const S1 = fid('TS1');
const E1 = fid('TE1');
const SL = fid('TSL');
const CUT = fid('TCT');
const S3 = fid('TS3');
const E3 = fid('TE3');
const FI = fid('TFI');
const CH = fid('TCH');

const PI = Math.PI;

function plate(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 80, 50, '80', '50');
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10')];
}

const top: EntityRef = {
  name: `F${E1}:end`,
  kind: 'face',
  fingerprint: { centroid: [40, 25, 10], normal: [0, 0, 1], area: 4000 },
};

/** A slot across the whole top face (y −5…55) between x0 and x1, 3 deep: splits the top face. */
function slot(x0: number, x1: number): Feature[] {
  const s = new Sk();
  s.rect('s', 'K', x0, -5, x1, 55);
  for (const id of ['sa', 'sb', 'sc', 'sd']) s.geo({ kind: 'fix', entity: id });
  return [
    s.feature(SL, top, 'Slot'),
    extrude(CUT, [region(SL, 'K1,K2,K3,K4')], '3', 'cut', 'reverse'),
  ];
}

/** A 20 × 20 boss on the top face at x 5…25, y 10…30, 5 high. */
function boss(): Feature[] {
  const s = new Sk();
  s.rect('b', 'M', 5, 10, 25, 30);
  for (const id of ['ba', 'bb', 'bc', 'bd']) s.geo({ kind: 'fix', entity: id });
  return [s.feature(S3, top, 'Boss'), extrude(E3, [region(S3, 'M1,M2,M3,M4')], '5', 'add')];
}

/** The plate's top front edge (along x at y = 0, z = 10) as picked before any slot existed. */
const frontTop = edge(edgeName(`F${E1}:end`, side(E1, S1, 'L1')), {
  centroid: [40, 0, 10],
  length: 80,
});

describe.skipIf(!built)(`regen golden: topology changes upstream${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterEach(async () => {
    await api.closePart(PART);
  });

  const regen = (features: Feature[], params: Record<string, string> = {}) =>
    api.regenerate({
      doc: makeDoc(params, features),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });

  it('a cut that splits the face a sketch sits on: the sketch plane still resolves', async () => {
    const before = await regen([...plate(), ...boss()]);
    expect(states(before), describeFailures(before)).toEqual(['ok', 'ok', 'ok', 'ok']);
    relClose(totalVolume(before.bodies), 80 * 50 * 10 + 20 * 20 * 5, 1e-9);

    const after = await regen([...plate(), ...slot(35, 45), ...boss()]);
    expect(states(after), describeFailures(after)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // The top face is now two faces; both lie in the sketch's plane, so the frame is unchanged.
    const body = after.bodies[0] as BodyResult;
    expect(facesStartingWith(body, `F${E1}:end`).sort()).toEqual([`F${E1}:end#0`, `F${E1}:end#1`]);
    expect(after.sketches.find((s) => s.featureId === S3)?.frame.origin).toEqual([0, 0, 10]);
    relClose(totalVolume(after.bodies), 80 * 50 * 10 - 10 * 50 * 3 + 20 * 20 * 5, 1e-9);
  });

  it('an edge split in two equal pieces is ambiguous: needs attention with both candidates', async () => {
    const r = await regen([
      ...plate(),
      ...slot(35, 45),
      fillet(FI, [frontTop], '2'),
      chamfer(CH, [edge(edgeName(`F${E1}:start`, side(E1, S1, 'L1')))], '1'),
    ]);
    expect(states(r), describeFailures(r)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'needsAttention',
      'blocked',
    ]);
    const u = r.features[4]?.unresolved ?? [];
    expect(u).toHaveLength(1);
    expect(u[0]?.path).toBe('/edges/0');
    expect(u[0]?.ref).toEqual(frontTop);
    expect(u[0]?.reason).toBe('ambiguous');
    expect(u[0]?.candidates?.sort()).toEqual([
      edgeName(`F${E1}:end#0`, side(E1, S1, 'L1')),
      edgeName(`F${E1}:end#1`, side(E1, S1, 'L1')),
    ]);
    // The geometry before the failing feature is still output.
    relClose(totalVolume(r.bodies), 80 * 50 * 10 - 10 * 50 * 3, 1e-9);
  });

  it('an edge split unevenly follows the piece that clearly matches its fingerprint', async () => {
    const r = await regen([...plate(), ...slot(55, 65), fillet(FI, [frontTop], '2')]);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const body = r.bodies[0] as BodyResult;
    const faces = facesStartingWith(body, `F${FI}:fillet(`);
    expect(faces).toEqual([`F${FI}:fillet(${edgeName(`F${E1}:end#0`, side(E1, S1, 'L1'))})`]);
    const c = (await faceCentroid(api, body, faces[0] as string)) as number[];
    expect(c[0]).toBeCloseTo(27.5, 6);
    // The left piece is 55 long.
    relClose(totalVolume(r.bodies), 80 * 50 * 10 - 10 * 50 * 3 - (1 - PI / 4) * 4 * 55, 1e-9);
  });

  it('a dimension change that removes the referenced edge: needs attention, downstream blocked', async () => {
    const P = fid('TPK');
    const PS = fid('TPS');
    const pocket = new Sk();
    pocket.point('o', 0, 0, true);
    pocket.geo({ kind: 'fix', entity: 'o' });
    const r = pocket.rect('q', 'N', 30, 15, 50, 35, '20', '20');
    pocket.dim({ kind: 'hDistance', a: 'o', b: r.a }, 'pocket_x');
    pocket.dim({ kind: 'vDistance', a: 'o', b: r.a }, '15');
    const corner = edge(edgeName(side(P, PS, 'N1'), side(P, PS, 'N2')));
    const features: Feature[] = [
      ...plate(),
      pocket.feature(PS, top, 'Pocket'),
      extrude(P, [region(PS, 'N1,N2,N3,N4')], '4', 'cut', 'reverse'),
      fillet(FI, [corner], '2'),
      chamfer(CH, [frontTop], '1'),
    ];
    const doc = makeDoc({ pocket_x: '30 mm' }, features);
    const ok = await api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });
    expect(states(ok), describeFailures(ok)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Concave corner fillet adds (1 − π/4)·r²·depth; the chamfer removes ½·1²·80.
    relClose(totalVolume(ok.bodies), 40000 - 400 * 4 + (1 - PI / 4) * 4 * 4 - 0.5 * 80, 1e-9);

    const moved = await api.regenerate({
      doc: withParams(doc, { pocket_x: '200 mm' }),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(moved), describeFailures(moved)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'needsAttention',
      'blocked',
    ]);
    expect(moved.features[3]?.warnings?.[0]?.message).toBe('The cut does not touch any body');
    const u = moved.features[4]?.unresolved?.[0];
    expect(u?.path).toBe('/edges/0');
    expect(u?.ref).toEqual(corner);
    expect(u?.reason).toBe('missing');
    expect(moved.features[4]?.error?.code).toBe('UNRESOLVED_REFERENCE');
    // Earlier bodies are still output: the untouched plate.
    expect(moved.bodies.map((b) => b.id)).toEqual([`B${E1}`]);
    relClose(totalVolume(moved.bodies), 40000, 1e-9);
    // Last good geometry is offered as a ghost.
    expect(moved.ghosts?.map((g) => g.id)).toEqual([`B${E1}`]);
  });
});
