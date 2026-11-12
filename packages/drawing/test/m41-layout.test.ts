/**
 * Layout goldens for M4.1 (ADR-095): a diameter in linear form (extension feet at the extremes),
 * a torus radius on the meridian on the side of the stored angle, and a draft angle's normal leg.
 */
import type {
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '../src/annotation';
import { extremePoint, layoutPlacement, type PlacementContext } from '../src/placement';
import { partToSheet, type SolvedView, solveViews } from '../src/view';
import { drawing, evalLength, evaluate, PART_BOUNDS } from './fixtures';

function view(id: string): SolvedView {
  const v = solveViews({ drawing: drawing(), bounds: PART_BOUNDS, evaluate }).get(id);
  if (!v?.ok) throw new Error(id);
  return v;
}

function place(
  v: SolvedView,
  a: Annotation,
  res: AnnotationResolution,
  layout: AnnotationPlacement['layout'],
) {
  const d = drawing();
  const ctx: PlacementContext = {
    view: v,
    style: d.style,
    standard: d.standard.gps,
    evaluate: (e) => evalLength(e),
    annotations: new Map([[a.id, a]]),
    resolutions: new Map([[a.id, res]]),
    placed: new Map(),
  };
  return layoutPlacement({ id: 'p', viewId: v.view.id, annotationId: a.id, layout }, a, ctx);
}

const lines = (items: DisplayItem[]) =>
  items.filter((i): i is Extract<DisplayItem, { kind: 'line' }> => i.kind === 'line');
const close = (p: Vec2, q: Vec2, eps = 1e-9) =>
  Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;

describe('golden: a diameter in linear form, refs [c, c] at [min, max]', () => {
  const rim: AnnotationAnchor = {
    kind: 'circle',
    center: [50, 30, 40],
    normal: [0, 0, 1],
    radius: 10,
  };
  const across = (direction: Vec3): Annotation => ({
    id: 'X',
    kind: 'linear',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [
      { name: 'F2:bore', kind: 'face' },
      { name: 'F2:bore', kind: 'face' },
    ],
    at: ['min', 'max'],
    direction,
  });
  const res: AnnotationResolution = {
    annotationId: 'X',
    state: 'ok',
    value: 20,
    anchors: [rim, rim],
  };

  it('extremePoint: tangent points along the direction, the centre along the axis', () => {
    expect(extremePoint(rim, 'min', [1, 0, 0])).toEqual([40, 30, 40]);
    expect(extremePoint(rim, 'max', [1, 0, 0])).toEqual([60, 30, 40]);
    expect(extremePoint(rim, 'max', [0, 2, 0])).toEqual([50, 40, 40]);
    expect(extremePoint(rim, 'max', [0, 0, 1])).toEqual([50, 30, 40]);
    const edge: AnnotationAnchor = { kind: 'line', a: [0, 0, 0], b: [10, 5, 0] };
    expect(extremePoint(edge, 'min', [-1, 0, 0])).toEqual([10, 5, 0]);
  });

  it('face-on (top view): the extension feet are the circle’s tangent points, the line spans the diameter', () => {
    const v = view('V2');
    const out = place(v, across([1, 0, 0]), res, { kind: 'lane', side: 'top', lane: 0 });
    expect(out.attention).toBe(false);
    const lo = partToSheet(v, [40, 30, 40]);
    const hi = partToSheet(v, [60, 30, 40]);
    // The dimension line runs between the two extremes' x, 20 mm at 1:1.
    const [p, q] = out.line as [Vec2, Vec2];
    expect(Math.abs(q[0] - p[0])).toBeCloseTo(20 * v.scale, 9);
    expect(Math.min(p[0], q[0])).toBeCloseTo(lo[0], 9);
    // Each extension line is vertical, at a tangent point's x, starting just off the circle.
    const ext = lines(out.items).filter((l) => Math.abs(l.a[0] - l.b[0]) < 1e-9);
    expect(ext.map((l) => l.a[0]).sort((m, n) => m - n)).toEqual([lo[0], hi[0]]);
    const gap = drawing().style.dimension.extensionGap;
    for (const l of ext) expect(Math.min(l.a[1], l.b[1])).toBeCloseTo(lo[1] + gap, 9);
  });

  it('side-on (front view): the same feet, at the silhouettes', () => {
    const v = view('V1');
    const out = place(v, across([1, 0, 0]), res, { kind: 'lane', side: 'top', lane: 0 });
    const [p, q] = out.line as [Vec2, Vec2];
    expect(Math.abs(q[0] - p[0])).toBeCloseTo(20, 9);
    expect(Math.min(p[0], q[0])).toBeCloseTo(partToSheet(v, [40, 30, 40])[0], 9);
  });
});

describe('golden: a torus radius on its meridian (a fillet at a shaft step)', () => {
  const torus: AnnotationAnchor = {
    kind: 'torus',
    center: [50, 30, 20],
    axis: [0, 0, 1],
    major: 10,
    minor: 3,
  };
  const r: Annotation = {
    id: 'R',
    kind: 'radius',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [{ name: 'F3:fillet(edge(F1:a|F1:b))', kind: 'face' }],
  };
  const res: AnnotationResolution = { annotationId: 'R', state: 'ok', value: 3, anchors: [torus] };

  for (const [angle, x] of [
    [45, 60],
    [135, 40],
    [-30, 60],
    [210, 40],
  ] as const)
    it(`leader at ${angle}°: on the meridian at x = ${x}, radius 3`, () => {
      const v = view('V1');
      const out = place(v, r, res, { kind: 'radial', angle, distance: 6 });
      expect(out.attention).toBe(false);
      const [centre, onCurve] = out.line as [Vec2, Vec2];
      expect(close(centre, partToSheet(v, [x, 30, 20]))).toBe(true);
      expect(Math.hypot(onCurve[0] - centre[0], onCurve[1] - centre[1])).toBeCloseTo(3, 9);
    });

  it('seen along its axis no meridian is seen true: not measurable in the view', () => {
    const out = place(view('V2'), r, res, { kind: 'radial', angle: 45, distance: 6 });
    expect(out.issues).toContainEqual({ kind: 'notMeasurableInView', viewId: 'V2' });
  });
});

describe('golden: a draft angle, refs [drafted, neutral] at [self, axis]', () => {
  const t = Math.tan((3 * Math.PI) / 180);
  // A wall rising from the base corner (20, ·, 10), leaning 3° outward-right, and the base face.
  const wall: AnnotationAnchor = {
    kind: 'plane',
    origin: [20, 0, 10],
    normal: [-Math.cos((3 * Math.PI) / 180), 0, Math.sin((3 * Math.PI) / 180)],
    outline: [
      [20, 0, 10],
      [20, 60, 10],
      [20 + 30 * t, 60, 40],
      [20 + 30 * t, 0, 40],
    ],
  };
  const base: AnnotationAnchor = {
    kind: 'plane',
    origin: [0, 0, 10],
    normal: [0, 0, -1],
    outline: [
      [0, 0, 10],
      [100, 0, 10],
      [100, 60, 10],
      [0, 60, 10],
    ],
  };
  const a: Annotation = {
    id: 'G',
    kind: 'angle',
    origin: { kind: 'drawing', drawingId: 'D1' },
    refs: [
      { name: 'F1:side(S1:e(L2))', kind: 'face' },
      { name: 'F1:start', kind: 'face' },
    ],
    at: ['self', 'axis'],
  };
  const res: AnnotationResolution = {
    annotationId: 'G',
    state: 'ok',
    value: (3 * Math.PI) / 180,
    anchors: [wall, base],
  };

  it('the vertex is where the edge-on lines meet; the second leg is the normal, on the wall’s side', () => {
    const v = view('V1');
    const out = place(v, a, res, { kind: 'arc', radius: 20 });
    expect(out.attention).toBe(false);
    const vertex = partToSheet(v, [20, 0, 10]);
    const arc = out.items.find((i) => i.kind === 'arc');
    expect(arc?.kind === 'arc' && close(arc.center, vertex, 1e-6)).toBe(true);
    // The arc's ends: on the wall and straight up the base's normal (towards the wall), 3° apart.
    const [p, q] = out.line as [Vec2, Vec2];
    const ang = (w: Vec2) => Math.atan2(w[1] - vertex[1], w[0] - vertex[0]);
    const sweep = Math.abs(ang(p) - ang(q));
    expect((sweep * 180) / Math.PI).toBeCloseTo(3, 6);
    const up = [p, q].find((w) => Math.abs(w[0] - vertex[0]) < 1e-6);
    expect(up && up[1] > vertex[1]).toBe(true);
    // The normal leg is drawn as an extension line along it, from the vertex out past the arc.
    const leg = lines(out.items).find(
      (l) => Math.abs(l.a[0] - vertex[0]) < 1e-6 && Math.abs(l.b[0] - vertex[0]) < 1e-6,
    );
    expect(leg).toBeDefined();
    expect(Math.max(leg?.a[1] ?? 0, leg?.b[1] ?? 0)).toBeGreaterThan(vertex[1] + 20);
    expect(out.textBox.length).toBe(4);
  });

  it('between the faces themselves (at self, self) it is the 87° between the lines', () => {
    const v = view('V1');
    const out = place(v, { ...a, at: ['self', 'self'] }, res, { kind: 'arc', radius: 20 });
    const vertex = partToSheet(v, [20, 0, 10]);
    const [p, q] = out.line as [Vec2, Vec2];
    const ang = (w: Vec2) => Math.atan2(w[1] - vertex[1], w[0] - vertex[0]);
    let sweep = Math.abs(ang(p) - ang(q));
    if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
    expect((sweep * 180) / Math.PI).toBeCloseTo(87, 6);
  });
});
