import type { KernelStatus, MeshBuffers } from '@whittle/contracts';
import type { KernelClient } from '@whittle/kernel-client';
import { reportKernelVariant, whenIsolationSettled } from '../platform/runtime-state';
import { DEMO_BOX, DEMO_BOX_INPUTS } from './demo';
import { mark } from './timing';

export interface KernelBoot {
  /** Resolves with the demo body's mesh, or rejects with a user-facing message. */
  firstMesh: Promise<MeshBuffers>;
  dispose(): void;
}

/**
 * Non-blocking kernel boot (PLAN §4): waits for the isolation outcome (the first visit reloads
 * once), picks the threaded build iff cross-origin isolated, streams + compiles the Wasm in the
 * kernel worker, then builds and meshes the demo box. The main thread never touches Wasm.
 */
export function bootKernel(onStatus: (status: KernelStatus) => void): KernelBoot {
  let client: KernelClient | null = null;
  let disposed = false;

  const firstMesh = (async () => {
    const mode = await whenIsolationSettled();
    const { createKernelClient } = await import('@whittle/kernel-client');
    if (disposed) throw new Error('disposed');
    client = createKernelClient({ variant: mode === 'isolated' ? 'threaded' : 'single' });
    client.status.subscribe(onStatus);

    const ready = await client.ready();
    if (!ready.ok) throw new Error(ready.error.message);
    reportKernelVariant(ready.value.variant);
    mark('kernelReadyMs');

    const made = await client.api.execFeature(DEMO_BOX, DEMO_BOX_INPUTS);
    if (!made.ok) throw new Error(made.error.message);
    const mesh = await client.api.mesh(made.value.shape, {
      linearDeflection: 0.05,
      angularDeflection: 0.35,
      relative: true,
    });
    if (!mesh.ok) throw new Error(mesh.error.message);
    return mesh.value;
  })();

  return {
    firstMesh,
    dispose() {
      disposed = true;
      client?.dispose();
    },
  };
}
