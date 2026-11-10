/**
 * Internal state of the regeneration engine: the model state while walking a part
 * (bodies, sketches, planes, datums, tool solids), feature-result cache entries and the
 * per-regen walk context shared by the feature executors (exec-*.ts).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  FeatureResult,
  Frame,
  Id,
  ImportFeature,
  KernelError,
  MeshBuffers,
  NamingMap,
  Part,
  RegenSlot,
  Result,
  ShapeHandle,
  SketchEntity,
  UnresolvedRef,
  WrenDoc,
} from '@wren-cad/contracts';
import type { Walk, WalkEntry } from './cause';
import type { SubKind } from './resolve';
import type { MergedRef, ReboundRef } from './types';

export interface BodyState {
  id: string;
  shape: ShapeHandle;
  naming: NamingMap;
  /** Content key (changes iff the geometry/naming may have changed). */
  key: string;
  /** A mesh-only reference body (STL/OBJ/3MF/GLB import): displayed and exported, never modified. */
  meshOnly?: boolean;
}

/** An attachment read once and cached by sha256 (unplaced, unnamed kernel shapes or meshes). */
export interface RawImport {
  sha: string;
  format: ImportFeature['source']['format'];
  /**
   * B-rep bodies in file order (owned by the import cache), unplaced and unnamed: solids, and
   * for IGES also the sewn open shells or loose faces.
   */
  shapes: ShapeHandle[];
  /** Mesh formats: one mesh per object in the file (TS-side; placed and handed to the kernel per use). */
  meshes: MeshBuffers[];
  lastUsed: number;
}

export interface SketchState {
  id: Id;
  shape: ShapeHandle;
  naming: NamingMap;
  frame: Frame;
  regions: string[];
  entities: SketchEntity[];
  key: string;
}

export interface PlaneState {
  id: Id;
  shape: ShapeHandle;
  naming: NamingMap;
  frame: Frame;
  key: string;
}

/** A construction axis or point (M3): pure geometry, no kernel shape. */
export interface DatumState {
  id: Id;
  kind: 'axis' | 'point';
  /** Axis: origin on the line, z = direction (`lineFrame`). Point: origin = the point. */
  frame: Frame;
  key: string;
}

/**
 * How to get the tool solid of a solid feature (extrude, revolve, sweep, loft, primitive, hole)
 * before its boolean, for mirror / pattern copies (ADR-019 item 4). The tool is built lazily — only
 * when a copy feature asks for it — and cached as its own entry under `key`, which hashes the
 * tool's own inputs (definition without op/scope, values, refs as content keys, frames) but not
 * the bodies it is applied to: editing an unrelated part of the body doesn't rebuild the tool.
 */
export interface ToolSpec {
  featureId: Id;
  key: string;
  /** values["/ops/<id>"]: 0 add, 1 cut, 2 intersect (`new` copies are added to its body). */
  op: 0 | 1 | 2;
  /**
   * Builds the tool. `depth` is given for through-all extrudes only (`throughAll` below): the
   * kernel refuses `throughAll` without a body to size it by, so their tool is the same extrude
   * made blind, `depth` long, in the same direction (normal, reverse or symmetric).
   */
  build: (depth?: number) => Promise<Result<FeatureResult>>;
  /**
   * Through-all extrudes: the shapes their profile regions live on. A copy sizes the blind tool
   * from these, its target body and how far the copies move (`throughAllDepth`).
   */
  throughAll?: ShapeHandle[];
  /** Bodies the feature produced or changed (set when the feature ran ok). */
  bodies: string[];
}

export type EntryResult =
  | {
      ok: true;
      set: BodyState[];
      remove: string[];
      /** Bodies the feature actually changed or consumed (for taint checks on cache hits). */
      touched: string[];
      sketch?: SketchState;
      plane?: PlaneState;
      datum?: DatumState;
      /** Tool entries (see `ToolSpec`): the cached tool solid. */
      tool?: { shape: ShapeHandle; naming: NamingMap };
      warnings: KernelError[];
    }
  | { ok: false; error: KernelError };

export interface CacheEntry {
  key: string;
  owned: ShapeHandle[];
  result: EntryResult;
  lastUsed: number;
}

/** One regeneration of a part (`'main'` or a version slot): its own cache and latest state. */
export interface PartCache {
  slot: RegenSlot;
  /** Engine-wide LRU stamp among slots (regen and compare touch it). */
  used: number;
  entries: Map<string, CacheEntry>;
  revision: number;
  tick: number;
  latest: {
    bodies: BodyState[];
    keys: Set<string>;
    partName: string;
    /** kg/mm³ of the part material at that regen, if any. */
    density?: number;
  } | null;
  lastGood: { bodies: BodyState[]; keys: Set<string> } | null;
  /** Imported attachments by sha256. */
  imports: Map<string, RawImport>;
  /**
   * Where each `(featureId|path)` ref resolved last (for `lastKnown`). The shape is one of the
   * previous regen's, which stays live until the current regen ends; the fingerprint is computed
   * only when needed.
   */
  lastResolved: Map<string, { shape: ShapeHandle; kind: SubKind; index: number }>;
  /** The previous regen's walk (cause.ts), for `AttentionCause`. */
  walk: Walk | null;
}

export class ModelState {
  bodies = new Map<string, BodyState>();
  sketches = new Map<Id, SketchState>();
  planes = new Map<Id, PlaneState>();
  datums = new Map<Id, DatumState>();
  /** Tool solids of the solid features evaluated so far (by feature id), for copies. */
  tools = new Map<Id, ToolSpec>();
  /**
   * Names a boolean merged away (ADR-076), `${kind}|${absorbed}` → the name of the sub-shape that
   * absorbed it, gathered from the alias entries of every body naming map seen in this walk (the
   * kernel lists them only on the merging feature's result, so later features need this table).
   */
  merged = new Map<string, string>();
  version = 0;

  apply(r: Extract<EntryResult, { ok: true }>): void {
    for (const id of r.remove) this.bodies.delete(id);
    for (const b of r.set) {
      this.bodies.set(b.id, b);
      recordMerges(this.merged, b.naming);
    }
    if (r.sketch) this.sketches.set(r.sketch.id, r.sketch);
    if (r.plane) this.planes.set(r.plane.id, r.plane);
    if (r.datum) this.datums.set(r.datum.id, r.datum);
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

/**
 * The primary entries of a body naming map: the first name per (kind, index). Later entries for
 * the same sub-shape are merge aliases (packages/kernel whittle_unify.cpp): names a boolean
 * absorbed into that sub-shape.
 */
export function primaryNaming(naming: NamingMap): NamingMap {
  const cached = primaryCache.get(naming);
  if (cached) return cached;
  const seen = new Set<string>();
  let aliases = false;
  const out: NamingMap = [];
  for (const n of naming) {
    const k = `${n.kind}|${n.index}`;
    if (seen.has(k)) {
      aliases = true;
      continue;
    }
    seen.add(k);
    out.push(n);
  }
  const value = aliases ? out : naming;
  primaryCache.set(naming, value);
  return value;
}

const primaryCache = new WeakMap<NamingMap, NamingMap>();

/** Adds a body naming map's merge aliases to `merged` (see `ModelState.merged`). */
export function recordMerges(merged: Map<string, string>, naming: NamingMap): void {
  if (primaryNaming(naming) === naming) return;
  const primary = new Map<string, string>();
  for (const n of naming) {
    const k = `${n.kind}|${n.index}`;
    const p = primary.get(k);
    if (p === undefined) primary.set(k, n.name);
    else if (p !== n.name) merged.set(`${n.kind}|${n.name}`, p);
  }
}

/** The names `name` was merged into, nearest first (a survivor may be merged again later). */
export function mergeChain(state: ModelState, kind: SubKind, name: string): string[] {
  const out: string[] = [];
  let n = name;
  for (let i = 0; i < 16; i++) {
    const next = state.merged.get(`${kind}|${n}`);
    if (next === undefined || next === name || out.includes(next)) break;
    out.push(next);
    n = next;
  }
  return out;
}

export interface WalkContext {
  doc: WrenDoc;
  part: Part;
  pc: PartCache;
  state: ModelState;
  failed: Set<Id>;
  /** Tainted body → the feature that failed on it first (what later features wait on). */
  tainted: Map<string, Id>;
  used: Set<string>;
  hits: number;
  misses: number;
  diag: { version: number; value: number } | null;
  attachments: Record<string, Uint8Array>;
  /** Ids of the part's import features (their names are geometric-key names: weak evidence). */
  importIds: Set<Id>;
  /** Imports used by this regen (sha256). */
  usedImports: Set<string>;
  /** The feature being planned: id, the refs rebound so far and those resolved through a merge. */
  current: { featureId: Id; rebound: ReboundRef[]; merged: MergedRef[] };
  /** This regen's walk (cause.ts) and the walk entry of the feature being run. */
  walk: Walk;
  rec: WalkEntry | null;
  /** Position of every feature in `part.features`. */
  index: Map<Id, number>;
  /** Body id → the feature whose result last set it. */
  bodyOwner: Map<string, Id>;
}

/** What a feature needs once its references are resolved. */
interface Plan {
  key: string;
  /** Bodies the feature reads or acts on (taint check before running). */
  involved: string[];
  /**
   * Further bodies whose content keys are part of `key` (an implicit scope's candidates), for
   * the cause walk's dependencies (cause.ts); not taint-checked.
   */
  reads?: string[];
  /** `transient`: the outcome depends on something outside the key (attachments): don't cache it. */
  run: () => Promise<{ result: EntryResult; owned: ShapeHandle[]; transient?: boolean }>;
  /** Solid features: how to build their tool solid for copies (registered when the feature is ok). */
  tool?: Omit<ToolSpec, 'bodies'>;
}

export interface Planned {
  plan?: Plan;
  unresolved: UnresolvedRef[];
  /** Bodies to taint if the feature fails. */
  taint: string[];
  /** An error detected while planning (e.g. a non-planar sketch face). */
  error?: KernelError;
  /** Needs attention: extra names to highlight (linked sketch entities whose source is lost). */
  attention?: string[];
  /** Planning-time warnings (e.g. ignored pattern skips), added to an ok status. */
  warnings?: KernelError[];
}
