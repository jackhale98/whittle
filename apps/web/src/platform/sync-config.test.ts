import { describe, expect, it } from 'vitest';
import {
  availableProviders,
  DEFAULT_GIT_CORS_PROXY,
  oauthRedirectUri,
  type ProviderId,
  readSyncConfig,
} from './sync-config';

const byId = (env: Record<string, string | undefined>) =>
  Object.fromEntries(availableProviders(readSyncConfig(env)).map((p) => [p.id, p])) as Record<
    ProviderId,
    ReturnType<typeof availableProviders>[number]
  >;

describe('readSyncConfig', () => {
  it('is empty-safe: no variables, no throw, development proxy default', () => {
    const c = readSyncConfig({});
    expect(c.dropboxAppKey).toBeUndefined();
    expect(c.syncWorkerUrl).toBeUndefined();
    expect(c.gitCorsProxy).toBe(DEFAULT_GIT_CORS_PROXY);
    expect(c.gitCorsProxyIsPublicDefault).toBe(true);
  });

  it('treats empty and whitespace values (unset repository variables) as missing', () => {
    const c = readSyncConfig({ VITE_DROPBOX_APP_KEY: '', VITE_GDRIVE_CLIENT_ID: '  ' });
    expect(c.dropboxAppKey).toBeUndefined();
    expect(c.gdriveClientId).toBeUndefined();
  });

  it('normalises the worker URL and uses it as the git proxy unless one is given', () => {
    const c = readSyncConfig({ VITE_SYNC_WORKER_URL: 'https://sync.example.workers.dev/' });
    expect(c.syncWorkerUrl).toBe('https://sync.example.workers.dev');
    expect(c.gitCorsProxy).toBe('https://sync.example.workers.dev');
    expect(c.gitCorsProxyIsPublicDefault).toBe(false);
    const d = readSyncConfig({
      VITE_SYNC_WORKER_URL: 'https://sync.example.workers.dev',
      VITE_GIT_CORS_PROXY: 'https://proxy.example/git/',
    });
    expect(d.gitCorsProxy).toBe('https://proxy.example/git');
  });

  it('rejects insecure, malformed and credentialed URLs without throwing', () => {
    for (const bad of ['http://sync.example.com', 'not a url', 'https://u:p@sync.example.com']) {
      const c = readSyncConfig({ VITE_SYNC_WORKER_URL: bad });
      expect(c.syncWorkerUrl, bad).toBeUndefined();
      expect(c.syncWorkerUrlProblem, bad).toMatch(/not a valid https URL/);
    }
    expect(readSyncConfig({ VITE_SYNC_WORKER_URL: 'http://localhost:8787' }).syncWorkerUrl).toBe(
      'http://localhost:8787',
    );
    expect(readSyncConfig({ VITE_GIT_CORS_PROXY: 'javascript:alert(1)' }).gitCorsProxy).toBe(
      DEFAULT_GIT_CORS_PROXY,
    );
  });
});

describe('availableProviders', () => {
  it('reports every key-based provider unavailable with a reason that names the variable', () => {
    const p = byId({});
    expect(p.dropbox.available).toBe(false);
    expect(p.dropbox.reason).toContain('VITE_DROPBOX_APP_KEY');
    expect(p.onedrive.reason).toContain('VITE_ONEDRIVE_CLIENT_ID');
    expect(p.gdrive.reason).toContain('VITE_GDRIVE_CLIENT_ID');
    expect(p.github.reason).toContain('VITE_GITHUB_CLIENT_ID');
    for (const entry of Object.values(p)) expect(entry.available === !entry.reason).toBe(true);
  });

  it('enables providers as their keys appear', () => {
    const p = byId({
      VITE_DROPBOX_APP_KEY: 'k',
      VITE_ONEDRIVE_CLIENT_ID: 'o',
      VITE_GDRIVE_CLIENT_ID: 'g',
    });
    expect(p.dropbox.available && p.onedrive.available && p.gdrive.available).toBe(true);
  });

  it('git OAuth and WebDAV need the Worker as well as a client id', () => {
    expect(byId({ VITE_GITHUB_CLIENT_ID: 'x' }).github.reason).toContain('sync Worker');
    expect(byId({ VITE_SYNC_WORKER_URL: 'https://w.example' }).github.reason).toContain(
      'VITE_GITHUB_CLIENT_ID',
    );
    const ready = byId({
      VITE_GITHUB_CLIENT_ID: 'x',
      VITE_GITLAB_CLIENT_ID: 'y',
      VITE_BITBUCKET_CLIENT_ID: 'z',
      VITE_SYNC_WORKER_URL: 'https://w.example',
    });
    expect(ready.github.available && ready.gitlab.available && ready.bitbucket.available).toBe(
      true,
    );
    expect(ready.webdav.available).toBe(true);
    expect(byId({}).webdav.available).toBe(false);
  });

  it('token sign-in is always available but warns while the public dev proxy is in use', () => {
    expect(byId({})['git-token'].available).toBe(true);
    expect(byId({})['git-token'].warning).toContain('public development proxy');
    expect(
      byId({ VITE_SYNC_WORKER_URL: 'https://w.example' })['git-token'].warning,
    ).toBeUndefined();
  });

  it('surfaces a bad worker URL as the reason', () => {
    expect(byId({ VITE_SYNC_WORKER_URL: 'http://evil.example' }).webdav.reason).toContain(
      'not a valid https URL',
    );
  });
});

describe('oauthRedirectUri', () => {
  it('is the app base URL with a trailing slash', () => {
    expect(oauthRedirectUri('https://jackhale98.github.io', '/whittle/')).toBe(
      'https://jackhale98.github.io/whittle/',
    );
    expect(oauthRedirectUri('http://localhost:5173', '/')).toBe('http://localhost:5173/');
    expect(oauthRedirectUri('http://localhost:5173', '/x')).toBe('http://localhost:5173/x/');
  });
});
