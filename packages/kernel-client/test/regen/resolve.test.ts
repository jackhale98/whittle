/**
 * Unit tests (no kernel) for reference resolution (PLAN §7.3), plane frames and cache keys.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, ShapeFingerprints, Vec3 } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { planeFrame } from '../../src/regen/geometry';
import { hashKey, stableStringify } from '../../src/regen/hash';
import { baseName, type Candidate, resolveRef } from '../../src/regen/resolve';

type Face = { name: string; centroid: Vec3; normal?: Vec3; area: number };

/** One fake shape (handle 1) with the given faces. */
function world(faces: Face[]) {
  const fp: ShapeFingerprints = {
    faces: faces.map((f) =>
      f.normal
        ? { centroid: f.centroid, normal: f.normal, area: f.area, surface: 'plane' }
        : { centroid: f.centroid, area: f.area, surface: 'cylinder' },
    ),
    edges: [],
    vertices: [],
  };
  const cands: Candidate[] = faces.map((f, index) => ({
    shape: 1,
    kind: 'face',
    index,
    name: f.name,
    owner: 'B1',
  }));
  const ctx = (planeLike = false) => ({
    diag: 100,
    planeLike,
    fingerprints: async (s: number) => (s === 1 ? fp : null),
  });
  return { cands, ctx };
}

const up: Vec3 = [0, 0, 1];
const ref = (name: string, centroid?: Vec3, normal?: Vec3, area?: number): EntityRef => {
  const r: EntityRef = { name, kind: 'face' };
  if (centroid) {
    r.fingerprint = { centroid };
    if (normal) r.fingerprint.normal = normal;
    if (area !== undefined) r.fingerprint.area = area;
  }
  return r;
};

describe('resolveRef', () => {
  it('exact unique name wins without fingerprints', async () => {
    const { cands, ctx } = world([
      { name: 'F1:end', centroid: [0, 0, 10], normal: up, area: 1 },
      { name: 'F1:start', centroid: [0, 0, 0], normal: [0, 0, -1], area: 1 },
    ]);
    const r = await resolveRef(ref('F1:end'), cands, ctx());
    expect(r).toMatchObject({ ok: true, target: { index: 0, via: 'name' } });
  });

  it('split family: nearest piece by a clear margin, else ambiguous with candidates', async () => {
    const { cands, ctx } = world([
      { name: 'F1:end#0', centroid: [10, 0, 10], normal: up, area: 1 },
      { name: 'F1:end#1', centroid: [60, 0, 10], normal: up, area: 1 },
    ]);
    const near0 = await resolveRef(ref('F1:end', [15, 0, 10], up), cands, ctx());
    expect(near0).toMatchObject({
      ok: true,
      target: { name: 'F1:end#0', via: 'name+fingerprint' },
    });
    const middle = await resolveRef(ref('F1:end', [35, 0, 10], up), cands, ctx());
    expect(middle).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: ['F1:end#0', 'F1:end#1'],
    });
    const noFp = await resolveRef(ref('F1:end'), cands, ctx());
    expect(noFp).toMatchObject({ ok: false, reason: 'ambiguous' });
    // Too far from every piece (beyond 25 % of the part diagonal): ambiguous, not guessed.
    const far = await resolveRef(ref('F1:end', [10, 90, 10], up), cands, ctx());
    expect(far.ok).toBe(false);
  });

  it('planeLike: coplanar split pieces are one plane, even when equidistant', async () => {
    const { cands, ctx } = world([
      { name: 'F1:end#0', centroid: [10, 0, 10], normal: up, area: 1 },
      { name: 'F1:end#1', centroid: [60, 0, 10], normal: up, area: 1 },
    ]);
    const r = await resolveRef(ref('F1:end', [35, 0, 10], up), cands, ctx(true));
    expect(r.ok).toBe(true);
    // …but pieces at different heights are not coplanar.
    const stepped = world([
      { name: 'F1:end#0', centroid: [10, 0, 10], normal: up, area: 1 },
      { name: 'F1:end#1', centroid: [60, 0, 12], normal: up, area: 1 },
    ]);
    const s = await resolveRef(ref('F1:end', [35, 0, 10], up), stepped.cands, stepped.ctx(true));
    expect(s).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('merged pieces: X#k resolves to the single X; a lone other piece needs strict evidence', async () => {
    const merged = world([{ name: 'F1:end', centroid: [35, 0, 10], normal: up, area: 1 }]);
    expect(
      await resolveRef(ref('F1:end#1', [60, 0, 10], up), merged.cands, merged.ctx()),
    ).toMatchObject({
      ok: true,
      target: { name: 'F1:end' },
    });
    const lone = world([{ name: 'F1:end#0', centroid: [10, 0, 10], normal: up, area: 1 }]);
    expect(await resolveRef(ref('F1:end#1', [60, 0, 10], up), lone.cands, lone.ctx())).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('exact split name is overridden only by a clear fingerprint winner', async () => {
    // Pieces swapped order: the name says #0, the geometry clearly says the other piece.
    const { cands, ctx } = world([
      { name: 'F1:end#0', centroid: [10, 0, 10], normal: up, area: 1 },
      { name: 'F1:end#1', centroid: [60, 0, 10], normal: up, area: 1 },
    ]);
    const r = await resolveRef(ref('F1:end#0', [58, 0, 10], up), cands, ctx());
    expect(r).toMatchObject({ ok: true, target: { name: 'F1:end#1' } });
    const unclear = await resolveRef(ref('F1:end#0', [35, 0, 10], up), cands, ctx());
    expect(unclear).toMatchObject({ ok: true, target: { name: 'F1:end#0', via: 'name' } });
  });

  it('fingerprint-only: strict tolerance on centroid, normal and area; unique or nothing', async () => {
    const { cands, ctx } = world([
      { name: 'F9:side(a)', centroid: [0, 5, 5], normal: [-1, 0, 0], area: 50 },
      { name: 'F9:side(b)', centroid: [10, 5, 5], normal: [1, 0, 0], area: 50 },
      { name: 'F9:side(c)', centroid: [5, 5, 5], area: 31.4 },
    ]);
    const hit = await resolveRef(ref('F7:gone', [10, 5, 5.05], [1, 0, 0], 50), cands, ctx());
    expect(hit).toMatchObject({ ok: true, target: { name: 'F9:side(b)', via: 'fingerprint' } });
    // Moved by more than 0.1 % of the diagonal: missing.
    expect(await resolveRef(ref('F7:gone', [10, 5, 6], [1, 0, 0], 50), cands, ctx())).toEqual({
      ok: false,
      reason: 'missing',
    });
    // Same place, flipped normal or different area: missing.
    expect((await resolveRef(ref('F7:gone', [10, 5, 5], [-1, 0, 0], 50), cands, ctx())).ok).toBe(
      false,
    );
    expect((await resolveRef(ref('F7:gone', [10, 5, 5], [1, 0, 0], 60), cands, ctx())).ok).toBe(
      false,
    );
    // No fingerprint at all: missing.
    expect(await resolveRef(ref('F7:gone'), cands, ctx())).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('baseName strips every split suffix', () => {
    expect(baseName('edge(F1:end#0|F1:side(S1:e(L1)#1))#2')).toBe('edge(F1:end|F1:side(S1:e(L1)))');
  });
});

describe('planeFrame', () => {
  it('is deterministic: world origin projected, X from the normal', () => {
    expect(planeFrame([37, 12, 8], [0, 0, 1])).toEqual({
      origin: [0, 0, 8],
      z: [0, 0, 1],
      x: [1, 0, 0],
    });
    expect(planeFrame([5, 0, 3], [0, -1, 0])).toEqual({
      origin: [0, 0, 0],
      z: [0, -1, 0],
      x: [1, 0, 0],
    });
    expect(planeFrame([20, 7, 3], [1, 0, 0])).toEqual({
      origin: [20, 0, 0],
      z: [1, 0, 0],
      x: [0, 1, 0],
    });
    const down = planeFrame([1, 1, -4], [0, 0, -1]);
    expect(down.origin).toEqual([0, 0, -4]);
    expect(down.x).toEqual([1, 0, 0]);
    // Independent of where on the plane the centroid is.
    expect(planeFrame([1, 2, 8], [0, 0, 1])).toEqual(planeFrame([90, -40, 8], [0, 0, 1]));
  });
});

describe('cache keys', () => {
  it('canonical: key order and undefined members do not matter', () => {
    expect(stableStringify({ b: 1, a: [1, { d: undefined, c: -0 }] })).toBe(
      '{"a":[1,{"c":0}],"b":1}',
    );
    expect(hashKey({ a: 1, b: 2 })).toBe(hashKey({ b: 2, a: 1 }));
    expect(hashKey({ a: 1 })).not.toBe(hashKey({ a: 2 }));
    expect(hashKey('x')).toMatch(/^[0-9a-f]{28}$/);
  });
});
