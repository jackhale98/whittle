/**
 * Picks and boots the regen engine. The default is the real engine: the kernel worker's
 * `Remote<ModelingWorkerApi>` (packages/kernel-client/src/regen). `?engine=fake` selects the
 * main-thread fake (`fake-modeling.ts`, exact-name resolution only), kept for engine A/B checks in
 * dev servers and unit tests only: production builds drop it (`import.meta.env.DEV` is false there,
 * so the dynamic import is dead code and the chunk is never emitted).
 */

import type { KernelStatus } from '@whittle/contracts';
import type { KernelClient } from '@whittle/kernel-client';
import { mark } from '../app/timing';
import { getDiagnostics } from '../platform/diagnostics';
import { reportKernelVariant, whenIsolationSettled } from '../platform/runtime-state';
import { createModeling, type Modeling, type ModelingPort, spareResultsFor } from './modeling';

/** The kernel worker exposes `ModelingApi` (regenerate, refFor, …). */
export const REAL_ENGINE_AVAILABLE = true;

export type EngineKind = 'fake' | 'real';

export function engineKind(search = globalThis.location?.search ?? ''): EngineKind {
  const v = new URLSearchParams(search).get('engine');
  if (v === 'fake' && import.meta.env.DEV) return 'fake';
  if (v === 'real') return v;
  return REAL_ENGINE_AVAILABLE ? 'real' : 'fake';
}

export interface EngineBoot {
  /** Resolves once the kernel is ready and the engine is wired; rejects with a user message. */
  modeling: Promise<Modeling>;
  kind: EngineKind;
  dispose(): void;
}

/**
 * Non-blocking kernel boot (PLAN §4): waits for the isolation outcome (the first visit reloads
 * once), picks the threaded build iff cross-origin isolated, streams + compiles the Wasm in the
 * kernel worker, then wires the regen engine. The main thread never touches Wasm.
 */
export function bootEngine(onStatus: (status: KernelStatus) => void): EngineBoot {
  let client: KernelClient | null = null;
  let disposed = false;
  const kind = engineKind();

  const modeling = (async () => {
    const mode = await whenIsolationSettled();
    const { createKernelClient } = await import('@whittle/kernel-client');
    if (disposed) throw new Error('disposed');
    // Smaller per-part result caches on tablets and phones (memory budget, PLAN §8.4, §10).
    const spare = spareResultsFor(getDiagnostics().tier);
    client = createKernelClient({
      variant: mode === 'isolated' ? 'threaded' : 'single',
      ...(spare !== undefined ? { regen: { maxSpareResults: spare } } : {}),
    });
    client.status.subscribe(onStatus);
    const ready = await client.ready();
    if (!ready.ok) throw new Error(ready.error.message);
    reportKernelVariant(ready.value.variant);
    mark('kernelReadyMs');

    let port: ModelingPort;
    if (import.meta.env.DEV && kind === 'fake') {
      const { createFakeModeling } = await import('./fake-modeling');
      port = createFakeModeling(client.api);
    } else {
      // The real engine: the kernel worker's Comlink surface is `Remote<ModelingWorkerApi>`.
      port = client.api;
    }
    return createModeling(port);
  })();

  return {
    modeling,
    kind,
    dispose() {
      disposed = true;
      client?.dispose();
    },
  };
}
