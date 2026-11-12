import type { Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { arcDrag, detailRadius, SHIFT_SNAP, textDrag } from './drag-math';

const h = 3.5;
/** A horizontal dimension line from x = 0 to 50 at y = 10, its text centred above it. */
const start = {
  line: [
    [0, 10],
    [50, 10],
  ] as [Vec2, Vec2],
  shift: 0,
  centre: [25, 10 + 0.4 * h + h / 2] as Vec2,
  h,
};
const grab = start.centre;

describe('dragging a dimension text (ADR-094)', () => {
  it('along the line it shifts by the distance, and the side stays', () => {
    const t = textDrag(start, grab, [grab[0] + 12, grab[1]]);
    expect(t.shift).toBe(12);
    expect(t.side).toBe('above');
    // From a stored shift, the drag adds to it.
    expect(textDrag({ ...start, shift: 5 }, grab, [grab[0] - 2, grab[1]]).shift).toBe(3);
  });

  it('back to the middle drops the shift: the text is auto-centred again', () => {
    expect(textDrag(start, grab, [grab[0] + SHIFT_SNAP / 2, grab[1]]).shift).toBeUndefined();
    expect(textDrag({ ...start, shift: 8 }, grab, [grab[0] - 8, grab[1]]).shift).toBeUndefined();
  });

  it('across the line it snaps to above, inline or below by where the text centre is', () => {
    const at = (dy: number) => textDrag(start, grab, [grab[0], grab[1] + dy]);
    expect(at(0).side).toBe('above');
    expect(at(-grab[1] + 10 + 0.5).side).toBe('inline');
    expect(at(-grab[1] + 10 - 0.5).side).toBe('inline');
    expect(at(-8).side).toBe('below');
    expect(at(-8).across).toBeLessThan(-h * 0.45);
    expect(at(20).side).toBe('above');
  });

  it('is measured along the line, whichever way it runs (vertical, sloped)', () => {
    const v = {
      line: [
        [0, 0],
        [0, 40],
      ] as [Vec2, Vec2],
      shift: 0,
      centre: [-3, 20] as Vec2,
      h,
    };
    // Up the line is +shift; to its left (the reading direction's up) is "above".
    expect(textDrag(v, v.centre, [-3, 27]).shift).toBe(7);
    expect(textDrag(v, v.centre, [-3, 20]).side).toBe('above');
    expect(textDrag(v, v.centre, [4, 20]).side).toBe('below');
    const d = Math.SQRT1_2;
    const s = {
      line: [
        [0, 0],
        [30 * d, 30 * d],
      ] as [Vec2, Vec2],
      shift: 0,
      centre: [10, 10] as Vec2,
      h,
    };
    expect(textDrag(s, s.centre, [10 + 5 * d, 10 + 5 * d]).shift).toBe(5);
  });

  it('grabbing by the text edge does not flip the side on the first move', () => {
    // The pointer is not at the centre: only its movement counts.
    const edge: Vec2 = [grab[0] + 6, grab[1] - h / 2];
    expect(textDrag(start, edge, [edge[0] + 1, edge[1]]).side).toBe('above');
  });
});

describe('dragging an angle dimension (ADR-094)', () => {
  const s = { vertex: [0, 0] as Vec2, radius: 20, shift: 0, centre: [20, 0] as Vec2 };

  it('by its text: the radius follows the distance from the vertex and the text slides on the arc', () => {
    const r = arcDrag(s, [0, 30], 'text');
    expect(r.radius).toBe(30);
    // A quarter turn at radius 30.
    expect(r.shift).toBeCloseTo((Math.PI / 2) * 30, 1);
    expect(arcDrag(s, [30, 0], 'text').shift).toBeUndefined();
  });

  it('by its arc: only the radius changes and the stored shift stays', () => {
    const r = arcDrag({ ...s, shift: 6 }, [0, 25], 'arc');
    expect(r).toEqual({ radius: 25, shift: 6 });
  });

  it('takes the shortest way round, and never a radius under 2 mm', () => {
    const r = arcDrag({ ...s, centre: [-20, 1] }, [-20, -1], 'text');
    expect(Math.abs(r.shift ?? 0)).toBeLessThan(3);
    expect(arcDrag(s, [0.1, 0.1], 'text').radius).toBe(2);
  });
});

describe('dragging a detail circle (ADR-094)', () => {
  it('the radius handle sets the radius to its distance from the centre, in part mm', () => {
    expect(detailRadius([100, 100], 2, [120, 100])).toBe(10);
    expect(detailRadius([100, 100], 0.5, [100, 130])).toBe(60);
    expect(detailRadius([100, 100], 2, [100, 100])).toBe(0.5);
  });
});
