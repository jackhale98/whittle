import { describe, expect, it } from 'vitest';
import {
  COEP_VALUE,
  ISOLATION_HEADERS,
  isUnrewritable,
  withIsolationHeaders,
} from './isolation-headers';

function opaque(type: ResponseType): Response {
  // Response.type is read-only; emulate the browser-created opaque kinds.
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'type', { value: type });
  Object.defineProperty(response, 'status', { value: 0 });
  return response;
}

describe('already isolated responses (Cloudflare Pages _headers, PLAN §8.2)', () => {
  const stamped = () =>
    new Response('x', {
      status: 200,
      headers: { ...ISOLATION_HEADERS, 'content-type': 'text/html' },
    });

  it('are returned untouched: the shim is a no-op', () => {
    const original = stamped();
    expect(withIsolationHeaders(original)).toBe(original);
  });

  it('are still rebuilt when redirected or when a policy differs', () => {
    const redirected = stamped();
    Object.defineProperty(redirected, 'redirected', { value: true });
    expect(withIsolationHeaders(redirected)).not.toBe(redirected);
    const weak = new Response('x', {
      headers: { ...ISOLATION_HEADERS, 'Cross-Origin-Embedder-Policy': 'credentialless' },
    });
    expect(withIsolationHeaders(weak).headers.get('cross-origin-embedder-policy')).toBe(
      'require-corp',
    );
  });
});

describe('withIsolationHeaders', () => {
  it('adds COOP, COEP and CORP and keeps status, body and other headers', async () => {
    const original = new Response('<html></html>', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html', 'cache-control': 'max-age=600' },
    });
    const result = withIsolationHeaders(original);
    expect(result).not.toBe(original);
    expect(result.status).toBe(200);
    expect(result.statusText).toBe('OK');
    expect(result.headers.get('content-type')).toBe('text/html');
    expect(result.headers.get('cache-control')).toBe('max-age=600');
    expect(result.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(result.headers.get('cross-origin-embedder-policy')).toBe(COEP_VALUE);
    expect(result.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(await result.text()).toBe('<html></html>');
  });

  it('uses require-corp (Safari has no credentialless)', () => {
    expect(ISOLATION_HEADERS['Cross-Origin-Embedder-Policy']).toBe('require-corp');
  });

  it('overrides conflicting upstream policies', () => {
    const result = withIsolationHeaders(
      new Response('x', {
        headers: {
          'cross-origin-embedder-policy': 'unsafe-none',
          'cross-origin-opener-policy': 'unsafe-none',
        },
      }),
    );
    expect(result.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(result.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('keeps content-length for plain responses (download progress UI)', () => {
    const result = withIsolationHeaders(
      new Response('abcd', { headers: { 'content-length': '4' } }),
    );
    expect(result.headers.get('content-length')).toBe('4');
  });

  it('drops stale content-encoding/content-length from already-decoded bodies', () => {
    const result = withIsolationHeaders(
      new Response('abcd', { headers: { 'content-encoding': 'gzip', 'content-length': '2' } }),
    );
    expect(result.headers.has('content-encoding')).toBe(false);
    expect(result.headers.has('content-length')).toBe(false);
  });

  it('handles bodyless statuses (204, 304) without throwing', () => {
    const noContent = withIsolationHeaders(new Response(null, { status: 204 }));
    expect(noContent.status).toBe(204);
    expect(noContent.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    // 304 cannot be rebuilt by the Response constructor in browsers that reject >=300 bodies;
    // it must at least never throw here.
    expect(() => withIsolationHeaders(new Response(null, { status: 304 }))).not.toThrow();
  });

  it('preserves error statuses', () => {
    const result = withIsolationHeaders(
      new Response('nope', { status: 404, statusText: 'Not Found' }),
    );
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
    expect(result.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('passes opaque, opaque-redirect and error responses through untouched', () => {
    for (const type of ['opaque', 'opaqueredirect'] as const) {
      const response = opaque(type);
      expect(isUnrewritable(response)).toBe(true);
      expect(withIsolationHeaders(response)).toBe(response);
    }
    const error = Response.error();
    expect(withIsolationHeaders(error)).toBe(error);
  });

  it('rebuilds redirected responses (clears the redirected flag)', () => {
    const redirected = new Response('final', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const result = withIsolationHeaders(redirected);
    expect(result.redirected).toBe(false);
    expect(result.status).toBe(200);
  });
});
