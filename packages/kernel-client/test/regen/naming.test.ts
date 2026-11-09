/**
 * Regen golden 10 (PLAN §7.3): persistent naming under **dimension** edits (no feature inserted)
 * that split and merge faces. Downstream fillets and sketches must resolve to the geometrically
 * right entity — reported as rebound when the name changed — or go "needs attention"; never a
 * wrong pick.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BodyResult, EntityRef, Feature, Vec3 } from '@wren-cad/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  describeFailures,
  edge,
  edgeName,
  extrude,
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

const PART = fid('NPART');
const S1 = fid('NS1');
const E1 = fid('NE1');
const NA = fid('NNA');
const CA = fid('NCA');
const NB = fid('NNB');
const CB = fid('NCB');
const FI = fid('NFI');
const SH = fid('NSH');
const CH = fid('NCH');

const PI = Math.PI;
const K = 1 - PI / 4;

/** A W × D × 10 plate from the origin. */
function plate(w: number, d: number): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, w, d, `${w}`, `${d}`);
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10')];
}

const topOf = (w: number, d: number): EntityRef => ({
  name: `F${E1}:end`,
  kind: 'face',
  fingerprint: { centroid: [w / 2, d / 2, 10], normal: [0, 0, 1], area: w * d },
});

/**
 * A notch across the whole top face (y −5 … d + 5) from x = x0, `width` wide (an expression), cut
 * `depth` deep: splits the top face.
 */
function notch(
  sketchId: string,
  cutId: string,
  on: EntityRef,
  d: number,
  x0: string,
  width: string,
  depth: string,
): Feature[] {
  const s = new Sk();
  s.point('o', 0, 0, true);
  s.geo({ kind: 'fix', entity: 'o' });
  const r = s.rect('n', 'K', 20, -5, 30, d + 5);
  s.dim({ kind: 'hDistance', a: 'o', b: r.a }, x0);
  s.dim({ kind: 'vDistance', a: r.a, b: 'o' }, '5');
  s.dim({ kind: 'hDistance', a: r.a, b: r.b }, width);
  s.dim({ kind: 'vDistance', a: r.b, b: r.c }, `${d + 10}`);
  return [
    s.feature(sketchId, on, 'Notch'),
    extrude(cutId, [region(sketchId, 'K1,K2,K3,K4')], depth, 'cut', 'reverse'),
  ];
}

/** A circle of radius 3 at (x, y) on `on`, cut 2 deep. */
function hole(on: EntityRef, x: number, y: number): Feature[] {
  const s = new Sk();
  s.circle('C', x, y, 3);
  s.geo({ kind: 'fix', entity: 'Cc' });
  return [s.feature(SH, on, 'Hole'), extrude(CH, [region(SH, 'C')], '2', 'cut', 'reverse')];
}

const frontTop = (face: string) => edgeName(face, side(E1, S1, 'L1'));
const leftTop = (face: string) => edgeName(face, side(E1, S1, 'L4'));

async function filletCentroid(api: Api, body: BodyResult): Promise<Vec3 | null> {
  const names = facesStartingWith(body, `F${FI}:fillet(`);
  if (names.length !== 1) return null;
  const i = body.mesh.faceNames.indexOf(names[0] as string);
  const fp = await api.fingerprints(body.shape);
  return fp.ok ? (fp.value.faces[i]?.centroid ?? null) : null;
}

describe.skipIf(!built)(`regen golden: naming under dimension edits${skipNote}${''}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterEach(async () => {
    await api.closePart(PART);
  });

  it('a notch moved off the part merges the top faces, and back: refs follow both ways', async () => {
    const top = topOf(80, 50);
    // Picked while the notch (x 35 … 45) split the top face: the left piece's front edge and
    // the right piece (for a sketch).
    const leftFront = edge(frontTop(`F${E1}:end#0`), { centroid: [17.5, 0, 10], length: 35 });
    const rightPiece: EntityRef = {
      name: `F${E1}:end#1`,
      kind: 'face',
      fingerprint: { centroid: [62.5, 25, 10], normal: [0, 0, 1], area: 1750 },
    };
    const doc = makeDoc(
      { nx: '35 mm', nd: '3 mm' },
      [
        ...plate(80, 50),
        ...notch(NA, CA, top, 50, 'nx', '10 mm', 'nd'),
        fillet(FI, [leftFront], '1'),
        ...hole(rightPiece, 65, 25),
      ],
      PART,
    );
    const run = (params: Record<string, string>) =>
      api.regenerate({
        doc: withParams(doc, params),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
    const split = await run({});
    expect(states(split), describeFailures(split)).toEqual(Array(7).fill('ok'));
    expect(split.features.every((f) => f.rebound === undefined)).toBe(true);
    relClose(totalVolume(split.bodies), 40000 - 1500 - K * 35 - PI * 18, 1e-9);
    const c0 = (await filletCentroid(api, split.bodies[0] as BodyResult)) as Vec3;
    expect(c0[0]).toBeCloseTo(17.5, 6);

    // Notch moved past the end: the cut touches nothing, the top face is whole again.
    const merged = await run({ nx: '100 mm' });
    expect(states(merged), describeFailures(merged)).toEqual(Array(7).fill('ok'));
    expect(merged.features[3]?.warnings?.[0]?.message).toBe('The cut does not touch any body');
    const body = merged.bodies[0] as BodyResult;
    expect(facesStartingWith(body, `F${E1}:end`)).toEqual([`F${E1}:end`]);
    // The pieces merged back into one edge / face: the fillet runs along the whole front edge,
    // the hole sits on the whole top; both reported as rebound to the merged names.
    expect(merged.features[4]?.rebound?.map((r) => r.name)).toEqual([frontTop(`F${E1}:end`)]);
    expect(merged.features[5]?.rebound?.map((r) => r.name)).toEqual([`F${E1}:end`]);
    expect(merged.features[4]?.rebound?.[0]?.fingerprint?.length).toBeCloseTo(80, 9);
    relClose(totalVolume(merged.bodies), 40000 - K * 80 - PI * 18, 1e-9);

    // And back: exact names again, nothing rebound, the original geometry.
    const back = await run({});
    expect(states(back)).toEqual(Array(7).fill('ok'));
    expect(back.features.every((f) => f.rebound === undefined)).toBe(true);
    relClose(totalVolume(back.bodies), 40000 - 1500 - K * 35 - PI * 18, 1e-9);
    expect(back.cache.hits).toBe(7);
  });

  it('a notch whose depth goes to 0: a clear error, downstream blocked, last good geometry kept', async () => {
    const top = topOf(80, 50);
    const doc = makeDoc(
      { nd: '3 mm' },
      [
        ...plate(80, 50),
        ...notch(NA, CA, top, 50, '35 mm', '10 mm', 'nd'),
        fillet(FI, [edge(frontTop(`F${E1}:end#0`), { centroid: [17.5, 0, 10], length: 35 })], '1'),
      ],
      PART,
    );
    const ok = await api.regenerate({ doc, partId: PART, quality: 'coarse' });
    expect(states(ok), describeFailures(ok)).toEqual(Array(5).fill('ok'));
    const zero = await api.regenerate({
      doc: withParams(doc, { nd: '0 mm' }),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(zero), describeFailures(zero)).toEqual(['ok', 'ok', 'ok', 'error', 'blocked']);
    relClose(totalVolume(zero.bodies), 40000, 1e-9);
    expect(zero.ghosts?.map((g) => g.id)).toEqual([`B${E1}`]);
  });

  it('an internal slot that grows until it cuts the top face in two, and back', async () => {
    const top = topOf(80, 50);
    // Slot x 55 … 65 centred on y = 25, `sh` long: internal at 20, through both edges at 60.
    const s = new Sk();
    s.point('o', 0, 0, true);
    s.geo({ kind: 'fix', entity: 'o' });
    const r = s.rect('n', 'K', 55, 15, 65, 35);
    s.dim({ kind: 'hDistance', a: 'o', b: r.a }, '55');
    s.dim({ kind: 'vDistance', a: 'o', b: r.a }, '25 mm - sh/2');
    s.dim({ kind: 'hDistance', a: r.a, b: r.b }, '10');
    s.dim({ kind: 'vDistance', a: r.b, b: r.c }, 'sh');
    const left = edge(leftTop(`F${E1}:end`), { centroid: [0, 25, 10], length: 50 });
    const doc = makeDoc(
      { sh: '20 mm' },
      [
        ...plate(80, 50),
        s.feature(NA, top, 'Slot'),
        extrude(CA, [region(NA, 'K1,K2,K3,K4')], '3', 'cut', 'reverse'),
        fillet(FI, [left], '1'),
        ...hole(top, 20, 25),
      ],
      PART,
    );
    const run = (sh: string) =>
      api.regenerate({
        doc: withParams(doc, { sh }),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
    const internal = await run('20 mm');
    expect(states(internal), describeFailures(internal)).toEqual(Array(7).fill('ok'));
    expect(internal.features.every((f) => f.rebound === undefined)).toBe(true);
    expect(facesStartingWith(internal.bodies[0] as BodyResult, `F${E1}:end`)).toEqual([
      `F${E1}:end`,
    ]);
    relClose(totalVolume(internal.bodies), 40000 - 600 - K * 50 - PI * 18, 1e-9);

    const through = await run('60 mm');
    expect(states(through), describeFailures(through)).toEqual(Array(7).fill('ok'));
    const body = through.bodies[0] as BodyResult;
    expect(facesStartingWith(body, `F${E1}:end`).sort()).toEqual([`F${E1}:end#0`, `F${E1}:end#1`]);
    // The left top edge now borders only the left piece: followed by strict fingerprint.
    expect(through.features[4]?.rebound).toEqual([
      {
        path: '/edges/0',
        name: leftTop(`F${E1}:end#0`),
        fingerprint: { centroid: [0, 25, 10], length: 50 },
      },
    ]);
    const c = (await filletCentroid(api, body)) as Vec3;
    expect(c[0]).toBeLessThan(1);
    expect(c[1]).toBeCloseTo(25, 6);
    // The hole's sketch plane: both pieces are the same plane; healed to the nearest piece.
    expect(through.features[5]?.rebound?.[0]?.name).toBe(`F${E1}:end#0`);
    expect(through.sketches.find((x) => x.featureId === SH)?.frame.origin).toEqual([0, 0, 10]);
    relClose(totalVolume(through.bodies), 40000 - 1500 - K * 50 - PI * 18, 1e-9);

    const back = await run('20 mm');
    expect(states(back)).toEqual(Array(7).fill('ok'));
    expect(back.features.every((f) => f.rebound === undefined)).toBe(true);
    relClose(totalVolume(back.bodies), 40000 - 600 - K * 50 - PI * 18, 1e-9);
  });

  it('adversarial: the referenced middle piece vanishes and "#1" moves to another piece → needs attention', async () => {
    // A tall plate (big diagonal, so the name-family radius alone would not catch this).
    const top = topOf(80, 200);
    // Pieces x 0…20, 30…50, 60…80; the fillet is on the middle piece's front edge.
    const middleFront = edge(frontTop(`F${E1}:end#1`), { centroid: [40, 0, 10], length: 20 });
    const doc = makeDoc(
      { wa: '10 mm' },
      [
        ...plate(80, 200),
        ...notch(NA, CA, top, 200, '20 mm', 'wa', '3'),
        ...notch(NB, CB, top, 200, '50 mm', '10 mm', '3'),
        fillet(FI, [middleFront], '1'),
      ],
      PART,
    );
    const run = (wa: string) =>
      api.regenerate({
        doc: withParams(doc, { wa }),
        partId: PART,
        quality: 'coarse',
        massProperties: true,
      });
    const three = await run('10 mm');
    expect(states(three), describeFailures(three)).toEqual(Array(7).fill('ok'));
    const c = (await filletCentroid(api, three.bodies[0] as BodyResult)) as Vec3;
    expect(c[0]).toBeCloseTo(40, 6);
    relClose(totalVolume(three.bodies), 160000 - 2 * 6000 - K * 20, 1e-9);

    // Notch A widens to meet notch B: the middle piece is gone; "end#1" is now the right piece.
    const two = await run('30 mm');
    expect(states(two), describeFailures(two)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'needsAttention',
    ]);
    const body = two.bodies[0] as BodyResult;
    expect(facesStartingWith(body, `F${E1}:end`).sort()).toEqual([`F${E1}:end#0`, `F${E1}:end#1`]);
    const u = two.features[6]?.unresolved?.[0];
    expect(u?.ref).toEqual(middleFront);
    expect(u?.candidates?.sort()).toEqual([frontTop(`F${E1}:end#0`), frontTop(`F${E1}:end#1`)]);
    relClose(totalVolume(two.bodies), 160000 - 4 * 6000, 1e-9);

    const again = await run('10 mm');
    expect(states(again)).toEqual(Array(7).fill('ok'));
  });
});
