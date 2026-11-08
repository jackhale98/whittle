/**
 * What the service worker (src/sw.ts) may touch. Pure, shared with unit tests.
 *
 * Rules (PLAN §8A.2, ADR-010):
 *  - The worker only ever handles same-origin requests. Provider traffic (Dropbox, Graph, Google
 *    APIs, WebDAV hosts, the sync Worker, git proxies, OAuth token endpoints) is cross-origin CORS
 *    `fetch`; it is left alone, so it is never cached, never rebuilt, and the browser's own CORS
 *    check against `Cross-Origin-Embedder-Policy: require-corp` applies unchanged.
 *  - A request carrying an `Authorization` header is never handled or cached, even same-origin.
 *  - Navigations (including an OAuth redirect back with `?code=...&state=...`) are answered with
 *    the precached shell by URL-fixed handler; the browser keeps the original URL, query and hash.
 *    Nothing here rewrites or redirects a navigation.
 *  - Only the kernel is runtime-cached, and only hashed kernel files.
 */

export interface RouteMatchInput {
  sameOrigin: boolean;
  request: Pick<Request, 'headers'>;
}

/** True when the worker may handle (and so possibly cache or re-stamp) this request at all. */
export function mayHandle({ sameOrigin, request }: RouteMatchInput): boolean {
  if (!sameOrigin) return false;
  if (request.headers.has('authorization')) return false;
  return true;
}

/** Kernel Wasm and glue (`*.wasm`, `whittle-kernel*.js`): the only runtime-cached files. */
export function isKernelAsset(url: Pick<URL, 'pathname'>): boolean {
  return url.pathname.endsWith('.wasm') || /\/whittle-kernel[^/]*\.js$/.test(url.pathname);
}
