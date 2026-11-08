/**
 * Small document builders for E2E scenarios that need a specific starting model (loaded through
 * `__whittleApp.load`, then edited through the UI). Ids are fixed and readable.
 */

import type {
  EntityRef,
  ExtrudeFeature,
  Feature,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  WhittleDoc,
} from '@whittle/contracts';

export const fid = (tag: string): string => `01J${tag.toUpperCase()}`.padEnd(26, '0');

export class Sk {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  private n = 0;
  point(id: string, x: number, y: number, construction = false): string {
    this.entities.push({ id, kind: 'point', x, y, construction });
    return id;
  }
  geo(c: Record<string, unknown>): void {
    this.n += 1;
    this.constraints.push({ ...c, id: `k${this.n}` } as unknown as SketchConstraint);
  }
  dim(c: Record<string, unknown>, value: string): void {
    this.n += 1;
    this.constraints.push({
      ...c,
      id: `d${this.n}`,
      value,
      driving: true,
    } as unknown as SketchConstraint);
  }
  /** Rectangle: points `${p}a…d`, lines `${l}1` bottom, `${l}2` right, `${l}3` top, `${l}4` left. */
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
    const line = (id: string, s: string, e: string) =>
      this.entities.push({ id, kind: 'line', start: s, end: e, construction: false });
    line(`${l}1`, a, b);
    line(`${l}2`, b, c);
    line(`${l}3`, c, d);
    line(`${l}4`, d, a);
    this.geo({ kind: 'horizontal', line: `${l}1` });
    this.geo({ kind: 'horizontal', line: `${l}3` });
    this.geo({ kind: 'vertical', line: `${l}2` });
    this.geo({ kind: 'vertical', line: `${l}4` });
    if (w) this.dim({ kind: 'hDistance', a, b }, w);
    if (h) this.dim({ kind: 'vDistance', a: b, b: c }, h);
    return { a, b, c, d };
  }
  feature(
    id: string,
    name: string,
    on: EntityRef = { name: 'origin:XY', kind: 'face' },
  ): SketchFeature {
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

export const region = (sketchId: string, body: string): EntityRef => ({
  name: `S${sketchId}:region(${body})`,
  kind: 'region',
});
export const side = (extrudeId: string, sketchId: string, entity: string) =>
  `F${extrudeId}:side(S${sketchId}:e(${entity}))`;
export const edgeName = (a: string, b: string) => `edge(${[a, b].sort().join('|')})`;

export function extrude(
  id: string,
  name: string,
  profile: EntityRef[],
  depth: string,
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
    end: { kind: 'blind', depth },
    op,
  };
}

export function docWith(
  name: string,
  params: Record<string, string>,
  features: Feature[],
): WhittleDoc {
  const now = '2026-11-08T00:00:00.000Z';
  return {
    schemaVersion: 1,
    units: { length: 'mm', angle: 'deg' },
    params: Object.entries(params).map(([n, expr], i) => ({ id: fid(`PRM${i}`), name: n, expr })),
    parts: [{ id: fid('PART'), name: 'Part', features, rollbackIndex: features.length }],
    assemblies: [],
    drawings: [],
    meta: {
      id: fid(`DOC${name.replace(/\W/g, '').slice(0, 6)}`),
      name,
      created: now,
      modified: now,
      app: 'whittle/e2e',
    },
  };
}

/**
 * Plate 80 × 50 × 10 with a 20 × 20 × 4 pocket at `pocket_x`, a fillet on the pocket's corner
 * edge and a chamfer on the plate's front top edge (regen golden "a dimension change that removes
 * the referenced edge"). Moving the pocket off the plate (pocket_x = 200) removes the fillet's
 * edge: needs attention.
 */
export function pocketDoc(): WhittleDoc {
  const S1 = fid('S1');
  const E1 = fid('E1');
  const PS = fid('PS');
  const P = fid('PK');
  const FI = fid('FI');
  const plate = new Sk();
  const r = plate.rect('p', 'L', 0, 0, 80, 50, '80', '50');
  plate.geo({ kind: 'fix', entity: r.a });
  const top: EntityRef = { name: `F${E1}:end`, kind: 'face' };
  const pocket = new Sk();
  pocket.point('o', 0, 0, true);
  pocket.geo({ kind: 'fix', entity: 'o' });
  const q = pocket.rect('q', 'N', 30, 15, 50, 35, '20', '20');
  pocket.dim({ kind: 'hDistance', a: 'o', b: q.a }, 'pocket_x');
  pocket.dim({ kind: 'vDistance', a: 'o', b: q.a }, '15');
  const corner: EntityRef = {
    name: edgeName(side(P, PS, 'N1'), side(P, PS, 'N2')),
    kind: 'edge',
    fingerprint: { centroid: [50, 15, 8], length: 4 },
  };
  return docWith('Pocket plate', { pocket_x: '30 mm' }, [
    plate.feature(S1, 'Plate sketch'),
    extrude(E1, 'Plate', [region(S1, 'L1,L2,L3,L4')], '10'),
    pocket.feature(PS, 'Pocket sketch', top),
    extrude(P, 'Pocket', [region(PS, 'N1,N2,N3,N4')], '4', 'cut', 'reverse'),
    {
      id: FI,
      type: 'fillet',
      name: 'Pocket fillet',
      suppressed: false,
      edges: [corner],
      radius: '2',
    },
  ]);
}
