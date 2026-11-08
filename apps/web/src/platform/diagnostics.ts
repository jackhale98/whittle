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
  /** `navigator.maxTouchPoints`. iPadOS Safari reports itself as a Mac but has > 1. */
  maxTouchPoints?: number;
  /** `navigator.userAgent`. */
  userAgent?: string;
  /** `navigator.platform` (`MacIntel` on iPadOS in desktop-class mode). */
  platform?: string;
}

/** Shortest screen side (CSS px) below which a touch device is a phone. */
export const PHONE_MAX_SHORT_SIDE = 600;
/** Below this a "desktop" is too weak for fine meshing + threaded kernel; treat as tablet tier. */
export const DESKTOP_MIN_CORES = 4;
export const DESKTOP_MIN_MEMORY_GIB = 4;

/**
 * Device class from the UA / platform / touch points, independent of pointer media queries (which
 * flip to `fine` on an iPad with a trackpad attached). Returns `undefined` for everything that is
 * not recognisably a phone or tablet.
 *
 * iPadOS 13+ sends a Macintosh UA and `navigator.platform === 'MacIntel'`; real Macs have no touch
 * screen (`maxTouchPoints` 0), so "Mac with > 1 touch points" is an iPad.
 */
export function mobileClassFromUserAgent(
  env: Pick<EnvSnapshot, 'userAgent' | 'platform' | 'maxTouchPoints'>,
): 'phone' | 'tablet' | undefined {
  const ua = env.userAgent ?? '';
  const touch = env.maxTouchPoints ?? 0;
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/iPad/.test(ua)) return 'tablet';
  if ((env.platform === 'MacIntel' || /Macintosh/.test(ua)) && touch > 1) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';
  return undefined;
}

/**
 * Tier rules (PLAN §8.4):
 *  - a recognised phone / iPad / Android tablet UA decides first (see `mobileClassFromUserAgent`);
 *  - phone: touch-primary and shortest screen side < 600 CSS px (viewer-first, lazy kernel).
 *  - tablet: touch-primary otherwise (Pencil support, medium meshing, memory-aware cache); also
 *    a mouse/keyboard machine with < 4 cores or < 4 GiB, which should not get fine meshing.
 *  - desktop: everything else.
 */
export function detectTier(env: EnvSnapshot): DeviceTier {
  const mobile = mobileClassFromUserAgent(env);
  if (mobile) return mobile;
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
  if (typeof nav.maxTouchPoints === 'number') snapshot.maxTouchPoints = nav.maxTouchPoints;
  if (typeof nav.userAgent === 'string') snapshot.userAgent = nav.userAgent;
  if (typeof nav.platform === 'string') snapshot.platform = nav.platform;
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
