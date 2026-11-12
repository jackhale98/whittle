import type { DisplayList } from '@wren-cad/drawing/annotation';
import { describe, expect, it } from 'vitest';
import { hitTest, itemDistance, sourceKey } from '../src/drawing/hit';
import { sheetUnits } from '../src/drawing/SheetValueField';
import { toleranceText } from '../src/drawing/ToleranceField';
import {
  fitView,
  MAX_K,
  panBy,
  pinch,
  toScreen,
  toSheet,
  zoomAt,
  zoomPercent,
} from '../src/drawing/viewerMath';

const sheet = { w: 420, h: 297 };

describe('sheet viewer maths', () => {
  it('fits the sheet in the box, centred, with a margin', () => {
    const v = fitView(sheet, { w: 1000, h: 800 });
    expect(v.k).toBeCloseTo(Math.min(968 / 420, 768 / 297), 9);
    expect(v.x).toBeCloseTo((1000 - 420 * v.k) / 2, 9);
    expect(v.y).toBeCloseTo((800 - 297 * v.k) / 2, 9);
    expect(zoomPercent(v, v.k)).toBe(100);
  });

  it('maps screen to sheet with y up, and back', () => {
    const v = fitView(sheet, { w: 1000, h: 800 });
    const p = toSheet(v, sheet, { x: v.x, y: v.y });
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(297, 9);
    const s = toScreen(v, sheet, [210, 148.5]);
    const back = toSheet(v, sheet, s);
    expect(back[0]).toBeCloseTo(210, 9);
    expect(back[1]).toBeCloseTo(148.5, 9);
  });

  it('zooms about a fixed screen point and clamps', () => {
    const v = fitView(sheet, { w: 1000, h: 800 });
    const at = { x: 300, y: 200 };
    const before = toSheet(v, sheet, at);
    const z = zoomAt(v, 2, at, v.k);
    const after = toSheet(z, sheet, at);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(zoomAt(v, 1e6, at, v.k).k).toBe(MAX_K);
    expect(zoomAt(v, 1e-6, at, v.k).k).toBeCloseTo(v.k * 0.4, 9);
  });

  it('a pinch scales by the finger distance and follows the midpoint', () => {
    const v = fitView(sheet, { w: 1000, h: 800 });
    const from = { a: { x: 400, y: 400 }, b: { x: 500, y: 400 } };
    const to = { a: { x: 350, y: 420 }, b: { x: 550, y: 420 } };
    const z = pinch(v, from, to, v.k);
    expect(z.k).toBeCloseTo(v.k * 2, 9);
    // The sheet point under the old midpoint is under the new one.
    const before = toSheet(v, sheet, { x: 450, y: 400 });
    const after = toSheet(z, sheet, { x: 450, y: 420 });
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    expect(panBy(v, 5, -3)).toMatchObject({ x: v.x + 5, y: v.y - 3, k: v.k });
  });
});

const list: DisplayList = {
  width: 420,
  height: 297,
  items: [
    {
      kind: 'line',
      a: [10, 10],
      b: [50, 10],
      role: 'visible',
      source: { kind: 'view', viewId: 'V', edge: 'e1' },
    },
    {
      kind: 'line',
      a: [10, 30],
      b: [50, 30],
      role: 'dimension',
      source: { kind: 'placement', placementId: 'P', annotationId: 'A' },
    },
    {
      kind: 'text',
      at: [30, 20],
      text: '80',
      height: 3.5,
      angle: 0,
      align: 'center',
      baseline: 'middle',
      role: 'text',
      source: { kind: 'placement', placementId: 'P', annotationId: 'A' },
    },
    { kind: 'line', a: [0, 0], b: [420, 0], role: 'frame', source: { kind: 'template' } },
    {
      kind: 'line',
      a: [10, 15],
      b: [50, 15],
      role: 'hatch',
      source: { kind: 'view', viewId: 'V', edge: 'cut' },
    },
    {
      kind: 'arc',
      center: [100, 50],
      radius: 10,
      start: 0,
      end: Math.PI * 2,
      role: 'visible',
      source: { kind: 'view', viewId: 'V', edge: 'circle' },
    },
  ],
};

describe('picking on a sheet', () => {
  it('finds the nearest view edge within the tolerance', () => {
    const hit = hitTest(list, [30, 11], 2);
    expect(hit?.source).toEqual({ kind: 'view', viewId: 'V', edge: 'e1' });
    expect(hit?.onGeometry).toBe(true);
    expect(hitTest(list, [30, 14], 2)).toBeNull();
  });

  it('prefers an annotation to a view edge it overlaps, and picks its text', () => {
    const near = hitTest(list, [30, 20], 2);
    expect(near?.source.kind).toBe('placement');
    // Text is picked inside its box, not only on its anchor.
    expect(itemDistance(list.items[2] as never, [31.5, 20], 1)).toBe(0);
  });

  it('a dimension text has a reach of its own: a 44 px target on touch (ADR-094)', () => {
    // 6 mm from the text box (its half width is about 3 mm), clear of the dimension line.
    const far: [number, number] = [38, 20];
    expect(hitTest(list, far, 2)).toBeNull();
    const hit = hitTest(list, far, 2, [], 8);
    expect(hit?.source.kind).toBe('placement');
    expect(hit?.itemKind).toBe('text');
    // A pick on the dimension line itself is not the text.
    expect(hitTest(list, [20, 30], 2, [], 8)?.itemKind).toBe('line');
    // The larger reach is for annotation text only: a view's edge keeps its own tolerance.
    expect(hitTest(list, [30, 5], 2, [], 8)).toBeNull();
  });

  it('never picks hatch or the template frame; arcs by their curve', () => {
    expect(hitTest(list, [30, 0], 2)).toBeNull();
    expect(hitTest(list, [30, 15], 0.5)).toBeNull();
    expect(hitTest(list, [110, 50], 1)?.source).toEqual({
      kind: 'view',
      viewId: 'V',
      edge: 'circle',
    });
    expect(hitTest(list, [100, 50], 1)).toBeNull();
  });

  it('falls back to the smallest region under the point', () => {
    const regions = [
      {
        source: { kind: 'view', viewId: 'big' } as const,
        min: [0, 0] as [number, number],
        max: [200, 200] as [number, number],
      },
      {
        source: { kind: 'view', viewId: 'small' } as const,
        min: [60, 60] as [number, number],
        max: [90, 90] as [number, number],
      },
    ];
    expect(hitTest(list, [70, 70], 1, regions)?.source).toEqual({ kind: 'view', viewId: 'small' });
    expect(hitTest(list, [70, 70], 1, regions)?.onGeometry).toBe(false);
    expect(hitTest(list, [300, 250], 1, regions)).toBeNull();
    expect(sourceKey({ kind: 'titleBlock', slot: 'partNumber' })).toBe('titleBlock:partNumber');
    expect(sourceKey({ kind: 'placement', placementId: 'P', annotationId: 'A' })).toBe(
      'placement:P',
    );
  });
});

describe('the tolerance field text', () => {
  it('writes each form the way it is typed', () => {
    expect(toleranceText(undefined)).toBe('');
    expect(toleranceText({ kind: 'symmetric', value: '0.1 mm' })).toBe('±0.1');
    expect(toleranceText({ kind: 'bilateral', upper: '0.1 mm', lower: '-0.05 mm' })).toBe(
      '+0.1/-0.05',
    );
    expect(toleranceText({ kind: 'fit', hole: 'H7', shaft: 'g6', show: 'symbol' })).toBe('H7/g6');
    expect(toleranceText({ kind: 'basic' })).toBe('[ ]');
    expect(toleranceText({ kind: 'reference' })).toBe('( )');
  });
});

describe('sheet values', () => {
  it('a bare number is sheet millimetres or degrees; anything with a unit or an operator is left alone', () => {
    expect(sheetUnits('12', 'mm')).toBe('12mm');
    expect(sheetUnits(' -0.5 ', 'mm')).toBe('-0.5mm');
    expect(sheetUnits('30', 'deg')).toBe('30deg');
    expect(sheetUnits('1.5e2', 'mm')).toBe('1.5e2mm');
    expect(sheetUnits('0.5in', 'mm')).toBe('0.5in');
    expect(sheetUnits('10+2', 'mm')).toBe('10+2');
    expect(sheetUnits('w/2', 'mm')).toBe('w/2');
  });
});
