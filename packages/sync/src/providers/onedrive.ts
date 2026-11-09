// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/onedrive/api.ts (errors as values, bytes instead of text).
/**
 * OneDrive and SharePoint document libraries through Microsoft Graph, straight from the browser:
 * Graph allows cross-origin calls, and sign-in uses PKCE with no client secret (an Entra
 * "single-page application"). Revisions are eTags; writes carry `If-Match` (or fail if the file
 * exists, for new files), so a file changed elsewhere is a `CONFLICT`. Changes come from the
 * drive's `delta` feed.
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

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MS_AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** The signed-in person's own OneDrive (personal or work): no access to other people's files. */
export const ONEDRIVE_SCOPES = 'offline_access User.Read Files.ReadWrite';
/** SharePoint document libraries need the `.All` file scope plus finding sites (work accounts). */
export const SHAREPOINT_SCOPES = 'offline_access User.Read Files.ReadWrite.All Sites.Read.All';

const SERVICE = 'OneDrive';

interface Item {
  id: string;
  name?: string;
  eTag?: string;
  size?: number;
  file?: object;
  folder?: object;
  root?: object;
  deleted?: object;
  parentReference?: { path?: string; id?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

interface Page {
  value: Item[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** The change cursor: Graph's delta link, the project folder and its folders by id. */
interface Cursor {
  delta: string;
  root: string;
  /** Folder id → lower-cased path, to place deletions and spot renamed folders. */
  folders: Record<string, string>;
}

/** Encode a path for Graph's `root:/…:` addressing. */
export function graphPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join('/');
}

/** `/drive/root:/CAD/bracket` (or `/drives/{id}/root:`) → `/CAD/bracket`. */
export function parentPath(ref: string | undefined): string | null {
  if (!ref) return null;
  const i = ref.indexOf('root:');
  if (i < 0) return null;
  try {
    return decodeURIComponent(ref.slice(i + 5));
  } catch {
    return null;
  }
}

const skipName = (name: string | undefined): boolean =>
  !!name && SKIP_FOLDERS.has(name.toLowerCase());
const insideSkipped = (rel: string): boolean =>
  rel.split('/').some((part) => SKIP_FOLDERS.has(part.toLowerCase()));

export interface DriveChoice {
  id: string;
  name: string;
  /** e.g. "OneDrive" or the site's name. */
  owner: string;
}

async function graphSummary(res: Response): Promise<string> {
  try {
    const b = (await res.clone().json()) as { error?: { message?: string; code?: string } };
    return b.error?.message ?? b.error?.code ?? '';
  } catch {
    return '';
  }
}

export class OneDriveProvider implements StorageProvider {
  readonly kind = 'onedrive' as const;
  readonly caseSensitive = false;
  readonly pollMs = 60_000;

  constructor(
    readonly driveId: string,
    private readonly token: TokenGetter,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  /** `/drives/{id}/root` or `/drives/{id}/root:/a/b:` for a path. */
  #item(path: string, suffix = ''): string {
    const p = graphPath(path);
    const base = `${GRAPH}/drives/${encodeURIComponent(this.driveId)}/root`;
    if (!p) return `${base}${suffix ? `/${suffix}` : ''}`;
    return `${base}:/${p}:${suffix ? `/${suffix}` : ''}`;
  }

  async #call(
    url: string,
    init: RequestInit = {},
    retried = false,
  ): Promise<StorageResult<Response>> {
    const t = await this.token(retried);
    if (!t.ok) return forward(t);
    const r = await request(this.fetcher, SERVICE, url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t.value}` },
    });
    if (!r.ok) return r;
    if (r.value.status === 401 && !retried) return this.#call(url, init, true);
    if (r.value.status === 401) return fail('AUTH', 'OneDrive signed you out. Sign in again.');
    return r;
  }

  async #failure<T>(res: Response, path?: string): Promise<StorageResult<T>> {
    if (res.status === 410) {
      return fail('CURSOR_EXPIRED', 'OneDrive: the change list expired; listing again.');
    }
    const summary = await graphSummary(res);
    if (res.status === 507 || /quotaLimitReached/i.test(summary)) {
      return fail('QUOTA', 'OneDrive is out of space.', { status: res.status });
    }
    return httpFailure(SERVICE, res, summary, path);
  }

  async #json<T>(url: string, path?: string): Promise<StorageResult<T>> {
    const r = await this.#call(url);
    if (!r.ok) return forward(r);
    if (!r.value.ok) return this.#failure(r.value, path);
    return ok((await r.value.json()) as T);
  }

  /** Every page of a collection. */
  async #all(
    url: string,
    path?: string,
  ): Promise<StorageResult<{ items: Item[]; deltaLink?: string }>> {
    const items: Item[] = [];
    let next: string | undefined = url;
    let deltaLink: string | undefined;
    while (next) {
      const page: StorageResult<Page> = await this.#json<Page>(next, path);
      if (!page.ok) return forward(page);
      items.push(...page.value.value);
      next = page.value['@odata.nextLink'];
      deltaLink = page.value['@odata.deltaLink'] ?? deltaLink;
    }
    return ok(deltaLink ? { items, deltaLink } : { items });
  }

  #children(path: string) {
    return this.#all(
      `${this.#item(path, 'children')}?$top=999&$select=id,name,eTag,size,file,folder`,
      path,
    );
  }

  /** Walk a folder: its files and its folders (by id), recursively. */
  async #walk(
    root: string,
    folders: Record<string, string>,
  ): Promise<StorageResult<RemoteEntry[]>> {
    const files: RemoteEntry[] = [];
    let level = [root];
    while (level.length) {
      const next: string[] = [];
      const r = await pool(level, 4, async (dir) => {
        const c = await this.#children(dir);
        if (!c.ok) return c;
        for (const it of c.value.items) {
          const path = `${dir}/${it.name}`;
          if (it.folder) {
            if (skipName(it.name)) continue;
            folders[it.id] = path.toLowerCase();
            next.push(path);
          } else if (it.file) {
            files.push({
              kind: 'file',
              path,
              rev: it.eTag ?? '',
              ...(typeof it.size === 'number' ? { size: it.size } : {}),
            });
          }
        }
        return c;
      });
      if (!r.ok) return forward(r);
      level = next;
    }
    return ok(files);
  }

  async #latest(): Promise<StorageResult<string>> {
    const page = await this.#json<Page>(`${this.#item('', 'delta')}?token=latest`);
    if (!page.ok) return forward(page);
    const link = page.value['@odata.deltaLink'];
    return link ? ok(link) : fail('REMOTE', 'OneDrive sent no change link.');
  }

  async #full(root: string): Promise<StorageResult<RemoteListing>> {
    // Take the change position first, so nothing that changes during the walk is missed.
    const delta = await this.#latest();
    if (!delta.ok) return forward(delta);
    const folders: Record<string, string> = {};
    const entries = await this.#walk(root, folders);
    if (!entries.ok) return forward(entries);
    return ok({
      entries: entries.value,
      cursor: JSON.stringify({ delta: delta.value, root, folders } satisfies Cursor),
      complete: true,
    });
  }

  async list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    if ('path' in start) return this.#full(start.path);
    let cursor: Cursor;
    try {
      cursor = JSON.parse(start.cursor) as Cursor;
      if (typeof cursor.delta !== 'string' || typeof cursor.root !== 'string') throw new Error();
    } catch {
      return fail('CURSOR_EXPIRED', 'OneDrive: the change list is unreadable; listing again.');
    }
    const rootLower = cursor.root.toLowerCase();
    const inside = (p: string) =>
      (!rootLower || p.startsWith(`${rootLower}/`)) && !insideSkipped(p.slice(rootLower.length));
    const all = await this.#all(cursor.delta);
    if (!all.ok) return forward(all);
    const { items, deltaLink } = all.value;
    const folders = { ...cursor.folders };
    const entries: RemoteEntry[] = [];
    const newFolders: string[] = [];
    for (const it of items) {
      if (it.root) continue;
      const parent = parentPath(it.parentReference?.path);
      const path = parent !== null && it.name ? `${parent}/${it.name}` : null;
      if (it.deleted) {
        const known = folders[it.id];
        if (known) {
          delete folders[it.id];
          entries.push({ kind: 'deleted', path: known });
        } else if (path) {
          if (inside(path.toLowerCase())) entries.push({ kind: 'deleted', path });
        }
        // Work drives often leave out where a deleted item was: list everything.
        else return this.#full(cursor.root);
        continue;
      }
      if (!path) continue;
      const lower = path.toLowerCase();
      if (it.folder) {
        const before = folders[it.id];
        // A folder that moved or was renamed: its files' paths changed without being reported.
        if (before && before !== lower) return this.#full(cursor.root);
        if (!before && inside(lower) && !skipName(it.name)) {
          folders[it.id] = lower;
          newFolders.push(path);
        }
        continue;
      }
      if (it.file && inside(lower)) {
        entries.push({
          kind: 'file',
          path,
          rev: it.eTag ?? '',
          ...(typeof it.size === 'number' ? { size: it.size } : {}),
        });
      }
    }
    // A new folder (or one moved in) may arrive with its files unlisted.
    for (const dir of newFolders) {
      const walked = await this.#walk(dir, folders);
      if (!walked.ok) return forward(walked);
      entries.push(...walked.value);
    }
    return ok({
      entries,
      cursor: JSON.stringify({
        delta: deltaLink ?? cursor.delta,
        root: cursor.root,
        folders,
      } satisfies Cursor),
      complete: false,
    });
  }

  async read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    const item = await this.#json<Item>(this.#item(path), path);
    if (!item.ok) return forward(item);
    const url = item.value['@microsoft.graph.downloadUrl'];
    if (!url) return fail('NOT_FOUND', `OneDrive: ‘${path}’ isn't a file.`, { path });
    // A short-lived, pre-signed link: no Authorization header (and none allowed).
    const r = await request(this.fetcher, SERVICE, url, {});
    if (!r.ok) return forward(r);
    if (!r.value.ok) return this.#failure(r.value, path);
    return ok({ bytes: new Uint8Array(await r.value.arrayBuffer()), rev: item.value.eTag ?? '' });
  }

  async write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    const url = ifRev
      ? this.#item(path, 'content')
      : `${this.#item(path, 'content')}?@microsoft.graph.conflictBehavior=fail`;
    const r = await this.#call(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(ifRev ? { 'If-Match': ifRev } : {}),
      },
      body: body(bytes),
    });
    if (!r.ok) return forward(r);
    const res = r.value;
    // 412: not that eTag any more; 409: exists already; 404 with If-Match: it went elsewhere.
    if (res.status === 412 || res.status === 409 || (res.status === 404 && ifRev)) {
      return fail('CONFLICT', `OneDrive: ‘${path}’ changed elsewhere.`, {
        path,
        status: res.status,
      });
    }
    if (!res.ok) return this.#failure(res, path);
    const item = (await res.json()) as Item;
    return ok({ rev: item.eTag ?? '' });
  }

  async remove(path: string, ifRev: string | null): Promise<StorageResult<void>> {
    if (ifRev === null) {
      const r = await this.#call(`${this.#item(path)}?$select=id`);
      if (!r.ok) return forward(r);
      if (r.value.status === 404) return ok(undefined);
      if (r.value.ok) return fail('CONFLICT', `OneDrive: ‘${path}’ exists elsewhere.`, { path });
      return this.#failure(r.value, path);
    }
    const r = await this.#call(this.#item(path), {
      method: 'DELETE',
      headers: { 'If-Match': ifRev },
    });
    if (!r.ok) return forward(r);
    if (r.value.ok || r.value.status === 404) return ok(undefined);
    if (r.value.status === 412) {
      return fail('CONFLICT', `OneDrive: ‘${path}’ changed elsewhere.`, { path, status: 412 });
    }
    return this.#failure(r.value, path);
  }

  async browse(path: string): Promise<StorageResult<RemoteFolder[]>> {
    const c = await this.#children(path);
    if (!c.ok) return forward(c);
    const folders = c.value.items
      .filter((i) => i.folder && !i.name?.startsWith('.'))
      .map((i) => ({ name: i.name ?? '', path: `${path}/${i.name}`, isProject: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const checked = await pool(folders.slice(0, 100), 4, async (f) => {
      const r = await this.#call(`${this.#item(joinPath(f.path, MANIFEST_FILE))}?$select=id`);
      if (!r.ok) return r;
      f.isProject = r.value.ok;
      return ok(undefined);
    });
    return checked.ok ? ok(folders) : forward(checked);
  }
}

// ------------------------------------------------------------------ account and drives

/** Calls Graph outside a drive (account, drives, sites), for the connection picker. */
export class GraphAccount {
  constructor(
    private readonly token: TokenGetter,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {}

  async #json<T>(path: string): Promise<StorageResult<T>> {
    const t = await this.token();
    if (!t.ok) return forward(t);
    const r = await request(this.fetcher, SERVICE, `${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${t.value}` },
    });
    if (!r.ok) return forward(r);
    if (!r.value.ok) return httpFailure(SERVICE, r.value, await graphSummary(r.value));
    return ok((await r.value.json()) as T);
  }

  async me(): Promise<StorageResult<{ name: string; email: string }>> {
    const u = await this.#json<{ displayName?: string; mail?: string; userPrincipalName?: string }>(
      '/me?$select=displayName,mail,userPrincipalName',
    );
    if (!u.ok) return forward(u);
    return ok({
      name: u.value.displayName ?? '',
      email: u.value.mail ?? u.value.userPrincipalName ?? '',
    });
  }

  /** The signed-in person's own OneDrive. */
  async myDrive(): Promise<StorageResult<DriveChoice>> {
    const d = await this.#json<{ id: string; driveType?: string }>(
      '/me/drive?$select=id,driveType',
    );
    if (!d.ok) return forward(d);
    return ok({
      id: d.value.id,
      name: d.value.driveType === 'personal' ? 'OneDrive' : 'OneDrive for work',
      owner: 'OneDrive',
    });
  }

  /** SharePoint sites matching `query` (work accounts; needs `SHAREPOINT_SCOPES`). */
  async searchSites(
    query: string,
  ): Promise<StorageResult<{ id: string; name: string; url: string }[]>> {
    const r = await this.#json<{
      value: { id: string; displayName?: string; name?: string; webUrl: string }[];
    }>(
      `/sites?search=${encodeURIComponent(query.trim() || '*')}&$select=id,displayName,name,webUrl`,
    );
    if (!r.ok) return forward(r);
    return ok(
      r.value.value.map((s) => ({
        id: s.id,
        name: s.displayName ?? s.name ?? s.webUrl,
        url: s.webUrl,
      })),
    );
  }

  /** A site's document libraries. */
  async siteDrives(site: { id: string; name: string }): Promise<StorageResult<DriveChoice[]>> {
    const r = await this.#json<{ value: { id: string; name: string; driveType?: string }[] }>(
      `/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,driveType`,
    );
    if (!r.ok) return forward(r);
    return ok(
      r.value.value
        .filter((d) => d.driveType === 'documentLibrary' || !d.driveType)
        .map((d) => ({ id: d.id, name: d.name, owner: site.name })),
    );
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
    // Microsoft's descriptions start with a code like "AADSTS50011:"; keep the readable first line.
    const why = (body.error_description ?? body.error ?? 'Microsoft sign-in failed').split(
      /\r?\n/,
    )[0];
    return fail(
      body.error === 'invalid_grant' || body.error === 'interaction_required' ? 'AUTH' : 'REMOTE',
      `Microsoft: ${why}`,
    );
  }
  return ok({
    kind: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? keepRefresh,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
  });
}

export function microsoftAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
  scopes: string,
): string {
  const url = new URL(MS_AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function tokenRequest(
  form: Record<string, string>,
  fetcher: Fetcher,
): Promise<StorageResult<TokenBody>> {
  const r = await request(fetcher, 'Microsoft', MS_TOKEN, {
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

export async function exchangeMicrosoftCode(
  input: { clientId: string; code: string; verifier: string; redirectUri: string; scopes: string },
  fetcher: Fetcher = defaultFetch,
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await tokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      scope: input.scopes,
    },
    fetcher,
  );
  return r.ok ? tokens(r.value, now) : forward(r);
}

/** Microsoft rotates refresh tokens: keep the new one. */
export async function refreshMicrosoftToken(
  clientId: string,
  refreshToken: string,
  fetcher: Fetcher = defaultFetch,
  now = Date.now(),
): Promise<StorageResult<OAuthCredential>> {
  const r = await tokenRequest(
    { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
    fetcher,
  );
  return r.ok ? tokens(r.value, now, refreshToken) : forward(r);
}
