/**
 * A stand-in `ModelingApi` for development and tests until the real regen engine
 * (packages/kernel-client/src/regen, inside the kernel worker) lands. It runs on the main thread
 * and orchestrates the **real low-level kernel** over Comlink (`execFeature`, `mesh`,
 * `massProperties`, `fingerprints`, `exportShapes`, `importShapes`), so the main thread still
 * never touches Wasm. Deliberately simple:
 *
 *  - sequential evaluation with a per-feature result cache (hash of definition + values + input
 *    handles), so editing feature k mostly re-runs k…n;
 *  - references resolve by **exact persistent name only** (no fingerprint matching): anything
 *    else is reported as `needsAttention`, never guessed;
 *  - `add` acts on the most recent body, `cut`/`intersect` on every body.
 *
 * Swap for the real engine in `engine.ts`.
 */

import type {
  BodyResult,
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  Feature,
  FeatureInputs,
  FeatureResult,
  FeatureStatus,
  Frame,
  Id,
  KernelError,
  MassProperties,
  MeshBuffers,
  MeshOptions,
  MeshQuality,
  NamingMap,
  RegenRequest,
  RegenResult,
  ResolvedRef,
  Result,
  ShapeFingerprints,
  ShapeHandle,
  SketchFeature,
  SketchResult,
  UnresolvedRef,
  Vec3,
  WhittleDoc,
} from '@whittle/contracts';
import {
  evaluateFeatureValues,
  expressionEngine,
  featureReferences,
  scopeOf,
  tryResolveDensity,
} from '@whittle/document';
import { indexEntities } from '@whittle/sketch';
import { sketchCurves } from '../sketch/overlay';
import {
  frameFromNormal,
  isOriginAxis,
  isOriginPlane,
  norm3,
  ORIGIN_AXES,
  ORIGIN_FRAMES,
  offsetFrame,
  sub3,
  toPlaneFrame,
  toWorld,
} from './frames';
import type { ModelingPort } from './modeling';

/** The low-level kernel calls the fake needs (`Remote<KernelWorkerApi>` satisfies it). */
export interface KernelPort {
  execFeature(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>>;
  mesh(shape: ShapeHandle, options: MeshOptions): Promise<Result<MeshBuffers>>;
  massProperties(shape: ShapeHandle, density?: number): Promise<Result<MassProperties>>;
  release(shape: ShapeHandle): Promise<void>;
  fingerprints(shape: ShapeHandle): Promise<Result<ShapeFingerprints>>;
  exportShapes(
    shapes: { shape: number; name: string; color?: string }[],
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<Result<{ name: string; bytes: Uint8Array }[]>>;
  importShapes(
    bytes: Uint8Array,
    format: ExportFormat,
  ): Promise<Result<{ shape: ShapeHandle; name?: string }[]>>;
}

export const MESH_QUALITY: Record<MeshQuality, MeshOptions> = {
  coarse: { linearDeflection: 0.02, angularDeflection: 0.5, relative: true },
  fine: { linearDeflection: 0.004, angularDeflection: 0.2, relative: true },
};

interface Body {
  id: string;
  shape: ShapeHandle;
  naming: NamingMap;
  /** Feature that last changed the body (for ghosts / statuses). */
  featureId: Id;
}

interface SketchOut {
  feature: SketchFeature;
  frame: Frame;
  shape: ShapeHandle | null;
  naming: NamingMap;
  regions: string[];
}

interface CacheEntry {
  result: FeatureResult;
  /** Every handle owned by this entry (shape + extra bodies). */
  handles: ShapeHandle[];
  used: boolean;
}

interface PartState {
  bodies: Body[];
  sketches: Map<Id, SketchOut>;
  meshes: Map<string, MeshBuffers>;
}

const err = (code: KernelError['code'], message: string, hint?: string): KernelError =>
  hint ? { code, message, hint } : { code, message };

const fieldLabel = (pointer: string): string => {
  const last = pointer.split('/').filter(Boolean).pop() ?? 'value';
  return last.replace(/^./, (c) => c.toUpperCase());
};

function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

function bboxOf(positions: Float32Array, indices: Uint32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const i of indices) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  return { min, max };
}

/** One face of a mesh as its own `MeshBuffers` (sketch regions for display/picking). */
export function faceSubMesh(mesh: MeshBuffers, face: number): MeshBuffers {
  const first = mesh.faceRanges[2 * face] ?? 0;
  const count = mesh.faceRanges[2 * face + 1] ?? 0;
  const indices = mesh.indices.slice(first * 3, (first + count) * 3);
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices,
    faceRanges: new Uint32Array([0, count]),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: [mesh.faceNames[face] ?? ''],
    edgeNames: [],
    bbox: count > 0 ? bboxOf(mesh.positions, indices) : mesh.bbox,
  };
}

export interface FakeModelingOptions {
  /** Simulated latency per regenerate (ms), to exercise staleness handling in development. */
  delayMs?: number;
}

/** Builds the fake engine over a low-level kernel. */
export function createFakeModeling(kernel: KernelPort, options: FakeModelingOptions = {}) {
  const cache = new Map<string, CacheEntry>();
  const parts = new Map<Id, PartState>();
  const revisions = new Map<Id, number>();
  const meshCache = new Map<string, MeshBuffers>();
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialises calls: the worker is serial and our state is shared. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function exec(
    feature: Feature,
    inputs: FeatureInputs,
  ): Promise<
    { ok: true; result: FeatureResult; cached: boolean } | { ok: false; error: KernelError }
  > {
    const key = stableKey({ feature: { ...feature, name: '' }, inputs });
    const hit = cache.get(key);
    if (hit) {
      hit.used = true;
      return { ok: true, result: hit.result, cached: true };
    }
    const r = await kernel.execFeature(feature, inputs);
    if (!r.ok) return { ok: false, error: r.error };
    const handles = [r.value.shape, ...(r.value.bodies ?? []).map((b) => b.shape)];
    cache.set(key, { result: r.value, handles, used: true });
    return { ok: true, result: r.value, cached: false };
  }

  async function meshOf(shape: ShapeHandle, quality: MeshQuality): Promise<MeshBuffers | null> {
    const key = `${shape}:${quality}`;
    const hit = meshCache.get(key);
    if (hit) return hit;
    const r = await kernel.mesh(shape, MESH_QUALITY[quality]);
    if (!r.ok) return null;
    meshCache.set(key, r.value);
    return r.value;
  }

  function releaseUnused(): void {
    for (const [key, entry] of cache) {
      if (entry.used) {
        entry.used = false;
        continue;
      }
      cache.delete(key);
      for (const h of entry.handles) {
        meshCache.delete(`${h}:coarse`);
        meshCache.delete(`${h}:fine`);
        void kernel.release(h);
      }
    }
  }

  async function regenerateNow(request: RegenRequest): Promise<RegenResult> {
    const t0 = performance.now();
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const { doc, partId, quality } = request;
    const revision = (revisions.get(partId) ?? 0) + 1;
    revisions.set(partId, revision);
    const part = doc.parts.find((p) => p.id === partId);
    if (!part) {
      return {
        partId,
        revision,
        features: [],
        bodies: [],
        sketches: [],
        totalMs: 0,
        cache: { hits: 0, misses: 0 },
      };
    }
    const state: PartState = { bodies: [], sketches: new Map(), meshes: new Map() };
    const planes = new Map<Id, Frame>();
    const statuses: FeatureStatus[] = [];
    const failed: Id[] = [];
    let hits = 0;
    let misses = 0;

    for (const [i, f] of part.features.entries()) {
      const t = performance.now();
      const status = (s: Omit<FeatureStatus, 'featureId' | 'cached' | 'ms'>, cached = false) =>
        statuses.push({ featureId: f.id, cached, ms: performance.now() - t, ...s });
      if (i >= part.rollbackIndex) {
        status({ state: 'rolledBack' });
        continue;
      }
      if (f.suppressed) {
        status({ state: 'suppressed' });
        continue;
      }
      if (failed.some((id) => featureReferences(f, id))) {
        status({ state: 'blocked' });
        failed.push(f.id);
        continue;
      }
      const evaluated = evaluateFeatureValues(f, doc);
      const badField = Object.keys(evaluated.errors)[0];
      if (badField && f.type !== 'sketch') {
        const e = evaluated.errors[badField];
        status({
          state: 'error',
          error: err('INVALID_INPUT', `${fieldLabel(badField)}: ${e?.message ?? 'invalid value'}`),
        });
        failed.push(f.id);
        continue;
      }
      const ctx: StepContext = { doc, state, planes, values: evaluated.values };
      const out = await step(f, ctx);
      if (out.cached) hits++;
      else misses++;
      if (out.state === 'ok') status({ state: 'ok' }, out.cached);
      else {
        status(
          out.state === 'needsAttention'
            ? { state: 'needsAttention', unresolved: out.unresolved ?? [] }
            : { state: 'error', error: out.error ?? err('OPERATION_FAILED', 'Failed') },
          out.cached,
        );
        failed.push(f.id);
      }
    }

    // Meshes, mass properties, sketch display.
    const density = part.material
      ? tryResolveDensity(part.material, expressionEngine, scopeOf(doc))
      : null;
    const bodies: BodyResult[] = [];
    for (const b of state.bodies) {
      const mesh = await meshOf(b.shape, quality);
      if (!mesh) continue;
      const body: BodyResult = { id: b.id, shape: b.shape, mesh };
      if (request.massProperties || part.material) {
        const mp = await kernel.massProperties(b.shape, density?.ok ? density.value : undefined);
        if (mp.ok) body.massProperties = mp.value;
      }
      bodies.push(body);
    }
    const sketches: SketchResult[] = [];
    for (const s of state.sketches.values()) {
      const frame = toPlaneFrame(s.frame);
      const regions: SketchResult['regions'] = [];
      if (s.shape !== null && s.regions.length > 0) {
        const mesh = await meshOf(s.shape, 'coarse');
        if (mesh) {
          mesh.faceNames.forEach((name, fi) => {
            if (name.includes(':region(')) regions.push({ name, mesh: faceSubMesh(mesh, fi) });
          });
        }
      }
      sketches.push({
        featureId: s.feature.id,
        ...sketchCurves(s.feature.entities, frame),
        regions,
        frame,
      });
    }

    parts.set(partId, state);
    releaseUnused();
    return {
      partId,
      revision,
      features: statuses,
      bodies,
      sketches,
      totalMs: performance.now() - t0,
      cache: { hits, misses },
    };
  }

  interface StepContext {
    doc: WhittleDoc;
    state: PartState;
    planes: Map<Id, Frame>;
    values: Record<string, number>;
  }

  interface StepOut {
    state: 'ok' | 'error' | 'needsAttention';
    cached: boolean;
    error?: KernelError;
    unresolved?: UnresolvedRef[];
  }

  const fail = (error: KernelError): StepOut => ({ state: 'error', cached: false, error });
  const attention = (unresolved: UnresolvedRef[]): StepOut => ({
    state: 'needsAttention',
    cached: false,
    unresolved,
  });

  function findNamed(
    state: PartState,
    ref: EntityRef,
    kind: 'face' | 'edge' | 'vertex',
  ): { body: Body; index: number } | null {
    for (let k = state.bodies.length - 1; k >= 0; k--) {
      const body = state.bodies[k] as Body;
      const hits = body.naming.filter((n) => n.kind === kind && n.name === ref.name);
      if (hits.length === 1) return { body, index: (hits[0] as { index: number }).index };
    }
    return null;
  }

  function regionRef(state: PartState, ref: EntityRef): ResolvedRef | null {
    for (const s of state.sketches.values()) {
      if (s.shape === null) continue;
      const hit = s.naming.find((n) => n.kind === 'face' && n.name === ref.name);
      if (hit) return { shape: s.shape, kind: 'face', index: hit.index };
    }
    return null;
  }

  /** Frame of a plane-like reference: origin plane, plane feature, planar face, sketch. */
  async function frameOf(ctx: StepContext, ref: EntityRef): Promise<Frame | null> {
    if (isOriginPlane(ref.name)) return ORIGIN_FRAMES[ref.name];
    // Datum plane: its single face is named F<id>:plane (kernel execPlane).
    const plane = /^F([0-9A-Za-z]+):plane$/.exec(ref.name);
    if (plane) return ctx.planes.get(plane[1] as string) ?? null;
    const face = findNamed(ctx.state, ref, 'face');
    if (!face) return null;
    const fp = await kernel.fingerprints(face.body.shape);
    if (!fp.ok) return null;
    const f = fp.value.faces[face.index];
    if (!f?.normal) return null;
    return frameFromNormal(f.centroid, f.normal);
  }

  async function axisOf(ctx: StepContext, ref: EntityRef): Promise<Frame | null> {
    if (isOriginAxis(ref.name)) return ORIGIN_AXES[ref.name];
    // A sketch line: S<id>:e(<entityId>)
    const m = /^S([0-9A-Za-z]+):e\(([^)]+)\)$/.exec(ref.name);
    if (m) {
      const s = ctx.state.sketches.get(m[1] as string);
      if (!s) return null;
      const line = s.feature.entities.find((e) => e.id === m[2]);
      if (line?.kind !== 'line') return null;
      const index = indexEntities(s.feature.entities);
      const a = index.get(line.start);
      const b = index.get(line.end);
      if (a?.kind !== 'point' || !b || b.kind !== 'point') return null;
      const pf = toPlaneFrame(s.frame);
      const wa = toWorld(pf, [a.x, a.y]);
      const wb = toWorld(pf, [b.x, b.y]);
      return frameFromNormal(wa, norm3(sub3(wb, wa)));
    }
    return null;
  }

  function newBody(ctx: StepContext, f: Feature, result: FeatureResult): void {
    ctx.state.bodies.push({
      id: `B${f.id}`,
      shape: result.shape,
      naming: result.naming,
      featureId: f.id,
    });
  }

  /** Applies a body op result (`add` → last body; `cut`/`intersect` → every body). */
  function applyBodyResult(ctx: StepContext, f: Feature, op: string, result: FeatureResult) {
    if (op === 'new') return newBody(ctx, f, result);
    const bodies = ctx.state.bodies;
    if (op === 'add') {
      const last = bodies[bodies.length - 1];
      if (last)
        Object.assign(last, { shape: result.shape, naming: result.naming, featureId: f.id });
      return;
    }
    const first = bodies[0];
    if (first)
      Object.assign(first, { shape: result.shape, naming: result.naming, featureId: f.id });
    for (const extra of result.bodies ?? []) {
      const id = extra.key.replace(/^scope:/, '');
      const b = bodies.find((x) => x.id === id);
      if (b) Object.assign(b, { shape: extra.shape, naming: extra.naming, featureId: f.id });
    }
  }

  function bodyInputs(ctx: StepContext, op: string): Partial<FeatureInputs> {
    const bodies = ctx.state.bodies;
    if (op === 'new' || bodies.length === 0) return {};
    if (op === 'add') return { target: (bodies[bodies.length - 1] as Body).shape };
    const shapes: Record<string, ShapeHandle> = {};
    for (const b of bodies) shapes[`scope:${b.id}`] = b.shape;
    return { shapes };
  }

  async function step(f: Feature, ctx: StepContext): Promise<StepOut> {
    const values = ctx.values;
    switch (f.type) {
      case 'primitive': {
        if (f.op !== 'new' && ctx.state.bodies.length === 0)
          return fail(
            err('INVALID_INPUT', 'There is no body to act on', 'Set the operation to New.'),
          );
        const r = await exec(f, { values, ...bodyInputs(ctx, f.op) });
        if (!r.ok) return fail(r.error);
        applyBodyResult(ctx, f, f.op, r.result);
        return { state: 'ok', cached: r.cached };
      }
      case 'sketch': {
        const frame = await frameOf(ctx, f.on);
        if (!frame) return attention([{ path: '/on', ref: f.on, reason: 'missing' }]);
        const out: SketchOut = { feature: f, frame, shape: null, naming: [], regions: [] };
        ctx.state.sketches.set(f.id, out);
        const curves = f.entities.filter((e) => e.kind !== 'point' && !e.construction);
        if (curves.length === 0) return { state: 'ok', cached: true };
        const r = await exec(f, { values, frames: { plane: frame } });
        if (!r.ok) return fail(r.error);
        out.shape = r.result.shape;
        out.naming = r.result.naming;
        out.regions = r.result.regions ?? [];
        if (r.result.frame) out.frame = r.result.frame;
        return { state: 'ok', cached: r.cached };
      }
      case 'plane': {
        const def = f.definition;
        if (def.kind !== 'frame' && def.kind !== 'offset') {
          return fail(err('UNSUPPORTED_FEATURE', 'This plane type needs the real engine'));
        }
        let from: Frame | null;
        if (def.kind === 'frame') from = def.frame;
        else from = await frameOf(ctx, def.from);
        if (!from) {
          return def.kind === 'offset'
            ? attention([{ path: '/definition/from', ref: def.from, reason: 'missing' }])
            : fail(err('INVALID_INPUT', 'The plane has no placement'));
        }
        const frame =
          def.kind === 'offset' ? offsetFrame(from, values['/definition/distance'] ?? 0) : from;
        ctx.planes.set(f.id, frame);
        return { state: 'ok', cached: true };
      }
      case 'extrude':
      case 'revolve': {
        const refs: Record<string, ResolvedRef> = {};
        const unresolved: UnresolvedRef[] = [];
        f.profile.forEach((ref, i) => {
          const r = regionRef(ctx.state, ref);
          if (r) refs[`/profile/${i}`] = r;
          else unresolved.push({ path: `/profile/${i}`, ref, reason: 'missing' });
        });
        if (f.profile.length === 0)
          return fail(
            err(
              'INVALID_INPUT',
              `Select a sketch region to ${f.type}`,
              'Pick a closed region in a sketch.',
            ),
          );
        const frames: Record<string, Frame> = {};
        if (f.type === 'revolve') {
          const axis = await axisOf(ctx, f.axis);
          if (axis) frames.axis = axis;
          else unresolved.push({ path: '/axis', ref: f.axis, reason: 'missing' });
        } else if (f.end.kind === 'upTo') {
          const target = await frameOf(ctx, f.end.target);
          if (target) frames.upTo = target;
          else unresolved.push({ path: '/end/target', ref: f.end.target, reason: 'missing' });
        }
        if (unresolved.length) return attention(unresolved);
        if (f.op !== 'new' && ctx.state.bodies.length === 0)
          return fail(
            err(
              'INVALID_INPUT',
              `There is no body to ${f.op}`,
              'Create a body first, or set the operation to New.',
            ),
          );
        const r = await exec(f, { values, refs, frames, ...bodyInputs(ctx, f.op) });
        if (!r.ok) return fail(r.error);
        applyBodyResult(ctx, f, f.op, r.result);
        return { state: 'ok', cached: r.cached };
      }
      case 'fillet':
      case 'chamfer': {
        const refs: Record<string, ResolvedRef> = {};
        const unresolved: UnresolvedRef[] = [];
        let target: Body | null = null;
        f.edges.forEach((ref, i) => {
          const hit = findNamed(ctx.state, ref, 'edge');
          if (hit && (!target || target === hit.body)) {
            target = hit.body;
            refs[`/edges/${i}`] = { shape: hit.body.shape, kind: 'edge', index: hit.index };
          } else unresolved.push({ path: `/edges/${i}`, ref, reason: 'missing' });
        });
        if (f.edges.length === 0)
          return fail(err('INVALID_INPUT', `Select edges to ${f.type}`, 'Pick one or more edges.'));
        if (unresolved.length) return attention(unresolved);
        const body = target as Body | null;
        if (!body) return attention([]);
        const r = await exec(f, { values, refs, target: body.shape });
        if (!r.ok) return fail(r.error);
        Object.assign(body, { shape: r.result.shape, naming: r.result.naming, featureId: f.id });
        return { state: 'ok', cached: r.cached };
      }
      case 'boolean': {
        const byName = (ref: EntityRef) => ctx.state.bodies.find((b) => b.id === ref.name);
        const target = byName(f.target);
        const unresolved: UnresolvedRef[] = [];
        if (!target) unresolved.push({ path: '/target', ref: f.target, reason: 'missing' });
        const refs: Record<string, ResolvedRef> = {};
        if (target) refs['/target'] = { shape: target.shape, kind: 'body', index: 0 };
        const tools: Body[] = [];
        f.tools.forEach((ref, i) => {
          const b = byName(ref);
          if (b && b !== target) {
            tools.push(b);
            refs[`/tools/${i}`] = { shape: b.shape, kind: 'body', index: 0 };
          } else unresolved.push({ path: `/tools/${i}`, ref, reason: 'missing' });
        });
        if (f.tools.length === 0)
          return fail(
            err('INVALID_INPUT', 'Select the tool bodies', 'Pick at least one other body.'),
          );
        if (unresolved.length || !target) return attention(unresolved);
        const r = await exec(f, { values, refs });
        if (!r.ok) return fail(r.error);
        Object.assign(target, { shape: r.result.shape, naming: r.result.naming, featureId: f.id });
        if (!f.keepTools) ctx.state.bodies = ctx.state.bodies.filter((b) => !tools.includes(b));
        return { state: 'ok', cached: r.cached };
      }
      case 'pushPull':
        return fail(err('UNSUPPORTED_FEATURE', 'Push/pull arrives in M2'));
      case 'import':
        return fail(err('UNSUPPORTED_FEATURE', 'Import needs the real engine'));
      case 'shell':
      case 'draft':
      case 'sweep':
      case 'loft':
      case 'mirror':
      case 'linearPattern':
      case 'circularPattern':
      case 'hole':
      case 'thread':
      case 'axis':
      case 'point':
        return fail(err('UNSUPPORTED_FEATURE', `${f.type} needs the real engine`));
      default: {
        const _never: never = f;
        return _never;
      }
    }
  }

  const api: ModelingPort = {
    regenerate: (request) => serial(() => regenerateNow(request)),

    refFor: (partId: Id, query: EntityQuery) =>
      serial(async (): Promise<EntityRef | null> => {
        const state = parts.get(partId);
        const body = state?.bodies.find((b) => b.id === query.bodyId);
        if (!state || !body) return null;
        const entry = body.naming.find((n) => n.kind === query.kind && n.index === query.index);
        if (!entry?.name) return null;
        const fp = await kernel.fingerprints(body.shape);
        const ref: EntityRef = { name: entry.name, kind: query.kind };
        if (fp.ok) {
          if (query.kind === 'face') {
            const f = fp.value.faces[query.index];
            if (f)
              ref.fingerprint = {
                centroid: f.centroid,
                area: f.area,
                ...(f.normal ? { normal: f.normal } : {}),
              };
          } else if (query.kind === 'edge') {
            const e = fp.value.edges[query.index];
            if (e) ref.fingerprint = { centroid: e.centroid, length: e.length };
          } else {
            const v = fp.value.vertices[query.index];
            if (v) ref.fingerprint = { centroid: v.point };
          }
        }
        return ref;
      }),

    exportPart: (partId: Id, format: ExportFormat, opts?: ExportOptions) =>
      serial(async () => {
        const state = parts.get(partId);
        const bodies = (state?.bodies ?? []).filter(
          (b) => !opts?.bodies || opts.bodies.includes(b.id),
        );
        if (bodies.length === 0)
          return {
            ok: false as const,
            error: err('INVALID_INPUT', 'There is nothing to export yet', 'Create a solid first.'),
          };
        const r = await kernel.exportShapes(
          bodies.map((b, i) => ({ shape: b.shape, name: `Body ${i + 1}` })),
          format,
          { ...opts, stlPerBody: false },
        );
        if (!r.ok) return { ok: false as const, error: r.error };
        const file = r.value[0];
        if (!file)
          return { ok: false as const, error: err('INTERNAL', 'The export produced no file') };
        return { ok: true as const, bytes: file.bytes };
      }),

    importFile: (bytes: Uint8Array, format: ExportFormat) =>
      serial(async () => {
        const r = await kernel.importShapes(bytes, format);
        if (!r.ok) return { ok: false as const, error: r.error };
        const bodies: { shape: ShapeHandle; mesh: MeshBuffers; name?: string }[] = [];
        for (const b of r.value) {
          const mesh = await meshOf(b.shape, 'fine');
          if (mesh) bodies.push({ shape: b.shape, mesh, ...(b.name ? { name: b.name } : {}) });
        }
        return { ok: true as const, bodies };
      }),

    closePart: (partId: Id) =>
      serial(async () => {
        parts.delete(partId);
        for (const entry of cache.values()) entry.used = false;
        releaseUnused();
      }),
  };
  return api;
}
