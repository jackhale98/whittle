import type {
  Annotation,
  AnnotationResolution,
  Drawing,
  Part,
  Vec3,
  ViewProjection,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  anchorLookup,
  type ImportInput,
  importAnchorQueries,
  importCommand,
  planImport,
  type SketchFrame,
} from '../src/import';
import { solveViews } from '../src/view';
import { ANNOTATIONS, drawing, evaluate, PART_BOUNDS, resolutions } from './fixtures';

const XY: SketchFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const TOP: SketchFrame = { origin: [0, 0, 40], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function part(annotations: Annotation[] = ANNOTATIONS): Part {
  return {
    id: 'P1',
    name: 'Bracket',
    rollbackIndex: 6,
    annotations,
    features: [
      {
        id: 'SK1',
        type: 'sketch',
        name: 'Sketch 1',
        suppressed: false,
        on: { name: 'origin:XY', kind: 'face' },
        entities: [
          { id: 'p1', kind: 'point', construction: false, x: 0, y: 0 },
          { id: 'p2', kind: 'point', construction: false, x: 90, y: 0 },
          { id: 'p3', kind: 'point', construction: false, x: 90, y: 60 },
          { id: 'l1', kind: 'line', construction: false, start: 'p1', end: 'p2' },
          { id: 'l2', kind: 'line', construction: false, start: 'p2', end: 'p3' },
        ],
        constraints: [
          { id: 'c1', kind: 'hDistance', a: 'p1', b: 'p2', value: '90 mm', driving: true },
          { id: 'c2', kind: 'length', line: 'l2', value: '60 mm', driving: true },
          { id: 'c3', kind: 'distance', a: 'p1', b: 'p3', value: '116 mm', driving: false },
          {
            id: 'c4',
            kind: 'offset',
            sources: ['l1'],
            targets: ['l2'],
            value: '5 mm',
            driving: true,
          },
        ],
      },
      {
        id: 'EX1',
        type: 'extrude',
        name: 'Extrude 1',
        suppressed: false,
        profile: [{ name: 'SSK1:region(l1,l2)', kind: 'region' }],
        direction: 'normal',
        end: { kind: 'blind', depth: '40 mm' },
        op: 'new',
      },
      {
        id: 'SK2',
        type: 'sketch',
        name: 'Sketch 2',
        suppressed: false,
        on: { name: 'FEX1:end', kind: 'face' },
        entities: [{ id: 'h1', kind: 'point', construction: false, x: 50, y: 30 }],
        constraints: [],
      },
      {
        id: 'HO1',
        type: 'hole',
        name: 'Hole 1',
        suppressed: false,
        points: [{ name: 'SSK2:p(h1)', kind: 'vertex' }],
        face: { name: 'FEX1:end', kind: 'face' },
        standard: 'ISO',
        kind: 'simple',
        size: 'M10',
        fit: 'normal',
        end: { kind: 'throughAll' },
      },
      {
        id: 'FI1',
        type: 'fillet',
        name: 'Fillet 1',
        suppressed: false,
        edges: [{ name: 'edge(FEX1:end|FEX1:side(SSK1:e(l1)))', kind: 'edge' }],
        radius: '3 mm',
      },
      {
        id: 'SH1',
        type: 'shell',
        name: 'Shell',
        suppressed: true,
        faces: [],
        thickness: '2 mm',
      } as unknown as Part['features'][number],
    ],
  };
}

function input(over: Partial<ImportInput> = {}, d: Drawing = drawing()): ImportInput {
  let n = 0;
  return {
    drawing: d,
    part: part(),
    views: solveViews({ drawing: d, bounds: PART_BOUNDS, evaluate }),
    resolutions: new Map(resolutions().map((r) => [r.annotationId, r])),
    sketchFrames: new Map([
      ['SK1', XY],
      ['SK2', TOP],
    ]),
    newId: () => `N${String(++n).padStart(3, '0')}`,
    ...over,
  };
}

const byKey = (plan: ReturnType<typeof planImport>) =>
  new Map(plan.candidates.map((c) => [c.key, c]));

describe('import model annotations', () => {
  it('lists existing annotations (checked) and promotable driving dimensions (unchecked)', () => {
    const plan = planImport(input());
    const c = byKey(plan);
    expect([...c.keys()].filter((k) => k.startsWith('annotation:'))).toEqual([
      'annotation:A1',
      'annotation:A2',
      'annotation:A3',
      'annotation:A4',
      'annotation:A5',
    ]);
    expect(c.get('annotation:A1')?.checked).toBe(true);
    expect(c.get('sketch:SK1:c1')).toMatchObject({ kind: 'promote', checked: false });
    expect(c.get('sketch:SK1:c2')?.annotation).toMatchObject({
      kind: 'aligned',
      refs: [{ name: 'SSK1:p(p2)' }, { name: 'SSK1:p(p3)' }],
      source: { kind: 'sketchDimension', featureId: 'SK1', constraintId: 'c2' },
    });
    // Reference (non-driving) dimensions are not promoted; offsets are not promotable in M4.
    expect(c.has('sketch:SK1:c3')).toBe(false);
    expect(plan.notPromotable.map((n) => n.path)).toContain('/constraints/c4');
    // Suppressed features are skipped.
    expect(plan.notPromotable.some((n) => n.featureId === 'SH1')).toBe(false);
  });
  it('picks the view where each annotation is seen true length', () => {
    const c = byKey(planImport(input()));
    expect(c.get('annotation:A1')?.viewId).toBe('V1'); // width: front (base before projected)
    expect(c.get('annotation:A3')?.viewId).toBe('V2'); // Ø20: circle face-on in the top view
    expect(c.get('sketch:SK1:c1')?.viewId).toBe('V2'); // sketch on XY: top view
    expect(c.get('feature:EX1:/end/depth')?.viewId).toBe('V1'); // depth along Z: front view
    expect(c.get('feature:HO1:')?.viewId).toBe('V2'); // hole axis Z: top view
    expect(c.get('feature:FI1:/radius')?.reason).toBe('noGeometry');
  });
  it('prefers the view where the refs are visible', () => {
    const proj: ViewProjection = {
      key: 'k',
      bounds: { min: [0, 0], max: [1, 1] },
      ms: 0,
      curves: [
        {
          role: 'visible',
          edge: 'sharp',
          name: 'F1:face.zmin',
          curve: { kind: 'line', a: [0, 0], b: [1, 0] },
        },
      ],
    };
    const projections = new Map([['V3', proj]]);
    const c = byKey(planImport(input({ projections })));
    expect(c.get('annotation:A2')?.viewId).toBe('V3');
  });
  it('assigns lanes: shortest nearest the outline, sharing when spans do not overlap', () => {
    const extra: Annotation[] = [
      ...ANNOTATIONS,
      {
        id: 'A6',
        kind: 'linear',
        origin: { kind: 'model' },
        refs: [
          { name: 'a', kind: 'vertex' },
          { name: 'b', kind: 'vertex' },
        ],
        direction: [1, 0, 0],
      },
      {
        id: 'A7',
        kind: 'linear',
        origin: { kind: 'model' },
        refs: [
          { name: 'c', kind: 'vertex' },
          { name: 'd', kind: 'vertex' },
        ],
        direction: [1, 0, 0],
      },
    ];
    const pt = (at: Vec3) => ({ kind: 'point' as const, at });
    const res: AnnotationResolution[] = [
      ...resolutions(),
      { annotationId: 'A6', state: 'ok', value: 20, anchors: [pt([0, 0, 40]), pt([20, 0, 40])] },
      { annotationId: 'A7', state: 'ok', value: 30, anchors: [pt([70, 0, 40]), pt([100, 0, 40])] },
    ];
    // Without the section: its cut line pokes out of the front view (see the next test).
    const d = drawing();
    d.views = d.views.filter((v) => v.id !== 'V4');
    const plan = planImport(
      input({ part: part(extra), resolutions: new Map(res.map((r) => [r.annotationId, r])) }, d),
    );
    const c = byKey(plan);
    const lane = (k: string) => {
      const l = c.get(k)?.placement?.layout;
      return l?.kind === 'lane' ? [l.side, l.lane] : null;
    };
    // A6 (20) and A7 (30) don't overlap: both lane 0; the 100 mm width A1 overlaps both: lane 1.
    expect(lane('annotation:A6')).toEqual(['top', 0]);
    expect(lane('annotation:A7')).toEqual(['top', 0]);
    expect(lane('annotation:A1')).toEqual(['top', 1]);
    expect(lane('annotation:A2')?.[0]).toBe('right');
  });
  it('never places an annotation twice and never re-promotes a promoted source', () => {
    const first = planImport(input());
    const cmd = importCommand(
      first,
      'D1',
      new Set(first.candidates.filter((c) => c.placement).map((c) => c.key)),
    );
    expect(cmd.kind).toBe('placeAnnotations');
    const promoted = cmd.items.filter((i) => i.annotation).map((i) => i.annotation as Annotation);
    expect(promoted.length).toBeGreaterThan(0);
    // Apply it the way the store would.
    const d = drawing({ placements: cmd.items.map((i) => i.placement) });
    const p = part([...ANNOTATIONS, ...promoted]);
    const second = planImport(input({ part: p, drawing: d }, d));
    expect(second.candidates.filter((c) => c.placement)).toEqual([]);
    expect(second.alreadyPlaced.length).toBe(cmd.items.length);
    expect(second.candidates.some((c) => c.kind === 'promote' && c.placement)).toBe(false);
  });
  it('places an already promoted, unplaced annotation instead of promoting again', () => {
    const existing: Annotation = {
      id: 'A9',
      kind: 'linear',
      origin: { kind: 'model' },
      refs: [
        { name: 'SSK1:p(p1)', kind: 'vertex' },
        { name: 'SSK1:p(p2)', kind: 'vertex' },
      ],
      direction: [1, 0, 0],
      source: { kind: 'sketchDimension', featureId: 'SK1', constraintId: 'c1' },
    };
    const plan = planImport(input({ part: part([...ANNOTATIONS, existing]) }));
    const c = byKey(plan);
    expect(c.has('sketch:SK1:c1')).toBe(false);
    expect(c.get('annotation:A9')?.reason).toBe('needsAttention'); // no resolution: listed, not placed
  });
  it('puts a frame bound to a size dimension under that dimension', () => {
    const frame: Annotation = {
      id: 'A8',
      kind: 'geometricTolerance',
      origin: { kind: 'model' },
      refs: [],
      characteristic: 'position',
      zone: { value: '0.1 mm', shape: 'diameter' },
      appliesTo: 'A3',
    };
    const res = [
      ...resolutions(),
      {
        annotationId: 'A8',
        state: 'ok' as const,
        anchors: [
          {
            kind: 'circle' as const,
            center: [50, 30, 40] as Vec3,
            normal: [0, 0, 1] as Vec3,
            radius: 10,
          },
        ],
      },
    ];
    const plan = planImport(
      input({
        part: part([...ANNOTATIONS, frame]),
        resolutions: new Map(res.map((r) => [r.annotationId, r])),
      }),
    );
    const c = byKey(plan);
    const dia = c.get('annotation:A3')?.placement;
    expect(c.get('annotation:A8')?.placement?.layout).toEqual({
      kind: 'leader',
      attach: { kind: 'placement', placementId: dia?.id },
      text: [0, 0],
    });
  });
  it('is deterministic and the command only carries checked candidates', () => {
    const a = planImport(input());
    const b = planImport(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const cmd = importCommand(a, 'D1');
    expect(cmd.items.every((i) => !i.annotation)).toBe(true);
    expect(cmd.items.map((i) => i.placement.annotationId)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });
  it('skips suppressed and needs-attention annotations with a reason', () => {
    const res = resolutions().map((r) =>
      r.annotationId === 'A1'
        ? { annotationId: 'A1', state: 'suppressed' as const }
        : r.annotationId === 'A2'
          ? { annotationId: 'A2', state: 'needsAttention' as const }
          : r,
    );
    const c = byKey(
      planImport(input({ resolutions: new Map(res.map((r) => [r.annotationId, r])) })),
    );
    expect(c.get('annotation:A1')).toMatchObject({ reason: 'suppressed', checked: false });
    expect(c.get('annotation:A2')).toMatchObject({ reason: 'needsAttention', checked: false });
  });
  it('promotes a revolve angle as the supplement of its faces’ normals, placed by anchors', () => {
    const revolve = {
      id: 'RV1',
      type: 'revolve' as const,
      name: 'Revolve',
      suppressed: false,
      profile: [{ name: 'SSK1:region(l1,l2)', kind: 'region' as const }],
      axis: { name: 'origin:Z', kind: 'edge' as const },
      angle: '90 deg',
      direction: 'normal' as const,
      op: 'add' as const,
    };
    const p0 = part();
    const p1: Part = {
      ...p0,
      features: [...p0.features.slice(0, 5), revolve, ...p0.features.slice(5)],
      rollbackIndex: 7,
    };
    const queries = importAnchorQueries(p1, new Map([['SK1', XY]]));
    const faces = queries.filter((q) => q.ref.name.startsWith('FRV1:'));
    expect(faces.map((q) => [q.ref.name, q.annotationKind])).toEqual([
      ['FRV1:start', 'angle'],
      ['FRV1:end', 'angle'],
    ]);
    // Start face in the XZ plane, end face in the YZ plane: normals 90° apart about Z.
    const answers = queries.map((q) =>
      q.ref.name === 'FRV1:start'
        ? {
            anchor: {
              kind: 'plane' as const,
              origin: [0, 0, 0] as Vec3,
              normal: [0, -1, 0] as Vec3,
              outline: [
                [10, 0, 0],
                [50, 0, 0],
                [50, 0, 40],
              ] as Vec3[],
            },
          }
        : q.ref.name === 'FRV1:end'
          ? {
              anchor: {
                kind: 'plane' as const,
                origin: [0, 0, 0] as Vec3,
                normal: [-1, 0, 0] as Vec3,
                outline: [
                  [0, 10, 0],
                  [0, 50, 0],
                  [0, 50, 40],
                ] as Vec3[],
              },
            }
          : { anchor: null },
    );
    const c = byKey(planImport(input({ part: p1, anchors: anchorLookup(queries, answers) })));
    const rv = c.get('feature:RV1:/angle');
    expect(rv?.annotation).toMatchObject({
      kind: 'angle',
      measure: 'supplement',
      refs: [{ name: 'FRV1:start' }, { name: 'FRV1:end' }],
      source: { kind: 'featureField', featureId: 'RV1', path: '/angle' },
    });
    expect(rv?.viewId).toBe('V2'); // the angle's plane is face-on from above
    expect(rv?.placement?.layout.kind).toBe('arc');
    // Without answers it is listed, never placed on a guess.
    const none = byKey(planImport(input({ part: p1 })));
    expect(none.get('feature:RV1:/angle')).toMatchObject({ reason: 'noGeometry', checked: false });
    expect(none.get('feature:RV1:/angle')?.annotation).toMatchObject({ measure: 'supplement' });
  });
});
