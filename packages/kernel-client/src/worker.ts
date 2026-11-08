/**
 * Kernel worker entry (PLAN §4): owns the OCCT Wasm instance and every shape; exposes exactly
 * `KernelApi` over Comlink. Spawned by `createKernelClient()` as a module worker.
 *
 * Asset wiring is static so bundlers can see it:
 *  - `import('@whittle/kernel/<variant>/init')` pulls in the generated initialiser, which
 *    references its Emscripten glue with `new URL('./whittle-kernel*.js', import.meta.url)`.
 *  - `?url` imports emit the `.wasm` files as hashed assets; the URL is handed to the glue via
 *    `locateFile` and fetched by us for streaming compile + download progress.
 * Vite: the threaded glue spawns its pthread workers as ES modules with top-level await, so the
 * app's Vite config needs `worker: { format: 'es' }`.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { KernelApi } from '@whittle/contracts';
import threadedWasmUrl from '@whittle/kernel/multi/wasm?url';
import singleWasmUrl from '@whittle/kernel/single/wasm?url';
import { expose } from 'comlink';
import { createKernelApi } from './kernel-api';
import { statusMessage } from './protocol';

const scope = self as unknown as {
  postMessage(message: unknown): void;
};

const api: KernelApi = createKernelApi({
  variants: {
    single: { load: () => import('@whittle/kernel/single/init'), wasmUrl: singleWasmUrl },
    threaded: { load: () => import('@whittle/kernel/multi/init'), wasmUrl: threadedWasmUrl },
  },
  onStatus: (status) => scope.postMessage(statusMessage(status)),
});

expose(api);
