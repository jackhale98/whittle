// Wren drawing kernel build (ADR-090 amendment): a second, trimmed OCCT 8.0.1 → Wasm build for the
// drawing worker (hidden-line removal never runs in the modeling worker, trap T12). Same toolchain
// and digest-pinned images as ../libcascade.config.ts (ADR-002). Run through
// `pnpm --filter @wren-cad/kernel build:drawing` (drawing/scripts/build.mjs), which first
// amalgamates the façade into drawing/.libcascade/wren_drawing_facade.cpp.
//
// Trimming: the bindings list is the drawing façade only, so no OCCT class is reachable from JS and
// the linker keeps only what the façade calls: TKBRep (BREP read), TKHLR, TKG2d/TKG3d/TKGeomBase,
// TKGeomAlgo/TKTopAlgo, TKBO (the section cut), TKPrim (its prism tools) and TKMesh (PolyAlgo's
// tessellation). Nothing of STEP/IGES/STL, XCAF/OCAF, fillets, offsets or features is referenced.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineBuild } from '@libcascade/toolchain';

/** Every JS-visible registration in drawing/cpp/wren_drawing_bindings.cpp. */
const facadeSymbols = [
  'drawingInfo',
  'loadShape',
  'project',
  'configureThreads',
  'release',
  'liveHandleCount',
] as const;

export default defineBuild({
  name: 'wren-drawing',
  bindings: [...facadeSymbols],
  customBindings: [
    {
      file: '.libcascade/wren_drawing_facade.cpp',
      symbols: [...facadeSymbols],
      scope: 'main',
    },
  ],
  settings: {
    MODULARIZE: true,
    EXPORT_ES6: true,
    ENVIRONMENT: ['web', 'worker', 'node'],
    ALLOW_MEMORY_GROWTH: true,
    INITIAL_MEMORY: '32MB',
    MAXIMUM_MEMORY: '4GB',
    // As the main kernel: the exception helpers are required with native Wasm exceptions,
    // wasmMemory keeps the d.ts shape `libcascade assemble` parses, and FS carries the BREP bytes
    // (the worker writes ShapeForDrawing.brep to MEMFS for loadShape).
    EXPORTED_RUNTIME_METHODS: [
      'FS',
      'wasmMemory',
      'getExceptionMessage',
      'incrementExceptionRefcount',
      'decrementExceptionRefcount',
    ],
  },
  compilerFlags: { exceptions: 'wasm', noEntry: true, simd: true, optimize: 'O3' },
  variants: [
    { name: 'single', outputName: 'wren-drawing-st' },
    {
      name: 'multi',
      outputName: 'wren-drawing',
      compilerFlags: { threads: true },
      settings: {
        SHARED_MEMORY: true,
        // Pre-spawned like the main kernel; the drawing API passes a smaller `threadCount`
        // (src/drawing/api.ts) so the drawing worker does not double the modeling worker's pool.
        PTHREAD_POOL_SIZE: 'navigator.hardwareConcurrency',
      },
    },
  ],
});
