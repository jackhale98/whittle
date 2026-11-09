/**
 * Regen golden (M3) on the current real kernel: the parts of M3 the engine does without new
 * façade calls — linked sketch entities (Convert Entities) that follow upstream edits and need
 * attention when their source is lost, and reference geometry (axes from cylinder faces, three-
 * point / mid / through-point planes, points) feeding sketches and revolves, checked by volume.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AxisFeature,
  EntityRef,
  Feature,
  PlaneFeature,
  PointFeature,
  PrimitiveFeature,
  RevolveFeature,
  SketchFeature,
  Vec3,
  WhittleDoc,
} from '@whittle/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import {
  type Api,
  built,
  describeFailures,
  edgeName,
  extrude,
  fid,
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

const PART = fid('RPART');
const S1 = fid('RS1');
const E1 = fid('RE1');
const S2 = fid('RS2');
const E2 = fid('RE2');
const SL = fid('RSL');
const top = `F${E1}:end`;
const front = side(E1, S1, 'L1');

const face = (name: string): EntityRef => ({ name, kind: 'face' });
const edge = (name: string): EntityRef => ({ name, kind: 'edge' });
const makeDoc = (params: Record<string, string>, features: Feature[]) =>
  makeDocFor(params, features, PART);

/** A w × 50 × 10 plate from the origin. */
function plate(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 80, 50, 'w', '50 mm');
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10')];
}

/** A 20 × 10 pocket, 4 deep, its corner at (px, 20) on the top face. */
function pocket(): Feature[] {
  const s = new Sk();
  const r = s.rect('q', 'M', 30, 20, 50, 30, '20 mm', '10 mm');
  s.dim({ kind: 'hDistance', a: '@origin', b: r.a }, 'px');
  s.dim({ kind: 'vDistance', a: '@origin', b: r.a }, '20 mm');
  return [
    s.feature(S2, face(top), 'Pocket'),
    extrude(E2, [region(S2, 'M1,M2,M3,M4')], '4', 'cut', 'reverse'),
  ];
}

/** A sketch on XY with one line linked to `source` (its stored geometry deliberately off). */
function linked(source: EntityRef, id = SL): SketchFeature {
  const s = new Sk();
  s.point('a', 3, 7);
  s.point('b', 40, 9);
  s.line('l', 'a', 'b');
  const f = s.feature(id, 'origin:XY', 'Converted');
  f.entities = f.entities.map((e) => (e.id === 'l' ? { ...e, source: { ref: source } } : e));
  return f;
}

function pointAt(r: RegenOutput, sketch: string, entity: string): Vec3 | undefined {
  return r.sketches.find((s) => s.featureId === sketch)?.points?.find((p) => p.entity === entity)
    ?.at;
}

const near = (a: Vec3 | undefined, b: Vec3, tol = 1e-6) => {
  expect(a, `expected ${JSON.stringify(b)}`).toBeDefined();
  for (let i = 0; i < 3; i++)
    expect(Math.abs(((a as Vec3)[i] as number) - (b[i] as number))).toBeLessThan(tol);
};

let api: Api;
beforeAll(async () => {
  if (built) api = await loadApi();
}, 60_000);
const regen = (doc: WhittleDoc) => api.regenerate({ doc, partId: PART, quality: 'coarse' });

describe.skipIf(!built)(`regen golden (M3, current kernel): convert entities${skipNote}`, () => {
  it('a linked line follows a model edge through upstream edits', async () => {
    const src = edge(edgeName(top, front));
    const doc = makeDoc({ w: '80 mm' }, [...plate(), linked(src)]);
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
    near(pointAt(r, SL, 'a'), [0, 0, 0]);
    near(pointAt(r, SL, 'b'), [80, 0, 0]);
    const wider = await regen(withParams(doc, { w: '100 mm' }));
    expect(states(wider)).toEqual(['ok', 'ok', 'ok']);
    near(pointAt(wider, SL, 'b'), [100, 0, 0]);
    expect(wider.features[2]?.rebound).toBeUndefined();
  }, 60_000);

  it('a lost convert-entities source makes the sketch need attention, never re-picked', async () => {
    // Linked to the pocket floor's front edge.
    const floorFront = edge(edgeName(`F${E2}:end`, side(E2, S2, 'M1')));
    const doc = makeDoc({ w: '80 mm', px: '30 mm' }, [...plate(), ...pocket(), linked(floorFront)]);
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    near(pointAt(r, SL, 'a'), [30, 20, 0]);
    near(pointAt(r, SL, 'b'), [50, 20, 0]);
    // The pocket moves: the linked line follows by name.
    const moved = await regen(withParams(doc, { px: '45 mm' }));
    expect(states(moved)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    near(pointAt(moved, SL, 'a'), [45, 20, 0]);
    // The pocket is suppressed: its edges are gone. Other edges of the plate are never picked.
    const gone = structuredClone(doc);
    const feats = gone.parts[0]?.features as Feature[];
    (feats[3] as Feature).suppressed = true;
    const lost = await regen(gone);
    expect(states(lost)).toEqual(['ok', 'ok', 'ok', 'suppressed', 'needsAttention']);
    const st = lost.features[4];
    expect(st?.unresolved).toEqual([
      expect.objectContaining({ path: '/entities/2/source/ref', reason: 'missing' }),
    ]);
    expect(st?.error?.entityRefs).toContain(`S${SL}:e(l)`);
    expect(lost.sketches.find((s) => s.featureId === SL)).toBeUndefined();
    // Back again: resolves by name as before.
    const back = await regen(doc);
    expect(states(back)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  }, 60_000);

  it('origin planes, axis and point features project into a sketch', async () => {
    const pt: PointFeature = {
      id: fid('RPT'),
      type: 'point',
      name: 'Point',
      suppressed: false,
      definition: { kind: 'coordinates', x: '12 mm', y: '-4 mm', z: '30 mm' },
    };
    const s = new Sk();
    s.point('p', 0, 0);
    s.point('a', 5, 5);
    s.point('b', 9, 30);
    s.line('l', 'a', 'b', true);
    const f = s.feature(SL, 'origin:XY');
    f.entities = f.entities.map((e) =>
      e.id === 'p'
        ? { ...e, source: { ref: { name: `F${pt.id}:point`, kind: 'vertex' } } }
        : e.id === 'l'
          ? { ...e, source: { ref: face('origin:YZ') } }
          : e,
    );
    const r = await regen(makeDoc({}, [pt, f]));
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    near(pointAt(r, SL, 'p'), [12, -4, 0]);
    // The YZ plane's trace is the Y axis; the line keeps its extent along it.
    near(pointAt(r, SL, 'a'), [0, 5, 0]);
    near(pointAt(r, SL, 'b'), [0, 30, 0]);
  }, 60_000);
});

describe.skipIf(!built)(`regen golden (M3, current kernel): reference geometry${skipNote}`, () => {
  it('an axis from a cylinder face is exact: a ring revolved about it has the analytic volume', async () => {
    const cyl: PrimitiveFeature = {
      id: fid('RCYL'),
      type: 'primitive',
      name: 'Cylinder',
      suppressed: false,
      op: 'new',
      shape: 'cylinder',
      radius: '5 mm',
      height: '20 mm',
      frame: { origin: [30, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
    };
    const ax: AxisFeature = {
      id: fid('RAX'),
      type: 'axis',
      name: 'Axis',
      suppressed: false,
      definition: { kind: 'cylinder', face: face(`F${cyl.id}:face.side`) },
    };
    const s = new Sk();
    s.rect('r', 'K', 40, 0, 45, 10);
    const sk = s.feature(fid('RSR'), 'origin:XZ');
    const rev: RevolveFeature = {
      id: fid('RREV'),
      type: 'revolve',
      name: 'Ring',
      suppressed: false,
      profile: [region(sk.id, 'K1,K2,K3,K4')],
      axis: edge(`F${ax.id}:axis`),
      angle: '360 deg',
      direction: 'normal',
      op: 'new',
    };
    const r = await api.regenerate({
      doc: makeDoc({}, [cyl, ax, sk, rev]),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const ring = r.bodies.find((b) => b.id === `B${rev.id}`);
    // Radii about x = 30: 10…15 mm, 10 mm tall.
    relClose(ring?.massProperties?.volume ?? 0, Math.PI * (15 ** 2 - 10 ** 2) * 10, 1e-6);
    relClose(totalVolume(r.bodies), Math.PI * 25 * 20 + Math.PI * 125 * 10, 1e-6);
  }, 60_000);

  it('three-point, mid and through-point planes carry sketches; flip reverses them', async () => {
    const box: PrimitiveFeature = {
      id: fid('RBOX'),
      type: 'primitive',
      name: 'Box',
      suppressed: false,
      op: 'new',
      shape: 'box',
      dx: '40 mm',
      dy: '30 mm',
      dz: '20 mm',
    };
    const v = (s: string) => ({ name: `F${box.id}:vertex(${s})`, kind: 'vertex' as const });
    const three: PlaneFeature = {
      id: fid('RPL3'),
      type: 'plane',
      name: 'Top',
      suppressed: false,
      definition: {
        kind: 'threePoints',
        points: [v('min,min,max'), v('max,min,max'), v('min,max,max')],
      },
    };
    const mid: PlaneFeature = {
      id: fid('RPLM'),
      type: 'plane',
      name: 'Mid',
      suppressed: false,
      definition: {
        kind: 'midplane',
        a: face(`F${box.id}:face.xmin`),
        b: face(`F${box.id}:face.xmax`),
      },
    };
    const s = new Sk();
    s.rect('r', 'T', 0, 0, 10, 10);
    const onTop = s.feature(fid('RST'), face(`F${three.id}:plane`));
    const boss = extrude(fid('RET'), [region(onTop.id, 'T1,T2,T3,T4')], '5');
    const m = new Sk();
    m.point('o', 0, 0);
    const onMid = m.feature(fid('RSM'), face(`F${mid.id}:plane`));
    const doc = makeDoc({}, [box, three, mid, onTop, boss, onMid]);
    const r = await api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const b = r.bodies.find((x) => x.id === `B${boss.id}`);
    relClose(b?.massProperties?.volume ?? 0, 500, 1e-9);
    expect(b?.massProperties?.bbox.min[2]).toBeCloseTo(20, 9);
    expect(b?.massProperties?.bbox.max[2]).toBeCloseTo(25, 9);
    const midFrame = r.sketches.find((x) => x.featureId === onMid.id)?.frame;
    near(midFrame?.origin, [20, 0, 0]);
    // Flipped: the boss grows downwards into the box.
    const flipped = structuredClone(doc);
    (flipped.parts[0]?.features[1] as PlaneFeature).flip = true;
    const f2 = await api.regenerate({
      doc: flipped,
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    const b2 = f2.bodies.find((x) => x.id === `B${boss.id}`);
    expect(b2?.massProperties?.bbox.min[2]).toBeCloseTo(15, 9);
    expect(b2?.massProperties?.bbox.max[2]).toBeCloseTo(20, 9);
  }, 60_000);
});
