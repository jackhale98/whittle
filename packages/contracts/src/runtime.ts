/**
 * Runtime environment & device tier (PLAN §8.3, §8.4). Lead-owned.
 */

import type { KernelVariant } from './kernel';
import type { RenderBackend } from './viewport';

export type DeviceTier = 'desktop' | 'tablet' | 'phone';

export interface RuntimeDiagnostics {
  tier: DeviceTier;
  crossOriginIsolated: boolean;
  kernelVariant: KernelVariant | null;
  renderBackend: RenderBackend | null;
  hardwareConcurrency: number;
  /** GiB, where `navigator.deviceMemory` exists. */
  deviceMemory?: number;
  primaryPointer: 'fine' | 'coarse' | 'none';
  serviceWorker: 'unsupported' | 'installing' | 'active' | 'none';
  /** App version string, e.g. `0.1.0+<git sha>`. */
  appVersion: string;
}

/**
 * Global hook the app exposes for E2E/perf tests (`window.__wren`). Only test-facing; not an
 * extension API.
 */
export interface WrenTestHooks {
  diagnostics(): RuntimeDiagnostics;
  /** Resolves once the first body has been rendered. Includes timing marks (ms since navigationStart). */
  firstBodyRendered(): Promise<{
    shellInteractiveMs: number;
    kernelReadyMs: number;
    firstBodyMs: number;
  }>;
}
