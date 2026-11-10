/**
 * Public types of the regeneration engine (re-exported by engine.ts and index.ts).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  BodyResult,
  FeatureStatus,
  Fingerprint,
  KernelError,
  MeshBuffers,
  MeshQuality,
  RegenResult,
  ShapeHandle,
  SketchSolveInput,
  SketchSolveResult,
  UnresolvedRef,
} from '@wren-cad/contracts';
import type { KernelApiInternals, KernelWorkerApi } from '../kernel-api';
import type { ProjectionApi, ReprojectLinked } from './linked';

/** The part of `@wren-cad/sketch/core`'s `SketchSolverCore` the engine needs. */
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
  /**
   * Version slots (`version:<id>`, M2.5 compare / merge preview) kept per part beside `'main'`,
   * least recently used first out (its shapes are released). Default 2; at least 1. Each slot
   * has its own result cache bounded by `maxSpareResults`.
   */
  maxVersionSlots?: number;
  /** Viewport mesh deflections per quality (relative to the shape's bbox size). */
  meshQuality?: Partial<
    Record<MeshQuality, { linearDeflection: number; angularDeflection: number }>
  >;
  now?: () => number;
}

export interface RegenEngineDeps {
  /**
   * The kernel worker surface. `projectEdges` / `projectFaceOutline` (M3, kernel engineer) are
   * used for linked sketch entities when present; without them straight edges and circles parallel
   * to the sketch are projected in TypeScript and other sources are an error.
   */
  kernel: KernelWorkerApi & Partial<KernelApiInternals> & Partial<ProjectionApi>;
  /** Lazily loads planegcs (only when a sketch misses the cache). */
  sketchSolver: () => Promise<SketchSolve>;
  /**
   * Re-projects linked sketch entities onto their sources' projections (packages/sketch's
   * `reprojectLinked` once it lands; default `reprojectLinkedFallback`).
   */
  reprojectLinked?: ReprojectLinked;
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
