/**
 * Fallback declarations for the drawing kernel subpaths `libcascade assemble` generates into
 * drawing/dist/ (like ../generated-entries.d.ts for the main kernel), so typechecking works before
 * the first `pnpm --filter @wren-cad/kernel build:drawing`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

declare module '@wren-cad/kernel/drawing/single/init' {
  export const createInstance: (
    options?: import('../facade').KernelModuleOptions,
  ) => Promise<unknown>;
  export default createInstance;
}

declare module '@wren-cad/kernel/drawing/multi/init' {
  export const createInstance: (
    options?: import('../facade').KernelModuleOptions & { threadCount?: number },
  ) => Promise<unknown>;
  export default createInstance;
}

declare module '@wren-cad/kernel/drawing/single/wasm?url' {
  const url: string;
  export default url;
}

declare module '@wren-cad/kernel/drawing/multi/wasm?url' {
  const url: string;
  export default url;
}
