/// <reference lib="webworker" />
/**
 * Whittle's single service worker (PLAN §3 PWA, §8.3). vite-plugin-pwa `injectManifest` builds
 * this file and injects the precache manifest. Never register a second service worker and never
 * ship `coi-serviceworker`: only one worker can control a page.
 *
 * Responsibilities
 *  1. Precache the app shell (HTML/JS/CSS/icons/manifest). NOT the kernel.
 *  2. Runtime CacheFirst for the kernel `*.wasm` (and `whittle-kernel*.js` glue) in a versioned
 *     cache. The kernel is tens of MB; precaching would block install on the first visit and make
 *     phone-tier devices download it eagerly. It is fetched when the app first boots the kernel
 *     (non-blocking, PLAN §4) and is served from cache from then on, including offline.
 *  3. Cross-origin isolation: every same-origin response this worker serves (precached, cached or
 *     network) is rebuilt with COOP/COEP/CORP headers (see platform/isolation-headers.ts).
 *  4. Update flow: a new worker waits; the page asks it to take over with `{type:'SKIP_WAITING'}`
 *     (see platform/sw-register.ts). First install activates immediately and claims clients.
 */

import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import type { WorkboxPlugin } from 'workbox-core';
import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  addPlugins,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { withIsolationHeaders } from './platform/isolation-headers';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

/** Bump to discard every runtime cache (e.g. after an incompatible kernel ABI change). */
const CACHE_VERSION = 'v1';

setCacheNameDetails({
  prefix: 'whittle',
  suffix: CACHE_VERSION,
  precache: 'precache',
  runtime: 'runtime',
});

const KERNEL_CACHE = `whittle-kernel-${CACHE_VERSION}`;

/** Adds COOP/COEP/CORP to whatever response a strategy is about to return. */
const isolationPlugin: WorkboxPlugin = {
  handlerWillRespond: async ({ response }) => withIsolationHeaders(response),
};

// Precached responses go through the same plugin.
addPlugins([isolationPlugin]);
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigations (deep links, hash routes) always get the precached shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// Kernel: cache on first use, then serve from cache forever (hashed file names change on update).
registerRoute(
  ({ sameOrigin, url }) =>
    sameOrigin &&
    (url.pathname.endsWith('.wasm') || /\/whittle-kernel[^/]*\.js$/.test(url.pathname)),
  new CacheFirst({
    cacheName: KERNEL_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 8, purgeOnQuotaError: true }),
      isolationPlugin,
    ],
  }),
);

// Everything else on our origin (lazy chunks, worker scripts, fixtures): network, but still
// isolation-stamped so dedicated workers started by an isolated page are themselves isolated.
registerRoute(({ sameOrigin }) => sameOrigin, new NetworkOnly({ plugins: [isolationPlugin] }));

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop caches left by older CACHE_VERSIONs (`whittle-<kind>-v<N>`).
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (/^whittle-(precache|runtime|kernel)-/.test(key) && !key.endsWith(`-${CACHE_VERSION}`)) {
          await caches.delete(key);
        }
      }
    })(),
  );
});

clientsClaim();
