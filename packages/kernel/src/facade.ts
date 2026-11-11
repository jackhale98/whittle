/**
 * Typed JS surface of the Emscripten module built from src/whittle_bindings.cpp.
 *
 * The toolchain does not generate declarations for `scope: 'main'` (raw embind) bindings, so this
 * file is the hand-maintained counterpart of the EMSCRIPTEN_BINDINGS block. Every structured
 * value crosses the boundary as a JSON string shaped like packages/contracts/src/kernel.ts.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Frame, Vec2 } from '@wren-cad/contracts';

/** Owned render buffers (C++ `whittle::MeshData`). Must be `delete()`d. */
export interface MeshDataHandle {
  /** Views alias the Wasm heap: copy them (e.g. `.slice()`) before the next kernel call. */
  positions(): Float32Array;
  normals(): Float32Array;
  indices(): Uint32Array;
  faceRanges(): Uint32Array;
  edgePositions(): Float32Array;
  edgeRanges(): Uint32Array;
  /** `{"faceNames":[...],"edgeNames":[...],"bbox":{"min":[..],"max":[..]}}` */
  metaJson(): string;
  delete(): void;
}

/** The façade functions registered on the module (see whittle_kernel.h). */
export interface WhittleKernelModule {
  /** `Result<{occtVersion, buildId, threads}>` JSON. */
  kernelInfo(): string;
  /** `Result<FeatureResult>` JSON. */
  execFeature(featureJson: string, inputsJson: string): string;
  /** `Result<{}>` JSON; buffers land in `out`. */
  mesh(shape: number, optionsJson: string, out: MeshDataHandle): string;
  /**
   * `Result<MassProperties>` JSON. `densityKgPerMm3` > 0 adds `mass` and `inertia` (ADR-004);
   * pass 0 for geometry only.
   */
  massProperties(shape: number, densityKgPerMm3: number): string;
  /** `Result<ShapeFingerprints>` JSON (TopExp order). */
  fingerprints(shape: number): string;
  /**
   * `Result<ShapeBounds>` JSON: massProperties' bbox and topology counts without integrating
   * anything (ADR-084). Optional: builds before it lack it (callers fall back to massProperties).
   */
  bounds?(shape: number): string;
  /**
   * Writes `format` (`step` | `stl` | `brep`) to MEMFS. `shapesJson`: `ExportShape[]`;
   * `optionsJson`: contracts `ExportOptions`. Returns `Result<RawExportResult>` JSON; the caller
   * reads every file with `FS.readFile` and unlinks it.
   */
  exportShapes(shapesJson: string, format: string, optionsJson: string): string;
  /**
   * Reads a MEMFS file (`step` | `iges` | `stl` | `brep`). Returns `Result<RawImportResult>`
   * JSON.
   */
  importFile(path: string, format: string): string;
  /**
   * Exact B-rep measurement. `queryJson`: `MeasureQuery`. Returns `Result<Measurement>` JSON
   * (contracts kernel.ts).
   */
  measure(queryJson: string): string;
  /**
   * M3 "convert entities": `queryJson` is a `ProjectEdgesQuery`. Returns
   * `Result<ProjectedEdge[]>` JSON (`Result<ExactProjectedEdge[]>` with `exact: true`, M3.5).
   */
  projectEdges(queryJson: string): string;
  /**
   * M3: `queryJson` is a `ProjectFaceOutlineQuery`. Returns `Result<ProjectedOutline>` JSON (with
   * `exact: true`, M3.5, its edges are `ExactProjectedEdge`s).
   */
  projectFaceOutline(queryJson: string): string;
  /** Threaded build: caps OCCT's thread pool. Returns `Result<{threads, max}>` JSON. */
  configureThreads(count: number): string;
  release(shape: number): void;
  liveHandleCount(): number;
  MeshData: new () => MeshDataHandle;
  /** Live linear memory (exported for heap diagnostics). */
  wasmMemory: WebAssembly.Memory;
  /** Emscripten MEMFS, used to move export/import bytes. */
  FS: KernelFileSystem;
}

/** The subset of Emscripten's `FS` the worker uses. */
export interface KernelFileSystem {
  readFile(path: string, options?: { encoding: 'binary' }): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}

/** One body handed to `exportShapes`. */
export interface ExportShape {
  shape: number;
  name: string;
  /** CSS hex `#rrggbb`; STEP only. */
  color?: string;
}

/** Value of `exportShapes()` on success: MEMFS paths to read and unlink. */
export interface RawExportResult {
  /** First (for merged exports: only) file. */
  path: string;
  files: { path: string; name: string }[];
}

/** Value of `importFile()` on success. */
export interface RawImportResult {
  bodies: { shape: number; name?: string }[];
}

/**
 * What `measure()` measures: a sub-shape of a live shape (a contracts `ResolvedRef`) or a world
 * point (mm).
 */
export type MeasureSubject =
  | { shape: number; kind: 'face' | 'edge' | 'vertex' | 'body'; index: number }
  | { point: [number, number, number] };

/** `measure()` query: one target (intrinsic values) or two (distance, angle). */
export interface MeasureQuery {
  a: MeasureSubject;
  b?: MeasureSubject;
}

/** A point in a sketch plane's local x/y, mm (the contracts `Vec2`). */
export type PlaneXY = Vec2;

/**
 * One model curve projected onto a plane (plane-frame local x/y, mm). Arcs run counter-clockwise
 * in plane coordinates. `polyline` is an approximation (ellipses, circles seen obliquely, splines),
 * within about 1 µm of the exact projection. With `exact: true` the result is an
 * `ExactProjectedCurve` instead.
 */
export type ProjectedCurve =
  | { kind: 'line'; a: PlaneXY; b: PlaneXY }
  | { kind: 'circle'; c: PlaneXY; r: number }
  | { kind: 'arc'; c: PlaneXY; r: number; start: PlaneXY; end: PlaneXY }
  | { kind: 'polyline'; points: PlaneXY[] };

/**
 * M3.5, `exact: true`: an ellipse (full) or elliptic arc (counter-clockwise `start` → `end`), as
 * `SketchEllipse` / `SketchEllipticArc`: `rotation` is the major axis angle in (−π/2, π/2],
 * `majorRadius` > `minorRadius`. A circle seen obliquely projects to one (a projection that is
 * still circular comes back as `circle` / `arc`).
 */
export type ProjectedConic =
  | { kind: 'ellipse'; c: PlaneXY; majorRadius: number; minorRadius: number; rotation: number }
  | {
      kind: 'ellipticArc';
      c: PlaneXY;
      majorRadius: number;
      minorRadius: number;
      rotation: number;
      start: PlaneXY;
      end: PlaneXY;
    };

/**
 * M3.5, `exact: true`: the exact projection of a B-spline or Bezier edge, in any orientation
 * (parallel projection is affine, so it maps poles to poles): the projected poles with the curve's
 * own weights (present only when rational), degree and OCCT knots/multiplicities (distinct knots,
 * not normalised to [0, 1]), in the edge's parameter direction. Trimmed edges and non-periodic
 * curves come back clamped (`periodic: false`); a whole periodic curve stays periodic. Maps
 * one-to-one onto `SketchBSpline` (the poles become point entities). Poles that project onto one
 * line come back as a `line` instead.
 */
export interface ProjectedBSpline {
  kind: 'bspline';
  poles: PlaneXY[];
  degree: number;
  periodic: boolean;
  weights?: number[];
  knots: number[];
  multiplicities: number[];
}

/**
 * A curve of an `exact: true` projection: conics and B-splines exactly; other curves (offset
 * curves, intersection curves without a B-spline form) are still sampled `polyline`s.
 */
export type ExactProjectedCurve = ProjectedCurve | ProjectedConic | ProjectedBSpline;

/** A projected edge of an `exact: true` query. */
export interface ExactProjectedEdge {
  edge: number;
  curves: ExactProjectedCurve[];
}

/** A projected edge: `edge` is its TopExp ordinal; no curves when it projects to a point. */
export interface ProjectedEdge {
  edge: number;
  curves: ProjectedCurve[];
}

/** A projected face outline: the outer loop and each inner loop, edges in wire order. */
export interface ProjectedOutline {
  outer: ProjectedEdge[];
  inner: ProjectedEdge[][];
}

/** `projectEdges()` query. */
export interface ProjectEdgesQuery {
  shape: number;
  /** TopExp edge ordinals of `shape`. */
  edges: number[];
  plane: Frame;
  /**
   * M3.5: return conics and B-splines exactly; the value is then `ExactProjectedEdge[]` (the
   * default, false, keeps the M3 `ProjectedEdge[]`).
   */
  exact?: boolean;
}

/** `projectFaceOutline()` query. */
export interface ProjectFaceOutlineQuery {
  shape: number;
  /** TopExp face ordinal of `shape`. */
  face: number;
  plane: Frame;
  /** M3.5: as `ProjectEdgesQuery.exact` (the loops then hold `ExactProjectedEdge`s). */
  exact?: boolean;
}

/** Value of `kernelInfo()` on success. */
export interface RawKernelInfo {
  occtVersion: string;
  buildId: string;
  threads: boolean;
}

/** Emscripten module-factory options we use. */
export interface KernelModuleOptions {
  /** Resolve the `.wasm` (and, for the threaded build, the glue the pthread workers load). */
  locateFile?: (path: string, scriptDirectory: string) => string;
  /** Pre-fetched/compiled bytes; skips the module's own fetch. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Pre-compiled module (e.g. from `WebAssembly.compileStreaming`). */
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => unknown;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}
