/**
 * Error causes (M3.5, `AttentionCause`, cause.ts) on the real kernel: each needs-attention ref,
 * error and blocked feature names the upstream feature whose change broke it — one test per
 * rule — and nothing when the engine cannot tell.
 *
 * The model: a plate (extrude E1, thickness `t`), a 20 × 10 pocket sketched on its top face (S2)
 * and cut `pd` deep (E2), a convert-entities sketch linked to a pocket-floor edge (SL), a fillet
 * on that edge (FI) and a fillet on a plate edge (FP).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AttentionCause,
  EntityRef,
  Feature,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RegenOutput } from '../../src/regen/engine';
import {
  type Api,
  built,
  chamfer,
  describeFailures,
  edgeName,
  extrude,
  fid,
  fillet,
  loadApi,
  makeDoc as makeDocFor,
  region,
  Sk,
  side,
  skipNote,
  states,
  withParams,
} from './helpers';

const PART = fid('CPART');
const S1 = fid('CS1');
const E1 = fid('CE1');
const S2 = fid('CS2');
const E2 = fid('CE2');
const FI = fid('CFI');
const FP = fid('CFP');
const SL = fid('CSL');
const CH = fid('CCH');

const top = `F${E1}:end`;
const face = (name: string): EntityRef => ({ name, kind: 'face' });
const edge = (name: string): EntityRef => ({ name, kind: 'edge' });
/** The pocket floor's front edge. */
const floorFront = edge(edgeName(`F${E2}:end`, side(E2, S2, 'M1')));
/** The plate's top front edge. */
const plateFront = edge(edgeName(top, side(E1, S1, 'L1')));

function plate(): Feature[] {
  const s = new Sk();
  const r = s.rect('p', 'L', 0, 0, 80, 50, '80 mm', '50 mm');
  s.geo({ kind: 'fix', entity: r.a });
  return [s.feature(S1), extrude(E1, [region(S1, 'L1,L2,L3,L4')], 't')];
}

function pocket(): Feature[] {
  const s = new Sk();
  const r = s.rect('q', 'M', 30, 20, 50, 30, '20 mm', '10 mm');
  s.dim({ kind: 'hDistance', a: '@origin', b: r.a }, 'px');
  s.dim({ kind: 'vDistance', a: '@origin', b: r.a }, '20 mm');
  return [
    s.feature(S2, face(top), 'Pocket'),
    extrude(E2, [region(S2, 'M1,M2,M3,M4')], 'pd', 'cut', 'reverse'),
  ];
}

/** A sketch on XY with a line linked to `source`. */
function linked(source: EntityRef): SketchFeature {
  const s = new Sk();
  s.point('a', 3, 7);
  s.point('b', 40, 9);
  s.line('l', 'a', 'b');
  const f = s.feature(SL, 'origin:XY', 'Converted');
  f.entities = f.entities.map((e) => (e.id === 'l' ? { ...e, source: { ref: source } } : e));
  return f;
}

const PARAMS = { t: '10 mm', pd: '6 mm', px: '30 mm' };
const makeDoc = (features: Feature[], params: Record<string, string> = PARAMS) =>
  makeDocFor(params, features, PART);

/** [S1, E1, S2, E2, SL (linked to the floor edge), FI (fillet on it), FP (plate edge)] */
function model(): Feature[] {
  return [
    ...plate(),
    ...pocket(),
    linked(floorFront),
    fillet(FI, [floorFront], '1'),
    fillet(FP, [plateFront], '1'),
  ];
}

const statusOf = (r: RegenOutput, id: string) => r.features.find((f) => f.featureId === id);
const refCause = (r: RegenOutput, id: string): AttentionCause | undefined =>
  statusOf(r, id)?.unresolved?.[0]?.cause;

let api: Api;
beforeAll(async () => {
  if (built) api = await loadApi();
}, 60_000);
const regen = (doc: WrenDoc) => api.regenerate({ doc, partId: PART, quality: 'coarse' });

describe.skipIf(!built)(`regen: error causes (AttentionCause)${skipNote}`, () => {
  afterEach(async () => {
    await api.closePart(PART);
  });

  async function baseline(features = model()): Promise<WrenDoc> {
    const doc = makeDoc(features);
    const r = await regen(doc);
    expect(states(r), describeFailures(r)).toEqual(Array(features.length).fill('ok'));
    expect(r.features.every((f) => f.cause === undefined)).toBe(true);
    return doc;
  }

  it('changed (chain): shortening the plate removes the pocket floor → the extrude and its depth', async () => {
    const doc = await baseline();
    // 4 mm thick: the 6 mm pocket goes through, its floor and the floor edges are gone. The
    // pocket's own definition did not change; its input (the plate) did.
    const r = await regen(withParams(doc, { t: '4 mm' }));
    expect(states(r), describeFailures(r)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'needsAttention',
      'needsAttention',
      'blocked',
    ]);
    const expected: AttentionCause = {
      featureId: E1,
      kind: 'changed',
      detail: 'depth 10 mm → 4 mm',
    };
    expect(refCause(r, FI)).toEqual(expected);
    expect(statusOf(r, FI)?.cause).toEqual(expected);
    // The convert-entities sketch linked to the vanished edge: the same cause.
    expect(statusOf(r, SL)?.unresolved).toEqual([
      expect.objectContaining({
        path: '/entities/2/source/ref',
        reason: 'missing',
        cause: expected,
      }),
    ]);
    expect(statusOf(r, SL)?.cause).toEqual(expected);
    // The plate fillet waits on the fillet that needs attention on the same body.
    expect(statusOf(r, FP)?.cause).toEqual({ featureId: FI, kind: 'failed' });
  }, 60_000);

  it('changed (producer): deepening the pocket itself until it goes through → the pocket', async () => {
    const doc = await baseline();
    const r = await regen(withParams(doc, { pd: '12 mm' }));
    expect(statusOf(r, FI)?.state).toBe('needsAttention');
    expect(statusOf(r, FI)?.cause).toEqual({
      featureId: E2,
      kind: 'changed',
      detail: 'depth 6 mm → 12 mm',
    });
  }, 60_000);

  it('the cause stays while the ref stays broken, and goes when it resolves again', async () => {
    const doc = await baseline();
    const broken = withParams(doc, { t: '4 mm' });
    await regen(broken);
    const again = await regen(broken);
    expect(statusOf(again, FI)?.cause).toMatchObject({ featureId: E1, kind: 'changed' });
    // An unrelated edit (the plate fillet's radius) keeps it.
    const other = structuredClone(broken);
    const fp = other.parts[0]?.features.find((f) => f.id === FP) as Extract<
      Feature,
      { type: 'fillet' }
    >;
    fp.radius = '2';
    const unrelated = await regen(other);
    expect(statusOf(unrelated, FI)?.cause).toMatchObject({ featureId: E1, kind: 'changed' });
    const fixed = await regen(doc);
    expect(states(fixed)).toEqual(Array(7).fill('ok'));
    expect(fixed.features.every((f) => f.cause === undefined)).toBe(true);
  }, 60_000);

  it('changed (added): a chamfer inserted on the same edge before the fillet', async () => {
    const doc = await baseline();
    const next = structuredClone(doc);
    const p = next.parts[0] as WrenDoc['parts'][number];
    p.features.splice(5, 0, chamfer(CH, [floorFront], '0.5')); // …, SL, CH, FI, FP
    p.rollbackIndex = p.features.length;
    const r = await regen(next);
    expect(statusOf(r, CH)?.state, describeFailures(r)).toBe('ok');
    expect(statusOf(r, FI)?.state).toBe('needsAttention');
    expect(statusOf(r, FI)?.cause).toEqual({ featureId: CH, kind: 'changed', detail: 'added' });
  }, 60_000);

  it('suppressed: the pocket that made the edge is suppressed', async () => {
    const doc = await baseline();
    const next = structuredClone(doc);
    (next.parts[0]?.features[3] as Feature).suppressed = true;
    const r = await regen(next);
    expect(states(r)).toEqual([
      'ok',
      'ok',
      'ok',
      'suppressed',
      'needsAttention',
      'needsAttention',
      'blocked',
    ]);
    expect(statusOf(r, FI)?.cause).toEqual({ featureId: E2, kind: 'suppressed' });
    expect(statusOf(r, SL)?.cause).toEqual({ featureId: E2, kind: 'suppressed' });
  }, 60_000);

  it('deleted: the pocket that made the edge is gone', async () => {
    const doc = await baseline();
    const next = structuredClone(doc);
    const p = next.parts[0] as WrenDoc['parts'][number];
    p.features = p.features.filter((f) => f.id !== E2);
    p.rollbackIndex = p.features.length;
    const r = await regen(next);
    expect(statusOf(r, FI)?.state).toBe('needsAttention');
    expect(statusOf(r, FI)?.cause).toEqual({ featureId: E2, kind: 'deleted' });
  }, 60_000);

  it('reordered: the fillet moved above the pocket', async () => {
    const doc = await baseline();
    const next = structuredClone(doc);
    const p = next.parts[0] as WrenDoc['parts'][number];
    const fi = p.features.splice(5, 1)[0] as Feature;
    p.features.splice(2, 0, fi); // S1, E1, FI, S2, E2, SL, FP
    const r = await regen(next);
    expect(statusOf(r, FI)?.state).toBe('needsAttention');
    expect(statusOf(r, FI)?.cause).toEqual({ featureId: E2, kind: 'reordered' });
  }, 60_000);

  it('failed / blocked: a pocket whose depth no longer evaluates blocks what waits on it', async () => {
    const doc = await baseline();
    const next = structuredClone(doc);
    const e2 = next.parts[0]?.features[3] as Extract<Feature, { type: 'extrude' }>;
    e2.end = { kind: 'blind', depth: 'pd_missing' };
    const r = await regen(next);
    expect(states(r)).toEqual(['ok', 'ok', 'ok', 'error', 'blocked', 'blocked', 'blocked']);
    // The pocket's own edit broke it: no upstream cause.
    expect(statusOf(r, E2)?.cause).toBeUndefined();
    // By reference (the floor edge's name) and by body (the plate fillet acts on the same body).
    for (const id of [FI, SL, FP]) {
      expect(statusOf(r, id)?.cause, id).toEqual({ featureId: E2, kind: 'failed' });
    }
  }, 60_000);

  it('error: a fillet too big for the shortened plate names the extrude', async () => {
    const features = [...plate(), fillet(FP, [plateFront], '6')];
    const doc = await baseline(features);
    const r = await regen(withParams(doc, { t: '4 mm' }));
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'error']);
    expect(statusOf(r, FP)?.cause).toEqual({
      featureId: E1,
      kind: 'changed',
      detail: 'depth 10 mm → 4 mm',
    });
    // Still failing on the next regen: the cause is carried.
    const again = await regen(withParams(doc, { t: '4 mm' }));
    expect(statusOf(again, FP)?.cause).toMatchObject({ featureId: E1, kind: 'changed' });
  }, 60_000);

  it('never guesses: two upstream changes at the same distance, or no history → no cause', async () => {
    const doc = await baseline();
    // Plate thinner and pocket moved in one regen: both could have removed the floor edge.
    const both = await regen(withParams(doc, { t: '4 mm', px: '35 mm' }));
    expect(statusOf(both, FI)?.state).toBe('needsAttention');
    expect(statusOf(both, FI)?.cause).toBeUndefined();
    expect(statusOf(both, FI)?.unresolved?.[0]?.cause).toBeUndefined();
    // A fresh worker opening the broken document has no previous regen to compare with.
    await api.closePart(PART);
    const fresh = await regen(withParams(doc, { t: '4 mm' }));
    expect(statusOf(fresh, FI)?.state).toBe('needsAttention');
    expect(statusOf(fresh, FI)?.cause).toBeUndefined();
  }, 60_000);
});
