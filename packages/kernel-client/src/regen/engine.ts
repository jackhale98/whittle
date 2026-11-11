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
 * Cache key of a feature = hash(feature definition without name/suppressed, evaluated values,
 * resolved references as (input content key, kind, index), frames, and the content keys of the
 * bodies it may act on). Content keys chain, so editing feature k changes the keys of k and of
 * every feature that consumes its output, and nothing upstream. Annotations (M4) are part-level
 * and resolved after the walk (annotations.ts): they never enter a feature's key.
 *
 * Failure semantics: a failing (`error` / `needsAttention`) feature is skipped — the state keeps
 * its pre-feature geometry, which therefore stays visible. Its id joins the failed set and the
 * bodies it would have acted on are tainted; a later feature that references the failed feature
 * (by name tag) or acts on / references a tainted body is `blocked` (and propagates the same way).
 *
 * Module map (H1): this file keeps orchestration only, i.e. the public API, the regen walk
 * (`regen`), one feature (`runFeature`) and the per-type dispatch (`planFeature`). Shared services
 * (kernel, sketch solver, per-handle caches) are in core.ts (`EngineCore`, the explicit context the
 * executors take), the feature-result cache in result-cache.ts, internal state in state.ts, public
 * types in types.ts (re-exported here), reference resolution in refs.ts, `AttentionCause`
 * attribution in attribution.ts, body / sketch outputs in outputs.ts, small helpers (errors, the
 * open-surface guard) in helpers.ts and the feature executors in exec-sketch.ts, exec-solids.ts,
 * exec-modify.ts, exec-copies.ts, exec-holes.ts, exec-datums.ts and exec-import.ts.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  AnchorAnswer,
  AnchorQuery,
  AttentionCause,
  BodyResult,
  EntityQuery,
  EntityRef,
  ExportFormat,
  ExportOptions,
  Feature,
  Id,
  KernelError,
  MassProperties,
  Measurement,
  MeasureTarget,
  MeshBuffers,
  MeshQuality,
  RegenRequest,
  RegenSlot,
  Result,
  ShapeForDrawing,
  ShapeHandle,
  SketchResult,
  Vec3,
} from '@wren-cad/contracts';
import { evaluateFeatureValues, featureReferences } from '@wren-cad/document';
import { zipSync } from 'fflate';
import type { MeasureSubject } from '../kernel-api';
import { queryAnchors, resolveAnnotations } from './annotations';
import { attachCauses, fieldLabel, walkDelta, walkEntry } from './attribution';
import { newWalk, pushWalk, type WalkEntry } from './cause';
import { type CompareOutput, type DiffSide, geometricDiff } from './compare';
import { EngineCore } from './core';
import { planCopy } from './exec-copies';
import { planAxis, planPlane, planPoint } from './exec-datums';
import { planHole, planThread } from './exec-holes';
import { planImport } from './exec-import';
import { planBoolean, planDraft, planEdgeOp, planPushPull, planShell } from './exec-modify';
import { planSketch } from './exec-sketch';
import { planSolid, planSweepLoft } from './exec-solids';
import { hashKey } from './hash';
import { allBodiesFor, copiedFeatures, kerr, meshOnlyError } from './helpers';
import { bodyResult, densityOf, referenceResults, sketchResult } from './outputs';
import { absorbedInto, fingerprintOf, rememberAbsorbed } from './refs';
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
  type EntryResult,
  ModelState,
  type PartCache,
  type Planned,
  primaryNaming,
  type WalkContext,
} from './state';
import type {
  ExportResult,
  ImportResult,
  RegenEngineDeps,
  RegenEngineOptions,
  RegenFeatureStatus,
  RegenMemoryStats,
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
  type RegenMemoryStats,
  type RegenOutput,
  type RegenSlotStats,
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
      validSpare(deps.options?.maxSpareResults),
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
      if (spare !== undefined) {
        this.cache.maxSpare = spare;
        this.cache.auto = false;
      }
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
      // What the picked face/edge has absorbed now: later `grown` checks only count names
      // absorbed after the pick (ADR-084 amendment).
      if (fingerprint && query.kind !== 'vertex' && latest?.merged) {
        const pc = this.cache.slotCache(partId, 'main');
        if (pc) {
          rememberAbsorbed(pc, ref, absorbedInto(latest.merged, query.kind, entry.name));
        }
      }
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

  /**
   * M4 (ADR-090 decision 14): the final shape of the latest regen of a part in `slot`, for the
   * drawing worker's HLR. One BREP of the solid and sheet bodies (a compound when there are
   * several, in body order; mesh-only reference bodies have no B-rep and are left out), and the
   * persistent name of every face and edge in `TopExp::MapShapes` order of that BREP: the bodies'
   * own maps concatenated (bodies share no sub-shapes, and the BREP format keeps sub-shape order).
   * Alias entries (ADR-078) are not names here: each sub-shape gets its primary name.
   *
   * `key` hashes the bodies' content keys (equal keys = equal shapes and names; it moves only
   * when the geometry or naming may have, not for annotation or configuration-only edits).
   * `bounds` is the union of the bodies' cheap boxes (ADR-084). The bytes are a fresh buffer the
   * caller transfers.
   */
  shapeForDrawing(partId: Id, slot: RegenSlot = 'main'): Promise<Result<ShapeForDrawing>> {
    return this.serial(async (): Promise<Result<ShapeForDrawing>> => {
      if (!isSlot(slot)) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', `${JSON.stringify(slot)} is not a regen slot`, {
            hint: "Use 'main', 'version:<id>' or 'config:<id>'.",
          }),
        };
      }
      const latest = this.cache.slotCache(partId, slot)?.latest;
      if (!latest) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', `${capitalise(slotLabel(slot))} has not been regenerated`, {
            hint: 'Regenerate the part before drawing it.',
          }),
        };
      }
      const bodies = latest.bodies.filter((b) => !b.meshOnly);
      if (bodies.length === 0) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', 'The part has no solid bodies to draw', {
            hint: 'Mesh reference bodies (STL, OBJ, 3MF, GLB) cannot be drawn.',
          }),
        };
      }
      const faceNames: string[] = [];
      const edgeNames: string[] = [];
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const b of bodies) {
        const bb = await this.core.boundsOf(b.shape);
        if (!bb) {
          return {
            ok: false,
            error: kerr('OPERATION_FAILED', 'The part could not be prepared for the drawing', {
              entityRefs: [b.id],
            }),
          };
        }
        const faces: string[] = Array(bb.faceCount).fill('');
        const edges: string[] = Array(bb.edgeCount).fill('');
        for (const n of primaryNaming(b.naming)) {
          if (n.kind === 'face' && n.index < faces.length) faces[n.index] = n.name;
          else if (n.kind === 'edge' && n.index < edges.length) edges[n.index] = n.name;
        }
        faceNames.push(...faces);
        edgeNames.push(...edges);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k] as number, bb.bbox.min[k] as number);
          max[k] = Math.max(max[k] as number, bb.bbox.max[k] as number);
        }
      }
      const r = await this.core.kernel.exportShapes(
        bodies.map((b) => ({ shape: b.shape, name: b.id })),
        'brep',
      );
      if (!r.ok) return r;
      const file = r.value[0];
      if (!file) return { ok: false, error: kerr('OPERATION_FAILED', 'Writing the BREP failed') };
      return {
        ok: true,
        value: {
          key: hashKey({ t: 'shapeForDrawing', bodies: bodies.map((b) => [b.id, b.key]) }),
          brep: file.bytes,
          edgeNames,
          faceNames,
          bounds: { min, max },
        },
      };
    });
  }

  /**
   * M4 (ADR-092 proposal 2): anchors of arbitrary refs in the latest regen of a part in `slot`,
   * resolved with the annotation rules (`queryAnchors`), one answer per query in order. For
   * dimensions that are not annotations yet (the drawing import's promoted fillet, chamfer and
   * revolve values). Reads the slot, never changes it.
   */
  annotationAnchors(
    partId: Id,
    queries: readonly AnchorQuery[],
    slot: RegenSlot = 'main',
  ): Promise<Result<AnchorAnswer[]>> {
    return this.serial(async (): Promise<Result<AnchorAnswer[]>> => {
      if (!isSlot(slot)) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', `${JSON.stringify(slot)} is not a regen slot`, {
            hint: "Use 'main', 'version:<id>' or 'config:<id>'.",
          }),
        };
      }
      const context = this.cache.slotCache(partId, slot)?.latest?.context;
      if (!context) {
        return {
          ok: false,
          error: kerr('INVALID_INPUT', `${capitalise(slotLabel(slot))} has not been regenerated`, {
            hint: 'Regenerate the part first.',
          }),
        };
      }
      return { ok: true, value: await queryAnchors(this.core, context, queries) };
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

  /**
   * `KernelApi.massProperties` through the engine (ADR-084): serialised with regens, and for
   * shapes the regen cache owns, memoised per handle and density with the mass properties regens
   * compute, so the app's deferred fetch after a regen never integrates a body twice.
   */
  massProperties(shape: ShapeHandle, density?: number): Promise<Result<MassProperties>> {
    return this.serial(async () => {
      const valid = density === undefined || (Number.isFinite(density) && density > 0);
      if (valid && this.core.ownedHandles.has(shape)) {
        const mp = await this.core.massOf(shape, density);
        if (mp) return { ok: true, value: mp };
      }
      return this.core.kernel.massProperties(shape, density);
    });
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

  /**
   * Memory guard (PLAN H1): cache entries and owned shape handles of every part and slot, the
   * per-handle caches and the configured bounds. Stable diagnostics surface: `ownedHandles` must
   * equal `handles` plus every slot's `importHandles`, and all of them drop to 0 once every part
   * is closed (`closePart`). Engine-side only; the façade's live handles and Wasm heap are added by
   * `ModelingApiInternals.memoryStats`.
   */
  memoryStats(): RegenMemoryStats {
    return { ...this.cache.memoryStats(), shapeCaches: this.core.shapeCacheStats() };
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
      current: { featureId: '', rebound: [], merged: [], grown: [] },
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
    const prevWalk = pc.walk;
    pc.walk = ctx.walk;

    // Outputs.
    const density = densityOf(part, doc);
    // Contract (ADR-084): omitted = the part has a material; `false` skips them even then.
    const wantMass = request.massProperties ?? part.material !== undefined;
    const finalBodies = [...ctx.state.bodies.values()];
    const bodies: BodyResult[] = [];
    for (const b of finalBodies) {
      const out = await bodyResult(this.core, b, request.quality, wantMass, density);
      if (out) bodies.push(out);
    }
    const references = await referenceResults(this.core, part, ctx.state, finalBodies);
    const sketches: SketchResult[] = [];
    for (const s of ctx.state.sketches.values()) {
      sketches.push(await sketchResult(this.core, s, request.quality));
    }
    // M4 (ADR-090): annotations after the last feature, against the final state, only when asked
    // (the contract's default: the part has annotations). Before eviction, so the previous
    // regen's shapes are still live for `lastKnown`.
    const wantAnnotations = request.annotations ?? (part.annotations?.length ?? 0) > 0;
    const annotations = wantAnnotations
      ? await resolveAnnotations(this.core, ctx, prevWalk)
      : undefined;

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
    pc.latest = {
      bodies: finalBodies,
      keys: new Set(ctx.used),
      partName: part.name,
      merged: ctx.state.merged,
      // For anchor queries against this final state (ADR-092 proposal 2); no attachment bytes.
      context: { ...ctx, attachments: {}, rec: null },
    };
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
    if (references.length > 0) result.references = references;
    if (annotations) result.annotations = annotations;
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // One feature
  // -------------------------------------------------------------------------------------------

  private async runFeature(ctx: WalkContext, f: Feature): Promise<RegenFeatureStatus> {
    ctx.current = { featureId: f.id, rebound: [], merged: [], grown: [] };
    const status = (
      state: RegenFeatureStatus['state'],
      extra: Partial<RegenFeatureStatus> = {},
    ) => {
      const s = { featureId: f.id, state, cached: false, ms: 0, ...extra } as RegenFeatureStatus;
      if (ctx.current.rebound.length > 0) s.rebound = ctx.current.rebound;
      if (ctx.current.merged.length > 0) s.merged = ctx.current.merged;
      if (ctx.current.grown.length > 0) s.grown = ctx.current.grown;
      return s;
    };
    const fail = (taint: string[]) => {
      ctx.failed.add(f.id);
      for (const b of taint) if (!ctx.tainted.has(b)) ctx.tainted.set(b, f.id);
    };
    const allBodies = () => [...ctx.state.bodies.keys()];
    const evaluated = evaluateFeatureValues(f, ctx.doc);
    const exprErrors = Object.entries(evaluated.errors);
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
        return planEdgeOp(this.core, ctx, f, values);
      case 'boolean':
        return planBoolean(this.core, ctx, f, values);
      case 'plane':
        return planPlane(this.core, ctx, f, values);
      case 'pushPull':
        return planPushPull(this.core, ctx, f, values);
      case 'import':
        return planImport(this.core, ctx, f);
      case 'axis':
        return planAxis(this.core, ctx, f, values);
      case 'point':
        return planPoint(this.core, ctx, f, values);
      case 'shell':
        return planShell(this.core, ctx, f, values);
      case 'draft':
        return planDraft(this.core, ctx, f, values);
      case 'sweep':
      case 'loft':
        return planSweepLoft(this.core, ctx, f, values);
      case 'mirror':
      case 'linearPattern':
      case 'circularPattern':
        return planCopy(this.core, ctx, f, values);
      case 'hole':
        return planHole(this.core, ctx, f, values);
      case 'thread':
        return planThread(this.core, ctx, f, values);
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
}
