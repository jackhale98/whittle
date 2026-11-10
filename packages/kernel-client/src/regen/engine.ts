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
  AttentionCause,
  AxisFeature,
  BodyResult,
  BodyScope,
  ChamferFeature,
  CircularPatternFeature,
  DraftFeature,
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  ExtrudeFeature,
  Feature,
  FeatureInputs,
  FeatureResult,
  FilletFeature,
  Fingerprint,
  Frame,
  HoleFeature,
  Id,
  ImportFeature,
  KernelError,
  LinearPatternFeature,
  LoftFeature,
  MassProperties,
  Measurement,
  MeasureTarget,
  MeshBuffers,
  MeshQuality,
  MirrorFeature,
  NamingMap,
  Part,
  PlaneFeature,
  PointFeature,
  PrimitiveFeature,
  PushPullFeature,
  RegenRequest,
  RegenSlot,
  ResolvedRef,
  Result,
  RevolveFeature,
  ShapeFingerprints,
  ShapeHandle,
  ShellFeature,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SketchResult,
  SweepFeature,
  ThreadFeature,
  UnresolvedRef,
  Vec2,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  entityRefs,
  evaluateFeatureValues,
  expressionEngine,
  featureReferences,
  holeRow,
  resolveHoleSize,
  scopeOf,
  sketchSolveValues,
  tryResolveDensity,
} from '@wren-cad/document';
import { IoError, importMesh, meshToStl } from '@wren-cad/io';
import { zipSync } from 'fflate';
import type { MeasureSubject } from '../kernel-api';
import { copyMesh, faceIndex, faceSubMesh } from './buffers';
import {
  type CauseEnv,
  changeCause,
  nameTags,
  newWalk,
  pushWalk,
  refIdentity,
  stillHolds,
  structuralCause,
  upstreamCause,
  valueAt,
  type WalkContainer,
  type WalkEntry,
} from './cause';
import { chainOrder } from './chain';
import { type CompareOutput, type DiffSide, geometricDiff } from './compare';
import {
  anglePlane,
  edgeCircle,
  edgeEndpoints,
  edgeLine,
  faceAxis,
  flipFrame,
  frameLine,
  type GeoQuery,
  heightAbove,
  isGeoError,
  type Line,
  lineFrame,
  lineLineIntersection,
  linePlaneIntersection,
  midPlane,
  normalPlane,
  planesIntersection,
  planeThroughPoint,
  planeThroughPoints,
  pointFrame,
  snapFrame,
  sphereCentre,
  toLocal,
} from './datums';
import {
  add,
  type Box3,
  boxDiagonal,
  boxesOverlap,
  cross,
  dist,
  dot,
  emptyBox,
  extendBox,
  groupByNormal,
  norm,
  normalize,
  ORIGIN_AXES,
  ORIGIN_PLANES,
  planeFrame,
  sampleEntity,
  scale,
  sub,
  toWorld,
} from './geometry';
import { hashKey, stableStringify } from './hash';
import {
  allBodiesFor,
  copiedFeatures,
  definition,
  hasFreeEdges,
  kerr,
  meshOnlyError,
} from './helpers';
import {
  compareGeoKey,
  frameMatrix,
  isIdentity,
  type Matrix34,
  mentionsImport,
  placeMesh,
  sha256Hex,
} from './imports';
import {
  flattenProjection,
  type LinkedCurve,
  type LinkedSource,
  projectAxis,
  projectCircle,
  projectPlaneTrace,
  projectPoint,
  projectSketchEntity,
  type ReprojectLinked,
  reprojectLinkedFallback,
} from './linked';
import { type Candidate, type ResolvedTarget, resolveRef, type SubKind } from './resolve';
import {
  type BodyState,
  type CacheEntry,
  type DatumState,
  type EntryResult,
  ModelState,
  type PartCache,
  type PlaneState,
  type Planned,
  type RawImport,
  type SketchState,
  type ToolSpec,
  type WalkContext,
} from './state';
import {
  type ExportResult,
  type ImportResult,
  MESH_QUALITY,
  type ReboundRef,
  type RegenEngineDeps,
  type RegenEngineOptions,
  type RegenFeatureStatus,
  type RegenOutput,
  type RegenUnresolvedRef,
  type SketchSolve,
} from './types';

export {
  type ExportResult,
  type ImportResult,
  MESH_QUALITY,
  type ReboundRef,
  type RegenEngineDeps,
  type RegenEngineOptions,
  type RegenFeatureStatus,
  type RegenOutput,
  type RegenUnresolvedRef,
  type SketchSolve,
} from './types';

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

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
  '/definition/angle': 'Angle',
  '/definition/at/t': 'Position along the curve',
  '/definition/t': 'Position along the edge',
  '/definition/x': 'X',
  '/definition/y': 'Y',
  '/definition/z': 'Z',
  '/thickness': 'Thickness',
  '/count': 'Count',
  '/spacing': 'Spacing',
  '/second/count': 'Second direction count',
  '/second/spacing': 'Second direction spacing',
  '/diameter': 'Diameter',
  '/tipAngle': 'Drill point angle',
  '/counterbore/diameter': 'Counterbore diameter',
  '/counterbore/depth': 'Counterbore depth',
  '/countersink/diameter': 'Countersink diameter',
  '/countersink/angle': 'Countersink angle',
  '/thread/depth': 'Thread depth',
  '/length': 'Thread length',
};

const SKETCH_TAG = /^S([0-9A-Za-z]+):/;
const PLANE_NAME = /^F([0-9A-Za-z]+):plane$/;
const AXIS_NAME = /^F([0-9A-Za-z]+):axis$/;
const POINT_NAME = /^F([0-9A-Za-z]+):point$/;

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
  private readonly reproject: ReprojectLinked;
  /** Per-handle memo of probed geometry (lines, circles, axes, end points); dropped on release. */
  private readonly geoMemo = new Map<string, unknown>();
  private maxSpare: number;
  private readonly quality: Record<
    MeshQuality,
    { linearDeflection: number; angularDeflection: number }
  >;
  private readonly now: () => number;
  private maxSlots: number;
  /** Per part, per slot (`'main'` and up to `maxSlots` version slots). */
  private readonly parts = new Map<Id, Map<RegenSlot, PartCache>>();
  private slotTick = 0;
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
    this.reproject = deps.reprojectLinked ?? reprojectLinkedFallback;
    this.maxSpare = validSpare(deps.options?.maxSpareResults) ?? 128;
    this.maxSlots = validSlots(deps.options?.maxVersionSlots) ?? DEFAULT_VERSION_SLOTS;
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

  /**
   * Regenerates a part in `request.slot` (default `'main'`). Each slot keeps its own cache,
   * latest state and revision counter, so a version slot never disturbs the live model.
   * Rejects with a `TypeError` for a malformed slot (a programming error, not a model error).
   */
  regenerate(request: RegenRequest): Promise<RegenOutput> {
    const slot: unknown = request.slot ?? 'main';
    if (!isSlot(slot)) {
      return Promise.reject(new TypeError(`Invalid regen slot ${JSON.stringify(slot)}`));
    }
    return this.serial(() => this.regen(request, slot));
  }

  /**
   * Changes the cache budget at runtime (e.g. the tablet/phone tier). `maxSpareResults` takes
   * effect at the next regen of each slot, which evicts down to the new bound; a lower
   * `maxVersionSlots` releases the least recently used version slots at once.
   */
  configure(
    options: Pick<RegenEngineOptions, 'maxSpareResults' | 'maxVersionSlots'>,
  ): Promise<void> {
    return this.serial(async () => {
      const spare = validSpare(options.maxSpareResults);
      if (spare !== undefined) this.maxSpare = spare;
      const slots = validSlots(options.maxVersionSlots);
      if (slots !== undefined) {
        this.maxSlots = slots;
        for (const partId of [...this.parts.keys()]) await this.evictSlots(partId);
      }
    });
  }

  /** Live model only (`'main'`): selection never refers to a version slot. */
  refFor(partId: Id, query: EntityQuery): Promise<EntityRef | null> {
    return this.serial(async () => {
      const latest = this.slotCache(partId, 'main')?.latest;
      const body = latest?.bodies.find((b) => b.id === query.bodyId);
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
      const latest = this.slotCache(partId, 'main')?.latest;
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
      const latest = this.slotCache(partId, 'main')?.latest;
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

  /** Releases a part's cached results and shapes: every slot, or only `slot`. */
  closePart(partId: Id, slot?: RegenSlot): Promise<void> {
    return this.serial(async () => {
      const slots = this.parts.get(partId);
      if (!slots) return;
      for (const pc of [...slots.values()]) {
        if (slot === undefined || pc.slot === slot) await this.releaseSlot(partId, pc);
      }
    });
  }

  /**
   * Geometric compare (PLAN §8A.3) of the latest regens of a part in slots `a` and `b`: B − A
   * (added) and A − B (removed) meshed at `quality`, their volumes, and each side's mass
   * properties and bounding box. Mesh-only reference bodies and sheets are left out with a
   * warning. Missing slots and failed booleans are `KernelError`s; this never throws.
   */
  compare(
    partId: Id,
    a: RegenSlot,
    b: RegenSlot,
    quality: MeshQuality,
  ): Promise<Result<CompareOutput>> {
    return this.serial(async (): Promise<Result<CompareOutput>> => {
      for (const s of [a, b] as unknown[]) {
        if (!isSlot(s)) {
          return {
            ok: false,
            error: kerr('INVALID_INPUT', `${JSON.stringify(s)} is not a version to compare`, {
              hint: "Use 'main' or 'version:<id>'.",
            }),
          };
        }
      }
      if (quality !== 'coarse' && quality !== 'fine') {
        return { ok: false, error: kerr('INVALID_INPUT', 'Mesh quality must be coarse or fine') };
      }
      const warnings: KernelError[] = [];
      const sides: DiffSide[] = [];
      for (const s of [a, b]) {
        const pc = this.slotCache(partId, s);
        if (!pc?.latest) {
          return {
            ok: false,
            error: kerr('INVALID_INPUT', `${capitalise(slotLabel(s))} has not been regenerated`, {
              hint:
                s === 'main'
                  ? 'Regenerate the part before comparing.'
                  : `Regenerate the part in slot "${s}" before comparing; older version slots are released to save memory.`,
            }),
          };
        }
        pc.used = ++this.slotTick;
        sides.push(await this.diffSide(pc, warnings));
      }
      const kernel = this.kernel;
      const r = await geometricDiff(
        {
          exec: (f, i) => this.exec(f, i),
          mesh: (shape, options) => kernel.mesh(shape, options),
          massProperties: (shape, density) => kernel.massProperties(shape, density),
          release: (shape) => kernel.release(shape),
        },
        sides[0] as DiffSide,
        sides[1] as DiffSide,
        { ...this.quality[quality], relative: true },
      );
      if (r.ok && warnings.length > 0) r.value.warnings = warnings;
      return r;
    });
  }

  /** The solid bodies of a slot's latest regen; mesh-only bodies and sheets become warnings. */
  private async diffSide(pc: PartCache, warnings: KernelError[]): Promise<DiffSide> {
    const latest = pc.latest as NonNullable<PartCache['latest']>;
    const label = slotLabel(pc.slot);
    const side: DiffSide = { label, bodies: [], keys: [] };
    if (latest.density !== undefined) side.density = latest.density;
    for (const body of latest.bodies) {
      if (body.meshOnly) {
        warnings.push(
          kerr('UNSUPPORTED_FEATURE', `A mesh reference body in ${label} is not compared`, {
            entityRefs: [body.id],
          }),
        );
        continue;
      }
      const mp = await this.massOf(body.shape);
      if (!mp || !(Math.abs(mp.volume) > 0)) {
        warnings.push(
          kerr('UNSUPPORTED_FEATURE', `A body without volume in ${label} is not compared`, {
            entityRefs: [body.id],
          }),
        );
        continue;
      }
      side.bodies.push({ shape: body.shape, naming: body.naming });
      side.keys.push(body.key);
    }
    return side;
  }

  /** Is `shape` owned by the regen cache (released by the engine, never by callers)? */
  ownsHandle(shape: ShapeHandle): boolean {
    return this.ownedHandles.has(shape);
  }

  /** Diagnostics: cache entries and owned handles of one slot of a part (default `'main'`). */
  stats(partId: Id, slot: RegenSlot = 'main'): { entries: number; handles: number } | null {
    const pc = this.slotCache(partId, slot);
    if (!pc) return null;
    let handles = 0;
    for (const e of pc.entries.values()) handles += e.owned.length;
    return { entries: pc.entries.size, handles };
  }

  /** Diagnostics: the slots a part holds, `'main'` first, then version slots by recency. */
  slots(partId: Id): RegenSlot[] {
    return [...(this.parts.get(partId)?.values() ?? [])]
      .sort((x, y) => (x.slot === 'main' ? -1 : y.slot === 'main' ? 1 : y.used - x.used))
      .map((pc) => pc.slot);
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
    for (const k of [...this.geoMemo.keys()]) if (k.startsWith(`${shape}|`)) this.geoMemo.delete(k);
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
   * `execFeature`. Every kernel feature call of the engine goes through here. (Kernel names are
   * document names: the M1 translation of imported names, `F<id>:face:unnamed` → `F<id>:face`,
   * went with the kernel `import` feature, which names imported faces `F<id>:face#k` itself.)
   */
  private exec(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>> {
    return this.kernel.execFeature(feature, inputs);
  }

  // -------------------------------------------------------------------------------------------
  // Regeneration
  // -------------------------------------------------------------------------------------------

  private slotCache(partId: Id, slot: RegenSlot): PartCache | undefined {
    return this.parts.get(partId)?.get(slot);
  }

  private partCache(id: Id, slot: RegenSlot): PartCache {
    let slots = this.parts.get(id);
    if (!slots) {
      slots = new Map();
      this.parts.set(id, slots);
    }
    let pc = slots.get(slot);
    if (!pc) {
      pc = {
        slot,
        used: 0,
        entries: new Map(),
        revision: 0,
        tick: 0,
        latest: null,
        lastGood: null,
        imports: new Map(),
        lastResolved: new Map(),
        walk: null,
      };
      slots.set(slot, pc);
    }
    pc.used = ++this.slotTick;
    return pc;
  }

  /** Keeps at most `maxSlots` version slots of a part (LRU out; `'main'` is never evicted). */
  private async evictSlots(partId: Id): Promise<void> {
    const slots = this.parts.get(partId);
    if (!slots) return;
    const versions = [...slots.values()]
      .filter((pc) => pc.slot !== 'main')
      .sort((x, y) => y.used - x.used);
    for (const pc of versions.slice(this.maxSlots)) await this.releaseSlot(partId, pc);
  }

  private async releaseSlot(partId: Id, pc: PartCache): Promise<void> {
    for (const e of pc.entries.values()) await this.releaseEntry(e);
    for (const raw of pc.imports.values()) await this.releaseRaw(raw);
    pc.entries.clear();
    pc.imports.clear();
    pc.latest = null;
    pc.lastGood = null;
    const slots = this.parts.get(partId);
    slots?.delete(pc.slot);
    if (slots?.size === 0) this.parts.delete(partId);
  }

  private async regen(request: RegenRequest, slot: RegenSlot): Promise<RegenOutput> {
    const t0 = this.now();
    const { doc, partId } = request;
    const part = doc.parts.find((p) => p.id === partId);
    const pc = this.partCache(partId, slot);
    // A new version slot may push the least recently used one out: free it before allocating.
    if (slot !== 'main') await this.evictSlots(partId);
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
      tainted: new Map(),
      used: new Set(),
      hits: 0,
      misses: 0,
      diag: null,
      attachments: request.attachments ?? {},
      importIds: new Set(part.features.filter((f) => f.type === 'import').map((f) => f.id)),
      usedImports: new Set(),
      current: { featureId: '', rebound: [] },
      walk: newWalk(),
      rec: null,
      index: new Map(part.features.map((f, i) => [f.id, i])),
      bodyOwner: new Map(),
    };
    const rollback = Math.max(0, Math.min(part.rollbackIndex, part.features.length));
    const features: RegenFeatureStatus[] = [];
    for (let i = 0; i < part.features.length; i++) {
      const f = part.features[i] as Feature;
      if (i >= rollback || f.suppressed) {
        const state = i >= rollback ? 'rolledBack' : 'suppressed';
        features.push({ featureId: f.id, state, cached: false, ms: 0 });
        pushWalk(ctx.walk, { id: f.id, state, planned: false, deps: [] });
      } else {
        const ft = this.now();
        const status = await this.runFeature(ctx, f);
        const rec = ctx.rec as WalkEntry;
        rec.state = status.state;
        this.attachCauses(ctx, f, status, rec);
        if (status.unresolved) {
          rec.unresolved = status.unresolved.map((u) =>
            u.cause ? { path: u.path, cause: u.cause } : { path: u.path },
          );
        }
        if (status.cause) rec.cause = status.cause;
        pushWalk(ctx.walk, rec);
        ctx.rec = null;
        status.ms = this.now() - ft;
        features.push(status);
      }
    }
    pc.walk = ctx.walk;

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
    if (density !== undefined) pc.latest.density = density;
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

  private densityOf(part: Part, doc: WrenDoc): number | undefined {
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
      if (e.kind === 'ellipse' || e.kind === 'ellipticArc') {
        extent = Math.max(extent, e.majorRadius, e.minorRadius);
      }
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
      for (const b of taint) if (!ctx.tainted.has(b)) ctx.tainted.set(b, f.id);
    };
    const allBodies = () => [...ctx.state.bodies.keys()];
    const evaluated = evaluateFeatureValues(f, ctx.doc);
    const exprErrors = Object.entries(evaluated.errors).filter(
      ([p]) => !p.startsWith('/annotations/'),
    );
    const copied = copiedFeatures(f);
    const rec = this.walkEntry(ctx, f, evaluated.values, exprErrors, copied);
    ctx.rec = rec;
    /** What a blocked feature waits on: the feature that failed first on one of its bodies. */
    const taintCause = (bodies: readonly string[]): { cause?: AttentionCause } => {
      const b = bodies.find((x) => ctx.tainted.has(x));
      const id = b === undefined ? undefined : ctx.tainted.get(b);
      return id === undefined ? {} : { cause: { featureId: id, kind: 'failed' } };
    };

    // 1. References into failed features (or copies of one) → blocked.
    const waitsOn = [...ctx.failed].filter((id) => featureReferences(f, id) || copied.includes(id));
    if (waitsOn.length > 0) {
      // The cause: a referenced feature that failed itself (not merely blocked), else the first.
      const root =
        waitsOn.find((id) => {
          const st = ctx.walk.byId.get(id)?.state;
          return st === 'error' || st === 'needsAttention';
        }) ?? (waitsOn[0] as Id);
      fail(allBodiesFor(f, allBodies()));
      return status('blocked', {
        error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature this one depends on failed', {
          hint: 'Fix the features marked above first.',
        }),
        cause: { featureId: root, kind: 'failed' },
      });
    }

    // 2. Values and references.
    let planned: Planned;
    try {
      planned = await this.planFeature(ctx, f, evaluated.values);
      if (planned.plan) {
        rec.key = planned.plan.key;
        rec.planned = planned.unresolved.length === 0 && !planned.error;
        for (const b of [...planned.plan.involved, ...(planned.plan.reads ?? [])]) {
          const owner = ctx.bodyOwner.get(b);
          if (owner !== undefined && owner !== f.id && !rec.deps.includes(owner))
            rec.deps.push(owner);
        }
      }
    } catch (e) {
      fail(allBodies());
      return status('error', {
        error: kerr('INTERNAL', 'The feature could not be prepared', { detail: String(e) }),
      });
    }

    // 3. Acting on a tainted body → blocked.
    if (planned.plan?.involved.some((b) => ctx.tainted.has(b))) {
      const waits = taintCause(planned.plan.involved);
      fail(planned.taint);
      return status('blocked', {
        error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature on this body failed', {
          hint: 'Fix the features marked above first.',
        }),
        ...waits,
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
      const linked = planned.attention ?? [];
      return status('needsAttention', {
        unresolved: planned.unresolved,
        error: kerr(
          'UNRESOLVED_REFERENCE',
          linked.length > 0
            ? `${linked.length === 1 ? 'A linked sketch entity has' : `${linked.length} linked sketch entities have`} lost ${linked.length === 1 ? 'its' : 'their'} source`
            : first?.reason === 'ambiguous'
              ? 'A selection now matches several entities'
              : 'A selection no longer exists',
          {
            hint:
              linked.length > 0
                ? 'Re-pick the source of the highlighted entities, or unlink them.'
                : 'Re-pick the highlighted selection.',
            entityRefs: [...new Set([...planned.unresolved.map((u) => u.ref.name), ...linked])],
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
      const waits = taintCause(r.touched);
      fail(planned.taint);
      return status('blocked', {
        cached,
        error: kerr('UNRESOLVED_REFERENCE', 'An upstream feature on this body failed', {
          hint: 'Fix the features marked above first.',
        }),
        ...waits,
      });
    }
    ctx.state.apply(r);
    rec.delta = walkDelta(r);
    for (const b of r.set) ctx.bodyOwner.set(b.id, f.id);
    if (plan.tool) {
      ctx.state.tools.set(f.id, { ...plan.tool, bodies: r.set.map((b) => b.id) });
    }
    const out = status('ok', { cached });
    const warnings = [...(planned.warnings ?? []), ...r.warnings];
    if (warnings.length > 0) out.warnings = warnings;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Error causes (cause.ts)
  // -------------------------------------------------------------------------------------------

  /** The walk record of a feature about to run: its own definition, values and reference tags. */
  private walkEntry(
    ctx: WalkContext,
    f: Feature,
    values: Record<string, number>,
    exprErrors: [string, unknown][],
    copied: Id[],
  ): WalkEntry {
    const own: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) if (!k.startsWith('/annotations/')) own[k] = v;
    const deps: Id[] = [];
    const dep = (id: Id) => {
      if (id !== f.id && ctx.walk.byId.has(id) && !deps.includes(id)) deps.push(id);
    };
    for (const r of entityRefs(f)) for (const id of nameTags(r.name, r.kind).all) dep(id);
    for (const id of copied) dep(id);
    const rec: WalkEntry = {
      id: f.id,
      state: 'ok',
      def: stableStringify(definition(f)),
      values: own,
      planned: false,
      deps,
    };
    if (exprErrors.length > 0) rec.valueErrors = exprErrors.map(([p]) => p);
    return rec;
  }

  private causeEnv(ctx: WalkContext): CauseEnv {
    return {
      part: ctx.part,
      index: ctx.index,
      walk: ctx.walk,
      prev: ctx.pc.walk,
      label: causeLabel,
    };
  }

  /**
   * `AttentionCause` for a finished feature's unresolved refs and its status (cause.ts rules):
   * structural from the name, else this regen's change if the same stored ref resolved last
   * regen, else the cause it already had. Blocked causes are set by `runFeature`.
   */
  private attachCauses(
    ctx: WalkContext,
    f: Feature,
    status: RegenFeatureStatus,
    rec: WalkEntry,
  ): void {
    if (status.state === 'ok' || status.state === 'blocked') return;
    const env = this.causeEnv(ctx);
    const prev = ctx.pc.walk?.byId.get(f.id);
    // Entities sharing a linked source share one name: compute its change once.
    const changed = new Map<string, AttentionCause | null>();
    for (const u of status.unresolved ?? []) {
      const stored = refIdentity(valueAt(f, u.path));
      const same =
        prev !== undefined &&
        stored !== undefined &&
        refIdentity(valueAt(prev.def, u.path)) === stored;
      let cause = structuralCause(env, f.id, u.ref.name, u.ref.kind);
      if (!cause && same && prev?.planned) {
        const k = `${u.ref.kind}|${u.ref.name}`;
        if (!changed.has(k)) changed.set(k, changeCause(env, f.id, u.ref.name, u.ref.kind));
        cause = changed.get(k) ?? null;
      } else if (!cause && same) {
        const was = prev?.unresolved?.find((x) => x.path === u.path)?.cause;
        if (was && stillHolds(env, f.id, was)) cause = was;
      }
      if (cause) u.cause = cause;
    }
    if (status.state === 'needsAttention') {
      const first = status.unresolved?.find((u) => u.cause)?.cause;
      if (first) status.cause = first;
      return;
    }
    if (status.state !== 'error' || status.cause || !prev) return;
    const ownSame =
      prev.def === rec.def && stableStringify(prev.values) === stableStringify(rec.values);
    if (prev.state === 'ok') {
      const c = upstreamCause(env, rec);
      if (c) status.cause = c;
    } else if (
      prev.state === 'error' &&
      prev.cause &&
      ownSame &&
      stillHolds(env, f.id, prev.cause)
    ) {
      status.cause = prev.cause;
    }
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
      case 'axis':
        return this.planAxis(ctx, f, values);
      case 'point':
        return this.planPoint(ctx, f, values);
      case 'shell':
        return this.planShell(ctx, f, values);
      case 'draft':
        return this.planDraft(ctx, f, values);
      case 'sweep':
      case 'loft':
        return this.planSweepLoft(ctx, f, values);
      case 'mirror':
      case 'linearPattern':
      case 'circularPattern':
        return this.planCopy(ctx, f, values);
      case 'hole':
        return this.planHole(ctx, f, values);
      case 'thread':
        return this.planThread(ctx, f, values);
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
    let entities = f.entities;
    let constraints = f.constraints;
    if (f.entities.some((e) => e.source)) {
      const linked = await this.linkedEntities(ctx, f, frame, unresolved, involved);
      if ('code' in linked) return { unresolved, taint: [], error: linked };
      if ('attention' in linked) return { unresolved, taint: [], attention: linked.attention };
      entities = linked.entities;
      constraints = linked.constraints;
    }
    const key = hashKey({
      t: 'sketch',
      id: f.id,
      entities,
      constraints,
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
          const solved = this.solver.solve({ entities, constraints, values: solveValues });
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
      const datum = AXIS_NAME.exec(f.axis.name);
      if (axis) frames.axis = axis;
      else if (datum) {
        // M3: an axis feature (`F…:axis`) revolves about its frame.
        const d = ctx.state.datums.get(datum[1] as string);
        if (d?.kind === 'axis') frames.axis = d.frame;
        else unresolved.push({ path: '/axis', ref: f.axis, reason: 'missing' });
      } else {
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
      for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
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
        reads: scoped.bodies.map((b) => b.id),
        run: () => this.runSolid(f, inputs, scoped, key),
        tool: this.solidTool(f, inputs, refKeys),
      },
    };
  }

  /** The tool solid of a solid feature: the feature alone (op `new`), keyed without its bodies. */
  private solidTool(
    f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | SweepFeature | LoftFeature,
    inputs: FeatureInputs,
    refKeys: Record<string, unknown>,
  ): Omit<ToolSpec, 'bodies'> {
    const tool = { ...f, op: 'new', scope: undefined } as Feature;
    const toolInputs: FeatureInputs = { values: inputs.values };
    if (inputs.refs) toolInputs.refs = inputs.refs;
    if (inputs.frames) toolInputs.frames = inputs.frames;
    return {
      featureId: f.id,
      key: hashKey({
        t: 'tool',
        def: definition(tool),
        values: inputs.values,
        refs: refKeys,
        frames: inputs.frames ?? {},
      }),
      op: opCode(f.op),
      build: (depth?: number) => {
        if (depth === undefined || f.type !== 'extrude' || f.end.kind !== 'throughAll') {
          return this.exec(tool, toolInputs);
        }
        const blind = { ...tool, end: { kind: 'blind', depth: `${depth} mm` } } as Feature;
        return this.exec(blind, {
          ...toolInputs,
          values: { ...inputs.values, '/end/depth': depth },
        });
      },
      ...(f.type === 'extrude' && f.end.kind === 'throughAll'
        ? {
            throughAll: [
              ...new Set(
                Object.entries(inputs.refs ?? {})
                  .filter(([p]) => p.startsWith('/profile/'))
                  .map(([, r]) => r.shape),
              ),
            ],
          }
        : {}),
    };
  }

  /** Executes a solid feature with its body op and scope semantics. */
  private async runSolid(
    f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | SweepFeature | LoftFeature,
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
      // `propagate` absent means true (ADR-019 item 2): both spellings share one cache entry.
      def: { ...(definition(f) as object), propagate: f.propagate !== false },
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
    const involved = new Set<string>();
    const noteOwner = (owner: string | undefined) => {
      if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
    };
    const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
    const d = f.definition;
    /** Frame computed in TypeScript (M3 definitions); the kernel then gets `{ kind: 'frame' }`. */
    let computed: Frame | null = null;
    const geoError = (message: string, refs: EntityRef[]) =>
      fail(
        kerr('INVALID_INPUT', message, {
          hint: 'Pick other references for the plane.',
          entityRefs: refs.map((r) => r.name),
        }),
      );
    if (d.kind === 'offset') {
      const p = await this.resolvePlane(ctx, d.from, '/definition/from', unresolved);
      if (p === null) return { unresolved, taint: [] };
      if ('code' in p) return fail(p);
      frames.from = p.frame;
      fromKey = p.shapeKey;
      noteOwner(p.target?.owner);
    } else if (d.kind === 'threePoints') {
      const pts: Vec3[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await this.resolvePoint(
          ctx,
          d.points[i] as EntityRef,
          `/definition/points/${i}`,
          unresolved,
        );
        if (p && 'code' in p) return fail(p);
        if (p) {
          pts.push(p.point);
          noteOwner(p.owner);
        }
      }
      if (unresolved.length > 0) return { unresolved, taint: [] };
      const g = planeThroughPoints(pts[0] as Vec3, pts[1] as Vec3, pts[2] as Vec3);
      if (isGeoError(g)) return geoError(g.error, d.points);
      computed = g;
    } else if (d.kind === 'angle') {
      const p = await this.resolvePlane(ctx, d.from, '/definition/from', unresolved);
      const a = await this.resolveAxis(ctx, d.axis, '/definition/axis', unresolved, false);
      if (p && 'code' in p) return fail(p);
      if (a && 'code' in a) return fail(a);
      if (!p || !a) return { unresolved, taint: [] };
      noteOwner(p.target?.owner);
      noteOwner(a.owner);
      const g = anglePlane(p.frame, a.line, values['/definition/angle'] ?? 0);
      if (isGeoError(g)) return geoError(g.error, [d.from, d.axis]);
      computed = g;
    } else if (d.kind === 'normalToCurve') {
      const r = await this.normalToCurve(ctx, d, values, unresolved);
      if (r === null) return { unresolved, taint: [] };
      if ('code' in r) return fail(r);
      noteOwner(r.owner);
      computed = r.frame;
    } else if (d.kind === 'midplane') {
      const a = await this.resolvePlane(ctx, d.a, '/definition/a', unresolved);
      const b = await this.resolvePlane(ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (!a || !b) return { unresolved, taint: [] };
      noteOwner(a.target?.owner);
      noteOwner(b.target?.owner);
      const g = midPlane(a.frame, b.frame);
      if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
      computed = g;
    } else if (d.kind === 'throughPoint') {
      const p = await this.resolvePlane(ctx, d.from, '/definition/from', unresolved);
      const q = await this.resolvePoint(ctx, d.point, '/definition/point', unresolved);
      if (p && 'code' in p) return fail(p);
      if (q && 'code' in q) return fail(q);
      if (!p || !q) return { unresolved, taint: [] };
      noteOwner(p.target?.owner);
      noteOwner(q.owner);
      computed = planeThroughPoint(p.frame, q.point);
    }
    if (unresolved.length > 0) return { unresolved, taint: [] };
    // The kernel never sees `flip`: new definitions reach it as a (flipped) frame; offset planes
    // run as in M1 and the flip is applied to the resulting frame.
    if (computed && f.flip) computed = flipFrame(computed);
    if (!computed && f.flip && d.kind === 'frame') computed = flipFrame(d.frame);
    const kernelFeature: PlaneFeature = computed
      ? { ...f, definition: { kind: 'frame', frame: computed } }
      : { ...f };
    delete kernelFeature.flip;
    const flipAfter = !computed && f.flip === true;
    const key = hashKey({
      t: 'plane',
      def: definition(f),
      values,
      frames,
      from: fromKey,
      computed,
    });
    return {
      unresolved,
      taint: [],
      plan: {
        key,
        involved: [...involved],
        run: async () => {
          const r = await this.exec(kernelFeature, computed ? { values: {} } : { values, frames });
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          let frame = computed ??
            r.value.frame ??
            frames.from ?? { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
          if (flipAfter) frame = flipFrame(frame);
          const plane: PlaneState = {
            id: f.id,
            shape: r.value.shape,
            naming: r.value.naming,
            frame,
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

  /** `normalToCurve` planes: at a vertex on the curve or at a 0–1 position along a straight edge. */
  private async normalToCurve(
    ctx: WalkContext,
    d: Extract<PlaneFeature['definition'], { kind: 'normalToCurve' }>,
    values: Record<string, number>,
    unresolved: UnresolvedRef[],
  ): Promise<{ frame: Frame; owner?: string } | KernelError | null> {
    const t = await this.resolveSub(ctx, d.curve, '/definition/curve', unresolved);
    let at: Vec3 | null = null;
    if (!('t' in d.at)) {
      const p = await this.resolvePoint(ctx, d.at, '/definition/at', unresolved);
      if (p && 'code' in p) return p;
      if (p) at = p.point;
    }
    if (!t || unresolved.length > 0) return null;
    const bad = (message: string) =>
      kerr('INVALID_INPUT', message, {
        hint: 'Pick a straight or circular edge.',
        entityRefs: [d.curve.name],
      });
    if (t.kind !== 'edge') return bad('A plane normal to a curve needs an edge');
    const owner = t.owner;
    const line = await this.lineOfEdge(t);
    if (line) {
      const dir = normalize(sub(line.b, line.a));
      const point = at ?? add(line.a, scale(sub(line.b, line.a), values['/definition/at/t'] ?? 0));
      return { frame: normalPlane(point, dir), owner };
    }
    const circle = await this.circleOfEdge(t);
    if (circle) {
      if (!at) {
        return kerr(
          'UNSUPPORTED_FEATURE',
          'A position along a curved edge is not supported yet; pick a vertex on it',
          { hint: 'Pick a vertex on the edge instead of a position.', entityRefs: [d.curve.name] },
        );
      }
      const radial = sub(at, circle.centre);
      if (Math.abs(dist(at, circle.centre) - circle.radius) > 1e-6 * (1 + circle.radius)) {
        return bad('The point is not on the curve');
      }
      return { frame: normalPlane(at, cross(circle.normal, radial)), owner };
    }
    return bad('Planes normal to this kind of curve are not supported yet');
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
          const r = await this.pushPullSteps(f, body, values, refs, picked);
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

  /**
   * Runs a push/pull as one kernel step per normal group (ADR-013 addendum). Faces facing the same
   * way move together in one prism + boolean, as before. Faces facing different ways move group
   * by group, groups sorted by normal; after each step the remaining groups' faces are found on
   * the new body by their persistent names (moved and untouched faces keep them, naming.ts M2).
   * Moving the top and then the side means the side is already taller when it moves, so its prism
   * fills the corner: the result is the uniform offset at convex corners. A face that no longer
   * exists by name after an earlier step fails the feature; it is never guessed.
   */
  private async pushPullSteps(
    f: PushPullFeature,
    body: BodyState,
    values: Record<string, number>,
    refs: Record<string, ResolvedRef>,
    picked: readonly string[],
  ): Promise<Result<FeatureResult>> {
    const fp = await this.fingerprints(body.shape);
    const members = Object.keys(refs)
      .map((path) => Number(path.slice('/faces/'.length)))
      .sort((a, b) => a - b)
      .map((i) => {
        const ref = refs[`/faces/${i}`] as ResolvedRef;
        const name = body.naming.find((n) => n.kind === 'face' && n.index === ref.index)?.name;
        return { i, ref, name, normal: fp?.faces[ref.index]?.normal };
      });
    const groups = fp ? groupByNormal(members) : null;
    // One normal (or a curved face, which the kernel reports): a single step, as in M2.
    if (!groups || groups.length < 2) return this.exec(f, { target: body.shape, values, refs });

    let shape = body.shape;
    let naming = body.naming;
    const warnings: KernelError[] = [];
    const seen = new Set<string>();
    const release = async (h: ShapeHandle): Promise<void> => {
      if (h !== body.shape) await this.kernel.release(h);
    };
    for (const [g, group] of groups.entries()) {
      const stepRefs: Record<string, ResolvedRef> = {};
      const faces: EntityRef[] = [];
      for (const m of group.items) {
        const original = f.faces[m.i] as EntityRef;
        let index = m.ref.index;
        if (g > 0) {
          const hit =
            m.name === undefined
              ? undefined
              : naming.find((n) => n.kind === 'face' && n.name === m.name);
          if (!hit) {
            await release(shape);
            return {
              ok: false,
              error: kerr(
                'UNRESOLVED_REFERENCE',
                `Selected face ${m.i + 1} is gone once the faces facing another way have moved`,
                {
                  hint: 'Push/pull these faces in separate steps, or pick fewer faces.',
                  detail: `push/pull step ${g + 1} of ${groups.length}: no face named ${
                    m.name ?? '(unnamed)'
                  }`,
                  entityRefs: [m.name ?? original.name],
                },
              ),
            };
          }
          index = hit.index;
        }
        stepRefs[`/faces/${faces.length}`] = { shape, kind: 'face', index };
        faces.push(original);
      }
      const r = await this.exec({ ...f, faces }, { target: shape, values, refs: stepRefs });
      await release(shape);
      if (!r.ok) {
        // The error speaks for the whole selection, not just this step's share of it.
        const names = [...new Set([...(r.error.entityRefs ?? []), ...picked])];
        return { ok: false, error: { ...r.error, entityRefs: names } };
      }
      for (const w of r.value.warnings) {
        const k = `${w.code}|${w.message}`;
        if (seen.has(k)) continue;
        seen.add(k);
        warnings.push(w);
      }
      shape = r.value.shape;
      naming = r.value.naming;
    }
    return { ok: true, value: { shape, naming, warnings } };
  }

  // -------------------------------------------------------------------------------------------
  // M3: geometry probes, axes, points (reference geometry)
  // -------------------------------------------------------------------------------------------

  private geo(): GeoQuery {
    return {
      fingerprints: (shape) => this.fingerprints(shape),
      measure: (a, b) => this.kernel.measureShapes(a, b),
    };
  }

  /** Memoised per handle (engine-owned handles keep their geometry; dropped on release). */
  private async memo<T>(shape: ShapeHandle, what: string, fn: () => Promise<T>): Promise<T> {
    const k = `${shape}|${what}`;
    if (this.geoMemo.has(k)) return this.geoMemo.get(k) as T;
    const v = await fn();
    this.geoMemo.set(k, v);
    return v;
  }

  private lineOfEdge(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `line:${t.index}`, () => edgeLine(this.geo(), t.shape, t.index));
  }

  private circleOfEdge(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `circle:${t.index}`, () => edgeCircle(this.geo(), t.shape, t.index));
  }

  private axisOfFace(t: { shape: ShapeHandle; index: number }) {
    return this.memo(t.shape, `axis:${t.index}`, () => faceAxis(this.geo(), t.shape, t.index));
  }

  private endpointsOf(t: { shape: ShapeHandle; index: number }, tol: number) {
    return this.memo(t.shape, `ends:${t.index}:${tol}`, () =>
      edgeEndpoints(this.geo(), t.shape, t.index, tol),
    );
  }

  /**
   * An axis-like reference → a line: origin axes, axis features (`F…:axis`), straight edges (in
   * their geometric-key direction), circular edges and cylindrical faces (their axis, canonical
   * direction). With `planeNormal` (linear pattern directions) planes and flat faces give their
   * normal, and circular edges are refused (no direction).
   */
  private async resolveAxis(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
    planeNormal: boolean,
  ): Promise<{ line: Line; owner?: string } | KernelError | null> {
    const origin = ORIGIN_AXES[ref.name];
    if (origin) return { line: frameLine(origin) };
    const ax = AXIS_NAME.exec(ref.name);
    if (ax) {
      const d = ctx.state.datums.get(ax[1] as string);
      if (d?.kind === 'axis') return { line: frameLine(d.frame) };
      unresolved.push({ path, ref, reason: 'missing' });
      return null;
    }
    const bad = (message: string) =>
      kerr('INVALID_INPUT', message, {
        hint: planeNormal
          ? 'Pick a straight edge, an axis, a plane or a flat face.'
          : 'Pick an axis, a straight or circular edge, or a cylindrical face.',
        entityRefs: [ref.name],
      });
    if (ORIGIN_PLANES[ref.name] || PLANE_NAME.test(ref.name)) {
      if (!planeNormal) return bad('A plane is not an axis');
      const p = await this.resolvePlane(ctx, ref, path, unresolved);
      if (!p || 'code' in p) return p;
      const out: { line: Line; owner?: string } = { line: frameLine(p.frame) };
      if (p.target?.owner) out.owner = p.target.owner;
      return out;
    }
    const t = await this.resolveSub(ctx, ref, path, unresolved);
    if (!t) return null;
    if (t.kind === 'edge') {
      const l = await this.lineOfEdge(t);
      if (l) return { line: { origin: l.a, dir: normalize(sub(l.b, l.a)) }, owner: t.owner };
      const c = await this.circleOfEdge(t);
      if (c) {
        if (planeNormal) return bad('A circular edge has no direction; pick a straight edge');
        return { line: { origin: c.centre, dir: c.normal }, owner: t.owner };
      }
      return bad('This edge is neither straight nor circular');
    }
    if (t.kind === 'face') {
      const fp = await this.fingerprints(t.shape);
      const face = fp?.faces[t.index];
      if (face?.normal) {
        if (!planeNormal) return bad('A flat face has no axis');
        return { line: { origin: face.centroid, dir: normalize(face.normal) }, owner: t.owner };
      }
      const a = await this.axisOfFace(t);
      if (a) return { line: { origin: a.origin, dir: a.dir }, owner: t.owner };
      return bad('This face has no axis');
    }
    return bad('A vertex has no direction');
  }

  /**
   * A point-like reference → a world point: `origin:O`, point features (`F…:point`), vertices and
   * sketch points (`S…:p(id)`), and circular edges (their centre).
   */
  private async resolvePoint(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
  ): Promise<{ point: Vec3; owner?: string } | KernelError | null> {
    if (ref.name === 'origin:O') return { point: [0, 0, 0] };
    const pm = POINT_NAME.exec(ref.name);
    if (pm) {
      const d = ctx.state.datums.get(pm[1] as string);
      if (d?.kind === 'point') return { point: d.frame.origin };
      unresolved.push({ path, ref, reason: 'missing' });
      return null;
    }
    const t = await this.resolveSub(ctx, ref, path, unresolved);
    if (!t) return null;
    if (t.kind === 'vertex') {
      const fp = await this.fingerprints(t.shape);
      const v = fp?.vertices[t.index];
      if (v) return { point: v.point, owner: t.owner };
    }
    if (t.kind === 'edge') {
      const c = await this.circleOfEdge(t);
      if (c) return { point: c.centre, owner: t.owner };
    }
    return kerr('INVALID_INPUT', 'Pick a point, a vertex or a circular edge (its centre)', {
      entityRefs: [ref.name],
    });
  }

  /** A line or a plane (for intersection points). */
  private async resolveLineOrPlane(
    ctx: WalkContext,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
  ): Promise<{ line: Line } | { plane: Frame } | KernelError | null> {
    if (ORIGIN_PLANES[ref.name] || PLANE_NAME.test(ref.name) || ref.kind === 'face') {
      const p = await this.resolvePlane(ctx, ref, path, unresolved);
      if (!p || 'code' in p) return p;
      return { plane: p.frame };
    }
    const a = await this.resolveAxis(ctx, ref, path, unresolved, false);
    if (!a || 'code' in a) return a;
    return { line: a.line };
  }

  private datumPlan(
    f: AxisFeature | PointFeature,
    frame: Frame,
    values: Record<string, number>,
    involved: Set<string>,
  ): Planned {
    const key = hashKey({ t: f.type, def: definition(f), values, frame });
    const datum: DatumState = { id: f.id, kind: f.type, frame, key: `${key}/D` };
    return {
      unresolved: [],
      taint: [],
      plan: {
        key,
        involved: [...involved],
        run: async () => ({
          result: { ok: true, set: [], remove: [], touched: [], datum, warnings: [] },
          owned: [],
        }),
      },
    };
  }

  private async planAxis(
    ctx: WalkContext,
    f: AxisFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const involved = new Set<string>();
    const note = (owner: string | undefined) => {
      if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
    };
    const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
    const geoError = (message: string, refs: EntityRef[]) =>
      fail(
        kerr('INVALID_INPUT', message, {
          hint: 'Pick other references for the axis.',
          entityRefs: refs.map((r) => r.name),
        }),
      );
    const d = f.definition;
    let line: Line | null = null;
    if (d.kind === 'twoPoints') {
      const a = await this.resolvePoint(ctx, d.a, '/definition/a', unresolved);
      const b = await this.resolvePoint(ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (a && b) {
        note(a.owner);
        note(b.owner);
        if (dist(a.point, b.point) <= 1e-9) return geoError('The two points coincide', [d.a, d.b]);
        line = { origin: a.point, dir: normalize(sub(b.point, a.point)) };
      }
    } else if (d.kind === 'edge') {
      const t = await this.resolveSub(ctx, d.edge, '/definition/edge', unresolved);
      if (t) {
        note(t.owner);
        const l = t.kind === 'edge' ? await this.lineOfEdge(t) : null;
        if (!l) return geoError('Pick a straight edge', [d.edge]);
        line = { origin: l.a, dir: normalize(sub(l.b, l.a)) };
      }
    } else if (d.kind === 'cylinder') {
      const a = await this.resolveAxis(ctx, d.face, '/definition/face', unresolved, false);
      if (a && 'code' in a) return fail(a);
      if (a) {
        note(a.owner);
        line = a.line;
      }
    } else if (d.kind === 'twoPlanes') {
      const a = await this.resolvePlane(ctx, d.a, '/definition/a', unresolved);
      const b = await this.resolvePlane(ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (a && b) {
        note(a.target?.owner);
        note(b.target?.owner);
        const g = planesIntersection(a.frame, b.frame);
        if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
        line = g;
      }
    } else if (d.kind === 'pointNormal') {
      const p = await this.resolvePoint(ctx, d.point, '/definition/point', unresolved);
      const pl = await this.resolvePlane(ctx, d.plane, '/definition/plane', unresolved);
      if (p && 'code' in p) return fail(p);
      if (pl && 'code' in pl) return fail(pl);
      if (p && pl) {
        note(p.owner);
        note(pl.target?.owner);
        line = { origin: p.point, dir: normalize(pl.frame.z) };
      }
    }
    if (unresolved.length > 0 || !line) return { unresolved, taint: [] };
    return this.datumPlan(f, lineFrame(line), values, involved);
  }

  private async planPoint(
    ctx: WalkContext,
    f: PointFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const involved = new Set<string>();
    const note = (owner: string | undefined) => {
      if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
    };
    const fail = (e: KernelError): Planned => ({ unresolved, taint: [], error: e });
    const geoError = (
      message: string,
      refs: EntityRef[],
      code: KernelError['code'] = 'INVALID_INPUT',
    ) =>
      fail(
        kerr(code, message, {
          hint: 'Pick other references for the point.',
          entityRefs: refs.map((r) => r.name),
        }),
      );
    const d = f.definition;
    let point: Vec3 | null = null;
    if (d.kind === 'coordinates') {
      point = [
        values['/definition/x'] ?? 0,
        values['/definition/y'] ?? 0,
        values['/definition/z'] ?? 0,
      ];
    } else if (d.kind === 'vertex') {
      const p = await this.resolvePoint(ctx, d.vertex, '/definition/vertex', unresolved);
      if (p && 'code' in p) return fail(p);
      if (p) {
        note(p.owner);
        point = p.point;
      }
    } else if (d.kind === 'center') {
      const t = await this.resolveSub(ctx, d.of, '/definition/of', unresolved);
      if (t) {
        note(t.owner);
        if (t.kind === 'edge') point = (await this.circleOfEdge(t))?.centre ?? null;
        else if (t.kind === 'face') {
          point = await this.memo(t.shape, `sphere:${t.index}`, () =>
            sphereCentre(this.geo(), t.shape, t.index),
          );
        }
        if (!point) return geoError('Pick a circular edge or a spherical face', [d.of]);
      }
    } else if (d.kind === 'alongEdge') {
      const t = await this.resolveSub(ctx, d.edge, '/definition/edge', unresolved);
      if (t) {
        note(t.owner);
        const l = t.kind === 'edge' ? await this.lineOfEdge(t) : null;
        if (!l) {
          return geoError(
            'A position along a curved edge is not supported yet; pick a straight edge',
            [d.edge],
            'UNSUPPORTED_FEATURE',
          );
        }
        point = add(l.a, scale(sub(l.b, l.a), values['/definition/t'] ?? 0));
      }
    } else if (d.kind === 'intersection') {
      const a = await this.resolveLineOrPlane(ctx, d.a, '/definition/a', unresolved);
      const b = await this.resolveLineOrPlane(ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (a && b) {
        const tol = Math.max(1e-6, 1e-6 * (await this.partDiag(ctx)));
        const g =
          'line' in a && 'line' in b
            ? lineLineIntersection(a.line, b.line, tol)
            : 'line' in a && 'plane' in b
              ? linePlaneIntersection(a.line, b.plane)
              : 'plane' in a && 'line' in b
                ? linePlaneIntersection(b.line, a.plane)
                : { error: 'Two planes meet in a line; pick a line and a plane' };
        if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
        point = g;
      }
    }
    if (unresolved.length > 0 || !point) return { unresolved, taint: [] };
    return this.datumPlan(f, pointFrame(point), values, involved);
  }

  // -------------------------------------------------------------------------------------------
  // M3: shell, draft, sweep, loft
  // -------------------------------------------------------------------------------------------

  /** Resolves face refs that must all lie on one (B-rep) body. */
  private async facesOfOneBody(
    ctx: WalkContext,
    refsIn: readonly EntityRef[],
    base: string,
    unresolved: UnresolvedRef[],
    verb: string,
  ): Promise<{
    body?: BodyState;
    refs: Record<string, ResolvedRef>;
    refKeys: Record<string, unknown>;
    error?: KernelError;
    taint: string[];
  }> {
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const owners = new Set<string>();
    const picked: string[] = [];
    for (let i = 0; i < refsIn.length; i++) {
      const ref = refsIn[i] as EntityRef;
      const path = `${base}/${i}`;
      const t = await this.resolveSub(ctx, ref, path, unresolved);
      if (!t) continue;
      if (t.kind !== 'face') {
        return {
          refs,
          refKeys,
          taint: [],
          error: kerr('INVALID_INPUT', `Only faces can be ${verb}`, { entityRefs: [ref.name] }),
        };
      }
      refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
      refKeys[path] = this.refKeyOf(ctx, t);
      owners.add(t.owner);
      picked.push(t.name);
    }
    const ids = [...owners];
    const bodies = ids.filter((o) => ctx.state.bodies.has(o));
    if (ids.length > 1 || (ids.length === 1 && bodies.length === 0)) {
      return {
        refs,
        refKeys,
        taint: bodies,
        error: kerr(
          'INVALID_INPUT',
          bodies.length === 0
            ? `Only faces of a body can be ${verb}`
            : `The faces must all be on one body`,
          { hint: 'Pick faces of one solid body.', entityRefs: picked },
        ),
      };
    }
    const body = bodies[0] === undefined ? undefined : ctx.state.bodies.get(bodies[0]);
    if (body?.meshOnly) {
      return { refs, refKeys, taint: [body.id], error: meshOnlyError(verb, body.id) };
    }
    return body ? { body, refs, refKeys, taint: [body.id] } : { refs, refKeys, taint: [] };
  }

  /** Runs a feature that changes one body in place (shell, draft, hole). */
  private async runOnBody(
    f: Feature,
    body: BodyState,
    inputs: FeatureInputs,
    key: string,
  ): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
    const r = await this.exec(f, { ...inputs, target: body.shape });
    if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
    for (const extra of r.value.bodies ?? []) {
      if (extra.shape !== r.value.shape) await this.releaseHandle(extra.shape);
    }
    return {
      result: {
        ok: true,
        set: [
          { id: body.id, shape: r.value.shape, naming: r.value.naming, key: `${key}/${body.id}` },
        ],
        remove: [],
        touched: [body.id],
        warnings: r.value.warnings,
      },
      owned: [r.value.shape],
    };
  }

  private async planShell(
    ctx: WalkContext,
    f: ShellFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const g = await this.facesOfOneBody(ctx, f.openFaces, '/openFaces', unresolved, 'shelled');
    if (g.error) return { unresolved, taint: g.taint, error: g.error };
    let body = g.body;
    if (f.openFaces.length === 0) {
      if (!f.body) {
        return {
          unresolved,
          taint: [],
          error: kerr('INVALID_INPUT', 'Pick the faces to remove, or the body to hollow'),
        };
      }
      body = this.resolveBody(ctx, f.body, '/body', unresolved) ?? undefined;
      if (body?.meshOnly) {
        return { unresolved, taint: [body.id], error: meshOnlyError('shelled', body.id) };
      }
    } else if (f.body && body && f.body.name !== body.id) {
      return {
        unresolved,
        taint: [body.id],
        error: kerr('INVALID_INPUT', 'The faces to remove are not on the selected body', {
          entityRefs: [f.body.name],
        }),
      };
    }
    if (unresolved.length > 0 || !body) return { unresolved, taint: body ? [body.id] : [] };
    if (!((values['/thickness'] ?? 0) > 0)) {
      return {
        unresolved,
        taint: [body.id],
        error: kerr('INVALID_INPUT', 'The shell thickness must be greater than zero', {
          hint: 'Enter a positive thickness; use the direction to shell outward.',
        }),
      };
    }
    const target = body;
    const key = hashKey({
      t: 'shell',
      def: definition(f),
      values,
      refs: g.refKeys,
      body: [target.id, target.key],
    });
    return {
      unresolved,
      taint: [target.id],
      plan: {
        key,
        involved: [target.id],
        run: () => this.runOnBody(f, target, { values, refs: g.refs }, key),
      },
    };
  }

  private async planDraft(
    ctx: WalkContext,
    f: DraftFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const g = await this.facesOfOneBody(ctx, f.faces, '/faces', unresolved, 'drafted');
    if (g.error) return { unresolved, taint: g.taint, error: g.error };
    const p = await this.resolvePlane(ctx, f.neutral, '/neutral', unresolved);
    if (p && 'code' in p) return { unresolved, taint: g.taint, error: p };
    if (unresolved.length > 0 || !p || !g.body) return { unresolved, taint: g.taint };
    if (f.faces.length === 0) {
      return {
        unresolved,
        taint: [],
        error: kerr('INVALID_INPUT', 'Pick the faces to draft'),
      };
    }
    const body = g.body;
    const refs = { ...g.refs };
    const refKeys: Record<string, unknown> = { ...g.refKeys, '/neutral': p.shapeKey };
    // `frames.neutral` always carries the plane; `refs['/neutral']` too when it is a face or a
    // plane feature's face (origin planes have no shape).
    if (p.target) {
      refs['/neutral'] = { shape: p.target.shape, kind: p.target.kind, index: p.target.index };
      refKeys['/neutral'] = [p.shapeKey, ...this.refKeyOf(ctx, p.target).slice(1)];
    }
    const frames = { neutral: p.frame };
    const key = hashKey({
      t: 'draft',
      def: definition(f),
      values,
      refs: refKeys,
      frames,
      body: [body.id, body.key],
    });
    return {
      unresolved,
      taint: [body.id],
      plan: {
        key,
        involved: [body.id],
        run: () => this.runOnBody(f, body, { values, refs, frames }, key),
      },
    };
  }

  private async planSweepLoft(
    ctx: WalkContext,
    f: SweepFeature | LoftFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const involved = new Set<string>();
    const note = (path: string, t: ResolvedTarget) => {
      refs[path] = { shape: t.shape, kind: t.kind, index: t.index };
      refKeys[path] = this.refKeyOf(ctx, t);
      if (ctx.state.bodies.has(t.owner)) involved.add(t.owner);
    };
    const taintNew = f.op === 'new' ? [`B${f.id}`] : [];
    const fail = (message: string, names: string[] = []): Planned => ({
      unresolved,
      taint: taintNew,
      error: kerr('INVALID_INPUT', message, { entityRefs: names }),
    });
    let feature: SweepFeature | LoftFeature = f;
    if (f.type === 'sweep') {
      for (let i = 0; i < f.profile.length; i++) {
        const t = await this.resolveSub(
          ctx,
          f.profile[i] as EntityRef,
          `/profile/${i}`,
          unresolved,
        );
        if (t) note(`/profile/${i}`, t);
      }
      if (f.profile.length === 0) return fail('Select the profile to sweep');
      const path: (ResolvedTarget | null)[] = [];
      for (let i = 0; i < f.path.length; i++) {
        path.push(await this.resolveSub(ctx, f.path[i] as EntityRef, `/path/${i}`, unresolved));
      }
      if (unresolved.length === 0) {
        const tol = Math.max(1e-6, 1e-6 * (await this.partDiag(ctx)));
        const ends: Vec3[][] = [];
        for (const t of path as ResolvedTarget[]) {
          if (t.kind !== 'edge')
            return fail('The sweep path must be edges or sketch curves', [t.name]);
          ends.push(await this.endpointsOf(t, tol / 10));
        }
        const chain = chainOrder(ends, tol);
        if (!chain.ok)
          return fail(
            chain.message,
            f.path.map((r) => r.name),
          );
        feature = { ...f, path: chain.order.map((i) => f.path[i] as EntityRef) };
        chain.order.forEach((src, j) => {
          note(`/path/${j}`, path[src] as ResolvedTarget);
        });
      }
    } else {
      if (f.sections.length < 2) return fail('A loft needs at least two sections');
      for (let i = 0; i < f.sections.length; i++) {
        const ref = f.sections[i] as EntityRef;
        const t = await this.resolveSub(ctx, ref, `/sections/${i}`, unresolved);
        if (!t) continue;
        if (t.kind === 'vertex' && i > 0 && i < f.sections.length - 1) {
          return fail('Only the first and the last loft section can be a point', [ref.name]);
        }
        if (t.kind === 'edge')
          return fail('Loft sections are regions, faces or points', [ref.name]);
        note(`/sections/${i}`, t);
      }
      for (let i = 0; i < (f.guides ?? []).length; i++) {
        const t = await this.resolveSub(
          ctx,
          (f.guides as EntityRef[])[i] as EntityRef,
          `/guides/${i}`,
          unresolved,
        );
        if (t) note(`/guides/${i}`, t);
      }
    }
    const scoped =
      f.op === 'new'
        ? { bodies: [] as BodyState[], mode: 'bodies' as const }
        : this.scopeBodies(ctx, f.scope, unresolved);
    if ('error' in scoped && scoped.error) {
      return { unresolved, taint: scoped.bodies.map((b) => b.id), error: scoped.error };
    }
    const taint = f.op === 'new' ? taintNew : scoped.bodies.map((b) => b.id);
    if (scoped.mode === 'bodies') for (const b of scoped.bodies) involved.add(b.id);
    else if (f.op !== 'new') {
      for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
    }
    const key = hashKey({
      t: f.type,
      def: definition(f),
      values,
      refs: refKeys,
      scope: scoped.mode,
      bodies: scoped.bodies.map((b) => [b.id, b.key]),
    });
    const inputs: FeatureInputs = { values, refs };
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: [...involved],
        reads: scoped.bodies.map((b) => b.id),
        run: () => this.runSolid(feature, inputs, scoped, key),
        tool: this.solidTool(feature, inputs, refKeys),
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // M3: mirror and patterns
  // -------------------------------------------------------------------------------------------

  /** The cached tool solid of a source feature, built on first use (see `ToolSpec`). */
  private async toolOf(
    ctx: WalkContext,
    spec: ToolSpec,
    depth?: number,
  ): Promise<Result<{ shape: ShapeHandle; naming: NamingMap }>> {
    const key = depth === undefined ? spec.key : hashKey({ tool: spec.key, depth });
    let e = ctx.pc.entries.get(key);
    if (!e?.result.ok || !e.result.tool) {
      const r = await spec.build(depth);
      if (!r.ok) return r;
      for (const extra of r.value.bodies ?? []) {
        if (extra.shape !== r.value.shape) await this.releaseHandle(extra.shape);
      }
      const tool = { shape: r.value.shape, naming: r.value.naming };
      e = {
        key,
        owned: [tool.shape],
        result: { ok: true, set: [], remove: [], touched: [], tool, warnings: [] },
        lastUsed: ctx.pc.tick,
      };
      this.ownedHandles.add(tool.shape);
      ctx.pc.entries.set(key, e);
    }
    e.lastUsed = ctx.pc.tick;
    ctx.used.add(key);
    const tool = (e.result as { tool: { shape: ShapeHandle; naming: NamingMap } }).tool;
    return { ok: true, value: tool };
  }

  private async planCopy(
    ctx: WalkContext,
    f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const frames: Record<string, Frame> = {};
    const involved = new Set<string>();
    const warnings: KernelError[] = [];
    const fail = (e: KernelError, taint: string[] = []): Planned => ({
      unresolved,
      taint,
      error: e,
    });
    const noteOwner = (owner: string | undefined) => {
      if (owner && ctx.state.bodies.has(owner)) involved.add(owner);
    };

    // 1. Where the copies go.
    if (f.type === 'mirror') {
      const p = await this.resolvePlane(ctx, f.plane, '/plane', unresolved);
      if (p && 'code' in p) return fail(p);
      if (p) {
        frames.plane = p.frame;
        noteOwner(p.target?.owner);
      }
    } else if (f.type === 'linearPattern') {
      const a = await this.resolveAxis(ctx, f.direction, '/direction', unresolved, true);
      if (a && 'code' in a) return fail(a);
      if (a) {
        frames.axis = lineFrame(a.line);
        noteOwner(a.owner);
      }
      if (f.second) {
        const b = await this.resolveAxis(
          ctx,
          f.second.direction,
          '/second/direction',
          unresolved,
          true,
        );
        if (b && 'code' in b) return fail(b);
        if (b) {
          frames.second = lineFrame(b.line);
          noteOwner(b.owner);
        }
      }
    } else {
      const a = await this.resolveAxis(ctx, f.axis, '/axis', unresolved, false);
      if (a && 'code' in a) return fail(a);
      if (a) {
        frames.axis = lineFrame(a.line);
        noteOwner(a.owner);
      }
    }

    // 2. Counts (whole numbers) and skips.
    let total = f.type === 'mirror' ? 2 : 1;
    for (const p of ['/count', '/second/count']) {
      const v = values[p];
      if (v === undefined) continue;
      const n = Math.round(v);
      if (Math.abs(v - n) > 1e-9 || n < 1) {
        return fail(
          kerr('INVALID_INPUT', `${FIELD_LABELS[p]} must be a whole number of at least 1`, {
            hint: 'Enter the number of instances, the original included.',
            detail: `${p} = ${v}`,
          }),
        );
      }
      values[p] = n;
      total *= n;
    }
    if (f.type !== 'mirror') {
      if (total === 1) {
        warnings.push(kerr('INVALID_INPUT', 'The pattern has one instance, so it makes no copies'));
      }
      const bad = (f.skip ?? []).filter((k) => !Number.isInteger(k) || k < 1 || k >= total);
      if (bad.length > 0) {
        warnings.push(
          kerr(
            'INVALID_INPUT',
            `Skipped instance${bad.length === 1 ? '' : 's'} ${bad.join(', ')} ${
              bad.length === 1 ? 'is' : 'are'
            } not a copy in this pattern and ${bad.length === 1 ? 'is' : 'are'} ignored`,
            { hint: 'Instance 0 is the original; copies are numbered 1 and up.' },
          ),
        );
      }
    }

    // 3. What is copied.
    const specs: ToolSpec[] = [];
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const sources: BodyState[] = [];
    let target: BodyState | undefined;
    const src = f.source;
    if (src.kind === 'features') {
      if (src.features.length === 0)
        return fail(kerr('INVALID_INPUT', 'Select the features to copy'));
      const targets = new Set<string>();
      for (const [i, id] of src.features.entries()) {
        const feature = ctx.part.features.find((x) => x.id === id);
        if (!feature) {
          unresolved.push({
            path: `/source/features/${i}`,
            ref: { name: `F${id}`, kind: 'body' },
            reason: 'missing',
          });
          continue;
        }
        const spec = ctx.state.tools.get(id);
        if (!spec) {
          const why = !TOOL_TYPES.has(feature.type)
            ? `‘${feature.name}’ cannot be copied: only extrude, revolve, sweep, loft, hole and primitive features can`
            : feature.suppressed
              ? `‘${feature.name}’ is suppressed, so there is nothing to copy`
              : `‘${feature.name}’ must come before this feature`;
          return fail(
            kerr('INVALID_INPUT', why, {
              hint: 'Copy bodies instead, or reorder the features.',
              entityRefs: [`F${id}`],
            }),
          );
        }
        specs.push(spec);
        values[`/ops/${id}`] = spec.op;
        for (const b of spec.bodies) targets.add(b);
      }
      if (unresolved.length > 0) return { unresolved, taint: [] };
      const live = [...targets].filter((b) => ctx.state.bodies.has(b));
      if (live.length === 0) {
        return fail(
          kerr('INVALID_INPUT', 'The copied features no longer change any body', {
            hint: 'Copy bodies instead.',
          }),
        );
      }
      if (live.length > 1) {
        return fail(
          kerr('INVALID_INPUT', 'The copied features change more than one body', {
            hint: 'Copy the features of one body at a time, or copy bodies instead.',
            entityRefs: live,
          }),
          live,
        );
      }
      target = ctx.state.bodies.get(live[0] as string) as BodyState;
      if (target.meshOnly) return fail(meshOnlyError('changed', target.id), [target.id]);
      involved.add(target.id);
    } else {
      if (src.bodies.length === 0) return fail(kerr('INVALID_INPUT', 'Select the bodies to copy'));
      for (const [i, ref] of src.bodies.entries()) {
        const b = this.resolveBody(ctx, ref, `/source/bodies/${i}`, unresolved);
        if (!b) continue;
        if (b.meshOnly) return fail(meshOnlyError('copied', b.id), [b.id]);
        refs[`/source/bodies/${i}`] = { shape: b.shape, kind: 'body', index: 0 };
        refKeys[`/source/bodies/${i}`] = [b.id, b.key];
        involved.add(b.id);
        sources.push(b);
      }
    }
    const taint = target ? [target.id] : src.kind === 'bodies' && src.merge ? [...involved] : [];
    if (unresolved.length > 0) return { unresolved, taint };
    const key = hashKey({
      t: f.type,
      def: definition(f),
      values,
      frames,
      tools: specs.map((s) => [s.featureId, s.key, s.op]),
      target: target ? [target.id, target.key] : null,
      refs: refKeys,
    });
    const inputs: FeatureInputs = { values, frames, refs };
    const out: Planned = {
      unresolved,
      taint,
      plan: {
        key,
        involved: [...involved],
        run: () => this.runCopy(ctx, f, inputs, specs, target, sources, key),
      },
    };
    if (warnings.length > 0) out.warnings = warnings;
    return out;
  }

  /**
   * Depth of the blind tool that stands in for a copied through-all extrude (`ToolSpec.build`).
   * Every copy must still cut through the whole target body, so the depth is at least twice the
   * farthest a target point can be from a copied profile plane: the diagonal of the target and
   * profile boxes together (the kernel's own through-all bound) plus the farthest a profile point
   * moves (linear: the pattern's full span; circular: twice its distance from the axis; mirror:
   * twice its distance from the plane). Rounded up to a power of two, so edits that resize the
   * body a little keep the cached tool.
   */
  private async throughAllDepth(
    f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
    inputs: FeatureInputs,
    target: BodyState,
    profiles: ShapeHandle[],
  ): Promise<number> {
    const box = emptyBox();
    const profile = emptyBox();
    const tb = await this.massOf(target.shape);
    if (tb) {
      extendBox(box, tb.bbox.min);
      extendBox(box, tb.bbox.max);
    }
    for (const s of profiles) {
      const pb = await this.massOf(s);
      if (!pb) continue;
      for (const p of [pb.bbox.min, pb.bbox.max]) {
        extendBox(box, p);
        extendBox(profile, p);
      }
    }
    const corners: Vec3[] = [];
    if (profile.max[0] >= profile.min[0]) {
      for (let i = 0; i < 8; i++) {
        corners.push([
          (i & 1 ? profile.max : profile.min)[0],
          (i & 2 ? profile.max : profile.min)[1],
          (i & 4 ? profile.max : profile.min)[2],
        ]);
      }
    }
    const values = inputs.values;
    let reach = 0;
    if (f.type === 'linearPattern') {
      for (const p of ['', '/second']) {
        const n = values[`${p}/count`] ?? 1;
        reach += Math.max(0, n - 1) * Math.abs(values[`${p}/spacing`] ?? 0);
      }
    } else {
      const frame = f.type === 'mirror' ? inputs.frames?.plane : inputs.frames?.axis;
      for (const c of corners) {
        if (!frame) break;
        const z = normalize(frame.z);
        const d = sub(c, frame.origin);
        const off = f.type === 'mirror' ? Math.abs(dot(d, z)) : norm(sub(d, scale(z, dot(d, z))));
        reach = Math.max(reach, 2 * off);
      }
    }
    const needed = 2 * (boxDiagonal(box) + reach) + 1;
    return 2 ** Math.ceil(Math.log2(Math.max(needed, 1)));
  }

  /**
   * Runs a mirror / pattern. Feature copies change the source features' body in place (it keeps
   * its id). Body copies with `merge` fuse into the first source body (the others are consumed);
   * without `merge` each copy is a new body: `B<featureId>` for one, else `B<featureId>:<key>`
   * with the kernel's per-copy key (FeatureResult.bodies).
   */
  private async runCopy(
    ctx: WalkContext,
    f: MirrorFeature | LinearPatternFeature | CircularPatternFeature,
    inputs: FeatureInputs,
    specs: ToolSpec[],
    target: BodyState | undefined,
    sources: BodyState[],
    key: string,
  ): Promise<{ result: EntryResult; owned: ShapeHandle[] }> {
    const fail = (error: KernelError) => ({ result: { ok: false as const, error }, owned: [] });
    const shapes: Record<string, ShapeHandle> = {};
    for (const spec of specs) {
      const depth =
        spec.throughAll && target
          ? await this.throughAllDepth(f, inputs, target, spec.throughAll)
          : undefined;
      const t = await this.toolOf(ctx, spec, depth);
      if (!t.ok) return fail(t.error);
      shapes[`tool:${spec.featureId}`] = t.value.shape;
    }
    const all: FeatureInputs = { ...inputs, shapes };
    if (target) all.target = target.shape;
    const r = await this.exec(f, all);
    if (!r.ok) return fail(r.error);
    const v = r.value;
    const extras = (v.bodies ?? []).filter((b) => b.shape !== v.shape);
    if (target || (f.source.kind === 'bodies' && f.source.merge)) {
      for (const b of extras) await this.releaseHandle(b.shape);
      const keep = (target ?? sources[0]) as BodyState;
      const consumed = target ? [] : sources.slice(1).map((b) => b.id);
      return {
        result: {
          ok: true,
          set: [{ id: keep.id, shape: v.shape, naming: v.naming, key: `${key}/${keep.id}` }],
          remove: consumed,
          touched: target ? [target.id] : sources.map((b) => b.id),
          warnings: v.warnings,
        },
        owned: [v.shape],
      };
    }
    const copies =
      v.bodies && v.bodies.length > 0 ? v.bodies : [{ key: '', shape: v.shape, naming: v.naming }];
    if (v.bodies && v.bodies.length > 0 && !v.bodies.some((b) => b.shape === v.shape)) {
      await this.releaseHandle(v.shape);
    }
    const set: BodyState[] = copies.map((c) => {
      const id = copies.length === 1 ? `B${f.id}` : `B${f.id}:${c.key}`;
      return { id, shape: c.shape, naming: c.naming, key: `${key}/${id}` };
    });
    return {
      result: { ok: true, set, remove: [], touched: [], warnings: v.warnings },
      owned: [...new Set(copies.map((c) => c.shape))],
    };
  }

  // -------------------------------------------------------------------------------------------
  // M3: holes and cosmetic threads
  // -------------------------------------------------------------------------------------------

  /**
   * Hole wizard: one hole per point on a flat face of a body. `frames["hole:i"]` has its origin on
   * the face (the point projected along the face normal; points off the face plane are an error),
   * z into the material (−outward normal) and x from `planeFrame`. The diameters and depths come
   * from the standards table (`resolveHoleSize`) with explicit values overriding it, written to
   * `values` at the feature's own pointers (`/diameter`, `/counterbore/diameter`, …, angles rad).
   */
  private async planHole(
    ctx: WalkContext,
    f: HoleFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const fail = (e: KernelError, taint: string[] = []): Planned => ({
      unresolved,
      taint,
      error: e,
    });
    if (f.points.length === 0) {
      return fail(
        kerr('INVALID_INPUT', 'Place at least one hole point', {
          hint: 'Sketch points on the face, then pick them.',
        }),
      );
    }
    const ft = await this.resolveSub(ctx, f.face, '/face', unresolved);
    const points: (Vec3 | null)[] = [];
    for (let i = 0; i < f.points.length; i++) {
      const p = await this.resolvePoint(ctx, f.points[i] as EntityRef, `/points/${i}`, unresolved);
      if (p && 'code' in p) return fail(p);
      points.push(p?.point ?? null);
    }
    let body: BodyState | undefined;
    if (ft) {
      body = ft.kind === 'face' ? ctx.state.bodies.get(ft.owner) : undefined;
      if (!body) {
        return fail(
          kerr('INVALID_INPUT', 'Holes are drilled into a flat face of a body', {
            entityRefs: [f.face.name],
          }),
        );
      }
      if (body.meshOnly) return fail(meshOnlyError('drilled', body.id), [body.id]);
    }
    const refs: Record<string, ResolvedRef> = {};
    const refKeys: Record<string, unknown> = {};
    const frames: Record<string, Frame> = {};
    if (f.end.kind === 'upTo') {
      const p = await this.resolvePlane(ctx, f.end.target, '/end/target', unresolved);
      if (p && 'code' in p) return fail(p, body ? [body.id] : []);
      if (p?.target) {
        refs['/end/target'] = { shape: p.target.shape, kind: p.target.kind, index: p.target.index };
        refKeys['/end/target'] = this.refKeyOf(ctx, p.target);
      } else if (p) {
        frames.upTo = p.frame;
        refKeys['/end/target'] = p.shapeKey;
      }
    }
    if (unresolved.length > 0 || !ft || !body) return { unresolved, taint: body ? [body.id] : [] };
    const taint = [body.id];
    const fp = await this.fingerprints(ft.shape);
    const face = fp?.faces[ft.index];
    if (!face?.normal) {
      return fail(
        kerr('INVALID_INPUT', 'Holes are drilled into flat faces', {
          hint: 'Pick a planar face.',
          entityRefs: [f.face.name],
        }),
        taint,
      );
    }
    const n = normalize(face.normal);
    const facePlane: Frame = { origin: face.centroid, z: n, x: planeFrame(face.centroid, n).x };
    const tol = Math.max(1e-6, 1e-6 * (await this.partDiag(ctx)));
    const into = scale(n, -1);
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as Vec3;
      const h = heightAbove(facePlane, p);
      if (Math.abs(h) > tol) {
        return fail(
          kerr('INVALID_INPUT', `Hole point ${i + 1} is not on the hole’s face`, {
            hint: 'Put the hole points in a sketch on that face.',
            entityRefs: [(f.points[i] as EntityRef).name, f.face.name],
            detail: `${h} mm off the face plane`,
          }),
          taint,
        );
      }
      const origin = sub(p, scale(n, h));
      frames[`hole:${i}`] = snapFrame({ origin, z: into, x: planeFrame(origin, into).x });
    }
    const size = resolveHoleSize({
      standard: f.standard,
      kind: f.kind,
      size: f.size,
      fit: f.fit,
      ...(values['/diameter'] === undefined ? {} : { diameter: values['/diameter'] }),
      counterbore: {
        ...(values['/counterbore/diameter'] === undefined
          ? {}
          : { diameter: values['/counterbore/diameter'] }),
        ...(values['/counterbore/depth'] === undefined
          ? {}
          : { depth: values['/counterbore/depth'] }),
      },
      countersink: {
        ...(values['/countersink/diameter'] === undefined
          ? {}
          : { diameter: values['/countersink/diameter'] }),
        ...(values['/countersink/angle'] === undefined
          ? {}
          : { angle: values['/countersink/angle'] }),
      },
    });
    if (!size.ok) {
      return fail(
        kerr('INVALID_INPUT', size.message, { hint: size.hint, detail: size.field }),
        taint,
      );
    }
    if (f.end.kind === 'blind' && !((values['/end/depth'] ?? 0) > 0)) {
      return fail(kerr('INVALID_INPUT', 'The hole depth must be greater than zero'), taint);
    }
    const kv: Record<string, number> = { ...values, '/diameter': size.value.diameter };
    if (size.value.counterbore) {
      kv['/counterbore/diameter'] = size.value.counterbore.diameter;
      kv['/counterbore/depth'] = size.value.counterbore.depth;
    }
    if (size.value.countersink) {
      kv['/countersink/diameter'] = size.value.countersink.diameter;
      kv['/countersink/angle'] = size.value.countersink.angle;
    }
    const key = hashKey({
      t: 'hole',
      def: definition(f),
      values: kv,
      frames,
      refs: refKeys,
      body: [body.id, body.key],
    });
    const target = body;
    const toolInputs: FeatureInputs = { values: kv, frames, refs };
    return {
      unresolved,
      taint,
      plan: {
        key,
        involved: [target.id],
        run: () => this.runOnBody(f, target, toolInputs, key),
        tool: {
          featureId: f.id,
          key: hashKey({ t: 'tool', def: definition(f), values: kv, frames, refs: refKeys }),
          op: 1,
          // Without `target` the kernel returns the drill solids alone (proposed in ADR-036).
          build: () => this.exec(f, toolInputs),
        },
      },
    };
  }

  /** A cosmetic thread: checks the face and the size; no geometry change (M5 carries it to PMI). */
  private async planThread(
    ctx: WalkContext,
    f: ThreadFeature,
    values: Record<string, number>,
  ): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const t = await this.resolveSub(ctx, f.face, '/face', unresolved);
    if (!t) return { unresolved, taint: [] };
    const fp = await this.fingerprints(t.shape);
    const surface = t.kind === 'face' ? fp?.faces[t.index]?.surface : undefined;
    if (surface !== 'cylinder') {
      return {
        unresolved,
        taint: [],
        error: kerr('INVALID_INPUT', 'A cosmetic thread goes on a cylindrical face', {
          entityRefs: [f.face.name],
        }),
      };
    }
    const row = holeRow(f.standard, f.size);
    if (!row) {
      return {
        unresolved,
        taint: [],
        error: kerr('INVALID_INPUT', `${f.standard} ${f.size} is not in the thread table`, {
          hint: 'Pick a thread size from the table.',
        }),
      };
    }
    const warnings: KernelError[] = [];
    const m = await this.kernel.measureShapes({ shape: t.shape, kind: 'face', index: t.index });
    const d = m.ok && m.value.radius !== undefined ? 2 * m.value.radius : undefined;
    if (d !== undefined) {
      const near = (x: number) => Math.abs(d - x) <= 0.05 * x;
      if (!near(row.nominal) && !near(row.tap.drill)) {
        warnings.push(
          kerr(
            'INVALID_INPUT',
            `The face is ${Math.round(d * 1000) / 1000} mm across, which is neither the ${f.size} major diameter (${row.nominal} mm) nor its tap drill (${Math.round(row.tap.drill * 1000) / 1000} mm)`,
          ),
        );
      }
    }
    const owner = ctx.state.bodies.has(t.owner) ? [t.owner] : [];
    const key = hashKey({ t: 'thread', def: definition(f), values, face: this.refKeyOf(ctx, t) });
    return {
      unresolved,
      taint: [],
      plan: {
        key,
        involved: owner,
        run: async () => ({
          result: { ok: true, set: [], remove: [], touched: [], warnings },
          owned: [],
        }),
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // M3: linked sketch entities (Convert Entities)
  // -------------------------------------------------------------------------------------------

  /**
   * Resolves and projects the sources of a sketch's linked entities and re-projects them (see
   * linked.ts). Returns the entities and constraints to solve, `attention` (entity names) when a
   * source is lost — the sketch then needs attention and nothing is re-picked — or an error.
   */
  private async linkedEntities(
    ctx: WalkContext,
    f: SketchFeature,
    plane: Frame,
    unresolved: UnresolvedRef[],
    involved: string[],
  ): Promise<
    | { entities: SketchEntity[]; constraints: SketchConstraint[] }
    | { attention: string[] }
    | KernelError
  > {
    const groups = new Map<string, { ref: EntityRef; ids: Id[]; paths: string[] }>();
    f.entities.forEach((e, i) => {
      if (!e.source) return;
      const k = `${e.source.ref.kind}|${e.source.ref.name}`;
      let g = groups.get(k);
      if (!g) {
        g = { ref: e.source.ref, ids: [], paths: [] };
        groups.set(k, g);
      }
      g.ids.push(e.id);
      g.paths.push(`/entities/${i}/source/ref`);
    });
    const attention: string[] = [];
    const sources: LinkedSource[] = [];
    for (const g of groups.values()) {
      const u: UnresolvedRef[] = [];
      const before = ctx.current.rebound.length;
      const p = await this.projectSource(ctx, f, g.ref, g.paths[0] as string, u, plane);
      if (p && 'code' in p) return p;
      // Every entity sharing a source shares its outcome and its healing.
      const healed = ctx.current.rebound.slice(before);
      for (const path of g.paths.slice(1)) {
        for (const r of healed) ctx.current.rebound.push({ ...r, path });
      }
      if (!p) {
        const first: UnresolvedRef = u[0] ?? { path: '', ref: g.ref, reason: 'missing' };
        for (const path of g.paths) unresolved.push({ ...first, path });
        attention.push(...g.ids.map((id) => entityName(f, id)));
        continue;
      }
      if (p.owner && ctx.state.bodies.has(p.owner) && !involved.includes(p.owner)) {
        involved.push(p.owner);
      }
      const s: LinkedSource = { ref: g.ref, entities: g.ids, curves: p.curves };
      if (p.curves.some((c) => c.kind === 'polyline')) s.approximate = true;
      sources.push(s);
    }
    if (attention.length > 0) return { attention };
    const rp = this.reproject(f.entities, sources);
    for (const l of rp.lost) {
      const i = f.entities.findIndex((e) => e.id === l.entity);
      const e = f.entities[i];
      if (!e?.source) continue;
      unresolved.push({ path: `/entities/${i}/source/ref`, ref: e.source.ref, reason: 'missing' });
      attention.push(entityName(f, l.entity));
    }
    if (attention.length > 0) return { attention };
    // Linked entities are fixed for the solver (grounding twice is harmless if it already is).
    const fixed = new Set<Id>();
    for (const e of rp.entities) {
      if (!e.source) continue;
      fixed.add(e.id);
      if (e.kind === 'line') fixed.add(e.start).add(e.end);
      if (e.kind === 'circle' || e.kind === 'ellipse') fixed.add(e.center);
      if (e.kind === 'arc' || e.kind === 'ellipticArc') fixed.add(e.center).add(e.start).add(e.end);
      if (e.kind === 'bspline') for (const id of e.poles) fixed.add(id);
    }
    const fixes = [...fixed].map(
      (id): SketchConstraint => ({ id: `@linked:${id}`, kind: 'fix', entity: id }),
    );
    return { entities: rp.entities, constraints: [...f.constraints, ...fixes] };
  }

  /** One linked source projected onto the sketch plane; null when it does not resolve. */
  private async projectSource(
    ctx: WalkContext,
    f: SketchFeature,
    ref: EntityRef,
    path: string,
    unresolved: UnresolvedRef[],
    plane: Frame,
  ): Promise<{ curves: LinkedCurve[]; owner?: string } | KernelError | null> {
    const fail = (message: string, code: KernelError['code'] = 'INVALID_INPUT') =>
      kerr(code, message, {
        hint: 'Pick another source, or unlink the entity.',
        entityRefs: [ref.name],
      });
    const one = (c: LinkedCurve | { error: string }, owner?: string) =>
      'error' in c ? fail(c.error) : owner ? { curves: [c], owner } : { curves: [c] };
    if (ref.name === 'origin:O') return one(projectPoint(plane, [0, 0, 0]));
    const oa = ORIGIN_AXES[ref.name];
    if (oa) return one(projectAxis(plane, frameLine(oa)));
    const op = ORIGIN_PLANES[ref.name];
    if (op) return one(projectPlaneTrace(plane, op));
    if (AXIS_NAME.test(ref.name)) {
      const a = await this.resolveAxis(ctx, ref, path, unresolved, false);
      if (!a || 'code' in a) return a;
      return one(projectAxis(plane, a.line));
    }
    if (POINT_NAME.test(ref.name)) {
      const p = await this.resolvePoint(ctx, ref, path, unresolved);
      if (!p || 'code' in p) return p;
      return one(projectPoint(plane, p.point));
    }
    if (PLANE_NAME.test(ref.name)) {
      const p = await this.resolvePlane(ctx, ref, path, unresolved);
      if (!p || 'code' in p) return p;
      return one(projectPlaneTrace(plane, p.frame));
    }
    if (SKETCH_TAG.exec(ref.name)?.[1] === f.id) {
      return fail('A sketch cannot link to its own geometry');
    }
    const t = await this.resolveSub(ctx, ref, path, unresolved);
    if (!t) return null;
    if (t.owner.startsWith('sketch:')) {
      // Another sketch's curve or point: exact, from its solved entities.
      const s = ctx.state.sketches.get(t.owner.slice('sketch:'.length));
      const m = /^S[0-9A-Za-z]+:[ep]\((.+)\)$/.exec(t.name);
      const e = m && s ? s.entities.find((x) => x.id === m[1]) : undefined;
      if (s && e) {
        const pts = new Map<Id, Vec2>();
        for (const x of s.entities) if (x.kind === 'point') pts.set(x.id, [x.x, x.y]);
        const c = projectSketchEntity(plane, s.frame, e, pts);
        if (!('error' in c)) return { curves: [c] };
      }
    }
    if (t.kind === 'vertex') {
      const fp = await this.fingerprints(t.shape);
      const v = fp?.vertices[t.index];
      if (v) return one(projectPoint(plane, v.point), t.owner);
    }
    if (t.kind === 'edge') {
      if (this.kernel.projectEdges) {
        const r = await this.kernel.projectEdges(t.shape, [t.index], plane);
        if (!r.ok) return r.error;
        return { curves: r.value.flatMap((x) => x.curves), owner: t.owner };
      }
      const l = await this.lineOfEdge(t);
      if (l) {
        const c = projectAxis(plane, { origin: l.a, dir: normalize(sub(l.b, l.a)) });
        if (c.kind === 'point') return one(c, t.owner);
        return one({ kind: 'line', a: toLocal(plane, l.a), b: toLocal(plane, l.b) }, t.owner);
      }
      const circle = await this.circleOfEdge(t);
      if (circle?.full) return one(projectCircle(plane, circle), t.owner);
      if (circle) {
        const tol = Math.max(1e-7, 1e-7 * (await this.partDiag(ctx)));
        const ends = await this.endpointsOf(t, tol);
        const fp = await this.fingerprints(t.shape);
        const mid = fp?.edges[t.index]?.centroid;
        if (ends.length === 2 && mid) {
          const [s, e] = ends as [Vec3, Vec3];
          const ccw = dot(cross(sub(s, circle.centre), sub(mid, circle.centre)), circle.normal) > 0;
          return one(
            projectCircle(plane, circle, ccw ? { start: s, end: e } : { start: e, end: s }),
            t.owner,
          );
        }
      }
      return fail(
        'This edge cannot be projected yet (it needs the kernel’s projection call)',
        'UNSUPPORTED_FEATURE',
      );
    }
    if (t.kind === 'face') {
      if (this.kernel.projectFaceOutline) {
        const r = await this.kernel.projectFaceOutline(t.shape, t.index, plane);
        if (!r.ok) return r.error;
        return { curves: flattenProjection(r.value), owner: t.owner };
      }
      return fail(
        'Projecting a face outline needs a newer kernel; convert its edges instead',
        'UNSUPPORTED_FEATURE',
      );
    }
    return fail('This reference cannot be projected into a sketch');
  }

  // -------------------------------------------------------------------------------------------
  // Import (STEP/IGES/BREP solids, mesh reference bodies)
  // -------------------------------------------------------------------------------------------

  private async planImport(ctx: WalkContext, f: ImportFeature): Promise<Planned> {
    const unresolved: UnresolvedRef[] = [];
    const format = f.source.format;
    const taintNew = [`B${f.id}`];
    const meshFormat = MESH_FORMATS.has(format);
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
      for (const t of ctx.tainted.keys()) if (!ctx.state.bodies.has(t)) involved.add(t);
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
        reads: scoped.bodies.map((b) => b.id),
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
      // IGES (M3): the kernel sews loose faces; closed shells become solids, open ones stay
      // shell bodies (whittle_io.cpp importIges).
      const r = await this.kernel.importShapes(
        bytes,
        format === 'brep' ? 'brep' : format === 'iges' ? 'iges' : 'step',
      );
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

  /**
   * Placed, named B-rep bodies of an import (fresh handles the caller owns) from the kernel's
   * `import` feature (ADR-039 item 11): the raw shapes go in as `shapes["source:<k>"]` in file
   * order, the kernel moves them by the frame (shared geometry, no re-import) and names faces
   * `F<id>:face#k` per body by geometric key, edges and vertices from their adjacent faces.
   * Bodies come back ordered by the geometric key of their volume centroids (`shape` first, then
   * `bodies` keyed `body#k`). These are the names the M1 engine gave, so stored references keep
   * resolving (ADR-044; test/regen/import-naming.test.ts).
   */
  private async namedSolids(
    f: ImportFeature,
    raw: RawImport,
    m: Matrix34,
  ): Promise<
    Result<{ bodies: { shape: ShapeHandle; naming: NamingMap }[]; warnings: KernelError[] }>
  > {
    const width = Math.max(4, String(raw.shapes.length - 1).length);
    const shapes: Record<string, ShapeHandle> = {};
    raw.shapes.forEach((h, i) => {
      shapes[`source:${String(i).padStart(width, '0')}`] = h;
    });
    // The frame as the engine validated and orthonormalised it (frameMatrix columns).
    const frame: Frame = {
      origin: [m[3], m[7], m[11]],
      z: [m[2], m[6], m[10]],
      x: [m[0], m[4], m[8]],
    };
    const { scope: _scope, ...feature } = f;
    const r = await this.exec({ ...feature, op: 'new', frame }, { values: {}, shapes });
    if (!r.ok) return r;
    const rank = (key: string) => Number(/^body#(\d+)$/.exec(key)?.[1] ?? Number.NaN);
    const extra = [...(r.value.bodies ?? [])];
    if (extra.some((b) => !Number.isInteger(rank(b.key)))) {
      for (const b of extra) await this.releaseHandle(b.shape);
      await this.releaseHandle(r.value.shape);
      return {
        ok: false,
        error: kerr('INTERNAL', 'The imported bodies could not be ordered', {
          detail: `kernel body keys: ${extra.map((b) => b.key).join(', ')}`,
        }),
      };
    }
    extra.sort((a, b) => rank(a.key) - rank(b.key));
    const bodies = [
      { shape: r.value.shape, naming: r.value.naming },
      ...extra.map((b) => ({ shape: b.shape, naming: b.naming })),
    ];
    return { ok: true, value: { bodies, warnings: r.value.warnings } };
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
    const bodyId = (k: number) => (tools.length === 1 ? `B${f.id}` : `B${f.id}#${k}`);
    // Open surfaces (IGES surface models whose faces do not close, loose faces): never passed
    // off as solids. Their volume and mass mean nothing, and booleans with them are refused.
    const open: string[] = [];
    if (!meshOnly) {
      for (const [k, t] of tools.entries()) {
        const fp = await this.fingerprints(t.shape);
        if (hasFreeEdges(t.naming, f.id, fp)) open.push(bodyId(k));
      }
    }
    if (open.length > 0) {
      const what =
        open.length === tools.length ? 'The imported file has' : 'Some imported bodies have';
      if (f.op !== 'new') {
        for (const t of tools) await this.releaseHandle(t.shape);
        return fail(
          kerr(
            'INVALID_INPUT',
            `${what} open surfaces, so it cannot ${f.op === 'add' ? 'add to' : f.op} a body`,
            {
              hint: 'Set the operation to New, or close the gaps (or export a solid) in the other program.',
              entityRefs: open,
            },
          ),
        );
      }
      warnings.push(
        kerr('OPERATION_FAILED', `${what} open surfaces, not closed solids`, {
          hint: 'Their volume and mass are not meaningful. Close the gaps or export a solid in the other program.',
          entityRefs: open,
        }),
      );
    }
    const asNew = (extra: KernelError[]) => {
      const set: BodyState[] = tools.map((t, k) => {
        const id = bodyId(k);
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

/** The containers an ok result sets (cause.ts touchers) and the bodies it removes. */
function walkDelta(r: Extract<EntryResult, { ok: true }>): NonNullable<WalkEntry['delta']> {
  const set: WalkContainer[] = r.set.map((b) => ({ id: b.id, naming: b.naming }));
  if (r.sketch) set.push({ id: `sketch:${r.sketch.id}`, naming: r.sketch.naming });
  if (r.plane) set.push({ id: `plane:${r.plane.id}`, naming: r.plane.naming });
  if (r.datum) {
    const d = r.datum;
    set.push({
      id: `datum:${d.id}`,
      naming: [
        { name: `F${d.id}:${d.kind}`, kind: d.kind === 'axis' ? 'edge' : 'vertex', index: 0 },
      ],
    });
  }
  return { set, remove: [...r.remove] };
}

function crossY(f: Frame): Vec3 {
  const y: Vec3 = [
    f.z[1] * f.x[2] - f.z[2] * f.x[1],
    f.z[2] * f.x[0] - f.z[0] * f.x[2],
    f.z[0] * f.x[1] - f.z[1] * f.x[0],
  ];
  return y.map((v) => (v === 0 ? 0 : v)) as Vec3; // no -0
}

/** Feature types whose tool solid can be copied by mirror / patterns. */
const TOOL_TYPES: ReadonlySet<Feature['type']> = new Set([
  'extrude',
  'revolve',
  'primitive',
  'sweep',
  'loft',
  'hole',
]);

/** values["/ops/<id>"] of a copied feature: 0 add, 1 cut, 2 intersect (a `new` copy is added). */
function opCode(op: ExtrudeFeature['op']): 0 | 1 | 2 {
  return op === 'cut' ? 1 : op === 'intersect' ? 2 : 0;
}

/** Persistent name of a sketch entity (naming.ts): points `S…:p(id)`, curves `S…:e(id)`. */
function entityName(f: SketchFeature, id: Id): string {
  const e = f.entities.find((x) => x.id === id);
  return `S${f.id}:${e?.kind === 'point' ? 'p' : 'e'}(${id})`;
}

function fieldLabel(f: Feature, pointer: string): string {
  const m = /^\/constraints\/(\d+)\/value$/.exec(pointer);
  if (m && f.type === 'sketch') {
    const c = f.constraints[Number(m[1])];
    return c ? `Sketch dimension ${c.id} (${c.kind})` : 'Sketch dimension';
  }
  return FIELD_LABELS[pointer] ?? pointer;
}

const DIMENSION_LABELS: Record<string, string> = {
  distance: 'Distance',
  hDistance: 'Horizontal distance',
  vDistance: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

/** `AttentionCause.detail` labels: sketch dimensions by kind, never by constraint id. */
function causeLabel(f: Feature, pointer: string): string {
  const m = /^\/constraints\/(\d+)\/value$/.exec(pointer);
  if (m && f.type === 'sketch') {
    const c = f.constraints[Number(m[1])];
    return (c && DIMENSION_LABELS[c.kind]) ?? 'Dimension';
  }
  return fieldLabel(f, pointer);
}

/** Spare (unused by the latest regen) imported attachments kept per part, LRU. */
const IMPORT_SPARE = 8;
const DEFAULT_VERSION_SLOTS = 2;

function validSlots(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** `'main'` or `version:<non-empty id>` (Comlink callers are not type-checked). */
function isSlot(s: unknown): s is RegenSlot {
  return s === 'main' || (typeof s === 'string' && s.startsWith('version:') && s.length > 8);
}

function slotLabel(s: RegenSlot): string {
  return s === 'main' ? 'the live model' : `version ${s.slice('version:'.length)}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function validSpare(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
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
