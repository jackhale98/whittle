/**
 * Main-thread side of the kernel (PLAN §4): spawns the kernel worker, wraps it with Comlink and
 * turns its lifecycle messages into a subscribable `KernelStatus` stream for the status chip.
 * Never touches Wasm itself (golden rule).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  KernelApi,
  KernelError,
  KernelInfo,
  KernelInitOptions,
  KernelStatus,
  Result,
} from '@whittle/contracts';
import { type Remote, releaseProxy, wrap } from 'comlink';
import { isStatusMessage, STATUS_MESSAGE_TAG } from './protocol';

export interface KernelClientOptions extends KernelInitOptions {
  /** Start loading the kernel immediately (default `true`; PLAN §4 non-blocking boot). */
  autoInit?: boolean;
  /** Override worker creation (tests, custom bundling). */
  createWorker?: () => Worker;
}

export interface KernelStatusStream {
  /** Latest status. */
  readonly current: KernelStatus;
  /** Calls `listener` with the current status now and on every change. Returns unsubscribe. */
  subscribe(listener: (status: KernelStatus) => void): () => void;
}

export interface KernelClient {
  api: Remote<KernelApi>;
  status: KernelStatusStream;
  /** Resolves with the first `init()` result (starting it if `autoInit` was false). */
  ready(): Promise<Result<KernelInfo>>;
  /** Terminates the worker. Shapes are lost; the client is unusable afterwards. */
  dispose(): void;
}

function workerError(message: string, detail?: string): KernelError {
  return detail === undefined
    ? { code: 'INTERNAL', message }
    : { code: 'INTERNAL', message, detail };
}

function spawnKernelWorker(): Worker {
  // Literal `new Worker(new URL(...), { type: 'module' })` so Vite/Rollup bundle the worker.
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'whittle-kernel',
  });
}

export function createKernelClient(options: KernelClientOptions = {}): KernelClient {
  const { autoInit = true, createWorker, ...initOptions } = options;
  const worker = createWorker ? createWorker() : spawnKernelWorker();

  let current: KernelStatus = { state: 'idle' };
  const listeners = new Set<(status: KernelStatus) => void>();
  const set = (status: KernelStatus) => {
    current = status;
    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch {
        // Listener errors must not break status delivery to others.
      }
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (isStatusMessage(event.data)) set(event.data[STATUS_MESSAGE_TAG]);
  };
  const onError = (event: ErrorEvent) => {
    set({ state: 'error', error: workerError('The kernel worker failed', event.message) });
  };
  const onMessageError = () => {
    set({ state: 'error', error: workerError('The kernel worker sent an unreadable message') });
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);

  const api = wrap<KernelApi>(worker);
  let disposed = false;
  let initResult: Promise<Result<KernelInfo>> | null = null;

  const ready = (): Promise<Result<KernelInfo>> => {
    if (initResult === null) {
      initResult = api.init(initOptions).then(
        (result) => {
          // The worker reports its own statuses; this covers results that arrive without one.
          if (result.ok && current.state !== 'ready') set({ state: 'ready', info: result.value });
          if (!result.ok && current.state !== 'error') set({ state: 'error', error: result.error });
          return result;
        },
        (e: unknown) => {
          const error = workerError(
            'The kernel worker is unavailable',
            e instanceof Error ? e.message : String(e),
          );
          set({ state: 'error', error });
          return { ok: false, error } as const;
        },
      );
    }
    return initResult;
  };
  if (autoInit) void ready();

  return {
    api,
    status: {
      get current() {
        return current;
      },
      subscribe(listener) {
        listeners.add(listener);
        listener(current);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      api[releaseProxy]();
      worker.terminate();
      listeners.clear();
    },
  };
}
