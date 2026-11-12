/**
 * Turns a reference part's step list into a `WrenDoc` (the contract types, built with the
 * packages/document factories). Deterministic: the same part and dimensions give the same document.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityKind,
  EntityRef,
  Feature,
  Id,
  SketchConstraint,
  SketchEntity,
  WrenDoc,
} from '@wren-cad/contracts';
import { materialFromLibrary, newDoc } from '@wren-cad/document';
import {
  type Dims,
  dimGetter,
  type Ex,
  type PartDef,
  type Pick,
  type SketchOp,
  type Step,
} from './types';

const NOW = '2026-11-09T00:00:00.000Z';

/** Evaluate an expression over the dimensions (plain arithmetic, no units). */
export function evalEx(expr: Ex, dims: Dims): number {
  const names = Object.keys(dims);
  const fn = new Function(...names, 'pi', `return (${expr});`) as (...a: number[]) => number;
  const v = fn(...names.map((n) => dims[n] as number), Math.PI);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`bad expression: ${expr}`);
  return v;
}

/** Deterministic feature id for step `index` (0-based) of part `no`: a 26-character string. */
export function stepFid(no: number, index: number): Id {
  return `01JRP${String(no).padStart(2, '0')}${String(index + 1).padStart(3, '0')}`.padEnd(26, '0');
}

const KIND: Record<Pick['pick'], EntityKind> = {
  face: 'face',
  plane: 'face',
  edge: 'edge',
  axis: 'edge',
  vertex: 'vertex',
  point: 'vertex',
  region: 'region',
  body: 'body',
};

type Resolve = (s: string) => string;

function regionName(p: Pick, ids: Map<string, Id>): string {
  const sk = ids.get(p.sketch ?? '');
  if (sk === undefined) throw new Error(`pick: unknown sketch ${p.sketch}`);
  const outer = [...(p.curves ?? [])].sort().join(',');
  const inner = (p.inner ?? [])
    .map((l) => [...l].sort().join(','))
    .sort()
    .map((l) => `|${l}`)
    .join('');
  return `S${sk}:region(${outer}${inner})`;
}

export function pickToRef(p: Pick, resolve: Resolve, ids: Map<string, Id>): EntityRef {
  const name = p.curves !== undefined ? regionName(p, ids) : resolve(p.name ?? '');
  return { name, kind: KIND[p.pick] };
}

function isPick(v: unknown): v is Pick {
  return typeof v === 'object' && v !== null && typeof (v as { pick?: unknown }).pick === 'string';
}

function mapValue(v: unknown, resolve: Resolve, ids: Map<string, Id>): unknown {
  if (isPick(v)) return pickToRef(v, resolve, ids);
  if (Array.isArray(v)) return v.map((x) => mapValue(x, resolve, ids));
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = mapValue(x, resolve, ids);
    // CopySource.features lists feature ids: they are step ids in the spec.
    if (o.kind === 'features' && Array.isArray(o.features)) {
      out.features = (o.features as string[]).map((s) => {
        const id = ids.get(s);
        if (id === undefined) throw new Error(`copy source: unknown step ${s}`);
        return id;
      });
    }
    return out;
  }
  if (typeof v === 'string') return resolve(v);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Sketches
// ---------------------------------------------------------------------------------------------

class SketchBuilder {
  entities: SketchEntity[] = [];
  constraints: SketchConstraint[] = [];
  private nk = 0;
  private nd = 0;

  constructor(
    private readonly dims: Dims,
    private readonly resolvePick: (p: Pick) => EntityRef,
  ) {
    this.entities.push({ id: 'o', kind: 'point', x: 0, y: 0, construction: true });
    this.geo({ kind: 'fix', entity: 'o' });
  }

  private n(e: Ex): number {
    return evalEx(e, this.dims);
  }
  private geo(c: Record<string, unknown>): void {
    this.nk += 1;
    this.constraints.push({ ...c, id: `k${this.nk}` } as unknown as SketchConstraint);
  }
  private dim(c: Record<string, unknown>, value: Ex): void {
    this.nd += 1;
    this.constraints.push({ ...c, id: `d${this.nd}`, value, driving: true } as SketchConstraint);
  }
  private pt(id: string, x: number, y: number, construction = false): string {
    this.entities.push({ id, kind: 'point', x, y, construction });
    return id;
  }
  private place(id: string, ex: Ex, ey: Ex, dims: 'xy' | 'x' | 'y' | 'none' = 'xy'): void {
    if (dims === 'xy' || dims === 'x') this.dim({ kind: 'hDistance', a: 'o', b: id }, ex);
    if (dims === 'xy' || dims === 'y') this.dim({ kind: 'vDistance', a: 'o', b: id }, ey);
  }

  op(o: SketchOp): void {
    switch (o.op) {
      case 'rect': {
        const x = this.n(o.x);
        const y = this.n(o.y);
        const w = this.n(o.w);
        const h = this.n(o.h);
        const a = this.pt(`${o.id}a`, x, y);
        const b = this.pt(`${o.id}b`, x + w, y);
        const c = this.pt(`${o.id}c`, x + w, y + h);
        const d = this.pt(`${o.id}d`, x, y + h);
        const l = [a, b, c, d].map((s, i) => {
          const e = [b, c, d, a][i] as string;
          this.entities.push({
            id: `${o.id}${i + 1}`,
            kind: 'line',
            start: s,
            end: e,
            construction: false,
          });
          return `${o.id}${i + 1}`;
        });
        this.geo({ kind: 'horizontal', line: l[0] });
        this.geo({ kind: 'horizontal', line: l[2] });
        this.geo({ kind: 'vertical', line: l[1] });
        this.geo({ kind: 'vertical', line: l[3] });
        this.dim({ kind: 'hDistance', a, b }, o.w);
        this.dim({ kind: 'vDistance', a: b, b: c }, o.h);
        this.place(a, o.x, o.y);
        return;
      }
      case 'circle': {
        const c = this.pt(`${o.id}c`, this.n(o.cx), this.n(o.cy));
        this.entities.push({
          id: o.id,
          kind: 'circle',
          center: c,
          radius: this.n(o.d) / 2,
          construction: false,
        });
        this.dim({ kind: 'diameter', curve: o.id }, o.d);
        this.place(c, o.cx, o.cy);
        return;
      }
      case 'point': {
        this.pt(o.id, this.n(o.x), this.n(o.y), o.construction === true);
        this.place(o.id, o.x, o.y, o.dims ?? 'xy');
        if (o.align === 'h') this.geo({ kind: 'horizontalPoints', a: 'o', b: o.id });
        if (o.align === 'v') this.geo({ kind: 'verticalPoints', a: 'o', b: o.id });
        return;
      }
      case 'line': {
        this.entities.push({
          id: o.id,
          kind: 'line',
          start: o.a,
          end: o.b,
          construction: o.construction === true,
        });
        return;
      }
      case 'arc': {
        this.entities.push({
          id: o.id,
          kind: 'arc',
          center: o.c,
          start: o.a,
          end: o.b,
          construction: false,
        });
        if (o.radius !== undefined) this.dim({ kind: 'radius', curve: o.id }, o.radius);
        return;
      }
      case 'polygon': {
        const ids = o.pts.map(([ex, ey], i) => {
          const id = `${o.id}p${i + 1}`;
          this.pt(id, this.n(ex), this.n(ey));
          this.place(id, ex, ey);
          return id;
        });
        ids.forEach((s, i) => {
          this.entities.push({
            id: `${o.id}${i + 1}`,
            kind: 'line',
            start: s,
            end: ids[(i + 1) % ids.length] as string,
            construction: false,
          });
        });
        return;
      }
      case 'convert': {
        const a = this.pt(`${o.id}a`, o.a[0], o.a[1]);
        const b = this.pt(`${o.id}b`, o.b[0], o.b[1]);
        this.entities.push({
          id: o.id,
          kind: 'line',
          start: a,
          end: b,
          construction: false,
          source: { ref: this.resolvePick(o.source) },
        });
        return;
      }
      case 'offsetRect': {
        const d = this.n(o.distance);
        const [x0, y0, x1, y1] = o.bounds;
        const pts: [number, number][] = [
          [x0 + d, y0 + d],
          [x1 - d, y0 + d],
          [x1 - d, y1 - d],
          [x0 + d, y1 - d],
        ];
        const ids = pts.map((p, i) => this.pt(`${o.id}${'abcd'[i]}`, p[0], p[1]));
        const lines = ids.map((s, i) => {
          this.entities.push({
            id: `${o.id}${i + 1}`,
            kind: 'line',
            start: s,
            end: ids[(i + 1) % 4] as string,
            construction: false,
          });
          return `${o.id}${i + 1}`;
        });
        this.geo({ kind: 'horizontal', line: lines[0] });
        this.geo({ kind: 'horizontal', line: lines[2] });
        this.geo({ kind: 'vertical', line: lines[1] });
        this.geo({ kind: 'vertical', line: lines[3] });
        this.dim({ kind: 'offset', sources: o.sources, targets: lines }, o.distance);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

const NON_FIELDS = new Set(['tool', 'id', 'say', 'name', 'ops', 'on']);

const DEFAULT_NAMES: Record<string, string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  boolean: 'Combine',
  pushPull: 'Push/pull',
  plane: 'Plane',
  axis: 'Axis',
  point: 'Point',
  shell: 'Shell',
  draft: 'Draft',
  sweep: 'Sweep',
  loft: 'Loft',
  mirror: 'Mirror',
  linearPattern: 'Linear pattern',
  circularPattern: 'Circular pattern',
  hole: 'Hole',
};

/** Feature types in a step list (what the kernel must support to regenerate it). */
export function stepTypes(steps: Step[]): Set<string> {
  return new Set(steps.map((s) => s.tool));
}

export function buildFeatures(no: number, steps: Step[], dims: Dims): Feature[] {
  const ids = new Map<string, Id>();
  steps.forEach((s, i) => {
    if (ids.has(s.id)) throw new Error(`duplicate step id ${s.id}`);
    ids.set(s.id, stepFid(no, i));
  });
  const resolve: Resolve = (s) =>
    s.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, id: string) => {
      const v = ids.get(id);
      if (v === undefined) throw new Error(`unknown step {${id}} in "${s}"`);
      return v;
    });
  const refOf = (p: Pick) => pickToRef(p, resolve, ids);

  return steps.map((s) => {
    const base = {
      id: ids.get(s.id) as Id,
      type: s.tool,
      name: s.name ?? DEFAULT_NAMES[s.tool] ?? s.tool,
      suppressed: false,
    };
    if (s.tool === 'sketch') {
      const sb = new SketchBuilder(dims, refOf);
      for (const o of s.ops ?? []) sb.op(o);
      if (s.on === undefined) throw new Error(`sketch ${s.id} has no plane`);
      return {
        ...base,
        type: 'sketch',
        on: refOf(s.on),
        entities: sb.entities,
        constraints: sb.constraints,
      } as Feature;
    }
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) {
      if (!NON_FIELDS.has(k)) rest[k] = mapValue(v, resolve, ids);
    }
    return { ...base, ...rest } as unknown as Feature;
  });
}

export function paramExpr(value: number, unit: string): string {
  return unit === '' ? String(value) : `${value} ${unit}`;
}

/** The document for a part at the given dimensions (default: the baseline). */
export function buildDoc(part: PartDef, dims: Dims = baselineDims(part)): WrenDoc {
  const doc = newDoc({ name: part.title, now: NOW });
  doc.params = Object.entries(part.dims).map(([name, d], i) => ({
    id: stepFid(part.no, 900 + i),
    name,
    expr: paramExpr(dims[name] ?? d.value, d.unit),
    description: d.description,
  }));
  // Steps are built from the baseline so that every initial sketch position is consistent with
  // the stored geometry; stages change only the parameters (see `stageDoc`).
  const features = buildFeatures(
    part.no,
    part.steps(dimGetter(baselineDims(part))),
    baselineDims(part),
  );
  const material = materialFromLibrary(part.material);
  if (material === undefined) throw new Error(`unknown material ${part.material}`);
  doc.parts = [
    {
      id: stepFid(part.no, 999),
      name: part.title,
      features,
      rollbackIndex: features.length,
      material,
    },
  ];
  return doc;
}

export function baselineDims(part: PartDef): Dims {
  return Object.fromEntries(Object.entries(part.dims).map(([k, v]) => [k, v.value]));
}

/** Dimensions after applying a stage's changes. */
export function stageDims(part: PartDef, set: Record<string, number>): Dims {
  const d = baselineDims(part);
  for (const [k, v] of Object.entries(set)) {
    if (!(k in d)) throw new Error(`${part.id}: stage sets unknown dimension ${k}`);
    d[k] = v;
  }
  return d;
}

/** The baseline document with only the stage's parameters changed (what a person does in the UI). */
export function stageDoc(part: PartDef, set: Record<string, number>): WrenDoc {
  const doc = buildDoc(part);
  for (const p of doc.params) {
    const v = set[p.name];
    if (v !== undefined) p.expr = paramExpr(v, part.dims[p.name]?.unit ?? '');
  }
  return doc;
}
