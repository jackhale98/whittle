/**
 * Picks and boots the regen engine.
 *
 * SWAP POINT for the real engine: once the kernel worker implements `ModelingApi`
 * (packages/kernel-client/src/regen), set `REAL_ENGINE_AVAILABLE = true`. `?engine=fake` keeps the
 * fake (E2E pins it until the real engine is merged); `?engine=real` forces the worker.
 */

import type { KernelStatus } from '@whittle/contracts';
import type { KernelClient } from '@whittle/kernel-client';
import { mark } from '../app/timing';
import { reportKernelVariant, whenIsolationSettled } from '../platform/runtime-state';
import { createModeling, type Modeling, type ModelingPort } from './modeling';

/** Flip to true when the kernel worker exposes `ModelingApi` (regenerate, refFor, …). */
export const REAL_ENGINE_AVAILABLE = false;

export type EngineKind = 'fake' | 'real';

export function engineKind(search = globalThis.location?.search ?? ''): EngineKind {
  const v = new URLSearchParams(search).get('engine');
  if (v === 'fake' || v === 'real') return v;
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
    client = createKernelClient({ variant: mode === 'isolated' ? 'threaded' : 'single' });
    client.status.subscribe(onStatus);
    const ready = await client.ready();
    if (!ready.ok) throw new Error(ready.error.message);
    reportKernelVariant(ready.value.variant);
    mark('kernelReadyMs');

    let port: ModelingPort;
    if (kind === 'fake') {
      const { createFakeModeling } = await import('./fake-modeling');
      port = createFakeModeling(client.api);
    } else {
      // The real engine: the kernel worker's Comlink surface is `Remote<ModelingApi>`.
      port = client.api as unknown as ModelingPort;
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
