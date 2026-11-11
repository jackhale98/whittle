// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Annotation,
  BooleanFeature,
  ChamferFeature,
  Drawing,
  DrawingStyle,
  EntityRef,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  PlaneFeature,
  PrimitiveFeature,
  PushPullFeature,
  RevolveFeature,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { MATERIALS, newDoc } from '../src';

/** Deterministic 26-char ULID-shaped ids for fixtures. */
export const id = (n: number): string => `01J${String(n).padStart(23, '0')}`;

export const ref = (name: string, kind: EntityRef['kind'] = 'face'): EntityRef => ({ name, kind });

const base = (n: number, name: string) => ({ id: id(n), name, suppressed: false });

export const box = (n: number, over: Partial<PrimitiveFeature> = {}): PrimitiveFeature =>
  ({
    ...base(n, `Box ${n}`),
    type: 'primitive',
    shape: 'box',
    op: 'new',
    dx: '40mm',
    dy: '30mm',
    dz: '20mm',
    ...over,
  }) as PrimitiveFeature;

export function sketch(n: number, over: Partial<SketchFeature> = {}): SketchFeature {
  const p = (k: number) => id(n * 100 + k);
  return {
    ...base(n, `Sketch ${n}`),
    type: 'sketch',
    on: ref('origin:XY'),
    entities: [
      { id: p(1), kind: 'point', construction: false, x: 0, y: 0 },
      { id: p(2), kind: 'point', construction: false, x: 40, y: 0 },
      { id: p(3), kind: 'point', construction: false, x: 40, y: 30 },
      { id: p(4), kind: 'point', construction: false, x: 0, y: 30 },
      { id: p(5), kind: 'line', construction: false, start: p(1), end: p(2) },
      { id: p(6), kind: 'line', construction: false, start: p(2), end: p(3) },
      { id: p(7), kind: 'line', construction: false, start: p(3), end: p(4) },
      { id: p(8), kind: 'line', construction: false, start: p(4), end: p(1) },
      { id: p(9), kind: 'circle', construction: false, center: p(1), radius: 5 },
    ],
    constraints: [
      { id: p(20), kind: 'horizontal', line: p(5) },
      { id: p(21), kind: 'length', line: p(5), value: 'width', driving: true },
      { id: p(22), kind: 'length', line: p(6), value: '30mm', driving: true },
      { id: p(23), kind: 'length', line: p(7), value: 'not evaluated', driving: false },
      { id: p(24), kind: 'diameter', curve: p(9), value: '10', driving: true },
      { id: p(25), kind: 'angle', a: p(5), b: p(6), value: '90deg', driving: true },
    ],
    ...over,
  };
}

export const extrude = (
  n: number,
  sketchN: number,
  over: Partial<ExtrudeFeature> = {},
): ExtrudeFeature => ({
  ...base(n, `Extrude ${n}`),
  type: 'extrude',
  profile: [
    ref(`S${id(sketchN)}:region(${id(sketchN * 100 + 5)},${id(sketchN * 100 + 6)})`, 'region'),
  ],
  direction: 'normal',
  end: { kind: 'blind', depth: 'depth' },
  op: 'new',
  draft: '2deg',
  ...over,
});

export const revolve = (n: number, sketchN: number): RevolveFeature => ({
  ...base(n, `Revolve ${n}`),
  type: 'revolve',
  profile: [ref(`S${id(sketchN)}:region(${id(sketchN * 100 + 5)})`, 'region')],
  axis: ref('origin:Y', 'edge'),
  angle: '180deg',
  direction: 'normal',
  op: 'add',
});

export const fillet = (n: number, extrudeN: number): FilletFeature => ({
  ...base(n, `Fillet ${n}`),
  type: 'fillet',
  edges: [ref(`F${id(extrudeN)}:edge(start|side)`, 'edge')],
  radius: '2mm + 1/16in',
});

export const chamferDist = (n: number, extrudeN: number): ChamferFeature => ({
  ...base(n, `Chamfer ${n}`),
  type: 'chamfer',
  edges: [ref(`F${id(extrudeN)}:edge(end|side)`, 'edge')],
  mode: { kind: 'distance', distance: '1mm' },
});

export const chamferAngle = (n: number, extrudeN: number): ChamferFeature => ({
  ...base(n, `Chamfer ${n}`),
  type: 'chamfer',
  edges: [ref(`F${id(extrudeN)}:edge(end|side)`, 'edge')],
  mode: { kind: 'distanceAngle', distance: '1mm', angle: '45' },
});

export const booleanCut = (n: number, a: number, b: number): BooleanFeature => ({
  ...base(n, `Cut ${n}`),
  type: 'boolean',
  op: 'cut',
  target: ref(`B${id(a)}`, 'body'),
  tools: [ref(`B${id(b)}`, 'body')],
  keepTools: false,
});

export const pushPull = (n: number, extrudeN: number): PushPullFeature => ({
  ...base(n, `Push/Pull ${n}`),
  type: 'pushPull',
  faces: [ref(`F${id(extrudeN)}:end`)],
  distance: '-2mm',
});

export const planeOffset = (n: number): PlaneFeature => ({
  ...base(n, `Plane ${n}`),
  type: 'plane',
  definition: { kind: 'offset', from: ref('origin:XY', 'face'), distance: 'depth / 2' },
});

export const planeFrame = (n: number): PlaneFeature => ({
  ...base(n, `Plane ${n}`),
  type: 'plane',
  definition: { kind: 'frame', frame: { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] } },
});

export const cylinder = (n: number): PrimitiveFeature => ({
  ...base(n, `Cylinder ${n}`),
  type: 'primitive',
  shape: 'cylinder',
  op: 'add',
  radius: '5mm',
  height: '1in',
});

export const sphere = (n: number): PrimitiveFeature => ({
  ...base(n, `Sphere ${n}`),
  type: 'primitive',
  shape: 'sphere',
  op: 'add',
  radius: 'depth / 4',
});

/** A complete ISO-ish drawing style (sheet mm). */
export const style = (): DrawingStyle => ({
  lineGroup: 'iso-0.35',
  text: { dimension: 3.5, note: 3.5, viewLabel: 5, title: 7 },
  font: 'osifont',
  dimension: {
    extensionGap: 1,
    extensionOvershoot: 1.5,
    arrow: { kind: 'filledClosed', length: 3, angle: 15 },
    firstLane: 10,
    laneSpacing: 7,
    textOrientation: 'aligned',
    textPosition: 'above',
  },
  numbers: {
    decimal: '.',
    lengthPrecision: 2,
    anglePrecision: 1,
    trailingZeros: 'strip',
    angleFormat: 'decimal',
  },
  hatch: { pattern: 'iso-general', angle: 45, spacing: 3 },
  view: {
    lines: 'visible',
    tangentEdges: 'thin',
    centerMarks: true,
    centerLines: true,
    threads: true,
  },
});

/** A v4 annotation set exercising every kind but the hole callout (ids 900+, sorted). */
export function sampleAnnotations(): Annotation[] {
  const model = { kind: 'model' } as const;
  return [
    {
      id: id(900),
      kind: 'linear',
      origin: model,
      refs: [ref(`F${id(12)}:start`), ref(`F${id(12)}:end`)],
      direction: [1, 0, 0],
      source: { kind: 'featureField', featureId: id(12), path: '/end/depth' },
      tolerance: { kind: 'bilateral', upper: '0.1mm', lower: '-0.1mm' },
    },
    {
      id: id(901),
      kind: 'angle',
      origin: model,
      refs: [ref('S11:e(a)', 'edge'), ref('S11:e(b)', 'edge')],
      nominal: '30deg',
      tolerance: { kind: 'symmetric', value: '1deg' },
    },
    {
      id: id(902),
      kind: 'diameter',
      origin: { kind: 'drawing', drawingId: id(5) },
      refs: [ref('S23:e(c)', 'edge')],
      at: ['self'],
      nominal: '10mm',
      tolerance: { kind: 'fit', hole: 'H7', show: 'symbolAndDeviations' },
      text: { prefix: '4×', precision: 2 },
    },
    {
      id: id(903),
      kind: 'datumFeature',
      origin: model,
      refs: [ref(`F${id(12)}:start`)],
      label: 'A',
    },
    { id: id(904), kind: 'datumFeature', origin: model, refs: [ref(`F${id(12)}:end`)], label: 'B' },
    {
      id: id(905),
      kind: 'geometricTolerance',
      origin: model,
      refs: [],
      standard: 'ISO 1101:2017',
      characteristic: 'position',
      zone: { value: '0.1mm', shape: 'diameter', material: 'mmc' },
      datums: [{ datums: [{ datum: id(903) }] }, { datums: [{ datum: id(904) }] }],
      appliesTo: id(902),
    },
    {
      id: id(906),
      kind: 'note',
      origin: model,
      refs: [ref(`F${id(12)}:start`)],
      text: 'BREAK SHARP EDGES',
    },
    {
      id: id(907),
      kind: 'surfaceFinish',
      origin: model,
      refs: [ref(`F${id(12)}:start`)],
      process: 'removalRequired',
      requirements: [{ parameter: 'Ra', value: '1.6um' }],
      allowance: '0.2mm',
    },
    {
      id: id(908),
      kind: 'chamfer',
      origin: model,
      refs: [ref(`F${id(15)}:chamfer(e1)`)],
      form: 'distanceAngle',
      source: { kind: 'feature', featureId: id(15) },
    },
  ];
}

/** A full v4 drawing of the Bracket part: every view kind, placement layout and table kind. */
export function sampleDrawing(): Drawing {
  const sheet = (n: number) => ({
    id: id(n),
    name: `Sheet ${n - 5049}`,
    format: { size: 'A3' as const, orientation: 'landscape' as const },
    scale: '1/2',
  });
  return {
    id: id(5),
    name: 'Bracket drawing',
    subject: { kind: 'part', partId: id(3) },
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'third',
    units: 'mm',
    style: style(),
    template: { id: 'iso-5457', version: 1, fields: { owner: 'Wren' } },
    sheets: [sheet(5050), sheet(5051)],
    views: [
      {
        id: id(5060),
        sheetId: id(5050),
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [120, 150] },
      },
      {
        id: id(5061),
        sheetId: id(5050),
        kind: 'projected',
        parentId: id(5060),
        from: 'top',
        layout: { kind: 'aligned', distance: 70 },
      },
      {
        id: id(5062),
        sheetId: id(5050),
        kind: 'section',
        parentId: id(5060),
        letter: 'A',
        cut: [
          { kind: 'free', at: [-30, 0] },
          { kind: 'ref', ref: ref('S23:e(c)', 'edge'), point: 'center', offset: [-40, 0] },
        ],
        look: 'left',
        depth: 'full',
        layout: { kind: 'free', position: [260, 150] },
      },
      {
        id: id(5063),
        sheetId: id(5051),
        kind: 'detail',
        parentId: id(5060),
        letter: 'B',
        center: { kind: 'free', at: [10, 5] },
        radius: 12,
        scale: '2',
        layout: { kind: 'free', position: [100, 100] },
      },
      {
        id: id(5064),
        sheetId: id(5051),
        kind: 'iso',
        parentId: id(5060),
        corner: 'topRight',
        layout: { kind: 'free', position: [250, 100] },
      },
    ],
    placements: [
      {
        id: id(5070),
        viewId: id(5060),
        annotationId: id(900),
        layout: { kind: 'lane', side: 'bottom', lane: 0 },
      },
      {
        id: id(5071),
        viewId: id(5060),
        annotationId: id(902),
        layout: { kind: 'radial', angle: 45, distance: 6 },
        text: { shift: 1.5 },
      },
      {
        id: id(5072),
        viewId: id(5060),
        annotationId: id(905),
        layout: {
          kind: 'leader',
          attach: { kind: 'placement', placementId: id(5071) },
          text: [0, -8],
        },
      },
      {
        id: id(5073),
        viewId: id(5061),
        annotationId: id(901),
        layout: { kind: 'arc', radius: 12 },
      },
      {
        id: id(5074),
        viewId: id(5061),
        annotationId: id(903),
        layout: {
          kind: 'leader',
          attach: { kind: 'ref', index: 0, t: 0.5 },
          bends: [[4, 4]],
          text: [8, 8],
          landing: 'auto',
        },
        witness: { flip: true, hide: [false, true] },
        arrows: 'auto',
      },
      {
        id: id(5075),
        viewId: id(5061),
        annotationId: id(908),
        layout: { kind: 'offset', distance: 9 },
      },
    ],
    centerMarks: [
      { id: id(5080), viewId: id(5060), kind: 'centerMark', refs: [ref('S23:e(c)', 'edge')] },
    ],
    tables: [
      {
        id: id(5081),
        sheetId: id(5050),
        kind: 'partProperties',
        position: [410, 10],
        anchor: 'bottomRight',
        columns: ['partNumber', 'material', 'mass'],
        rows: { kind: 'drawing' },
      },
      {
        id: id(5082),
        sheetId: id(5050),
        kind: 'holeTable',
        position: [10, 280],
        anchor: 'topLeft',
        viewId: id(5061),
        origin: { kind: 'free', at: [0, 0] },
        holes: 'all',
      },
    ],
    notes: [{ id: id(5083), sheetId: id(5050), position: [15, 40], text: 'ALL DIMENSIONS IN MM' }],
    markup: [
      {
        id: id(5084),
        sheetId: id(5050),
        versionId: 'v1',
        author: 'reviewer',
        at: '2026-01-02T03:04:05.000Z',
        strokes: [
          {
            points: [
              [1, 1],
              [5, 5],
            ],
            width: 0.5,
          },
        ],
        anchor: { placementId: id(5070) },
      },
    ],
  };
}

/** A document exercising every feature type, a material, params, annotations and a drawing. */
export function sampleDoc(): WrenDoc {
  const doc = newDoc({ name: 'Bracket', now: '2026-01-02T03:04:05.000Z', app: 'wren/test' });
  const filletF: Feature = fillet(14, 12);
  const features: Feature[] = [
    sketch(11),
    extrude(12, 11),
    box(13),
    filletF,
    chamferDist(15, 12),
    chamferAngle(16, 12),
    cylinder(17),
    sphere(18),
    booleanCut(19, 12, 13),
    pushPull(20, 12),
    planeOffset(21),
    planeFrame(22),
    sketch(23),
    revolve(24, 23),
    {
      ...base(25, 'bracket'),
      type: 'import',
      source: {
        path: `imports/${id(25)}.step`,
        format: 'step',
        sha256: '0f'.repeat(32),
        fileName: 'bracket.step',
      },
      op: 'new',
    },
  ];
  doc.params = [
    { id: id(1), name: 'width', expr: '40mm', description: 'Overall width' },
    { id: id(2), name: 'depth', expr: 'width / 2 + 0.25in' },
  ];
  doc.parts = [
    {
      id: id(3),
      name: 'Bracket',
      features,
      rollbackIndex: features.length,
      material: structuredClone(MATERIALS[2] as NonNullable<WrenDoc['parts'][0]['material']>),
      color: '#9aa4b2',
      annotations: sampleAnnotations(),
    },
    { id: id(4), name: 'Bracket', features: [box(40)], rollbackIndex: 1 },
  ];
  doc.drawings = [sampleDrawing()];
  doc.drawingDefaults = {
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'third',
    fields: { owner: 'Wren' },
  };
  doc.assemblies = [{ id: id(6), name: 'Asm' }];
  return doc;
}

/** Non-null access for tests (throws instead of using `!`). */
export function req<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}
