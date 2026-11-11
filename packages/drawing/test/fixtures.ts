/**
 * Shared fixtures: a bracket-like part (100 × 60 × 40 mm box with a Ø20 bore along Z), its
 * drawing (front base view, top and right projected views, a section and an iso), and mocked
 * kernel results (`ViewProjection`, `AnnotationResolution`). Nothing here runs a kernel.
 */
import type {
  Annotation,
  AnnotationResolution,
  Drawing,
  DrawingView,
  Expr,
  ProjectedCurve,
  Vec2,
  Vec3,
  ViewProjection,
} from '@wren-cad/contracts';
import { buildDrawing } from '../src/sheet';
import { standardPreset, stylePreset } from '../src/style';
import type { ExprEvaluator, SolvedView } from '../src/view';
import { projectToView, solveViews } from '../src/view';

export const PART_BOUNDS: { min: Vec3; max: Vec3 } = { min: [0, 0, 0], max: [100, 60, 40] };

/** `1/2`, `2`, `0.5`, `30deg`, `30 deg`, `0.1 mm` → numbers (mm, rad); anything else fails. */
export const evaluate: ExprEvaluator = (expr: Expr, kind) => {
  const t = expr.trim();
  const frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const deg = /^(-?\d+(?:\.\d+)?)\s*deg$/.exec(t);
  if (deg) return (Number(deg[1]) * Math.PI) / 180;
  const mm = /^(-?\d+(?:\.\d+)?)\s*(mm)?$/.exec(t);
  if (mm) return kind === 'angle' ? (Number(mm[1]) * Math.PI) / 180 : Number(mm[1]);
  return undefined;
};

export const evalLength = (e: Expr): number | undefined => {
  const um = /^(-?\d+(?:\.\d+)?)\s*um$/.exec(e.trim());
  if (um) return Number(um[1]) / 1000;
  return evaluate(e, 'ratio');
};

export function drawing(over: Partial<Drawing> = {}, views?: DrawingView[]): Drawing {
  return {
    id: 'D1',
    name: 'Bracket drawing',
    subject: { kind: 'part', partId: 'P1' },
    standard: standardPreset('iso'),
    projection: 'first',
    units: 'mm',
    style: stylePreset('iso'),
    template: { id: 'iso-5457', version: 1 },
    sheets: [
      { id: 'S1', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale: '1/1' },
    ],
    views: views ?? [
      {
        id: 'V1',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [150, 180] },
      },
      {
        id: 'V2',
        sheetId: 'S1',
        kind: 'projected',
        parentId: 'V1',
        from: 'top',
        layout: { kind: 'aligned', distance: 90 },
      },
      {
        id: 'V3',
        sheetId: 'S1',
        kind: 'projected',
        parentId: 'V1',
        from: 'right',
        layout: { kind: 'aligned', distance: 120 },
      },
      {
        id: 'V4',
        sheetId: 'S1',
        kind: 'section',
        parentId: 'V1',
        letter: 'A',
        cut: [
          { kind: 'free', at: [50, -10] },
          { kind: 'free', at: [50, 50] },
        ],
        look: 'right',
        layout: { kind: 'free', position: [330, 180] },
      },
      {
        id: 'V5',
        sheetId: 'S1',
        kind: 'iso',
        parentId: 'V1',
        corner: 'topRight',
        layout: { kind: 'free', position: [330, 80] },
      },
    ],
    placements: [],
    centerMarks: [],
    tables: [],
    notes: [],
    ...over,
  };
}

/** The box's 12 edges projected into a solved view: a stand-in for HLR output. */
export function boxProjection(v: SolvedView, bounds = PART_BOUNDS): ViewProjection {
  const { min, max } = bounds;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++)
    corners.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  const edges: [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const curves: ProjectedCurve[] = edges.map(([a, b], i) => ({
    role: 'visible',
    edge: 'sharp',
    name: `F1:edge#${i}`,
    curve: {
      kind: 'line',
      a: projectToView(v.frame, corners[a] as Vec3),
      b: projectToView(v.frame, corners[b] as Vec3),
    },
  }));
  // The bore, seen face-on in top/bottom views and as hidden lines elsewhere.
  const c: Vec3 = [50, 30, 0];
  const faceOn = Math.abs(Math.abs(v.frame.n[2]) - 1) < 1e-9;
  if (faceOn) {
    curves.push({
      role: 'visible',
      edge: 'sharp',
      name: 'F2:bore-edge',
      curve: {
        kind: 'arc',
        center: projectToView(v.frame, c),
        radius: 10,
        start: 0,
        end: 2 * Math.PI,
      },
    });
  }
  const pb = { min: [Infinity, Infinity] as Vec2, max: [-Infinity, -Infinity] as Vec2 };
  for (const p of corners) {
    const q = projectToView(v.frame, p);
    pb.min = [Math.min(pb.min[0], q[0]), Math.min(pb.min[1], q[1])];
    pb.max = [Math.max(pb.max[0], q[0]), Math.max(pb.max[1], q[1])];
  }
  return { key: `k-${v.view.id}`, curves, bounds: pb, ms: 1 };
}

/** Part annotations of the fixture: width, height, bore diameter, a datum and a frame. */
export const ANNOTATIONS: Annotation[] = [
  {
    id: 'A1',
    kind: 'linear',
    origin: { kind: 'model' },
    refs: [
      { name: 'F1:face.xmin', kind: 'face' },
      { name: 'F1:face.xmax', kind: 'face' },
    ],
    direction: [1, 0, 0],
    tolerance: { kind: 'symmetric', value: '0.1 mm' },
  },
  {
    id: 'A2',
    kind: 'linear',
    origin: { kind: 'model' },
    refs: [
      { name: 'F1:face.zmin', kind: 'face' },
      { name: 'F1:face.zmax', kind: 'face' },
    ],
    direction: [0, 0, 1],
  },
  {
    id: 'A3',
    kind: 'diameter',
    origin: { kind: 'model' },
    refs: [{ name: 'F2:bore', kind: 'face' }],
    tolerance: { kind: 'fit', hole: 'H7', show: 'symbol' },
  },
  {
    id: 'A4',
    kind: 'datumFeature',
    origin: { kind: 'model' },
    refs: [{ name: 'F1:face.zmin', kind: 'face' }],
    label: 'A',
  },
  {
    id: 'A5',
    kind: 'geometricTolerance',
    origin: { kind: 'model' },
    refs: [{ name: 'F2:bore', kind: 'face' }],
    characteristic: 'perpendicularity',
    zone: { value: '0.05 mm', shape: 'diameter' },
    datums: [{ datums: [{ datum: 'A4' }] }],
  },
];

/** Mocked regen resolutions for the fixture annotations (scale `k` resizes the part). */
export function resolutions(k = 1): AnnotationResolution[] {
  const s = (v: Vec3): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
  const plane = (origin: Vec3, normal: Vec3, outline: Vec3[]) => ({
    kind: 'plane' as const,
    origin: s(origin),
    normal,
    outline: outline.map(s),
  });
  return [
    {
      annotationId: 'A1',
      state: 'ok',
      value: 100 * k,
      measured: 100 * k,
      anchors: [
        plane(
          [0, 0, 0],
          [-1, 0, 0],
          [
            [0, 0, 0],
            [0, 60, 0],
            [0, 60, 40],
            [0, 0, 40],
          ],
        ),
        plane(
          [100, 0, 0],
          [1, 0, 0],
          [
            [100, 0, 0],
            [100, 60, 0],
            [100, 60, 40],
            [100, 0, 40],
          ],
        ),
      ],
    },
    {
      annotationId: 'A2',
      state: 'ok',
      value: 40 * k,
      anchors: [
        plane(
          [0, 0, 0],
          [0, 0, -1],
          [
            [0, 0, 0],
            [100, 0, 0],
            [100, 60, 0],
            [0, 60, 0],
          ],
        ),
        plane(
          [0, 0, 40],
          [0, 0, 1],
          [
            [0, 0, 40],
            [100, 0, 40],
            [100, 60, 40],
            [0, 60, 40],
          ],
        ),
      ],
    },
    {
      annotationId: 'A3',
      state: 'ok',
      value: 20 * k,
      anchors: [{ kind: 'circle', center: s([50, 30, 40]), normal: [0, 0, 1], radius: 10 * k }],
    },
    {
      annotationId: 'A4',
      state: 'ok',
      anchors: [
        plane(
          [0, 0, 0],
          [0, 0, -1],
          [
            [0, 0, 0],
            [100, 0, 0],
            [100, 60, 0],
            [0, 60, 0],
          ],
        ),
      ],
    },
    {
      annotationId: 'A5',
      state: 'ok',
      anchors: [{ kind: 'circle', center: s([50, 30, 40]), normal: [0, 0, 1], radius: 10 * k }],
    },
  ];
}

/** The bracket drawing built end to end against the mocks (three views, a section, dimensions). */
export function bracketBuild(over: Partial<Drawing> = {}) {
  const d = drawing({
    placements: [
      {
        id: 'p1',
        viewId: 'V1',
        annotationId: 'A1',
        layout: { kind: 'lane', side: 'bottom', lane: 0 },
      },
      {
        id: 'p2',
        viewId: 'V1',
        annotationId: 'A2',
        layout: { kind: 'lane', side: 'left', lane: 0 },
      },
      {
        id: 'p3',
        viewId: 'V2',
        annotationId: 'A3',
        layout: { kind: 'radial', angle: 45, distance: 7 },
      },
      {
        id: 'p4',
        viewId: 'V1',
        annotationId: 'A4',
        layout: { kind: 'leader', attach: { kind: 'ref', index: 0, t: 0.8 }, text: [0, -12] },
      },
      {
        id: 'p5',
        viewId: 'V2',
        annotationId: 'A5',
        layout: { kind: 'leader', attach: { kind: 'placement', placementId: 'p3' }, text: [0, 0] },
      },
    ],
    notes: [
      {
        id: 'n1',
        sheetId: 'S1',
        position: [30, 60],
        text: 'MATERIAL {material}\nBREAK ALL SHARP EDGES',
      },
    ],
    ...over,
  });
  const views = solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate });
  const projections = new Map<string, ViewProjection>();
  for (const [id, v] of views) {
    if (!v.ok) continue;
    const p = boxProjection(v);
    if (id === 'V4') {
      const [x0, y0] = p.bounds.min;
      const [x1, y1] = p.bounds.max;
      p.sectionFaces = [
        {
          face: 'F1:cut',
          loops: [
            [
              { kind: 'line', a: [x0, y0], b: [x1, y0] },
              { kind: 'line', a: [x1, y0], b: [x1, y1] },
              { kind: 'line', a: [x1, y1], b: [x0, y1] },
              { kind: 'line', a: [x0, y1], b: [x0, y0] },
            ],
          ],
        },
      ];
    }
    projections.set(id, p);
  }
  const res = new Map(resolutions().map((r) => [r.annotationId, r]));
  return buildDrawing({
    drawing: d,
    annotations: ANNOTATIONS,
    configurationIds: new Set(),
    bounds: PART_BOUNDS,
    evaluate,
    evaluateAnnotation: (e) => evalLength(e),
    projections,
    resolutions: () => res,
    annotationIssues: () => [],
    titleBlock: (s, index, count) => {
      const scale = evaluate(s.scale, 'ratio');
      return {
        title: 'Bracket',
        partNumber: 'BRK-001',
        material: 'AlMg3',
        mass: 152.4,
        ...(scale !== undefined ? { scale } : {}),
        projection: d.projection,
        units: 'mm',
        standard: d.standard,
        sheet: { index, count },
        date: '2026-11-11',
      };
    },
    fitDeviations: (c) => (c === 'H7' ? { upper: 0.021, lower: 0 } : undefined),
  });
}
