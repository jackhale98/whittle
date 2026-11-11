/**
 * Merge aliases in body naming maps (ADR-078), without a kernel: primary entries, the walk's
 * absorbed → survivor table, and merge chains.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NamingMap, ShapeFingerprints, Vec3 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { resolveWithMerges } from '../../src/regen/refs';
import {
  ModelState,
  mergeChain,
  mergeLookup,
  primaryNaming,
  recordMerges,
} from '../../src/regen/state';

const naming: NamingMap = [
  { name: 'F1:back', kind: 'face', index: 0 },
  { name: 'F1:top', kind: 'face', index: 1 },
  { name: 'edge(F1:back|F1:top)', kind: 'edge', index: 0 },
  { name: 'F2:back', kind: 'face', index: 0 },
  { name: 'edge(F2:back|F2:top)', kind: 'edge', index: 0 },
];

describe('merge aliases', () => {
  it('the first entry per kind and index is the name; later ones are aliases', () => {
    expect(primaryNaming(naming).map((n) => n.name)).toEqual([
      'F1:back',
      'F1:top',
      'edge(F1:back|F1:top)',
    ]);
    const plain = naming.slice(0, 3);
    expect(primaryNaming(plain)).toBe(plain);
  });

  it('records absorbed → survivor per kind, and follows chains', () => {
    const state = new ModelState();
    recordMerges(state.merged, naming);
    expect(state.merged.get('face|F2:back')).toEqual(['F1:back']);
    expect(state.merged.get('edge|edge(F2:back|F2:top)')).toEqual(['edge(F1:back|F1:top)']);
    expect(state.merged.has('face|F1:back')).toBe(false);
    // A later feature merges the survivor into another face.
    recordMerges(state.merged, [
      { name: 'F0:back', kind: 'face', index: 0 },
      { name: 'F1:back', kind: 'face', index: 0 },
    ]);
    expect(mergeChain(state, 'face', 'F2:back')).toEqual(['F1:back', 'F0:back']);
    expect(mergeChain(state, 'face', 'F9:none')).toEqual([]);
    expect(mergeChain(state, 'edge', 'F2:back')).toEqual([]);
  });

  it('a name listed for two different survivors is a conflict, also further down a chain', () => {
    const state = new ModelState();
    // Two features each derive the same old vertex name for different vertices.
    recordMerges(state.merged, [
      { name: 'vertex(A|B|C)', kind: 'vertex', index: 3 },
      { name: 'vertex(X)', kind: 'vertex', index: 3 },
    ]);
    recordMerges(state.merged, [
      { name: 'vertex(A|B|D)', kind: 'vertex', index: 7 },
      { name: 'vertex(X)', kind: 'vertex', index: 7 },
    ]);
    expect(mergeLookup(state, 'vertex', 'vertex(X)')).toEqual({
      chain: [],
      conflict: ['vertex(A|B|C)', 'vertex(A|B|D)'],
    });
    expect(mergeChain(state, 'vertex', 'vertex(X)')).toEqual([]);
    // The same survivor again (a thread feature copies its target's aliases) is no conflict.
    recordMerges(state.merged, naming);
    recordMerges(state.merged, naming);
    expect(mergeLookup(state, 'face', 'F2:back')).toEqual({ chain: ['F1:back'] });
    // A conflict on a survivor makes every name merged into it a conflict too.
    recordMerges(state.merged, [
      { name: 'F7:back', kind: 'face', index: 0 },
      { name: 'F1:back', kind: 'face', index: 0 },
    ]);
    recordMerges(state.merged, [
      { name: 'F8:back', kind: 'face', index: 2 },
      { name: 'F1:back', kind: 'face', index: 2 },
    ]);
    expect(mergeLookup(state, 'face', 'F2:back').conflict).toEqual(['F7:back', 'F8:back']);
  });

  it('resolveWithMerges: primary first, conflicts unresolved, survivors by name family only', async () => {
    const state = new ModelState();
    recordMerges(state.merged, [
      { name: 'S1', kind: 'vertex', index: 0 },
      { name: 'OLD', kind: 'vertex', index: 0 },
    ]);
    recordMerges(state.merged, [
      { name: 'S2', kind: 'vertex', index: 1 },
      { name: 'OLD', kind: 'vertex', index: 1 },
    ]);
    recordMerges(state.merged, [
      { name: 'F1:top', kind: 'face', index: 0 },
      { name: 'F2:top', kind: 'face', index: 0 },
    ]);
    const fp: ShapeFingerprints = {
      faces: [
        { centroid: [0, 0, 1], normal: [0, 0, 1], area: 4, surface: 'plane' },
        { centroid: [5, 0, 1], normal: [0, 0, 1], area: 1, surface: 'plane' },
      ],
      edges: [],
      vertices: [{ point: [0, 0, 0] }, { point: [1, 0, 0] }],
    };
    const rc = { diag: 10, fingerprints: async () => fp };
    const cand = (kind: 'face' | 'vertex', index: number, name: string) => ({
      shape: 1,
      kind,
      index,
      name,
      owner: 'B',
    });
    const verts = [cand('vertex', 0, 'S1'), cand('vertex', 1, 'S2')];
    const ref = {
      name: 'OLD',
      kind: 'vertex' as const,
      fingerprint: { centroid: [0, 0, 0] as Vec3 },
    };
    expect(await resolveWithMerges(ref, 'vertex', verts, state, rc)).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: ['S1', 'S2'],
    });
    // A current primary name beats the merge table.
    const withOld = [...verts, cand('vertex', 1, 'OLD')];
    const p = await resolveWithMerges(ref, 'vertex', withOld, state, rc);
    expect(p.ok && p.target.via).toBe('name');
    // A survivor that is gone: no fingerprint-only pick labelled merged.
    const faces = [cand('face', 1, 'F9:other')];
    const top = { name: 'F2:top', kind: 'face' as const };
    expect((await resolveWithMerges(top, 'face', faces, state, rc)).ok).toBe(false);
    const m = await resolveWithMerges(top, 'face', [cand('face', 0, 'F1:top')], state, rc);
    expect(m.ok && m.target.via).toBe('merged');
  });

  it('ModelState.apply collects aliases from every body it sets', () => {
    const state = new ModelState();
    state.apply({
      ok: true,
      set: [{ id: 'BF1', shape: 1, naming, key: 'k' }],
      remove: [],
      touched: ['BF1'],
      warnings: [],
    });
    expect(state.merged.get('face|F2:back')).toEqual(['F1:back']);
  });
});
