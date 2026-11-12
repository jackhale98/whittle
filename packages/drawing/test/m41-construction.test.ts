/**
 * M4.1 (ADR-095): construction candidates (queries, projection, end-on skip, dedupe by priority)
 * and the used construction refs a sheet draws from resolution anchors.
 */
import type {
  Annotation,
  AnnotationAnchor,
  AnnotationResolution,
  Part,
  ViewProjection,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildDrawing,
  CONSTRUCTION_OVERRUN,
  type ConstructionCandidate,
  constructionCandidates,
  constructionItems,
  constructionNames,
  constructionQueries,
  constructionShapes,
  defaultIsConstruction,
  isConstructionName,
  projectConstruction,
  usedConstruction,
} from '../src/sheet';
import { type SolvedView, solveViews } from '../src/view';
import { boxProjection, drawing, evalLength, evaluate, PART_BOUNDS } from './fixtures';

function views() {
  const d = drawing();
  const vs = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate });
  const get = (id: string) => {
    const v = vs.get(id);
    if (!v?.ok) throw new Error(id);
    return v;
  };
  return { d, vs, front: get('V1'), top: get('V2') };
}

const axis = (direction: [number, number, number], origin: [number, number, number] = [0, 0, 0]) =>
  ({ kind: 'axis', origin, direction, extent: [0, 0] }) as AnnotationAnchor;
const point = (at: [number, number, number]) => ({ kind: 'point', at }) as AnnotationAnchor;

const PART = {
  id: 'P1',
  name: 'p',
  features: [
    {
      id: 'SK',
      type: 'sketch',
      name: 'Sketch',
      suppressed: false,
      on: { name: 'origin:XY', kind: 'face' },
      entities: [
        { id: 'a', kind: 'point', x: 0, y: 0, construction: false },
        { id: 'b', kind: 'point', x: 10, y: 0, construction: false },
        { id: 'L', kind: 'line', start: 'a', end: 'b', construction: false },
        { id: 'C', kind: 'point', x: 5, y: 5, construction: true },
        { id: 'free', kind: 'point', x: 7, y: 2, construction: false },
        { id: 'cc', kind: 'point', x: 3, y: 3, construction: false },
        { id: 'K', kind: 'circle', center: 'cc', radius: 2, construction: false },
      ],
      constraints: [],
    },
    { id: 'PL', type: 'plane', name: 'Level', suppressed: false, definition: {} },
    { id: 'GONE', type: 'plane', name: 'Off', suppressed: true, definition: {} },
    { id: 'AX', type: 'axis', name: 'Axis', suppressed: false, definition: {} },
    { id: 'PT', type: 'point', name: 'Point', suppressed: false, definition: {} },
    { id: 'RING', type: 'circularPattern', name: 'Ring', suppressed: false },
  ],
} as unknown as Part;

describe('construction queries (pure, priority order)', () => {
  it('lists the origin, then each sketch’s origin, axes and standalone points, then reference features and pitch circles', () => {
    expect(constructionQueries(PART).map((q) => `${q.name}/${q.ref.kind}`)).toEqual([
      'origin:O/vertex',
      'origin:X/edge',
      'origin:Y/edge',
      'origin:Z/edge',
      'SSK:p(@origin)/vertex',
      'SSK:e(@x)/edge',
      'SSK:e(@y)/edge',
      // The construction point and the point no curve uses; never a line end or a circle centre.
      'SSK:p(C)/vertex',
      'SSK:p(free)/vertex',
      'FPL:plane/face',
      'FAX:axis/edge',
      'FPT:point/vertex',
      'FRING:pitch/edge',
    ]);
    expect(constructionNames(PART).has('SSK:p(a)')).toBe(false);
  });

  it('names construction refs exactly; profile corners are drawn only when named standalone', () => {
    for (const n of ['origin:Y', 'S1:e(@x)', 'S1:p(@origin)', 'F2:plane', 'F2:pitch', 'S1:p(SC)'])
      expect(isConstructionName(n)).toBe(true);
    for (const n of ['origin:XY', 'F1:side(S1:e(L1))', 'edge(F1:end|F1:side)', 'S1:e(L1)'])
      expect(isConstructionName(n)).toBe(false);
    expect(defaultIsConstruction('S1:p(@origin)')).toBe(true);
    expect(defaultIsConstruction('S1:p(a)')).toBe(false);
  });

  it('keeps the answered candidates only (an unresolved ref is never drawn)', () => {
    const qs = constructionQueries(PART).slice(0, 3);
    const c = constructionCandidates(qs, [{ anchor: point([0, 0, 0]) }, { anchor: null }]);
    expect(c.map((x) => x.name)).toEqual(['origin:O']);
  });
});

describe('construction shapes on a view', () => {
  it('skips lines seen end-on and planes not seen edge-on; spans lines past the part', () => {
    const { front } = views();
    // Front: x is world X, y is world Z. The Y axis is seen end-on.
    expect(projectConstruction(front, 'origin:Y', axis([0, 1, 0]))).toBeNull();
    const x = projectConstruction(front, 'origin:X', axis([1, 0, 0]));
    expect(x?.kind).toBe('line');
    if (x?.kind !== 'line') return;
    const m = CONSTRUCTION_OVERRUN / front.scale;
    expect(Math.min(x.a[0], x.b[0])).toBeCloseTo(front.bounds.min[0] - m, 9);
    expect(Math.max(x.a[0], x.b[0])).toBeCloseTo(front.bounds.max[0] + m, 9);
    const face: AnnotationAnchor = {
      kind: 'plane',
      origin: [0, 0, 10],
      normal: [0, 1, 0],
      outline: [],
    };
    expect(projectConstruction(front, 'F1:plane', face)).toBeNull();
    const level: AnnotationAnchor = {
      kind: 'plane',
      origin: [0, 0, 10],
      normal: [0, 0, 1],
      outline: [],
    };
    const l = projectConstruction(front, 'F1:plane', level);
    expect(l?.kind === 'line' && Math.abs(l.a[1] - l.b[1])).toBeLessThan(1e-9);
    // A line that misses the part's bounds (plus the overrun) is not shown.
    expect(projectConstruction(front, 'far', axis([1, 0, 0], [0, 0, 500]))).toBeNull();
  });

  it('a pitch circle is a circle face-on and a line across side-on', () => {
    const { front, top } = views();
    const ring = {
      kind: 'circle',
      center: [50, 30, 0],
      normal: [0, 0, 1],
      radius: 20,
    } as AnnotationAnchor;
    expect(projectConstruction(top, 'F9:pitch', ring)).toMatchObject({
      kind: 'circle',
      radius: 20,
    });
    const side = projectConstruction(front, 'F9:pitch', ring);
    expect(side?.kind).toBe('line');
  });

  it('coincident candidates keep one, by priority: the origin, then history order', () => {
    const { front } = views();
    const cands: ConstructionCandidate[] = [
      // A sketch on XY listed first: its x axis and origin coincide with the origin's in this view.
      { name: 'SSK:e(@x)', anchor: axis([1, 0, 0]) },
      { name: 'SSK:p(@origin)', anchor: point([0, 0, 0]) },
      { name: 'origin:O', anchor: point([0, 0, 0]) },
      { name: 'origin:X', anchor: axis([1, 0, 0]) },
      { name: 'origin:Y', anchor: axis([0, 1, 0]) },
      // A second sketch's x axis at z = 10 is distinct; a later one at z = 10 is a duplicate.
      { name: 'SA:e(@x)', anchor: axis([1, 0, 0], [0, 0, 10]) },
      { name: 'SB:e(@x)', anchor: axis([1, 0, 0], [5, 7, 10]) },
    ];
    const names = constructionShapes(front, cands).map((s) => s.name);
    expect(names).toEqual(['origin:O', 'origin:X', 'SA:e(@x)']);
  });

  it('items are thin chain lines sourced by the exact name; a point is a small cross', () => {
    const { front } = views();
    const shapes = constructionShapes(front, [
      { name: 'origin:O', anchor: point([0, 0, 0]) },
      { name: 'origin:Z', anchor: axis([0, 0, 1]) },
    ]);
    const items = constructionItems(front, shapes);
    expect(items).toHaveLength(3);
    for (const i of items) expect(i.role).toBe('center');
    expect(items.map((i) => (i.source?.kind === 'view' ? i.source.construction : null))).toEqual([
      'origin:O',
      'origin:O',
      'origin:Z',
    ]);
  });
});

describe('used construction refs on the sheet', () => {
  const ann = (id: string, refs: string[]): Annotation =>
    ({
      id,
      kind: 'linear',
      origin: { kind: 'drawing', drawingId: 'D1' },
      refs: refs.map((name) => ({ name, kind: 'edge' })),
      direction: [0, 0, 1],
    }) as Annotation;
  const res = (
    id: string,
    anchors: (AnnotationAnchor | null)[],
    ok = true,
  ): AnnotationResolution =>
    ok
      ? { annotationId: id, state: 'ok', value: 10, anchors }
      : { annotationId: id, state: 'needsAttention', anchors };
  const edge = { kind: 'line', a: [0, 0, 40], b: [100, 0, 40] } as AnnotationAnchor;

  it('only refs a placement uses, with an anchor, once per name', () => {
    const annotations = new Map([
      ['A', ann('A', ['origin:X', 'edge(F1:a|F1:b)'])],
      ['B', ann('B', ['origin:X', 'SSK:e(@y)'])],
      ['C', ann('C', ['FPL:plane', 'edge(F1:a|F1:b)'])],
    ]);
    const resolutions = new Map([
      ['A', res('A', [axis([1, 0, 0]), edge])],
      ['B', res('B', [axis([1, 0, 0]), null], false)],
      ['C', res('C', [null, edge], false)],
    ]);
    const placements = ['A', 'B', 'C'].map((id) => ({
      id: `p${id}`,
      viewId: 'V1',
      annotationId: id,
      layout: { kind: 'lane' as const, side: 'left' as const, lane: 0 },
    }));
    expect(usedConstruction(placements, annotations, resolutions).map((c) => c.name)).toEqual([
      'origin:X',
    ]);
  });

  it('compose draws them as centre lines on their view, and nothing for an unused or unresolved ref', () => {
    const { d, vs } = views();
    const a = ann('A', ['origin:X', 'edge(F1:a|F1:b)']);
    const unresolved = ann('U', ['origin:Z', 'edge(F1:a|F1:b)']);
    const dd = {
      ...d,
      placements: [
        {
          id: 'p1',
          viewId: 'V1',
          annotationId: 'A',
          layout: { kind: 'lane', side: 'left', lane: 0 },
        },
        {
          id: 'p2',
          viewId: 'V1',
          annotationId: 'U',
          layout: { kind: 'lane', side: 'left', lane: 1 },
        },
      ],
    } as typeof d;
    const projections = new Map<string, ViewProjection>();
    for (const [id, v] of vs) if (v.ok) projections.set(id, boxProjection(v as SolvedView));
    const resolutions = new Map([
      ['A', res('A', [axis([1, 0, 0]), edge])],
      ['U', res('U', [null, edge], false)],
    ]);
    const b = buildDrawing({
      drawing: dd,
      annotations: [a, unresolved],
      configurationIds: new Set(),
      bounds: PART_BOUNDS,
      evaluate,
      evaluateAnnotation: (e) => evalLength(e),
      projections,
      resolutions: () => resolutions,
      annotationIssues: () => [],
      titleBlock: (_s, index, count) => ({
        title: 'T',
        partNumber: 'P',
        projection: 'first',
        units: 'mm',
        standard: dd.standard,
        sheet: { index, count },
      }),
    });
    const items = b.sheets[0]?.list.items ?? [];
    const drawn = items.flatMap((i) =>
      i.source?.kind === 'view' && i.source.construction ? [i.source.construction] : [],
    );
    expect(drawn).toEqual(['origin:X']);
    const line = items.find((i) => i.source?.kind === 'view' && i.source.construction);
    expect(line?.role).toBe('center');
    expect(line?.source).toMatchObject({ viewId: 'V1' });
  });
});
