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
  ChamferFeature,
  CircularPatternFeature,
  DraftFeature,
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  Feature,
  FeatureInputs,
  FeatureResult,
  FilletFeature,
  Frame,
  HoleFeature,
  Id,
  ImportFeature,
  KernelError,
  LinearPatternFeature,
  Measurement,
  MeasureTarget,
  MeshBuffers,
  MeshQuality,
  MirrorFeature,
  NamingMap,
  PlaneFeature,
  PointFeature,
  PushPullFeature,
  RegenRequest,
  RegenSlot,
  ResolvedRef,
  Result,
  ShapeHandle,
  ShellFeature,
  SketchResult,
  ThreadFeature,
  UnresolvedRef,
  Vec3,
} from '@wren-cad/contracts';
import {
  evaluateFeatureValues,
  featureReferences,
  holeRow,
  resolveHoleSize,
} from '@wren-cad/document';
import { IoError, importMesh, meshToStl } from '@wren-cad/io';
import { zipSync } from 'fflate';
import type { MeasureSubject } from '../kernel-api';
import { attachCauses, FIELD_LABELS, fieldLabel, walkDelta, walkEntry } from './attribution';
import { newWalk, pushWalk, type WalkEntry } from './cause';
import { type CompareOutput, type DiffSide, geometricDiff } from './compare';
import { EngineCore } from './core';
import {
  anglePlane,
  flipFrame,
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
} from './datums';
import { planSketch } from './exec-sketch';
import { planSolid, planSweepLoft, sameSolid } from './exec-solids';
import {
  add,
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
  planeFrame,
  scale,
  sub,
} from './geometry';
import { hashKey } from './hash';
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
  placeMesh,
  sha256Hex,
} from './imports';
import { bodyResult, densityOf, sketchResult } from './outputs';
import {
  fingerprintOf,
  partDiag,
  refKeyOf,
  resolveAxis,
  resolveBody,
  resolveLineOrPlane,
  resolvePlane,
  resolvePoint,
  resolveSub,
  scopeBodies,
} from './refs';
import type { ResolvedTarget } from './resolve';
import {
  capitalise,
  DEFAULT_VERSION_SLOTS,
  isSlot,
  ResultCache,
  slotLabel,
  validSlots,
  validSpare,
} from './result-cache';
import {
  type BodyState,
  type DatumState,
  type EntryResult,
  ModelState,
  type PartCache,
  type PlaneState,
  type Planned,
  type RawImport,
  type ToolSpec,
  type WalkContext,
} from './state';
import type {
  ExportResult,
  ImportResult,
  RegenEngineDeps,
  RegenEngineOptions,
  RegenFeatureStatus,
  RegenOutput,
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
// Engine
// ---------------------------------------------------------------------------------------------

export class RegenEngine {
  /** The kernel, the sketch solver and the per-handle caches the feature executors share. */
  private readonly core: EngineCore;
  /** Per-part, per-slot feature-result caches. */
  private readonly cache: ResultCache;
  private readonly now: () => number;
  /** Serialises engine calls (Comlink may interleave async calls). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RegenEngineDeps) {
    this.core = new EngineCore(deps);
    this.cache = new ResultCache(
      this.core,
      validSpare(deps.options?.maxSpareResults) ?? 128,
      validSlots(deps.options?.maxVersionSlots) ?? DEFAULT_VERSION_SLOTS,
    );
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
      if (spare !== undefined) this.cache.maxSpare = spare;
      const slots = validSlots(options.maxVersionSlots);
      if (slots !== undefined) {
        this.cache.maxSlots = slots;
        for (const partId of [...this.cache.parts.keys()]) await this.cache.evictSlots(partId);
      }
    });
  }

  /** Live model only (`'main'`): selection never refers to a version slot. */
  refFor(partId: Id, query: EntityQuery): Promise<EntityRef | null> {
    return this.serial(async () => {
      const latest = this.cache.slotCache(partId, 'main')?.latest;
      const body = latest?.bodies.find((b) => b.id === query.bodyId);
      if (!body) return null;
      const entry = body.naming.find((n) => n.kind === query.kind && n.index === query.index);
      if (!entry) return null;
      const fp = await this.core.fingerprints(body.shape);
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
      const latest = this.cache.slotCache(partId, 'main')?.latest;
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
      if (b === undefined) return this.core.kernel.measureShapes(sa);
      const sb = await this.measureSubject(latest.bodies, b);
      if ('code' in sb) return { ok: false, error: sb };
      return this.core.kernel.measureShapes(sa, sb);
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
    const fp = await this.core.fingerprints(body.shape);
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
      const latest = this.cache.slotCache(partId, 'main')?.latest;
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
      const r = await this.core.kernel.exportShapes(shapes, format, opts);
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
      const r = await this.core.kernel.importShapes(bytes, format);
      if (!r.ok) return r;
      const out: { shape: ShapeHandle; mesh: MeshBuffers; name?: string }[] = [];
      for (const b of r.value) {
        const m = await this.core.kernel.mesh(b.shape, {
          ...this.core.quality.fine,
          relative: true,
        });
        if (!m.ok) {
          for (const x of r.value) await this.core.kernel.release(x.shape);
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
      const slots = this.cache.parts.get(partId);
      if (!slots) return;
      for (const pc of [...slots.values()]) {
        if (slot === undefined || pc.slot === slot) await this.cache.releaseSlot(partId, pc);
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
        const pc = this.cache.slotCache(partId, s);
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
        pc.used = ++this.cache.slotTick;
        sides.push(await this.diffSide(pc, warnings));
      }
      const kernel = this.core.kernel;
      const r = await geometricDiff(
        {
          exec: (f, i) => this.core.exec(f, i),
          mesh: (shape, options) => kernel.mesh(shape, options),
          massProperties: (shape, density) => kernel.massProperties(shape, density),
          release: (shape) => kernel.release(shape),
        },
        sides[0] as DiffSide,
        sides[1] as DiffSide,
        { ...this.core.quality[quality], relative: true },
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
      const mp = await this.core.massOf(body.shape);
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
    return this.core.ownedHandles.has(shape);
  }

  /** Diagnostics: cache entries and owned handles of one slot of a part (default `'main'`). */
  stats(partId: Id, slot: RegenSlot = 'main'): { entries: number; handles: number } | null {
    const pc = this.cache.slotCache(partId, slot);
    if (!pc) return null;
    let handles = 0;
    for (const e of pc.entries.values()) handles += e.owned.length;
    return { entries: pc.entries.size, handles };
  }

  /** Diagnostics: the slots a part holds, `'main'` first, then version slots by recency. */
  slots(partId: Id): RegenSlot[] {
    return [...(this.cache.parts.get(partId)?.values() ?? [])]
      .sort((x, y) => (x.slot === 'main' ? -1 : y.slot === 'main' ? 1 : y.used - x.used))
      .map((pc) => pc.slot);
  }

  // -------------------------------------------------------------------------------------------
  // Regeneration
  // -------------------------------------------------------------------------------------------

  private async regen(request: RegenRequest, slot: RegenSlot): Promise<RegenOutput> {
    const t0 = this.now();
    const { doc, partId } = request;
    const part = doc.parts.find((p) => p.id === partId);
    const pc = this.cache.partCache(partId, slot);
    // A new version slot may push the least recently used one out: free it before allocating.
    if (slot !== 'main') await this.cache.evictSlots(partId);
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
        attachCauses(ctx, f, status, rec);
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
    const density = densityOf(part, doc);
    const wantMass = request.massProperties === true || part.material !== undefined;
    const finalBodies = [...ctx.state.bodies.values()];
    const bodies: BodyResult[] = [];
    for (const b of finalBodies) {
      const out = await bodyResult(this.core, b, request.quality, wantMass, density);
      if (out) bodies.push(out);
    }
    const sketches: SketchResult[] = [];
    for (const s of ctx.state.sketches.values()) {
      sketches.push(await sketchResult(this.core, s, request.quality));
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
        const out = await bodyResult(this.core, g, request.quality, false, undefined);
        if (out) ghosts.push(out);
      }
    }
    pc.latest = { bodies: finalBodies, keys: new Set(ctx.used), partName: part.name };
    if (density !== undefined) pc.latest.density = density;
    await this.cache.evict(pc);
    await this.cache.evictImports(pc, ctx.usedImports);

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
    const rec = walkEntry(ctx, f, evaluated.values, exprErrors, copied);
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
      for (const h of ran.owned) this.core.ownedHandles.add(h);
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
  // Planning per feature type
  // -------------------------------------------------------------------------------------------

  private planFeature(
    ctx: WalkContext,
    f: Feature,
    values: Record<string, number>,
  ): Promise<Planned> {
    switch (f.type) {
      case 'sketch':
        return planSketch(this.core, ctx, f, values);
      case 'extrude':
      case 'revolve':
      case 'primitive':
        return planSolid(this.core, ctx, f, values);
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
        return planSweepLoft(this.core, ctx, f, values);
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
      refKeys[path] = refKeyOf(ctx, t);
      return null;
    };
    for (let i = 0; i < f.edges.length; i++) {
      const t = await resolveSub(
        this.core,
        ctx,
        f.edges[i] as EntityRef,
        `/edges/${i}`,
        unresolved,
      );
      if (t) {
        const e = add(`/edges/${i}`, t);
        if (e) return { unresolved, taint: [t.owner], error: e };
      }
    }
    if (f.type === 'chamfer' && f.mode.kind === 'distanceAngle' && f.mode.face) {
      const t = await resolveSub(this.core, ctx, f.mode.face, '/mode/face', unresolved);
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
            const r = await this.core.exec(f, {
              values,
              target: g.body.shape,
              refs: g.refs,
            });
            if (!r.ok) {
              for (const h of owned) await this.core.releaseHandle(h);
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
    const target = resolveBody(ctx, f.target, '/target', unresolved);
    const tools: BodyState[] = [];
    f.tools.forEach((ref, i) => {
      const b = resolveBody(ctx, ref, `/tools/${i}`, unresolved);
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
          const r = await this.core.exec(f, { values, refs });
          if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
          for (const extra of r.value.bodies ?? []) await this.core.releaseHandle(extra.shape);
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
      const p = await resolvePlane(this.core, ctx, d.from, '/definition/from', unresolved);
      if (p === null) return { unresolved, taint: [] };
      if ('code' in p) return fail(p);
      frames.from = p.frame;
      fromKey = p.shapeKey;
      noteOwner(p.target?.owner);
    } else if (d.kind === 'threePoints') {
      const pts: Vec3[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await resolvePoint(
          this.core,
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
      const p = await resolvePlane(this.core, ctx, d.from, '/definition/from', unresolved);
      const a = await resolveAxis(this.core, ctx, d.axis, '/definition/axis', unresolved, false);
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
      const a = await resolvePlane(this.core, ctx, d.a, '/definition/a', unresolved);
      const b = await resolvePlane(this.core, ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (!a || !b) return { unresolved, taint: [] };
      noteOwner(a.target?.owner);
      noteOwner(b.target?.owner);
      const g = midPlane(a.frame, b.frame);
      if (isGeoError(g)) return geoError(g.error, [d.a, d.b]);
      computed = g;
    } else if (d.kind === 'throughPoint') {
      const p = await resolvePlane(this.core, ctx, d.from, '/definition/from', unresolved);
      const q = await resolvePoint(this.core, ctx, d.point, '/definition/point', unresolved);
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
          const r = await this.core.exec(
            kernelFeature,
            computed ? { values: {} } : { values, frames },
          );
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
    const t = await resolveSub(this.core, ctx, d.curve, '/definition/curve', unresolved);
    let at: Vec3 | null = null;
    if (!('t' in d.at)) {
      const p = await resolvePoint(this.core, ctx, d.at, '/definition/at', unresolved);
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
    const line = await this.core.lineOfEdge(t);
    if (line) {
      const dir = normalize(sub(line.b, line.a));
      const point = at ?? add(line.a, scale(sub(line.b, line.a), values['/definition/at/t'] ?? 0));
      return { frame: normalPlane(point, dir), owner };
    }
    const circle = await this.core.circleOfEdge(t);
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
      const t = await resolveSub(this.core, ctx, ref, `/faces/${i}`, unresolved);
      if (t) {
        refs[`/faces/${i}`] = { shape: t.shape, kind: t.kind, index: t.index };
        refKeys[`/faces/${i}`] = refKeyOf(ctx, t);
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
    const fp = await this.core.fingerprints(body.shape);
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
    if (!groups || groups.length < 2)
      return this.core.exec(f, { target: body.shape, values, refs });

    let shape = body.shape;
    let naming = body.naming;
    const warnings: KernelError[] = [];
    const seen = new Set<string>();
    const release = async (h: ShapeHandle): Promise<void> => {
      if (h !== body.shape) await this.core.kernel.release(h);
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
      const r = await this.core.exec({ ...f, faces }, { target: shape, values, refs: stepRefs });
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
      const a = await resolvePoint(this.core, ctx, d.a, '/definition/a', unresolved);
      const b = await resolvePoint(this.core, ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (a && b) {
        note(a.owner);
        note(b.owner);
        if (dist(a.point, b.point) <= 1e-9) return geoError('The two points coincide', [d.a, d.b]);
        line = { origin: a.point, dir: normalize(sub(b.point, a.point)) };
      }
    } else if (d.kind === 'edge') {
      const t = await resolveSub(this.core, ctx, d.edge, '/definition/edge', unresolved);
      if (t) {
        note(t.owner);
        const l = t.kind === 'edge' ? await this.core.lineOfEdge(t) : null;
        if (!l) return geoError('Pick a straight edge', [d.edge]);
        line = { origin: l.a, dir: normalize(sub(l.b, l.a)) };
      }
    } else if (d.kind === 'cylinder') {
      const a = await resolveAxis(this.core, ctx, d.face, '/definition/face', unresolved, false);
      if (a && 'code' in a) return fail(a);
      if (a) {
        note(a.owner);
        line = a.line;
      }
    } else if (d.kind === 'twoPlanes') {
      const a = await resolvePlane(this.core, ctx, d.a, '/definition/a', unresolved);
      const b = await resolvePlane(this.core, ctx, d.b, '/definition/b', unresolved);
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
      const p = await resolvePoint(this.core, ctx, d.point, '/definition/point', unresolved);
      const pl = await resolvePlane(this.core, ctx, d.plane, '/definition/plane', unresolved);
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
      const p = await resolvePoint(this.core, ctx, d.vertex, '/definition/vertex', unresolved);
      if (p && 'code' in p) return fail(p);
      if (p) {
        note(p.owner);
        point = p.point;
      }
    } else if (d.kind === 'center') {
      const t = await resolveSub(this.core, ctx, d.of, '/definition/of', unresolved);
      if (t) {
        note(t.owner);
        if (t.kind === 'edge') point = (await this.core.circleOfEdge(t))?.centre ?? null;
        else if (t.kind === 'face') {
          point = await this.core.memo(t.shape, `sphere:${t.index}`, () =>
            sphereCentre(this.core.geo(), t.shape, t.index),
          );
        }
        if (!point) return geoError('Pick a circular edge or a spherical face', [d.of]);
      }
    } else if (d.kind === 'alongEdge') {
      const t = await resolveSub(this.core, ctx, d.edge, '/definition/edge', unresolved);
      if (t) {
        note(t.owner);
        const l = t.kind === 'edge' ? await this.core.lineOfEdge(t) : null;
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
      const a = await resolveLineOrPlane(this.core, ctx, d.a, '/definition/a', unresolved);
      const b = await resolveLineOrPlane(this.core, ctx, d.b, '/definition/b', unresolved);
      if (a && 'code' in a) return fail(a);
      if (b && 'code' in b) return fail(b);
      if (a && b) {
        const tol = Math.max(1e-6, 1e-6 * (await partDiag(this.core, ctx)));
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
      const t = await resolveSub(this.core, ctx, ref, path, unresolved);
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
      refKeys[path] = refKeyOf(ctx, t);
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
    const r = await this.core.exec(f, { ...inputs, target: body.shape });
    if (!r.ok) return { result: { ok: false, error: r.error }, owned: [] };
    for (const extra of r.value.bodies ?? []) {
      if (extra.shape !== r.value.shape) await this.core.releaseHandle(extra.shape);
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
      body = resolveBody(ctx, f.body, '/body', unresolved) ?? undefined;
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
    const p = await resolvePlane(this.core, ctx, f.neutral, '/neutral', unresolved);
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
      refKeys['/neutral'] = [p.shapeKey, ...refKeyOf(ctx, p.target).slice(1)];
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
        if (extra.shape !== r.value.shape) await this.core.releaseHandle(extra.shape);
      }
      const tool = { shape: r.value.shape, naming: r.value.naming };
      e = {
        key,
        owned: [tool.shape],
        result: { ok: true, set: [], remove: [], touched: [], tool, warnings: [] },
        lastUsed: ctx.pc.tick,
      };
      this.core.ownedHandles.add(tool.shape);
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
      const p = await resolvePlane(this.core, ctx, f.plane, '/plane', unresolved);
      if (p && 'code' in p) return fail(p);
      if (p) {
        frames.plane = p.frame;
        noteOwner(p.target?.owner);
      }
    } else if (f.type === 'linearPattern') {
      const a = await resolveAxis(this.core, ctx, f.direction, '/direction', unresolved, true);
      if (a && 'code' in a) return fail(a);
      if (a) {
        frames.axis = lineFrame(a.line);
        noteOwner(a.owner);
      }
      if (f.second) {
        const b = await resolveAxis(
          this.core,
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
      const a = await resolveAxis(this.core, ctx, f.axis, '/axis', unresolved, false);
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
        const b = resolveBody(ctx, ref, `/source/bodies/${i}`, unresolved);
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
    const tb = await this.core.massOf(target.shape);
    if (tb) {
      extendBox(box, tb.bbox.min);
      extendBox(box, tb.bbox.max);
    }
    for (const s of profiles) {
      const pb = await this.core.massOf(s);
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
    const r = await this.core.exec(f, all);
    if (!r.ok) return fail(r.error);
    const v = r.value;
    const extras = (v.bodies ?? []).filter((b) => b.shape !== v.shape);
    if (target || (f.source.kind === 'bodies' && f.source.merge)) {
      for (const b of extras) await this.core.releaseHandle(b.shape);
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
      await this.core.releaseHandle(v.shape);
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
    const ft = await resolveSub(this.core, ctx, f.face, '/face', unresolved);
    const points: (Vec3 | null)[] = [];
    for (let i = 0; i < f.points.length; i++) {
      const p = await resolvePoint(
        this.core,
        ctx,
        f.points[i] as EntityRef,
        `/points/${i}`,
        unresolved,
      );
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
      const p = await resolvePlane(this.core, ctx, f.end.target, '/end/target', unresolved);
      if (p && 'code' in p) return fail(p, body ? [body.id] : []);
      if (p?.target) {
        refs['/end/target'] = { shape: p.target.shape, kind: p.target.kind, index: p.target.index };
        refKeys['/end/target'] = refKeyOf(ctx, p.target);
      } else if (p) {
        frames.upTo = p.frame;
        refKeys['/end/target'] = p.shapeKey;
      }
    }
    if (unresolved.length > 0 || !ft || !body) return { unresolved, taint: body ? [body.id] : [] };
    const taint = [body.id];
    const fp = await this.core.fingerprints(ft.shape);
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
    const tol = Math.max(1e-6, 1e-6 * (await partDiag(this.core, ctx)));
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
          build: () => this.core.exec(f, toolInputs),
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
    const t = await resolveSub(this.core, ctx, f.face, '/face', unresolved);
    if (!t) return { unresolved, taint: [] };
    const fp = await this.core.fingerprints(t.shape);
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
    const m = await this.core.kernel.measureShapes({
      shape: t.shape,
      kind: 'face',
      index: t.index,
    });
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
    const key = hashKey({ t: 'thread', def: definition(f), values, face: refKeyOf(ctx, t) });
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
        : scopeBodies(ctx, f.scope, unresolved);
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
      const r = await this.core.kernel.importShapes(
        bytes,
        format === 'brep' ? 'brep' : format === 'iges' ? 'iges' : 'step',
      );
      if (!r.ok) return r;
      raw.shapes = r.value.map((b) => b.shape);
      for (const h of raw.shapes) this.core.ownedHandles.add(h);
      if (raw.shapes.length === 0) {
        return { ok: false, error: kerr('INVALID_INPUT', 'The file contains no solids') };
      }
    }
    if (cached) await this.core.releaseRaw(cached);
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
    const r = await this.core.exec({ ...feature, op: 'new', frame }, { values: {}, shapes });
    if (!r.ok) return r;
    const rank = (key: string) => Number(/^body#(\d+)$/.exec(key)?.[1] ?? Number.NaN);
    const extra = [...(r.value.bodies ?? [])];
    if (extra.some((b) => !Number.isInteger(rank(b.key)))) {
      for (const b of extra) await this.core.releaseHandle(b.shape);
      await this.core.releaseHandle(r.value.shape);
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
      const r = await this.core.kernel.importShapes(
        meshToStl([{ name: 'mesh', mesh: o.mesh }]),
        'stl',
      );
      if (!r.ok) {
        for (const x of out) await this.core.releaseHandle(x.shape);
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
        const fp = await this.core.fingerprints(t.shape);
        if (hasFreeEdges(t.naming, f.id, fp)) open.push(bodyId(k));
      }
    }
    if (open.length > 0) {
      const what =
        open.length === tools.length ? 'The imported file has' : 'Some imported bodies have';
      if (f.op !== 'new') {
        for (const t of tools) await this.core.releaseHandle(t.shape);
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
      for (const t of tools) await this.core.releaseHandle(t.shape);
    };
    let candidates = scoped.bodies;
    if (scoped.mode === 'default' && candidates.length > 0) {
      const tb = emptyBox();
      for (const t of tools) {
        const mp = await this.core.massOf(t.shape);
        if (mp) {
          extendBox(tb, mp.bbox.min);
          extendBox(tb, mp.bbox.max);
        }
      }
      const tol = 1e-6 * Math.max(1, boxDiagonal(tb));
      const kept: BodyState[] = [];
      for (const b of candidates) {
        const bb = await this.core.massOf(b.shape);
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
      return this.core.exec(
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
      for (const extra of r.value.bodies ?? []) await this.core.releaseHandle(extra.shape);
      if (
        f.op === 'cut' &&
        scoped.mode !== 'bodies' &&
        (await sameSolid(this.core, b.shape, r.value.shape))
      ) {
        await this.core.releaseHandle(r.value.shape);
        continue;
      }
      set.push({ id: b.id, shape: r.value.shape, naming: r.value.naming, key: `${key}/${b.id}` });
      owned.push(r.value.shape);
      touched.push(b.id);
      warnings.push(...r.value.warnings);
    }
    await dropTools();
    if (firstError && (scoped.mode === 'bodies' || f.op === 'add' || set.length === 0)) {
      for (const h of owned) await this.core.releaseHandle(h);
      return fail(firstError);
    }
    if (f.op === 'cut' && touched.length === 0) {
      warnings.push(kerr('OPERATION_FAILED', 'The imported shape does not touch any body'));
    }
    return { result: { ok: true, set, remove: [], touched, warnings }, owned };
  }
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

const MESH_FORMATS: ReadonlySet<ImportFeature['source']['format']> = new Set([
  'stl',
  'obj',
  '3mf',
  'glb',
]);

const IDENTITY_FRAME: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
