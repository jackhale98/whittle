// Ported from Mycelium's sync worker tests (jackhale98/mycelium-web, Apache-2.0; see
// ../LICENSE-APACHE-2.0), modified: push tests removed. Combined work GPL-3.0-or-later.
// SPDX-License-Identifier: GPL-3.0-or-later AND Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, isGitRequest, isPublicHost } from './index';

const env: Env = {
  ALLOWED_ORIGINS: 'https://app.example, http://localhost:4321',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'shh',
  DAV_HOSTS: 'cloud.example.com',
};
const ORIGIN = 'https://app.example';
const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
  return worker.fetch(new Request(`https://proxy.example${path}`, { ...init, headers }), env);
};

afterEach(() => vi.unstubAllGlobals());

describe('git proxy', () => {
  it('recognises only smart-HTTP endpoints', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(isGitRequest('GET', '/a/b.git/info/refs', q('service=git-upload-pack'))).toBe(true);
    expect(isGitRequest('GET', '/a/b.git/info/refs', q('service=evil'))).toBe(false);
    expect(isGitRequest('POST', '/a/b.git/git-receive-pack', q(''))).toBe(true);
    expect(isGitRequest('GET', '/a/b.git/git-receive-pack', q(''))).toBe(false);
    expect(isGitRequest('GET', '/login', q(''))).toBe(false);
  });

  it('rejects unknown origins, hosts and paths', async () => {
    expect(
      (await call('/github.com/a/b.git/info/refs?service=git-upload-pack', { origin: null }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('/github.com/a/b.git/info/refs?service=git-upload-pack', {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect((await call('/example.com/a/b.git/info/refs?service=git-upload-pack')).status).toBe(403);
    expect((await call('/github.com/settings/profile')).status).toBe(403);
    expect((await call('/github.com/a/../../b.git/info/refs?service=git-upload-pack')).status).toBe(
      403,
    );
  });

  it('answers preflight with CORS headers', async () => {
    const res = await call('/github.com/a/b.git/git-upload-pack', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('forwards only git headers and streams the response back', async () => {
    const upstream = vi.fn(
      async () =>
        new Response('pack', {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Set-Cookie': 'x=1' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const res = await call('/github.com/a/b.git/git-upload-pack', {
      method: 'POST',
      body: 'want',
      headers: {
        Authorization: 'Basic abc',
        Cookie: 'session=1',
        'Content-Type': 'application/x-git-upload-pack-request',
      },
    });
    expect(await res.text()).toBe('pack');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://github.com/a/b.git/git-upload-pack');
    const sent = new Headers(init.headers);
    expect(sent.get('authorization')).toBe('Basic abc');
    expect(sent.get('cookie')).toBeNull();
    // Redirects are never followed with the forwarded Authorization header.
    expect(init.redirect).toBe('manual');
  });
});

describe('oauth', () => {
  it('adds the client secret and relays the token response', async () => {
    const upstream = vi.fn(
      async () =>
        new Response('{"access_token":"t"}', { headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', upstream);
    const res = await call('/oauth/github/token', {
      method: 'POST',
      body: JSON.stringify({
        code: 'c',
        code_verifier: 'v',
        redirect_uri: 'https://app.example/cb',
      }),
    });
    expect(await res.json()).toEqual({ access_token: 't' });
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://github.com/login/oauth/access_token');
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'https://app.example/cb',
      client_id: 'id',
      client_secret: 'shh',
    });
  });

  it('exchanges Google Drive codes with the client secret (web-application clients need it)', async () => {
    const upstream = vi.fn(async () => new Response('{"access_token":"gd"}'));
    vi.stubGlobal('fetch', upstream);
    const res = await worker.fetch(
      new Request('https://proxy.example/oauth/google/token', {
        method: 'POST',
        headers: { Origin: ORIGIN },
        body: JSON.stringify({
          code: 'c',
          code_verifier: 'v',
          redirect_uri: 'https://app.example/',
        }),
      }),
      { ...env, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs' },
    );
    expect(res.status).toBe(200);
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'gid',
      client_secret: 'gs',
      code_verifier: 'v',
    });
  });

  it('exchanges codes for public GitLab apps without a secret', async () => {
    const upstream = vi.fn(async () => new Response('{"access_token":"g"}'));
    vi.stubGlobal('fetch', upstream);
    const res = await worker.fetch(
      new Request('https://proxy.example/oauth/gitlab/refresh', {
        method: 'POST',
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ refresh_token: 'r', redirect_uri: 'https://app.example/cb' }),
      }),
      { ...env, GITLAB_CLIENT_ID: 'gl' },
    );
    expect(res.status).toBe(200);
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://gitlab.com/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r',
      redirect_uri: 'https://app.example/cb',
      client_id: 'gl',
    });
  });

  it('reports unconfigured providers', async () => {
    expect(
      (await call('/oauth/gitlab/token', { method: 'POST', body: '{"code":"c"}' })).status,
    ).toBe(501);
    expect(
      (await call('/oauth/bitbucket/token', { method: 'POST', body: '{"code":"c"}' })).status,
    ).toBe(501);
    expect((await call('/oauth/nope/token', { method: 'POST', body: '{}' })).status).toBe(404);
    // Google is configured per worker; without its id and secret it reports what's missing.
    expect(
      (await call('/oauth/google/token', { method: 'POST', body: '{"code":"c"}' })).status,
    ).toBe(501);
  });
});

describe('WebDAV relay', () => {
  const auth = { Authorization: 'Basic YWRhOnB3' };

  it('only relays to public HTTPS host names', () => {
    expect(isPublicHost('cloud.example.com')).toBe(true);
    expect(isPublicHost('cloud.example.com:8443')).toBe(true);
    for (const bad of [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      'nas',
      'nas.local',
      'box.internal',
      'a@b.com',
      '[::1]',
    ])
      expect(isPublicHost(bad), bad).toBe(false);
  });

  it('passes WebDAV requests through with their conditions, and exposes ETags', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('<multistatus/>', {
          status: 207,
          headers: { ETag: '"e1"', 'Set-Cookie': 'x=y', 'Content-Type': 'application/xml' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const res = await call('/dav/cloud.example.com/remote.php/dav/files/ada/Notes/', {
      method: 'PROPFIND',
      headers: { ...auth, Depth: '1', Cookie: 'session=1', 'If-Match': '"e0"' },
      body: '<propfind/>',
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('ETag')).toBe('"e1"');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloud.example.com/remote.php/dav/files/ada/Notes/');
    const sent = new Headers(init.headers);
    expect(sent.get('depth')).toBe('1');
    expect(sent.get('if-match')).toBe('"e0"');
    expect(sent.get('authorization')).toBe(auth.Authorization);
    expect(sent.get('cookie')).toBeNull();
    expect(init.redirect).toBe('manual');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe('<propfind/>');
  });

  it('refuses other methods, anonymous requests, private hosts and hosts not allowed', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await call('/dav/cloud.example.com/x', { method: 'POST', headers: auth })).status).toBe(
      405,
    );
    expect((await call('/dav/cloud.example.com/x', { method: 'GET' })).status).toBe(401);
    expect((await call('/dav/192.168.1.2/x', { method: 'GET', headers: auth })).status).toBe(403);
    // Hex and numeric last labels are IPv4 to URL parsers (0x7f.1 → 127.0.0.1).
    expect(isPublicHost('0x7f.1')).toBe(false);
    expect(isPublicHost('evil.0x7f')).toBe(false);
    expect(isPublicHost('cloud.example.com')).toBe(true);
    // With no DAV_HOSTS the relay is off, unless explicitly opened.
    const { DAV_HOSTS: _unused, ...noHosts } = env;
    const off = await worker.fetch(
      new Request('https://proxy.example/dav/cloud.example.com/x', {
        method: 'GET',
        headers: { Origin: ORIGIN, ...auth },
      }),
      noHosts,
    );
    expect(off.status).toBe(403);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    const open = await worker.fetch(
      new Request('https://proxy.example/dav/cloud.example.com/x', {
        method: 'GET',
        headers: { Origin: ORIGIN, ...auth },
      }),
      { ...noHosts, DAV_OPEN_RELAY: 'true' },
    );
    expect(open.status).toBe(200);
    const pinned = { ...env, DAV_HOSTS: 'mine.example.com' };
    const req = new Request('https://proxy.example/dav/cloud.example.com/x', {
      method: 'GET',
      headers: { ...auth, Origin: ORIGIN },
    });
    expect((await worker.fetch(req, pinned)).status).toBe(403);
  });

  it('holds WebDAV bodies to 20 MB, whether or not they declare a length', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const big = 20 * 1024 * 1024 + 1;
    // Declared too large: refused before reading.
    const declared = await call('/dav/cloud.example.com/x', {
      method: 'PUT',
      headers: { ...auth, 'Content-Length': String(big) },
      body: 'x',
    });
    expect(declared.status).toBe(413);
    // Streamed with no length: refused once the bytes pass the limit.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= big) return c.close();
        sent += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
    const req = new Request('https://proxy.example/dav/cloud.example.com/x', {
      method: 'PUT',
      headers: { ...auth, Origin: ORIGIN },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect((await worker.fetch(req, env)).status).toBe(413);
    expect(sent).toBeLessThan(big + 2 * chunk.byteLength);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers preflights for WebDAV methods and headers', async () => {
    const res = await call('/dav/cloud.example.com/x', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PROPFIND');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('If-Match');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
  });
});
