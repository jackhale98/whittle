import type {
  GeometricToleranceAnnotation,
  SurfaceFinishAnnotation,
  Vec2,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  angularLayout,
  arrowhead,
  chamferText,
  type DimensionStyle,
  datumRuns,
  dimensionLabel,
  holeCalloutLines,
  layoutDatumBox,
  layoutDimensionLabel,
  layoutFrame,
  layoutSurfaceFinish,
  leaderLayout,
  linearLayout,
  type Primitive,
  placeSymbol,
  radialLayout,
  readableAngle,
  SYMBOL_IDS,
  surfaceRequirementText,
  symbolGlyph,
  type TextRun,
  textWidth,
  toleranceRuns,
} from '../src/annotation';
import { stylePreset } from '../src/style';

const style = stylePreset('iso');
const dim: DimensionStyle = style.dimension;
const numbers = style.numbers;
const h = 3.5;

function points(prims: Primitive[]): Vec2[] {
  return prims.flatMap((p) => {
    switch (p.kind) {
      case 'line':
        return [p.a, p.b];
      case 'polyline':
        return p.points;
      case 'fill':
        return p.loops.flat();
      case 'arc':
        return [
          [p.center[0] - p.radius, p.center[1] - p.radius],
          [p.center[0] + p.radius, p.center[1] + p.radius],
        ];
      case 'text':
        return [p.at];
      default:
        return [];
    }
  });
}

const runsText = (runs: TextRun[]) =>
  runs.map((r) => (r.kind === 'text' ? r.text : `{${r.id}}`)).join('');

describe('symbol library', () => {
  it('draws every symbol as finite paths in its box (no font glyphs)', () => {
    expect(SYMBOL_IDS.length).toBeGreaterThanOrEqual(15 + 9 + 3);
    for (const id of SYMBOL_IDS) {
      const g = symbolGlyph(id);
      expect(g.prims.length, id).toBeGreaterThan(0);
      expect(
        g.prims.some((p) => p.kind === 'text'),
        id,
      ).toBe(false);
      for (const [x, y] of points(g.prims)) {
        expect(Number.isFinite(x) && Number.isFinite(y), id).toBe(true);
        expect(Math.abs(x) < 6 && Math.abs(y) < 4, id).toBe(true);
      }
    }
  });
  it('covers every GD&T characteristic, the hole symbols and the datum triangle', () => {
    for (const id of [
      'straightness',
      'flatness',
      'circularity',
      'cylindricity',
      'lineProfile',
      'surfaceProfile',
      'parallelism',
      'perpendicularity',
      'angularity',
      'position',
      'concentricity',
      'coaxiality',
      'symmetry',
      'circularRunout',
      'totalRunout',
      'mmc',
      'lmc',
      'projected',
      'freeState',
      'tangentPlane',
      'unequal',
      'statistical',
      'counterbore',
      'countersink',
      'depth',
      'datumTriangle',
    ])
      expect(SYMBOL_IDS).toContain(id);
  });
  it('scales and rotates with the text height', () => {
    const p = placeSymbol('straightness', [10, 20], 2, Math.PI / 2);
    expect(p[0]).toMatchObject({ kind: 'line' });
    const l = p[0] as Extract<Primitive, { kind: 'line' }>;
    expect(l.a[0]).toBeCloseTo(9);
    expect(l.b[1]).toBeCloseTo(22);
  });
  it('mirrors the projection symbol between first and third angle', () => {
    const first = symbolGlyph('projectionFirst').prims[0] as Extract<Primitive, { kind: 'arc' }>;
    const third = symbolGlyph('projectionThird').prims[0] as Extract<Primitive, { kind: 'arc' }>;
    expect(first.center[0]).toBeLessThan(third.center[0]);
  });
});

describe('text metrics', () => {
  it('widths scale with height and grow with length', () => {
    expect(textWidth('10', 7)).toBeCloseTo(2 * textWidth('10', 3.5));
    expect(textWidth('100', 3.5)).toBeGreaterThan(textWidth('10', 3.5));
    expect(textWidth('', 3.5)).toBe(0);
  });
});

describe('GD&T frames', () => {
  const frame = (over: Partial<GeometricToleranceAnnotation> = {}) => {
    const a: GeometricToleranceAnnotation = {
      id: 'g1',
      kind: 'geometricTolerance',
      origin: { kind: 'model' },
      refs: [],
      characteristic: 'position',
      zone: { value: '0.1 mm', shape: 'diameter', material: 'mmc' },
      datums: [
        { datums: [{ datum: 'dA' }] },
        { datums: [{ datum: 'dB' }, { datum: 'dC' }], material: 'mmc' },
      ],
      ...over,
    };
    return layoutFrame({
      annotation: a,
      zone: { value: 0.1 },
      datumLabel: (r) =>
        'datum' in r ? ({ dA: 'A', dB: 'B', dC: 'C' } as Record<string, string>)[r.datum] : r.label,
      standard: 'ISO 1101:2017',
      numbers,
      h,
    });
  };
  it('lays out characteristic, tolerance and datum cells, frame height 2h', () => {
    const f = frame();
    expect(f.height).toBe(7);
    expect(f.cells.map((c) => c.kind)).toEqual(['characteristic', 'tolerance', 'datum', 'datum']);
    expect(f.cells[0]?.width).toBe(7);
    for (const c of f.cells) expect(c.width).toBeGreaterThanOrEqual(7);
    const last = f.cells[f.cells.length - 1]!;
    expect(f.width).toBeCloseTo(last.x + last.width);
    expect(f.incomplete).toBe(false);
    const texts = f.prims.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);
    expect(texts).toEqual(['Ø0.1', 'A', 'B-C']);
  });
  it('writes ISO UZ/CZ as text and uses symbols for ASME', () => {
    const iso = toleranceRuns({
      annotation: {
        id: 'g',
        kind: 'geometricTolerance',
        origin: { kind: 'model' },
        refs: [],
        characteristic: 'surfaceProfile',
        zone: { value: '0.2 mm', unequal: '0.05 mm', modifiers: ['combinedZone'] },
      },
      zone: { value: 0.2, unequal: 0.05 },
      datumLabel: () => 'A',
      standard: 'ISO 1101:2017',
      numbers,
      h,
    });
    expect(runsText(iso.runs)).toBe('0.2 UZ+0.05 CZ');
    const asme = toleranceRuns({
      annotation: {
        id: 'g',
        kind: 'geometricTolerance',
        origin: { kind: 'model' },
        refs: [],
        characteristic: 'surfaceProfile',
        zone: { value: '0.2 mm', unequal: '0.05 mm', projected: '10 mm', material: 'lmc' },
      },
      zone: { value: 0.2, unequal: 0.05, projected: 10 },
      datumLabel: () => 'A',
      standard: 'ASME Y14.5-2018',
      numbers,
      h,
    });
    expect(runsText(asme.runs)).toBe('0.2{unequal}0.05{lmc}{projected}10');
  });
  it('shows ? and flags a frame whose datum or zone cannot be shown', () => {
    const f = layoutFrame({
      annotation: {
        id: 'g',
        kind: 'geometricTolerance',
        origin: { kind: 'model' },
        refs: [],
        characteristic: 'parallelism',
        zone: { value: 'oops' },
        datums: [{ datums: [{ datum: 'gone' }] }],
      },
      zone: {},
      datumLabel: () => undefined,
      standard: 'ISO 1101:2017',
      numbers,
      h,
    });
    expect(f.incomplete).toBe(true);
    expect(runsText(datumRuns({ datums: [{ datum: 'gone' }] }, () => undefined).runs)).toBe('?');
  });
});

describe('callouts', () => {
  it('builds hole callout lines with vector symbols', () => {
    const cb = holeCalloutLines(
      {
        count: 4,
        kind: 'counterbore',
        diameter: 6.6,
        depth: 'thru',
        counterbore: { diameter: 11, depth: 6.8 },
      },
      numbers,
    );
    expect(cb.map(runsText)).toEqual(['4× Ø6.6 THRU', '{counterbore}Ø11{depth}6.8']);
    const tapped = holeCalloutLines(
      {
        count: 1,
        kind: 'tapped',
        diameter: 5,
        depth: 15,
        thread: { designation: 'M6', class: '6H', depth: 12 },
      },
      numbers,
    );
    expect(tapped.map(runsText)).toEqual(['M6-6H{depth}12', 'Ø5{depth}15']);
    const cs = holeCalloutLines(
      {
        count: 2,
        kind: 'countersink',
        diameter: 6.6,
        depth: 'thru',
        countersink: { diameter: 12, angle: Math.PI / 2 },
      },
      numbers,
      { count: false },
    );
    expect(cs.map(runsText)).toEqual(['Ø6.6 THRU', '{countersink}Ø12 × 90°']);
  });
  it('formats chamfers', () => {
    expect(chamferText('distanceAngle', { distance: 2, angle: Math.PI / 4 }, numbers)).toBe(
      '2 × 45°',
    );
    expect(chamferText('twoDistances', { distance: 2, distance2: 3 }, numbers)).toBe('2 × 3');
    expect(chamferText('twoDistances', { distance: 2 }, numbers)).toBe('2 × ?');
  });
  it('lays out the datum box with the letter centred', () => {
    const b = layoutDatumBox('A', h);
    expect(b.width).toBe(7);
    expect(b.attention).toBe(false);
    expect(layoutDatumBox('', h).attention).toBe(true);
  });
  it('writes surface texture requirements in µm with the standard rules', () => {
    const a: SurfaceFinishAnnotation = {
      id: 's',
      kind: 'surfaceFinish',
      origin: { kind: 'model' },
      refs: [],
      process: 'removalRequired',
      requirements: [
        { parameter: 'Ra', value: '1.6 um' },
        { parameter: 'Rz', value: '6.3 um', acceptance: '16%' },
      ],
      lay: 'perpendicular',
      method: 'ground',
      allowance: '0.2 mm',
      allAround: true,
    };
    expect(surfaceRequirementText(a, 0, 0.0016, numbers)).toBe('Ra 1.6');
    expect(surfaceRequirementText(a, 1, 0.0063, numbers)).toBe('Rz 16% 6.3');
    expect(
      surfaceRequirementText(
        {
          ...a,
          standard: 'ISO 1302:2002',
          requirements: [{ parameter: 'Ra', value: '1', acceptance: 'max' }],
        },
        0,
        0.001,
        numbers,
      ),
    ).toBe('Ra max 1');
    const l = layoutSurfaceFinish(
      a,
      { requirements: [0.0016, 0.0063], allowance: 0.2 },
      numbers,
      h,
    );
    expect(l.attention).toBe(false);
    const texts = l.prims.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);
    expect(texts).toEqual(['Ra 1.6', 'Rz 16% 6.3', 'ground', '0.2']);
    expect(
      layoutSurfaceFinish(a, { requirements: [undefined, 0.0063] }, numbers, h).attention,
    ).toBe(true);
  });
});

describe('dimension layouts (ADR-055 rules)', () => {
  const lab = (v: number) =>
    layoutDimensionLabel(dimensionLabel({ value: v, quantity: 'length', numbers }), h);

  it('linear: extension lines start 1 mm from the geometry and overshoot 1.5 mm', () => {
    const g = linearLayout({
      p1: [0, 0],
      p2: [50, 0],
      dir: [1, 0],
      across: 15,
      label: lab(50),
      style: dim,
      h,
    });
    const lines = g.prims.filter(
      (p): p is Extract<Primitive, { kind: 'line' }> => p.kind === 'line',
    );
    const ext = lines.filter((l) => l.a[0] === l.b[0]);
    expect(ext).toHaveLength(2);
    for (const e of ext) {
      expect(e.a[1]).toBeCloseTo(1);
      expect(e.b[1]).toBeCloseTo(16.5);
    }
    expect(g.line).toEqual([
      [0, 15],
      [50, 15],
    ]);
    expect(g.arrowsOutside).toBe(false);
    const text = g.prims.find((p) => p.kind === 'text') as Extract<Primitive, { kind: 'text' }>;
    expect(text.at[1]).toBeGreaterThan(15);
    expect(text.angle).toBe(0);
  });
  it('linear: arrows flip outside when the span cannot hold text plus arrows', () => {
    const g = linearLayout({
      p1: [0, 0],
      p2: [4, 0],
      dir: [1, 0],
      across: 10,
      label: lab(4),
      style: dim,
      h,
    });
    expect(g.arrowsOutside).toBe(true);
    const text = g.prims.find((p) => p.kind === 'text') as Extract<Primitive, { kind: 'text' }>;
    expect(text.at[0]).toBeGreaterThan(4);
  });
  it('linear: shifted text beyond the extension lines pulls the dimension line out', () => {
    const g = linearLayout({
      p1: [0, 0],
      p2: [50, 0],
      dir: [1, 0],
      across: 10,
      label: lab(50),
      style: dim,
      h,
      shift: 60,
    });
    const dimLine = g.prims.find(
      (p) => p.kind === 'line' && p.a[1] === 10 && p.b[1] === 10,
    ) as Extract<Primitive, { kind: 'line' }>;
    expect(Math.max(dimLine.a[0], dimLine.b[0])).toBeGreaterThan(85);
  });
  it('linear vertical: ISO text reads from the right (90°)', () => {
    const g = linearLayout({
      p1: [0, 0],
      p2: [0, 40],
      dir: [0, 1],
      across: -12,
      label: lab(40),
      style: dim,
      h,
    });
    const text = g.prims.find((p) => p.kind === 'text') as Extract<Primitive, { kind: 'text' }>;
    expect(text.angle).toBe(90);
    expect(readableAngle([0, -1])).toBe(90);
    expect(readableAngle([-1, 0])).toBe(0);
  });
  it('ASME: unidirectional text in a break of the line', () => {
    const asme = stylePreset('asme').dimension;
    const g = linearLayout({
      p1: [0, 0],
      p2: [0, 40],
      dir: [0, 1],
      across: -12,
      label: lab(40),
      style: asme,
      h: 3,
    });
    const text = g.prims.find((p) => p.kind === 'text') as Extract<Primitive, { kind: 'text' }>;
    expect(text.angle).toBe(0);
    const dimLines = g.prims.filter((p) => p.kind === 'line' && p.a[0] === 12 && p.b[0] === 12);
    expect(dimLines).toHaveLength(2);
  });
  it('radial: radius and diameter put arrows on the curve', () => {
    const r = radialLayout({
      center: [0, 0],
      radius: 10,
      angle: 45,
      distance: 5,
      kind: 'radius',
      label: lab(10),
      style: dim,
      h,
    });
    const fill = r.prims.find((p) => p.kind === 'fill') as Extract<Primitive, { kind: 'fill' }>;
    const tip = fill.loops[0]![0]!;
    expect(Math.hypot(tip[0], tip[1])).toBeCloseTo(10);
    const d = radialLayout({
      center: [0, 0],
      radius: 10,
      angle: 0,
      distance: 5,
      kind: 'diameter',
      label: lab(20),
      style: dim,
      h,
    });
    expect(d.prims.filter((p) => p.kind === 'fill')).toHaveLength(2);
    expect(d.line[0][0]).toBeCloseTo(-10);
  });
  it('angular: arc at the radius, extension lines beyond the geometry', () => {
    const g = angularLayout({
      vertex: [0, 0],
      a: [1, 0],
      b: [Math.SQRT1_2, Math.SQRT1_2],
      extentA: 10,
      extentB: 10,
      radius: 30,
      label: layoutDimensionLabel(
        dimensionLabel({ value: Math.PI / 4, quantity: 'angle', numbers }),
        h,
      ),
      style: dim,
      h,
    });
    const arc = g.prims.find((p) => p.kind === 'arc') as Extract<Primitive, { kind: 'arc' }>;
    expect(arc.radius).toBe(30);
    expect(arc.end - arc.start).toBeCloseTo(Math.PI / 4);
    expect(g.prims.filter((p) => p.kind === 'line')).toHaveLength(2);
  });
  it('leader: arrow at the geometry, landing towards the text side', () => {
    const l = leaderLayout({
      attach: [0, 0],
      bends: [],
      text: [-20, 10],
      contentWidth: 10,
      terminator: 'arrow',
      style: dim,
      h,
    });
    expect(l.side).toBe('left');
    expect(l.contentAt[0]).toBeLessThan(-20);
    expect(l.prims.some((p) => p.kind === 'fill')).toBe(true);
  });
  it('arrowheads have the style length and included angle', () => {
    const [f] = arrowhead([0, 0], [1, 0], dim.arrow) as [Extract<Primitive, { kind: 'fill' }>];
    const [tip, left, right] = f.loops[0]!;
    expect(tip).toEqual([0, 0]);
    expect(left![0]).toBeCloseTo(-3);
    const half = Math.atan2(left![1] - right![1], 6) * (180 / Math.PI);
    expect(half * 2).toBeCloseTo(
      2 * Math.atan(Math.tan((15 * Math.PI) / 180)) * (180 / Math.PI) * 1,
      0,
    );
  });
});
