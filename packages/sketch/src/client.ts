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
 * The deadline counts from when the worker reports planegcs loaded (worker-protocol.ts), or from
 * the call if it was already: a cold, slow link may take longer than that to download the Wasm,
 * and restarting then would only download it again. A worker still loading is never restarted;
 * calls that wait on it longer than `loadTimeoutMs` reject, and it keeps loading for the next.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolverApi } from '@wren-cad/contracts';
import { type Remote, releaseProxy, wrap } from 'comlink';
import { sketchWorkerStatus } from './worker-protocol';

export interface SketchSolverClientOptions {
  /** Override worker creation (tests, custom bundling). */
  createWorker?: () => Worker;
  /**
   * How long one call may take once the worker has loaded planegcs before the worker is presumed
   * dead, ms (default 20 000). A solve of 200 entities measured 22–83 ms in Node.
   */
  timeoutMs?: number;
  /**
   * Whether the worker posts the ready message (worker-protocol.ts). Default: true for the
   * built-in worker, false with `createWorker` (then it counts as ready at once).
   */
  signalsReady?: boolean;
  /**
   * How long a call may wait for a worker that is still loading, ms (default 120 000). Past it the
   * call rejects but the worker keeps loading (never restarted while loading).
   */
  loadTimeoutMs?: number;
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

/** A call that missed its deadline (the worker was restarted), or waited too long for it to load. */
export class SketchSolverTimeout extends Error {
  constructor(call: string, ms: number, loading = false) {
    super(
      loading
        ? `The sketch solver was still loading after ${ms} ms (${call}); it keeps loading`
        : `The sketch solver did not answer ${call} within ${ms} ms; it was restarted`,
    );
    this.name = 'SketchSolverTimeout';
  }
}

export const DEFAULT_SOLVER_TIMEOUT_MS = 20_000;
export const DEFAULT_SOLVER_LOAD_TIMEOUT_MS = 120_000;

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
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_SOLVER_LOAD_TIMEOUT_MS;
  const signalsReady = options.signalsReady ?? options.createWorker === undefined;
  interface Live {
    worker: Worker;
    remote: Remote<SketchSolverApi>;
    /** Rejecters of this worker's unanswered calls: a dead worker fails them all at once. */
    waiting: Set<(err: Error) => void>;
    /** planegcs is loaded: deadlines run from the call. */
    ready: boolean;
    /** Deadlines waiting for the ready message. */
    onReady: Set<() => void>;
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
      const w: Live = {
        worker,
        remote: wrap<SketchSolverApi>(worker),
        waiting: new Set(),
        ready: !signalsReady,
        onReady: new Set(),
      };
      // An uncaught error in the worker (a failed module or Wasm load, a crash): its calls would
      // never be answered. Fail them now; the next call starts a fresh worker.
      worker.addEventListener?.('error', () =>
        kill(w, new Error('The sketch solver worker failed; it was restarted')),
      );
      if (signalsReady) {
        worker.addEventListener?.('message', (ev: MessageEvent) => {
          const st = sketchWorkerStatus(ev.data);
          if (!st || w.ready) return;
          if (st.wrenSketch === 'failed') {
            kill(
              w,
              new Error(`The sketch solver could not load (${st.message}); it was restarted`),
            );
            return;
          }
          w.ready = true;
          for (const start of [...w.onReady]) start();
          w.onReady.clear();
        });
      }
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
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(timer);
          w.onReady.delete(arm);
          w.waiting.delete(fail);
        };
        const fail = (err: Error) => {
          done();
          reject(err);
        };
        /** The deadline proper: from now, with planegcs loaded. */
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => kill(w, new SketchSolverTimeout(name, timeoutMs)), timeoutMs);
        };
        if (w.ready) arm();
        else {
          w.onReady.add(arm);
          // Still loading: this call gives up after `loadTimeoutMs`, the worker keeps loading.
          timer = setTimeout(
            () => fail(new SketchSolverTimeout(name, loadTimeoutMs, true)),
            loadTimeoutMs,
          );
        }
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
