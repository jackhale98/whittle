/**
 * The sketch worker's one non-Comlink message: `{ wrenSketch: 'ready' }` once planegcs is
 * loaded, `{ wrenSketch: 'failed', message }` if it can't be (ADR-088 amendment). Shared by
 * worker.ts and client.ts without pulling one into the other's bundle.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SKETCH_WORKER_READY = 'ready';
export const SKETCH_WORKER_FAILED = 'failed';

export type SketchWorkerStatus =
  | { wrenSketch: typeof SKETCH_WORKER_READY }
  | { wrenSketch: typeof SKETCH_WORKER_FAILED; message: string };

export function sketchWorkerStatus(data: unknown): SketchWorkerStatus | null {
  if (typeof data !== 'object' || data === null || !('wrenSketch' in data)) return null;
  const s = (data as { wrenSketch: unknown }).wrenSketch;
  if (s === SKETCH_WORKER_READY) return { wrenSketch: s };
  if (s === SKETCH_WORKER_FAILED) {
    const m = (data as { message?: unknown }).message;
    return { wrenSketch: s, message: typeof m === 'string' ? m : 'unknown error' };
  }
  return null;
}
