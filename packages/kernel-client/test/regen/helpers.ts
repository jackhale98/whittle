/**
 * Shared helpers for the regen golden suite: a real kernel (Node, single-threaded build) + real
 * planegcs behind `createModelingApi`, and small document builders.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  BodyResult,
  ChamferFeature,
  DimensionConstraint,
  EntityRef,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  GeometricConstraint,
  Id,
  Part,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  Vec3,
  WhittleDoc,
} from '@whittle/contracts';
import { newDoc } from '@whittle/document';
import type { KernelInitModule } from '@whittle/kernel';
import { createModelingApi, type ModelingApiDeps } from '../../src/modeling-api';
import type { RegenOutput } from '../../src/regen/engine';

const dist = fileURLToPath(new URL('../../../kernel/dist/', import.meta.url));
export const built = existsSync(`${dist}init.single.js`) && existsSync(`${dist}init.multi.js`);
export const skipNote = built
  ? ''
  : ' — SKIPPED: packages/kernel/dist missing; run `pnpm --filter @whittle/kernel build`';

export const variants: ModelingApiDeps['variants'] = {
  single: {
    load: () => import(pathToFileURL(`${dist}init.single.js`).href) as Promise<KernelInitModule>,
  },
  threaded: {
    load: () => import(pathToFileURL(`${dist}init.multi.js`).href) as Promise<KernelInitModule>,
  },
};

export type Api = ReturnType<typeof createModelingApi>;

export async function loadApi(
  regen?: ModelingApiDeps['regen'],
  variant: 'single' | 'threaded' = 'single',
): Promise<Api> {
  const api = createModelingApi({
    variants,
    canUseThreads: () => variant === 'threaded',
    ...(regen === undefined ? {} : { regen }),
  });
  const r = await api.init({ variant });
  if (!r.ok) throw new Error(`kernel init failed: ${JSON.stringify(r.error)}`);
  return api;
}

// ---------------------------------------------------------------------------------------------
// Ids (fixed, readable, valid name characters)
// ---------------------------------------------------------------------------------------------

/** A 26-char id like `01JS1000000000000000000000` from a short tag. */
export function fid(tag: string): Id {
  return `01J${tag.toUpperCase()}`.padEnd(26, '0');
}

// ---------------------------------------------------------------------------------------------
// Sketch builders
// ---------------------------------------------------------------------------------------------

export class Sk {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  /** Deterministic per sketch, so rebuilding a document yields identical definitions. */
  private n = 0;
  private nextId(p: string): string {
    this.n += 1;
    return `${p}${this.n}`;
  }

  point(id: string, x: number, y: number, construction = false): string {
    this.entities.push({ id, kind: 'point', x, y, construction });
    return id;
  }
  line(id: string, a: string, b: string, construction = false): string {
    this.entities.push({ id, kind: 'line', start: a, end: b, construction });
    return id;
  }
  circle(id: string, cx: number, cy: number, r: number): string {
    const c = this.point(`${id}c`, cx, cy);
    this.entities.push({ id, kind: 'circle', center: c, radius: r, construction: false });
    return id;
  }
  geo(
    c: GeometricConstraint extends infer C
      ? C extends GeometricConstraint
        ? Omit<C, 'id'>
        : never
      : never,
  ): void {
    this.constraints.push({ ...c, id: this.nextId('k') } as SketchConstraint);
  }
  dim(
    c: DimensionConstraint extends infer C
      ? C extends DimensionConstraint
        ? Omit<C, 'id' | 'value' | 'driving'>
        : never
      : never,
    value: string,
    id = this.nextId('d'),
  ): string {
    this.constraints.push({ ...c, id, value, driving: true } as SketchConstraint);
    return id;
  }

  /**
   * Axis-aligned rectangle with corner points `${p}a` (x0,y0) … `${p}d`, lines `${l}1` (bottom),
   * `${l}2` (right), `${l}3` (top), `${l}4` (left); horizontal/vertical constraints and, when
   * given, width/height dimensions.
   */
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

  feature(id: Id, on: EntityRef | string = 'origin:XY', name = 'Sketch'): SketchFeature {
    return {
      id,
      type: 'sketch',
      name,
      suppressed: false,
      on: typeof on === 'string' ? { name: on, kind: 'face' } : on,
      entities: this.entities,
      constraints: this.constraints,
    };
  }
}

export const region = (sketchId: Id, body: string): EntityRef => ({
  name: `S${sketchId}:region(${body})`,
  kind: 'region',
});

export function extrude(
  id: Id,
  profile: EntityRef[],
  depth: string | 'throughAll',
  op: ExtrudeFeature['op'] = 'new',
  direction: ExtrudeFeature['direction'] = 'normal',
  extra: Partial<ExtrudeFeature> = {},
): ExtrudeFeature {
  return {
    id,
    type: 'extrude',
    name: 'Extrude',
    suppressed: false,
    profile,
    direction,
    end: depth === 'throughAll' ? { kind: 'throughAll' } : { kind: 'blind', depth },
    op,
    ...extra,
  };
}

export const edge = (name: string, fingerprint?: EntityRef['fingerprint']): EntityRef =>
  fingerprint === undefined ? { name, kind: 'edge' } : { name, kind: 'edge', fingerprint };

export function fillet(id: Id, edges: EntityRef[], radius: string): FilletFeature {
  return { id, type: 'fillet', name: 'Fillet', suppressed: false, edges, radius };
}

export function chamfer(id: Id, edges: EntityRef[], distance: string): ChamferFeature {
  return {
    id,
    type: 'chamfer',
    name: 'Chamfer',
    suppressed: false,
    edges,
    mode: { kind: 'distance', distance },
  };
}

/** Name helpers for extrude faces. */
export const side = (extrudeId: Id, sketchId: Id, entity: string) =>
  `F${extrudeId}:side(S${sketchId}:e(${entity}))`;
export const edgeName = (a: string, b: string) => `edge(${[a, b].sort().join('|')})`;

export function makeDoc(
  params: Record<string, string>,
  features: Feature[],
  partId = fid('PART'),
): WhittleDoc {
  const doc = newDoc({ name: 'Test', now: '2026-11-08T00:00:00.000Z' });
  doc.params = Object.entries(params).map(([name, expr], i) => ({
    id: fid(`P${i}`),
    name,
    expr,
  }));
  const part: Part = {
    id: partId,
    name: 'Bracket',
    features,
    rollbackIndex: features.length,
  };
  doc.parts = [part];
  return doc;
}

export function withParams(doc: WhittleDoc, changes: Record<string, string>): WhittleDoc {
  const next = structuredClone(doc);
  for (const p of next.params) {
    const v = changes[p.name];
    if (v !== undefined) p.expr = v;
  }
  return next;
}

export function part(doc: WhittleDoc): Part {
  return doc.parts[0] as Part;
}

export function relClose(actual: number, expected: number, rel: number): void {
  if (!(Math.abs(actual - expected) <= rel * Math.max(1, Math.abs(expected)))) {
    throw new Error(`expected ${expected}, got ${actual} (rel tol ${rel})`);
  }
}

export function states(r: RegenOutput): string[] {
  return r.features.map((f) => f.state);
}

export function describeFailures(r: RegenOutput): string {
  return JSON.stringify(
    r.features.filter((f) => f.state !== 'ok'),
    null,
    1,
  );
}

export function totalVolume(bodies: BodyResult[]): number {
  return bodies.reduce((s, b) => s + (b.massProperties?.volume ?? Number.NaN), 0);
}

/** Centroid of a named face of a body, via the api's fingerprints. */
export async function faceCentroid(api: Api, body: BodyResult, name: string): Promise<Vec3 | null> {
  const idx = body.mesh.faceNames.indexOf(name);
  if (idx < 0) return null;
  const fp = await api.fingerprints(body.shape);
  if (!fp.ok) return null;
  return fp.value.faces[idx]?.centroid ?? null;
}

export function facesStartingWith(body: BodyResult, prefix: string): string[] {
  return body.mesh.faceNames.filter((n) => n.startsWith(prefix));
}
