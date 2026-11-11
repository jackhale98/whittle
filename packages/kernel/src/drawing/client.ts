/**
 * Main-thread side of the drawing worker: a Comlink proxy whose `loadShape` transfers the BREP
 * bytes instead of copying them (ADR-090: "bytes are transferred"). Never loads Wasm.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ShapeForDrawing } from '@wren-cad/contracts';
import { type Remote, transfer, wrap } from 'comlink';
import type { DrawingWorkerApi } from './api';

export type DrawingClient = Remote<DrawingWorkerApi>;

/**
 * Wraps a drawing worker. `loadShape` hands the BREP's buffer to the worker: the caller's
 * `shape.brep` is detached afterwards (it is the modeling worker's transferred copy anyway).
 */
export function connectDrawingWorker(worker: Worker): DrawingClient {
  const remote = wrap<DrawingWorkerApi>(worker);
  const loadShape = (shape: ShapeForDrawing) => {
    const buffer = shape.brep.buffer;
    const whole = shape.brep.byteOffset === 0 && shape.brep.byteLength === buffer.byteLength;
    return whole && buffer instanceof ArrayBuffer
      ? remote.loadShape(transfer(shape, [buffer]))
      : remote.loadShape(shape);
  };
  return new Proxy(remote, {
    get(target, prop, receiver) {
      if (prop === 'loadShape') return loadShape;
      return Reflect.get(target, prop, receiver);
    },
  });
}
