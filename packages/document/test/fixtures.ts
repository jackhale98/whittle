// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  BooleanFeature,
  ChamferFeature,
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

/** A document exercising every feature type, a material and params. */
export function sampleDoc(): WrenDoc {
  const doc = newDoc({ name: 'Bracket', now: '2026-01-02T03:04:05.000Z', app: 'wren/test' });
  // v4: annotations are part-level (ADR-090); the M4 document workstream adds them here.
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
    },
    { id: id(4), name: 'Bracket', features: [box(40)], rollbackIndex: 1 },
  ];
  // v4: a full drawing fixture comes with the M4 document workstream.
  doc.drawings = [];
  doc.assemblies = [{ id: id(6), name: 'Asm' }];
  return doc;
}

/** Non-null access for tests (throws instead of using `!`). */
export function req<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}
