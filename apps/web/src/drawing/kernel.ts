/**
 * The drawing kernel as the route uses it: a thin client over `DrawingKernelApi` that loads each
 * shape once and caches projections by request. The implementation is the HLR drawing worker
 * (`@wren-cad/kernel/drawing`, ADR-090 amendment) with its own trimmed Wasm build; the main thread
 * never touches Wasm. The worker picks the threaded variant itself when cross-origin isolated,
 * as the modelling worker does.
 *
 * Shapes come from `ModelingApi.shapeForDrawing` (see `ConfigDataSource`). The BREP's bytes are
 * transferred to the worker. The route keeps its own copy (a transferred copy is sent), because a
 * shape the worker has evicted from its LRU must be loadable again, and the modelling slot it came
 * from may be closed by then (other configurations are regenerated in a slot that is closed at
 * once).
 */

import type {
  DrawingKernelApi,
  KernelError,
  ShapeForDrawing,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { type Remote, transfer, wrap } from 'comlink';

export interface DrawingKernel {
  project(
    shape: ShapeForDrawing,
    request: ViewProjectionRequest,
  ): Promise<{ ok: true; value: ViewProjection } | { ok: false; error: KernelError }>;
  dispose(): void;
}

const MAX_CACHE = 240;

/** Wraps any `DrawingKernelApi` with load-once and a projection cache. */
export function drawingKernelOver(
  api: Pick<DrawingKernelApi, 'loadShape' | 'project'>,
  options: {
    dispose(): void;
    /** Hand a copy of the BREP's buffer to the worker instead of cloning it through the channel. */
    transfer?: boolean;
  },
): DrawingKernel {
  const loaded = new Set<string>();
  const loading = new Map<string, Promise<{ ok: true } | { ok: false; error: KernelError }>>();
  const cache = new Map<string, ViewProjection>();
  const load = (shape: ShapeForDrawing) => {
    if (loaded.has(shape.key)) return Promise.resolve({ ok: true as const });
    let p = loading.get(shape.key);
    if (!p) {
      let arg: ShapeForDrawing = shape;
      if (options.transfer) {
        const copy = { ...shape, brep: shape.brep.slice() };
        arg = transfer(copy, [copy.brep.buffer as ArrayBuffer]);
      }
      p = api.loadShape(arg).then((r) => {
        if (r.ok) loaded.add(shape.key);
        loading.delete(shape.key);
        return r;
      });
      loading.set(shape.key, p);
    }
    return p;
  };
  return {
    async project(shape, request) {
      const key = JSON.stringify(request);
      const hit = cache.get(key);
      if (hit) return { ok: true, value: hit };
      const l = await load(shape);
      if (!l.ok) return l;
      let r = await api.project(request);
      if (!r.ok && r.error.code === 'INVALID_HANDLE') {
        // The worker evicted the shape (its LRU is small): load it again, once.
        loaded.delete(shape.key);
        const again = await load(shape);
        if (!again.ok) return again;
        r = await api.project(request);
      }
      if (r.ok) {
        cache.set(key, r.value);
        if (cache.size > MAX_CACHE) {
          const first = cache.keys().next().value;
          if (first !== undefined) cache.delete(first);
        }
      }
      return r;
    },
    dispose: options.dispose,
  };
}

/** The drawing worker. Its Wasm loads on the first call, not when it is created. */
export function createDrawingKernel(): DrawingKernel {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'wren-drawing',
  });
  const api = wrap<DrawingKernelApi>(worker) as Remote<DrawingKernelApi>;
  return drawingKernelOver(api, { transfer: true, dispose: () => worker.terminate() });
}
