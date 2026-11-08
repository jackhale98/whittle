/**
 * "Install app" support for the welcome panel: captures `beforeinstallprompt` (Chromium) as early
 * as possible, knows whether we already run standalone, and whether to show the iOS
 * "Share → Add to Home Screen" hint instead (Safari has no install prompt).
 */

import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  | { kind: 'installed' }
  | { kind: 'prompt' }
  | { kind: 'ios-hint' }
  | { kind: 'unavailable' };

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = compute();
  for (const l of listeners) l();
};

function standalone(): boolean {
  const nav = globalThis.navigator as Navigator & { standalone?: boolean };
  return (
    installed ||
    nav?.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  );
}

function isIos(): boolean {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) || (/Mac/.test(nav.platform) && nav.maxTouchPoints > 1)
  );
}

function compute(): InstallState {
  if (standalone()) return { kind: 'installed' };
  if (deferred) return { kind: 'prompt' };
  if (isIos()) return { kind: 'ios-hint' };
  return { kind: 'unavailable' };
}

let snapshot: InstallState = { kind: 'unavailable' };

/** Call once at startup, before the browser fires the event. */
export function watchInstallPrompt(): void {
  snapshot = compute();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep it for our own button
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  const choice = await e.userChoice;
  emit();
  return choice.outcome === 'accepted';
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => snapshot;

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
