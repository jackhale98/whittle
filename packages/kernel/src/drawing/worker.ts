/**
 * Drawing worker entry (PLAN §3, ADR-090 §14): owns the trimmed HLR Wasm build and exposes
 * `DrawingWorkerApi` (contracts `DrawingKernelApi` plus warm-up and diagnostics) over Comlink.
 * Spawn it as a module worker, separate from the modeling worker:
 *
 *   new Worker(new URL('@wren-cad/kernel/drawing/worker', import.meta.url), { type: 'module' })
 *
 * Asset wiring is static, as in kernel-client's worker: the init modules are `import()`ed and the
 * `.wasm` files are `?url` assets. Vite needs `worker: { format: 'es' }` for the threaded glue.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/// <reference path="./generated-entries.d.ts" />

import threadedWasmUrl from '@wren-cad/kernel/drawing/multi/wasm?url';
import singleWasmUrl from '@wren-cad/kernel/drawing/single/wasm?url';
import { expose } from 'comlink';
import { createDrawingKernelApi } from './api';
import type { DrawingInitModule } from './facade';

const api = createDrawingKernelApi({
  variants: {
    single: {
      load: () => import('@wren-cad/kernel/drawing/single/init') as Promise<DrawingInitModule>,
      wasmUrl: singleWasmUrl,
    },
    threaded: {
      load: () => import('@wren-cad/kernel/drawing/multi/init') as Promise<DrawingInitModule>,
      wasmUrl: threadedWasmUrl,
    },
  },
});

expose(api);
