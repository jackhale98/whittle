/**
 * Push/pull step order (ADR-013 addendum): faces grouped by normal within 1e-6 after
 * normalising, groups sorted by normal, input order kept inside a group.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec3 } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { groupByNormal } from '../../src/regen/geometry';

const f = (id: string, normal?: Vec3) => ({ id, normal });

describe('groupByNormal', () => {
  it('groups equal normals (after normalising) and sorts the groups by normal', () => {
    const g = groupByNormal([
      f('top', [0, 0, 1]),
      f('right', [1, 0, 0]),
      f('top2', [0, 0, 2]),
      f('left', [-1, 0, 0]),
      f('top3', [0, 1e-7, 1]),
    ]);
    expect(g?.map((x) => x.items.map((i) => i.id))).toEqual([
      ['left'],
      ['top', 'top2', 'top3'],
      ['right'],
    ]);
    expect(g?.[1]?.normal).toEqual([0, 0, 1]);
  });

  it('is independent of the selection order', () => {
    const a = groupByNormal([f('a', [0, 0, 1]), f('b', [1, 0, 0]), f('c', [0, -1, 0])]);
    const b = groupByNormal([f('c', [0, -1, 0]), f('b', [1, 0, 0]), f('a', [0, 0, 1])]);
    expect(a?.map((x) => x.normal)).toEqual(b?.map((x) => x.normal));
  });

  it('keeps normals more than 1e-6 apart in separate groups', () => {
    const n = Math.SQRT1_2;
    const g = groupByNormal([f('a', [0, 0, 1]), f('b', [0, 1e-5, 1]), f('c', [n, 0, n])]);
    expect(g).toHaveLength(3);
  });

  it('returns null when a face has no normal (curved: the kernel reports it)', () => {
    expect(groupByNormal([f('a', [0, 0, 1]), f('b')])).toBeNull();
    expect(groupByNormal([f('a', [0, 0, 0])])).toBeNull();
  });
});
