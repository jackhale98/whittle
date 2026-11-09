import { describe, expect, it } from 'vitest';
import { isKernelAsset, mayHandle } from './sw-rules';

const req = (headers: Record<string, string> = {}) => ({ headers: new Headers(headers) });

describe('service worker request rules', () => {
  it('never handles cross-origin (provider API, Worker, WebDAV) requests', () => {
    expect(mayHandle({ sameOrigin: false, request: req() })).toBe(false);
    expect(mayHandle({ sameOrigin: false, request: req({ Authorization: 'Bearer t' }) })).toBe(
      false,
    );
  });

  it('never handles a request that carries Authorization', () => {
    expect(mayHandle({ sameOrigin: true, request: req({ authorization: 'Basic x' }) })).toBe(false);
  });

  it('handles plain same-origin requests', () => {
    expect(mayHandle({ sameOrigin: true, request: req() })).toBe(true);
  });

  it('runtime-caches only kernel files', () => {
    expect(isKernelAsset(new URL('https://x/wren-cad/assets/whittle-kernel-abc.wasm'))).toBe(true);
    expect(isKernelAsset(new URL('https://x/wren-cad/assets/whittle-kernel-st.js'))).toBe(true);
    expect(isKernelAsset(new URL('https://x/wren-cad/api/files.json'))).toBe(false);
    expect(isKernelAsset(new URL('https://x/wren-cad/assets/index-abc.js'))).toBe(false);
  });
});
