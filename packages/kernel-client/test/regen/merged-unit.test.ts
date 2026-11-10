/**
 * Merge aliases in body naming maps (ADR-076), without a kernel: primary entries, the walk's
 * absorbed → survivor table, and merge chains.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NamingMap } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { mergeChain, ModelState, primaryNaming, recordMerges } from '../../src/regen/state';

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
    expect(state.merged.get('face|F2:back')).toBe('F1:back');
    expect(state.merged.get('edge|edge(F2:back|F2:top)')).toBe('edge(F1:back|F1:top)');
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

  it('ModelState.apply collects aliases from every body it sets', () => {
    const state = new ModelState();
    state.apply({
      ok: true,
      set: [{ id: 'BF1', shape: 1, naming, key: 'k' }],
      remove: [],
      touched: ['BF1'],
      warnings: [],
    });
    expect(state.merged.get('face|F2:back')).toBe('F1:back');
  });
});
