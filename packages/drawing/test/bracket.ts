/**
 * The demo bracket (apps/web `samples/bracket.ts`, the M1 acceptance part with four holes) for the
 * import planner, scaled by `k` (a model resize), with a stand-in for the kernel's
 * `annotationAnchors`: the anchors the regen reports for its refs, computed from the known
 * geometry. Plate 80 × 50 × 8, upright 80 × 8 × 40 along the back edge (its start face is fused
 * into the plate, so `F<E3>:start` does not resolve), Ø6 holes at x 20/60, y 11/31, corner R5,
 * bend R3, a 2 mm chamfer on the upright's top front edge.
 */

import type {
  AnchorAnswer,
  AnchorQuery,
  Annotation,
  AnnotationAnchor,
  AnnotationResolution,
  Drawing,
  DrawingView,
  EntityRef,
  ExtrudeFeature,
  Feature,
  Id,
  Part,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  Vec3,
} from '@wren-cad/contracts';
import type { SketchFrame } from '../src/import';
import { anchorPoints } from '../src/placement';
import { standardPreset, stylePreset } from '../src/style';

export const ID = {
  S1: 'S1',
  E1: 'E1',
  S2: 'S2',
  E2: 'E2',
  S3: 'S3',
  E3: 'E3',
  F1: 'F1',
  F2: 'F2',
  C1: 'C1',
} as const;

const side = (e: string, s: string, entity: string) => `F${e}:side(S${s}:e(${entity}))`;
const edgeName = (a: string, b: string) => `edge(${[a, b].sort().join('|')})`;

class Sk {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  private n = 0;
  constructor(private k: number) {}
  point(id: string, x: number, y: number, construction = false): string {
    this.entities.push({ id, kind: 'point', x: x * this.k, y: y * this.k, construction });
    return id;
  }
  line(id: string, a: string, b: string) {
    this.entities.push({ id, kind: 'line', start: a, end: b, construction: false });
  }
  circle(id: string, x: number, y: number, r: number) {
    const c = this.point(`${id}c`, x, y);
    this.entities.push({ id, kind: 'circle', center: c, radius: r * this.k, construction: false });
  }
  dim(c: Record<string, unknown>, value: string) {
    this.n += 1;
    this.constraints.push({ ...c, id: `d${this.n}`, value, driving: true } as SketchConstraint);
  }
  rect(p: string, l: string, x0: number, y0: number, x1: number, y1: number, w: string, h: string) {
    const a = this.point(`${p}a`, x0, y0);
    const b = this.point(`${p}b`, x1, y0);
    const c = this.point(`${p}c`, x1, y1);
    const d = this.point(`${p}d`, x0, y1);
    this.line(`${l}1`, a, b);
    this.line(`${l}2`, b, c);
    this.line(`${l}3`, c, d);
    this.line(`${l}4`, d, a);
    this.dim({ kind: 'hDistance', a, b }, w);
    this.dim({ kind: 'vDistance', a: b, b: c }, h);
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

const plateTopRef: EntityRef = { name: `F${ID.E1}:end`, kind: 'face' };

export function bracketPart(k = 1): Part {
  const s1 = new Sk(k);
  s1.rect('p', 'L', 0, 0, 80, 50, 'width', 'depth');
  const s2 = new Sk(k);
  s2.point('o', 0, 0, true);
  for (const [h, x, y] of [
    ['H1', 20, 11],
    ['H2', 60, 11],
    ['H3', 20, 31],
    ['H4', 60, 31],
  ] as const) {
    s2.circle(h, x, y, 3);
    s2.dim({ kind: 'diameter', curve: h }, 'hole_d');
    s2.dim({ kind: 'hDistance', a: 'o', b: `${h}c` }, 'x');
    s2.dim({ kind: 'vDistance', a: 'o', b: `${h}c` }, 'y');
  }
  const s3 = new Sk(k);
  s3.point('o', 0, 0, true);
  const r3 = s3.rect('q', 'M', 0, 42, 80, 50, 'width', 'thickness');
  s3.dim({ kind: 'vDistance', a: 'o', b: r3.a }, 'depth - thickness');
  const extrude = (
    id: Id,
    profile: string,
    end: ExtrudeFeature['end'],
    op: 'new' | 'add' | 'cut',
    direction: 'normal' | 'reverse' = 'normal',
  ): Feature => ({
    id,
    type: 'extrude',
    name: id,
    suppressed: false,
    profile: [{ name: profile, kind: 'region' }],
    direction,
    end,
    op,
  });
  const features: Feature[] = [
    s1.feature(ID.S1, 'Plate sketch', { name: 'origin:XY', kind: 'face' }),
    extrude(ID.E1, `S${ID.S1}:region(L1,L2,L3,L4)`, { kind: 'blind', depth: 'thickness' }, 'new'),
    s2.feature(ID.S2, 'Hole sketch', plateTopRef),
    extrude(ID.E2, `S${ID.S2}:region(H1)`, { kind: 'throughAll' }, 'cut', 'reverse'),
    s3.feature(ID.S3, 'Upright sketch', plateTopRef),
    extrude(ID.E3, `S${ID.S3}:region(M1,M2,M3,M4)`, { kind: 'blind', depth: 'height' }, 'add'),
    {
      id: ID.F1,
      type: 'fillet',
      name: 'Corner fillets',
      suppressed: false,
      edges: [
        { name: edgeName(side(ID.E1, ID.S1, 'L4'), side(ID.E1, ID.S1, 'L1')), kind: 'edge' },
        { name: edgeName(side(ID.E1, ID.S1, 'L1'), side(ID.E1, ID.S1, 'L2')), kind: 'edge' },
      ],
      radius: 'corner_r',
    },
    {
      id: ID.F2,
      type: 'fillet',
      name: 'Bend fillet',
      suppressed: false,
      edges: [{ name: edgeName(`F${ID.E1}:end`, side(ID.E3, ID.S3, 'M1')), kind: 'edge' }],
      radius: 'bend_r',
    },
    {
      id: ID.C1,
      type: 'chamfer',
      name: 'Top chamfer',
      suppressed: false,
      edges: [{ name: edgeName(`F${ID.E3}:end`, side(ID.E3, ID.S3, 'M1')), kind: 'edge' }],
      mode: { kind: 'distance', distance: 'chamfer_d' },
    },
  ];
  return { id: 'P1', name: 'Bracket', features, rollbackIndex: features.length, annotations: [] };
}

export function bracketFrames(k = 1): Map<Id, SketchFrame> {
  const at = (z: number): SketchFrame => ({
    origin: [0, 0, z],
    x: [1, 0, 0],
    y: [0, 1, 0],
    z: [0, 0, 1],
  });
  return new Map([
    [ID.S1, at(0)],
    [ID.S2, at(8 * k)],
    [ID.S3, at(8 * k)],
  ]);
}

export function bracketBounds(k = 1): { min: Vec3; max: Vec3 } {
  return { min: [0, 0, 0], max: [80 * k, 50 * k, 48 * k] };
}

/** What the kernel answers for one query on the bracket at scale `k` (part mm). */
export function bracketAnchor(q: AnchorQuery, k = 1): AnchorAnswer {
  const s = (v: Vec3): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
  const plane = (normal: Vec3, outline: Vec3[]): AnnotationAnchor => ({
    kind: 'plane',
    origin: s(outline[0] as Vec3),
    normal,
    outline: outline.map(s),
  });
  const name = q.ref.name;
  const part = bracketPart(k);
  const sk = /^S([^:]+):(p|e)\((.+)\)$/.exec(name);
  if (sk) {
    const f = part.features.find((x) => x.id === sk[1]) as SketchFeature;
    const z = sk[1] === ID.S1 ? 0 : 8 * k;
    const byId = new Map(f.entities.map((e) => [e.id, e]));
    const e = byId.get(sk[3] as string);
    const pt = (id: string): Vec3 => {
      const p = byId.get(id);
      if (p?.kind !== 'point') throw new Error(id);
      return [p.x, p.y, z];
    };
    if (e?.kind === 'point') return { anchor: { kind: 'point', at: pt(e.id) } };
    if (e?.kind === 'circle')
      return {
        anchor: { kind: 'circle', center: pt(e.center), normal: [0, 0, 1], radius: e.radius },
      };
    if (e?.kind === 'line') return { anchor: { kind: 'line', a: pt(e.start), b: pt(e.end) } };
  }
  switch (name) {
    case 'origin:XY':
      return { anchor: { kind: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], outline: [] } };
    case `F${ID.E1}:start`:
      return {
        anchor: plane(
          [0, 0, -1],
          [
            [0, 0, 0],
            [80, 0, 0],
            [80, 50, 0],
            [0, 50, 0],
          ],
        ),
      };
    case `F${ID.E1}:end`:
      return {
        anchor: plane(
          [0, 0, 1],
          [
            [0, 0, 8],
            [80, 0, 8],
            [80, 39, 8],
            [0, 39, 8],
          ],
        ),
      };
    case `F${ID.E3}:end`:
      return {
        anchor: plane(
          [0, 0, 1],
          [
            [0, 44, 48],
            [80, 44, 48],
            [80, 50, 48],
            [0, 50, 48],
          ],
        ),
      };
    case `F${ID.E3}:start`:
      // Fused into the plate by the add: gone from the final body.
      return {
        anchor: null,
        unresolved: {
          path: '/0',
          ref: q.ref,
          reason: 'missing',
        },
      };
  }
  if (name.startsWith(`F${ID.F1}:fillet(`))
    return {
      anchor: {
        kind: 'circle',
        center: s([5, 5, 8]),
        normal: [0, 0, 1],
        radius: 5 * k,
        start: s([0, 5, 8]),
        end: s([5, 0, 8]),
      },
    };
  if (name.startsWith(`F${ID.F2}:fillet(`))
    return {
      anchor: {
        kind: 'circle',
        center: s([80, 39, 11]),
        normal: [1, 0, 0],
        radius: 3 * k,
        start: s([80, 39, 8]),
        end: s([80, 42, 11]),
      },
    };
  if (name.startsWith(`F${ID.C1}:chamfer(`))
    return {
      anchor: {
        kind: 'plane',
        origin: s([0, 42, 46]),
        normal: [0, -Math.SQRT1_2, Math.SQRT1_2],
        outline: [
          [0, 42, 46],
          [80, 42, 46],
          [80, 44, 48],
          [0, 44, 48],
        ].map((p) => s(p as Vec3)),
      },
    };
  return {
    anchor: null,
    unresolved: { path: '/0', ref: q.ref, reason: 'missing' },
  };
}

/** Resolutions of annotations made by the import, as the regen would report them at scale k. */
export function bracketResolutions(annotations: readonly Annotation[], k = 1) {
  const out = new Map<Id, AnnotationResolution>();
  for (const a of annotations) {
    const anchors = a.refs.map(
      (ref, i) =>
        bracketAnchor({ ref, ...(a.at?.[i] ? { at: a.at[i] } : {}), annotationKind: a.kind }, k)
          .anchor,
    );
    if (anchors.some((x) => x === null)) {
      out.set(a.id, { annotationId: a.id, state: 'needsAttention', anchors });
      continue;
    }
    let value: number | undefined;
    const pts = anchors.map((an, i) => anchorPoints(an as AnnotationAnchor, a.at?.[i]));
    const mean = (ps: Vec3[]) =>
      [0, 1, 2].map((c) => ps.reduce((acc, p) => acc + (p[c] as number), 0) / ps.length) as Vec3;
    if ((a.kind === 'linear' || a.kind === 'aligned') && pts[0] && pts[1]) {
      const p = mean(pts[0]);
      const q = mean(pts[1]);
      const d = a.kind === 'linear' && a.direction ? a.direction : null;
      value = d
        ? Math.abs((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1] + (q[2] - p[2]) * d[2])
        : Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    }
    const c = anchors[0];
    if ((a.kind === 'radius' || a.kind === 'diameter') && c?.kind === 'circle')
      value = a.kind === 'radius' ? c.radius : 2 * c.radius;
    out.set(a.id, {
      annotationId: a.id,
      state: 'ok',
      anchors,
      ...(value !== undefined ? { value, measured: value } : {}),
    });
  }
  return out;
}

/**
 * The drawing the app makes for the bracket (`newDrawing` + "Add standard views" + a section
 * across the front view): A3 landscape ISO at 1:1, the front view 8 mm inside the usable area,
 * the top and side views at the app's aligned distance (half extents + 25 mm), the section in
 * free space to the right.
 */
export function bracketDrawing(projection: 'first' | 'third'): Drawing {
  // Usable area of A3 ISO (frame 20/10 mm, title block 180 × 56): x 30…400, y 76…277.
  const w = 80;
  const h = 48;
  const x = 30 + w / 2 + 8;
  const y = projection === 'first' ? 277 - h / 2 - 8 : 76 + h / 2 + 8;
  const sideFrom = projection === 'first' ? 'left' : 'right';
  const views: DrawingView[] = [
    {
      id: 'VF',
      sheetId: 'S1',
      kind: 'base',
      orientation: { kind: 'named', name: 'front' },
      layout: { kind: 'free', position: [x, y] },
    },
    {
      id: 'VT',
      sheetId: 'S1',
      kind: 'projected',
      parentId: 'VF',
      from: 'top',
      layout: { kind: 'aligned', distance: 24 + 25 + 25 },
    },
    {
      id: 'VS',
      sheetId: 'S1',
      kind: 'projected',
      parentId: 'VF',
      from: sideFrom,
      layout: { kind: 'aligned', distance: 40 + 25 + 25 },
    },
    {
      id: 'VX',
      sheetId: 'S1',
      kind: 'section',
      parentId: 'VF',
      letter: 'A',
      // Across the front view at half height, from just inside its left edge to its right one.
      cut: [
        { kind: 'free', at: [1, 24] },
        { kind: 'free', at: [79, 24] },
      ],
      look: 'left',
      layout: { kind: 'free', position: [330, projection === 'first' ? 230 : 150] },
    },
  ];
  return {
    id: 'D1',
    name: 'Bracket drawing',
    subject: { kind: 'part', partId: 'P1' },
    standard: standardPreset('iso'),
    projection,
    units: 'mm',
    style: stylePreset('iso'),
    template: { id: 'iso-5457', version: 1 },
    sheets: [
      { id: 'S1', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale: '1' },
    ],
    views,
    placements: [],
    centerMarks: [],
    tables: [],
    notes: [],
  };
}
