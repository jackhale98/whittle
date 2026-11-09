/**
 * cause.ts without the kernel: which features a persistent name records (outermost producers
 * first), and the structural rule over a part's feature list.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, Part } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { type CauseEnv, nameTags, newWalk, pushWalk, structuralCause } from '../../src/regen/cause';

describe('nameTags', () => {
  it('edges and vertices: one producer per adjacent face, then inner tags', () => {
    expect(nameTags('edge(F1:end|F3:side(S2:e(M1)))')).toEqual({
      outer: ['1', '3'],
      all: ['1', '3', '2'],
    });
    expect(nameTags('vertex(F1:end|F1:side(S0:e(l1))|F1:side(S0:e(l2)))#2').outer).toEqual(['1']);
  });

  it('history names: the outermost feature produced it', () => {
    expect(nameTags('F7:fillet(edge(F1:end|F1:side(S0:e(F2))))')).toEqual({
      outer: ['7'],
      all: ['7', '1', '0'],
    });
    // Entity ids inside e(…) are not tags, even when they look like one.
    expect(nameTags('S0:e(F2)').all).toEqual(['0']);
    expect(nameTags('F9:hole(S4:p(q)):wall').all).toEqual(['9', '4']);
    expect(nameTags('origin:XY').all).toEqual([]);
  });

  it('body refs and a copy feature’s missing source', () => {
    expect(nameTags('B01JX#2', 'body').all).toEqual(['01JX']);
    expect(nameTags('F01JX', 'body').all).toEqual(['01JX']);
  });
});

describe('structuralCause', () => {
  const f = (id: string, suppressed = false): Feature =>
    ({ id, type: 'fillet', name: id, suppressed, edges: [], radius: '1' }) as Feature;
  const env = (features: Feature[], failed: string[] = []): CauseEnv => {
    const part: Part = { id: 'P', name: 'P', features, rollbackIndex: features.length };
    const walk = newWalk();
    for (const x of features) {
      pushWalk(walk, {
        id: x.id,
        state: failed.includes(x.id) ? 'error' : x.suppressed ? 'suppressed' : 'ok',
        planned: true,
        deps: [],
      });
    }
    return {
      part,
      index: new Map(features.map((x, i) => [x.id, i])),
      walk,
      prev: null,
      label: () => '',
    };
  };
  const name = 'edge(F1:end|F3:side(S2:e(M1)))';

  it('deleted, suppressed, reordered, failed, or none', () => {
    expect(structuralCause(env([f('1'), f('2'), f('C')]), 'C', name)).toEqual({
      featureId: '3',
      kind: 'deleted',
    });
    expect(structuralCause(env([f('1'), f('2'), f('3', true), f('C')]), 'C', name)).toEqual({
      featureId: '3',
      kind: 'suppressed',
    });
    expect(structuralCause(env([f('1'), f('2'), f('C'), f('3')]), 'C', name)).toEqual({
      featureId: '3',
      kind: 'reordered',
    });
    expect(structuralCause(env([f('1'), f('2'), f('3'), f('C')], ['2']), 'C', name)).toEqual({
      featureId: '2',
      kind: 'failed',
    });
    expect(structuralCause(env([f('1'), f('2'), f('3'), f('C')]), 'C', name)).toBeNull();
  });
});
