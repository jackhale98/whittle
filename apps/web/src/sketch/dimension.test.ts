import { rectangleCornerTool } from '@whittle/sketch';
import { describe, expect, it } from 'vitest';
import {
  convertRadiusDiameter,
  dimensionAt,
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

  it('places horizontal / vertical distances by where the label goes', () => {
    // e1 (0,0) and e3 (40,30): above/below the span → horizontal, left/right → vertical.
    expect(dimensionAt(rect, ['e1', 'e3'], [20, 40])).toEqual({
      kind: 'hDistance',
      a: 'e1',
      b: 'e3',
    });
    expect(dimensionAt(rect, ['e3', 'e1'], [20, -10])).toEqual({
      kind: 'hDistance',
      a: 'e1',
      b: 'e3',
    });
    expect(dimensionAt(rect, ['e1', 'e3'], [50, 15])).toEqual({
      kind: 'vDistance',
      a: 'e1',
      b: 'e3',
    });
    // Inside the span or diagonal off it: aligned. Shift (aligned) forces it.
    expect(dimensionAt(rect, ['e1', 'e3'], [20, 15])?.kind).toBe('distance');
    expect(dimensionAt(rect, ['e1', 'e3'], [60, 50])?.kind).toBe('distance');
    expect(dimensionAt(rect, ['e1', 'e3'], [20, 40], { aligned: true })?.kind).toBe('distance');
    // Axis-aligned lines keep their length.
    expect(dimensionAt(rect, ['e5'], [20, -8])).toEqual({ kind: 'length', line: 'e5' });
    const h = dimensionAt(rect, ['e1', 'e3'], [20, 40]);
    expect(h && measure(rect, h)).toBeCloseTo(40);
    const v = dimensionAt(rect, ['e1', 'e3'], [50, 15]);
    expect(v && measure(rect, v)).toBeCloseTo(30);
  });

  it('oblique lines: h/v distance between their end points', () => {
    const sk = {
      entities: [
        { id: 'p', kind: 'point' as const, x: 10, y: 0, construction: false },
        { id: 'q', kind: 'point' as const, x: 0, y: 20, construction: false },
        { id: 'l', kind: 'line' as const, start: 'p', end: 'q', construction: false },
      ],
      constraints: [],
    };
    expect(dimensionAt(sk, ['l'], [5, 30])).toEqual({ kind: 'hDistance', a: 'q', b: 'p' });
    expect(dimensionAt(sk, ['l'], [-5, 10])).toEqual({ kind: 'vDistance', a: 'p', b: 'q' });
    expect(dimensionAt(sk, ['l'], [5, 10])).toEqual({ kind: 'length', line: 'l' });
    // A line as both ends (contract: end − start).
    expect(measure(sk, { kind: 'hDistance', a: 'l', b: 'l' })).toBeCloseTo(-10);
    expect(measure(sk, { kind: 'vDistance', a: 'l', b: 'l' })).toBeCloseTo(20);
  });

  it('converts radius ↔ diameter expressions', () => {
    expect(convertRadiusDiameter('3 mm', true)).toBe('6 mm');
    expect(convertRadiusDiameter('6 mm', false)).toBe('3 mm');
    expect(convertRadiusDiameter('hole_d/2', true)).toBe('hole_d');
    expect(convertRadiusDiameter('hole_d', false)).toBe('hole_d/2');
    expect(convertRadiusDiameter('(a + b)/2', true)).toBe('a + b');
    expect(convertRadiusDiameter('a + b', false)).toBe('(a + b)/2');
    expect(convertRadiusDiameter('r1', true)).toBe('2 * r1');
    expect(convertRadiusDiameter('2 * r1', false)).toBe('r1');
    // Several groups: never strip a parenthesis that doesn't wrap the whole operand.
    expect(convertRadiusDiameter('(a) * (b)/2', true)).toBe('2 * ((a) * (b)/2)');
    expect(convertRadiusDiameter('2 * (r) + (gap)', false)).toBe('(2 * (r) + (gap))/2');
    expect(convertRadiusDiameter('((a + b))/2', true)).toBe('(a + b)');
    expect(convertRadiusDiameter('2 * (a * (b + c))', false)).toBe('a * (b + c)');
  });
});
