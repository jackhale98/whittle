/**
 * What the sync chunk needs from the page: build-time provider config (`sync-config.ts`), the
 * OAuth redirect URI, and one seam for end-to-end tests.
 *
 * Test seam: `globalThis.__whittleSyncOverrides`, set by a Playwright init script before the app
 * boots. It can (1) rewrite provider origins to local fake servers (Dropbox's three hosts are
 * fixed URLs inside `@whittle/sync`), (2) supply public app keys the CI build doesn't have and
 * (3) stand in for `showDirectoryPicker`, which can't be automated. Only script already running
 * in this page can set it, and such script could read the vault anyway, so it widens nothing.
 */

import type { OAuthConfig } from '@whittle/sync';
import {
  availableProviders,
  type ProviderAvailability,
  readSyncConfig,
  oauthRedirectUri as redirectFor,
  type SyncConfig,
} from '../platform/sync-config';

export interface SyncOverrides {
  /** Origin → replacement origin, e.g. `https://api.dropboxapi.com` → `http://127.0.0.1:9999`. */
  endpoints?: Record<string, string>;
  config?: Partial<SyncConfig>;
  /** Replaces `window.showDirectoryPicker` (tests pass an OPFS directory). */
  pickDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

export function overrides(): SyncOverrides {
  const o = (globalThis as { __whittleSyncOverrides?: SyncOverrides }).__whittleSyncOverrides;
  return o && typeof o === 'object' ? o : {};
}

export function syncConfig(): SyncConfig {
  return { ...readSyncConfig(), ...(overrides().config ?? {}) };
}

export function providerAvailability(): ProviderAvailability[] {
  return availableProviders(syncConfig());
}

/** Rewrites a URL's origin per the test seam (identity in normal use). */
export function rewrite(url: string): string {
  const map = overrides().endpoints;
  if (!map) return url;
  for (const [from, to] of Object.entries(map)) {
    if (url === from || url.startsWith(`${from}/`) || url.startsWith(`${from}?`))
      return to + url.slice(from.length);
  }
  return url;
}

/** `fetch` that honours the endpoint rewrites (providers and token exchange take a `Fetcher`). */
export const syncFetch: typeof fetch = (input, init) => {
  if (typeof input === 'string') return fetch(rewrite(input), init);
  if (input instanceof URL) return fetch(rewrite(input.toString()), init);
  return fetch(new Request(rewrite(input.url), input), init);
};

export function redirectUri(): string {
  return redirectFor(location.origin, import.meta.env.BASE_URL);
}

export function oauthConfig(): OAuthConfig {
  const c = syncConfig();
  return {
    dropboxAppKey: c.dropboxAppKey,
    onedriveClientId: c.onedriveClientId,
    gdriveClientId: c.gdriveClientId,
    redirectUri: redirectUri(),
  };
}

/** The page URL carries an OAuth callback (`state` plus `code` or `error`). */
export function hasOAuthCallback(search = globalThis.location?.search ?? ''): boolean {
  const q = new URLSearchParams(search);
  return q.has('state') && (q.has('code') || q.has('error'));
}

/** Desktop Chromium has `showDirectoryPicker` (local folders and local git repos, ADR-029). */
export function canPickDirectory(): boolean {
  return (
    !!overrides().pickDirectory ||
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const o = overrides().pickDirectory;
  try {
    if (o) return await o();
    const pick = (
      globalThis as {
        showDirectoryPicker?: (o: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    return pick ? await pick({ mode: 'readwrite' }) : null;
  } catch {
    return null; // cancelled
  }
}
