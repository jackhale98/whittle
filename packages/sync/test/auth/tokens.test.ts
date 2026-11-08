import { describe, expect, it, vi } from 'vitest';
import { refreshGoogleToken, workerTokenExchange } from '../../src/auth/google';
import { oauthTokenSource, type Refresher, staticToken } from '../../src/auth/tokens';
import { MemoryCredentialVault } from '../../src/vault/vault';
import { fakeFetch, json, must } from '../support/fetch';

const setup = async (expiresAt: number | null, refreshToken: string | null = 'r1') => {
  const vault = new MemoryCredentialVault();
  await vault.set('c', { kind: 'oauth', accessToken: 'a1', refreshToken, expiresAt });
  return vault;
};

describe('oauthTokenSource', () => {
  it('uses the stored token until shortly before it expires', async () => {
    const vault = await setup(100_000);
    const refresh = vi.fn<Refresher>();
    const t = oauthTokenSource({
      connectionId: 'c',
      vault,
      refresh,
      service: 'Dropbox',
      now: () => 0,
    });
    expect(must(await t())).toBe('a1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when due or forced, once for parallel callers, and saves to the vault', async () => {
    const vault = await setup(30_000);
    const refresh = vi.fn<Refresher>(async () => ({
      ok: true,
      value: { kind: 'oauth', accessToken: 'a2', refreshToken: null, expiresAt: 999_999 },
    }));
    const t = oauthTokenSource({
      connectionId: 'c',
      vault,
      refresh,
      service: 'Dropbox',
      now: () => 0,
    });
    const [x, y] = await Promise.all([t(), t()]);
    expect([must(x), must(y)]).toEqual(['a2', 'a2']);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refresh token is kept when the service doesn't send a new one.
    expect(await vault.get('c')).toEqual({
      kind: 'oauth',
      accessToken: 'a2',
      refreshToken: 'r1',
      expiresAt: 999_999,
    });
    expect(must(await t(true))).toBe('a2');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('treats offline as offline and a refused refresh as signed out', async () => {
    const vault = await setup(0);
    let code: 'OFFLINE' | 'AUTH' = 'OFFLINE';
    const t = oauthTokenSource({
      connectionId: 'c',
      vault,
      refresh: async () => ({ ok: false, error: { code, message: 'x' } }),
      service: 'OneDrive',
      now: () => 10,
    });
    const off = await t();
    expect(off.ok || off.error.code).toBe('OFFLINE');
    code = 'AUTH';
    const out = await t();
    expect(out.ok || out.error).toEqual({
      code: 'AUTH',
      message: 'OneDrive signed you out. Sign in again.',
    });
    const none = oauthTokenSource({
      connectionId: 'missing',
      vault,
      refresh: vi.fn(),
      service: 'Dropbox',
    });
    expect((await none()).ok).toBe(false);
  });

  it('static tokens refuse a forced refresh', async () => {
    expect(must(await staticToken('pat')())).toBe('pat');
    expect((await staticToken('pat')(true)).ok).toBe(false);
  });
});

describe('Worker token exchange (Google)', () => {
  it('posts JSON to /oauth/<provider>/<action> and reads JSON or form answers', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'ya29.b', expires_in: 3600 }),
      new Response('access_token=t2&expires_in=60', { status: 200 }),
      json(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        400,
      ),
    ]);
    const exchange = workerTokenExchange('https://w.test/', fetcher);
    const r = must(await refreshGoogleToken(exchange, 'g-r', 0));
    expect(r).toEqual({
      kind: 'oauth',
      accessToken: 'ya29.b',
      refreshToken: 'g-r',
      expiresAt: 3_600_000,
    });
    expect(calls[0]!.url).toBe('https://w.test/oauth/google/refresh');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ refresh_token: 'g-r' });
    expect(must(await refreshGoogleToken(exchange, 'g-r', 0)).accessToken).toBe('t2');
    const bad = await refreshGoogleToken(exchange, 'g-r', 0);
    expect(bad.ok || bad.error.code).toBe('AUTH');
  });
});
