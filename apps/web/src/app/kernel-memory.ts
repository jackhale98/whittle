/**
 * Kernel memory guard, app side (PLAN H1): live shape handles, the Wasm heap and the regen cache,
 * read from the kernel worker (`ModelingApi.memoryStats`, contracts). Feeds the Runtime panel
 * (diagnostics view) and the soak test's hook `window.__wrenKernel`. The main thread only asks the
 * worker for a few numbers; it never touches Wasm. The fake engine has no `memoryStats`: reads
 * return `null`.
 */

import type { KernelMemoryStats } from '@wren-cad/contracts';
import type { KernelMemory } from '@wren-cad/ui';
import type { Workbench } from './workbench';

export function toKernelMemory(s: KernelMemoryStats): KernelMemory {
  return {
    handles: s.liveHandles,
    heapBytes: s.wasmHeapBytes,
    cacheEntries: s.regen.entries,
    cacheHandles: s.regen.ownedHandles,
  };
}

export async function readKernelMemory(
  wb: Pick<Workbench, 'modeling'>,
): Promise<KernelMemory | null> {
  const stats = await wb.modeling?.port.memoryStats?.();
  return stats ? toKernelMemory(stats) : null;
}

/** E2E hook `window.__wrenKernel` (soak test). Returns the cleanup. */
export function installKernelMemoryHook(wb: Pick<Workbench, 'modeling'>): () => void {
  const w = window as unknown as { __wrenKernel?: { memory(): Promise<KernelMemory | null> } };
  w.__wrenKernel = { memory: () => readKernelMemory(wb) };
  return () => {
    delete w.__wrenKernel;
  };
}
