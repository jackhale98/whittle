/**
 * Regen goldens 4–6: suppress / rollback / reorder, multi-body scopes, and how expression errors
 * and sketch conflicts surface (with last-good geometry kept for display).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BodyResult, Feature, WhittleDoc } from '@whittle/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  describeFailures,
  edge,
  edgeName,
  extrude,
  fid,
  fillet,
  loadApi,
  makeDoc,
  part,
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
const PI = Math.PI;

/** Fixed (fully constrained) rectangle sketch. */
function rectSketch(id: string, x0: number, y0: number, x1: number, y1: number, on = 'origin:XY') {
  const s = new Sk();
  s.rect('p', 'L', x0, y0, x1, y1);
  for (const p of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: p });
  return s.feature(id, on);
}

function circleSketch(id: string, cx: number, cy: number, r: number) {
  const s = new Sk();
  s.circle('C', cx, cy, r);
  s.geo({ kind: 'fix', entity: 'Cc' });
  s.dim({ kind: 'radius', curve: 'C' }, String(r));
  return s.feature(id);
}

const S1 = fid('FS1');
const E1 = fid('FE1');
const S2 = fid('FS2');
const CUT = fid('FCT');
const FI = fid('FFI');

/** 40×30×10 block, a Ø10 through hole, fillet r=2 on one vertical edge. */
function block(): Feature[] {
  return [
    rectSketch(S1, 0, 0, 40, 30),
    extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10'),
    circleSketch(S2, 20, 15, 5),
    extrude(CUT, [region(S2, 'C')], 'throughAll', 'cut'),
    fillet(FI, [edge(edgeName(side(E1, S1, 'L1'), side(E1, S1, 'L2')))], '2'),
  ];
}
const BLOCK = 40 * 30 * 10;
const HOLE = PI * 25 * 10;
const FILLET = (1 - PI / 4) * 4 * 10;

describe.skipIf(!built)(`regen golden: tree operations, multi-body, errors${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterEach(async () => {
    await api.closePart(PART);
  });

  const regen = (doc: WhittleDoc) =>
    api.regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });

  describe('suppress, rollback, reorder', () => {
    it('suppressing the cut restores the uncut volume; downstream still evaluates', async () => {
      const doc = makeDoc({}, block());
      const full = await regen(doc);
      expect(states(full), describeFailures(full)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      relClose(totalVolume(full.bodies), BLOCK - HOLE - FILLET, 1e-9);

      const sup = structuredClone(doc);
      (part(sup).features[3] as Feature).suppressed = true;
      const r = await regen(sup);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'suppressed', 'ok']);
      relClose(totalVolume(r.bodies), BLOCK - FILLET, 1e-9);
      // The fillet's input changed (no hole), the sketches/plate came from the cache.
      expect(r.features.map((f) => f.cached)).toEqual([true, true, true, false, false]);
    });

    it('rollback bar: later features are rolledBack and not evaluated', async () => {
      const doc = makeDoc({}, block());
      part(doc).rollbackIndex = 3;
      const r = await regen(doc);
      expect(states(r)).toEqual(['ok', 'ok', 'ok', 'rolledBack', 'rolledBack']);
      relClose(totalVolume(r.bodies), BLOCK, 1e-9);
      expect(r.sketches.map((s) => s.featureId)).toEqual([S1, S2]);
      part(doc).rollbackIndex = 0;
      const none = await regen(doc);
      expect(states(none)).toEqual(Array(5).fill('rolledBack'));
      expect(none.bodies).toEqual([]);
    });

    it('reorder: fillet before the cut gives the same part', async () => {
      const f = block();
      const doc = makeDoc({}, [f[0], f[1], f[4], f[2], f[3]] as Feature[]);
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      relClose(totalVolume(r.bodies), BLOCK - HOLE - FILLET, 1e-9);
      // Moving a feature above the one it depends on blocks it instead of guessing.
      const bad = makeDoc({}, [f[2], f[3], f[0], f[1], f[4]] as Feature[]);
      const rb = await regen(bad);
      expect(states(rb), describeFailures(rb)).toEqual(['ok', 'error', 'ok', 'ok', 'ok']);
      expect(rb.features[1]?.error?.message).toMatch(/no body to cut/);
    });

    it('revision is monotonic per part', async () => {
      const doc = makeDoc({}, block().slice(0, 2));
      const a = await regen(doc);
      const b = await regen(doc);
      expect(b.revision).toBe(a.revision + 1);
      expect(b.features.every((x) => x.cached)).toBe(true);
      expect(b.cache).toEqual({ hits: 2, misses: 0 });
    });
  });

  describe('multi-body', () => {
    const A = fid('MA');
    const AS = fid('MAS');
    const BB = fid('MB');
    const BS = fid('MBS');
    const CS = fid('MCS');
    const C = fid('MC');
    const bodies = (): Feature[] => [
      rectSketch(AS, 0, 0, 10, 10),
      extrude(A, [region(AS, 'L1,L2,L3,L4')], '10'),
      rectSketch(BS, 30, 0, 40, 10),
      extrude(BB, [region(BS, 'L1,L2,L3,L4')], '10'),
    ];

    it('two new bodies; a default-scope cut hits only the body it touches', async () => {
      const base = await regen(makeDoc({}, bodies()));
      expect(base.bodies.map((b) => b.id)).toEqual([`B${A}`, `B${BB}`]);
      const shapeA = base.bodies[0]?.shape;
      const r = await regen(
        makeDoc({}, [
          ...bodies(),
          circleSketch(CS, 35, 5, 2),
          extrude(C, [region(CS, 'C')], '10', 'cut'),
        ]),
      );
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
      const [a, b] = r.bodies as [BodyResult, BodyResult];
      expect(a.id).toBe(`B${A}`);
      expect(a.shape).toBe(shapeA); // untouched body keeps its shape (and cache)
      relClose(a.massProperties?.volume ?? 0, 1000, 1e-9);
      relClose(b.massProperties?.volume ?? 0, 1000 - PI * 4 * 10, 1e-9);
    });

    it('explicit scope limits a cut that overlaps both bodies', async () => {
      const wide = rectSketch(CS, -5, 4, 45, 6);
      const cut = extrude(C, [region(CS, 'L1,L2,L3,L4')], '10', 'cut', 'normal', {
        scope: { kind: 'bodies', bodies: [{ name: `B${A}`, kind: 'body' }] },
      });
      const r = await regen(makeDoc({}, [...bodies(), wide, cut]));
      expect(states(r), describeFailures(r)).toEqual(Array(6).fill('ok'));
      relClose(r.bodies[0]?.massProperties?.volume ?? 0, 1000 - 10 * 2 * 10, 1e-9);
      relClose(r.bodies[1]?.massProperties?.volume ?? 0, 1000, 1e-9);
      // Default scope: both are cut.
      const all = await regen(makeDoc({}, [...bodies(), wide, { ...cut, scope: undefined }]));
      relClose(totalVolume(all.bodies), 2 * (1000 - 200), 1e-9);
      // A scope naming a missing body needs attention.
      const missing = await regen(
        makeDoc({}, [
          ...bodies(),
          wide,
          {
            ...cut,
            scope: {
              kind: 'bodies',
              bodies: [{ name: 'B01JNOPE00000000000000000', kind: 'body' }],
            },
          },
        ]),
      );
      expect(states(missing)[5]).toBe('needsAttention');
      expect(missing.features[5]?.unresolved?.[0]?.path).toBe('/scope/bodies/0');
    });

    it('add with default scope merges the touched body and keeps the other', async () => {
      const bridge = rectSketch(CS, 5, 0, 12, 10);
      const r = await regen(
        makeDoc({}, [...bodies(), bridge, extrude(C, [region(CS, 'L1,L2,L3,L4')], '10', 'add')]),
      );
      expect(states(r), describeFailures(r)).toEqual(Array(6).fill('ok'));
      expect(r.bodies.map((b) => b.id)).toEqual([`B${A}`, `B${BB}`]);
      relClose(r.bodies[0]?.massProperties?.volume ?? 0, 1200, 1e-9);
      // Material touching nothing becomes a new body (with a warning).
      const far = rectSketch(CS, 100, 0, 110, 10);
      const lone = await regen(
        makeDoc({}, [...bodies(), far, extrude(C, [region(CS, 'L1,L2,L3,L4')], '10', 'add')]),
      );
      expect(lone.bodies.map((b) => b.id)).toEqual([`B${A}`, `B${BB}`, `B${C}`]);
      expect(lone.features[5]?.warnings?.[0]?.message).toMatch(/touches no body/);
    });

    it('boolean feature: target and tools, tools consumed', async () => {
      const BO = fid('MBO');
      const overlap = rectSketch(CS, 5, 0, 35, 10);
      const r = await regen(
        makeDoc({}, [
          ...bodies(),
          overlap,
          extrude(C, [region(CS, 'L1,L2,L3,L4')], '5', 'new'),
          {
            id: BO,
            type: 'boolean',
            name: 'Union',
            suppressed: false,
            op: 'add',
            target: { name: `B${A}`, kind: 'body' },
            tools: [
              { name: `B${C}`, kind: 'body' },
              { name: `B${BB}`, kind: 'body' },
            ],
            keepTools: false,
          },
        ]),
      );
      expect(states(r), describeFailures(r)).toEqual(Array(7).fill('ok'));
      expect(r.bodies.map((b) => b.id)).toEqual([`B${A}`]);
      relClose(totalVolume(r.bodies), 2000 + 20 * 10 * 5, 1e-9);
    });
  });

  describe('revolve, construction planes, up-to, multi-body fillet', () => {
    it('revolve about origin:Z of a sketch on origin:XZ', async () => {
      const SK = fid('RS');
      const RV = fid('RV');
      const s = new Sk();
      s.rect('p', 'L', 10, 0, 20, 5);
      for (const p of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: p });
      const doc = makeDoc({ sweep: '90 deg' }, [
        s.feature(SK, 'origin:XZ'),
        {
          id: RV,
          type: 'revolve',
          name: 'Revolve',
          suppressed: false,
          profile: [region(SK, 'L1,L2,L3,L4')],
          axis: { name: 'origin:Z', kind: 'edge' },
          angle: 'sweep * 4',
          direction: 'normal',
          op: 'new',
        },
      ]);
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
      relClose(totalVolume(r.bodies), PI * (400 - 100) * 5, 1e-9);
      // XZ sketch: u → world X, v → world Z.
      expect(r.sketches[0]?.frame).toEqual({
        origin: [0, 0, 0],
        x: [1, 0, 0],
        y: [0, 0, 1],
        z: [0, -1, 0],
      });
    });

    it('offset plane from a param, a sketch on it, and an extrude up to it', async () => {
      const PL = fid('PL');
      const SK = fid('PS');
      const EX = fid('PE');
      const UP = fid('PU');
      const s = new Sk();
      s.rect('p', 'L', 0, 0, 10, 10);
      for (const p of ['pa', 'pb', 'pc', 'pd']) s.geo({ kind: 'fix', entity: p });
      const base = new Sk();
      base.rect('p', 'L', 20, 0, 30, 10);
      for (const p of ['pa', 'pb', 'pc', 'pd']) base.geo({ kind: 'fix', entity: p });
      const BS = fid('PBS');
      const doc = makeDoc({ h: '12 mm' }, [
        {
          id: PL,
          type: 'plane',
          name: 'Plane',
          suppressed: false,
          definition: { kind: 'offset', from: { name: 'origin:XY', kind: 'face' }, distance: 'h' },
        },
        s.feature(SK, { name: `F${PL}:plane`, kind: 'face' }),
        extrude(EX, [region(SK, 'L1,L2,L3,L4')], '3'),
        base.feature(BS),
        extrude(UP, [region(BS, 'L1,L2,L3,L4')], 'throughAll', 'new', 'normal', {
          end: { kind: 'upTo', target: { name: `F${PL}:plane`, kind: 'face' } },
        }),
      ]);
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      expect(r.sketches.find((x) => x.featureId === SK)?.frame.origin).toEqual([0, 0, 12]);
      expect(r.bodies[0]?.mesh.bbox.min[2]).toBeCloseTo(12, 9);
      relClose(r.bodies[1]?.massProperties?.volume ?? 0, 100 * 12, 1e-9);
      // Editing the plane offset moves both.
      const moved = await regen(withParams(doc, { h: '20 mm' }));
      expect(moved.bodies[0]?.mesh.bbox.min[2]).toBeCloseTo(20, 9);
      relClose(moved.bodies[1]?.massProperties?.volume ?? 0, 100 * 20, 1e-9);
      expect(moved.features.map((f) => f.cached)).toEqual([false, false, false, true, false]);
    });

    it('one fillet feature over edges of two bodies runs once per body', async () => {
      const A = fid('GA');
      const AS = fid('GAS');
      const BB = fid('GB');
      const BS = fid('GBS');
      const FF = fid('GF');
      const doc = makeDoc({}, [
        rectSketch(AS, 0, 0, 10, 10),
        extrude(A, [region(AS, 'L1,L2,L3,L4')], '10'),
        rectSketch(BS, 30, 0, 40, 10),
        extrude(BB, [region(BS, 'L1,L2,L3,L4')], '10'),
        fillet(
          FF,
          [
            edge(edgeName(side(A, AS, 'L1'), side(A, AS, 'L2'))),
            edge(edgeName(side(BB, BS, 'L3'), side(BB, BS, 'L4'))),
          ],
          '1',
        ),
      ]);
      const r = await regen(doc);
      expect(states(r), describeFailures(r)).toEqual(Array(5).fill('ok'));
      for (const b of r.bodies)
        relClose(b.massProperties?.volume ?? 0, 1000 - (1 - PI / 4) * 10, 1e-9);
    });
  });

  describe('errors keep last-good geometry', () => {
    it('an expression error names the field; downstream is blocked; ghosts show the last good part', async () => {
      const doc = makeDoc({ depth: '10 mm' }, block());
      (part(doc).features[1] as Extract<Feature, { type: 'extrude' }>).end = {
        kind: 'blind',
        depth: 'depth',
      };
      const good = await regen(doc);
      expect(states(good), describeFailures(good)).toEqual(Array(5).fill('ok'));

      const broken = structuredClone(doc);
      (part(broken).features[1] as Extract<Feature, { type: 'extrude' }>).end = {
        kind: 'blind',
        depth: 'detph * 2',
      };
      const r = await regen(broken);
      expect(states(r)).toEqual(['ok', 'error', 'ok', 'blocked', 'blocked']);
      const e = r.features[1]?.error;
      expect(e?.code).toBe('INVALID_INPUT');
      expect(e?.message).toMatch(/^Depth: /);
      expect(e?.message).toMatch(/detph/);
      expect(e?.message).toMatch(/depth/); // did-you-mean suggestion from the engine
      expect(r.bodies).toEqual([]);
      expect(r.ghosts?.map((g) => g.id)).toEqual([`B${E1}`]);
      relClose(
        r.ghosts?.[0]?.mesh ? (good.bodies[0]?.massProperties?.volume ?? 0) : 0,
        BLOCK - HOLE - FILLET,
        1e-9,
      );
      expect(r.ghosts?.[0]?.mesh.indices.length).toBeGreaterThan(0);
    });

    it('a kernel error (fillet too large) carries the hint; the unfilleted body is shown', async () => {
      const f = block();
      (f[4] as Extract<Feature, { type: 'fillet' }>).radius = '40';
      const r = await regen(makeDoc({}, f));
      expect(states(r)).toEqual(['ok', 'ok', 'ok', 'ok', 'error']);
      expect(r.features[4]?.error?.message).toBe('Fillet radius is too large for this edge');
      expect(r.features[4]?.error?.hint).toMatch(/^Try ≤/);
      relClose(totalVolume(r.bodies), BLOCK - HOLE, 1e-9);
    });

    it('a conflicting sketch is an error with the solver explanation; its extrude is blocked', async () => {
      const s = new Sk();
      s.rect('p', 'L', 0, 0, 40, 30, '40', '30');
      s.geo({ kind: 'fix', entity: 'pa' });
      s.dim({ kind: 'length', line: 'L1' }, '50'); // contradicts the 40 mm width
      const r = await regen(
        makeDoc({}, [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], '10')]),
      );
      expect(states(r)).toEqual(['error', 'blocked']);
      expect(r.features[0]?.error?.message).toMatch(/^The sketch is over-constrained: /);
      expect(r.features[0]?.error?.hint).toBeTruthy();
    });

    it('a sketch dimension expression error points at the constraint', async () => {
      const s = new Sk();
      s.rect('p', 'L', 0, 0, 40, 30, 'nope', '30');
      s.geo({ kind: 'fix', entity: 'pa' });
      const r = await regen(makeDoc({}, [s.feature(S1)]));
      expect(states(r)).toEqual(['error']);
      expect(r.features[0]?.error?.message).toMatch(/^Sketch dimension .* \(hDistance\): /);
      expect(r.features[0]?.error?.detail).toMatch(/^\/constraints\/\d+\/value: /);
    });
  });
});
