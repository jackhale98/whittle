// Ported from Mycelium src/lib/dropbox/api.test.ts.
import { describe, expect, it } from 'vitest';
import {
  apiArg,
  DropboxProvider,
  dropboxAuthorizeUrl,
  exchangeDropboxCode,
  refreshDropboxToken,
} from '../../src/providers/dropbox';
import { dec, enc, fakeFetch, header, json, must, tok } from '../support/fetch';

describe('Dropbox provider', () => {
  it('escapes non-ASCII characters in API arguments', () => {
    expect(apiArg({ path: '/CAD/café.json' })).toBe('{"path":"/CAD/caf\\u00e9.json"}');
  });

  it('lists every page of a folder, skipping the cache', async () => {
    const { calls, fetcher } = fakeFetch([
      json({
        entries: [
          { '.tag': 'file', path_display: '/P/a.json', path_lower: '/p/a.json', rev: '1', size: 3 },
          {
            '.tag': 'file',
            path_display: '/P/.wren/m.bin',
            path_lower: '/p/.wren/m.bin',
            rev: '9',
          },
        ],
        cursor: 'c1',
        has_more: true,
      }),
      json({
        entries: [
          { '.tag': 'deleted', path_display: '/P/b.json', path_lower: '/p/b.json' },
          {
            '.tag': 'file',
            path_display: '/P/.wren-history/versions/v.json',
            path_lower: '/p/.wren-history/versions/v.json',
            rev: '2',
          },
        ],
        cursor: 'c2',
        has_more: false,
      }),
    ]);
    const r = must(await new DropboxProvider(tok, fetcher).list({ path: '/P' }));
    expect(r.cursor).toBe('c2');
    expect(r.complete).toBe(true);
    expect(r.entries).toEqual([
      { kind: 'file', path: '/P/a.json', rev: '1', size: 3 },
      { kind: 'deleted', path: '/P/b.json' },
      { kind: 'file', path: '/P/.wren-history/versions/v.json', rev: '2' },
    ]);
    expect(calls[0]!.url).toMatch(/files\/list_folder$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      path: '/P',
      recursive: true,
    });
    expect(calls[1]!.url).toMatch(/list_folder\/continue$/);
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer tok');
  });

  it('reports an expired cursor as CURSOR_EXPIRED', async () => {
    const { fetcher } = fakeFetch([json({ error_summary: 'reset/..' }, 409)]);
    const r = await new DropboxProvider(tok, fetcher).list({ cursor: 'old' });
    expect(r.ok || r.error.code).toBe('CURSOR_EXPIRED');
  });

  it('downloads bytes with their revision', async () => {
    const { calls, fetcher } = fakeFetch([
      new Response('{"a":1}\n', { headers: { 'Dropbox-API-Result': '{"rev":"abc"}' } }),
    ]);
    const r = must(await new DropboxProvider(tok, fetcher).read('/P/a.json'));
    expect(dec(r.bytes)).toBe('{"a":1}\n');
    expect(r.rev).toBe('abc');
    expect(header(calls[0]!, 'Dropbox-API-Arg')).toBe('{"path":"/P/a.json"}');
  });

  it('uploads against a revision and reports conflicts as values', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ rev: 'r2', path_display: '/P/a.json' }),
      json({ error_summary: 'path/conflict/file/..' }, 409),
      json({ error_summary: 'path/insufficient_space/..' }, 409),
    ]);
    const api = new DropboxProvider(tok, fetcher);
    expect(must(await api.write('/P/a.json', enc('x'), 'r1'))).toEqual({ rev: 'r2' });
    expect(JSON.parse(header(calls[0]!, 'Dropbox-API-Arg')!)).toMatchObject({
      mode: { '.tag': 'update', update: 'r1' },
      strict_conflict: true,
      autorename: false,
    });
    const c = await api.write('/P/b.json', enc('y'), null);
    expect(c.ok || c.error.code).toBe('CONFLICT');
    expect(JSON.parse(header(calls[1]!, 'Dropbox-API-Arg')!).mode).toEqual({ '.tag': 'add' });
    const q = await api.write('/P/c.json', enc('z'), null);
    expect(q.ok || q.error.code).toBe('QUOTA');
  });

  it('deletes against the parent revision; a missing file is done', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ error_summary: 'path_lookup/not_found/..' }, 409),
      json({ error_summary: 'path_lookup/conflict/..' }, 409),
    ]);
    const api = new DropboxProvider(tok, fetcher);
    must(await api.remove('/P/gone.json', 'r1'));
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      path: '/P/gone.json',
      parent_rev: 'r1',
    });
    const c = await api.remove('/P/a.json', 'r1');
    expect(c.ok || c.error.code).toBe('CONFLICT');
  });

  it('retries once with a fresh token after a 401, then reports AUTH', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ error_summary: 'expired_access_token/' }, 401),
      json({ name: { display_name: 'Ada' }, email: 'ada@example.com' }),
      json({}, 401),
      json({}, 401),
    ]);
    const forced: boolean[] = [];
    const api = new DropboxProvider(async (force) => {
      forced.push(!!force);
      return { ok: true, value: force ? 'fresh' : 'old' };
    }, fetcher);
    expect(must(await api.account())).toEqual({ name: 'Ada', email: 'ada@example.com' });
    expect(forced).toEqual([false, true]);
    expect(header(calls[1]!, 'Authorization')).toBe('Bearer fresh');
    const r = await api.read('/P/a.json');
    expect(r.ok || r.error.code).toBe('AUTH');
    expect(r.ok || r.error.message).not.toContain('fresh');
  });

  it('reports no network as OFFLINE and 429 as RATE_LIMITED with the wait', async () => {
    const { fetcher } = fakeFetch([
      new TypeError('Failed to fetch'),
      new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
    ]);
    const api = new DropboxProvider(tok, fetcher);
    const off = await api.read('/P/a.json');
    expect(off.ok || off.error.code).toBe('OFFLINE');
    const slow = await api.read('/P/a.json');
    expect(slow.ok || slow.error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 });
  });
});

describe('Dropbox sign-in', () => {
  it('builds a PKCE authorize link asking for offline access and minimal scopes', () => {
    const url = new URL(dropboxAuthorizeUrl('key', 'https://x.test/auth/callback/', 'st', 'ch'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'key',
      response_type: 'code',
      redirect_uri: 'https://x.test/auth/callback/',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: 'account_info.read files.metadata.read files.content.read files.content.write',
    });
  });

  it('exchanges the code with the verifier and no secret', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'a', refresh_token: 'r', expires_in: 14400 }),
    ]);
    const t = must(
      await exchangeDropboxCode(
        { appKey: 'key', code: 'c', verifier: 'v', redirectUri: 'https://x.test/cb' },
        fetcher,
        1000,
      ),
    );
    expect(t).toEqual({
      kind: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1000 + 14400 * 1000,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.init.body as string))).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      client_id: 'key',
      code_verifier: 'v',
      redirect_uri: 'https://x.test/cb',
    });
  });

  it('refreshes and keeps the refresh token', async () => {
    const { fetcher } = fakeFetch([json({ access_token: 'b', expires_in: 100 })]);
    expect(must(await refreshDropboxToken('key', 'r', fetcher, 0))).toEqual({
      kind: 'oauth',
      accessToken: 'b',
      refreshToken: 'r',
      expiresAt: 100000,
    });
  });

  it('surfaces token errors as values', async () => {
    const { fetcher } = fakeFetch([
      json({ error: 'invalid_grant', error_description: 'code doesn’t exist' }, 400),
    ]);
    const r = await exchangeDropboxCode(
      { appKey: 'k', code: 'c', verifier: 'v', redirectUri: 'u' },
      fetcher,
    );
    expect(r.ok || r.error).toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('code doesn’t exist'),
    });
  });
});
