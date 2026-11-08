// Ported from Mycelium src/lib/auth/oauth.test.ts (cloud sign-in), with the vault and redirects.
import { describe, expect, it, vi } from 'vitest';
import {
  availableServices,
  beginSignIn,
  completeSignIn,
  hasPendingSignIn,
  type SignInStorage,
  takeSignInResult,
} from '../../src/auth/oauth';
import { challengeFor } from '../../src/auth/pkce';
import type { OAuthConfig, TokenExchange } from '../../src/auth/types';
import { MemoryCredentialVault } from '../../src/vault/vault';
import { fakeFetch, json, must } from '../support/fetch';

function memoryStorage(): SignInStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const config: OAuthConfig = {
  dropboxAppKey: 'dbx',
  onedriveClientId: 'ms',
  redirectUri: 'https://app.test/auth/callback/',
};

/** Starts a sign-in and returns the provider URL it navigated to, plus the storage. */
async function begin(
  service: 'dropbox' | 'onedrive' | 'gdrive',
  cfg: OAuthConfig = config,
  options: { renew?: string; sharepoint?: boolean } = {},
) {
  const storage = memoryStorage();
  const navigate = vi.fn<(u: string) => void>();
  must(
    await beginSignIn(
      service,
      cfg,
      { returnTo: '/#/connections', ...options },
      { storage, navigate, now: () => 1000 },
    ),
  );
  const url = new URL(navigate.mock.calls[0]![0]);
  return { storage, url, state: url.searchParams.get('state')! };
}

describe('PKCE', () => {
  it('computes the RFC 7636 S256 challenge', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('OAuth redirect sign-in', () => {
  it('only offers configured services', () => {
    expect(availableServices(config)).toEqual(['dropbox', 'onedrive']);
    expect(availableServices({ redirectUri: 'x' })).toEqual([]);
    const exchange: TokenExchange = async () => ({ ok: true, value: {} });
    expect(
      availableServices({ ...config, gdriveClientId: 'g', tokenExchange: exchange }),
    ).toContain('gdrive');
    expect(availableServices({ ...config, gdriveClientId: 'g' })).not.toContain('gdrive');
  });

  it('leaves by full-page redirect with a PKCE challenge, keeping only the verifier', async () => {
    const { storage, url } = await begin('dropbox');
    expect(url.origin).toBe('https://www.dropbox.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    const pending = JSON.parse([...storage.map.values()][0]!);
    expect(await challengeFor(pending.verifier)).toBe(url.searchParams.get('code_challenge'));
    expect(hasPendingSignIn({ storage })).toBe(true);
  });

  it('trades a Dropbox code with Dropbox itself and puts the tokens only in the vault', async () => {
    const { storage, state } = await begin('dropbox');
    const vault = new MemoryCredentialVault();
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'sl.a', refresh_token: 'r', expires_in: 14400 }),
    ]);
    const cleared = vi.fn();
    const r = must(
      await completeSignIn(new URLSearchParams(`code=xyz&state=${state}`), config, {
        vault,
        fetch: fetcher,
        storage,
        newId: () => 'conn-1',
        clearCallback: cleared,
        now: () => 2000,
      }),
    );
    expect(r).toEqual({
      service: 'dropbox',
      connectionId: 'conn-1',
      renewed: false,
      sharepoint: false,
      returnTo: '/#/connections',
    });
    expect(calls[0]!.url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('client_id')).toBe('dbx');
    expect(await vault.get('conn-1')).toMatchObject({ kind: 'oauth', accessToken: 'sl.a' });
    // Nothing secret is left in sessionStorage; the callback query is stripped after success.
    for (const v of storage.map.values()) {
      expect(v).not.toContain('sl.a');
      expect(v).not.toContain('"r"');
    }
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(takeSignInResult({ storage })).toEqual(r);
    expect(takeSignInResult({ storage })).toBeNull();
    expect(hasPendingSignIn({ storage })).toBe(false);
  });

  it('trades a Microsoft code, repeating the scopes, and renews an existing connection', async () => {
    const { storage, state } = await begin('onedrive', config, {
      renew: 'conn-7',
      sharepoint: true,
    });
    const vault = new MemoryCredentialVault();
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'ey', refresh_token: 'r', expires_in: 3600 }),
    ]);
    const r = must(
      await completeSignIn(new URLSearchParams(`code=xyz&state=${state}`), config, {
        vault,
        fetch: fetcher,
        storage,
        clearCallback: () => undefined,
        now: () => 2000,
      }),
    );
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('client_id')).toBe('ms');
    expect(form.get('code_verifier')).toBeTruthy();
    expect(form.get('scope')).toContain('Sites.Read.All');
    expect(r).toMatchObject({
      service: 'onedrive',
      connectionId: 'conn-7',
      renewed: true,
      sharepoint: true,
    });
  });

  it('trades a Google code through the injected Worker exchange (the secret stays there)', async () => {
    const exchange = vi.fn<TokenExchange>(async () => ({
      ok: true,
      value: { access_token: 'ya29', refresh_token: 'g-r', expires_in: 3599 },
    }));
    const cfg = { ...config, gdriveClientId: 'g-id', tokenExchange: exchange };
    const { storage, url, state } = await begin('gdrive', cfg);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const vault = new MemoryCredentialVault();
    must(
      await completeSignIn(new URLSearchParams(`code=c&state=${state}`), cfg, {
        vault,
        storage,
        newId: () => 'g1',
        clearCallback: () => undefined,
        now: () => 2000,
      }),
    );
    const [provider, action, body] = exchange.mock.calls[0]!;
    expect([provider, action]).toEqual(['google', 'token']);
    expect(body).toMatchObject({ code: 'c', redirect_uri: config.redirectUri });
    expect(body.code_verifier).toBeTruthy();
    expect(await vault.get('g1')).toMatchObject({ accessToken: 'ya29', refreshToken: 'g-r' });
  });

  it('rejects a mismatched state, a denied consent and an expired sign-in, without stripping', async () => {
    const vault = new MemoryCredentialVault();
    const cleared = vi.fn();
    const deps = (storage: SignInStorage, now = 2000) => ({
      vault,
      storage,
      clearCallback: cleared,
      now: () => now,
    });
    const a = await begin('dropbox');
    const r1 = await completeSignIn(
      new URLSearchParams('code=x&state=evil'),
      config,
      deps(a.storage),
    );
    expect(r1.ok || r1.error.message).toMatch(/mismatch/);
    const b = await begin('dropbox');
    const r2 = await completeSignIn(
      new URLSearchParams(`error=access_denied&state=${b.state}`),
      config,
      deps(b.storage),
    );
    expect(r2.ok || r2.error.code).toBe('PERMISSION');
    const c = await begin('dropbox');
    const r3 = await completeSignIn(
      new URLSearchParams(`code=x&state=${c.state}`),
      config,
      deps(c.storage, 1000 + 16 * 60_000),
    );
    expect(r3.ok || r3.error.message).toMatch(/expired/);
    const r4 = await completeSignIn(
      new URLSearchParams('code=x&state=y'),
      config,
      deps(memoryStorage()),
    );
    expect(r4.ok || r4.error.code).toBe('AUTH');
    expect(cleared).not.toHaveBeenCalled();
  });

  it('keeps the callback query when the code exchange fails', async () => {
    const { storage, state } = await begin('dropbox');
    const { fetcher } = fakeFetch([json({ error: 'invalid_grant' }, 400)]);
    const cleared = vi.fn();
    const r = await completeSignIn(new URLSearchParams(`code=x&state=${state}`), config, {
      vault: new MemoryCredentialVault(),
      fetch: fetcher,
      storage,
      clearCallback: cleared,
      now: () => 2000,
    });
    expect(r.ok).toBe(false);
    expect(cleared).not.toHaveBeenCalled();
  });
});
