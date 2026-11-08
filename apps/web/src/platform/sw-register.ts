/**
 * Service worker registration and the one-time reload that turns on cross-origin isolation
 * (PLAN §8.3).
 *
 * First visit on GitHub Pages: the document is served without COOP/COEP, so it is not isolated.
 * Our service worker (src/sw.ts) installs, claims the page, and from then on stamps every response
 * with the headers. The *current* document stays non-isolated, so we reload exactly once. A
 * sessionStorage flag prevents loops: if the reloaded page is still not isolated (in-app browsers,
 * some private modes, hard reloads that bypass the worker) we stay in `fallback` mode and the app
 * boots the single-threaded kernel.
 */

import { Workbox } from 'workbox-window';
import { patchRuntimeState } from './runtime-state';

export const SW_UPDATE_EVENT = 'whittle:sw-update';
const RELOAD_KEY = 'whittle:coi-reload';
const CONTROLLER_WAIT_MS = 3000;
/** A worker that never activates (failed install: precache 404 mid-deploy, quota, network) must not hang boot. */
const READY_WAIT_MS = 8000;

export interface IsolationReloadInput {
  isolated: boolean;
  /** A service worker currently controls this page. */
  controlled: boolean;
  /** We already reloaded once this session (or cannot record that we did). */
  alreadyReloaded: boolean;
}

/** Pure decision: reload iff we could be isolated after a reload and have not tried yet. */
export function shouldReloadForIsolation(input: IsolationReloadInput): boolean {
  return !input.isolated && input.controlled && !input.alreadyReloaded;
}

type FlagStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** sessionStorage can throw (blocked storage). Unavailable counts as "already reloaded". */
function readReloadFlag(store: () => FlagStore): boolean {
  try {
    return store().getItem(RELOAD_KEY) !== null;
  } catch {
    return true;
  }
}

function writeReloadFlag(store: () => FlagStore): boolean {
  try {
    store().setItem(RELOAD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

function clearReloadFlag(store: () => FlagStore): void {
  try {
    store().removeItem(RELOAD_KEY);
  } catch {
    // ignore
  }
}

function waitForController(timeoutMs: number): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(value);
    };
    const onChange = () => done(true);
    const timer = setTimeout(() => done(Boolean(navigator.serviceWorker.controller)), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
  });
}

let workbox: Workbox | undefined;
let updateAvailable = false;

/** True once a new service worker is installed and waiting to take over. */
export function isSwUpdateAvailable(): boolean {
  return updateAvailable;
}

/** Subscribe to "a new version is ready". Fires immediately if one is already waiting. */
export function onSwUpdateAvailable(listener: () => void): () => void {
  window.addEventListener(SW_UPDATE_EVENT, listener);
  if (updateAvailable) queueMicrotask(listener);
  return () => window.removeEventListener(SW_UPDATE_EVENT, listener);
}

/** Manual "Check for updates": resolves with what was found. */
export async function checkForSwUpdateNow(): Promise<'update' | 'current' | 'unavailable'> {
  if (!workbox) return 'unavailable';
  try {
    await workbox.update();
  } catch {
    return 'unavailable';
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.waiting || reg?.installing || updateAvailable) return 'update';
  return 'current';
}

/** Asks the browser to look for a new service worker now (cheap; the SW script is tiny). */
export function checkForSwUpdate(): void {
  void workbox?.update().catch(() => {
    // offline or server error: try again on the next focus
  });
}

/**
 * Keeps an open app current: re-check on focus/visibility and every 30 minutes. A new version that
 * is found before the user has interacted with this page (typically: right after launch) is applied
 * immediately — documents are saved locally on every change, so a reload loses nothing. Otherwise
 * the UI shows "Update available" (subscribe with onSwUpdateAvailable).
 */
export function keepServiceWorkerFresh(): void {
  let interacted = false;
  const markInteracted = () => {
    interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  window.addEventListener('keydown', markInteracted, { once: true, capture: true });
  onSwUpdateAvailable(() => {
    if (!interacted) applySwUpdate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForSwUpdate();
  });
  window.addEventListener('focus', checkForSwUpdate);
  setInterval(checkForSwUpdate, 30 * 60 * 1000);
}

/** Activate the waiting worker and reload into the new version. */
export function applySwUpdate(): void {
  if (!workbox) return;
  workbox.addEventListener('controlling', () => window.location.reload());
  workbox.messageSkipWaiting();
}

function settleWithoutServiceWorker(): void {
  patchRuntimeState({ isolation: window.crossOriginIsolated ? 'isolated' : 'fallback' });
}

/**
 * Register the service worker and settle the isolation mode. Safe to call once at startup;
 * never throws. Skipped in `vite dev` (the dev server sends the headers itself).
 */
export async function initServiceWorker(): Promise<void> {
  if (import.meta.env.DEV) {
    patchRuntimeState({ serviceWorker: 'none' });
    settleWithoutServiceWorker();
    return;
  }
  if (!('serviceWorker' in navigator)) {
    patchRuntimeState({ serviceWorker: 'unsupported' });
    settleWithoutServiceWorker();
    return;
  }

  const base = import.meta.env.BASE_URL;
  try {
    workbox = new Workbox(`${base}sw.js`, { scope: base });
    workbox.addEventListener('waiting', () => {
      // A waiting worker on first install is not an "update"; only prompt when one is controlling.
      if (!navigator.serviceWorker.controller) return;
      updateAvailable = true;
      window.dispatchEvent(new Event(SW_UPDATE_EVENT));
    });
    // Already isolated (warm visit through the SW, or real headers): settle now so the kernel can
    // boot in parallel with registration instead of waiting for it.
    if (window.crossOriginIsolated) {
      clearReloadFlag(() => sessionStorage);
      patchRuntimeState({ isolation: 'isolated' });
    }
    patchRuntimeState({ serviceWorker: 'installing' });
    await workbox.register({ immediate: true });
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), READY_WAIT_MS)),
    ]);
    if (!ready) {
      // Install failed or stalled: keep working without isolation (single-threaded kernel).
      settleWithoutServiceWorker();
      return;
    }
    patchRuntimeState({ serviceWorker: 'active' });
    if (window.crossOriginIsolated) return;

    const controlled = await waitForController(CONTROLLER_WAIT_MS);
    const alreadyReloaded = readReloadFlag(() => sessionStorage);
    if (shouldReloadForIsolation({ isolated: false, controlled, alreadyReloaded })) {
      if (writeReloadFlag(() => sessionStorage)) {
        window.location.reload();
        return; // isolation stays 'pending' for this (doomed) document
      }
    }
    patchRuntimeState({ isolation: 'fallback' });
  } catch {
    // Registration refused (blocked workers, private mode, insecure context...): fallback mode.
    patchRuntimeState({ serviceWorker: 'none' });
    settleWithoutServiceWorker();
  }
}
