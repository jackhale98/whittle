/**
 * Goldens for the leader forms of datums and frames (ADR-094): on a surface (on its line and on
 * an extension of it), on a feature of size (in line with a size dimension's line, or with its
 * text), and their DXF and PDF output.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Annotation,
  AnnotationPlacement,
  AnnotationResolution,
  Vec2,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { DisplayItem, DisplayList } from '../src/annotation';
import { symbolGlyph } from '../src/annotation/symbols';
import { renderDxf } from '../src/dxf';
import { renderPdf } from '../src/pdf';
import {
  datumTriangleFilled,
  datumTriangleSize,
  dimensionLineEnd,
  edgeFaceNames,
  faceAlongLine,
  layoutView,
  lineParameter,
  outwardOffset,
  type PlacedAnnotation,
  type PlacementContext,
} from '../src/placement';
import { type SolvedView, solveViews } from '../src/view';
import { ANNOTATIONS, drawing, evalLength, evaluate, PART_BOUNDS, resolutions } from './fixtures';

const FONT = new Uint8Array(readFileSync(join(__dirname, '../assets/fonts/osifont-lgpl3fe.ttf')));

/** A frame on the bottom face (zmin), and one bound to the width dimension A1. */
const EXTRA: Annotation[] = [
  {
    id: 'G1',
    kind: 'geometricTolerance',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'F1:face.zmin', kind: 'face' }],
    characteristic: 'flatness',
    zone: { value: '0.1 mm' },
  },
  {
    id: 'G2',
    kind: 'geometricTolerance',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [],
    appliesTo: 'A1',
    characteristic: 'position',
    zone: { value: '0.2 mm' },
    datums: [{ datums: [{ datum: 'A4' }] }],
  },
  {
    id: 'D2',
    kind: 'datumFeature',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'F2:bore', kind: 'face' }],
    at: ['axis'],
    label: 'B',
  },
  {
    // A datum on the width A1's feature of size: its median plane (appliesTo, ADR-094).
    id: 'D3',
    kind: 'datumFeature',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [],
    label: 'C',
    appliesTo: 'A1',
  },
];
const annotations = new Map([...ANNOTATIONS, ...EXTRA].map((a) => [a.id, a]));

function view(id: string): SolvedView {
  const v = solveViews({ drawing: drawing(), bounds: PART_BOUNDS, evaluate }).get(id);
  if (!v?.ok) throw new Error(`view ${id}`);
  return v;
}

function ctx(v: SolvedView): Omit<PlacementContext, 'placed'> {
  const d = drawing();
  const res = resolutions();
  const g1 = res.find((r) => r.annotationId === 'A4') as AnnotationResolution;
  const extra: AnnotationResolution[] = [
    { ...g1, annotationId: 'G1' },
    { annotationId: 'G2', state: 'ok', anchors: [] },
    { annotationId: 'D2', state: 'ok', anchors: [] },
    { annotationId: 'D3', state: 'ok' },
  ];
  return {
    view: v,
    style: d.style,
    standard: d.standard.gps,
    evaluate: (e) => evalLength(e),
    annotations,
    resolutions: new Map([...res, ...extra].map((r) => [r.annotationId, r])),
  };
}

const P = (
  id: string,
  viewId: string,
  annotationId: string,
  layout: AnnotationPlacement['layout'],
): AnnotationPlacement => ({ id, viewId, annotationId, layout });

const fills = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'fill' }> => i.kind === 'fill');
const lines = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'line' }> => i.kind === 'line');
const polylines = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'polyline' }> => i.kind === 'polyline');
const texts = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'text' }> => i.kind === 'text');

const close = (a: Vec2, b: Vec2, eps = 1e-6) =>
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(eps);

/** The datum triangle's three corners: two on the base, then the apex. */
function triangle(p: PlacedAnnotation): Vec2[] {
  const f = fills(p.items)[0];
  if (!f) throw new Error('no triangle');
  return f.loops[0] as Vec2[];
}

const front = view('V1');
const top = view('V2');
const h = drawing().style.text.dimension;
const tri = datumTriangleSize(h);
// The front view shows the 100 × 40 box face-on: the bottom face is the line y = 170.
const BOTTOM = 190 - 20;

function one(v: SolvedView, placements: AnnotationPlacement[], id: string): PlacedAnnotation {
  const out = layoutView(placements, ctx(v));
  const p = out.find((x) => x.placementId === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
}

describe('datum on a surface (ISO 5459, ASME Y14.5 §6.3)', () => {
  it('golden: the triangle’s base sits on the surface line, the leader leaves across it', () => {
    const p = one(
      front,
      [
        P('t', 'V1', 'A4', {
          kind: 'leader',
          attach: { kind: 'ref', index: 0, t: 0.25 },
          text: [0, -15],
        }),
      ],
      't',
    );
    expect(p.attention).toBe(false);
    const [b0, b1, apex] = triangle(p) as [Vec2, Vec2, Vec2];
    // Base on the line, centred a quarter of the way along it (140 → 240), apex out of the part.
    expect(b0[1]).toBeCloseTo(BOTTOM, 9);
    expect(b1[1]).toBeCloseTo(BOTTOM, 9);
    expect((b0[0] + b1[0]) / 2).toBeCloseTo(165, 9);
    expect(Math.abs(b1[0] - b0[0])).toBeCloseTo(tri.base, 9);
    close(apex, [165, BOTTOM - tri.height]);
    // The leader runs from the apex to the letter box, straight down.
    const leader = polylines(p.items).find((x) => !x.closed);
    expect(leader?.points[0]).toEqual(apex);
    close(leader?.points.at(-1) as Vec2, [165, BOTTOM - 15]);
    expect(texts(p.items).map((x) => x.text)).toEqual(['A']);
    // Its letter box is under the leader's end.
    expect(Math.max(...p.textBox.map((q) => q[1]))).toBeCloseTo(BOTTOM - 15, 6);
    // Handles: the attach point and the line it is held on.
    expect(p.leader?.attach).toBe('ref');
    close(p.leader?.at as Vec2, [165, BOTTOM]);
    expect(p.leader?.on?.map((q) => q[1])).toEqual([BOTTOM, BOTTOM]);
  });

  it('golden: on an extension of the surface line, with a thin extension line out to it', () => {
    const p = one(
      front,
      [
        P('t', 'V1', 'A4', {
          kind: 'leader',
          attach: { kind: 'ref', index: 0, t: 1.2 },
          text: [0, -12],
        }),
      ],
      't',
    );
    const [b0, b1] = triangle(p) as [Vec2, Vec2];
    // 20 % of 100 mm past the right end (x = 240): centred at x = 260.
    expect((b0[0] + b1[0]) / 2).toBeCloseTo(260, 9);
    expect(b0[1]).toBeCloseTo(BOTTOM, 9);
    const ext = lines(p.items).find((l) => Math.abs(l.a[1] - BOTTOM) < 1e-9);
    const style = drawing().style.dimension;
    expect(ext?.a[0]).toBeCloseTo(240 + style.extensionGap, 9);
    expect(ext?.b[0]).toBeCloseTo(260 + tri.base / 2 + style.extensionOvershoot, 9);
  });

  it('golden: the triangle turns to whichever side the leader leaves on', () => {
    const p = one(
      front,
      [P('t', 'V1', 'A4', { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [8, 15] })],
      't',
    );
    const apex = triangle(p)[2] as Vec2;
    // Text above the line: the apex points up (into the view here), across the line, never along
    // the leader.
    close(apex, [190, BOTTOM + tri.height]);
  });

  it('the triangle is filled for every supported standard; the open glyph is a closed outline', () => {
    expect(datumTriangleFilled('ISO 1101:2017')).toBe(true);
    expect(datumTriangleFilled('ASME Y14.5-2018')).toBe(true);
    expect(datumTriangleFilled('ASME Y14.5-2009')).toBe(true);
    const open = symbolGlyph('datumTriangleOpen').prims[0];
    expect(open?.kind === 'polyline' && open.closed).toBe(true);
  });
});

describe('datum on a feature of size (in line with the dimension line)', () => {
  it('golden: at the end of a lane dimension’s line, pointing out of it', () => {
    const dim = P('w', 'V1', 'A1', { kind: 'lane', side: 'bottom', lane: 0 });
    const datum = P('t', 'V1', 'A4', {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'w', t: 1 },
      text: [10, 0],
    });
    const out = layoutView([datum, dim], ctx(front));
    const w = out.find((x) => x.placementId === 'w') as PlacedAnnotation;
    const t = out.find((x) => x.placementId === 't') as PlacedAnnotation;
    const line = w.line as [Vec2, Vec2];
    const end = line[0][0] > line[1][0] ? line[0] : line[1];
    const [b0, b1, apex] = triangle(t) as [Vec2, Vec2, Vec2];
    // The base lies on the extension line (vertical), centred on the dimension line's end.
    expect(b0[0]).toBeCloseTo(end[0], 9);
    expect(b1[0]).toBeCloseTo(end[0], 9);
    expect((b0[1] + b1[1]) / 2).toBeCloseTo(end[1], 9);
    // In line with the dimension line, pointing away from it.
    close(apex, [end[0] + tri.height, end[1]]);
    expect(t.leader?.attach).toBe('dimensionLine');
    expect(t.attention).toBe(false);
  });

  it('golden: a datum bound to a width (appliesTo, no refs) sits in line with its line at t = 0', () => {
    const dim = P('w', 'V1', 'A1', { kind: 'lane', side: 'bottom', lane: 0 });
    const datum = P('t', 'V1', 'D3', {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'w', t: 0 },
      text: [-10, 0],
    });
    const out = layoutView([datum, dim], ctx(front));
    const w = out.find((x) => x.placementId === 'w') as PlacedAnnotation;
    const t = out.find((x) => x.placementId === 't') as PlacedAnnotation;
    const [L0, L1] = w.line as [Vec2, Vec2];
    const [b0, b1, apex] = triangle(t) as [Vec2, Vec2, Vec2];
    expect((b0[0] + b1[0]) / 2).toBeCloseTo(L0[0], 9);
    expect((b0[1] + b1[1]) / 2).toBeCloseTo(L0[1], 9);
    const u: Vec2 = [L0[0] - L1[0], L0[1] - L1[1]];
    const l = Math.hypot(...u);
    close(apex, [L0[0] + (u[0] / l) * tri.height, L0[1] + (u[1] / l) * tri.height]);
    expect(texts(t.items).map((x) => x.text)).toEqual(['C']);
    expect(t.attention).toBe(false);
    // On its own ref attach (no dimension placed) it falls back to the dimension's geometry.
    const alone = layoutView(
      [P('t', 'V1', 'D3', { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [0, -10] })],
      ctx(front),
    )[0] as PlacedAnnotation;
    expect(alone.issues).toEqual([]);
    expect(fills(alone.items)).toHaveLength(1);
  });

  it('golden: far out on the extension (t = −0.5) and back at the end (t = 0)', () => {
    const at = (t: number) =>
      one(
        front,
        [
          P('t', 'V1', 'A4', {
            kind: 'leader',
            attach: { kind: 'ref', index: 0, t },
            text: [0, -12],
          }),
        ],
        't',
      );
    const far = at(-0.5);
    const [b0, b1] = triangle(far) as [Vec2, Vec2];
    expect((b0[0] + b1[0]) / 2).toBeCloseTo(90, 9);
    const style = drawing().style.dimension;
    const ext = lines(far.items).find((l) => Math.abs(l.a[1] - BOTTOM) < 1e-9);
    expect(ext?.a[0]).toBeCloseTo(140 - style.extensionGap, 9);
    expect(ext?.b[0]).toBeCloseTo(90 - tri.base / 2 - style.extensionOvershoot, 9);
    // At an end it is on the edge: no extension line.
    const end = at(0);
    expect(lines(end.items).filter((l) => Math.abs(l.a[1] - BOTTOM) < 1e-9)).toHaveLength(0);
  });

  it('golden: at the far end of a radial diameter (t = 0), along the diameter line', () => {
    const dim = P('d', 'V2', 'A3', { kind: 'radial', angle: 30, distance: 8 });
    const datum = P('t', 'V2', 'D2', {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'd', t: 0 },
      text: [-8, -5],
    });
    const out = layoutView([datum, dim], ctx(top));
    const d = out.find((x) => x.placementId === 'd') as PlacedAnnotation;
    const t = out.find((x) => x.placementId === 't') as PlacedAnnotation;
    const [L0, L1] = d.line as [Vec2, Vec2];
    const u: Vec2 = [L0[0] - L1[0], L0[1] - L1[1]];
    const l = Math.hypot(...u);
    const apex = triangle(t)[2] as Vec2;
    close(apex, [L0[0] + (u[0] / l) * tri.height, L0[1] + (u[1] / l) * tri.height]);
    expect(texts(t.items).map((x) => x.text)).toEqual(['B']);
  });

  it('flags a dimension-line attach to something without a dimension line', () => {
    const note = P('f', 'V1', 'G1', {
      kind: 'leader',
      attach: { kind: 'ref', index: 0 },
      text: [5, -5],
    });
    const datum = P('t', 'V1', 'A4', {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'f', t: 0 },
      text: [10, 0],
    });
    const t = layoutView([datum, note], ctx(front)).find((x) => x.placementId === 't');
    expect(t?.issues).toContainEqual({ kind: 'attachTargetMissing', placementId: 'f' });
    expect(t?.attention).toBe(true);
  });
});

describe('tolerance frames: the same two forms', () => {
  it('golden: on a surface, a leader with an arrow to the surface line (and its extension)', () => {
    const p = one(
      front,
      [
        P('f', 'V1', 'G1', {
          kind: 'leader',
          attach: { kind: 'ref', index: 0, t: -0.1 },
          text: [-10, -12],
        }),
      ],
      'f',
    );
    const arrow = fills(p.items)[0];
    // The arrow's tip is on the extension of the bottom line, 10 mm left of x = 140.
    expect(
      arrow?.loops[0]?.some((q) => Math.abs(q[0] - 130) < 1e-9 && Math.abs(q[1] - BOTTOM) < 1e-9),
    ).toBe(true);
    const ext = lines(p.items).find(
      (l) => Math.abs(l.a[1] - BOTTOM) < 1e-9 && Math.abs(l.b[1] - BOTTOM) < 1e-9,
    );
    expect(ext?.a[0]).toBeCloseTo(140 - drawing().style.dimension.extensionGap, 9);
    expect(texts(p.items).some((x) => x.text.includes('0.1'))).toBe(true);
  });

  it('golden: on a feature of size, under the size dimension’s text, or beside it', () => {
    const dim = P('w', 'V1', 'A1', { kind: 'lane', side: 'bottom', lane: 0 });
    const under = P('f', 'V1', 'G2', {
      kind: 'leader',
      attach: { kind: 'placement', placementId: 'w' },
      text: [0, 0],
    });
    const out = layoutView([under, dim], ctx(front));
    const w = out.find((x) => x.placementId === 'w') as PlacedAnnotation;
    const f = out.find((x) => x.placementId === 'f') as PlacedAnnotation;
    const wMinY = Math.min(...w.textBox.map((q) => q[1]));
    const wMinX = Math.min(...w.textBox.map((q) => q[0]));
    // Under: its top 0.5 h below the dimension text, left-aligned with it; no leader.
    expect(Math.max(...f.textBox.map((q) => q[1]))).toBeCloseTo(wMinY - 0.5 * h, 6);
    expect(Math.min(...f.textBox.map((q) => q[0]))).toBeCloseTo(wMinX, 6);
    expect(polylines(f.items).filter((x) => !x.closed)).toHaveLength(0);
    expect(f.leader?.attach).toBe('placement');
    // Beside: the same frame moved right of the text by its offset.
    const wMaxX = Math.max(...w.textBox.map((q) => q[0]));
    const beside = layoutView(
      [
        {
          ...under,
          layout: {
            ...(under.layout as Extract<AnnotationPlacement['layout'], { kind: 'leader' }>),
            text: [wMaxX - wMinX + 2, 0.5 * h + 4],
          },
        },
        dim,
      ],
      ctx(front),
    ).find((x) => x.placementId === 'f') as PlacedAnnotation;
    expect(Math.min(...beside.textBox.map((q) => q[0]))).toBeCloseTo(wMaxX + 2, 6);
  });
});

describe('helpers', () => {
  it('reads an edge name’s faces from the naming rules, never more', () => {
    expect(edgeFaceNames('edge(F1:end|F1:side(S1:e(l2)))')).toEqual([
      'F1:end',
      'F1:side(S1:e(l2))',
    ]);
    expect(edgeFaceNames('edge(F1:end|F2:hole(p1):wall)#1')).toEqual([
      'F1:end',
      'F2:hole(p1):wall',
    ]);
    expect(edgeFaceNames('F0:edge(face.side|face.zmax)')).toEqual(['F0:face.side', 'F0:face.zmax']);
    expect(edgeFaceNames('edge(A|A)')).toEqual(['A']);
    expect(edgeFaceNames('edge(A)')).toEqual(['A']);
    expect(edgeFaceNames('F3:fillet(edge(A|B))')).toEqual([]);
    expect(edgeFaceNames('edge(A|B)x')).toEqual([]);
  });

  it('a pick maps to the face seen edge-on along it; t and the dimension end', () => {
    const res = resolutions().find((r) => r.annotationId === 'A4');
    const plane = res?.anchors?.[0];
    if (!plane) throw new Error('no plane');
    expect(
      faceAlongLine(front, plane, [
        [150, BOTTOM],
        [200, BOTTOM],
      ]),
    ).toBe(true);
    expect(
      faceAlongLine(front, plane, [
        [150, BOTTOM + 1],
        [200, BOTTOM + 1],
      ]),
    ).toBe(false);
    // The top view sees the bottom face face-on: not along any line.
    expect(
      faceAlongLine(top, plane, [
        [150, 100],
        [200, 100],
      ]),
    ).toBe(false);
    expect(outwardOffset(front, plane, 10)).toEqual([0, -10]);
    expect(
      lineParameter(
        [
          [0, 0],
          [10, 0],
        ],
        [12, 3],
      ),
    ).toBeCloseTo(1.2, 12);
    expect(dimensionLineEnd(0.3)).toBe(0);
    expect(dimensionLineEnd(0.7)).toBe(1);
  });
});

describe('output: DXF and PDF draw the triangle and every leader form', () => {
  const placements = [
    P('w', 'V1', 'A1', { kind: 'lane', side: 'bottom', lane: 0 }),
    P('s', 'V1', 'A4', {
      kind: 'leader',
      attach: { kind: 'ref', index: 0, t: 1.2 },
      text: [0, -12],
    }),
    P('g', 'V1', 'G1', {
      kind: 'leader',
      attach: { kind: 'ref', index: 0, t: 0.3 },
      text: [-10, -14],
    }),
    P('t', 'V1', 'D2', {
      kind: 'leader',
      attach: { kind: 'dimensionLine', placementId: 'w', t: 0 },
      text: [-10, 0],
    }),
    P('f', 'V1', 'G2', {
      kind: 'leader',
      attach: { kind: 'placement', placementId: 'w' },
      text: [0, 0],
    }),
  ];
  const out = layoutView(placements, ctx(front));
  const list: DisplayList = { width: 420, height: 297, items: out.flatMap((p) => p.items) };
  const surface = out.find((p) => p.placementId === 's') as PlacedAnnotation;
  const tri0 = triangle(surface);

  /** Entities as tag lists (code, value), from a DXF's ENTITIES section. */
  const entities = (dxf: string): [number, string][][] => {
    const rows = dxf.split(/\r?\n/);
    const pairs: [number, string][] = [];
    for (let i = 0; i + 1 < rows.length; i += 2)
      pairs.push([Number(rows[i]?.trim()), (rows[i + 1] ?? '').trim()]);
    const start = pairs.findIndex(
      ([c, v], i) => c === 2 && v === 'ENTITIES' && pairs[i - 1]?.[1] === 'SECTION',
    );
    const out: [number, string][][] = [];
    for (const pr of pairs.slice(start + 1)) {
      if (pr[0] === 0 && pr[1] === 'ENDSEC') break;
      if (pr[0] === 0) out.push([pr]);
      else out.at(-1)?.push(pr);
    }
    return out;
  };
  const num = (e: [number, string][], code: number) => Number(e.find(([c]) => c === code)?.[1]);
  const near = (e: [number, string][], code: number, q: Vec2) =>
    Math.hypot(num(e, code) - q[0], num(e, code + 10) - q[1]) < 1e-3;

  it('R2000: the filled triangle is SOLID, the leaders are polylines and lines', () => {
    const ents = entities(renderDxf(list, { lineGroup: 'iso-0.5' }, { profile: 'r2000' }));
    const solids = ents.filter((e) => e[0]?.[1] === 'SOLID');
    // The surface datum's triangle, exactly.
    expect(solids.some((e) => [10, 11, 12].every((c, k) => near(e, c, tri0[k] as Vec2)))).toBe(
      true,
    );
    // Two datum triangles and the frame's arrowhead, at least.
    expect(solids.length).toBeGreaterThanOrEqual(3);
    expect(ents.some((e) => e[0]?.[1] === 'LWPOLYLINE')).toBe(true);
    const words = ents
      .filter((e) => e[0]?.[1] === 'TEXT')
      .map((e) => e.find(([c]) => c === 1)?.[1]);
    expect(words).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('R12: fills are closed polylines (CNC-safe profile, ADR-091)', () => {
    const dxf = renderDxf(list, { lineGroup: 'iso-0.5' }, { profile: 'r12' });
    expect(dxf).toContain('AC1009');
    const ents = entities(dxf);
    const closed = ents.filter((e) => e[0]?.[1] === 'POLYLINE' && num(e, 70) === 1);
    expect(closed.length).toBeGreaterThanOrEqual(3);
    // The triangle's corners are its vertices, in order.
    const i = ents.findIndex(
      (e, k) =>
        e[0]?.[1] === 'POLYLINE' &&
        num(e, 70) === 1 &&
        near(ents[k + 1] ?? [], 10, tri0[0] as Vec2),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ents.slice(i + 1, i + 4).every((e) => e[0]?.[1] === 'VERTEX')).toBe(true);
  });

  it('PDF: the triangle is a filled path and the leaders are stroked, one page', () => {
    const bytes = renderPdf([{ list, style: { lineGroup: 'iso-0.5' } }], {
      font: FONT,
      compress: false,
    });
    const text = Array.from(bytes, (c) => String.fromCharCode(c)).join('');
    const pt = (x: number) => String(Math.round(x * (72 / 25.4) * 1000) / 1000);
    const [b0] = tri0 as [Vec2];
    expect(text).toContain(`${pt(b0[0])} ${pt(b0[1])} m`);
    expect((text.match(/ h f\*/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('/Count 1');
  });

  it('PDF: every sheet is one page', () => {
    const bytes = renderPdf(
      [1, 2, 3].map(() => ({ list, style: { lineGroup: 'iso-0.5' as const } })),
      { font: FONT, compress: false },
    );
    const text = Array.from(bytes, (c) => String.fromCharCode(c)).join('');
    expect(text).toContain('/Count 3');
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
  });
});
