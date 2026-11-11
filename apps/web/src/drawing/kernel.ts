/**
 * The drawing kernel as the route uses it: a thin client over `DrawingKernelApi` that loads each
 * shape once and caches projections by request.
 *
 * Today the implementation is the PLACEHOLDER in `placeholder/` (a worker projecting the regen
 * meshes' feature edges, see ADR-092). When the HLR drawing worker lands, `createDrawingKernel`
 * returns it instead, `shapeFor` becomes `ModelingApi.shapeForDrawing`, and nothing else changes.
 */

import type {
  DrawingKernelApi,
  KernelError,
  RegenResult,
  ShapeForDrawing,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { type Remote, transfer, wrap } from 'comlink';
import { shapeFromRegen } from './placeholder/shape';

export type KernelKind = 'placeholder' | 'hlr';

export interface DrawingKernel {
  kind: KernelKind;
  /** The shape the drawing kernel is given for a regen result. */
  shapeFor(result: RegenResult): ShapeForDrawing;
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
    kind: KernelKind;
    shapeFor(result: RegenResult): ShapeForDrawing;
    dispose(): void;
    /** Hand the BREP's buffer to the worker instead of copying it (a shape is then loaded once). */
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
      const arg = options.transfer ? transfer(shape, [shape.brep.buffer as ArrayBuffer]) : shape;
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
    kind: options.kind,
    shapeFor: options.shapeFor,
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

/** The placeholder kernel in its own worker. */
export function createDrawingKernel(): DrawingKernel {
  const worker = new Worker(new URL('./placeholder/worker.ts', import.meta.url), {
    type: 'module',
    name: 'wren-drawing-placeholder',
  });
  const api = wrap<DrawingKernelApi>(worker) as Remote<DrawingKernelApi>;
  return drawingKernelOver(api, {
    kind: 'placeholder',
    shapeFor: shapeFromRegen,
    dispose: () => worker.terminate(),
  });
}
