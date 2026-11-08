/**
 * @whittle/kernel — typed surface of the OCCT Wasm kernel and its two build variants.
 *
 * Variant entries (generated into dist/ by `libcascade assemble`; absent until `pnpm build`):
 *   - `@whittle/kernel/single/init` → `createInstance()` for whittle-kernel-st.{js,wasm}
 *   - `@whittle/kernel/multi/init`  → `createInstance()` for whittle-kernel.{js,wasm} (pthreads)
 *   - `@whittle/kernel/single/wasm`, `@whittle/kernel/multi/wasm` → the `.wasm` files (`?url`)
 *
 * This module only holds types and pure helpers; it never loads Wasm, so the main thread may
 * import it freely (golden rule: only the kernel worker instantiates the kernel).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference path="./generated-entries.d.ts" />

import type { KernelVariant } from '@whittle/contracts';
import type { KernelModuleOptions, WhittleKernelModule } from './facade';

export type {
  KernelModuleOptions,
  MeshDataHandle,
  RawKernelInfo,
  WhittleKernelModule,
} from './facade';

/** Toolchain variant name (libcascade.config.ts) for a contracts `KernelVariant`. */
export const TOOLCHAIN_VARIANT = { single: 'single', threaded: 'multi' } as const satisfies Record<
  KernelVariant,
  string
>;

/** Emitted artefact base names per variant (PLAN §7.2). */
export const KERNEL_ARTEFACT = {
  single: 'whittle-kernel-st',
  threaded: 'whittle-kernel',
} as const satisfies Record<KernelVariant, string>;

/** Shape of the generated `init.<variant>.js` modules. */
export interface KernelInitModule {
  createInstance(options?: KernelModuleOptions & { threadCount?: number }): Promise<unknown>;
}

/**
 * Instantiate a kernel module from a variant init module and narrow it to the façade surface.
 * Throws if the module lacks a façade entry point (e.g. a stale or foreign build).
 */
export async function instantiateKernel(
  init: KernelInitModule,
  options: KernelModuleOptions = {},
): Promise<WhittleKernelModule> {
  const instance = (await init.createInstance(options)) as Partial<WhittleKernelModule>;
  const required = [
    'kernelInfo',
    'execFeature',
    'mesh',
    'massProperties',
    'release',
    'liveHandleCount',
    'MeshData',
  ] as const;
  for (const name of required) {
    if (typeof instance[name] !== 'function') {
      throw new Error(`Kernel module is missing façade entry point "${name}"`);
    }
  }
  return instance as WhittleKernelModule;
}
