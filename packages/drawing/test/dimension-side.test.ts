/**
 * Dimension text placement (ADR-094): `AnnotationPlacement.text.side` and `shift` against the
 * dimension line, and the three renderers (SVG, PDF, DXF) drawing what the layout says.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  type DimensionStyle,
  type DisplayItem,
  type DisplayList,
  dimensionLabel,
  layoutDimensionLabel,
  linearLayout,
  normalizeText,
  type Primitive,
} from '../src/annotation';
import { dxfText, renderDxf } from '../src/dxf';
import { PT_PER_MM, renderPdf } from '../src/pdf';
import { layoutPlacement, type PlacementContext } from '../src/placement';
import { stylePreset } from '../src/style';
import { renderSvg } from '../src/svg';
import { solveViews } from '../src/view';
import { ANNOTATIONS, drawing, evalLength, evaluate, PART_BOUNDS, resolutions } from './fixtures';

const iso = stylePreset('iso');
const asme = stylePreset('asme');
const h = 3.5;
const lab = (v: number) =>
  layoutDimensionLabel(dimensionLabel({ value: v, quantity: 'length', numbers: iso.numbers }), h);

type Text = Extract<Primitive, { kind: 'text' }>;
const textOf = (prims: Primitive[]) => prims.find((p): p is Text => p.kind === 'text') as Text;
const dimLines = (prims: Primitive[], y: number) =>
  prims.filter(
    (p): p is Extract<Primitive, { kind: 'line' }> =>
      p.kind === 'line' && Math.abs(p.a[1] - y) < 1e-9 && Math.abs(p.b[1] - y) < 1e-9,
  );

function linear(style: DimensionStyle, side?: 'above' | 'below' | 'inline', shift?: number) {
  return linearLayout({
    p1: [0, 0],
    p2: [50, 0],
    dir: [1, 0],
    across: 10,
    label: lab(50),
    style,
    h,
    ...(side ? { side } : {}),
    ...(shift !== undefined ? { shift } : {}),
  });
}

describe('linear dimension text side', () => {
  it('above puts the text over the line, below under it, inline in a break of the line', () => {
    const above = linear(iso.dimension, 'above');
    const below = linear(iso.dimension, 'below');
    const inline = linear(iso.dimension, 'inline');
    expect(textOf(above.prims).at[1]).toBeGreaterThan(10);
    expect(textOf(below.prims).at[1]).toBeLessThan(10);
    // Clear of the line by the same gap on either side.
    expect((above.textBox[0]?.[1] ?? 0) - 10).toBeCloseTo(0.4 * h, 6);
    expect(10 - (below.textBox[2]?.[1] ?? 0)).toBeCloseTo(0.4 * h, 6);
    // Inline: the text is centred on the line and the line is broken around it.
    const mid = ((inline.textBox[0]?.[1] ?? 0) + (inline.textBox[2]?.[1] ?? 0)) / 2;
    expect(mid).toBeCloseTo(10, 6);
    expect(dimLines(inline.prims, 10)).toHaveLength(2);
    expect(dimLines(above.prims, 10)).toHaveLength(1);
    expect(dimLines(below.prims, 10)).toHaveLength(1);
  });

  it('side overrides the standard: ASME defaults to inline, "above" lifts it clear', () => {
    const def = linear(asme.dimension);
    expect(dimLines(def.prims, 10)).toHaveLength(2);
    const above = linear(asme.dimension, 'above');
    expect(dimLines(above.prims, 10)).toHaveLength(1);
    expect(textOf(above.prims).at[1]).toBeGreaterThan(10);
    // ISO defaults to above: "inline" breaks the line.
    expect(dimLines(linear(iso.dimension).prims, 10)).toHaveLength(1);
    expect(dimLines(linear(iso.dimension, 'inline').prims, 10)).toHaveLength(2);
  });

  it('side keeps the same side of a vertical line (above = the reading direction up)', () => {
    const mk = (side: 'above' | 'below', style: DimensionStyle) =>
      linearLayout({
        p1: [0, 0],
        p2: [0, 40],
        dir: [0, 1],
        across: -12,
        label: lab(40),
        style,
        h,
        side,
      });
    // The line is at x = 12 (across is measured along -x). ISO aligned text reads from the right:
    // up is -x.
    const a = textOf(mk('above', iso.dimension).prims);
    const b = textOf(mk('below', iso.dimension).prims);
    expect(a.angle).toBe(90);
    expect(a.at[0]).toBeLessThan(12);
    expect(b.at[0]).toBeGreaterThan(12);
    // ASME's horizontal text is lifted off the line sideways, the same two sides, clear of it.
    const au = mk('above', asme.dimension);
    const bu = mk('below', asme.dimension);
    expect(textOf(au.prims).angle).toBe(0);
    const right = (g: { textBox: Vec2[] }) => Math.max(...g.textBox.map((p) => p[0]));
    const left = (g: { textBox: Vec2[] }) => Math.min(...g.textBox.map((p) => p[0]));
    expect(right(au)).toBeLessThan(12);
    expect(left(bu)).toBeGreaterThan(12);
  });

  it('text dragged past an extension line goes outside, the dimension line reaching it', () => {
    const g = linear(iso.dimension, 'above', 50);
    const t = textOf(g.prims);
    expect(t.at[0]).toBeGreaterThan(50);
    const line = dimLines(g.prims, 10)[0] as Extract<Primitive, { kind: 'line' }>;
    expect(Math.max(line.a[0], line.b[0])).toBeGreaterThanOrEqual(t.at[0]);
    // The arrow tips (the measured span) do not move with the text.
    expect(g.line).toEqual([
      [0, 10],
      [50, 10],
    ]);
  });
});

describe('placement text side through the renderers (SVG, PDF, DXF)', () => {
  const d = drawing();
  const annotations = new Map(ANNOTATIONS.map((a) => [a.id, a]));
  const v = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate }).get('V1');
  if (!v?.ok) throw new Error('view');
  const ctx: PlacementContext = {
    view: v,
    style: d.style,
    standard: d.standard.gps,
    evaluate: (e) => evalLength(e),
    annotations,
    resolutions: new Map(resolutions().map((r) => [r.annotationId, r])),
    placed: new Map(),
  };
  const place = (side?: 'above' | 'below' | 'inline') =>
    layoutPlacement(
      {
        id: 'P',
        viewId: 'V1',
        annotationId: 'A1',
        layout: { kind: 'lane', side: 'top', lane: 0 },
        ...(side ? { text: { side } } : {}),
      },
      annotations.get('A1') as never,
      ctx,
    );
  const list = (items: DisplayItem[]): DisplayList => ({ width: 420, height: 297, items });
  const textItem = (items: DisplayItem[]) =>
    items.find((i): i is Extract<DisplayItem, { kind: 'text' }> => i.kind === 'text') as Extract<
      DisplayItem,
      { kind: 'text' }
    >;

  it('the layout moves the text; the stored placement says where', () => {
    const above = textItem(place('above').items);
    const below = textItem(place('below').items);
    expect(above.at[1]).toBeGreaterThan(below.at[1]);
    // Same value either way.
    expect(above.text).toBe(below.text);
    // Nothing stored = the standard's default (ISO: above).
    expect(textItem(place().items).at).toEqual(above.at);
  });

  it('SVG carries each text at its own position', () => {
    const y = (side: 'above' | 'below') => {
      const t = textItem(place(side).items);
      const svg = renderSvg(list(place(side).items), d.style);
      const re = new RegExp(
        `translate\\(${t.at[0].toFixed(3).replace(/\\.?0+$/, '')} ([-\\d.]+)\\)`,
      );
      const m = re.exec(svg);
      expect(m, `text transform of ${side}`).not.toBeNull();
      return Number(m?.[1]);
    };
    expect(y('above')).toBeGreaterThan(y('below'));
  });

  it('DXF places the TEXT entity at the laid out position', () => {
    const dxfY = (side: 'above' | 'below') => {
      const items = place(side).items;
      const text = renderDxf(list(items), d.style, { profile: 'r2000' });
      const t = textItem(items);
      const lines = text.split(/\r?\n/);
      // Tags come in (code, value) pairs: the TEXT entity's insertion y is its group 20.
      const want = dxfText(normalizeText(t.text));
      for (let i = 0; i + 1 < lines.length; i += 2) {
        if (lines[i]?.trim() !== '100' || lines[i + 1]?.trim() !== 'AcDbText') continue;
        const tags = new Map<string, string>();
        for (let j = i + 2; j + 1 < lines.length && lines[j]?.trim() !== '100'; j += 2)
          tags.set((lines[j] as string).trim(), (lines[j + 1] as string).trim());
        if (tags.get('1') === want) return Number(tags.get('20'));
      }
      throw new Error('no TEXT entity');
    };
    expect(dxfY('above')).toBeGreaterThan(dxfY('below'));
    expect(dxfY('above')).toBeCloseTo(textItem(place('above').items).at[1], 3);
  });

  it('PDF puts the text at its position in points', () => {
    const font = new Uint8Array(
      readFileSync(join(__dirname, '../assets/fonts/osifont-lgpl3fe.ttf')),
    );
    const yPt = (side: 'above' | 'below') => {
      const items = place(side).items;
      const bytes = renderPdf([{ list: list(items), style: { lineGroup: 'iso-0.5' } }], {
        font,
        compress: false,
      });
      const text = Array.from(bytes, (c) => String.fromCharCode(c)).join('');
      const m = /([-\d.]+) ([-\d.]+) Tm </.exec(text);
      expect(m).not.toBeNull();
      return Number(m?.[2]) / PT_PER_MM;
    };
    expect(yPt('above')).toBeGreaterThan(yPt('below'));
    expect(yPt('above')).toBeCloseTo(textItem(place('above').items).at[1], 1);
  });
});
