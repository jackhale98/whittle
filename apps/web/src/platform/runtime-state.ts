/**
 * Tiny observable store for platform facts that change after boot: service worker state, the
 * cross-origin-isolation outcome, and the kernel/render backends the app reports. React reads it
 * with `useSyncExternalStore(subscribe, getSnapshot)`.
 */

import type { KernelVariant, RenderBackend, RuntimeDiagnostics } from '@wren-cad/contracts';

export type ServiceWorkerState = RuntimeDiagnostics['serviceWorker'];

/**
 * - `pending`: still deciding (service worker installing, possible one-time reload ahead).
 * - `isolated`: `crossOriginIsolated === true`, threaded kernel allowed.
 * - `fallback`: isolation is unavailable; use the single-threaded kernel.
 */
export type IsolationMode = 'pending' | 'isolated' | 'fallback';

export interface RuntimeState {
  readonly serviceWorker: ServiceWorkerState;
  readonly isolation: IsolationMode;
  readonly kernelVariant: KernelVariant | null;
  readonly renderBackend: RenderBackend | null;
}

let state: RuntimeState = {
  serviceWorker: 'none',
  isolation: 'pending',
  kernelVariant: null,
  renderBackend: null,
};

const listeners = new Set<() => void>();
let settledResolvers: Array<(mode: 'isolated' | 'fallback') => void> = [];

export function getRuntimeState(): RuntimeState {
  return state;
}

export function subscribeRuntimeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function patchRuntimeState(patch: Partial<RuntimeState>): void {
  state = { ...state, ...patch };
  if (state.isolation !== 'pending') {
    const mode = state.isolation;
    for (const resolve of settledResolvers) resolve(mode);
    settledResolvers = [];
  }
  for (const listener of listeners) listener();
}

/**
 * Resolves once the isolation outcome is known. The kernel client must await this before picking
 * a variant: on a first visit the page reloads once and this promise never resolves for the
 * pre-reload document (which is the point: don't boot a kernel that is about to be thrown away).
 */
export function whenIsolationSettled(): Promise<'isolated' | 'fallback'> {
  if (state.isolation !== 'pending') return Promise.resolve(state.isolation);
  return new Promise((resolve) => {
    settledResolvers.push(resolve);
  });
}

/** Called by the app once the kernel has booted / the viewport has chosen a backend. */
export function reportKernelVariant(variant: KernelVariant | null): void {
  patchRuntimeState({ kernelVariant: variant });
}

export function reportRenderBackend(backend: RenderBackend | null): void {
  patchRuntimeState({ renderBackend: backend });
}
