/**
 * Kernel memory guard, app side (PLAN H1): live shape-handle count and Wasm heap size, read from
 * the kernel worker (`ModelingWorkerApi.memoryStats`). Feeds the Runtime panel (diagnostics view)
 * and the soak test's hook `window.__wrenKernel`. The main thread only asks the worker for two
 * numbers; it never touches Wasm. The fake engine has no `memoryStats`: reads return `null`.
 */

import type { KernelMemoryStats } from '@wren-cad/kernel-client';
import type { KernelMemory } from '@wren-cad/ui';
import type { Workbench } from './workbench';

type MemoryPort = { memoryStats?: () => Promise<KernelMemoryStats> };

export async function readKernelMemory(
  wb: Pick<Workbench, 'modeling'>,
): Promise<KernelMemory | null> {
  const port = wb.modeling?.port as MemoryPort | undefined;
  if (!port?.memoryStats) return null;
  return port.memoryStats();
}

/** E2E hook `window.__wrenKernel` (soak test). Returns the cleanup. */
export function installKernelMemoryHook(wb: Pick<Workbench, 'modeling'>): () => void {
  const w = window as unknown as { __wrenKernel?: { memory(): Promise<KernelMemory | null> } };
  w.__wrenKernel = { memory: () => readKernelMemory(wb) };
  return () => {
    delete w.__wrenKernel;
  };
}
