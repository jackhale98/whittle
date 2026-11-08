/**
 * Parametric regeneration API (PLAN §4, §7.3). Lead-owned contract, implemented by
 * packages/kernel-client (regen engine runs **inside the kernel worker**, next to the shapes).
 *
 * Regeneration is incremental: each feature's result is cached by hash(feature definition,
 * resolved values, input result hashes). Editing feature k re-runs k…n only.
 */

import type { EntityRef, Id, Vec3, WhittleDoc } from './document';
import type {
  KernelApi,
  KernelError,
  MassProperties,
  MeshBuffers,
  Result,
  ShapeFingerprints,
  ShapeHandle,
} from './kernel';

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
}

export interface FeatureStatus {
  featureId: Id;
  state: FeatureState;
  error?: KernelError;
  unresolved?: UnresolvedRef[];
  /** Served from the result cache. */
  cached: boolean;
  ms: number;
}

/** A solid (or sheet) body in the part's final state. */
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
  /** Closed regions usable as profiles: persistent name + triangulated fill for picking. */
  regions: { name: string; mesh: MeshBuffers }[];
  /** Sketch plane frame (mm). */
  frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 };
}

export interface RegenRequest {
  doc: WhittleDoc;
  partId: Id;
  quality: MeshQuality;
  /** Compute mass properties for every body (always on when the part has a material). */
  massProperties?: boolean;
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
  /** STL: binary (default) or ASCII; deflection in mm. */
  stlBinary?: boolean;
  linearDeflection?: number;
}

/** The kernel worker's full Comlink surface from M1 on. */
export interface ModelingApi extends KernelApi {
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
  /** Drops cached results and shapes for a part (document closed). */
  closePart(partId: Id): Promise<void>;
}
