// Whittle kernel build (ADR-002): OCCT 8.0.1 → Wasm via @libcascade/toolchain, with our coarse
// C++ façade as the only JS-visible surface. Run through `pnpm build` (scripts/build.mjs), which
// first amalgamates the façade into .libcascade/whittle_facade.cpp (see scripts/amalgamate.mjs).
//
// SPDX-License-Identifier: Apache-2.0
import { defineBuild } from '@libcascade/toolchain';

/** Every JS-visible registration in src/whittle_bindings.cpp. */
const facadeSymbols = [
  'MeshData',
  'kernelInfo',
  'execFeature',
  'mesh',
  'massProperties',
  'release',
  'liveHandleCount',
] as const;

export default defineBuild({
  name: 'whittle-kernel',
  // Façade only: no OCCT class gets an embind registration, so JS cannot reach OCCT except
  // through the façade, and the linker keeps only the OCCT code the façade references.
  bindings: [...facadeSymbols],
  customBindings: [
    {
      file: '.libcascade/whittle_facade.cpp',
      symbols: [...facadeSymbols],
      // Raw embind: free functions + a class with typed_memory_view accessors.
      scope: 'main',
    },
  ],
  settings: {
    MODULARIZE: true,
    EXPORT_ES6: true,
    ENVIRONMENT: ['web', 'worker', 'node'],
    ALLOW_MEMORY_GROWTH: true,
    INITIAL_MEMORY: '64MB',
    MAXIMUM_MEMORY: '4GB',
    // getExceptionMessage & co. are required by the toolchain with native Wasm exceptions (decode
    // escaped exceptions in JS). wasmMemory exposes heap size for diagnostics, and is also what
    // makes the generated d.ts take the `{ … } & { … }` shape `libcascade assemble` parses
    // (toolchain 3.1.0 emits a one-line `{}` prelude without FS/wasmMemory and assemble rejects it).
    EXPORTED_RUNTIME_METHODS: [
      'wasmMemory',
      'getExceptionMessage',
      'incrementExceptionRefcount',
      'decrementExceptionRefcount',
    ],
  },
  compilerFlags: { exceptions: 'wasm', noEntry: true, simd: true, optimize: 'O3' },
  variants: [
    { name: 'single', outputName: 'whittle-kernel-st' },
    {
      name: 'multi',
      outputName: 'whittle-kernel',
      compilerFlags: { threads: true },
      settings: {
        SHARED_MEMORY: true,
        // Workers are pre-spawned at init (blocking pthread_create cannot wait for a lazily
        // loaded worker). The generated initialiser overrides this with `threadCount`.
        PTHREAD_POOL_SIZE: 'navigator.hardwareConcurrency',
      },
    },
  ],
});
