import type { AnchoredPoint } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  addVertex,
  cutKind,
  moveVertex,
  removeVertex,
  toHalfSection,
  toOffsetSection,
} from './cutline';

const f = (x: number, y: number): AnchoredPoint => ({ kind: 'free', at: [x, y] });
const pts = (c: readonly AnchoredPoint[]) => c.map((p) => (p.kind === 'free' ? p.at : null));

describe('cut line edits', () => {
  const straight = [f(0, 0), f(40, 0)];

  it('a half section turns at the middle by a right angle, towards the looking side', () => {
    expect(pts(toHalfSection(straight, 'left') as AnchoredPoint[])).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
    ]);
    expect(pts(toHalfSection(straight, 'right') as AnchoredPoint[])[2]).toEqual([20, -20]);
    expect(cutKind(toHalfSection(straight, 'left') as AnchoredPoint[])).toBe('half');
  });

  it('an offset section jogs across and continues in a parallel plane', () => {
    const o = toOffsetSection(straight, 'left') as AnchoredPoint[];
    expect(pts(o)).toEqual([
      [0, 0],
      [20, 0],
      [20, 10],
      [40, 10],
    ]);
    expect(cutKind(o)).toBe('offset');
  });

  it('only a plain two-point cut converts', () => {
    expect(toHalfSection([f(0, 0), f(1, 0), f(1, 1)], 'left')).toBeNull();
    expect(toOffsetSection([f(3, 3), f(3, 3)], 'left')).toBeNull();
  });

  it('a vertex is added in the middle of the longest segment and removed again', () => {
    const c = addVertex([f(0, 0), f(10, 0), f(10, 40)]);
    expect(pts(c)).toEqual([
      [0, 0],
      [10, 0],
      [10, 20],
      [10, 40],
    ]);
    expect(pts(removeVertex(c, 2))).toEqual([
      [0, 0],
      [10, 0],
      [10, 40],
    ]);
  });

  it('a cut line keeps two points', () => {
    expect(removeVertex(straight, 0)).toHaveLength(2);
  });

  it('moving a vertex makes it a free point and leaves the others alone', () => {
    const ref: AnchoredPoint = { kind: 'ref', ref: { name: 'e', kind: 'edge' } };
    const c = moveVertex([f(0, 0), ref, f(5, 5)], 1, [2.00004, 3]);
    expect(c[1]).toEqual({ kind: 'free', at: [2, 3] });
    expect(c[0]).toEqual(f(0, 0));
  });
});
