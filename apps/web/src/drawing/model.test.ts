import { describe, expect, it } from 'vitest';
import {
  alignedDistance,
  DEFAULT_FORMAT,
  detailScale,
  dominantAxis,
  freeSpot,
  newDrawing,
  nextLetter,
  ratioExpr,
  rectOf,
  SCALE_SERIES,
  scaleFromInput,
  scaleLabel,
  sideForDirection,
  suggestScale,
  usableArea,
} from './model';

const bracket = {
  min: [0, 0, 0] as [number, number, number],
  max: [80, 50, 48] as [number, number, number],
};
const iso = {
  family: 'iso' as const,
  gps: 'ISO 1101:2017' as const,
  surfaceFinish: 'ISO 21920-1:2021' as const,
};

describe('scales', () => {
  it('writes ratios as expressions and labels', () => {
    expect(ratioExpr(1)).toBe('1');
    expect(ratioExpr(0.5)).toBe('1/2');
    expect(ratioExpr(0.2)).toBe('1/5');
    expect(ratioExpr(2)).toBe('2');
    expect(ratioExpr(0.1)).toBe('1/10');
    expect(scaleLabel(0.5)).toBe('1:2');
    expect(scaleLabel(2)).toBe('2:1');
    expect(scaleLabel(1)).toBe('1:1');
  });

  it('reads what a user types as a scale', () => {
    expect(scaleFromInput('1:2')).toBe('1/2');
    expect(scaleFromInput(' 5 : 1 ')).toBe('5/1');
    expect(scaleFromInput('1/4')).toBe('1/4');
    expect(scaleFromInput('2')).toBe('2');
    expect(scaleFromInput('')).toBeNull();
  });

  it('picks the largest standard ratio at which the three views fit the usable area', () => {
    const area = usableArea(DEFAULT_FORMAT.iso, {
      id: 'iso-5457',
      version: 1,
    });
    // A3 landscape: the bracket's plan and elevation fit at 1:1 or larger, never past the series.
    const s = suggestScale(bracket, area);
    expect(SCALE_SERIES).toContain(s);
    const w = (bracket.max[0] - bracket.min[0] + (bracket.max[1] - bracket.min[1])) * s;
    expect(w).toBeLessThanOrEqual(area.max[0] - area.min[0]);
    // The next ratio up would not have fitted.
    const up = SCALE_SERIES[SCALE_SERIES.indexOf(s) - 1];
    if (up !== undefined) {
      const wUp = 130 * up > area.max[0] - area.min[0] - 40;
      const hUp = 98 * up > area.max[1] - area.min[1] - 40;
      expect(wUp || hUp).toBe(true);
    }
    // A huge part gets the smallest ratio; a tiny one the largest.
    expect(suggestScale({ min: [0, 0, 0], max: [1e5, 1e5, 1e5] }, area)).toBe(0.01);
    expect(suggestScale({ min: [0, 0, 0], max: [1, 1, 1] }, area)).toBe(10);
  });

  it('a detail enlarges its parent, aiming at a readable size', () => {
    expect(detailScale(10, 1)).toBe(2);
    expect(detailScale(5, 1)).toBe(5);
    expect(detailScale(1, 1)).toBe(10);
    expect(detailScale(10, 2)).toBeGreaterThan(2);
    expect(detailScale(1000, 1)).toBe(2); // always an enlargement: the smallest one
  });
});

describe('a new drawing follows the standard (D10)', () => {
  const defaults = { standard: iso, projection: 'first' as const };

  it('ISO: A3 landscape, ISO 5457 template at its latest version, ISO style', () => {
    const d = newDrawing({
      id: 'D',
      sheetId: 'S',
      name: 'Bracket',
      partId: 'P',
      defaults,
      scale: 0.5,
    });
    expect(d.template.id).toBe('iso-5457');
    expect(d.sheets[0]).toMatchObject({
      id: 'S',
      format: { size: 'A3', orientation: 'landscape' },
      scale: '1/2',
    });
    expect(d.style.lineGroup).toBe('iso-0.5');
    expect(d.projection).toBe('first');
    expect(d.units).toBe('mm');
    expect(d.subject).toEqual({ kind: 'part', partId: 'P' });
    expect(d.configurationId).toBeUndefined();
    expect(d.views).toEqual([]);
  });

  it('ASME: ANSI B, Y14.1, the ASME style; the style is a copy, never shared', () => {
    const asme = {
      standard: {
        family: 'asme' as const,
        gps: 'ASME Y14.5-2018' as const,
        surfaceFinish: 'ASME Y14.36-2018' as const,
      },
      projection: 'third' as const,
    };
    const a = newDrawing({
      id: 'D',
      sheetId: 'S',
      name: 'x',
      partId: 'P',
      defaults: asme,
      scale: 1,
      configurationId: 'C',
    });
    expect(a.template.id).toBe('asme-y14.1');
    expect(a.sheets[0]?.format).toEqual({ size: 'ANSI-B', orientation: 'landscape' });
    expect(a.style.lineGroup).toBe('asme-0.6');
    expect(a.configurationId).toBe('C');
    const b = newDrawing({
      id: 'E',
      sheetId: 'T',
      name: 'y',
      partId: 'P',
      defaults: asme,
      scale: 1,
    });
    a.style.text.dimension = 99;
    expect(b.style.text.dimension).not.toBe(99);
    expect(asme.standard).not.toBe(a.standard);
  });
});

describe('where a dragged view goes', () => {
  it('the side a drag means follows the projection method', () => {
    // Third angle: the view is seen from the side it is dragged to.
    expect(sideForDirection([0, 1], 'third')).toBe('top');
    expect(sideForDirection([1, 0], 'third')).toBe('right');
    // First angle: the opposite side.
    expect(sideForDirection([0, -1], 'first')).toBe('top');
    expect(sideForDirection([1, 0], 'first')).toBe('left');
    expect(sideForDirection([-1, 0], 'first')).toBe('right');
    expect(dominantAxis([3, -1])).toEqual([1, 0]);
    expect(dominantAxis([-0.2, -5])).toEqual([0, -1]);
  });

  it('never lets an aligned view overlap its parent, however small the drag', () => {
    const frame = { x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] } as never;
    const parent = { frame, scale: 1 };
    const min = alignedDistance(parent, 'top', bracket, 'first', null);
    // Half the front's height plus half the top view's depth plus the gap.
    expect(min).toBeCloseTo(48 / 2 + 50 / 2 + 25, 6);
    expect(alignedDistance(parent, 'top', bracket, 'first', 5)).toBeCloseTo(min, 6);
    expect(alignedDistance(parent, 'top', bracket, 'first', 200)).toBe(200);
  });

  it('finds free space for a view, preferring where it was asked to go', () => {
    const area = { min: [10, 10] as [number, number], max: [200, 150] as [number, number] };
    const taken = [rectOf([50, 100], 60, 40)];
    // The preferred spot is free.
    expect(freeSpot(taken, 30, 20, area, [[150, 100]])).toEqual([150, 100]);
    // The preferred spot is taken: another place that fits and does not overlap.
    const at = freeSpot(taken, 30, 20, area, [[50, 100]]);
    const r = rectOf(at, 30, 20);
    expect(r.min[0] >= area.min[0] && r.max[0] <= area.max[0]).toBe(true);
    expect(r.min[1] >= area.min[1] && r.max[1] <= area.max[1]).toBe(true);
    expect(
      r.max[0] + 12 <= 20 || r.min[0] - 12 >= 80 || r.max[1] + 12 <= 80 || r.min[1] - 12 >= 120,
    ).toBe(true);
  });

  it('section and detail letters skip I, O and Q', () => {
    expect(nextLetter([])).toBe('A');
    expect(nextLetter(['A', 'B'])).toBe('C');
    expect(nextLetter(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).toBe('J');
    expect(nextLetter(['K', 'L', 'M', 'N'])).toBe('A');
    expect(nextLetter(Array.from('ABCDEFGHJKLMNPRSTUVWXYZ'))).toMatch(/^A/);
  });
});
