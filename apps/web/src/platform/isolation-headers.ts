/**
 * Cross-origin isolation header rewrite (PLAN §8.3). Pure functions, shared by the service worker
 * (src/sw.ts) and unit tests. Uses only Fetch types that exist in both DOM and WebWorker libs.
 *
 * COEP choice: `require-corp` for every browser.
 *  - Safari/WebKit (macOS 26, iOS/iPadOS 26.x) has not shipped `Cross-Origin-Embedder-Policy:
 *    credentialless` (caniuse: unsupported through 26.5); it ignores the header and the page never
 *    becomes isolated. All iOS browsers are WebKit, so UA sniffing would also have to cover
 *    CriOS/FxiOS.
 *  - Wren self-hosts every asset, so `require-corp` costs nothing. Using one policy everywhere
 *    means a cross-origin `no-cors` load that would break Safari also breaks Chrome in development,
 *    instead of surfacing only in Safari. CORS-enabled `fetch()` (cloud sync) is unaffected.
 *  - The dev/preview servers and public/_headers send the same value.
 */

export const COOP_VALUE = 'same-origin';
export const COEP_VALUE = 'require-corp';
export const CORP_VALUE = 'same-origin';

export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': COOP_VALUE,
  'Cross-Origin-Embedder-Policy': COEP_VALUE,
  'Cross-Origin-Resource-Policy': CORP_VALUE,
};

/** True if `response` must be passed through untouched (cannot or must not be rebuilt). */
export function isUnrewritable(response: Response): boolean {
  // Opaque (no-cors cross-origin) and opaque-redirect responses have status 0 and hidden
  // headers/body; `new Response()` cannot reproduce them. Statuses outside 200..599 (1xx, and
  // the status 0 of the above) are rejected by the Response constructor.
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return true;
  if (response.status < 200 || response.status > 599) return true;
  // Error responses (`Response.error()`) have type 'error' and status 0, covered above.
  return false;
}

/** True if `response` already carries exactly the isolation policies. */
export function hasIsolationHeaders(response: Response): boolean {
  return Object.entries(ISOLATION_HEADERS).every(
    ([name, value]) => response.headers.get(name) === value,
  );
}

/**
 * Returns a copy of `response` carrying COOP/COEP/CORP. The body stream is passed through (not
 * buffered). Rebuilding also clears `response.redirected`, which the browser would otherwise
 * reject for a service-worker-answered navigation. Unrewritable responses are returned as-is.
 */
export function withIsolationHeaders(response: Response): Response {
  if (isUnrewritable(response)) return response;
  // Served with the headers already (Cloudflare Pages `_headers`, PLAN §8.2; or a response this
  // worker stamped before and cached): nothing to add, so the shim is a no-op. A redirected
  // response is still rebuilt, because the browser rejects one for a worker-answered navigation.
  if (!response.redirected && hasIsolationHeaders(response)) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  // The fetched body is already decoded and a synthetic response is never decoded again, so a
  // stale `content-encoding` (and the encoded `content-length`) would be a lie. Plain responses
  // keep `content-length` so download-progress UI still works.
  if (headers.has('content-encoding')) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
