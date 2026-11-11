/**
 * The drawing worker's entry for the app's bundle. The kernel package's worker module exposes
 * `DrawingWorkerApi` over Comlink as a side effect of being imported; this file only gives Vite a
 * relative worker URL to bundle (a bare specifier cannot be a `new URL` argument). The `.wasm`
 * files are hashed `?url` assets, fetched on the first `init`, which is on the drawing route.
 */
import '@wren-cad/kernel/drawing/worker';
