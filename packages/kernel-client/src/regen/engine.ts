/**
 * The regeneration engine (PLAN §4, §7.3): walks a part's feature list inside the kernel worker,
 * resolves persistent references, drives the kernel one feature at a time and serves unchanged
 * features from a per-part, content-addressed result cache.
 *
 * Model state while walking: an ordered body table (`B<featureId>` → shape), the solved sketches
 * and the construction planes produced so far. Every feature result is a *delta* on that state
 * (bodies set / removed, a sketch, a plane) stored in a cache entry that owns the shape handles it
 * created; deltas never reference handles owned by other entries, so evicting an entry that the
 * latest regen did not use can never invalidate a live state.
 *
 * Cache key of a feature = hash(feature definition without name/suppressed/annotations, evaluated
 * values, resolved references as (input content key, kind, index), frames, and the content keys of
 * the bodies it may act on). Content keys chain, so editing feature k changes the keys of k and of
 * every feature that consumes its output, and nothing upstream.
 *
 * Failure semantics: a failing (`error` / `needsAttention`) feature is skipped — the state keeps
 * its pre-feature geometry, which therefore stays visible. Its id joins the failed set and the
 * bodies it would have acted on are tainted; a later feature that references the failed feature
 * (by name tag) or acts on / references a tainted body is `blocked` (and propagates the same way).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  BodyScope,
  ChamferFeature,
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  ExtrudeFeature,
  Feature,
  FeatureInputs,
  FeatureResult,
  FeatureStatus,
  FilletFeature,
  Fingerprint,
  Frame,
  Id,
  ImportFeature,
  KernelError,
  MassProperties,
  Measurement,
  MeasureTarget,
  MeshBuffers,
  MeshQuality,
  NamingMap,
  Part,
  PlaneFeature,
  PrimitiveFeature,
  PushPullFeature,
  RegenRequest,
  RegenResult,
  ResolvedRef,
  Result,
  RevolveFeature,
  ShapeFingerprints,
  ShapeHandle,
  SketchEntity,
  SketchFeature,
  SketchResult,
  SketchSolveInput,
  SketchSolveResult,
  UnresolvedRef,
  Vec2,
  Vec3,
  WhittleDoc,
} from '@whittle/contracts';
import {
  evaluateFeatureValues,
  expressionEngine,
  featureReferences,
  scopeOf,
  sketchSolveValues,
  tryResolveDensity,
} from '@whittle/document';
import { IoError, importMesh, meshToStl } from '@whittle/io';
import { zipSync } from 'fflate';
import type { KernelApiInternals, KernelWorkerApi, MeasureSubject } from '../kernel-api';
import { copyMesh, faceIndex, faceSubMesh } from './buffers';
import {
  type Box3,
  boxDiagonal,
  boxesOverlap,
  emptyBox,
  extendBox,
  ORIGIN_AXES,
  ORIGIN_PLANES,
  planeFrame,
  sampleEntity,
  toWorld,
} from './geometry';
import { hashKey } from './hash';
import {
  compareGeoKey,
  faceNamesByKey,
  frameMatrix,
  importNamingTag,
  isIdentity,
  type Matrix34,
  mentionsImport,
  placeBrep,
  placeMesh,
  sha256Hex,
  translateName,
  translateNaming,
} from './imports';
import { type Candidate, type ResolvedTarget, resolveRef, type SubKind } from './resolve';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** The part of `@whittle/sketch/core`'s `SketchSolverCore` the engine needs. */
export interface SketchSolve {
  solve(input: SketchSolveInput): SketchSolveResult;
}

export interface RegenEngineOptions {
  /**
   * Cache entries kept beyond those the latest regen (and the last all-ok regen, for ghosts)
   * uses, per part, least recently used first out. Each holds one or two B-rep shapes plus their
   * meshes. Default 128; the tablet tier should use ~32 (PLAN §8.4 memory budget).
   */
  maxSpareResults?: number;
  /** Viewport mesh deflections per quality (relative to the shape's bbox size). */
  meshQuality?: Partial<
    Record<MeshQuality, { linearDeflection: number; angularDeflection: number }>
  >;
  now?: () => number;
}

export interface RegenEngineDeps {
  kernel: KernelWorkerApi & Partial<KernelApiInternals>;
  /** Lazily loads planegcs (only when a sketch misses the cache). */
  sketchSolver: () => Promise<SketchSolve>;
  options?: RegenEngineOptions;
}

/**
 * A reference that resolved by fingerprint / name-family disambiguation rather than by its exact
 * stored name. `name` is the current name and `fingerprint` the entity's current fingerprint, so
 * the app can heal the stored ref (proposed contract field: `fingerprint`, see README).
 */
export interface ReboundRef {
  path: string;
  name: string;
  fingerprint?: Fingerprint;
}

/** `UnresolvedRef` plus the fingerprint seen the last time this ref resolved (proposed). */
export interface RegenUnresolvedRef extends UnresolvedRef {
  /**
   * Where the entity was the last time this (feature, path) resolved in this worker — present
   * when the stored ref has no fingerprint of its own (otherwise `ref.fingerprint` is the old
   * location), so the app can always ghost the old location.
   */
  lastKnown?: Fingerprint;
}

/** Extensions over the contract (proposed for packages/contracts, see README). */
export interface RegenFeatureStatus extends FeatureStatus {
  /** Non-fatal kernel/engine warnings (e.g. "The cut does not touch any body"). */
  warnings?: KernelError[];
  unresolved?: RegenUnresolvedRef[];
  rebound?: ReboundRef[];
}

export interface RegenOutput extends RegenResult {
  features: RegenFeatureStatus[];
  /**
   * Last good geometry (PLAN §9.2 ghost): bodies of the most recent regen in which every feature
   * evaluated, for bodies whose current geometry differs from it, while some feature fails.
   */
  ghosts?: BodyResult[];
}

export type ImportResult =
  | { ok: true; bodies: { shape: ShapeHandle; mesh: MeshBuffers; name?: string }[] }
  | { ok: false; error: KernelError };

export type ExportResult = { ok: true; bytes: Uint8Array } | { ok: false; error: KernelError };

/** Default viewport deflections: relative chord deviation (× bbox size) and angle (rad). */
export const MESH_QUALITY: Record<
  MeshQuality,
  { linearDeflection: number; angularDeflection: number }
> = {
  coarse: { linearDeflection: 0.004, angularDeflection: 0.5 },
  fine: { linearDeflection: 0.0006, angularDeflection: 0.25 },
};

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

interface BodyState {
  id: string;
  shape: ShapeHandle;
  naming: NamingMap;
  /** Content key (changes iff the geometry/naming may have changed). */
  key: string;
  /** A mesh-only reference body (STL/OBJ/3MF/GLB import): displayed and exported, never modified. */
  meshOnly?: boolean;
}

/** An attachment read once and cached by sha256 (unplaced, unnamed kernel shapes or meshes). */
interface RawImport {
  sha: string;
  format: ImportFeature['source']['format'];
  /** B-rep solids in file order (owned by the import cache). */
  shapes: ShapeHandle[];
  /** Mesh formats: one mesh per object in the file (TS-side; placed and handed to the kernel per use). */
  meshes: MeshBuffers[];
  lastUsed: number;
}

interface SketchState {
  id: Id;
  shape: ShapeHandle;
  naming: NamingMap;
  frame: Frame;
  regions: string[];
  entities: SketchEntity[];
  key: string;
}

interface PlaneState {
  id: Id;
  shape: ShapeHandle;
  naming: NamingMap;
  frame: Frame;
  key: string;
}

type EntryResult =
  | {
      ok: true;
      set: BodyState[];
      remove: string[];
      /** Bodies the feature actually changed or consumed (for taint checks on cache hits). */
      touched: string[];
      sketch?: SketchState;
      plane?: PlaneState;
      warnings: KernelError[];
    }
  | { ok: false; error: KernelError };

interface CacheEntry {
  key: string;
  owned: ShapeHandle[];
  result: EntryResult;
  lastUsed: number;
}

interface PartCache {
  entries: Map<string, CacheEntry>;
  revision: number;
  tick: number;
  latest: { bodies: BodyState[]; keys: Set<string>; partName: string } | null;
  lastGood: { bodies: BodyState[]; keys: Set<string> } | null;
  /** Imported attachments by sha256. */
  imports: Map<string, RawImport>;
  /**
   * Where each `(featureId|path)` ref resolved last (for `lastKnown`). The shape is one of the
   * previous regen's, which stays live until the current regen ends; the fingerprint is computed
   * only when needed.
   */
  lastResolved: Map<string, { shape: ShapeHandle; kind: SubKind; index: number }>;
}

class ModelState {
  bodies = new Map<string, BodyState>();
  sketches = new Map<Id, SketchState>();
  planes = new Map<Id, PlaneState>();
  version = 0;

  apply(r: Extract<EntryResult, { ok: true }>): void {
    for (const id of r.remove) this.bodies.delete(id);
    for (const b of r.set) this.bodies.set(b.id, b);
    if (r.sketch) this.sketches.set(r.sketch.id, r.sketch);
    if (r.plane) this.planes.set(r.plane.id, r.plane);
    this.version++;
  }

  /** Content key of any live shape in the state. */
  keyOf(shape: ShapeHandle): string | undefined {
    for (const b of this.bodies.values()) if (b.shape === shape) return b.key;
    for (const s of this.sketches.values()) if (s.shape === shape) return s.key;
    for (const p of this.planes.values()) if (p.shape === shape) return p.key;
    return undefined;
  }
}

interface WalkContext {
  doc: WhittleDoc;
  part: Part;
  pc: PartCache;
  state: ModelState;
  failed: Set<Id>;
  tainted: Set<string>;
  used: Set<string>;
  hits: number;
  misses: number;
  diag: { version: number; value: number } | null;
  attachments: Record<string, Uint8Array>;
  /** Ids of the part's import features (their names are geometric-key names: weak evidence). */
  importIds: Set<Id>;
  /** Imports used by this regen (sha256). */
  usedImports: Set<string>;
  /** The feature being planned: id and the refs rebound so far. */
  current: { featureId: Id; rebound: ReboundRef[] };
}

/** What a feature needs once its references are resolved. */
interface Plan {
  key: string;
  /** Bodies the feature reads or acts on (taint check before running). */
  involved: string[];
  /** `transient`: the outcome depends on something outside the key (attachments): don't cache it. */
  run: () => Promise<{ result: EntryResult; owned: ShapeHandle[]; transient?: boolean }>;
}

interface Planned {
  plan?: Plan;
  unresolved: UnresolvedRef[];
  /** Bodies to taint if the feature fails. */
  taint: string[];
  /** An error detected while planning (e.g. a non-planar sketch face). */
  error?: KernelError;
}

const FIELD_LABELS: Record<string, string> = {
  '/dx': 'Length X',
  '/dy': 'Length Y',
  '/dz': 'Length Z',
  '/radius': 'Radius',
  '/height': 'Height',
  '/end/depth': 'Depth',
  '/draft': 'Draft angle',
  '/angle': 'Angle',
  '/mode/distance': 'Distance',
  '/mode/angle': 'Angle',
  '/distance': 'Distance',
  '/definition/distance': 'Offset',
};

const kerr = (
  code: KernelError['code'],
  message: string,
  extra: Partial<Omit<KernelError, 'code' | 'message'>> = {},
): KernelError => ({ code, message, ...extra });

const SKETCH_TAG = /^S([0-9A-Za-z]+):/;
const PLANE_NAME = /^F([0-9A-Za-z]+):plane$/;

function definition(f: Feature): unknown {
  return { ...f, name: undefined, suppressed: undefined, annotations: undefined };
}

function refKind(ref: EntityRef): SubKind | 'body' {
  return ref.kind === 'region' ? 'face' : ref.kind;
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

export class RegenEngine {
  private readonly kernel: RegenEngineDeps['kernel'];
  private readonly solverLoader: RegenEngineDeps['sketchSolver'];
  private solver: SketchSolve | null = null;
  private maxSpare: number;
  private readonly quality: Record<
    MeshQuality,
    { linearDeflection: number; angularDeflection: number }
  >;
  private readonly now: () => number;
  private readonly parts = new Map<Id, PartCache>();
  /** Per-handle caches; dropped when the handle is released. */
  private readonly fps = new Map<ShapeHandle, ShapeFingerprints | null>();
  private readonly mass = new Map<string, MassProperties | null>();
  private readonly meshes = new Map<string, MeshBuffers>();
  /** Every handle owned by a cache entry (the UI must never release these). */
  private readonly ownedHandles = new Set<ShapeHandle>();
  /** Serialises engine calls (Comlink may interleave async calls). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RegenEngineDeps) {
    this.kernel = deps.kernel;
    this.solverLoader = deps.sketchSolver;
    this.maxSpare = validSpare(deps.options?.maxSpareResults) ?? 128;
    this.quality = { ...MESH_QUALITY, ...deps.options?.meshQuality };
    this.now = deps.options?.now ?? (() => performance.now());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  regenerate(request: RegenRequest): Promise<RegenOutput> {
    return this.serial(() => this.regen(request));
  }

  /**
   * Changes the cache budget at runtime (e.g. the tablet/phone tier). Takes effect at the next
   * regen of each part, which evicts down to the new bound.
   */
  configure(options: Pick<RegenEngineOptions, 'maxSpareResults'>): Promise<void> {
    return this.serial(async () => {
      const spare = validSpare(options.maxSpareResults);
      if (spare !== undefined) this.maxSpare = spare;
    });
  }

  refFor(partId: Id, query: EntityQuery): Promise<EntityRef | null> {
    return this.serial(async () => {
      const body = this.parts.get(partId)?.latest?.bodies.find((b) => b.id === query.bodyId);
      if (!body) return null;
      const entry = body.naming.find((n) => n.kind === query.kind && n.index === query.index);
      if (!entry) return null;
      const fp = await this.fingerprints(body.shape);
      const ref: EntityRef = { name: entry.name, kind: query.kind };
      const fingerprint = fp ? fingerprintOf(fp, query.kind, query.index) : undefined;
      if (fingerprint) ref.fingerprint = fingerprint;
      return ref;
    });
  }

  /**
   * Exact measurement on the latest regen of a part (M2). Body targets resolve exactly as
   * `refFor` does: the body by its `BodyResult` id, `index` = the mesh face/edge (TopExp) ordinal
   * of that body's shape; vertices by TopExp vertex index.
   */
  measure(partId: Id, a: MeasureTarget, b?: MeasureTarget): Promise<Result<Measurement>> {
    return this.serial(async () => {
      const latest = this.parts.get(partId)?.latest;
      if (!latest) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', 'This part has not been regenerated yet', {
            hint: 'Regenerate the part before measuring.',
          }),
        };
      }
      const sa = await this.measureSubject(latest.bodies, a);
      if ('code' in sa) return { ok: false, error: sa };
      if (b === undefined) return this.kernel.measureShapes(sa);
      const sb = await this.measureSubject(latest.bodies, b);
      if ('code' in sb) return { ok: false, error: sb };
      return this.kernel.measureShapes(sa, sb);
    });
  }

  private async measureSubject(
    bodies: BodyState[],
    t: MeasureTarget,
  ): Promise<MeasureSubject | KernelError> {
    if ('point' in t) {
      if (!t.point.every((v) => Number.isFinite(v))) {
        return kerr('INVALID_INPUT', 'A measure point needs finite coordinates');
      }
      return { point: t.point };
    }
    const body = bodies.find((x) => x.id === t.bodyId);
    if (!body) {
      return kerr('UNRESOLVED_REFERENCE', 'The picked body is no longer in the model', {
        hint: 'Pick it again.',
        entityRefs: [t.bodyId],
      });
    }
    if (body.meshOnly) return meshOnlyError('measured exactly', body.id);
    const fp = await this.fingerprints(body.shape);
    const count =
      t.kind === 'face'
        ? fp?.faces.length
        : t.kind === 'edge'
          ? fp?.edges.length
          : fp?.vertices.length;
    if (!Number.isInteger(t.index) || t.index < 0 || (count !== undefined && t.index >= count)) {
      return kerr('UNRESOLVED_REFERENCE', `The picked ${t.kind} is no longer on the body`, {
        hint: 'Pick it again.',
        entityRefs: [t.bodyId],
      });
    }
    return { shape: body.shape, kind: t.kind, index: t.index };
  }

  exportPart(partId: Id, format: ExportFormat, options: ExportOptions = {}): Promise<ExportResult> {
    return this.serial(async () => {
      const latest = this.parts.get(partId)?.latest;
      if (!latest) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', 'This part has not been regenerated yet', {
            hint: 'Regenerate the part before exporting.',
          }),
        };
      }
      const wanted = options.bodies;
      const bodies = latest.bodies.filter((b) => wanted === undefined || wanted.includes(b.id));
      if (bodies.length === 0) {
        return { ok: false, error: kerr('INVALID_INPUT', 'There are no bodies to export') };
      }
      const base = latest.partName.trim() || 'Part';
      const shapes = bodies.map((b, i) => ({
        shape: b.shape,
        name: bodies.length === 1 ? base : `${base} ${i + 1}`,
      }));
      const opts: ExportOptions = { ...options };
      delete opts.bodies;
      if (format === 'step') opts.stepSchema = options.stepSchema ?? 'AP214';
      const r = await this.kernel.exportShapes(shapes, format, opts);
      if (!r.ok) return r;
      const files = r.value;
      if (files.length === 1) return { ok: true, bytes: (files[0] as { bytes: Uint8Array }).bytes };
      const entries: Record<string, Uint8Array> = {};
      files.forEach((f, i) => {
        let name = f.name || `body-${i + 1}.${format}`;
        if (!name.toLowerCase().endsWith(`.${format}`)) name = `${name}.${format}`;
        while (name in entries) name = `${i + 1}-${name}`;
        entries[name] = f.bytes;
      });
      return { ok: true, bytes: zipSync(entries, { level: 6 }) };
    });
  }

  importFile(bytes: Uint8Array, format: ExportFormat): Promise<ImportResult> {
    return this.serial(async () => {
      const r = await this.kernel.importShapes(bytes, format);
      if (!r.ok) return r;
      const out: { shape: ShapeHandle; mesh: MeshBuffers; name?: string }[] = [];
      for (const b of r.value) {
        const m = await this.kernel.mesh(b.shape, { ...this.quality.fine, relative: true });
        if (!m.ok) {
          for (const x of r.value) await this.kernel.release(x.shape);
          return m;
        }
        out.push(
          b.name === undefined ? { shape: b.shape, mesh: m.value } : { ...b, mesh: m.value },
        );
      }
      return { ok: true, bodies: out };
    });
  }

  closePart(partId: Id): Promise<void> {
    return this.serial(async () => {
      const pc = this.parts.get(partId);
      if (!pc) return;
      for (const e of pc.entries.values()) await this.releaseEntry(e);
      for (const raw of pc.imports.values()) await this.releaseRaw(raw);
      this.parts.delete(partId);
    });
  }

  /** Is `shape` owned by the regen cache (released by the engine, never by callers)? */
  ownsHandle(shape: ShapeHandle): boolean {
    return this.ownedHandles.has(shape);
  }

  /** Diagnostics: cache entries and owned handles per part. */
  stats(partId: Id): { entries: number; handles: number } | null {
    const pc = this.parts.get(partId);
    if (!pc) return null;
    let handles = 0;
    for (const e of pc.entries.values()) handles += e.owned.length;
    return { entries: pc.entries.size, handles };
  }

  // -------------------------------------------------------------------------------------------
  // Shape-level caches
  // -------------------------------------------------------------------------------------------

  private async fingerprints(shape: ShapeHandle): Promise<ShapeFingerprints | null> {
    if (this.fps.has(shape)) return this.fps.get(shape) ?? null;
    const r = await this.kernel.fingerprints(shape);
    const v = r.ok ? r.value : null;
    this.fps.set(shape, v);
    return v;
  }

  private async massOf(shape: ShapeHandle, density?: number): Promise<MassProperties | null> {
    const k = `${shape}|${density ?? 0}`;
    if (this.mass.has(k)) return this.mass.get(k) ?? null;
    const r = await this.kernel.massProperties(shape, density);
    const v = r.ok ? r.value : null;
    this.mass.set(k, v);
    return v;
  }

  private async meshOf(shape: ShapeHandle, quality: MeshQuality): Promise<MeshBuffers | null> {
    const k = `${shape}|${quality}`;
    const cached = this.meshes.get(k);
    if (cached) return cached;
    const r = await this.kernel.mesh(shape, { ...this.quality[quality], relative: true });
    if (!r.ok) return null;
    this.meshes.set(k, r.value);
    return r.value;
  }

  private async releaseHandle(shape: ShapeHandle): Promise<void> {
    this.ownedHandles.delete(shape);
    this.fps.delete(shape);
    for (const k of [...this.mass.keys()]) if (k.startsWith(`${shape}|`)) this.mass.delete(k);
    this.meshes.delete(`${shape}|coarse`);
    this.meshes.delete(`${shape}|fine`);
    await this.kernel.release(shape);
  }

  private async releaseEntry(e: CacheEntry): Promise<void> {
    for (const h of e.owned) await this.releaseHandle(h);
    e.owned = [];
  }

  private async releaseRaw(raw: RawImport): Promise<void> {
    for (const h of raw.shapes) await this.releaseHandle(h);
    raw.shapes = [];
  }

  /**
   * `execFeature` with kernel names translated to document names (imported topology: see
   * `translateName`). Every kernel feature call of the engine goes through here.
   */
  private async exec(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>> {
    const r = await this.kernel.execFeature(feature, inputs);
    if (!r.ok) return { ok: false, error: translateError(r.error) };
    const v = r.value;
    const out: FeatureResult = {
      ...v,
      naming: translateNaming(v.naming),
      warnings: v.warnings.map(translateError),
    };
    if (v.bodies) out.bodies = v.bodies.map((b) => ({ ...b, naming: translateNaming(b.naming) }));
    return { ok: true, value: out };
  }

  // -------------------------------------------------------------------------------------------
  // Regeneration
  // -------------------------------------------------------------------------------------------

  private partCache(id: Id): PartCache {
    let pc = this.parts.get(id);
    if (!pc) {
      pc = {
        entries: new Map(),
        revision: 0,
        tick: 0,
        latest: null,
        lastGood: null,
        imports: new Map(),
        lastResolved: new Map(),
      };
      this.parts.set(id, pc);
    }
    return pc;
  }

  private async regen(request: RegenRequest): Promise<RegenOutput> {
    const t0 = this.now();
    const { doc, partId } = request;
    const part = doc.parts.find((p) => p.id === partId);
    const pc = this.partCache(partId);
    pc.revision += 1;
    pc.tick += 1;
    if (!part) {
      return {
        partId,
        revision: pc.revision,
        features: [],
        bodies: [],
        sketches: [],
        totalMs: this.now() - t0,
        cache: { hits: 0, misses: 0 },
      };
    }
    const ctx: WalkContext = {
      doc,
      part,
      pc,
      state: new ModelState(),
      failed: new Set(),
      tainted: new Set(),
      used: new Set(),
      hits: 0,
      misses: 0,
      diag: null,
      attachments: request.attachments ?? {},
      importIds: new Set(part.features.filter((f) => f.type === 'import').map((f) => f.id)),
      usedImports: new Set(),
      current: { featureId: '', rebound: [] },
    };
    const rollback = Math.max(0, Math.min(part.rollbackIndex, part.features.length));
    const features: RegenFeatureStatus[] = [];
    for (let i = 0; i < part.features.length; i++) {
      const f = part.features[i] as Feature;
      if (i >= rollback) {
        features.push({ featureId: f.id, state: 'rolledBack', cached: false, ms: 0 });
      } else if (f.suppressed) {
        features.push({ featureId: f.id, state: 'suppressed', cached: false, ms: 0 });
      } else {
        const ft = this.now();
        const status = await this.runFeature(ctx, f);
        status.ms = this.now() - ft;
        features.push(status);
      }
    }

    // Outputs.
    const density = this.densityOf(part, doc);
    const wantMass = request.massProperties === true || part.material !== undefined;
    const finalBodies = [...ctx.state.bodies.values()];
    const bodies: BodyResult[] = [];
    for (const b of finalBodies) {
      const out = await this.bodyResult(b, request.quality, wantMass, density);
      if (out) bodies.push(out);
    }
    const sketches: SketchResult[] = [];
    for (const s of ctx.state.sketches.values()) {
      sketches.push(await this.sketchResult(s, request.quality));
    }

    const allOk = features.every(
      (s) => s.state === 'ok' || s.state === 'suppressed' || s.state === 'rolledBack',
    );
    let ghosts: BodyResult[] | undefined;
    if (allOk) {
      pc.lastGood = { bodies: finalBodies, keys: new Set(ctx.used) };
    } else if (pc.lastGood) {
      ghosts = [];
      for (const g of pc.lastGood.bodies) {
        const now = ctx.state.bodies.get(g.id);
        if (now && now.shape === g.shape) continue;
        const out = await this.bodyResult(g, request.quality, false, undefined);
        if (out) ghosts.push(out);
      }
    }
    pc.latest = { bodies: finalBodies, keys: new Set(ctx.used), partName: part.name };
    await this.evict(pc);
    await this.evictImports(pc, ctx.usedImports);

    const result: RegenOutput = {
      partId,
      revision: pc.revision,
      features,
      bodies,
      sketches,
      totalMs: this.now() - t0,
      cache: { hits: ctx.hits, misses: ctx.misses },
    };
    if (ghosts && ghosts.length > 0) result.ghosts = ghosts;
    return result;
  }

  private densityOf(part: Part, doc: WhittleDoc): number | undefined {
    if (!part.material) return undefined;
    const d = tryResolveDensity(part.material, expressionEngine, scopeOf(doc));
    return d.ok ? d.value : undefined;
  }

  private async bodyResult(
    b: BodyState,
    quality: MeshQuality,
    wantMass: boolean,
    density: number | undefined,
  ): Promise<BodyResult | null> {
    const mesh = await this.meshOf(b.shape, quality);
    if (!mesh) return null;
    const out: BodyResult = { id: b.id, shape: b.shape, mesh: copyMesh(mesh) };
    // Names from the body's naming map: the kernel's mesh names are its internal ones (imports
    // are translated, mesh-only bodies are named by the engine).
    out.mesh.faceNames = namesByIndex(b.naming, 'face', out.mesh.faceRanges.length / 2);
    out.mesh.edgeNames = namesByIndex(b.naming, 'edge', out.mesh.edgeRanges.length / 2);
    if (wantMass) {
      const mp = await this.massOf(b.shape, density);
      if (mp) out.massProperties = mp;
    }
    return out;
  }

  private async sketchResult(s: SketchState, quality: MeshQuality): Promise<SketchResult> {
    const points = new Map<string, Vec2>();
    for (const e of s.entities) if (e.kind === 'point') points.set(e.id, [e.x, e.y]);
    // Chord tolerance from the sketch's extent so display matches the viewport quality.
    let extent = 0;
    for (const p of points.values()) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
    for (const e of s.entities) {
      if (e.kind === 'circle') extent = Math.max(extent, e.radius);
    }
    const chord = Math.max(1e-4, (extent || 10) * this.quality[quality].linearDeflection);
    const curves: SketchResult['curves'] = [];
    const pts: NonNullable<SketchResult['points']> = [];
    for (const e of s.entities) {
      if (e.kind === 'point') {
        pts.push({ entity: e.id, at: toWorld(s.frame, e.x, e.y), construction: e.construction });
        continue;
      }
      const samples = sampleEntity(e, points, chord);
      const arr = new Float32Array(samples.length * 3);
      samples.forEach((uv, i) => {
        arr.set(toWorld(s.frame, uv[0], uv[1]), 3 * i);
      });
      curves.push({ entity: e.id, points: arr, construction: e.construction });
    }
    const regions: SketchResult['regions'] = [];
    const mesh = s.regions.length > 0 ? await this.meshOf(s.shape, quality) : null;
    for (const name of s.regions) {
      const fi = faceIndex(s.naming, name);
      if (mesh && fi >= 0) regions.push({ name, mesh: faceSubMesh(mesh, fi, name) });
    }
    return {
      featureId: s.id,
      curves,
      points: pts,
      regions,
      frame: { origin: s.frame.origin, x: s.frame.x, y: crossY(s.frame), z: s.frame.z },
    };
  }

  /** Keeps imports used by this regen plus the `IMPORT_SPARE` most recently used others. */
  private async evictImports(pc: PartCache, used: Set<string>): Promise<void> {
    for (const sha of used) {
      const raw = pc.imports.get(sha);
      if (raw) raw.lastUsed = pc.tick;
    }
    const spare = [...pc.imports.values()]
      .filter((r) => !used.has(r.sha))
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const raw of spare.slice(IMPORT_SPARE)) {
      await this.releaseRaw(raw);
      pc.imports.delete(raw.sha);
    }
  }

  private async evict(pc: PartCache): Promise<void> {
    const keep = new Set<string>([...(pc.latest?.keys ?? []), ...(pc.lastGood?.keys ?? [])]);
    const spare = [...pc.entries.values()]
      .filter((e) => !keep.has(e.key))
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const e of spare.slice(this.maxSpare)) {
      await this.releaseEntry(e);
      pc.entries.delete(e.key);
    }
  }

  // -------------------------------------------------------------------------------------------
  // One feature
  // -------------------------------------------------------------------------------------------

  private async runFeature(ctx: WalkContext, f: Feature): Promise<RegenFeatureStatus> {
    ctx.current = { featureId: f.id, rebound: [] };
    const status = (
      state: RegenFeatureStatus['state'],
      extra: Partial<RegenFeatureStatus> = {},
    ) => {
      const s = { featureId: f.id, state, cached: false, ms: 0, ...extra } as RegenFeatureStatus;
      if (ctx.current.rebound.length > 0) s.rebound = ctx.current.rebound;
      return s;
    };
    const fail = (taint: string[]) => {
      ctx.failed.add(f.id);
      for (const b of taint) ctx.tainted.add(b);
    };
    const allBodies = () => [...ctx.state.bodies.keys()];

    // 1. References into failed features → blocked.
    for (const id of ctx.failed) {
      if (featureReferences(f, id)) {
        fail(allBodiesFor(f, allBodies()));
        return status('blocked', {
          error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature this one depends on failed', {
            hint: 'Fix the features marked above first.',
          }),
        });
      }
    }

    // 2. Values and references.
    const evaluated = evaluateFeatureValues(f, ctx.doc);
    const exprErrors = Object.entries(evaluated.errors).filter(
      ([p]) => !p.startsWith('/annotations/'),
    );
    let planned: Planned;
    try {
      planned = await this.planFeature(ctx, f, evaluated.values);
    } catch (e) {
      fail(allBodies());
      return status('error', {
        error: kerr('INTERNAL', 'The feature could not be prepared', { detail: String(e) }),
      });
    }

    // 3. Acting on a tainted body → blocked.
    if (planned.plan?.involved.some((b) => ctx.tainted.has(b))) {
      fail(planned.taint);
      return status('blocked', {
        error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature on this body failed', {
          hint: 'Fix the features marked above first.',
        }),
      });
    }

    // 4. Expression errors.
    if (exprErrors.length > 0) {
      fail(planned.taint);
      const [pointer, e] = exprErrors[0] as [string, { message: string }];
      const extra: Partial<RegenFeatureStatus> = {
        error: kerr('INVALID_INPUT', `${fieldLabel(f, pointer)}: ${e.message}`, {
          detail: exprErrors.map(([p, x]) => `${p}: ${x.message}`).join('\n'),
        }),
      };
      if (planned.unresolved.length > 0) extra.unresolved = planned.unresolved;
      return status('error', extra);
    }
    if (planned.error) {
      fail(planned.taint);
      return status('error', { error: planned.error });
    }

    // 5. Unresolved references → needs attention (never guessed).
    if (planned.unresolved.length > 0 || !planned.plan) {
      fail(planned.taint);
      const first = planned.unresolved[0];
      return status('needsAttention', {
        unresolved: planned.unresolved,
        error: kerr(
          'UNRESOLVED_REFERENCE',
          first?.reason === 'ambiguous'
            ? 'A selection now matches several entities'
            : 'A selection no longer exists',
          {
            hint: 'Re-pick the highlighted selection.',
            entityRefs: planned.unresolved.map((u) => u.ref.name),
          },
        ),
      });
    }

    // 6. Cache or kernel.
    const plan = planned.plan;
    let entry = ctx.pc.entries.get(plan.key);
    let cached = true;
    if (entry) {
      ctx.hits++;
    } else {
      cached = false;
      ctx.misses++;
      let ran: { result: EntryResult; owned: ShapeHandle[]; transient?: boolean };
      try {
        ran = await plan.run();
      } catch (e) {
        ran = {
          result: {
            ok: false,
            error: kerr('INTERNAL', 'The feature failed unexpectedly', { detail: String(e) }),
          },
          owned: [],
        };
      }
      entry = { key: plan.key, owned: ran.owned, result: ran.result, lastUsed: ctx.pc.tick };
      for (const h of ran.owned) this.ownedHandles.add(h);
      if (!ran.transient) ctx.pc.entries.set(plan.key, entry);
    }
    entry.lastUsed = ctx.pc.tick;
    if (ctx.pc.entries.get(plan.key) === entry) ctx.used.add(plan.key);
    const r = entry.result;
    if (!r.ok) {
      fail(planned.taint);
      return status('error', { error: r.error, cached });
    }
    if (r.touched.some((b) => ctx.tainted.has(b))) {
      fail(planned.taint);
      return status('blocked', {
        cached,
        error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature on this body failed', {
          hint: 'Fix the features marked above first.',
        }),
      });
    }
    ctx.state.apply(r);
    const out = status('ok', { cached });
    if (r.warnings.length > 0) out.warnings = r.warnings;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Reference resolution against the walk state
  // -------------------------------------------------------------------------------------------

  private async partDiag(ctx: WalkContext): Promise<number> {
    if (ctx.diag && ctx.diag.version === ctx.state.version) return ctx.diag.value;
    const box: Box3 = emptyBox();
    const shapes =
      ctx.state.bodies.size > 0
        ? [...ctx.state.bodies.values()].map((b) => b.shape)
        : [...ctx.state.sketches.values()].map((s) => s.shape);
    for (const s of shapes) {
      const fp = await this.fingerprints(s);
      for (const v of fp?.vertices ?? []) extendBox(box, v.point);
      for (const f of fp?.faces ?? []) extendBox(box, f.centroid);
    }
    const d = boxDiagonal(box);
    const value = d > 1e-9 ? d : 100;
    ctx.diag = { version: ctx.state.version, value };
    return value;
  }

  private candidates(ctx: WalkContext, ref: EntityRef, kind: SubKind): Candidate[] {
    const fromMap = (shape: ShapeHandle, naming: NamingMap, owner: string): Candidate[] =>
      naming
        .filter((n) => n.kind === kind)
        .map((n) => ({ shape, kind, index: n.index, name: n.name, owner }));
    const sk = SKETCH_TAG.exec(ref.name);
    if (sk || ref.kind === 'region') {
      const id = sk?.[1];
      const s = id === undefined ? undefined : ctx.state.sketches.get(id);
      return s ? fromMap(s.shape, s.naming, `sketch:${s.id}`) : [];
    }
    const pl = PLANE_NAME.exec(ref.name);
    if (pl) {
      const p = ctx.state.planes.get(pl[1] as string);
      return p ? fromMap(p.shape, p.naming, `plane:${p.id}`) : [];
    }
    const out: Candidate[] = [];
    for (const b of ctx.state.bodies.values()) out.push(...fromMap(b.shape, b.naming, b.id));
    return out;
  }

  /** Resolves a face/edge/vertex/region ref; records unresolved refs under `path`. */
  private async resolveSub(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
    planeLike = false,
  ): Promise<ResolvedTarget | null> {
    const kind = refKind(ref);
    if (kind === 'body') {
      unresolved.push({ path, ref, reason: 'missing' });
      return null;
    }
    const cands = this.candidates(ctx, ref, kind);
    const r = await resolveRef(ref, cands, {
      diag: await this.partDiag(ctx),
      planeLike,
      fingerprints: (s) => this.fingerprints(s),
      weak: (name) => mentionsImport(name, ctx.importIds),
    });
    const memo = `${ctx.current.featureId}|${path}`;
    if (r.ok) {
      const t = r.target;
      ctx.pc.lastResolved.set(memo, { shape: t.shape, kind: t.kind, index: t.index });
      if (t.name === ref.name && t.via === 'name') return t;
      const fp = await this.fingerprints(t.shape);
      const now = fp ? fingerprintOf(fp, t.kind, t.index) : undefined;
      // Rebound: the name changed, or fingerprint evidence picked it and the stored fingerprint
      // is out of date (the app heals both).
      const stale = !ref.fingerprint || !now || !sameFingerprint(ref.fingerprint, now);
      if (t.name !== ref.name || stale) {
        const rebound: ReboundRef = { path, name: t.name };
        if (now) rebound.fingerprint = now;
        ctx.current.rebound.push(rebound);
      }
      return t;
    }
    const u: RegenUnresolvedRef = { path, ref, reason: r.reason };
    if (r.candidates) u.candidates = r.candidates;
    const last = ctx.pc.lastResolved.get(memo);
    if (last && !ref.fingerprint && this.ownedHandles.has(last.shape)) {
      const fp = await this.fingerprints(last.shape);
      const lastKnown = fp ? fingerprintOf(fp, last.kind, last.index) : undefined;
      if (lastKnown) u.lastKnown = lastKnown;
    }
    unresolved.push(u);
    return null;
  }

  private resolveBody(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
  ): BodyState | null {
    const b = ctx.state.bodies.get(ref.name);
    if (b) return b;
    unresolved.push({ path, ref, reason: 'missing' });
    return null;
  }

  /** A resolved planar face/plane ref → deterministic frame (see `planeFrame`). */
  private async frameOfTarget(t: ResolvedTarget): Promise<Frame | KernelError> {
    if (t.kind !== 'face')
      return kerr('INVALID_INPUT', 'Pick a flat face or a plane', { entityRefs: [t.name] });
    const fp = await this.fingerprints(t.shape);
    const face = fp?.faces[t.index];
    if (!face?.normal) {
      return kerr('INVALID_INPUT', 'The selected face is not flat', {
        hint: 'Pick a planar face or a plane.',
        entityRefs: [t.name],
      });
    }
    return planeFrame(face.centroid, face.normal);
  }

  /**
   * A plane-like ref (sketch `on`, plane `from`, extrude up-to): origin planes and construction
   * planes by name, faces by planeLike resolution. Returns the frame, or null when unresolved.
   */
  private async resolvePlane(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
  ): Promise<{ frame: Frame; target?: ResolvedTarget; shapeKey: string } | KernelError | null> {
    const origin = ORIGIN_PLANES[ref.name];
    if (origin) return { frame: origin, shapeKey: ref.name };
    const pl = PLANE_NAME.exec(ref.name);
    if (pl) {
      const p = ctx.state.planes.get(pl[1] as string);
      if (p) {
        return {
          frame: p.frame,
          target: {
            shape: p.shape,
            kind: 'face',
            index: 0,
            name: ref.name,
            owner: `plane:${p.id}`,
            via: 'name',
          },
          shapeKey: p.key,
        };
      }
    }
    const t = await this.resolveSub(ctx, ref, path, unresolved, true);
    if (!t) return null;
    if (t.owner.startsWith('plane:')) {
      // Construction planes carry their own frame.
      const p = ctx.state.planes.get(t.owner.slice('plane:'.length));
      if (p) return { frame: p.frame, target: t, shapeKey: p.key };
    }
    const frame = await this.frameOfTarget(t);
    if ('code' in frame) return frame;
    return { frame, target: t, shapeKey: ctx.state.keyOf(t.shape) ?? '' };
  }

  // -------------------------------------------------------------------------------------------
  // Planning per feature type
  // -------------------------------------------------------------------------------------------

  private planFeature(
    ctx: WalkContext,
    f: Feature,
    values: Record<string, number>,
  ): Promise<Planned> {
    switch (f.type) {
      case 'sketch':
        return this.planSketch(ctx, f, values);
      case 'extrude':
      case 'revolve':
      case 'primitive':
        return this.planSolid(ctx, f, values);
      case 'fillet':
      case 'chamfer':
        return this.planEdgeOp(ctx, f, values);
      case 'boolean':
        return this.planBoolean(ctx, f, values);
      case 'plane':
        return this.planPlane(ctx, f, values);
      case 'pushPull':
        return this.planPushPull(ctx, f, values);
      case 'import':
        return this.planImport(ctx, f);
      default: {
        const unknown = f as { type: string };
        return Promise.resolve({
          unresolved: [],
          taint: [],
          error: kerr('UNSUPPORTED_FEATURE', `Unknown feature type ‘${unknown.type}’`),
        });
      }
    }
  }

  private refKeyOf(ctx: WalkContext, t: ResolvedTarget): [string, string, number] {
    return [ctx.state.keyOf(t.shape) ?? '', t.kind, t.index];
  }

  private async planSketch(
    ctx: WalkContext,
    f: SketchFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const plane = await this.resolvePlane(ctx, f.on, '/on', unresolved);
    if (plane === null) return { unresolved, taint: [] };
    if ('code' in plane) return { unresolved, taint: [], error: plane };
    const owner = plane.target?.owner;
    const involved = owner && ctx.state.bodies.has(owner) ? [owner] : [];
    const solveValues = sketchSolveValues(f, { values, errors: {} }).values;
    const frame = plane.frame;
    const key = hashKey({
      t: 'sketch',
      id: f.id,
      entities: f.entities,
      constraints: f.constraints,
      values: solveValues,
      frame,
    });
    return {
      unresolved,
      taint: [],
      plan: {
        key,
        involved,
        run: async () => {
          this.solver ??= await this.solverLoader();
          const solved = this.solver.solve({
            entities: f.entities,
            constraints: f.constraints,
            values: solveValues,
          });
          if (solved.status !== 'solved') {
            const c = solved.conflicts[0];
            const error =
              solved.status === 'conflicting' && c
                ? kerr('INVALID_INPUT', `The sketch is over-constrained: ${c.explanation}`, {
                    ...(c.fixes[0] ? { hint: c.fixes[0].label } : {}),
                    detail: `conflicting constraints: ${c.constraints.join(', ')}`,
                  })
                : kerr('OPERATION_FAILED', solved.error ?? 'The sketch could not be solved', {
                    hint: 'Check the dimensions for values that cannot all hold at once.',
                  });
            return { result: { ok: false, error }, owned: [] };
          }
          const r = await this.exec(
            { ...f, entities: solved.entities },
            { values: {}, frames: { plane: frame } },
          );
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          const sketch: SketchState = {
            id: f.id,
            shape: r.value.shape,
            naming: r.value.naming,
            frame, // ours (deterministic; the kernel echoes it)
            regions: r.value.regions ?? [],
            entities: solved.entities,
            key: `${key}/S`,
          };
          return {
            result: {
              ok: true,
              set: [],
              remove: [],
              touched: [],
              sketch,
              warnings: r.value.warnings,
            },
            owned: [r.value.shape],
          };
        },
      },
    };
  }

  /** Body scope of a solid feature: explicit bodies, all, or the default "touched" scope. */
  private scopeBodies(
    ctx: WalkContext,
    scope: BodyScope | undefined,
    unresolved: UnresolvedRef[],
  ): { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies'; error?: KernelError } {
    if (scope?.kind === 'bodies') {
      const bodies: BodyState[] = [];
      scope.bodies.forEach((ref, i) => {
        const b = this.resolveBody(ctx, ref, `/scope/bodies/${i}`, unresolved);
        if (b) bodies.push(b);
      });
      const mesh = bodies.find((b) => b.meshOnly);
      if (mesh) return { bodies, mode: 'bodies', error: meshOnlyError('changed', mesh.id) };
      return { bodies, mode: 'bodies' };
    }
    // Mesh reference bodies are never part of an implicit scope.
    return {
      bodies: [...ctx.state.bodies.values()].filter((b) => !b.meshOnly),
      mode: scope?.kind === 'all' ? 'all' : 'default',
    };
  }

  private async planSolid(
    ctx: WalkContext,
    f: ExtrudeFeature | RevolveFeature | PrimitiveFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const frames: Record<string, Frame> = {};
    const involved = new Set<string>();
    const note = (path: string, t: ResolvedTarget) => {
      refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
      refKeys[path] = this.refKeyOf(ctx, t);
      if (ctx.state.bodies.has(t.owner)) involved.add(t.owner);
    };
    if (f.type !== 'primitive') {
      for (let i = 0; i < f.profile.length; i++) {
        const t = await this.resolveSub(
          ctx,
          f.profile[i] as EntityRef,
          `/profile/${i}`,
          unresolved,
        );
        if (t) note(`/profile/${i}`, t);
      }
    }
    if (f.type === 'extrude' && f.end.kind === 'upTo') {
      const p = await this.resolvePlane(ctx, f.end.target, '/end/target', unresolved);
      if (p && !('code' in p)) {
        if (p.target) note('/end/target', p.target);
        else {
          frames.upTo = p.frame;
          refKeys['/end/target'] = p.shapeKey;
        }
      } else if (p && 'code' in p) {
        return { unresolved, taint: [], error: p };
      }
    }
    if (f.type === 'revolve') {
      const axis = ORIGIN_AXES[f.axis.name];
      if (axis) frames.axis = axis;
      else {
        const t = await this.resolveSub(ctx, f.axis, '/axis', unresolved);
        if (t) note('/axis', t);
      }
    }
    const scoped =
      f.op === 'new'
        ? { bodies: [] as BodyState[], mode: 'bodies' as const }
        : this.scopeBodies(ctx, f.scope, unresolved);
    if ('error' in scoped && scoped.error) {
      return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
    }
    // A failed `new` feature taints its would-be body id: implicit scopes can't know whether
    // that body would have been touched, so they are blocked rather than evaluated without it.
    const taint = f.op === 'new' ? [`B${f.id}`] : scoped.bodies.map((b) => b.id);
    if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
    else if (f.op !== 'new') {
      for (const t of ctx.tainted) if (!ctx.state.bodies.has(t)) involved.add(t);
    }
    const key = hashKey({
      t: f.type,
      def: definition(f),
      values,
      refs: refKeys,
      frames,
      scope: scoped.mode,
      bodies: scoped.bodies.map((b) => [b.id, b.key]),
    });
    const inputs: FeatureInputs = { values, refs, frames };
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: [...involved],
        run: () => this.runSolid(f, inputs, scoped, key),
      },
    };
  }

  /** Executes a solid feature with its body op and scope semantics. */
  private async runSolid(
    f: ExtrudeFeature | RevolveFeature | PrimitiveFeature,
    inputs: FeatureInputs,
    scoped: { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies' },
    key: string,
  ): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
    const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
    const newBody = (r: FeatureResult, warnings: KernelError[]) => ({
      result: {
        ok: true as const,
        set: [{ id: `B${f.id}`, shape: r.shape, naming: r.naming, key: `${key}/B${f.id}` }],
        remove: [],
        touched: [],
        warnings,
      },
      owned: [r.shape],
    });
    if (f.op === 'new') {
      const r = await this.exec(f, inputs);
      return r.ok ? newBody(r.value, r.value.warnings) : fail(r.error);
    }

    let candidates = scoped.bodies;
    let tool: FeatureResult | null = null;
    const throughAll = f.type === 'extrude' && f.end.kind === 'throughAll';
    if (scoped.mode === 'default' && !throughAll) {
      // Prefilter "every body the tool touches" by bounding boxes of the tool alone.
      const t = await this.exec({ ...f, op: 'new', scope: undefined } as Feature, inputs);
      if (!t.ok) return fail(t.error);
      tool = t.value;
      const tb = await this.massOf(tool.shape);
      if (tb && candidates.length > 0) {
        const tol = 1e-6 * Math.max(1, boxDiagonal(tb.bbox));
        const kept: BodyState[] = [];
        for (const b of candidates) {
          const bb = await this.massOf(b.shape);
          if (!bb || boxesOverlap(bb.bbox, tb.bbox, tol)) kept.push(b);
        }
        candidates = kept;
      }
    }
    const dropTool = async () => {
      if (tool) await this.releaseHandle(tool.shape);
      tool = null;
    };

    if (candidates.length === 0) {
      if (f.op === 'add' && scoped.mode === 'default') {
        // Nothing to merge with: the material becomes a new body.
        const warning = kerr(
          'OPERATION_FAILED',
          scoped.bodies.length === 0
            ? 'There is no body to add to; created a new body'
            : 'The new material touches no body; created a new body',
        );
        if (tool) {
          const t = tool;
          tool = null;
          return newBody(t, [warning, ...t.warnings]);
        }
        const r = await this.exec({ ...f, op: 'new', scope: undefined } as Feature, inputs);
        return r.ok ? newBody(r.value, [warning, ...r.value.warnings]) : fail(r.error);
      }
      await dropTool();
      if (f.op === 'cut' && scoped.mode === 'default' && scoped.bodies.length > 0) {
        return {
          result: {
            ok: true,
            set: [],
            remove: [],
            touched: [],
            warnings: [
              kerr('OPERATION_FAILED', 'The cut does not touch any body', {
                hint: 'Move the sketch, or extend the cut depth.',
              }),
            ],
          },
          owned: [],
        };
      }
      return fail(
        kerr('INVALID_INPUT', `There is no body to ${f.op === 'add' ? 'add to' : f.op}`, {
          hint: 'Create a body first, or set the operation to New.',
        }),
      );
    }
    await dropTool();

    const exec = (bodies: BodyState[]) => {
      const shapes: Record<string, ShapeHandle> = {};
      bodies.slice(1).forEach((b, i) => {
        shapes[`scope:${String(i + 1).padStart(4, '0')}`] = b.shape;
      });
      return this.exec(f, {
        ...inputs,
        target: (bodies[0] as BodyState).shape,
        shapes: { ...inputs.shapes, ...shapes },
      });
    };
    const resultsOf = (r: FeatureResult, bodies: BodyState[]) => {
      const out = new Map<string, { shape: ShapeHandle; naming: NamingMap }>();
      out.set((bodies[0] as BodyState).id, { shape: r.shape, naming: r.naming });
      for (const extra of r.bodies ?? []) {
        const i = Number(extra.key.slice('scope:'.length));
        const b = bodies[i];
        if (b) out.set(b.id, { shape: extra.shape, naming: extra.naming });
      }
      return out;
    };

    if (f.op === 'add') {
      const r = await exec(candidates);
      if (!r.ok) return fail(r.error);
      const first = candidates[0] as BodyState;
      // Merged bodies: the oldest keeps its id; extra handles (none expected for fuse) released.
      for (const extra of r.value.bodies ?? []) await this.releaseHandle(extra.shape);
      return {
        result: {
          ok: true,
          set: [
            {
              id: first.id,
              shape: r.value.shape,
              naming: r.value.naming,
              key: `${key}/${first.id}`,
            },
          ],
          remove: candidates.slice(1).map((b) => b.id),
          touched: candidates.map((b) => b.id),
          warnings: r.value.warnings,
        },
        owned: [r.value.shape],
      };
    }

    // cut / intersect: one result per body; untouched bodies keep their shape.
    let produced: Map<string, { shape: ShapeHandle; naming: NamingMap }>;
    let warnings: KernelError[];
    const r = await exec(candidates);
    if (r.ok) {
      produced = resultsOf(r.value, candidates);
      warnings = r.value.warnings;
    } else if (f.op === 'intersect' && scoped.mode !== 'bodies' && candidates.length > 1) {
      // Some bbox candidate does not overlap: intersect body by body, skipping empty ones.
      produced = new Map();
      warnings = [];
      for (const b of candidates) {
        const one = await exec([b]);
        if (one.ok) {
          produced.set(b.id, { shape: one.value.shape, naming: one.value.naming });
          warnings.push(...one.value.warnings);
        }
      }
      if (produced.size === 0) return fail(r.error);
    } else {
      return fail(r.error);
    }

    const set: BodyState[] = [];
    const owned: ShapeHandle[] = [];
    const touched: string[] = [];
    for (const b of candidates) {
      const p = produced.get(b.id);
      if (!p) continue;
      if (f.op === 'cut' && scoped.mode !== 'bodies' && (await this.sameSolid(b.shape, p.shape))) {
        await this.releaseHandle(p.shape);
        continue;
      }
      set.push({ id: b.id, shape: p.shape, naming: p.naming, key: `${key}/${b.id}` });
      owned.push(p.shape);
      touched.push(b.id);
    }
    if (f.op === 'cut' && scoped.mode !== 'bodies') {
      // Per-body "does not touch" warnings are expected with an implicit scope.
      warnings = warnings.filter((w) => w.message !== 'The cut does not touch the body');
      if (touched.length === 0) {
        warnings.push(
          kerr('OPERATION_FAILED', 'The cut does not touch any body', {
            hint: 'Move the sketch, or extend the cut depth.',
          }),
        );
      }
    }
    return { result: { ok: true, set, remove: [], touched, warnings }, owned };
  }

  /** Same volume and topology counts: the boolean left the body unchanged. */
  private async sameSolid(a: ShapeHandle, b: ShapeHandle): Promise<boolean> {
    const ma = await this.massOf(a);
    const mb = await this.massOf(b);
    if (!ma || !mb) return false;
    return (
      Math.abs(ma.volume - mb.volume) <= 1e-9 * Math.max(1, Math.abs(ma.volume)) &&
      ma.faceCount === mb.faceCount &&
      ma.edgeCount === mb.edgeCount
    );
  }

  private async planEdgeOp(
    ctx: WalkContext,
    f: FilletFeature | ChamferFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const groups = new Map<string, { body: BodyState; refs: Record<string, ResolvedRef> }>();
    const refKeys: Record<string, unknown> = {};
    const add = (path: string, t: ResolvedTarget): KernelError | null => {
      const body = ctx.state.bodies.get(t.owner);
      if (body?.meshOnly) {
        return meshOnlyError(f.type === 'fillet' ? 'filleted' : 'chamfered', body.id);
      }
      if (!body)
        return kerr(
          'INVALID_INPUT',
          `Only edges of a body can be ${f.type === 'fillet' ? 'filleted' : 'chamfered'}`,
          { entityRefs: [t.name] },
        );
      let g = groups.get(body.id);
      if (!g) {
        g = { body, refs: {} };
        groups.set(body.id, g);
      }
      g.refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
      refKeys[path] = this.refKeyOf(ctx, t);
      return null;
    };
    for (let i = 0; i < f.edges.length; i++) {
      const t = await this.resolveSub(ctx, f.edges[i] as EntityRef, `/edges/${i}`, unresolved);
      if (t) {
        const e = add(`/edges/${i}`, t);
        if (e) return { unresolved, taint: [t.owner], error: e };
      }
    }
    if (f.type === 'chamfer' && f.mode.kind === 'distanceAngle' && f.mode.face) {
      const t = await this.resolveSub(ctx, f.mode.face, '/mode/face', unresolved);
      if (t) {
        const e = add('/mode/face', t);
        if (e) return { unresolved, taint: [t.owner], error: e };
      }
    }
    const owners = [...groups.keys()];
    const taint = owners.length > 0 ? owners : [...ctx.state.bodies.keys()];
    const key = hashKey({
      t: f.type,
      def: definition(f),
      values,
      refs: refKeys,
      bodies: [...groups.values()].map((g) => [g.body.id, g.body.key]),
    });
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: owners,
        run: async () => {
          const set: BodyState[] = [];
          const owned: ShapeHandle[] = [];
          const warnings: KernelError[] = [];
          for (const g of groups.values()) {
            const r = await this.exec(f, {
              values,
              target: g.body.shape,
              refs: g.refs,
            });
            if (!r.ok) {
              for (const h of owned) await this.releaseHandle(h);
              return { result: { ok: false, error: r.error }, owned: [] };
            }
            set.push({
              id: g.body.id,
              shape: r.value.shape,
              naming: r.value.naming,
              key: `${key}/${g.body.id}`,
            });
            owned.push(r.value.shape);
            warnings.push(...r.value.warnings);
          }
          return { result: { ok: true, set, remove: [], touched: owners, warnings }, owned };
        },
      },
    };
  }

  private async planBoolean(
    ctx: WalkContext,
    f: Extract<Feature, { type: 'boolean' }>,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const target = this.resolveBody(ctx, f.target, '/target', unresolved);
    const tools: BodyState[] = [];
    f.tools.forEach((ref, i) => {
      const b = this.resolveBody(ctx, ref, `/tools/${i}`, unresolved);
      if (b) tools.push(b);
    });
    const involved = [...(target ? [target.id] : []), ...tools.map((t) => t.id)];
    const taint = involved.length > 0 ? involved : [...ctx.state.bodies.keys()];
    const mesh = [...(target ? [target] : []), ...tools].find((b) => b.meshOnly);
    if (mesh) return { unresolved, taint, error: meshOnlyError('combined', mesh.id) };
    if (target && tools.some((t) => t.id === target.id)) {
      return {
        unresolved,
        taint,
        error: kerr('INVALID_INPUT', 'A body cannot be combined with itself', {
          entityRefs: [target.id],
        }),
      };
    }
    const key = hashKey({
      t: 'boolean',
      def: definition(f),
      bodies: involved.map((id) => [id, ctx.state.bodies.get(id)?.key]),
    });
    const refs: Record<string, ResolvedRef> = {};
    if (target) refs['/target'] = { shape: target.shape, kind: 'body', index: 0 };
    tools.forEach((t, i) => {
      refs[`/tools/${i}`] = { shape: t.shape, kind: 'body', index: 0 };
    });
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved,
        run: async () => {
          if (!target)
            return {
              result: { ok: false, error: kerr('UNRESOLVED_REFERENCE', 'Select the target body') },
              owned: [],
            };
          const r = await this.exec(f, { values, refs });
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          for (const extra of r.value.bodies ?? []) await this.releaseHandle(extra.shape);
          return {
            result: {
              ok: true,
              set: [
                {
                  id: target.id,
                  shape: r.value.shape,
                  naming: r.value.naming,
                  key: `${key}/${target.id}`,
                },
              ],
              remove: f.keepTools ? [] : tools.map((t) => t.id),
              touched: involved,
              warnings: r.value.warnings,
            },
            owned: [r.value.shape],
          };
        },
      },
    };
  }

  private async planPlane(
    ctx: WalkContext,
    f: PlaneFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const frames: Record<string, Frame> = {};
    let fromKey: unknown = null;
    let involved: string[] = [];
    if (f.definition.kind === 'offset') {
      const p = await this.resolvePlane(ctx, f.definition.from, '/definition/from', unresolved);
      if (p === null) return { unresolved, taint: [] };
      if ('code' in p) return { unresolved, taint: [], error: p };
      frames.from = p.frame;
      fromKey = p.shapeKey;
      const owner = p.target?.owner;
      if (owner && ctx.state.bodies.has(owner)) involved = [owner];
    }
    const key = hashKey({ t: 'plane', def: definition(f), values, frames, from: fromKey });
    return {
      unresolved,
      taint: [],
      plan: {
        key,
        involved,
        run: async () => {
          const r = await this.exec(f, { values, frames });
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          const plane: PlaneState = {
            id: f.id,
            shape: r.value.shape,
            naming: r.value.naming,
            frame: r.value.frame ??
              frames.from ?? { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] },
            key: `${key}/P`,
          };
          return {
            result: {
              ok: true,
              set: [],
              remove: [],
              touched: [],
              plane,
              warnings: r.value.warnings,
            },
            owned: [r.value.shape],
          };
        },
      },
    };
  }

  /**
   * Push/pull (M2): faces of one body moved along their outward normals by `distance`. The
   * kernel names the result per naming.ts "M2 additions" (moved faces keep their names, new walls
   * are `F…:side(<edge>)`), so the body keeps its id and downstream refs keep resolving.
   */
  private async planPushPull(
    ctx: WalkContext,
    f: PushPullFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const owners = new Set<string>();
    const picked: string[] = [];
    for (let i = 0; i < f.faces.length; i++) {
      const ref = f.faces[i] as EntityRef;
      if (ref.kind !== 'face') {
        return {
          unresolved,
          taint: [],
          error: kerr('INVALID_INPUT', 'Only faces can be pushed or pulled', {
            hint: 'Pick flat faces of a body.',
            entityRefs: [ref.name],
          }),
        };
      }
      const t = await this.resolveSub(ctx, ref, `/faces/${i}`, unresolved);
      if (t) {
        refs[`/faces/${i}`] = { shape: t.shape, kind: t.kind, index: t.index };
        refKeys[`/faces/${i}`] = this.refKeyOf(ctx, t);
        owners.add(t.owner);
        picked.push(t.name);
      }
    }
    const bodyIds = [...owners].filter((o) => ctx.state.bodies.has(o));
    const taint = bodyIds.length > 0 ? bodyIds : [...ctx.state.bodies.keys()];
    if (f.faces.length === 0) {
      return {
        unresolved,
        taint,
        error: kerr('UNRESOLVED_REFERENCE', 'Select at least one face to push or pull', {
          hint: 'Pick a flat face of a body.',
        }),
      };
    }
    const mesh = bodyIds.find((id) => ctx.state.bodies.get(id)?.meshOnly);
    if (mesh) return { unresolved, taint, error: meshOnlyError('pushed or pulled', mesh) };
    if (owners.size > 1 || (owners.size === 1 && bodyIds.length === 0)) {
      return {
        unresolved,
        taint,
        error: kerr(
          'INVALID_INPUT',
          bodyIds.length === 0
            ? 'Push/pull moves faces of a body'
            : 'Push/pull faces must all be on one body',
          { hint: 'Pick faces of one solid body.', entityRefs: picked },
        ),
      };
    }
    const bodyId = bodyIds[0];
    const key = hashKey({ t: 'pushPull', def: definition(f), values, refs: refKeys });
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: bodyIds,
        run: async () => {
          const body = bodyId === undefined ? undefined : ctx.state.bodies.get(bodyId);
          if (!body) {
            return {
              result: {
                ok: false,
                error: kerr('UNRESOLVED_REFERENCE', 'Select the faces to push or pull'),
              },
              owned: [],
            };
          }
          const r = await this.exec(f, { target: body.shape, values, refs });
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          return {
            result: {
              ok: true,
              set: [
                {
                  id: body.id,
                  shape: r.value.shape,
                  naming: r.value.naming,
                  key: `${key}/${body.id}`,
                },
              ],
              remove: [],
              touched: [body.id],
              warnings: r.value.warnings,
            },
            owned: [r.value.shape],
          };
        },
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Import (STEP/BREP solids, mesh reference bodies)
  // -------------------------------------------------------------------------------------------

  private async planImport(ctx: WalkContext, f: ImportFeature): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const format = f.source.format;
    const taintNew = [`B${f.id}`];
    const meshFormat = MESH_FORMATS.has(format);
    if (format === 'iges') {
      return {
        unresolved,
        taint: taintNew,
        error: kerr('UNSUPPORTED_FEATURE', 'IGES files cannot be imported yet', {
          hint: 'Export the part as STEP from the other program and import that instead.',
        }),
      };
    }
    if (meshFormat && f.op !== 'new') {
      return {
        unresolved,
        taint: taintNew,
        error: kerr('INVALID_INPUT', 'A mesh file can only be imported as a new reference body', {
          hint: 'Set the operation to New, or import a STEP file to combine it with bodies.',
        }),
      };
    }
    const m = frameMatrix(f.frame ?? IDENTITY_FRAME);
    if (!m) {
      return {
        unresolved,
        taint: taintNew,
        error: kerr('INVALID_INPUT', 'The placement of the imported file is invalid', {
          hint: 'Use non-zero, non-parallel Z and X directions.',
        }),
      };
    }
    const sha = f.source.sha256.toLowerCase();
    ctx.usedImports.add(sha);
    const scoped =
      f.op === 'new'
        ? { bodies: [] as BodyState[], mode: 'bodies' as const }
        : this.scopeBodies(ctx, f.scope, unresolved);
    if ('error' in scoped && scoped.error) {
      return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
    }
    const taint = f.op === 'new' ? taintNew : scoped.bodies.map((b) => b.id);
    const involved = new Set<string>();
    if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
    else if (f.op !== 'new') {
      for (const t of ctx.tainted) if (!ctx.state.bodies.has(t)) involved.add(t);
    }
    const key = hashKey({
      t: 'import',
      id: f.id,
      sha,
      format,
      placement: m,
      op: f.op,
      scope: scoped.mode,
      bodies: scoped.bodies.map((b) => [b.id, b.key]),
    });
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: [...involved],
        run: () => this.runImport(ctx, f, m, scoped, key),
      },
    };
  }

  /** The attachment's raw shapes/meshes: from the per-part cache by sha256, else from the request. */
  private async rawImport(ctx: WalkContext, f: ImportFeature): Promise<Result<RawImport>> {
    const sha = f.source.sha256.toLowerCase();
    const format = f.source.format;
    const cached = ctx.pc.imports.get(sha);
    if (cached && cached.format === format) return { ok: true, value: cached };
    const bytes = ctx.attachments[f.source.path];
    const label = f.source.fileName || f.source.path;
    if (!bytes) {
      return {
        ok: false,
        error: kerr('INVALID_INPUT', 'The imported file is missing from this project', {
          hint: `Import ${label} again.`,
          detail: `attachment ${f.source.path} (sha256 ${sha}) was not provided`,
        }),
      };
    }
    const actual = await sha256Hex(bytes);
    if (actual !== sha) {
      return {
        ok: false,
        error: kerr(
          'INVALID_INPUT',
          'The imported file has changed since it was imported (its checksum does not match)',
          {
            hint: `Import ${label} again.`,
            detail: `sha256 of ${f.source.path}: ${actual}, expected ${sha}`,
          },
        ),
      };
    }
    const raw: RawImport = { sha, format, shapes: [], meshes: [], lastUsed: ctx.pc.tick };
    if (MESH_FORMATS.has(format)) {
      try {
        raw.meshes = importMesh(bytes, f.source.fileName || `import.${format}`).map((x) => x.mesh);
      } catch (e) {
        return {
          ok: false,
          error: kerr(
            'INVALID_INPUT',
            e instanceof IoError ? e.message : 'The mesh file could not be read',
            {
              detail: String(e),
            },
          ),
        };
      }
      if (raw.meshes.length === 0) {
        return { ok: false, error: kerr('INVALID_INPUT', 'The mesh file contains no triangles') };
      }
    } else {
      const r = await this.kernel.importShapes(bytes, format === 'brep' ? 'brep' : 'step');
      if (!r.ok) return r;
      raw.shapes = r.value.map((b) => b.shape);
      for (const h of raw.shapes) this.ownedHandles.add(h);
      if (raw.shapes.length === 0) {
        return { ok: false, error: kerr('INVALID_INPUT', 'The file contains no solids') };
      }
    }
    if (cached) await this.releaseRaw(cached);
    ctx.pc.imports.set(sha, raw);
    return { ok: true, value: raw };
  }

  /** Fresh copies of `shapes` moved by `m`, via a BREP round trip (see `placeBrep`). */
  private async placedCopies(shapes: ShapeHandle[], m: Matrix34): Promise<Result<ShapeHandle[]>> {
    const ex = await this.kernel.exportShapes(
      shapes.map((shape, i) => ({ shape, name: `s${i}` })),
      'brep',
    );
    if (!ex.ok) return ex;
    const file = ex.value[0];
    const text = file ? new TextDecoder().decode(file.bytes) : '';
    const placed = isIdentity(m) ? text : placeBrep(text, m);
    if (placed === null) {
      return { ok: false, error: kerr('INTERNAL', 'The imported shape could not be placed') };
    }
    const back = await this.kernel.importShapes(new TextEncoder().encode(placed), 'brep');
    if (!back.ok) return back;
    const out = back.value.map((b) => b.shape);
    if (out.length !== shapes.length) {
      for (const h of out) await this.kernel.release(h);
      return {
        ok: false,
        error: kerr('INTERNAL', 'The imported shape could not be placed', {
          detail: `${shapes.length} solids in, ${out.length} out`,
        }),
      };
    }
    return { ok: true, value: out };
  }

  /**
   * Placed, named B-rep solids of an import (fresh handles the caller owns), ordered by the
   * geometric key of their volume centroids. Naming: the kernel names the topology during a no-op
   * intersect with an enclosing box (tag `importNamingTag`) — faces `F<id>:face#k` by geometric
   * key, edges/vertices from adjacent faces — checked to have left the solid unchanged.
   */
  private async namedSolids(
    f: ImportFeature,
    raw: RawImport,
    m: Matrix34,
  ): Promise<
    Result<{ bodies: { shape: ShapeHandle; naming: NamingMap }[]; warnings: KernelError[] }>
  > {
    let shapes = raw.shapes;
    const temp: ShapeHandle[] = [];
    if (!isIdentity(m)) {
      const p = await this.placedCopies(raw.shapes, m);
      if (!p.ok) return p;
      shapes = p.value;
      temp.push(...shapes);
    }
    const box = emptyBox();
    const before: (MassProperties | null)[] = [];
    for (const s of shapes) {
      const mp = await this.massOf(s);
      before.push(mp);
      if (mp) {
        extendBox(box, mp.bbox.min);
        extendBox(box, mp.bbox.max);
      }
    }
    const margin = Math.max(1, 0.01 * boxDiagonal(box));
    const size = (k: 0 | 1 | 2) => box.max[k] - box.min[k] + 2 * margin;
    const namer: Feature = {
      id: importNamingTag(f.id),
      type: 'primitive',
      name: f.name,
      suppressed: false,
      op: 'intersect',
      shape: 'box',
      frame: {
        origin: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
        z: [0, 0, 1],
        x: [1, 0, 0],
      },
      dx: '0',
      dy: '0',
      dz: '0',
    };
    const extra: Record<string, ShapeHandle> = {};
    shapes.slice(1).forEach((s, i) => {
      extra[`scope:${String(i + 1).padStart(4, '0')}`] = s;
    });
    const r = await this.exec(namer, {
      values: { '/dx': size(0), '/dy': size(1), '/dz': size(2) },
      target: shapes[0] as ShapeHandle,
      shapes: extra,
    });
    const named: ({ shape: ShapeHandle; naming: NamingMap } | null)[] = shapes.map(() => null);
    if (r.ok) {
      named[0] = { shape: r.value.shape, naming: r.value.naming };
      for (const b of r.value.bodies ?? []) {
        named[Number(b.key.slice('scope:'.length))] = { shape: b.shape, naming: b.naming };
      }
    }
    const warnings: KernelError[] = [];
    const out: { shape: ShapeHandle; naming: NamingMap; centroid: Vec3 }[] = [];
    const fallback: number[] = [];
    for (let i = 0; i < shapes.length; i++) {
      const n = named[i];
      const was = before[i];
      const now = n ? await this.massOf(n.shape) : null;
      const unchanged =
        n &&
        was &&
        now &&
        now.faceCount === was.faceCount &&
        now.edgeCount === was.edgeCount &&
        Math.abs(now.volume - was.volume) <= 1e-9 * Math.max(1, Math.abs(was.volume));
      if (n && now && unchanged) {
        out.push({ ...n, centroid: now.centroid });
      } else {
        if (n) await this.releaseHandle(n.shape);
        fallback.push(i);
      }
    }
    if (fallback.length > 0) {
      // Unnamed copies (faces named by key only), so no handle of the raw cache leaks into results.
      const copies = await this.placedCopies(
        fallback.map((i) => raw.shapes[i] as ShapeHandle),
        m,
      );
      if (!copies.ok) {
        for (const o of out) await this.releaseHandle(o.shape);
        for (const h of temp) await this.releaseHandle(h);
        return copies;
      }
      for (const shape of copies.value) {
        const fp = await this.fingerprints(shape);
        const mp = await this.massOf(shape);
        out.push({
          shape,
          naming: faceNamesByKey(
            f.id,
            (fp?.faces ?? []).map((x) => x.centroid),
          ),
          centroid: mp?.centroid ?? [0, 0, 0],
        });
      }
      warnings.push(
        kerr(
          'OPERATION_FAILED',
          'Edges and vertices of the imported shape could not be named; only its faces can be referenced',
          {
            hint: 'The file may contain invalid geometry; try repairing or re-exporting it.',
            ...(r.ok ? {} : { detail: r.error.message }),
          },
        ),
      );
    }
    for (const h of temp) await this.releaseHandle(h);
    out.sort((a, b) => compareGeoKey(a.centroid, b.centroid));
    return {
      ok: true,
      value: { bodies: out.map(({ shape, naming }) => ({ shape, naming })), warnings },
    };
  }

  /** Mesh reference bodies (fresh handles): placed in TS, handed to the kernel as STL. */
  private async meshBodies(
    f: ImportFeature,
    raw: RawImport,
    m: Matrix34,
  ): Promise<Result<{ shape: ShapeHandle; naming: NamingMap }[]>> {
    const placed = raw.meshes.map((mesh) => (isIdentity(m) ? mesh : placeMesh(mesh, m)));
    const order = placed
      .map((mesh, i) => ({
        mesh,
        i,
        c: [0, 1, 2].map(
          (k) => ((mesh.bbox.min[k] as number) + (mesh.bbox.max[k] as number)) / 2,
        ) as Vec3,
      }))
      .sort((a, b) => compareGeoKey(a.c, b.c) || a.i - b.i);
    const out: { shape: ShapeHandle; naming: NamingMap }[] = [];
    for (const o of order) {
      const r = await this.kernel.importShapes(meshToStl([{ name: 'mesh', mesh: o.mesh }]), 'stl');
      if (!r.ok) {
        for (const x of out) await this.releaseHandle(x.shape);
        return r;
      }
      for (const b of r.value)
        out.push({ shape: b.shape, naming: [{ name: `F${f.id}:face`, kind: 'face', index: 0 }] });
    }
    return { ok: true, value: out };
  }

  private async runImport(
    ctx: WalkContext,
    f: ImportFeature,
    m: Matrix34,
    scoped: { bodies: BodyState[]; mode: 'default' | 'all' | 'bodies' },
    key: string,
  ): Promise<{ result: EntryResult; owned: ShapeHandle[]; transient?: boolean }> {
    const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
    const raw = await this.rawImport(ctx, f);
    // Missing/mismatching attachments are not cached: the next request may carry the file.
    if (!raw.ok) return { ...fail(raw.error), transient: true };
    const meshOnly = raw.value.meshes.length > 0;
    let tools: { shape: ShapeHandle; naming: NamingMap }[];
    let warnings: KernelError[] = [];
    if (meshOnly) {
      const r = await this.meshBodies(f, raw.value, m);
      if (!r.ok) return fail(r.error);
      tools = r.value;
    } else {
      const r = await this.namedSolids(f, raw.value, m);
      if (!r.ok) return fail(r.error);
      tools = r.value.bodies;
      warnings = r.value.warnings;
    }
    const asNew = (extra: KernelError[]) => {
      const set: BodyState[] = tools.map((t, k) => {
        const id = tools.length === 1 ? `B${f.id}` : `B${f.id}#${k}`;
        const b: BodyState = { id, shape: t.shape, naming: t.naming, key: `${key}/${id}` };
        if (meshOnly) b.meshOnly = true;
        return b;
      });
      return {
        result: {
          ok: true as const,
          set,
          remove: [],
          touched: [],
          warnings: [...extra, ...warnings],
        },
        owned: tools.map((t) => t.shape),
      };
    };
    if (f.op === 'new') return asNew([]);

    const dropTools = async () => {
      for (const t of tools) await this.releaseHandle(t.shape);
    };
    let candidates = scoped.bodies;
    if (scoped.mode === 'default' && candidates.length > 0) {
      const tb = emptyBox();
      for (const t of tools) {
        const mp = await this.massOf(t.shape);
        if (mp) {
          extendBox(tb, mp.bbox.min);
          extendBox(tb, mp.bbox.max);
        }
      }
      const tol = 1e-6 * Math.max(1, boxDiagonal(tb));
      const kept: BodyState[] = [];
      for (const b of candidates) {
        const bb = await this.massOf(b.shape);
        if (!bb || boxesOverlap(bb.bbox, tb, tol)) kept.push(b);
      }
      candidates = kept;
    }
    if (candidates.length === 0) {
      if (f.op === 'add' && scoped.mode === 'default') {
        return asNew([
          kerr(
            'OPERATION_FAILED',
            scoped.bodies.length === 0
              ? 'There is no body to add to; created a new body'
              : 'The imported shape touches no body; created a new body',
          ),
        ]);
      }
      await dropTools();
      if (f.op === 'cut' && scoped.mode === 'default' && scoped.bodies.length > 0) {
        return {
          result: {
            ok: true,
            set: [],
            remove: [],
            touched: [],
            warnings: [kerr('OPERATION_FAILED', 'The imported shape does not touch any body')],
          },
          owned: [],
        };
      }
      return fail(
        kerr('INVALID_INPUT', `There is no body to ${f.op === 'add' ? 'add to' : f.op}`, {
          hint: 'Create a body first, or set the operation to New.',
        }),
      );
    }
    const booleanWith = (target: BodyState) => {
      const refs: Record<string, ResolvedRef> = {
        '/target': { shape: target.shape, kind: 'body', index: 0 },
      };
      tools.forEach((t, i) => {
        refs[`/tools/${i}`] = { shape: t.shape, kind: 'body', index: 0 };
      });
      const op = f.op === 'new' ? 'add' : f.op;
      return this.exec(
        {
          id: f.id,
          type: 'boolean',
          name: f.name,
          suppressed: false,
          op,
          target: { name: target.id, kind: 'body' },
          tools: tools.map((_, i) => ({ name: `tool${i}`, kind: 'body' as const })),
          keepTools: false,
        },
        { values: {}, refs },
      );
    };

    const set: BodyState[] = [];
    const owned: ShapeHandle[] = [];
    const touched: string[] = [];
    const targets = f.op === 'add' ? candidates.slice(0, 1) : candidates;
    if (f.op === 'add' && candidates.length > 1) {
      warnings.push(
        kerr(
          'OPERATION_FAILED',
          `The imported shape was merged into ${(candidates[0] as BodyState).id} only; it also touches ${candidates
            .slice(1)
            .map((b) => b.id)
            .join(', ')}`,
          { hint: 'Pick the bodies to merge with in the feature’s scope.' },
        ),
      );
    }
    let firstError: KernelError | null = null;
    for (const b of targets) {
      const r = await booleanWith(b);
      if (!r.ok) {
        firstError ??= r.error;
        if (scoped.mode === 'bodies' || f.op === 'add') break;
        continue;
      }
      for (const extra of r.value.bodies ?? []) await this.releaseHandle(extra.shape);
      if (
        f.op === 'cut' &&
        scoped.mode !== 'bodies' &&
        (await this.sameSolid(b.shape, r.value.shape))
      ) {
        await this.releaseHandle(r.value.shape);
        continue;
      }
      set.push({ id: b.id, shape: r.value.shape, naming: r.value.naming, key: `${key}/${b.id}` });
      owned.push(r.value.shape);
      touched.push(b.id);
      warnings.push(...r.value.warnings);
    }
    await dropTools();
    if (firstError && (scoped.mode === 'bodies' || f.op === 'add' || set.length === 0)) {
      for (const h of owned) await this.releaseHandle(h);
      return fail(firstError);
    }
    if (f.op === 'cut' && touched.length === 0) {
      warnings.push(kerr('OPERATION_FAILED', 'The imported shape does not touch any body'));
    }
    return { result: { ok: true, set, remove: [], touched, warnings }, owned };
  }
}

function crossY(f: Frame): Vec3 {
  const y: Vec3 = [
    f.z[1] * f.x[2] - f.z[2] * f.x[1],
    f.z[2] * f.x[0] - f.z[0] * f.x[2],
    f.z[0] * f.x[1] - f.z[1] * f.x[0],
  ];
  return y.map((v) => (v === 0 ? 0 : v)) as Vec3; // no -0
}

/** Bodies a blocked feature would have acted on (conservative: all for body-modifying features). */
function allBodiesFor(f: Feature, all: string[]): string[] {
  switch (f.type) {
    case 'sketch':
    case 'plane':
      return [];
    case 'extrude':
    case 'revolve':
    case 'primitive':
      if (f.op === 'new') return [`B${f.id}`];
      if (f.scope?.kind === 'bodies') return f.scope.bodies.map((b) => b.name);
      return all;
    case 'boolean':
      return [f.target.name, ...f.tools.map((t) => t.name)];
    case 'import':
      if (f.op === 'new') return [`B${f.id}`];
      if (f.scope?.kind === 'bodies') return f.scope.bodies.map((b) => b.name);
      return all;
    default:
      return all;
  }
}

function fieldLabel(f: Feature, pointer: string): string {
  const m = /^\/constraints\/(\d+)\/value$/.exec(pointer);
  if (m && f.type === 'sketch') {
    const c = f.constraints[Number(m[1])];
    return c ? `Sketch dimension ${c.id} (${c.kind})` : 'Sketch dimension';
  }
  return FIELD_LABELS[pointer] ?? pointer;
}

/** Spare (unused by the latest regen) imported attachments kept per part, LRU. */
const IMPORT_SPARE = 8;

function validSpare(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function translateError(e: KernelError): KernelError {
  return e.entityRefs ? { ...e, entityRefs: e.entityRefs.map(translateName) } : e;
}

/** The first name per index of `kind` (aliases come later in a naming map), "" when unnamed. */
function namesByIndex(naming: NamingMap, kind: 'face' | 'edge', count: number): string[] {
  const out: string[] = Array(count).fill('');
  for (let i = naming.length - 1; i >= 0; i--) {
    const n = naming[i] as NamingMap[number];
    if (n.kind === kind && n.index < count) out[n.index] = n.name;
  }
  return out;
}

/** The fingerprint stored with a ref to sub-shape `index` of `kind`. */
function fingerprintOf(
  fp: ShapeFingerprints,
  kind: SubKind,
  index: number,
): Fingerprint | undefined {
  if (kind === 'face') {
    const f = fp.faces[index];
    if (!f) return undefined;
    return f.normal
      ? { centroid: f.centroid, normal: f.normal, area: f.area }
      : { centroid: f.centroid, area: f.area };
  }
  if (kind === 'edge') {
    const e = fp.edges[index];
    return e ? { centroid: e.centroid, length: e.length } : undefined;
  }
  const v = fp.vertices[index];
  return v ? { centroid: v.point } : undefined;
}

const MESH_FORMATS: ReadonlySet<ImportFeature['source']['format']> = new Set([
  'stl',
  'obj',
  '3mf',
  'glb',
]);

const IDENTITY_FRAME: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };

function meshOnlyError(verb: string, bodyId: string): KernelError {
  return kerr('INVALID_INPUT', `A mesh reference body cannot be ${verb}`, {
    hint: 'Meshes (STL, OBJ, 3MF, GLB) are for reference only; import a STEP file to model on it.',
    entityRefs: [bodyId],
  });
}

/** Equal up to float noise (1e-6 mm, 1e-9 relative). */
function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-6 + 1e-9 * Math.abs(x);
  const vec = (x: Vec3 | undefined, y: Vec3 | undefined) =>
    x === undefined || y === undefined ? x === y : x.every((v, i) => close(v, y[i] as number));
  const num = (x: number | undefined, y: number | undefined) =>
    x === undefined || y === undefined ? x === y : close(x, y);
  return (
    vec(a.centroid, b.centroid) &&
    vec(a.normal, b.normal) &&
    num(a.area, b.area) &&
    num(a.length, b.length)
  );
}
