/**
 * Unit tests (no kernel) for name-family disambiguation with containment (ADR-078 review): with a
 * distance query (the regen engine always has one), the pick must contain the ref's recorded
 * location; without one (plane-like and unit callers) the nearest-centroid rule stands.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, ShapeFingerprints, Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { type Candidate, resolveRef } from '../../src/regen/resolve';

describe('name family with containment', () => {
  // Two straight edges along x: #0 covers [0, 4], #1 covers [6, 40]. A stored ref to an old piece
  // [6, 10] (centroid 8) is nearer #0's centroid (2) than #1's (23), but only #1 contains it.
  const fp: ShapeFingerprints = {
    faces: [],
    edges: [
      { centroid: [2, 0, 0], length: 4, curve: 'line' },
      { centroid: [23, 0, 0], length: 34, curve: 'line' },
    ],
    vertices: [],
  };
  const spans: [number, number][] = [
    [0, 4],
    [6, 40],
  ];
  const fam: Candidate[] = ['E#0', 'E#1'].map((name, index) => ({
    shape: 1,
    kind: 'edge',
    index,
    name,
    owner: 'B',
  }));
  const ctx = {
    diag: 50,
    fingerprints: async () => fp,
    distance: async (c: Candidate, p: Vec3) => {
      const [a, b] = spans[c.index] as [number, number];
      const x = Math.min(Math.max(p[0], a), b);
      return Math.hypot(p[0] - x, p[1], p[2]);
    },
  };
  const ref = (x: number): EntityRef => ({
    name: 'E#3',
    kind: 'edge',
    fingerprint: { centroid: [x, 0, 0], length: 4 },
  });

  it('picks the member that contains the recorded location, not the nearest centroid', async () => {
    const r = await resolveRef(ref(8), fam, ctx);
    expect(r.ok && r.target.name).toBe('E#1');
    // Without distances the old rule picks the nearer #0.
    const old = await resolveRef(ref(8), fam, { diag: 50, fingerprints: async () => fp });
    expect(old.ok && old.target.name).toBe('E#0');
  });

  it('no member contains it (the piece was cut away): ambiguous, needs attention', async () => {
    const r = await resolveRef(ref(5), fam, ctx);
    expect(r).toEqual({ ok: false, reason: 'ambiguous', candidates: ['E#0', 'E#1'] });
  });

  it('the nearest member that contains it stands', async () => {
    const r = await resolveRef(ref(2), fam, ctx);
    expect(r.ok && r.target.name).toBe('E#0');
  });
});
