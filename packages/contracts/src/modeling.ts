/**
 * Parametric regeneration API (PLAN §4, §7.3). Lead-owned contract, implemented by
 * packages/kernel-client (regen engine runs **inside the kernel worker**, next to the shapes).
 *
 * Regeneration is incremental: each feature's result is cached by hash(feature definition,
 * resolved values, input result hashes). Editing feature k re-runs k…n only.
 */

import type { EntityRef, Fingerprint, Id, Vec3, WrenDoc } from './document';
import type {
  KernelApi,
  KernelError,
  MassProperties,
  Measurement,
  MeasureTarget,
  MeshBuffers,
  Result,
  ShapeFingerprints,
  ShapeHandle,
} from './kernel';
import type { SketchEntity } from './sketch';
import type { GeometricDiff, RegenSlot } from './sync';

export type MeshQuality = 'coarse' | 'fine';

export type FeatureState =
  /** Evaluated successfully. */
  | 'ok'
  /** Evaluation failed; last good geometry stays visible as a ghost (PLAN §9.2). */
  | 'error'
  /** A reference could not be resolved unambiguously; never silently guessed (PLAN §7.3). */
  | 'needsAttention'
  | 'suppressed'
  /** After the rollback bar. */
  | 'rolledBack'
  /** Not evaluated because an upstream feature it depends on failed. */
  | 'blocked';

export interface UnresolvedRef {
  /** JSON pointer into the feature, e.g. `/edges/2`. */
  path: string;
  ref: EntityRef;
  reason: 'missing' | 'ambiguous';
  /** Candidate names when ambiguous (for the "Which one?" chooser). */
  candidates?: string[];
  /** Previous resolved location when the stored ref had no fingerprint (ghost the old spot). */
  lastKnown?: Fingerprint;
  /** M3.5. The upstream change that made this ref missing or ambiguous, when it can be named. */
  cause?: AttentionCause;
}

/**
 * M3.5 (PLAN §7.3, research report "errors far from their cause"): which upstream feature's change
 * broke a reference or a feature, so the UI can name and select it ("Fillet 2 lost its edge because
 * Extrude 1 changed"). Only reported when the engine can tell; never a guess.
 */
export interface AttentionCause {
  /** The upstream feature whose output no longer contains the entity, or that failed or vanished. */
  featureId: Id;
  /**
   * `changed`: its inputs or values changed this regen and the entity is gone from its output;
   * `suppressed` / `deleted` / `reordered`: the feature that produced the entity is suppressed,
   * deleted or now after the consumer; `failed`: it errored, so its output is missing.
   */
  kind: 'changed' | 'suppressed' | 'deleted' | 'reordered' | 'failed';
  /** Optional human detail, e.g. which parameter changed ("depth 10 → 4 mm"). */
  detail?: string;
}

export interface FeatureStatus {
  featureId: Id;
  state: FeatureState;
  error?: KernelError;
  unresolved?: UnresolvedRef[];
  /** Served from the result cache. */
  cached: boolean;
  /** Non-fatal warnings (e.g. "The cut does not touch any body"). */
  warnings?: KernelError[];
  /** M3.5. For `error`/`blocked`/`needsAttention`: the upstream cause when it can be named. */
  cause?: AttentionCause;
  /** Refs resolved by fingerprint/disambiguation, with their current name, so the UI can heal stored refs. */
  rebound?: { path: string; name: string; fingerprint?: Fingerprint }[];
  ms: number;
}

/** A solid (or sheet) body in the part's final state. Its `shape` is owned by the regen engine: never `release()` it. */
export interface BodyResult {
  /** Stable body id: `B{featureId}` of the feature that created it (persistent across regens). */
  id: string;
  shape: ShapeHandle;
  mesh: MeshBuffers;
  /** Present when the part has a material (density) or on request. */
  massProperties?: MassProperties;
}

/** Sketch output for display/picking: polylines per sketch entity and the detected regions. */
export interface SketchResult {
  featureId: Id;
  /** World-space polylines, one per sketch entity id. */
  curves: { entity: Id; points: Float32Array; construction: boolean }[];
  /** Sketch points (world space), drawn as dots and picked as `sketchPoint`. */
  points?: { entity: Id; at: Vec3; construction: boolean }[];
  /** Closed regions usable as profiles: persistent name + triangulated fill for picking. */
  regions: { name: string; mesh: MeshBuffers }[];
  /** Solved entities (sketch-local), so the UI can write positions back as the next initial guess. */
  entities?: SketchEntity[];
  /** Sketch plane frame (mm). */
  frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 };
}

export interface RegenRequest {
  doc: WrenDoc;
  partId: Id;
  /**
   * Attachment bytes referenced by features (ImportFeature.source.path → bytes). Only needed the
   * first time a path/sha is seen; the engine caches imported shapes by sha256.
   */
  attachments?: Record<string, Uint8Array>;
  quality: MeshQuality;
  /** Compute mass properties for every body (always on when the part has a material). */
  massProperties?: boolean;
  /**
   * M2.5: which regeneration this is. `'main'` (default) is the live model; `version:<id>` holds
   * another version beside it (compare, merge preview) with its own cache and latest state.
   */
  slot?: RegenSlot;
}

export interface RegenResult {
  partId: Id;
  /** Monotonic per part; lets the UI drop stale results. */
  revision: number;
  features: FeatureStatus[];
  bodies: BodyResult[];
  sketches: SketchResult[];
  totalMs: number;
  cache: { hits: number; misses: number };
  /** Last all-ok geometry of bodies that differ now while some feature fails (PLAN §9.2 ghost). */
  ghosts?: BodyResult[];
}

/** Answers "what is under the cursor" in persistent terms for selection → EntityRef. */
export interface EntityQuery {
  bodyId: string;
  kind: 'face' | 'edge' | 'vertex';
  /** Ordinal within the body's mesh face/edge ranges (from picking). */
  index: number;
}

export type ExportFormat = 'step' | 'stl' | 'brep';

export interface ExportOptions {
  /** STEP schema; AP214 in M1, AP242 + PMI in M5. */
  stepSchema?: 'AP203' | 'AP214' | 'AP242';
  /** Export only these bodies (BodyResult ids); default all visible bodies of the part. */
  bodies?: string[];
  /** STL: binary (default) or ASCII. Units are always millimetres. */
  stlBinary?: boolean;
  /** STL: one file per body (zip) instead of one merged file. */
  stlPerBody?: boolean;
  /**
   * STL tessellation quality. UI presets: coarse (0.1 mm, 0.5 rad), standard (0.02 mm, 0.25 rad),
   * fine (0.005 mm, 0.1 rad) — chord deviation in mm and angle in radians, independent of the
   * viewport meshing.
   */
  linearDeflection?: number;
  angularDeflection?: number;
}

/** The kernel worker's full Comlink surface from M1 on. */
export interface ModelingApi extends KernelApi {
  /** Per-part cache bound (device tiers pass smaller values). */
  configureRegen(options: {
    maxSpareResults?: number;
    /** M2.5: version slots kept per part besides `'main'` (LRU; default 2). */
    maxVersionSlots?: number;
  }): Promise<void>;
  fingerprints(shape: ShapeHandle): Promise<Result<ShapeFingerprints>>;
  regenerate(request: RegenRequest): Promise<RegenResult>;
  /** Persistent reference (with fingerprint) for a picked sub-shape of the latest regen. */
  refFor(partId: Id, query: EntityQuery): Promise<EntityRef | null>;
  /** Exports bodies of the latest regen of a part. Bytes are transferred. */
  exportPart(
    partId: Id,
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: KernelError }>;
  /** Imports a STEP/BREP/STL file as reference bodies (M1: STEP → solids). */
  importFile(
    bytes: Uint8Array,
    format: ExportFormat,
  ): Promise<
    | { ok: true; bodies: { shape: ShapeHandle; mesh: MeshBuffers; name?: string }[] }
    | { ok: false; error: KernelError }
  >;
  /** Drops cached results and shapes for a part (document closed); one slot, or all of them. */
  closePart(partId: Id, slot?: RegenSlot): Promise<void>;
  /** M2: exact measurement on the latest regen of a part (bodies by BodyResult id). */
  measure(partId: Id, a: MeasureTarget, b?: MeasureTarget): Promise<Result<Measurement>>;
  /**
   * M2.5: geometric compare of the latest regens of a part in two slots (PLAN §8A.3): boolean
   * differences B − A and A − B, meshed at `quality`, plus mass and bounding box of each side.
   */
  compare(
    partId: Id,
    a: RegenSlot,
    b: RegenSlot,
    quality: MeshQuality,
  ): Promise<Result<GeometricDiff>>;
}
