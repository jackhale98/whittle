/**
 * Runtime diagnostics + device tier detection (PLAN §8.3, §8.4). Local-only, never transmitted.
 * `detectTier` and `buildDiagnostics` are pure so they can be unit-tested without a browser.
 */

import type { DeviceTier, RuntimeDiagnostics, WhittleTestHooks } from '@whittle/contracts';
import { getRuntimeState } from './runtime-state';
import { APP_VERSION } from './version';

export type PrimaryPointer = RuntimeDiagnostics['primaryPointer'];

/** Everything tier detection needs, as plain data. */
export interface EnvSnapshot {
  hardwareConcurrency: number;
  /** GiB, from `navigator.deviceMemory` (Chromium only, coarse buckets up to 8). */
  deviceMemory?: number;
  /** CSS px. */
  screenWidth: number;
  screenHeight: number;
  primaryPointer: PrimaryPointer;
  crossOriginIsolated: boolean;
}

/** Shortest screen side (CSS px) below which a touch device is a phone. */
export const PHONE_MAX_SHORT_SIDE = 600;
/** Below this a "desktop" is too weak for fine meshing + threaded kernel; treat as tablet tier. */
export const DESKTOP_MIN_CORES = 4;
export const DESKTOP_MIN_MEMORY_GIB = 4;

/**
 * Tier rules (PLAN §8.4):
 *  - phone: touch-primary and shortest screen side < 600 CSS px (viewer-first, lazy kernel).
 *  - tablet: touch-primary otherwise (Pencil support, medium meshing, memory-aware cache); also
 *    a mouse/keyboard machine with < 4 cores or < 4 GiB, which should not get fine meshing.
 *  - desktop: everything else.
 */
export function detectTier(env: EnvSnapshot): DeviceTier {
  const shortSide = Math.min(env.screenWidth, env.screenHeight);
  if (env.primaryPointer === 'coarse') {
    return shortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  }
  const weakCpu = env.hardwareConcurrency > 0 && env.hardwareConcurrency < DESKTOP_MIN_CORES;
  const weakMemory = env.deviceMemory !== undefined && env.deviceMemory < DESKTOP_MIN_MEMORY_GIB;
  return weakCpu || weakMemory ? 'tablet' : 'desktop';
}

export function buildDiagnostics(
  env: EnvSnapshot,
  runtime: {
    serviceWorker: RuntimeDiagnostics['serviceWorker'];
    kernelVariant: RuntimeDiagnostics['kernelVariant'];
    renderBackend: RuntimeDiagnostics['renderBackend'];
  },
  appVersion: string,
): RuntimeDiagnostics {
  const diagnostics: RuntimeDiagnostics = {
    tier: detectTier(env),
    crossOriginIsolated: env.crossOriginIsolated,
    kernelVariant: runtime.kernelVariant,
    renderBackend: runtime.renderBackend,
    hardwareConcurrency: env.hardwareConcurrency,
    primaryPointer: env.primaryPointer,
    serviceWorker: runtime.serviceWorker,
    appVersion,
  };
  if (env.deviceMemory !== undefined) diagnostics.deviceMemory = env.deviceMemory;
  return diagnostics;
}

function readPointer(win: Window): PrimaryPointer {
  if (typeof win.matchMedia !== 'function') return 'none';
  if (win.matchMedia('(pointer: fine)').matches) return 'fine';
  if (win.matchMedia('(pointer: coarse)').matches) return 'coarse';
  return 'none';
}

export function readEnvSnapshot(win: Window = window): EnvSnapshot {
  const nav = win.navigator as Navigator & { deviceMemory?: number };
  const snapshot: EnvSnapshot = {
    hardwareConcurrency: nav.hardwareConcurrency || 1,
    screenWidth: win.screen?.width ?? win.innerWidth,
    screenHeight: win.screen?.height ?? win.innerHeight,
    primaryPointer: readPointer(win),
    crossOriginIsolated: win.crossOriginIsolated === true,
  };
  if (typeof nav.deviceMemory === 'number') snapshot.deviceMemory = nav.deviceMemory;
  return snapshot;
}

/** Live diagnostics for the diagnostics panel and tests. */
export function getDiagnostics(): RuntimeDiagnostics {
  const runtime = getRuntimeState();
  return buildDiagnostics(readEnvSnapshot(), runtime, APP_VERSION);
}

/**
 * Exposes `window.__whittle` for E2E/perf tests. The lead replaces this with the full hooks
 * (firstBodyRendered timing); keep `diagnostics()` working so platform tests keep passing.
 */
export function installTestHooks(extra: Partial<WhittleTestHooks> = {}): void {
  const hooks: WhittleTestHooks = {
    diagnostics: getDiagnostics,
    firstBodyRendered: () =>
      Promise.reject(new Error('firstBodyRendered is not implemented in the placeholder shell')),
    ...extra,
  };
  (window as unknown as { __whittle?: WhittleTestHooks }).__whittle = hooks;
}
