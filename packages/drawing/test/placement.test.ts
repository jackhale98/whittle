import type {
  Annotation,
  AnnotationPlacement,
  AnnotationResolution,
  Drawing,
  Vec2,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '../src/annotation';
import { layoutPlacement, layoutView, type PlacementContext } from '../src/placement';
import { type SolvedView, solveViews, viewOutline } from '../src/view';
import { ANNOTATIONS, drawing, evalLength, evaluate, PART_BOUNDS, resolutions } from './fixtures';

const annotations = new Map(ANNOTATIONS.map((a) => [a.id, a]));

function view(id: string, d: Drawing = drawing(), k = 1): SolvedView {
  const bounds = {
    min: PART_BOUNDS.min,
    max: PART_BOUNDS.max.map((x) => x * k) as typeof PART_BOUNDS.max,
  };
  const v = solveViews({ drawing: d, bounds, evaluate }).get(id);
  if (!v?.ok) throw new Error(`view ${id}`);
  return v;
}

function ctx(
  v: SolvedView,
  k = 1,
  res: AnnotationResolution[] = resolutions(k),
  d = drawing(),
): PlacementContext {
  return {
    view: v,
    style: d.style,
    standard: d.standard.gps,
    evaluate: (e) => evalLength(e),
    annotations,
    resolutions: new Map(res.map((r) => [r.annotationId, r])),
    placed: new Map(),
    features: {
      hole: () => ({ count: 1, kind: 'simple', diameter: 20, depth: 'thru' }),
    },
  };
}

const P = (
  id: string,
  viewId: string,
  annotationId: string,
  layout: AnnotationPlacement['layout'],
): AnnotationPlacement => ({
  id,
  viewId,
  annotationId,
  layout,
});

const lines = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'line' }> => i.kind === 'line');
const texts = (items: DisplayItem[]) =>
  items
    .filter((i): i is Extract<DisplayItem, { kind: 'text' }> => i.kind === 'text')
    .map((t) => t.text);

/** Extension lines of a horizontal dimension: vertical lines; their ends tell gap and overshoot. */
function extensions(items: DisplayItem[]) {
  return lines(items).filter((l) => Math.abs(l.a[0] - l.b[0]) < 1e-9);
}
function horizontalDimLine(items: DisplayItem[]): number {
  const l = lines(items).find(
    (x) => Math.abs(x.a[1] - x.b[1]) < 1e-9 && Math.abs(x.a[0] - x.b[0]) > 1,
  );
  return l?.a[1] ?? Number.NaN;
}

describe('golden: lanes and offsets survive a 10 % resize (feature 2, T8)', () => {
  const placements = [
    P('L1', 'V1', 'A1', { kind: 'lane', side: 'top', lane: 0 }),
    P('L2', 'V1', 'A2', { kind: 'lane', side: 'right', lane: 1 }),
    P('O1', 'V1', 'A1', { kind: 'offset', distance: -15 }),
  ];
  for (const k of [1, 1.1]) {
    it(`k = ${k}: lane distances, offsets, gap and overshoot are unchanged sheet mm`, () => {
      const v = view('V1', drawing(), k);
      const out = place(v, k);
      const o = viewOutline(v);
      const style = drawing().style.dimension;
      // Lane 0 on top: firstLane above the outline.
      const top = out.get('L1')!;
      expect(horizontalDimLine(top.items) - o.max[1]).toBeCloseTo(style.firstLane, 9);
      for (const e of extensions(top.items)) {
        expect(Math.min(e.a[1], e.b[1]) - o.max[1]).toBeCloseTo(style.extensionGap, 9);
        expect(Math.max(e.a[1], e.b[1]) - horizontalDimLine(top.items)).toBeCloseTo(
          style.extensionOvershoot,
          9,
        );
      }
      expect(texts(top.items)[0]).toBe(k === 1 ? '100' : '110');
      // Lane 1 on the right: firstLane + laneSpacing beyond the outline.
      const right = out.get('L2')!;
      const vert = lines(right.items).find(
        (l) => Math.abs(l.a[0] - l.b[0]) < 1e-9 && Math.abs(l.a[1] - l.b[1]) > 1,
      )!;
      expect(vert.a[0] - o.max[0]).toBeCloseTo(style.firstLane + style.laneSpacing, 9);
      // Offset −15: 15 mm below the geometry.
      const off = out.get('O1')!;
      expect(o.min[1] - horizontalDimLine(off.items)).toBeCloseTo(15, 9);
    });
  }
  it('a 1:20 view has the same 1.5 mm overshoot and 1 mm gap as a 1:1 view', () => {
    const d = drawing();
    d.sheets[0]!.scale = '1/20';
    const v = view('V1', d);
    const out = layoutPlacement(
      placements[0]!,
      annotations.get('A1')!,
      ctx(v, 1, resolutions(), d),
    );
    const o = viewOutline(v);
    const dimY = horizontalDimLine(out.items);
    expect(dimY - o.max[1]).toBeCloseTo(10, 9);
    for (const e of extensions(out.items)) {
      expect(Math.min(e.a[1], e.b[1]) - o.max[1]).toBeCloseTo(1, 9);
      expect(Math.max(e.a[1], e.b[1]) - dimY).toBeCloseTo(1.5, 9);
    }
  });

  function place(v: SolvedView, k: number) {
    const r = layoutView(placements, ctx(v, k));
    return new Map(r.map((p) => [p.placementId, p]));
  }
});

describe('placement layouts', () => {
  it('draws the tolerance and never a stale value (T1)', () => {
    const v = view('V1');
    const ok = layoutPlacement(
      P('p', 'V1', 'A1', { kind: 'lane', side: 'top', lane: 0 }),
      annotations.get('A1')!,
      ctx(v),
    );
    expect(texts(ok.items)).toEqual(['100', '±0.1']);
    expect(ok.attention).toBe(false);
    const res = resolutions().map((r) =>
      r.annotationId === 'A1'
        ? {
            ...r,
            state: 'needsAttention' as const,
            value: undefined,
            unresolved: [
              {
                path: '/refs/1',
                ref: { name: 'F1:face.xmax', kind: 'face' as const },
                reason: 'missing' as const,
              },
            ],
          }
        : r,
    ) as AnnotationResolution[];
    const bad = layoutPlacement(
      P('p', 'V1', 'A1', { kind: 'lane', side: 'top', lane: 0 }),
      annotations.get('A1')!,
      ctx(v, 1, res),
    );
    expect(bad.attention).toBe(true);
    expect(texts(bad.items)[0]).toBe('?');
    expect(bad.items.every((i) => i.attention)).toBe(true);
  });
  it('draws a ? marker when no anchors resolved, at the lane', () => {
    const v = view('V1');
    const res = resolutions().map((r) =>
      r.annotationId === 'A1'
        ? { annotationId: 'A1', state: 'needsAttention' as const, anchors: [null, null] }
        : r,
    );
    const out = layoutPlacement(
      P('p', 'V1', 'A1', { kind: 'lane', side: 'top', lane: 0 }),
      annotations.get('A1')!,
      ctx(v, 1, res),
    );
    expect(out.issues).toContainEqual({ kind: 'anchorsMissing' });
    expect(texts(out.items)).toEqual(['?']);
    const marker = out.items.find((i) => i.kind === 'text') as Extract<
      DisplayItem,
      { kind: 'text' }
    >;
    expect(marker.at[1]).toBeCloseTo(viewOutline(v).max[1] + 10);
  });
  it('hides suppressed annotations ("not in this configuration")', () => {
    const v = view('V1');
    const res = resolutions().map((r) =>
      r.annotationId === 'A1' ? { annotationId: 'A1', state: 'suppressed' as const } : r,
    );
    const out = layoutPlacement(
      P('p', 'V1', 'A1', { kind: 'lane', side: 'top', lane: 0 }),
      annotations.get('A1')!,
      ctx(v, 1, res),
    );
    expect(out.suppressed).toBe(true);
    expect(out.items).toHaveLength(0);
  });
  it('flags a direction seen end-on and a layout that does not fit, never re-laying out', () => {
    const right = view('V3');
    const endOn = layoutPlacement(
      P('p', 'V3', 'A1', { kind: 'offset', distance: 10 }),
      annotations.get('A1')!,
      ctx(right),
    );
    expect(endOn.issues).toContainEqual({ kind: 'notMeasurableInView', viewId: 'V3' });
    const v = view('V1');
    const wrong = layoutPlacement(
      P('p', 'V1', 'A1', { kind: 'radial', angle: 0, distance: 5 }),
      annotations.get('A1')!,
      ctx(v),
    );
    expect(wrong.issues[0]).toMatchObject({ kind: 'layoutDoesNotFit' });
    const lane = layoutPlacement(
      P('p', 'V1', 'A2', { kind: 'lane', side: 'top', lane: 0 }),
      annotations.get('A2')!,
      ctx(v),
    );
    expect(lane.issues[0]).toMatchObject({ kind: 'layoutDoesNotFit', layout: 'lane' });
  });
  it('radial diameter on the face-on circle (top view), linear across it side-on (front view)', () => {
    const top = view('V2');
    const r = layoutPlacement(
      P('p', 'V2', 'A3', { kind: 'radial', angle: 30, distance: 8 }),
      annotations.get('A3')!,
      ctx(top),
    );
    expect(texts(r.items)).toEqual(['Ø20', 'H7']);
    expect(r.items.filter((i) => i.kind === 'fill')).toHaveLength(2);
    const front = view('V1');
    const side = layoutPlacement(
      P('p', 'V1', 'A3', { kind: 'offset', distance: 12 }),
      annotations.get('A3')!,
      ctx(front),
    );
    expect(side.issues).toEqual([]);
    expect(side.line && Math.abs(side.line[1][0] - side.line[0][0])).toBeCloseTo(20);
    const notFaceOn = layoutPlacement(
      P('p', 'V1', 'A3', { kind: 'radial', angle: 0, distance: 5 }),
      annotations.get('A3')!,
      ctx(front),
    );
    expect(notFaceOn.issues).toContainEqual({ kind: 'notMeasurableInView', viewId: 'V1' });
  });
  it('lays out frames, datums and notes on leaders; a frame can sit under a size dimension', () => {
    const top = view('V2');
    const c = ctx(top);
    const dia = P('d', 'V2', 'A3', { kind: 'radial', angle: 30, distance: 8 });
    const frame = P('f', 'V2', 'A5', {
      kind: 'leader',
      attach: { kind: 'placement', placementId: 'd' },
      text: [0, 0],
    });
    const datum = P('t', 'V2', 'A4', {
      kind: 'leader',
      attach: { kind: 'ref', index: 0 },
      text: [0, -15],
    });
    const out = layoutView([frame, dia, datum], c);
    const byId = new Map(out.map((p) => [p.placementId, p]));
    const f = byId.get('f')!;
    expect(texts(f.items)).toEqual(['Ø0.05', 'A']);
    expect(f.attention).toBe(false);
    // Directly under the diameter's text.
    const dBox = byId.get('d')!.textBox;
    expect(Math.max(...f.textBox.map((p) => p[1]))).toBeLessThan(
      Math.min(...dBox.map((p) => p[1])),
    );
    const t = byId.get('t')!;
    expect(texts(t.items)).toEqual(['A']);
    expect(t.items.some((i) => i.kind === 'fill')).toBe(true);
  });
  it('shows ? in a frame whose datum is gone', () => {
    const top = view('V2');
    const c = ctx(top);
    const anns = new Map(annotations);
    anns.delete('A4');
    const f = layoutPlacement(
      P('f', 'V2', 'A5', { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [20, 20] }),
      annotations.get('A5')!,
      { ...c, annotations: anns },
    );
    expect(f.attention).toBe(true);
    expect(texts(f.items)).toContain('?');
  });
  it('lays out angles on an arc and ordinates on lanes', () => {
    const v = view('V1');
    const angle: Annotation = {
      id: 'X1',
      kind: 'angle',
      origin: { kind: 'model' },
      refs: [
        { name: 'e1', kind: 'edge' },
        { name: 'e2', kind: 'edge' },
      ],
    };
    const res: AnnotationResolution = {
      annotationId: 'X1',
      state: 'ok',
      value: Math.PI / 4,
      anchors: [
        { kind: 'line', a: [0, 0, 0], b: [50, 0, 0] },
        { kind: 'line', a: [0, 0, 0], b: [30, 0, 30] },
      ],
    };
    const c = ctx(v, 1, [res]);
    const out = layoutPlacement(P('a', 'V1', 'X1', { kind: 'arc', radius: 25 }), angle, c);
    expect(texts(out.items)).toEqual(['45°']);
    expect(out.items.some((i) => i.kind === 'arc')).toBe(true);
    const ord: Annotation = {
      id: 'X2',
      kind: 'ordinate',
      origin: { kind: 'model' },
      direction: [1, 0, 0],
      refs: [
        { name: 'o', kind: 'vertex' },
        { name: 't', kind: 'vertex' },
      ],
    };
    const ores: AnnotationResolution = {
      annotationId: 'X2',
      state: 'ok',
      value: 30,
      anchors: [
        { kind: 'point', at: [0, 0, 0] },
        { kind: 'point', at: [30, 0, 40] },
      ],
    };
    const o = layoutPlacement(
      P('o', 'V1', 'X2', { kind: 'lane', side: 'top', lane: 0 }),
      ord,
      ctx(v, 1, [ores]),
    );
    expect(texts(o.items)).toEqual(['30']);
    expect(o.items.some((i) => i.kind === 'fill')).toBe(false);
  });
  it('hole callouts count pattern instances from the regen', () => {
    const top = view('V2');
    const hole: Annotation = {
      id: 'H1',
      kind: 'holeCallout',
      origin: { kind: 'model' },
      refs: [{ name: 'F2:bore', kind: 'face' }],
      source: { kind: 'feature', featureId: 'F2' },
    };
    const res: AnnotationResolution = {
      annotationId: 'H1',
      state: 'ok',
      anchors: [{ kind: 'circle', center: [50, 30, 40], normal: [0, 0, 1], radius: 10 }],
      instances: [
        { name: 'a', kind: 'face' },
        { name: 'b', kind: 'face' },
        { name: 'c', kind: 'face' },
      ],
    };
    const out = layoutPlacement(
      P('h', 'V2', 'H1', { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [20, 15] }),
      hole,
      ctx(top, 1, [res]),
    );
    expect(texts(out.items)).toEqual(['3× Ø20 THRU']);
  });
  it('notes on a face seen face-on end in a dot', () => {
    const top = view('V2');
    const note: Annotation = {
      id: 'N1',
      kind: 'note',
      origin: { kind: 'model' },
      refs: [{ name: 'F1:face.zmax', kind: 'face' }],
      text: 'POLISH\nBOTH SIDES',
    };
    const res: AnnotationResolution = {
      annotationId: 'N1',
      state: 'ok',
      anchors: [
        {
          kind: 'plane',
          origin: [0, 0, 40],
          normal: [0, 0, 1],
          outline: [
            [0, 0, 40],
            [100, 0, 40],
            [100, 60, 40],
            [0, 60, 40],
          ],
        },
      ],
    };
    const out = layoutPlacement(
      P('n', 'V2', 'N1', { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [-30, 20] }),
      note,
      ctx(top, 1, [res]),
    );
    expect(texts(out.items)).toEqual(['POLISH', 'BOTH SIDES']);
    const dot = out.items.find((i) => i.kind === 'fill') as Extract<DisplayItem, { kind: 'fill' }>;
    expect(dot.loops[0]!.length).toBe(12);
    const mid: Vec2 = [top.position[0], top.position[1]];
    expect(
      Math.hypot(...(dot.loops[0]![0]!.map((x, i) => x - mid[i]!) as [number, number])),
    ).toBeLessThan(2);
  });
});
