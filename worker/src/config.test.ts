import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';

const ORIGIN = 'https://app.example';
const env: Env = {
  ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:5173`,
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'shh',
};
const refs = '/info/refs?service=git-upload-pack';
const ok = () => vi.fn(async () => new Response('refs'));

function call(path: string, e: Env, init: RequestInit = {}, origin = ORIGIN) {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  return worker.fetch(new Request(`https://proxy.example${path}`, { ...init, headers }), e);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wren worker configuration', () => {
  it('allows self-hosted Forgejo hosts only when they are listed', async () => {
    vi.stubGlobal('fetch', ok());
    expect((await call(`/forgejo.example.org/a/b.git${refs}`, env)).status).toBe(403);
    const withHost = { ...env, EXTRA_GIT_HOSTS: 'forgejo.example.org' };
    expect((await call(`/forgejo.example.org/a/b.git${refs}`, withHost)).status).toBe(200);
  });

  it('serves the configured Pages origin and localhost, and nothing else', async () => {
    vi.stubGlobal('fetch', ok());
    const cfg = {
      ...env,
      ALLOWED_ORIGINS: 'https://jackhale98.github.io,http://localhost:5173',
    };
    const as = async (origin: string) =>
      (await call(`/github.com/a/b.git${refs}`, cfg, {}, origin)).status;
    expect(await as('https://jackhale98.github.io')).toBe(200);
    expect(await as('http://localhost:5173')).toBe(200);
    expect(await as('https://jackhale98.github.io.evil.example')).toBe(403);
    expect(await as('http://localhost:9999')).toBe(403);
  });

  it('has no reminder or push routes', async () => {
    const res = await call('/push/reminders', env, { method: 'PUT', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('never logs and never returns the client secret', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"bad_verification_code"}', { status: 400 })),
    );
    const res = await call('/oauth/github/token', env, { method: 'POST', body: '{"code":"c"}' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('shh');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
