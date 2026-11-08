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
  /** `Result<MassProperties>` JSON. */
  massProperties(shape: number): string;
  release(shape: number): void;
  liveHandleCount(): number;
  MeshData: new () => MeshDataHandle;
  /** Live linear memory (exported for heap diagnostics). */
  wasmMemory: WebAssembly.Memory;
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
