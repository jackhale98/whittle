/**
 * Fallback declarations for the subpaths `libcascade assemble` generates into dist/.
 * TypeScript resolves the real dist/*.d.ts when they exist and falls back to these before the
 * first `pnpm build`, so `pnpm -r typecheck` works without Docker.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

declare module '@whittle/kernel/single/init' {
  export const createInstance: (
    options?: import('./facade').KernelModuleOptions,
  ) => Promise<unknown>;
  export default createInstance;
}

declare module '@whittle/kernel/multi/init' {
  export const createInstance: (
    options?: import('./facade').KernelModuleOptions & { threadCount?: number },
  ) => Promise<unknown>;
  export default createInstance;
}

declare module '@whittle/kernel/single/wasm?url' {
  const url: string;
  export default url;
}

declare module '@whittle/kernel/multi/wasm?url' {
  const url: string;
  export default url;
}
