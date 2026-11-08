import { rectangleCornerTool } from '@whittle/sketch';
import { describe, expect, it } from 'vitest';
import {
  dimensionFor,
  initialExpr,
  labelAnchor,
  makeDimension,
  measure,
  removeEntities,
} from './dimension';

const rect = rectangleCornerTool([0, 0], [40, 30], {
  id: (() => {
    let n = 0;
    return () => `e${++n}`;
  })(),
});
// ids: points e1..e4, lines e5 (bottom) e6 (right) e7 (top) e8 (left), constraints e9..e12

describe('dimension tool', () => {
  it('maps picks to dimensions and measures them', () => {
    const len = dimensionFor(rect, ['e5']);
    expect(len).toEqual({ kind: 'length', line: 'e5' });
    expect(len && measure(rect, len)).toBeCloseTo(40);
    const d = dimensionFor(rect, ['e1', 'e3']);
    expect(d?.kind).toBe('distance');
    expect(d && measure(rect, d)).toBeCloseTo(50);
    const pl = dimensionFor(rect, ['e6', 'e1']);
    expect(pl).toEqual({ kind: 'distance', a: 'e1', b: 'e6' });
    expect(pl && measure(rect, pl)).toBeCloseTo(40);
    const par = dimensionFor(rect, ['e5', 'e7']);
    expect(par?.kind).toBe('distance');
    expect(par && measure(rect, par)).toBeCloseTo(30);
    const ang = dimensionFor(rect, ['e5', 'e6']);
    expect(ang?.kind).toBe('angle');
    expect(ang && measure(rect, ang)).toBeCloseTo(Math.PI / 2);
    expect(initialExpr('length', 39.996)).toBe('40 mm');
    expect(initialExpr('angle', Math.PI / 2)).toBe('90 deg');
  });

  it('labels sit next to their geometry unless placed', () => {
    const c = makeDimension({ kind: 'length', line: 'e5' }, '40 mm');
    expect(labelAnchor(rect, c)).toEqual([20, 0]);
    expect(labelAnchor(rect, { ...c, label: [1, 2] })).toEqual([1, 2]);
  });

  it('deleting a line removes its unused points and dependent constraints', () => {
    const next = removeEntities(rect, ['e5']);
    expect(next.entities.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e6', 'e7', 'e8']);
    expect(next.constraints.some((c) => 'line' in c && c.line === 'e5')).toBe(false);
    const pt = removeEntities(rect, ['e1']);
    expect(pt.entities.map((e) => e.id)).toEqual(['e2', 'e3', 'e4', 'e6', 'e7']);
  });
});
