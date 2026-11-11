import type { Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '../src/annotation';
import { flattenArc, flattenBSpline, roleStroke } from '../src/annotation';
import { hatchLines, resolveTokens, wrapText } from '../src/sheet';
import { stylePreset } from '../src/style';
import { bracketBuild } from './fixtures';

const texts = (items: DisplayItem[]) =>
  items
    .filter((i): i is Extract<DisplayItem, { kind: 'text' }> => i.kind === 'text')
    .map((t) => t.text);

describe('hatching', () => {
  const square: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it('fills a polygon with parallel thin lines at the spacing', () => {
    const l = hatchLines([square], { pattern: 'iso-general', angle: 0, spacing: 2.5 });
    expect(l.map(([a]) => a[1])).toEqual([0, 2.5, 5, 7.5]);
    for (const [a, b] of l) expect(b[0] - a[0]).toBeCloseTo(10);
  });
  it('leaves holes empty (even-odd) and crosses for metal', () => {
    const hole: Vec2[] = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ];
    const l = hatchLines([square, hole], { pattern: 'iso-general', angle: 0, spacing: 5 });
    expect(l.filter(([a]) => a[1] === 5)).toHaveLength(2);
    const x = hatchLines([square], { pattern: 'iso-metal-cross', angle: 45, spacing: 2 });
    const y = hatchLines([square], { pattern: 'iso-general', angle: 45, spacing: 2 });
    expect(x.length).toBe(2 * y.length);
    expect(hatchLines([square], { pattern: 'none', angle: 0, spacing: 2 })).toEqual([]);
  });
});

describe('flattening', () => {
  it('arcs stay within the chord tolerance', () => {
    const pts = flattenArc([0, 0], 10, 0, Math.PI, 0.01);
    for (let i = 1; i < pts.length; i++) {
      const m = [(pts[i - 1]![0] + pts[i]![0]) / 2, (pts[i - 1]![1] + pts[i]![1]) / 2];
      expect(10 - Math.hypot(m[0]!, m[1]!)).toBeLessThanOrEqual(0.01 + 1e-12);
    }
  });
  it('clamped B-splines start and end on their end poles', () => {
    const pts = flattenBSpline(
      2,
      [
        [0, 0],
        [5, 10],
        [10, 0],
      ],
      [0, 0, 0, 1, 1, 1],
      0.01,
    );
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)![0]).toBeCloseTo(10);
    expect(pts[Math.floor(pts.length / 2)]![1]).toBeCloseTo(5, 1);
  });
});

describe('line roles', () => {
  it('maps roles to ISO 128 widths: thick visible, thin rest, 0.7 mm frame', () => {
    const s = stylePreset('iso');
    expect(roleStroke('visible', s).width).toBe(0.5);
    expect(roleStroke('hidden', s)).toMatchObject({ width: 0.25, type: 'dashed', dash: [3, 0.75] });
    expect(roleStroke('center', s).type).toBe('center');
    expect(roleStroke('frame', s).width).toBe(0.7);
    expect(roleStroke('frame', stylePreset('asme')).width).toBe(0.6);
    expect(roleStroke('dimension', { lineGroup: 'iso-0.35' }).width).toBe(0.18);
  });
});

describe('sheet composition (bracket, mocked kernel results)', () => {
  const build = bracketBuild();
  const sheet = build.sheets[0]!;
  const items = sheet.list.items;

  it('is the A3 sheet with frame, title block and views', () => {
    expect([sheet.list.width, sheet.list.height]).toEqual([420, 297]);
    expect(texts(items)).toContain('Bracket');
    expect(texts(items)).toContain('BRK-001');
    expect(
      items.filter((i) => i.role === 'visible' && i.source?.kind === 'view').length,
    ).toBeGreaterThan(40);
  });
  it('draws centre marks on face-on circles, the cutting plane, the section label and hatching', () => {
    expect(items.some((i) => i.role === 'center' && i.source?.kind === 'centerMark')).toBe(true);
    expect(items.filter((i) => i.role === 'cuttingPlaneEnd')).toHaveLength(2);
    expect(texts(items)).toContain('A–A');
    expect(items.filter((i) => i.role === 'hatch').length).toBeGreaterThan(5);
  });
  it('draws every placement and resolves note tokens', () => {
    const placements = new Set(
      items.flatMap((i) => (i.source?.kind === 'placement' ? [i.source.placementId] : [])),
    );
    expect([...placements].sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(texts(items)).toContain('MATERIAL AlMg3');
    expect(texts(items)).toContain('100');
    expect(texts(items)).toContain('±0.1');
    expect(build.attention).toEqual([]);
  });
  it('shows the sheet scale beside the graduation', () => {
    const scale = items.find(
      (i) => i.source?.kind === 'scaleBar' && i.kind === 'text' && i.text === '1:1',
    );
    expect(scale).toBeDefined();
  });
  it('wraps and resolves sheet note text', () => {
    expect(wrapText('one two three four', 3.5, 20).length).toBeGreaterThan(1);
    expect(
      resolveTokens(
        '{title} / {nope}',
        new Map([['title', { slot: 'title', text: 'T', source: 'bound' }]]),
      ),
    ).toBe('T / {nope}');
  });
});
