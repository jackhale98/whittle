/**
 * A scripted fake kernel for regen-engine unit tests (no Wasm): shapes are lists of named planar
 * faces, straight edges and vertices with exact fingerprints and closest-point measurement, so the
 * engine's reference resolution, geometry probes and input assembly can be checked call by call.
 *
 * It models just enough of the M3 façade behaviour (naming.ts "M3 additions") to test the engine:
 * boxes (primitive), sketches (points, lines, one region), construction planes, holes (a wall face
 * per point), mirror / pattern copies of tool shapes (`F…:inst<k>(N)`, `F…:mirror(N)`, honouring
 * `skip`), shell (`F…:shell(N)`), and in-place copies for draft / fillet / chamfer / sweep / loft.
 * Every `execFeature` call is recorded with its feature and inputs.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  Feature,
  FeatureInputs,
  FeatureResult,
  Frame,
  MassProperties,
  Measurement,
  MeshBuffers,
  NamingMap,
  Result,
  ShapeFingerprints,
  ShapeHandle,
  SketchFeature,
  Vec3,
} from '@wren-cad/contracts';
import type { MeasureSubject } from '../../src/kernel-api';
import type { RegenEngineDeps, SketchSolve } from '../../src/regen/engine';
import type { ProjectedCurve, ProjectionApi } from '../../src/regen/linked';

export interface FFace {
  name: string;
  centroid: Vec3;
  normal?: Vec3;
  area: number;
  surface?: string;
}
export interface FEdge {
  name: string;
  a: Vec3;
  b: Vec3;
}
export interface FShape {
  faces: FFace[];
  edges: FEdge[];
  vertices: { name: string; point: Vec3 }[];
  volume: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Axis-aligned box `[min, max]` named like the M0 primitive box. */
export function boxShape(tag: string, min: Vec3, max: Vec3): FShape {
  const c = mul(add(min, max), 0.5);
  const d = sub(max, min);
  const faces: FFace[] = [];
  const axes = ['x', 'y', 'z'] as const;
  axes.forEach((ax, k) => {
    for (const side of ['min', 'max'] as const) {
      const n: Vec3 = [0, 0, 0];
      n[k] = side === 'min' ? -1 : 1;
      const centroid: Vec3 = [...c];
      centroid[k] = side === 'min' ? (min[k] as number) : (max[k] as number);
      const others = [0, 1, 2].filter((j) => j !== k);
      const area = (d[others[0] as number] as number) * (d[others[1] as number] as number);
      faces.push({ name: `${tag}:face.${ax}${side}`, centroid, normal: n, area, surface: 'plane' });
    }
  });
  const corner = (i: number, j: number, k: number): Vec3 => [
    i ? max[0] : min[0],
    j ? max[1] : min[1],
    k ? max[2] : min[2],
  ];
  const vertices: FShape['vertices'] = [];
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1]) {
        const mm = (v: number) => (v ? 'max' : 'min');
        vertices.push({
          name: `${tag}:vertex(${mm(i)},${mm(j)},${mm(k)})`,
          point: corner(i, j, k),
        });
      }
  const edges: FEdge[] = [];
  const role = (k: number, v: number) => `face.${axes[k]}${v ? 'max' : 'min'}`;
  // Edges along each axis k at the 4 combinations of the other two.
  for (let k = 0; k < 3; k++) {
    const [p, q] = [0, 1, 2].filter((j) => j !== k) as [number, number];
    for (const i of [0, 1])
      for (const j of [0, 1]) {
        const a: Vec3 = [min[0], min[1], min[2]];
        a[p] = i ? (max[p] as number) : (min[p] as number);
        a[q] = j ? (max[q] as number) : (min[q] as number);
        const b: Vec3 = [...a];
        a[k] = min[k] as number;
        b[k] = max[k] as number;
        const names = [role(p, i), role(q, j)].sort();
        edges.push({ name: `${tag}:edge(${names[0]}|${names[1]})`, a, b });
      }
  }
  return { faces, edges, vertices, volume: d[0] * d[1] * d[2] };
}

function toWorld(f: Frame, u: number, v: number): Vec3 {
  const y = cross(f.z, f.x);
  return add(f.origin, add(mul(f.x, u), mul(y, v)));
}

function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-30)));
  return add(a, mul(ab, t));
}

export interface FakeCall {
  feature: Feature;
  inputs: FeatureInputs;
}

export class FakeKernel {
  shapes = new Map<ShapeHandle, FShape>();
  calls: FakeCall[] = [];
  released: ShapeHandle[] = [];
  next = 1;
  /** Script a failure for a feature id. */
  failFor = new Set<string>();
  /** Optional M3 projection API (left off to test the TypeScript fallback). */
  projection: ProjectionApi | null = null;

  add(s: FShape): ShapeHandle {
    const h = this.next++;
    this.shapes.set(h, s);
    return h;
  }

  naming(s: FShape): NamingMap {
    return [
      ...s.faces.map((f, index) => ({ name: f.name, kind: 'face' as const, index })),
      ...s.edges.map((e, index) => ({ name: e.name, kind: 'edge' as const, index })),
      ...s.vertices.map((v, index) => ({ name: v.name, kind: 'vertex' as const, index })),
    ];
  }

  private result(s: FShape, extra: Partial<FeatureResult> = {}): Result<FeatureResult> {
    const shape = this.add(s);
    return { ok: true, value: { shape, naming: this.naming(s), warnings: [], ...extra } };
  }

  private shape(h: ShapeHandle | undefined): FShape {
    const s = h === undefined ? undefined : this.shapes.get(h);
    if (!s) throw new Error(`fake kernel: no shape ${h}`);
    return s;
  }

  private copy(h: ShapeHandle | undefined): FShape {
    return structuredClone(this.shape(h));
  }

  async execFeature(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>> {
    this.calls.push({ feature: structuredClone(feature), inputs: structuredClone(inputs) });
    if (this.failFor.has(feature.id)) {
      return {
        ok: false,
        error: { code: 'OPERATION_FAILED', message: `scripted failure ${feature.id}` },
      };
    }
    const tag = `F${feature.id}`;
    switch (feature.type) {
      case 'primitive': {
        if (feature.shape !== 'box') break;
        const o = feature.frame?.origin ?? [0, 0, 0];
        const v = inputs.values;
        return this.result(boxShape(tag, o, add(o, [v['/dx'] ?? 0, v['/dy'] ?? 0, v['/dz'] ?? 0])));
      }
      case 'sketch':
        return this.sketch(feature, inputs);
      case 'plane': {
        const d = feature.definition;
        let frame: Frame = d.kind === 'frame' ? d.frame : (inputs.frames?.from as Frame);
        if (d.kind === 'offset') {
          frame = {
            ...frame,
            origin: add(frame.origin, mul(frame.z, inputs.values['/definition/distance'] ?? 0)),
          };
        }
        const s: FShape = {
          faces: [{ name: `${tag}:plane`, centroid: frame.origin, normal: frame.z, area: 1e4 }],
          edges: [],
          vertices: [],
          volume: 0,
        };
        return this.result(s, { frame });
      }
      case 'hole': {
        const s: FShape =
          inputs.target === undefined
            ? { faces: [], edges: [], vertices: [], volume: 0 }
            : this.copy(inputs.target);
        const depth = inputs.values['/end/depth'] ?? 10;
        feature.points.forEach((p, i) => {
          const f = inputs.frames?.[`hole:${i}`] as Frame;
          s.faces.push({
            name: `${tag}:hole(${p.name}):wall`,
            centroid: add(f.origin, mul(f.z, depth / 2)),
            area: Math.PI * (inputs.values['/diameter'] ?? 1) * depth,
            surface: 'cylinder',
          });
        });
        s.volume -= feature.points.length;
        return this.result(s);
      }
      case 'mirror':
      case 'linearPattern':
      case 'circularPattern':
        return this.copyFeature(feature, inputs);
      case 'shell': {
        const s = this.copy(inputs.target);
        const open = new Set(
          Object.entries(inputs.refs ?? {})
            .filter(([p]) => p.startsWith('/openFaces/'))
            .map(([, r]) => r.index),
        );
        const kept = s.faces.filter((_, i) => !open.has(i));
        s.faces = [...kept, ...kept.map((f) => ({ ...f, name: `${tag}:shell(${f.name})` }))];
        return this.result(s);
      }
      default:
        if (inputs.target !== undefined) return this.result(this.copy(inputs.target));
        return this.result({
          faces: [{ name: `${tag}:end`, centroid: [0, 0, 0], normal: [0, 0, 1], area: 1 }],
          edges: [],
          vertices: [],
          volume: 1,
        });
    }
    return { ok: false, error: { code: 'UNSUPPORTED_FEATURE', message: 'fake' } };
  }

  private sketch(f: SketchFeature, inputs: FeatureInputs): Result<FeatureResult> {
    const frame = inputs.frames?.plane as Frame;
    const tag = `S${f.id}`;
    const pts = new Map<string, Vec3>();
    const s: FShape = { faces: [], edges: [], vertices: [], volume: 0 };
    for (const e of f.entities) {
      if (e.kind !== 'point') continue;
      const w = toWorld(frame, e.x, e.y);
      pts.set(e.id, w);
      s.vertices.push({ name: `${tag}:p(${e.id})`, point: w });
    }
    const lines = f.entities.filter((e) => e.kind === 'line' && !e.construction);
    for (const e of f.entities) {
      if (e.kind === 'line') {
        s.edges.push({
          name: `${tag}:e(${e.id})`,
          a: pts.get(e.start) as Vec3,
          b: pts.get(e.end) as Vec3,
        });
      }
    }
    const regions: string[] = [];
    if (lines.length >= 3) {
      const ids = lines.map((l) => l.id).sort();
      const ps = lines.map((l) => pts.get((l as { start: string }).start) as Vec3);
      const centroid = mul(ps.reduce(add, [0, 0, 0] as Vec3), 1 / ps.length);
      const name = `${tag}:region(${ids.join(',')})`;
      s.faces.push({ name, centroid, normal: frame.z, area: 100, surface: 'plane' });
      regions.push(name);
    }
    return this.result(s, { frame, regions });
  }

  private copyFeature(
    f: Extract<Feature, { type: 'mirror' | 'linearPattern' | 'circularPattern' }>,
    inputs: FeatureInputs,
  ): Result<FeatureResult> {
    const tag = `F${f.id}`;
    const tools = Object.entries(inputs.shapes ?? {})
      .filter(([k]) => k.startsWith('tool:'))
      .map(([, h]) => this.shape(h));
    const bodies = Object.entries(inputs.refs ?? {})
      .filter(([p]) => p.startsWith('/source/bodies/'))
      .map(([, r]) => this.shape(r.shape));
    const out: FShape =
      inputs.target !== undefined
        ? this.copy(inputs.target)
        : f.source.kind === 'bodies' && f.source.merge
          ? structuredClone(bodies[0] as FShape)
          : { faces: [], edges: [], vertices: [], volume: 0 };
    const srcFaces = [...tools, ...bodies].flatMap((t) => t.faces);
    if (f.type === 'mirror') {
      const p = inputs.frames?.plane as Frame;
      for (const face of srcFaces) {
        const h = dot(sub(face.centroid, p.origin), p.z);
        out.faces.push({
          ...face,
          name: `${tag}:mirror(${face.name})`,
          centroid: sub(face.centroid, mul(p.z, 2 * h)),
        });
      }
      return this.result(out);
    }
    const count = inputs.values['/count'] ?? 1;
    const step = inputs.values['/spacing'] ?? 0;
    const dir = inputs.frames?.axis?.z ?? [1, 0, 0];
    const skip = new Set(f.skip ?? []);
    for (let k = 1; k < count; k++) {
      if (skip.has(k)) continue;
      for (const face of srcFaces) {
        const centroid =
          f.type === 'linearPattern' ? add(face.centroid, mul(dir, k * step)) : face.centroid;
        out.faces.push({ ...face, name: `${tag}:inst${k}(${face.name})`, centroid });
      }
    }
    return this.result(out);
  }

  async fingerprints(shape: ShapeHandle): Promise<Result<ShapeFingerprints>> {
    const s = this.shapes.get(shape);
    if (!s) return { ok: false, error: { code: 'INVALID_HANDLE', message: 'no shape' } };
    return {
      ok: true,
      value: {
        faces: s.faces.map((f) =>
          f.normal
            ? {
                centroid: f.centroid,
                normal: f.normal,
                area: f.area,
                surface: f.surface ?? 'plane',
              }
            : { centroid: f.centroid, area: f.area, surface: f.surface ?? 'cylinder' },
        ),
        edges: s.edges.map((e) => ({
          centroid: mul(add(e.a, e.b), 0.5),
          length: len(sub(e.b, e.a)),
          curve: 'line',
        })),
        vertices: s.vertices.map((v) => ({ point: v.point })),
      },
    };
  }

  async measureShapes(a: MeasureSubject, b?: MeasureSubject): Promise<Result<Measurement>> {
    const pointOf = (m: MeasureSubject): Vec3 | null => {
      if ('point' in m) return m.point;
      const s = this.shapes.get(m.shape);
      if (m.kind === 'vertex') return s?.vertices[m.index]?.point ?? null;
      return null;
    };
    if (!b) return { ok: true, value: {} };
    if (!('point' in a) && a.kind === 'edge') {
      const e = this.shapes.get(a.shape)?.edges[a.index];
      const p = pointOf(b);
      if (!e || !p) return { ok: false, error: { code: 'INVALID_INPUT', message: 'fake measure' } };
      const c = closestOnSegment(p, e.a, e.b);
      return { ok: true, value: { distance: { value: len(sub(p, c)), a: c, b: p } } };
    }
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'fake measure: unsupported' } };
  }

  async mesh(shape: ShapeHandle): Promise<Result<MeshBuffers>> {
    const s = this.shapes.get(shape);
    if (!s) return { ok: false, error: { code: 'INVALID_HANDLE', message: 'no shape' } };
    const nf = s.faces.length;
    const ne = s.edges.length;
    return {
      ok: true,
      value: {
        positions: new Float32Array(9 * nf),
        normals: new Float32Array(9 * nf),
        indices: new Uint32Array(3 * nf).map((_, i) => i),
        faceRanges: new Uint32Array(2 * nf).map((_, i) => (i % 2 ? 1 : i / 2)),
        edgePositions: new Float32Array(6 * ne),
        edgeRanges: new Uint32Array(2 * ne).map((_, i) => (i % 2 ? 2 : i)),
        faceNames: s.faces.map((f) => f.name),
        edgeNames: s.edges.map((e) => e.name),
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    };
  }

  async massProperties(shape: ShapeHandle): Promise<Result<MassProperties>> {
    const s = this.shapes.get(shape);
    if (!s) return { ok: false, error: { code: 'INVALID_HANDLE', message: 'no shape' } };
    const pts = [...s.vertices.map((v) => v.point), ...s.faces.map((f) => f.centroid)];
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
    return {
      ok: true,
      value: {
        volume: s.volume,
        area: 0,
        centroid: [0, 0, 0],
        bbox: { min, max },
        faceCount: s.faces.length,
        edgeCount: s.edges.length,
        vertexCount: s.vertices.length,
      },
    };
  }

  async release(shape: ShapeHandle): Promise<void> {
    this.shapes.delete(shape);
    this.released.push(shape);
  }

  /** The engine's `kernel` dependency (low-level calls the engine does not use are stubs). */
  api(): RegenEngineDeps['kernel'] {
    const unsupported = async () =>
      ({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', message: 'fake' } }) as const;
    const k: RegenEngineDeps['kernel'] = {
      init: async () => ({
        ok: true,
        value: { variant: 'single', occtVersion: 'fake', buildId: 'fake', initMs: 0 },
      }),
      execFeature: (f, i) => this.execFeature(f, i),
      mesh: (s) => this.mesh(s),
      massProperties: (s) => this.massProperties(s),
      release: (s) => this.release(s),
      fingerprints: (s) => this.fingerprints(s),
      exportShapes: unsupported,
      importShapes: unsupported,
      configureThreads: unsupported,
      measureShapes: (a, b) => this.measureShapes(a, b),
      liveHandleCount: () => this.shapes.size,
    };
    if (this.projection) {
      k.projectEdges = (s, e, p) => (this.projection as ProjectionApi).projectEdges(s, e, p);
      k.projectFaceOutline = (s, f, p) =>
        (this.projection as ProjectionApi).projectFaceOutline(s, f, p);
    }
    return k;
  }

  /** Calls for one feature id. */
  callsFor(id: string): FakeCall[] {
    return this.calls.filter((c) => c.feature.id === id);
  }
}

/** A solver that returns the input entities unchanged (geometry already consistent). */
export const identitySolver: SketchSolve = {
  solve: (input) => ({
    status: 'solved',
    entities: input.entities,
    dof: 0,
    entityDof: {},
    conflicts: [],
    redundant: [],
    driven: {},
    ms: 0,
  }),
};

export type { EntityRef, ProjectedCurve };
