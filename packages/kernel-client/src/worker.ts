/**
 * Kernel worker entry (PLAN §4): owns the OCCT Wasm instance, every shape and the regen engine
 * (with planegcs for sketch re-solves); exposes exactly `ModelingWorkerApi` (contracts
 * `ModelingApi` + low-level M1 calls) over Comlink. Spawned by `createKernelClient()` as a module
 * worker.
 *
 * Asset wiring is static so bundlers can see it:
 *  - `import('@wren-cad/kernel/<variant>/init')` pulls in the generated initialiser, which
 *    references its Emscripten glue with `new URL('./whittle-kernel*.js', import.meta.url)`.
 *  - `?url` imports emit the `.wasm` files (OCCT variants, planegcs) as hashed assets; the URL is handed to the glue via
 *    `locateFile` and fetched by us for streaming compile + download progress.
 * Vite: the threaded glue spawns its pthread workers as ES modules with top-level await, so the
 * app's Vite config needs `worker: { format: 'es' }`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import planegcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import threadedWasmUrl from '@wren-cad/kernel/multi/wasm?url';
import singleWasmUrl from '@wren-cad/kernel/single/wasm?url';
import { expose } from 'comlink';
import { createModelingApi, type ModelingWorkerApi } from './modeling-api';
import { statusMessage } from './protocol';

const scope = self as unknown as {
  postMessage(message: unknown): void;
};

const api: ModelingWorkerApi = createModelingApi({
  planegcsWasmUrl,
  variants: {
    single: { load: () => import('@wren-cad/kernel/single/init'), wasmUrl: singleWasmUrl },
    threaded: { load: () => import('@wren-cad/kernel/multi/init'), wasmUrl: threadedWasmUrl },
  },
  onStatus: (status) => scope.postMessage(statusMessage(status)),
});

expose(api);
