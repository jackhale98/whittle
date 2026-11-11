/**
 * Import planner, M4 gate round 3: instance counts on pattern and mirror dimensions, the duplicate
 * rule (same coordinates, different features; the principal view), zero and stale values, lanes
 * along a stepped cut, and sphere diameters.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchorAnswer,
  Annotation,
  AnnotationAnchor,
  AnnotationPlacement,
  AnnotationResolution,
  Drawing,
  DrawingView,
  Feature,
  Part,
  SketchFeature,
  Vec3,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { anchorLookup, importAnchorQueries, planImport, type SketchFrame } from '../src/import';
import { collectPromotions } from '../src/import/promote';
import { layoutPlacement, type PlacementContext } from '../src/placement';
import { solveViews } from '../src/view';
import { drawing, evalLength, evaluate } from './fixtures';

const XY: SketchFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const YZ: SketchFrame = { origin: [-30, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };

/** A rectangle `L` (corners `La`..`Ld`, lines `L1` bottom, `L2` right, `L3` top, `L4` left). */
function rect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  dims: { w: string; h: string },
): SketchFeature {
  return {
    id,
    type: 'sketch',
    name: id,
    suppressed: false,
    on: { name: 'origin:XY', kind: 'face' },
    entities: [
      { id: 'La', kind: 'point', construction: false, x, y },
      { id: 'Lb', kind: 'point', construction: false, x: x + w, y },
      { id: 'Lc', kind: 'point', construction: false, x: x + w, y: y + h },
      { id: 'Ld', kind: 'point', construction: false, x, y: y + h },
      { id: 'L1', kind: 'line', construction: false, start: 'La', end: 'Lb' },
      { id: 'L2', kind: 'line', construction: false, start: 'Lb', end: 'Lc' },
      { id: 'L3', kind: 'line', construction: false, start: 'Lc', end: 'Ld' },
      { id: 'L4', kind: 'line', construction: false, start: 'Ld', end: 'La' },
    ],
    constraints: [
      { id: 'w', kind: 'hDistance', a: 'La', b: 'Lb', value: dims.w, driving: true },
      { id: 'h', kind: 'vDistance', a: 'Lb', b: 'Lc', value: dims.h, driving: true },
    ],
  } as SketchFeature;
}

const extrude = (
  id: string,
  sk: string,
  op: 'new' | 'add' | 'cut',
  end: Extract<Feature, { type: 'extrude' }>['end'],
): Feature =>
  ({
    id,
    type: 'extrude',
    name: id,
    suppressed: false,
    profile: [{ name: `S${sk}:region(L1,L2,L3,L4)`, kind: 'region' }],
    direction: op === 'cut' ? 'symmetric' : 'normal',
    end,
    op,
  }) as Feature;

/** A comb plate: a plate, a slot patterned 6× with one skipped, an ear and its mirror copy. */
function comb(): Part {
  const features: Feature[] = [
    rect('PL', -60, -20, 120, 40, { w: '120 mm', h: '40 mm' }),
    extrude('E1', 'PL', 'new', { kind: 'blind', depth: '8 mm' }),
    rect('SL', -48, -12, 6, 24, { w: '6 mm', h: '24 mm' }),
    extrude('CUT', 'SL', 'cut', { kind: 'throughAll' }),
    {
      id: 'PAT',
      type: 'linearPattern',
      name: 'Pattern',
      suppressed: false,
      source: { kind: 'features', features: ['CUT'] },
      direction: { name: 'origin:X', kind: 'edge' },
      reverse: false,
      count: '6',
      spacing: '18 mm',
      skip: [3],
    } as Feature,
    rect('EA', 60, -12, 20, 24, { w: '20 mm', h: '24 mm' }),
    extrude('EAR', 'EA', 'add', { kind: 'blind', depth: '8 mm' }),
    {
      id: 'MIR',
      type: 'mirror',
      name: 'Mirror',
      suppressed: false,
      source: { kind: 'features', features: ['EAR'] },
      plane: { name: 'origin:YZ', kind: 'face' },
    } as Feature,
  ];
  return { id: 'P1', name: 'Comb', rollbackIndex: features.length, annotations: [], features };
}

function topDrawing(views?: DrawingView[]): Drawing {
  return drawing(
    { projection: 'third' },
    views ?? [
      {
        id: 'V1',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'top' },
        layout: { kind: 'free', position: [200, 150] },
      },
    ],
  );
}

const frames = (p: Part, by: Record<string, SketchFrame> = {}) =>
  new Map(
    p.features.filter((f) => f.type === 'sketch').map((f) => [f.id, by[f.id] ?? XY] as const),
  );

const bounds = { min: [-80, -20, 0] as Vec3, max: [80, 20, 8] as Vec3 };

/** A plane anchor for an extrude side face of a rectangle line, from the sketch. */
function sideAnchor(p: Part, name: string): AnnotationAnchor | null {
  const pm = /^S([^:]+):p\(([^)]+)\)$/.exec(name);
  if (pm) {
    const sk = p.features.find((f) => f.id === pm[1]) as SketchFeature | undefined;
    const e = sk?.entities.find((x) => x.id === pm[2]);
    return e?.kind === 'point' ? { kind: 'point', at: [e.x, e.y, 0] } : null;
  }
  const m = /^F([^:]+):side\(S([^:]+):e\(([^)]+)\)\)$/.exec(name);
  if (!m) return null;
  const sk = p.features.find((f) => f.id === m[2]) as SketchFeature;
  const line = sk.entities.find((e) => e.id === m[3]);
  if (line?.kind !== 'line') return null;
  const pt = (id: string) => sk.entities.find((e) => e.id === id) as { x: number; y: number };
  const a = pt(line.start);
  const b = pt(line.end);
  const n: Vec3 =
    Math.abs(a.x - b.x) < 1e-9 ? [Math.sign(a.x) || 1, 0, 0] : [0, Math.sign(a.y) || 1, 0];
  return {
    kind: 'plane',
    origin: [(a.x + b.x) / 2, (a.y + b.y) / 2, 4],
    normal: n,
    outline: [
      [a.x, a.y, 0],
      [b.x, b.y, 0],
      [b.x, b.y, 8],
      [a.x, a.y, 8],
    ],
  };
}

function plan(p: Part, answer?: (name: string) => AnchorAnswer, d = topDrawing()) {
  const fr = frames(p);
  const queries = importAnchorQueries(p, fr);
  let n = 0;
  return planImport({
    drawing: d,
    part: p,
    views: solveViews({ drawing: d, bounds, evaluate }),
    resolutions: new Map(),
    sketchFrames: fr,
    ...(answer
      ? {
          anchors: anchorLookup(
            queries,
            queries.map((q) => answer(q.ref.name)),
          ),
        }
      : {}),
    evaluate: (e, k) => evaluate(e, k === 'angle' ? 'angle' : 'ratio'),
    moveViews: true,
    newId: () => `N${String(++n).padStart(3, '0')}`,
  });
}

const byKey = (pl: ReturnType<typeof planImport>) => new Map(pl.candidates.map((c) => [c.key, c]));

describe('instance counts on pattern and mirror dimensions', () => {
  it('a copied extrude’s profile size is measured between its side faces and counts the copies', () => {
    const { promotions } = collectPromotions(comb(), frames(comb()), (e, k) =>
      evaluate(e, k === 'angle' ? 'angle' : 'ratio'),
    );
    const width = promotions.find((p) => p.key === 'sketch:SL:h');
    // vDistance from the bottom-right to the top-right corner: the horizontal lines through them.
    expect(width?.draft).toMatchObject({
      kind: 'linear',
      refs: [
        { name: 'FCUT:side(SSL:e(L1))', kind: 'face' },
        { name: 'FCUT:side(SSL:e(L3))', kind: 'face' },
      ],
      text: { count: true },
    });
    expect(width?.choices?.[1]).toEqual([
      { name: 'SSL:p(Lb)', kind: 'vertex' },
      { name: 'SSL:p(Lc)', kind: 'vertex' },
    ]);
    expect(width?.countChoice).toBe(0);
    // The ear is mirrored: its width counts 2.
    expect(promotions.find((p) => p.key === 'sketch:EA:h')?.draft).toMatchObject({
      refs: [{ name: 'FEAR:side(SEA:e(L1))' }, { name: 'FEAR:side(SEA:e(L3))' }],
      text: { count: true },
    });
    // The plate is not copied: sketch refs, no count.
    const plate = promotions.find((p) => p.key === 'sketch:PL:h');
    expect(plate?.draft.refs[0]?.name).toBe('SPL:p(Lb)');
    expect(plate?.draft).not.toHaveProperty('text');
  });

  it('a pattern that leaves one instance asks for no count', () => {
    const p = comb();
    const pat = p.features.find((f) => f.id === 'PAT') as Extract<
      Feature,
      { type: 'linearPattern' }
    >;
    pat.count = '2';
    pat.skip = [1];
    const { promotions } = collectPromotions(p, frames(p), (e, k) =>
      evaluate(e, k === 'angle' ? 'angle' : 'ratio'),
    );
    expect(promotions.find((x) => x.key === 'sketch:SL:h')?.draft).not.toHaveProperty('text');
  });

  it('keeps the count only while the face refs resolve; falls back to the sketch without it', () => {
    const p = comb();
    const faces = byKey(plan(p, (name) => ({ anchor: sideAnchor(p, name) })));
    expect(faces.get('sketch:SL:h')?.annotation).toMatchObject({
      refs: [{ name: 'FCUT:side(SSL:e(L1))' }, { name: 'FCUT:side(SSL:e(L3))' }],
      text: { count: true },
    });
    // The ear's inner end face is fused into the plate: its length keeps the sketch refs.
    const fused = byKey(
      plan(p, (name) =>
        name === 'FEAR:side(SEA:e(L4))' ? { anchor: null } : { anchor: sideAnchor(p, name) },
      ),
    );
    const earLength = fused.get('sketch:EA:w')?.annotation;
    expect(earLength?.refs[0]?.name).toBe('SEA:p(La)');
    expect(earLength).not.toHaveProperty('text');
  });
});

describe('duplicates: same coordinates, different features', () => {
  it('places a slot’s width and an ear’s width at the same two y values: two features', () => {
    const c = byKey(plan(comb()));
    expect(c.get('sketch:SL:h')?.reason).toBeUndefined();
    expect(c.get('sketch:EA:h')?.reason).toBeUndefined();
    expect(c.get('sketch:SL:h')?.placement).toBeDefined();
    expect(c.get('sketch:EA:h')?.placement).toBeDefined();
  });

  it('keeps the dimension on the principal view, then the one that locates a circle', () => {
    // The same y 0..15 from a sketch on Top (a point) and one on a YZ plane (a circle's centre):
    // Top is the drawing's base view, so its dimension is kept and the other is a duplicate.
    const pathSk: SketchFeature = {
      id: 'TOP',
      type: 'sketch',
      name: 'Path',
      suppressed: false,
      on: { name: 'origin:XY', kind: 'face' },
      entities: [{ id: 'q', kind: 'point', construction: false, x: -30, y: 15 }],
      constraints: [
        { id: 'y', kind: 'vDistance', a: '@origin', b: 'q', value: '15 mm', driving: true },
      ],
    } as SketchFeature;
    const profSk: SketchFeature = {
      id: 'SIDE',
      type: 'sketch',
      name: 'Profile',
      suppressed: false,
      on: { name: 'origin:YZ', kind: 'face' },
      entities: [
        { id: 'c', kind: 'point', construction: false, x: 15, y: 4 },
        { id: 'C', kind: 'circle', construction: false, center: 'c', radius: 4 },
      ],
      constraints: [
        { id: 'y', kind: 'hDistance', a: '@origin', b: 'c', value: '15 mm', driving: true },
      ],
    } as SketchFeature;
    const p: Part = {
      id: 'P1',
      name: 'Guide',
      rollbackIndex: 2,
      annotations: [],
      features: [pathSk, profSk],
    };
    const views: DrawingView[] = [
      {
        id: 'V1',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'top' },
        layout: { kind: 'free', position: [140, 150] },
      },
      {
        id: 'V2',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'right' },
        layout: { kind: 'free', position: [320, 150] },
      },
    ];
    const d = topDrawing(views);
    const fr = frames(p, { SIDE: YZ });
    let n = 0;
    const out = byKey(
      planImport({
        drawing: d,
        part: p,
        views: solveViews({ drawing: d, bounds, evaluate }),
        resolutions: new Map(),
        sketchFrames: fr,
        evaluate: (e, k) => evaluate(e, k === 'angle' ? 'angle' : 'ratio'),
        newId: () => `N${++n}`,
      }),
    );
    expect(out.get('sketch:TOP:y')).toMatchObject({ viewId: 'V1' });
    expect(out.get('sketch:TOP:y')?.reason).toBeUndefined();
    expect(out.get('sketch:SIDE:y')).toMatchObject({
      reason: 'duplicate',
      duplicateOf: 'sketch:TOP:y',
    });
  });
});

describe('promotions that would not be a dimension', () => {
  it('a zero distance (a centre on the origin’s x = 0) is listed, not placed', () => {
    const sk: SketchFeature = {
      id: 'B',
      type: 'sketch',
      name: 'Boss',
      suppressed: false,
      on: { name: 'origin:XY', kind: 'face' },
      entities: [
        { id: 'c', kind: 'point', construction: false, x: 0, y: 10 },
        { id: 'C', kind: 'circle', construction: false, center: 'c', radius: 5 },
      ],
      constraints: [
        { id: 'x', kind: 'hDistance', a: '@origin', b: 'c', value: '0 mm', driving: true },
        { id: 'y', kind: 'vDistance', a: '@origin', b: 'c', value: '10 mm', driving: true },
      ],
    } as SketchFeature;
    const p: Part = { id: 'P1', name: 'B', rollbackIndex: 1, annotations: [], features: [sk] };
    const c = byKey(plan(p));
    expect(c.get('sketch:B:x')).toMatchObject({ reason: 'zeroLength', checked: false });
    expect(c.get('sketch:B:x')?.placement).toBeUndefined();
    expect(c.get('sketch:B:y')?.placement).toBeDefined();
  });

  it('an extrude depth the model no longer has (a later push/pull) is listed, not placed', () => {
    const p: Part = {
      id: 'P1',
      name: 'Boss',
      rollbackIndex: 2,
      annotations: [],
      features: [
        rect('PL', -50, -20, 100, 40, { w: '100 mm', h: '40 mm' }),
        extrude('E1', 'PL', 'new', { kind: 'blind', depth: '20 mm' }),
      ],
    };
    const plane = (z: number): AnnotationAnchor => ({
      kind: 'plane',
      origin: [0, 0, z],
      normal: [0, 0, z > 0 ? 1 : -1],
      outline: [
        [-50, -20, z],
        [50, -20, z],
        [50, 20, z],
      ],
    });
    const at =
      (z: number) =>
      (name: string): AnchorAnswer =>
        name === 'FE1:end'
          ? { anchor: plane(z) }
          : name.startsWith('origin') || name === 'FE1:start'
            ? { anchor: plane(0) }
            : { anchor: sideAnchor(p, name) };
    const d = topDrawing([
      {
        id: 'V1',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [200, 150] },
      },
    ]);
    const stale = byKey(plan(p, at(26), d)).get('feature:E1:/end/depth');
    expect(stale).toMatchObject({ reason: 'differsFromModel', checked: false });
    const fine = byKey(plan(p, at(20), d)).get('feature:E1:/end/depth');
    expect(fine?.reason).toBeUndefined();
    expect(fine?.placement).toBeDefined();
  });
});

describe('lanes along a stepped cut', () => {
  it('places a hole’s y from the centre line although the cut runs along that y', () => {
    // A 100 × 70 plate (top view) with a stepped section cut through the hole row y = 18 and on
    // to the row y = −18: the extension line of the hole's y = 18 runs along the cut line.
    const sk: SketchFeature = {
      id: 'H',
      type: 'sketch',
      name: 'Holes',
      suppressed: false,
      on: { name: 'origin:XY', kind: 'face' },
      entities: [{ id: 'cb', kind: 'point', construction: false, x: -30, y: 18 }],
      constraints: [
        { id: 'x', kind: 'hDistance', a: '@origin', b: 'cb', value: '-30 mm', driving: true },
        { id: 'y', kind: 'vDistance', a: '@origin', b: 'cb', value: '18 mm', driving: true },
      ],
    } as SketchFeature;
    const p: Part = { id: 'P1', name: 'Cover', rollbackIndex: 1, annotations: [], features: [sk] };
    const views: DrawingView[] = [
      {
        id: 'V1',
        sheetId: 'S1',
        kind: 'base',
        orientation: { kind: 'named', name: 'top' },
        layout: { kind: 'free', position: [215, 176.5] },
      },
      {
        id: 'V2',
        sheetId: 'S1',
        kind: 'section',
        parentId: 'V1',
        letter: 'A',
        cut: [
          { kind: 'free', at: [-55, 18] },
          { kind: 'free', at: [0, 18] },
          { kind: 'free', at: [0, -18] },
          { kind: 'free', at: [55, -18] },
        ],
        look: 'left',
        layout: { kind: 'free', position: [80, 242] },
      } as DrawingView,
    ];
    const d = topDrawing(views);
    let n = 0;
    const c = byKey(
      planImport({
        drawing: d,
        part: p,
        views: solveViews({
          drawing: d,
          bounds: { min: [-50, -35, 0], max: [50, 35, 14] },
          evaluate,
        }),
        resolutions: new Map(),
        sketchFrames: new Map([['H', { ...XY, origin: [0, 0, 14] }]]),
        moveViews: true,
        newId: () => `N${++n}`,
      }),
    );
    expect(c.get('sketch:H:y')?.reason).toBeUndefined();
    expect(c.get('sketch:H:y')?.placement?.layout).toMatchObject({ kind: 'lane', side: 'left' });
  });
});

describe('sphere diameters', () => {
  it('lays out a sphere anchored by its centre as a circle of its radius, SØ', () => {
    const d = drawing();
    const v = solveViews({
      drawing: d,
      bounds: { min: [0, 0, 0], max: [100, 60, 40] },
      evaluate,
    }).get('V1');
    if (!v?.ok) throw new Error('view');
    const a: Annotation = {
      id: 'S1',
      kind: 'diameter',
      origin: { kind: 'drawing', drawingId: 'D1' },
      refs: [{ name: 'FRV:side(SK:e(A1))', kind: 'face' }],
    };
    const res: AnnotationResolution = {
      annotationId: 'S1',
      state: 'ok',
      value: 50,
      measured: 50,
      anchors: [{ kind: 'point', at: [50, 30, 20] }],
    };
    const ctx: PlacementContext = {
      view: v,
      style: d.style,
      standard: d.standard.gps,
      evaluate: (e) => evalLength(e),
      annotations: new Map([[a.id, a]]),
      resolutions: new Map([[a.id, res]]),
      placed: new Map(),
      features: {},
    };
    const placement: AnnotationPlacement = {
      id: 'PL',
      viewId: 'V1',
      annotationId: 'S1',
      layout: { kind: 'radial', angle: 45, distance: 6 },
    };
    const out = layoutPlacement(placement, a, ctx);
    expect(out.attention).toBe(false);
    expect(out.issues).toEqual([]);
    const text = out.items.flatMap((i) => (i.kind === 'text' ? [i.text] : [])).join(' ');
    expect(text).toContain('50');
    expect(text).toMatch(/S/);
  });
});
