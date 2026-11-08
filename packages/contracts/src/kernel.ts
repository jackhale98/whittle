/**
 * Kernel API (PLAN §4, §7). Lead-owned.
 *
 * Two layers share these types:
 *  1. The C++ façade compiled into the Wasm module (packages/kernel). It exchanges JSON strings and
 *     typed arrays; `packages/kernel/src/whittle_kernel.h` is its normative header.
 *  2. `KernelApi`, the Comlink surface exposed by the kernel worker (packages/kernel-client). The
 *     main thread only ever talks to this; it never touches Wasm (golden rule).
 *
 * Every call returns `Result<T>`; OCCT exceptions are caught at the C++ boundary and surfaced as
 * `KernelError`. A failing call must never crash or poison the worker.
 */

import type { Feature, Vec3 } from './document';
import type { NamingMap } from './naming';

/** Integer handle into the worker's shape cache. `0` is never a valid handle. */
export type ShapeHandle = number;

export type KernelErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FEATURE'
  | 'OCCT_EXCEPTION'
  | 'OPERATION_FAILED'
  | 'INVALID_HANDLE'
  | 'UNRESOLVED_REFERENCE'
  | 'NOT_INITIALISED'
  | 'INTERNAL';

export interface KernelError {
  code: KernelErrorCode;
  /** Human-readable, user-facing message (PLAN §1 "Forgiving"). */
  message: string;
  /** Suggested fix, e.g. "Reduce the radius below 2.4 mm". */
  hint?: string;
  /** Persistent names of entities implicated in the failure (for highlighting). */
  entityRefs?: string[];
  /** Raw diagnostic (OCCT exception text etc.). Not shown to users by default. */
  detail?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: KernelError };

export type KernelVariant = 'threaded' | 'single';

export interface KernelInfo {
  variant: KernelVariant;
  /** e.g. `"8.0.1"`. */
  occtVersion: string;
  /** Façade build id (content hash of façade sources + toolchain config). */
  buildId: string;
  /** Wall time from `init()` call to ready, ms. */
  initMs: number;
}

export interface KernelInitOptions {
  /** Force a variant; default picks `threaded` iff `crossOriginIsolated`. */
  variant?: KernelVariant;
  /** Absolute/relative URL of the `.wasm` (bundlers relocate assets). */
  wasmUrl?: string;
  /** Pthread pool size for the threaded build. */
  threads?: number;
}

/**
 * Inputs for one feature evaluation: resolved upstream shapes and resolved parameter values.
 * Expressions are evaluated by packages/document before reaching the kernel; the kernel sees
 * numbers in millimetres and radians only.
 */
export interface FeatureInputs {
  /** Body the feature operates on (for op add/cut/intersect, fillet, etc.). */
  target?: ShapeHandle;
  /** Additional input shapes keyed by role (e.g. tool bodies). */
  shapes?: Record<string, ShapeHandle>;
  /** Resolved numeric values for every Expr in the feature, keyed by JSON pointer into the feature (e.g. `"/dx"`). Millimetres / radians. */
  values: Record<string, number>;
}

export interface FeatureResult {
  shape: ShapeHandle;
  naming: NamingMap;
  /** Non-fatal warnings (e.g. "fillet used fallback algorithm"). */
  warnings: KernelError[];
}

export interface MeshOptions {
  /** Linear deflection, mm. Coarse ≈ 0.5, fine ≈ 0.05 (scaled by bbox in practice). */
  linearDeflection: number;
  /** Angular deflection, radians. */
  angularDeflection: number;
  /** Treat linearDeflection as relative to the shape's bbox size. */
  relative?: boolean;
}

/**
 * Render buffers for one shape. All arrays are transferred (never copied) across the worker
 * boundary. Index spaces:
 *  - Triangle `t` belongs to B-rep face `f` iff faceRanges[2f] <= t < faceRanges[2f] + faceRanges[2f+1].
 *  - Edge polyline `e` covers points edgeRanges[2e] … edgeRanges[2e] + edgeRanges[2e+1] - 1 of edgePositions.
 *  - Face/edge ordinal `i` corresponds to `faceNames[i]` / `edgeNames[i]` (persistent names; may be
 *    empty string if the façade could not name it) and to TopExp map index `i` of the shape.
 */
export interface MeshBuffers {
  /** xyz triplets, mm. */
  positions: Float32Array;
  /** xyz triplets, unit length, per vertex. */
  normals: Float32Array;
  /** Triangle vertex indices into positions/3. */
  indices: Uint32Array;
  /** [firstTriangle, triangleCount] pairs, one per B-rep face. */
  faceRanges: Uint32Array;
  /** xyz triplets of all edge polyline points, concatenated. */
  edgePositions: Float32Array;
  /** [firstPoint, pointCount] pairs, one per B-rep edge. */
  edgeRanges: Uint32Array;
  faceNames: string[];
  edgeNames: string[];
  bbox: { min: Vec3; max: Vec3 };
}

/** Geometric measurements on a shape (M0: volume/area/bbox; extended in M1/M3). */
export interface MassProperties {
  /** mm³. */
  volume: number;
  /** mm². */
  area: number;
  /** Centre of volume, mm. Equals the centre of mass for a homogeneous part. */
  centroid: Vec3;
  /**
   * Present when a density was supplied (kg/mm³ after unit resolution by packages/document):
   * mass in kg and the inertia tensor about the centroid in kg·mm², row-major 3×3.
   */
  mass?: number;
  inertia?: [number, number, number, number, number, number, number, number, number];
  bbox: { min: Vec3; max: Vec3 };
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
}

/** Comlink surface of the kernel worker. */
export interface KernelApi {
  init(options?: KernelInitOptions): Promise<Result<KernelInfo>>;
  execFeature(feature: Feature, inputs: FeatureInputs): Promise<Result<FeatureResult>>;
  mesh(shape: ShapeHandle, options: MeshOptions): Promise<Result<MeshBuffers>>;
  /** `density` in kg/mm³ (resolved from the part's Material); omit for geometry-only results. */
  massProperties(shape: ShapeHandle, density?: number): Promise<Result<MassProperties>>;
  release(shape: ShapeHandle): Promise<void>;
}

/** Lifecycle of the kernel as seen by the UI (status chip, PLAN §9.1). */
export type KernelStatus =
  | { state: 'idle' }
  | { state: 'downloading'; loaded: number; total?: number }
  | { state: 'compiling' }
  | { state: 'ready'; info: KernelInfo }
  | { state: 'error'; error: KernelError };
