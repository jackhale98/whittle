// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/dropbox/api.ts (errors as values, bytes instead of text).
/**
 * A small Dropbox API client for the browser. Dropbox allows cross-origin calls and PKCE
 * sign-in, so the page talks to Dropbox directly: no proxy, no client secret, and tokens never
 * leave the browser except to Dropbox. Revisions are Dropbox `rev`s; uploads use `update` mode
 * with `strict_conflict`, so a file changed elsewhere is a `CONFLICT`, never an overwrite.
 */

import type {
  RemoteEntry,
  RemoteFolder,
  RemoteListing,
  StorageProvider,
  StorageResult,
} from '@wren-cad/contracts';
import { MANIFEST_FILE } from '@wren-cad/document';
import type { OAuthCredential } from '../auth/types';
import {
  baseName,
  body,
  defaultFetch,
  type Fetcher,
  fail,
  forward,
  httpFailure,
  joinPath,
  ok,
  pool,
  request,
  SKIP_FOLDERS,
  type TokenGetter,
} from './common';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
export const DROPBOX_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
/** Minimal scopes: read the account name, list, read and write files (the app's own folder). */
export const DROPBOX_SCOPES =
  'account_info.read files.metadata.read files.content.read files.content.write';

const SERVICE = 'Dropbox';

/** Header values must be ASCII; Dropbox wants other characters as JSON \u escapes. */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

interface Raw {
  '.tag': 'file' | 'folder' | 'deleted';
  path_display?: string;
  path_lower?: string;
  name?: string;
  rev?: string;
  size?: number;
}

const entry = (e: Raw): RemoteEntry => ({
  kind: e['.tag'],
  path: e.path_display ?? e.path_lower ?? e.name ?? '',
  ...(e.rev ? { rev: e.rev } : {}),
  ...(typeof e.size === 'number' ? { size: e.size } : {}),
});

/** Inside a folder providers never sync (`.wren/`, `.git/`), relative to the listed root? */
const skipped = (path: string): boolean =>
  path.split('/').some((part) => SKIP_FOLDERS.has(part.toLowerCase()));

interface Page {
  entries: Raw[];
  cursor: string;
  has_more: boolean;
}

/** Dropbox's own error summary, e.g. `path/conflict/file/..`. */
async function summaryOf(res: Response): Promise<string> {
  try {
    const b = (await res.clone().json()) as { error_summary?: string; error?: string };
    return b.error_summary ?? (typeof b.error === 'string' ? b.error : '');
  } catch {
    return '';
  }
}

export class DropboxProvider implements StorageProvider {
  readonly kind = 'dropbox' as const;
  readonly caseSensitive = false;
  readonly pollMs = 60_000;

  constructor(
    private readonly token: TokenGetter,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  async #call(url: string, init: RequestInit, retried = false): Promise<StorageResult<Response>> {
    const t = await this.token(retried);
    if (!t.ok) return forward(t);
    const r = await request(this.fetcher, SERVICE, url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t.value}` },
    });
    if (!r.ok) return r;
    if (r.value.status === 401 && !retried) return this.#call(url, init, true);
    if (r.value.status === 401) return fail('AUTH', 'Dropbox signed you out. Sign in again.');
    return r;
  }

  /** Maps a failed response, recognising Dropbox's error summaries. */
  async #failure<T>(res: Response, path?: string): Promise<StorageResult<T>> {
    const summary = await summaryOf(res);
    const where = path ? { path } : {};
    if (/^reset/.test(summary)) {
      return fail('CURSOR_EXPIRED', 'Dropbox: the change list expired; listing again.', where);
    }
    if (/not_found/.test(summary)) {
      return fail('NOT_FOUND', `Dropbox: ‘${path ?? ''}’ isn't there.`, {
        ...where,
        status: res.status,
      });
    }
    if (/insufficient_space|insufficient_quota/.test(summary)) {
      return fail('QUOTA', 'Dropbox is out of space.', { ...where, status: res.status });
    }
    if (/conflict|parent_rev/.test(summary)) {
      return fail('CONFLICT', `Dropbox: ‘${path ?? ''}’ changed elsewhere.`, {
        ...where,
        status: res.status,
      });
    }
    if (res.status === 409)
      return fail('REMOTE', `Dropbox: ${summary || 'request refused'}`, where);
    return httpFailure(SERVICE, res, summary, path);
  }

  async #rpc<T>(endpoint: string, payload: unknown, path?: string): Promise<StorageResult<T>> {
    const r = await this.#call(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return forward(r);
    if (!r.value.ok) return this.#failure(r.value, path);
    return ok((await r.value.json()) as T);
  }

  async account(): Promise<StorageResult<{ name: string; email: string }>> {
    const r = await this.#rpc<{ name: { display_name: string }; email: string }>(
      'users/get_current_account',
      null,
    );
    return r.ok ? ok({ name: r.value.name.display_name, email: r.value.email }) : forward(r);
  }

  /** Every page of a folder listing (`recursive`) or of the changes since a cursor. */
  async #pages(
    start: { path: string; recursive: boolean } | { cursor: string },
  ): Promise<StorageResult<{ entries: RemoteEntry[]; cursor: string }>> {
    let page =
      'cursor' in start
        ? await this.#rpc<Page>('files/list_folder/continue', { cursor: start.cursor })
        : await this.#rpc<Page>(
            'files/list_folder',
            {
              path: start.path,
              recursive: start.recursive,
              include_deleted: false,
              include_non_downloadable_files: false,
            },
            start.path,
          );
    if (!page.ok) return forward(page);
    const entries = page.value.entries.map(entry);
    while (page.value.has_more) {
      page = await this.#rpc<Page>('files/list_folder/continue', { cursor: page.value.cursor });
      if (!page.ok) return forward(page);
      entries.push(...page.value.entries.map(entry));
    }
    return ok({ entries, cursor: page.value.cursor });
  }

  async list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    const r = await this.#pages('cursor' in start ? start : { path: start.path, recursive: true });
    if (!r.ok) return forward(r);
    const root = 'path' in start ? start.path.toLowerCase() : '';
    const entries = r.value.entries.filter((e) => !skipped(e.path.slice(root.length)));
    return ok({ entries, cursor: r.value.cursor, complete: 'path' in start });
  }

  async read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    const r = await this.#call(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': apiArg({ path }) },
    });
    if (!r.ok) return forward(r);
    const res = r.value;
    if (!res.ok) return this.#failure(res, path);
    let rev = '';
    try {
      rev =
        (JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as { rev?: string }).rev ?? '';
    } catch {
      /* no metadata header */
    }
    return ok({ bytes: new Uint8Array(await res.arrayBuffer()), rev });
  }

  async write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    const r = await this.#call(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({
          path,
          mode: ifRev ? { '.tag': 'update', update: ifRev } : { '.tag': 'add' },
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: body(bytes),
    });
    if (!r.ok) return forward(r);
    const res = r.value;
    if (!res.ok) {
      const f = await this.#failure<{ rev: string }>(res, path);
      // Updating a revision that no longer exists: it changed (or went) elsewhere.
      if (!f.ok && f.error.code === 'NOT_FOUND' && ifRev) {
        return fail('CONFLICT', `Dropbox: ‘${path}’ changed elsewhere.`, { path });
      }
      return f;
    }
    const meta = (await res.json()) as { rev: string };
    return ok({ rev: meta.rev });
  }

  async #revOf(path: string): Promise<StorageResult<string | null>> {
    const r = await this.#rpc<Raw>('files/get_metadata', { path }, path);
    if (r.ok) return ok(r.value['.tag'] === 'file' ? (r.value.rev ?? '') : null);
    return r.error.code === 'NOT_FOUND' ? ok(null) : forward(r);
  }

  async remove(path: string, ifRev: string | null): Promise<StorageResult<void>> {
    if (ifRev === null) {
      // "Only if it doesn't exist": nothing to delete, or someone else's file.
      const now = await this.#revOf(path);
      if (!now.ok) return forward(now);
      return now.value === null
        ? ok(undefined)
        : fail('CONFLICT', `Dropbox: ‘${path}’ exists elsewhere.`, { path });
    }
    const r = await this.#call(`${API}/files/delete_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, parent_rev: ifRev }),
    });
    if (!r.ok) return forward(r);
    if (r.value.ok) return ok(undefined);
    const f = await this.#failure<void>(r.value, path);
    if (!f.ok && f.error.code === 'NOT_FOUND') return ok(undefined);
    return f;
  }

  async browse(path: string): Promise<StorageResult<RemoteFolder[]>> {
    const r = await this.#pages({ path, recursive: false });
    if (!r.ok) return forward(r);
    const folders = r.value.entries
      .filter((e) => e.kind === 'folder' && !baseName(e.path).startsWith('.'))
      .map((e) => ({ name: baseName(e.path), path: e.path, isProject: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const checked = await pool(folders.slice(0, 100), 4, async (f) => {
      const rev = await this.#revOf(joinPath(f.path, MANIFEST_FILE));
      if (rev.ok) f.isProject = rev.value !== null;
      return rev;
    });
    return checked.ok ? ok(folders) : forward(checked);
  }
}

// ------------------------------------------------------------------ sign-in

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function tokens(
  body: TokenBody,
  now: number,
  keepRefresh: string | null = null,
): StorageResult<OAuthCredential> {
  if (!body.access_token) {
    const why = body.error_description || body.error || 'Dropbox sign-in failed';
    // A refused refresh token means signed out; anything else is the server's problem.
    return fail(
      body.error === 'invalid_grant' || body.error === 'invalid_client' ? 'AUTH' : 'REMOTE',
      `Dropbox: ${why}`,
    );
  }
  return ok({
    kind: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? keepRefresh,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
  });
}

/** The authorize URL (PKCE, offline access so a refresh token comes back). */
export function dropboxAuthorizeUrl(
  appKey: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(DROPBOX_AUTHORIZE);
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', DROPBOX_SCOPES);
  return url.toString();
}

async function tokenRequest(
  form: Record<string, string>,
  fetcher: Fetcher,
): Promise<StorageResult<TokenBody>> {
  const r = await request(fetcher, SERVICE, DROPBOX_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!r.ok) return forward(r);
  try {
    return ok((await r.value.json()) as TokenBody);
  } catch {
    return ok({ error: `HTTP ${r.value.status}` });
  }
}

export async function exchangeDropboxCode(
  input: { appKey: string; code: string; verifier: string; redirectUri: string },
  fetcher: Fetcher = defaultFetch,
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.appKey,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    fetcher,
  );
  return r.ok ? tokens(r.value, now) : forward(r);
}

export async function refreshDropboxToken(
  appKey: string,
  refreshToken: string,
  fetcher: Fetcher = defaultFetch,
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey },
    fetcher,
  );
  return r.ok ? tokens(r.value, now, refreshToken) : forward(r);
}
