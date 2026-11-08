/**
 * Build-time provider configuration for connections and sync (PLAN §8A.2). Config only: no UI, no
 * network, no sync logic. Every value is a PUBLIC client id or URL baked into the bundle from
 * `VITE_*` variables (GitHub repository *variables*, never secrets; see docs/SYNC_SETUP.md). Client
 * secrets live only in the sync Worker (worker/).
 *
 * A provider whose configuration is missing is reported unavailable with a human reason. Nothing
 * here throws, so a build without any variable is green and simply offers fewer providers.
 */

export type ProviderId =
  | 'dropbox'
  | 'onedrive'
  | 'gdrive'
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'git-token'
  | 'webdav';

export interface SyncConfig {
  dropboxAppKey?: string;
  onedriveClientId?: string;
  gdriveClientId?: string;
  /** Origin of the deployed sync Worker, no trailing slash. Absent or invalid: undefined. */
  syncWorkerUrl?: string;
  /** Why `VITE_SYNC_WORKER_URL` was ignored, if it was set but unusable. */
  syncWorkerUrlProblem?: string;
  /** Git smart-HTTP proxy base URL, no trailing slash. Always set (falls back to the dev proxy). */
  gitCorsProxy: string;
  /** True when `gitCorsProxy` is the public development proxy, which sees tokens in transit. */
  gitCorsProxyIsPublicDefault: boolean;
  githubClientId?: string;
  gitlabClientId?: string;
  bitbucketClientId?: string;
}

export interface ProviderAvailability {
  id: ProviderId;
  label: string;
  available: boolean;
  /** Human reason, present exactly when `available` is false. */
  reason?: string;
  /** Available, but the user should be told something (e.g. a public dev proxy is in use). */
  warning?: string;
}

/** Public isomorphic-git proxy: acceptable for development only; it sees credentials in transit. */
export const DEFAULT_GIT_CORS_PROXY = 'https://cors.isomorphic-git.org';

/** The subset of `import.meta.env` read here. */
export type SyncEnv = Readonly<Record<string, string | boolean | undefined>>;

function text(env: SyncEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Normalises an http(s) URL to its origin plus path without a trailing slash; undefined if invalid. */
function parseBaseUrl(raw: string, allowInsecureLocal: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(allowInsecureLocal && local && url.protocol === 'http:'))
    return undefined;
  if (url.username || url.password) return undefined; // never bake credentials into a bundle
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Reads the configuration from build-time env vars. Pure; never throws. */
export function readSyncConfig(env: SyncEnv = import.meta.env): SyncConfig {
  const workerRaw = text(env, 'VITE_SYNC_WORKER_URL');
  const syncWorkerUrl = workerRaw ? parseBaseUrl(workerRaw, true) : undefined;
  const syncWorkerUrlProblem =
    workerRaw && !syncWorkerUrl
      ? 'VITE_SYNC_WORKER_URL is not a valid https URL (http is allowed for localhost only)'
      : undefined;

  const proxyRaw = text(env, 'VITE_GIT_CORS_PROXY');
  const explicitProxy = proxyRaw ? parseBaseUrl(proxyRaw, true) : undefined;
  // An explicit proxy wins; otherwise our own Worker (it is a git proxy too); otherwise dev default.
  const gitCorsProxy = explicitProxy ?? syncWorkerUrl ?? DEFAULT_GIT_CORS_PROXY;

  return {
    dropboxAppKey: text(env, 'VITE_DROPBOX_APP_KEY'),
    onedriveClientId: text(env, 'VITE_ONEDRIVE_CLIENT_ID'),
    gdriveClientId: text(env, 'VITE_GDRIVE_CLIENT_ID'),
    syncWorkerUrl,
    syncWorkerUrlProblem,
    gitCorsProxy,
    gitCorsProxyIsPublicDefault: gitCorsProxy === DEFAULT_GIT_CORS_PROXY,
    githubClientId: text(env, 'VITE_GITHUB_CLIENT_ID'),
    gitlabClientId: text(env, 'VITE_GITLAB_CLIENT_ID'),
    bitbucketClientId: text(env, 'VITE_BITBUCKET_CLIENT_ID'),
  };
}

/**
 * The redirect URI to register with every OAuth provider and to use in the authorize request: the
 * app's own base URL (`https://jackhale98.github.io/whittle/`, `http://localhost:5173/`). The
 * service worker serves the shell for any navigation in scope and keeps the query string, so the
 * callback needs no dedicated route.
 */
export function oauthRedirectUri(origin: string, base: string): string {
  return `${origin}${base.endsWith('/') ? base : `${base}/`}`;
}

/** Every provider with its availability. Missing configuration is a reason, never an exception. */
export function availableProviders(config: SyncConfig = readSyncConfig()): ProviderAvailability[] {
  const missingKey = (name: string): string => `Not configured in this build (${name} is not set).`;
  const needsWorker = (what: string): string | undefined =>
    config.syncWorkerUrl
      ? undefined
      : `${what} needs the Whittle sync Worker. ${
          config.syncWorkerUrlProblem ?? 'VITE_SYNC_WORKER_URL is not set.'
        }`;

  const entry = (
    id: ProviderId,
    label: string,
    reason: string | undefined,
    warning?: string,
  ): ProviderAvailability =>
    reason
      ? { id, label, available: false, reason }
      : { id, label, available: true, ...(warning ? { warning } : {}) };

  const gitOauth = (id: 'github' | 'gitlab' | 'bitbucket', label: string, clientId?: string) =>
    entry(
      id,
      label,
      !clientId
        ? missingKey(`VITE_${id.toUpperCase()}_CLIENT_ID`)
        : needsWorker(`${label} sign-in`),
    );

  return [
    entry(
      'dropbox',
      'Dropbox',
      config.dropboxAppKey ? undefined : missingKey('VITE_DROPBOX_APP_KEY'),
    ),
    entry(
      'onedrive',
      'OneDrive',
      config.onedriveClientId ? undefined : missingKey('VITE_ONEDRIVE_CLIENT_ID'),
    ),
    entry(
      'gdrive',
      'Google Drive',
      config.gdriveClientId ? undefined : missingKey('VITE_GDRIVE_CLIENT_ID'),
    ),
    gitOauth('github', 'GitHub', config.githubClientId),
    gitOauth('gitlab', 'GitLab', config.gitlabClientId),
    gitOauth('bitbucket', 'Bitbucket', config.bitbucketClientId),
    // Access-token sign-in needs no client id, only a CORS proxy, and one is always configured.
    entry(
      'git-token',
      'Git host (access token)',
      undefined,
      config.gitCorsProxyIsPublicDefault
        ? 'Uses the public development proxy (cors.isomorphic-git.org), which sees your token. Deploy the Whittle sync Worker for real use.'
        : undefined,
    ),
    entry('webdav', 'WebDAV (Nextcloud)', needsWorker('WebDAV')),
  ];
}
