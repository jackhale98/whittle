/**
 * Typed JS surface of the Emscripten module built from src/whittle_bindings.cpp.
 *
 * The toolchain does not generate declarations for `scope: 'main'` (raw embind) bindings, so this
 * file is the hand-maintained counterpart of the EMSCRIPTEN_BINDINGS block. Every structured
 * value crosses the boundary as a JSON string shaped like packages/contracts/src/kernel.ts.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
   * Writes `format` (`step` | `stl` | `brep`) to MEMFS. `shapesJson`: `ExportShape[]`;
   * `optionsJson`: contracts `ExportOptions`. Returns `Result<RawExportResult>` JSON; the caller
   * reads every file with `FS.readFile` and unlinks it.
   */
  exportShapes(shapesJson: string, format: string, optionsJson: string): string;
  /** Reads a MEMFS file (`step` | `stl` | `brep`). Returns `Result<RawImportResult>` JSON. */
  importFile(path: string, format: string): string;
  /**
   * Exact B-rep measurement. `queryJson`: `MeasureQuery`. Returns `Result<Measurement>` JSON
   * (contracts kernel.ts).
   */
  measure(queryJson: string): string;
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
