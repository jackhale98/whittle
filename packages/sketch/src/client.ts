/**
 * Main-thread side of the sketch solver: spawns the sketch worker and wraps it with Comlink.
 * Never touches Wasm itself (golden rule). Inference is pure TS, so the UI may also call
 * `infer()` from the package root synchronously instead of round-tripping to the worker.
 *
 * Every call has a deadline. A worker that stops answering (it crashed, or Wasm hung) would
 * otherwise leave the call pending forever, and with it the app's edit queue and every settle
 * that waits on it. Past the deadline the call rejects, the worker is terminated, and the next
 * call spawns a fresh one (drag sessions of the old worker are gone: their calls reject).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolverApi } from '@wren-cad/contracts';
import { type Remote, releaseProxy, wrap } from 'comlink';

export interface SketchSolverClientOptions {
  /** Override worker creation (tests, custom bundling). */
  createWorker?: () => Worker;
  /**
   * How long one call may take before the worker is presumed dead, ms (default 20 000; the first
   * call includes compiling planegcs). A solve of 200 entities takes a few milliseconds.
   */
  timeoutMs?: number;
}

/** The solver calls, each returning a promise (the worker API, asynchronous). */
export type SketchSolverCalls = {
  [K in keyof SketchSolverApi]: (
    ...args: Parameters<SketchSolverApi[K]>
  ) => Promise<Awaited<ReturnType<SketchSolverApi[K]>>>;
};

export interface SketchSolverClient {
  api: SketchSolverCalls;
  /** Terminates the worker; drag sessions are lost and the client is unusable afterwards. */
  dispose(): void;
}

/** A call that missed its deadline (the worker was restarted). */
export class SketchSolverTimeout extends Error {
  constructor(call: string, ms: number) {
    super(`The sketch solver did not answer ${call} within ${ms} ms; it was restarted`);
    this.name = 'SketchSolverTimeout';
  }
}

export const DEFAULT_SOLVER_TIMEOUT_MS = 20_000;

function spawnSketchWorker(): Worker {
  // Literal `new Worker(new URL(...), { type: 'module' })` so Vite/Rollup bundle the worker.
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'wren-sketch',
  });
}

export function createSketchSolverClient(
  options: SketchSolverClientOptions = {},
): SketchSolverClient {
  const spawn = options.createWorker ?? spawnSketchWorker;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOLVER_TIMEOUT_MS;
  interface Live {
    worker: Worker;
    remote: Remote<SketchSolverApi>;
    /** Rejecters of this worker's unanswered calls: a dead worker fails them all at once. */
    waiting: Set<(err: Error) => void>;
  }
  let live: Live | null = null;
  let disposed = false;
  const kill = (w: Live, err: Error) => {
    if (live === w) live = null;
    w.remote[releaseProxy]();
    w.worker.terminate();
    for (const fail of [...w.waiting]) fail(err);
    w.waiting.clear();
  };
  const current = (): Live => {
    if (disposed) throw new Error('The sketch solver client was disposed');
    if (!live) {
      const worker = spawn();
      const w: Live = { worker, remote: wrap<SketchSolverApi>(worker), waiting: new Set() };
      // An uncaught error in the worker (a failed module or Wasm load, a crash): its calls would
      // never be answered. Fail them now; the next call starts a fresh worker.
      worker.addEventListener?.('error', () =>
        kill(w, new Error('The sketch solver worker failed; it was restarted')),
      );
      live = w;
    }
    return live;
  };
  const call =
    <K extends keyof SketchSolverApi>(name: K) =>
    (...args: Parameters<SketchSolverApi[K]>): Promise<Awaited<ReturnType<SketchSolverApi[K]>>> => {
      let w: Live;
      try {
        w = current();
      } catch (err) {
        return Promise.reject(err);
      }
      const fn = w.remote[name] as unknown as (
        ...a: Parameters<SketchSolverApi[K]>
      ) => Promise<Awaited<ReturnType<SketchSolverApi[K]>>>;
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          w.waiting.delete(fail);
        };
        const fail = (err: Error) => {
          done();
          reject(err);
        };
        const timer = setTimeout(
          () => kill(w, new SketchSolverTimeout(name, timeoutMs)),
          timeoutMs,
        );
        w.waiting.add(fail);
        fn(...args).then(
          (v) => {
            done();
            resolve(v);
          },
          (err: unknown) => {
            done();
            reject(err);
          },
        );
      });
    };
  current(); // spawn now: the worker starts compiling planegcs before the first call
  return {
    api: {
      solve: call('solve'),
      beginDrag: call('beginDrag'),
      drag: call('drag'),
      endDrag: call('endDrag'),
      infer: call('infer'),
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (live) kill(live, new Error('The sketch solver client was disposed'));
    },
  };
}
