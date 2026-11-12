/**
 * M4.1 (ADR-095) pick flows on a mocked build: cut edges, tangent and hidden runs, construction
 * candidates, the circle that waits for a second pick, linear across, the exact-alignment rule,
 * a draft angle from the neutral face's normal, a radius on a spline outline's face, and the
 * inspector's forms.
 */

import type {
  AnchorQuery,
  Annotation,
  AnnotationAnchor,
  Command,
  Drawing,
  ProjectedCurve,
  Vec2,
  ViewDisplay,
  ViewProjection,
} from '@wren-cad/contracts';
import {
  type ConstructionCandidate,
  type SolvedView,
  solveViews,
  stylePreset,
  viewItems,
  viewToSheet,
} from '@wren-cad/drawing';
import { describe, expect, it } from 'vitest';
import type { DrawingController } from './controller';
import { CIRCLE_WAIT, edgeAt, onPick } from './interact-pick';
import { pickEdge, planAngle, planDimension } from './ops-annot';
import { diameterFormOf, fromNormalOf, setAngleFromNormal, setDiameterForm } from './ops-forms';
import type { Built } from './pipeline';
import { type DrawingUiState, type EdgePick, initialDrawingUi } from './state';

interface Fake {
  c: DrawingController;
  view: SolvedView;
  applied: { cmd: Command; label: string; key?: string }[];
  toasts: string[];
  ui: () => DrawingUiState;
  /** Anchor answers the fake modelling worker gives `annotationAnchors`. */
  answers: (q: AnchorQuery) => AnnotationAnchor | null;
}

/**
 * One front view (x = world X, y = world Z) of an 80 × 50 × 48 part at 1:1, at (100, 100) on an
 * A3 sheet, with the given curves and construction candidates.
 */
function fake(
  curves: ProjectedCurve[],
  opts: {
    display?: Partial<ViewDisplay>;
    construction?: ConstructionCandidate[];
    annotations?: Annotation[];
    placements?: Drawing['placements'];
    answers?: (q: AnchorQuery) => AnnotationAnchor | null;
  } = {},
): Fake {
  const drawing = {
    id: 'D',
    name: 'd',
    subject: { kind: 'part', partId: 'P' },
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'first',
    units: 'mm',
    style: stylePreset('iso'),
    template: { id: 'iso-5457', version: 1 },
    sheets: [
      { id: 'S', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale: '1' },
    ],
    views: [
      {
        id: 'V',
        sheetId: 'S',
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [100, 100] },
        ...(opts.display ? { display: opts.display } : {}),
      },
    ],
    placements: opts.placements ?? [],
    centerMarks: [],
    tables: [],
    notes: [],
  } as unknown as Drawing;
  const views = solveViews({
    drawing,
    bounds: { min: [0, 0, 0], max: [80, 50, 48] },
    evaluate: () => 1,
  });
  const view = views.get('V') as SolvedView;
  const proj = { viewId: 'V', quality: 'exact', curves } as unknown as ViewProjection;
  const list = { width: 420, height: 297, items: viewItems(view, proj, drawing) };
  const annotations = opts.annotations ?? [];
  const built = {
    drawing,
    part: { id: 'P', annotations },
    build: {
      views,
      placed: [],
      attention: [],
      sheets: [{ sheetId: 'S', list }],
    },
    projections: new Map([['V', proj]]),
    main: {
      resolutions: new Map(),
      construction: opts.construction ?? [],
      doc: { parts: [{ id: 'P', annotations }] },
    },
    data: new Map(),
  } as unknown as Built;
  let state: DrawingUiState = { ...initialDrawingUi, tool: 'dimension', sheetId: 'S' };
  const applied: Fake['applied'] = [];
  const toasts: string[] = [];
  const answers = opts.answers ?? (() => null);
  const c = {
    built: () => built,
    drawing: () => drawing,
    sheet: () => drawing.sheets[0],
    ui: {
      get: () => state,
      set: (f: (s: DrawingUiState) => DrawingUiState) => {
        state = f(state);
      },
    },
    patch: (p: Partial<DrawingUiState>) => {
      state = { ...state, ...p };
    },
    toast: (t: string) => toasts.push(t),
    select: () => {},
    commit: () => {},
    apply: (cmd: Command, label: string, key?: string) => {
      applied.push({ cmd, label, ...(key ? { key } : {}) });
      return true;
    },
    wb: {
      regen: { get: () => undefined },
      part: undefined,
      modeling: {
        port: {
          annotationAnchors: async (_p: string, qs: AnchorQuery[]) => ({
            ok: true,
            value: qs.map((q) => ({ anchor: answers(q) })),
          }),
        },
      },
    },
  } as unknown as DrawingController;
  return { c, view, applied, toasts, ui: () => state, answers };
}

const line = (name: string | undefined, a: Vec2, b: Vec2, extra: Partial<ProjectedCurve> = {}) =>
  ({
    role: 'visible',
    edge: 'sharp',
    ...(name ? { name } : {}),
    curve: { kind: 'line', a, b },
    ...extra,
  }) as ProjectedCurve;
const circle = (name: string, center: Vec2, radius: number) =>
  ({
    role: 'visible',
    edge: 'sharp',
    name,
    curve: { kind: 'arc', center, radius, start: 0, end: 2 * Math.PI },
  }) as ProjectedCurve;

const cmdAt = (f: Fake, i: number): Command => {
  const x = f.applied[i];
  if (!x) throw new Error(`no command ${i}`);
  return x.cmd;
};
const added = (f: Fake): Annotation[] =>
  f.applied.flatMap((x) => (x.cmd.kind === 'addAnnotation' ? [x.cmd.annotation] : []));
const layouts = (f: Fake) =>
  f.applied.flatMap((x) =>
    x.cmd.kind === 'addAnnotation' && x.cmd.place ? [x.cmd.place.placement.layout] : [],
  );
const at = (f: Fake, p: Vec2) => viewToSheet(f.view, p);
const click = async (f: Fake, p: Vec2, mods = { alt: false, shift: false }) => {
  const pick = edgeAt(f.c, { at: at(f, p), tol: 1 }, true);
  if (!pick) throw new Error(`nothing at ${p.join(', ')}`);
  await onPick(f.c, f.ui().tool, pick, mods);
  return pick;
};

describe('section cut edges (cutFace)', () => {
  // A far corner behind the cut (a model edge) on the same line as a cut edge.
  const curves = [
    line('edge(F1:a|F1:b)', [-20, -24], [-20, 24]),
    line(undefined, [-20, -24], [-20, 24], { cutFace: 'F1:side(S1:e(L1))' }),
    line(undefined, [-14, -24], [-14, 24], { cutFace: 'F1:side(S1:e(L1))' }),
    line(undefined, [-20, 30], [-20, 40], { cutFace: 'F1:side(S1:e(L1))' }),
  ];

  it('a pick on a cut edge refs the model face; it wins over the coincident model edge', () => {
    const f = fake(curves);
    const p = edgeAt(f.c, { at: at(f, [-20, 0]), tol: 1 });
    expect(p).toMatchObject({ name: 'F1:side(S1:e(L1))', ref: 'face', cut: true, shape: 'line' });
  });

  it('two parallel cut lines of one face are its diameter; collinear pieces are refused', () => {
    const f = fake(curves);
    const a = pickEdge(f.c, 'V', 'F1:side(S1:e(L1))', at(f, [-20, 0]), 'cut') as EdgePick;
    const b = pickEdge(f.c, 'V', 'F1:side(S1:e(L1))', at(f, [-14, 0]), 'cut') as EdgePick;
    expect(planDimension(f.c, [a, b])).toMatchObject({
      ok: true,
      annotation: { kind: 'diameter' },
      layout: { kind: 'lane' },
      faceRef: 'F1:side(S1:e(L1))',
    });
    const c = pickEdge(f.c, 'V', 'F1:side(S1:e(L1))', at(f, [-20, 35]), 'cut') as EdgePick;
    expect(c.geom).toEqual({ a: [-20, 30], b: [-20, 40] });
    expect(planDimension(f.c, [a, c])).toMatchObject({
      ok: false,
      message: expect.stringMatching(/one cut line/),
    });
  });
});

describe('the exact-alignment rule', () => {
  const t = Math.tan((3 * Math.PI) / 180);
  it('edges exactly along a view axis get a direction and a lane; a 3° draft gets neither', () => {
    const f = fake([]);
    const pick = (name: string, a: Vec2, b: Vec2): EdgePick => ({
      viewId: 'V',
      name,
      shape: 'line',
      at: at(f, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]),
      geom: { a, b },
    });
    const straight = planDimension(f.c, [
      pick('a', [-10, -20], [-10, 20]),
      pick('b', [-7, -20], [-7, 20]),
    ]);
    expect(straight).toMatchObject({ ok: true, annotation: { direction: [1, 0, 0] } });
    expect(straight.ok && straight.layout.kind).toBe('lane');
    const drafted = planDimension(f.c, [
      pick('a', [-10, -20], [-10 + 40 * t, 20]),
      pick('b', [-7, -20], [-7 + 40 * t, 20]),
    ]);
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect('direction' in drafted.annotation).toBe(false);
    expect(drafted.layout).toEqual({ kind: 'offset', distance: 10 });
  });
});

describe('tangent and hidden lines', () => {
  const curves = [
    line('edge(F1:v)', [-30, 0], [30, 0]),
    line('edge(F1:h)', [-30, 0], [30, 0], { role: 'hidden' }),
    line('edge(F1:hidden-only)', [-30, 10], [30, 10], { role: 'hidden' }),
    line('edge(F1:smooth)', [-30, 20], [30, 20], { edge: 'smooth' }),
  ];

  it('picks hidden and tangent runs only when the view draws them, with their role', () => {
    const off = fake(curves);
    expect(pickEdge(off.c, 'V', 'edge(F1:hidden-only)', at(off, [0, 10]))).toBeNull();
    expect(pickEdge(off.c, 'V', 'edge(F1:smooth)', at(off, [0, 20]))).toBeNull();
    const on = fake(curves, { display: { lines: 'visibleAndHidden', tangentEdges: 'thin' } });
    expect(pickEdge(on.c, 'V', 'edge(F1:hidden-only)', at(on, [0, 10]))).toMatchObject({
      role: 'hidden',
      shape: 'line',
    });
    expect(edgeAt(on.c, { at: at(on, [0, 20]), tol: 1 })).toMatchObject({
      name: 'edge(F1:smooth)',
      role: 'tangent',
    });
  });

  it('visible wins over hidden where they coincide', () => {
    const on = fake(curves, { display: { lines: 'visibleAndHidden' } });
    expect(edgeAt(on.c, { at: at(on, [0, 0.2]), tol: 1 })).toMatchObject({
      name: 'edge(F1:v)',
      role: 'visible',
    });
  });
});

describe('construction geometry', () => {
  const construction: ConstructionCandidate[] = [
    {
      name: 'origin:Z',
      anchor: { kind: 'axis', origin: [0, 0, 0], direction: [0, 0, 1], extent: [0, 48] },
    },
    { name: 'SSK:p(C)', anchor: { kind: 'point', at: [60, 0, 30] } },
  ];
  // The part spans x 0..80 in the view plane (centred at 40): the origin's Z axis is its left side.
  const curves = [
    line('edge(F1:left)', [0, 0], [0, 48]),
    line('edge(F1:right)', [80, 0], [80, 48]),
  ];

  it('model edges outrank construction; elsewhere a pick stores the exact construction name', () => {
    const f = fake(curves, { construction });
    expect(edgeAt(f.c, { at: at(f, [0, 20]), tol: 1 }, true)).toMatchObject({
      name: 'edge(F1:left)',
    });
    // Past the part's top the origin's axis runs on (3 mm overrun): there it is picked.
    expect(edgeAt(f.c, { at: at(f, [0, 49.5]), tol: 1 }, true)).toMatchObject({
      name: 'origin:Z',
      construction: true,
      shape: 'line',
    });
    // Tools that do not measure never pick it.
    expect(edgeAt(f.c, { at: at(f, [0, 49.5]), tol: 1 }, false)).toBeNull();
  });

  it('a construction point and an edge: a linear dimension with the view axis as direction', async () => {
    const f = fake(curves, { construction });
    await click(f, [60, 30]);
    expect(f.ui().hint?.text).toMatch(/second edge, circle or point/);
    await click(f, [80, 10]);
    const [a] = added(f);
    expect(a).toMatchObject({
      kind: 'linear',
      refs: [
        { name: 'SSK:p(C)', kind: 'vertex' },
        { name: 'edge(F1:right)', kind: 'edge' },
      ],
      at: ['self', 'self'],
      direction: [1, 0, 0],
    });
  });
});

describe('the Dimension tool on circles (centre to centre)', () => {
  const curves = [circle('rim(A)', [-20, 10], 5), circle('rim(B)', [20, 14], 5)];

  it('waits after a circle; another circle is a centre distance along x or y', async () => {
    const f = fake(curves);
    await click(f, [-15, 10]);
    expect(added(f)).toHaveLength(0);
    expect(f.ui().hint?.text).toBe(CIRCLE_WAIT);
    await click(f, [25, 14]);
    expect(added(f)[0]).toMatchObject({
      kind: 'linear',
      at: ['center', 'center'],
      direction: [1, 0, 0],
    });
  });

  it('the same circle again: its diameter; Alt: its radius', async () => {
    const f = fake(curves);
    await click(f, [-15, 10]);
    await click(f, [-20, 15]);
    expect(added(f)[0]).toMatchObject({ kind: 'diameter', refs: [{ name: 'rim(A)' }] });
    expect(layouts(f)[0]).toMatchObject({ kind: 'radial' });
    const g = fake(curves);
    await click(g, [-15, 10]);
    await click(g, [-20, 15], { alt: true, shift: false });
    expect(added(g)[0]).toMatchObject({ kind: 'radius' });
  });

  it('Shift on the same circle again: linear across, refs [c, c] at [min, max], along the click’s axis', async () => {
    const f = fake(curves);
    await click(f, [-15, 10]);
    await click(f, [-25, 10], { alt: false, shift: true });
    expect(added(f)[0]).toMatchObject({
      kind: 'linear',
      refs: [{ name: 'rim(A)' }, { name: 'rim(A)' }],
      at: ['min', 'max'],
      direction: [1, 0, 0],
    });
    expect(layouts(f)[0]).toMatchObject({ kind: 'lane' });
    const g = fake(curves);
    await click(g, [-15, 10]);
    await click(g, [-20, 15], { alt: false, shift: true });
    expect(added(g)[0]).toMatchObject({ direction: [0, 0, 1] });
  });

  it('a sphere’s outline (a face-named circle) is still its diameter on the second pick', async () => {
    const f = fake([
      { role: 'visible', edge: 'outline', face: 'F1:sphere', curve: circle('x', [0, 0], 8).curve },
    ] as ProjectedCurve[]);
    await click(f, [8, 0]);
    await click(f, [-8, 0]);
    expect(added(f)[0]).toMatchObject({
      kind: 'diameter',
      refs: [{ name: 'F1:sphere', kind: 'face' }],
    });
  });
});

describe('a spline outline: a radius on its face, when round', () => {
  const spline = {
    role: 'visible',
    edge: 'outline',
    face: 'F3:fillet(edge(F1:a|F1:b))',
    curve: {
      kind: 'bspline',
      degree: 2,
      poles: [
        [20, 0],
        [25, 0],
        [25, 5],
      ],
      knots: [0, 0, 0, 1, 1, 1],
    },
  } as unknown as ProjectedCurve;

  it('a torus anchor stores a radius on the face, the leader on the picked side', async () => {
    const torus: AnnotationAnchor = {
      kind: 'torus',
      center: [0, 0, 5],
      axis: [0, 0, 1],
      major: 25,
      minor: 5,
    };
    const f = fake([spline], { answers: (q) => (q.annotationKind === 'radius' ? torus : null) });
    await click(f, [24.1, 1.25]);
    // A curved outline waits like a circle: nothing yet.
    expect(added(f)).toHaveLength(0);
    expect(f.ui().hint?.text).toBe(CIRCLE_WAIT);
    await click(f, [24.1, 1.25]);
    expect(added(f)[0]).toMatchObject({
      kind: 'radius',
      refs: [{ name: 'F3:fillet(edge(F1:a|F1:b))', kind: 'face' }],
    });
    const l = layouts(f)[0];
    expect(l?.kind).toBe('radial');
    // Picked right of the axis: the leader points right (the meridian on that side).
    expect(l?.kind === 'radial' && Math.abs(l.angle)).toBeLessThan(90);
  });

  it('the run under the pointer is the spline, not an arc of the same face elsewhere', () => {
    const seam = {
      role: 'visible',
      edge: 'sharp',
      name: 'edge(F3:fillet(edge(F1:a|F1:b))|F1:c)',
      face: 'F3:fillet(edge(F1:a|F1:b))',
      curve: { kind: 'arc', center: [-25, 5], radius: 5, start: Math.PI, end: 1.5 * Math.PI },
    } as unknown as ProjectedCurve;
    const f = fake([seam, spline]);
    expect(
      pickEdge(f.c, 'V', 'F3:fillet(edge(F1:a|F1:b))', at(f, [24.1, 1.25]), 'face'),
    ).toMatchObject({ shape: 'other', ref: 'face' });
    expect(pickEdge(f.c, 'V', 'F3:fillet(edge(F1:a|F1:b))', at(f, [-30, 5]), 'face')).toMatchObject(
      {
        shape: 'circle',
      },
    );
  });

  it('a face that is not round is refused with the reason, nothing added', async () => {
    const plane: AnnotationAnchor = {
      kind: 'plane',
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      outline: [],
    };
    const f = fake([spline], { answers: () => plane });
    await click(f, [24.1, 1.25]);
    await click(f, [24.1, 1.25]);
    expect(added(f)).toHaveLength(0);
    expect(f.toasts.at(-1)).toMatch(/flat, so it has no radius/);
  });
});

describe('pieces of one round outline are one circle (a sphere cut by a flat and a stem)', () => {
  const face = 'F1:sphere';
  const arc = {
    role: 'visible',
    edge: 'outline',
    face,
    curve: { kind: 'arc', center: [0, 0], radius: 8, start: 0, end: Math.PI },
  } as unknown as ProjectedCurve;
  const piece = {
    role: 'visible',
    edge: 'outline',
    face,
    curve: {
      kind: 'bspline',
      degree: 2,
      poles: [
        [-8, 0],
        [-8, -8],
        [0, -8],
      ],
      knots: [0, 0, 0, 1, 1, 1],
    },
  } as unknown as ProjectedCurve;
  const sphere: AnnotationAnchor = { kind: 'point', at: [0, 0, 0] };

  it('a spline piece first, then the arc of the same face: the diameter, not a one-pick radius', async () => {
    const f = fake([arc, piece], { answers: () => sphere });
    await click(f, [-6.5, -6]);
    expect(added(f)).toHaveLength(0);
    expect(f.ui().hint?.text).toBe(CIRCLE_WAIT);
    await click(f, [0, 8]);
    expect(added(f)[0]).toMatchObject({ kind: 'diameter', refs: [{ name: face, kind: 'face' }] });
  });

  it('two spline picks of a round face: its diameter; Alt: its radius', async () => {
    const f = fake([piece], { answers: () => sphere });
    await click(f, [-6.5, -6]);
    await click(f, [-6.5, -6]);
    expect(added(f)[0]).toMatchObject({ kind: 'diameter', refs: [{ name: face, kind: 'face' }] });
    const g = fake([piece], { answers: () => sphere });
    await click(g, [-6.5, -6]);
    await click(g, [-6.5, -6], { alt: true, shift: false });
    expect(added(g)[0]).toMatchObject({ kind: 'radius' });
  });

  it('a spline then something else is refused with the reason, nothing added', async () => {
    const f = fake([piece, line('edge(F2:x)', [20, -10], [20, 10])], { answers: () => sphere });
    await click(f, [-6.5, -6]);
    await click(f, [20, 0]);
    expect(added(f)).toHaveLength(0);
    expect(f.toasts.at(-1)).toMatch(/pick it again/);
  });
});

describe('a draft angle: from the neutral face’s normal', () => {
  const t = Math.tan((3 * Math.PI) / 180);
  const curves = [
    line(undefined, [-20, -10], [-20 + 30 * t, 20], { cutFace: 'F1:side(S1:e(L2))' }),
    line(undefined, [-30, -10], [30, -10], { cutFace: 'F1:start' }),
    line('edge(F1:x)', [-30, 22], [30, 22]),
  ];

  it('Shift on the second (cut) pick stores [drafted, neutral] at [self, axis]', async () => {
    const f = fake(curves);
    f.c.ui.set((s) => ({ ...s, tool: 'angle' }));
    await click(f, [-20 + 15 * t, 5]);
    expect(f.ui().hint?.text).toMatch(/Shift/);
    await click(f, [10, -10], { alt: false, shift: true });
    expect(added(f)[0]).toMatchObject({
      kind: 'angle',
      refs: [
        { name: 'F1:side(S1:e(L2))', kind: 'face' },
        { name: 'F1:start', kind: 'face' },
      ],
      at: ['self', 'axis'],
    });
  });

  it('from the normal of a model edge is refused: it needs a face', () => {
    const f = fake(curves);
    const wall = pickEdge(f.c, 'V', 'F1:side(S1:e(L2))', at(f, [-20, 0]), 'cut') as EdgePick;
    const edge = pickEdge(f.c, 'V', 'edge(F1:x)', at(f, [0, 22])) as EdgePick;
    expect(planAngle(f.c, [wall, edge], true)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/cut edge/),
    });
  });
});

describe('inspector forms', () => {
  const dia: Annotation = {
    id: 'A',
    kind: 'diameter',
    origin: { kind: 'drawing', drawingId: 'D' },
    refs: [{ name: 'rim(A)', kind: 'edge' }],
    tolerance: { kind: 'symmetric', value: '0.1 mm' },
  };
  const placements: Drawing['placements'] = [
    { id: 'p', viewId: 'V', annotationId: 'A', layout: { kind: 'radial', angle: 45, distance: 6 } },
  ];

  it('Ø ↔ linear across: one annotation rewrite and one placement update, under one key', () => {
    const f = fake([], { annotations: [dia], placements });
    const b = f.c.built() as Built;
    expect(diameterFormOf(b, dia, placements[0] as never)).toBe('diameter');
    expect(setDiameterForm(f.c, 'p', 'x')).toBe(true);
    expect(f.applied.map((x) => x.cmd.kind)).toEqual(['updateAnnotation', 'updatePlacements']);
    const keys = new Set(f.applied.map((x) => x.key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeTruthy();
    const next = (cmdAt(f, 0) as Extract<Command, { kind: 'updateAnnotation' }>).annotation;
    expect(next).toMatchObject({
      id: 'A',
      kind: 'linear',
      refs: [{ name: 'rim(A)' }, { name: 'rim(A)' }],
      at: ['min', 'max'],
      direction: [1, 0, 0],
      tolerance: { kind: 'symmetric', value: '0.1 mm' },
    });
    const pl = (cmdAt(f, 1) as Extract<Command, { kind: 'updatePlacements' }>).placements[0];
    expect(pl?.layout.kind).toBe('lane');
    // And it reads back as that form.
    expect(diameterFormOf(b, next, pl as never)).toBe('x');
  });

  it('linear across back to Ø', () => {
    const across: Annotation = {
      id: 'A',
      kind: 'linear',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [
        { name: 'rim(A)', kind: 'edge' },
        { name: 'rim(A)', kind: 'edge' },
      ],
      at: ['min', 'max'],
      direction: [0, 0, 1],
    };
    const lane: Drawing['placements'] = [
      { id: 'p', viewId: 'V', annotationId: 'A', layout: { kind: 'lane', side: 'left', lane: 0 } },
    ];
    const f = fake([], { annotations: [across], placements: lane });
    expect(diameterFormOf(f.c.built() as Built, across, lane[0] as never)).toBe('y');
    setDiameterForm(f.c, 'p', 'diameter');
    const next = (cmdAt(f, 0) as Extract<Command, { kind: 'updateAnnotation' }>).annotation;
    expect(next).toEqual({
      id: 'A',
      kind: 'diameter',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [{ name: 'rim(A)', kind: 'edge' }],
    });
  });

  it('an angle between faces toggles "from the normal of the second face"', () => {
    const angle: Annotation = {
      id: 'G',
      kind: 'angle',
      origin: { kind: 'drawing', drawingId: 'D' },
      refs: [
        { name: 'F1:side', kind: 'face' },
        { name: 'F1:start', kind: 'face' },
      ],
      at: ['self', 'self'],
    };
    expect(fromNormalOf(angle)).toBe(false);
    expect(
      fromNormalOf({ ...angle, refs: [angle.refs[0], { name: 'e', kind: 'edge' }] } as Annotation),
    ).toBeUndefined();
    const f = fake([], { annotations: [angle] });
    expect(setAngleFromNormal(f.c, 'G', true)).toBe(true);
    expect((cmdAt(f, 0) as Extract<Command, { kind: 'updateAnnotation' }>).annotation.at).toEqual([
      'self',
      'axis',
    ]);
  });
});
