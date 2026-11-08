/**
 * The demo bracket (welcome panel sample): the M1 acceptance part (PLAN §12) as an editable
 * document — a base plate with four holes, an upright sketched on the plate's top face, corner and
 * bend fillets and a chamfer, every size driven by a parameter, in aluminium 6061-T6. Same feature
 * list as the regen engine's bracket golden test (packages/kernel-client/test/regen/bracket.ts),
 * plus a second row of holes. Each call returns a fresh copy (new document, part and feature ids).
 */

import type {
  ChamferFeature,
  DimensionConstraint,
  EntityRef,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  GeometricConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  WhittleDoc,
} from '@whittle/contracts';
import { materialFromLibrary, newDoc, ulid } from '@whittle/document';

export const BRACKET_PARAMS: Record<string, string> = {
  width: '80 mm',
  depth: '50 mm',
  thickness: '8 mm',
  hole_d: '6 mm',
  hole_spacing: '40 mm',
  hole_rows: '20 mm',
  height: '40 mm',
  corner_r: '5 mm',
  bend_r: '3 mm',
  chamfer_d: '2 mm',
};

type GeoDraft = GeometricConstraint extends infer C
  ? C extends GeometricConstraint
    ? Omit<C, 'id'>
    : never
  : never;
type DimDraft = DimensionConstraint extends infer C
  ? C extends DimensionConstraint
    ? Omit<C, 'id' | 'value' | 'driving'>
    : never
  : never;

/** Small sketch builder (entity ids are local to the sketch). */
class Sk {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  private n = 0;
  point(id: string, x: number, y: number, construction = false): string {
    this.entities.push({ id, kind: 'point', x, y, construction });
    return id;
  }
  line(id: string, a: string, b: string): string {
    this.entities.push({ id, kind: 'line', start: a, end: b, construction: false });
    return id;
  }
  circle(id: string, cx: number, cy: number, r: number): string {
    const c = this.point(`${id}c`, cx, cy);
    this.entities.push({ id, kind: 'circle', center: c, radius: r, construction: false });
    return id;
  }
  geo(c: GeoDraft): void {
    this.n += 1;
    this.constraints.push({ ...c, id: `k${this.n}` } as SketchConstraint);
  }
  dim(c: DimDraft, value: string): void {
    this.n += 1;
    this.constraints.push({ ...c, id: `d${this.n}`, value, driving: true } as SketchConstraint);
  }
  rect(
    p: string,
    l: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    w?: string,
    h?: string,
  ) {
    const a = this.point(`${p}a`, x0, y0);
    const b = this.point(`${p}b`, x1, y0);
    const c = this.point(`${p}c`, x1, y1);
    const d = this.point(`${p}d`, x0, y1);
    this.line(`${l}1`, a, b);
    this.line(`${l}2`, b, c);
    this.line(`${l}3`, c, d);
    this.line(`${l}4`, d, a);
    this.geo({ kind: 'horizontal', line: `${l}1` });
    this.geo({ kind: 'horizontal', line: `${l}3` });
    this.geo({ kind: 'vertical', line: `${l}2` });
    this.geo({ kind: 'vertical', line: `${l}4` });
    if (w !== undefined) this.dim({ kind: 'hDistance', a, b }, w);
    if (h !== undefined) this.dim({ kind: 'vDistance', a: b, b: c }, h);
    return { a, b, c, d };
  }
  feature(id: Id, name: string, on: EntityRef): SketchFeature {
    return {
      id,
      type: 'sketch',
      name,
      suppressed: false,
      on,
      entities: this.entities,
      constraints: this.constraints,
    };
  }
}

const region = (sketchId: Id, body: string): EntityRef => ({
  name: `S${sketchId}:region(${body})`,
  kind: 'region',
});
const side = (extrudeId: Id, sketchId: Id, entity: string) =>
  `F${extrudeId}:side(S${sketchId}:e(${entity}))`;
const edge = (a: string, b: string): EntityRef => ({
  name: `edge(${[a, b].sort().join('|')})`,
  kind: 'edge',
});

function extrude(
  id: Id,
  name: string,
  profile: EntityRef[],
  depth: string | 'throughAll',
  op: ExtrudeFeature['op'] = 'new',
  direction: ExtrudeFeature['direction'] = 'normal',
): ExtrudeFeature {
  return {
    id,
    type: 'extrude',
    name,
    suppressed: false,
    profile,
    direction,
    end: depth === 'throughAll' ? { kind: 'throughAll' } : { kind: 'blind', depth },
    op,
  };
}

export function bracketFeatures(): Feature[] {
  const [S1, E1, S2, E2, S3, E3, F1, F2, C1] = Array.from({ length: 9 }, () => ulid()) as [
    Id,
    Id,
    Id,
    Id,
    Id,
    Id,
    Id,
    Id,
    Id,
  ];
  // The plate's top face, as the user picked it (fingerprint at the original size).
  const plateTop: EntityRef = {
    name: `F${E1}:end`,
    kind: 'face',
    fingerprint: { centroid: [40, 25, 8], normal: [0, 0, 1], area: 4000 },
  };

  const s1 = new Sk();
  const r1 = s1.rect('p', 'L', 0, 0, 80, 50, 'width', 'depth');
  s1.geo({ kind: 'fix', entity: r1.a });

  // Four holes on the plate's top face, centred on the free area in front of the upright.
  const s2 = new Sk();
  s2.point('o', 0, 0, true);
  s2.geo({ kind: 'fix', entity: 'o' });
  const holes = [
    ['H1', 20, 11, 'width/2 - hole_spacing/2', '(depth - thickness)/2 - hole_rows/2'],
    ['H2', 60, 11, 'width/2 + hole_spacing/2', '(depth - thickness)/2 - hole_rows/2'],
    ['H3', 20, 31, 'width/2 - hole_spacing/2', '(depth - thickness)/2 + hole_rows/2'],
    ['H4', 60, 31, 'width/2 + hole_spacing/2', '(depth - thickness)/2 + hole_rows/2'],
  ] as const;
  for (const [h, x, y, ex, ey] of holes) {
    s2.circle(h, x, y, 3);
    s2.dim({ kind: 'diameter', curve: h }, 'hole_d');
    s2.dim({ kind: 'hDistance', a: 'o', b: `${h}c` }, ex);
    s2.dim({ kind: 'vDistance', a: 'o', b: `${h}c` }, ey);
  }

  // The upright's footprint along the back edge.
  const s3 = new Sk();
  s3.point('o', 0, 0, true);
  s3.geo({ kind: 'fix', entity: 'o' });
  const r3 = s3.rect('q', 'M', 0, 42, 80, 50, 'width', 'thickness');
  s3.geo({ kind: 'verticalPoints', a: 'o', b: r3.a });
  s3.dim({ kind: 'vDistance', a: 'o', b: r3.a }, 'depth - thickness');

  const fillet = (id: Id, name: string, edges: EntityRef[], radius: string): FilletFeature => ({
    id,
    type: 'fillet',
    name,
    suppressed: false,
    edges,
    radius,
  });
  const chamfer: ChamferFeature = {
    id: C1,
    type: 'chamfer',
    name: 'Top chamfer',
    suppressed: false,
    edges: [edge(`F${E3}:end`, side(E3, S3, 'M1'))],
    mode: { kind: 'distance', distance: 'chamfer_d' },
  };

  return [
    s1.feature(S1, 'Plate sketch', { name: 'origin:XY', kind: 'face' }),
    extrude(E1, 'Plate', [region(S1, 'L1,L2,L3,L4')], 'thickness'),
    s2.feature(S2, 'Hole sketch', plateTop),
    extrude(
      E2,
      'Holes',
      holes.map(([h]) => region(S2, h)),
      'throughAll',
      'cut',
      'reverse',
    ),
    s3.feature(S3, 'Upright sketch', plateTop),
    extrude(E3, 'Upright', [region(S3, 'M1,M2,M3,M4')], 'height', 'add'),
    fillet(
      F1,
      'Corner fillets',
      [edge(side(E1, S1, 'L4'), side(E1, S1, 'L1')), edge(side(E1, S1, 'L1'), side(E1, S1, 'L2'))],
      'corner_r',
    ),
    fillet(F2, 'Bend fillet', [edge(`F${E1}:end`, side(E3, S3, 'M1'))], 'bend_r'),
    chamfer,
  ];
}

/** A fresh, editable copy of the demo bracket. */
export function demoBracket(): WhittleDoc {
  const doc = newDoc({ name: 'Demo bracket' });
  const features = bracketFeatures();
  const material = materialFromLibrary('whittle:aluminium-6061-t6');
  return {
    ...doc,
    meta: { ...doc.meta, id: ulid() },
    params: Object.entries(BRACKET_PARAMS).map(([name, expr]) => ({ id: ulid(), name, expr })),
    parts: [
      {
        id: ulid(),
        name: 'Bracket',
        features,
        rollbackIndex: features.length,
        ...(material ? { material } : {}),
      },
    ],
  };
}

/** Analytic volume (mm³) of the demo bracket for given dimensions (tests). */
export function demoBracketVolume(d: {
  width: number;
  depth: number;
  thickness: number;
  hole_d: number;
  height: number;
  corner_r: number;
  bend_r: number;
  chamfer_d: number;
}): number {
  const k = 1 - Math.PI / 4;
  return (
    d.width * d.depth * d.thickness -
    4 * Math.PI * (d.hole_d / 2) ** 2 * d.thickness -
    2 * k * d.corner_r ** 2 * d.thickness +
    d.width * d.thickness * d.height +
    k * d.bend_r ** 2 * d.width -
    0.5 * d.chamfer_d ** 2 * d.width
  );
}
