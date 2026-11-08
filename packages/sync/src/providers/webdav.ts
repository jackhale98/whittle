// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/webdav/api.ts (errors as values, bytes instead of text).
/**
 * WebDAV (Nextcloud, ownCloud, Synology, Koofr, Fastmail Files, Apache…).
 *
 * WebDAV has no change feed, so each sync lists the folder (every listing is complete).
 * Nextcloud and ownCloud change a folder's ETag whenever anything inside it changes, so
 * unchanged subfolders are reused from the last listing. Writes carry the file's ETag
 * (`If-Match`) or `If-None-Match: *` for new files, so a file changed elsewhere is a `CONFLICT`,
 * never overwritten. Most servers don't allow cross-origin requests, so the `relay` option sends
 * requests through the Worker's `/dav/<host>/<path>` relay (stateless; never logs).
 */

import type {
  RemoteEntry,
  RemoteFolder,
  RemoteListing,
  StorageProvider,
  StorageResult,
} from '@whittle/contracts';
import { MANIFEST_FILE } from '@whittle/document';
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
} from './common';

const SERVICE = 'WebDAV';

export interface WebDavConfig {
  /** The WebDAV address, e.g. `https://cloud.example.org/remote.php/dav/files/ann/`. */
  url: string;
  username: string;
  password: string;
  /**
   * The Worker's origin (e.g. `https://sync.whittle.example`): requests go to
   * `<relay>/dav/<host>/<path>`. `null` calls the server directly (it must allow CORS).
   */
  relay: string | null;
}

/** One PROPFIND result. */
export interface DavEntry {
  /** Relative to the WebDAV address, decoded: `/CAD/a.json` (`''` for the address itself). */
  path: string;
  folder: boolean;
  etag: string;
  size?: number;
}

/** Last listing, kept in the cursor to skip unchanged folders. */
interface Tree {
  /** Folder ETags change with their contents (Nextcloud, ownCloud). */
  trusted: boolean;
  /** The server answers `Depth: infinity` (`false`: it refused; don't ask again). */
  infinity?: boolean;
  folders: Record<
    string,
    { etag: string; files: { path: string; rev: string; size?: number }[]; dirs: string[] }
  >;
}

const PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>`;

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Parse a PROPFIND multistatus into paths relative to `basePath` (a decoded URL path). */
export function parseMultistatus(xml: string, basePath: string): DavEntry[] {
  const base = basePath.replace(/\/+$/, '');
  const tag = (name: string) =>
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`;
  const out: DavEntry[] = [];
  for (const m of xml.matchAll(new RegExp(tag('response'), 'g'))) {
    const block = m[1] as string;
    const href = new RegExp(tag('href')).exec(block)?.[1];
    if (!href) continue;
    let path = unescapeXml(href.trim());
    try {
      path = decodeURIComponent(new URL(path, 'http://x').pathname);
    } catch {
      continue;
    }
    if (!path.startsWith(base)) continue;
    path = path.slice(base.length).replace(/\/+$/, '');
    const folder = /<(?:[\w-]+:)?collection\s*\/?>/.test(block);
    // A propstat for missing properties can repeat getetag empty: take the first with a value.
    let etag = '';
    for (const e of block.matchAll(new RegExp(tag('getetag'), 'g'))) {
      const v = (e[1] as string).trim();
      if (v) {
        etag = unescapeXml(v);
        break;
      }
    }
    const len = new RegExp(tag('getcontentlength')).exec(block)?.[1]?.trim();
    const size = len ? Number(len) : Number.NaN;
    out.push({ path, folder, etag, ...(Number.isFinite(size) && !folder ? { size } : {}) });
  }
  return out;
}

/** Base64 of UTF-8 (passwords may hold any character). */
function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** Nextcloud and ownCloud: folder ETags change when anything inside changes. */
const trustsFolderEtags = (xml: string) => /owncloud\.org\/ns|nextcloud\.org\/ns/.test(xml);

const skipName = (name: string) => SKIP_FOLDERS.has(name.toLowerCase());

export class WebDavProvider implements StorageProvider {
  readonly kind = 'webdav' as const;
  readonly caseSensitive = true;
  readonly base: URL;
  /** The last listing was cheap (folder ETags or one whole-tree request): poll more often. */
  #cheap = false;

  constructor(
    readonly config: WebDavConfig,
    private readonly fetcher: Fetcher = defaultFetch,
  ) {
    this.base = new URL(config.url.endsWith('/') ? config.url : `${config.url}/`);
  }

  /**
   * Servers that list cheaply (Nextcloud/ownCloud skip unchanged folders; others answer one
   * whole-tree request) are checked every 2 minutes; others every 5.
   */
  get pollMs(): number {
    return this.#cheap ? 120_000 : 300_000;
  }

  /** The request URL for a service path (through the relay when there is one). */
  url(path: string): string {
    const encoded = path
      .split('/')
      .filter(Boolean)
      .map((p) => encodeURIComponent(p))
      .join('/');
    const target = new URL(encoded, this.base);
    if (path.endsWith('/') && !target.pathname.endsWith('/')) target.pathname += '/';
    if (!this.config.relay) return target.toString();
    return `${this.config.relay.replace(/\/+$/, '')}/dav/${target.host}${target.pathname}`;
  }

  async #call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    payload?: BodyInit,
  ): Promise<StorageResult<Response>> {
    const r = await request(
      this.fetcher,
      SERVICE,
      this.url(path),
      {
        method,
        headers: { Authorization: basic(this.config.username, this.config.password), ...headers },
        ...(payload !== undefined ? { body: payload } : {}),
      },
      !this.config.relay,
    );
    if (!r.ok) return r;
    if (r.value.status === 401) {
      return fail('AUTH', 'The server refused the user name or password.', { status: 401 });
    }
    return r;
  }

  #failure<T>(res: Response, path: string): StorageResult<T> {
    return httpFailure(SERVICE, res, res.statusText, path);
  }

  /** PROPFIND a folder (Depth 1 or infinity) or one item (Depth 0). */
  async propfind(
    path: string,
    depth: 0 | 1 | 'infinity',
  ): Promise<StorageResult<{ entries: DavEntry[]; xml: string }>> {
    const r = await this.#call(
      'PROPFIND',
      depth === 0 ? path : `${path}/`,
      { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      PROPFIND,
    );
    if (!r.ok) return forward(r);
    const res = r.value;
    if (res.status !== 207 && !res.ok) return this.#failure(res, path);
    const xml = await res.text();
    return ok({ entries: parseMultistatus(xml, decodeURIComponent(this.base.pathname)), xml });
  }

  async #etag(path: string): Promise<StorageResult<string | null>> {
    const r = await this.propfind(path, 0);
    if (r.ok) return ok(r.value.entries[0]?.etag ?? null);
    return r.error.code === 'NOT_FOUND' ? ok(null) : forward(r);
  }

  /**
   * The whole tree in one request, for servers that allow `Depth: infinity` (Nextcloud doesn't by
   * default; Apache, nginx and others may). `null` when the server refuses, or answers only one
   * level (some quietly do).
   */
  async #infinity(root: string): Promise<StorageResult<RemoteEntry[] | null>> {
    const r = await this.propfind(root, 'infinity');
    if (!r.ok) {
      const s = r.error.status ?? 0;
      if ([400, 403, 405, 409, 412, 501, 507].includes(s)) return ok(null);
      return forward(r);
    }
    const found = r.value.entries;
    const depth = (p: string) => p.slice(root.length).split('/').filter(Boolean).length;
    const subfolders = found.filter((e) => e.folder && e.path !== root && depth(e.path) === 1);
    // A subfolder but nothing below the first level: probably only Depth 1 came back.
    if (subfolders.length && !found.some((e) => depth(e.path) >= 2)) return ok(null);
    const skipped = (p: string) => p.slice(root.length).split('/').some(skipName);
    return ok(
      found
        .filter((e) => !e.folder && e.path.startsWith(`${root}/`) && !skipped(e.path))
        .map((e) => ({
          kind: 'file' as const,
          path: e.path,
          rev: e.etag,
          ...(e.size !== undefined ? { size: e.size } : {}),
        })),
    );
  }

  async #walk(
    root: string,
    before: Tree | null,
  ): Promise<StorageResult<{ entries: RemoteEntry[]; tree: Tree }>> {
    // One request for the whole tree, where the server allows it (and it isn't Nextcloud/ownCloud,
    // whose folder ETags already make listing cheap).
    if (!before?.trusted && before?.infinity !== false) {
      const all = await this.#infinity(root);
      if (!all.ok) return forward(all);
      if (all.value) {
        return ok({ entries: all.value, tree: { trusted: false, infinity: true, folders: {} } });
      }
      const walked = await this.#walkFolders(root, before);
      if (walked.ok) walked.value.tree.infinity = false;
      return walked;
    }
    return this.#walkFolders(root, before);
  }

  async #walkFolders(
    root: string,
    before: Tree | null,
  ): Promise<StorageResult<{ entries: RemoteEntry[]; tree: Tree }>> {
    const tree: Tree = {
      trusted: before?.trusted ?? false,
      ...(before?.infinity === false ? { infinity: false } : {}),
      folders: {},
    };
    const entries: RemoteEntry[] = [];
    const file = (path: string, rev: string, size?: number) =>
      entries.push({ kind: 'file', path, rev, ...(size !== undefined ? { size } : {}) });
    /** Reuse a folder unchanged since last time, with everything under it. */
    const reuse = (dir: string) => {
      const f = before?.folders[dir];
      if (!f) return;
      tree.folders[dir] = f;
      for (const x of f.files) file(x.path, x.rev, x.size);
      for (const d of f.dirs) reuse(d);
    };
    let level = [root];
    let first = true;
    while (level.length) {
      const next: string[] = [];
      const r = await pool(level, 4, async (dir) => {
        const p = await this.propfind(dir, 1);
        if (!p.ok) return p;
        const { entries: found, xml } = p.value;
        if (first) {
          tree.trusted = trustsFolderEtags(xml);
          first = false;
        }
        const self = found.find((e) => e.path === dir);
        const folder: Tree['folders'][string] = { etag: self?.etag ?? '', files: [], dirs: [] };
        tree.folders[dir] = folder;
        for (const e of found) {
          if (e.path === dir) continue;
          if (e.folder) {
            if (skipName(baseName(e.path))) continue;
            folder.dirs.push(e.path);
            const known = before?.folders[e.path];
            if (tree.trusted && known && e.etag && known.etag === e.etag) reuse(e.path);
            else next.push(e.path);
          } else {
            folder.files.push({
              path: e.path,
              rev: e.etag,
              ...(e.size !== undefined ? { size: e.size } : {}),
            });
            file(e.path, e.etag, e.size);
          }
        }
        return p;
      });
      if (!r.ok) return forward(r);
      level = next;
    }
    return ok({ entries, tree });
  }

  async list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    let root = 'path' in start ? start.path : '';
    let before: Tree | null = null;
    if ('cursor' in start) {
      try {
        const c = JSON.parse(start.cursor) as { root: string; tree: Tree };
        root = c.root;
        before = c.tree;
      } catch {
        return fail('CURSOR_EXPIRED', 'WebDAV: the last listing is unreadable; listing again.');
      }
    }
    const walked = await this.#walk(root, before);
    if (!walked.ok) return forward(walked);
    const { entries, tree } = walked.value;
    this.#cheap = tree.trusted || tree.infinity === true;
    return ok({ entries, cursor: JSON.stringify({ root, tree }), complete: true });
  }

  async read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    const r = await this.#call('GET', path);
    if (!r.ok) return forward(r);
    const res = r.value;
    if (!res.ok) return this.#failure(res, path);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let rev = res.headers.get('ETag');
    if (!rev) {
      const e = await this.#etag(path);
      if (!e.ok) return forward(e);
      rev = e.value ?? '';
    }
    return ok({ bytes, rev });
  }

  async #mkcols(path: string): Promise<StorageResult<void>> {
    const parts = path.split('/').filter(Boolean).slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) {
      const r = await this.#call('MKCOL', `/${parts.slice(0, i).join('/')}/`);
      if (!r.ok) return forward(r);
      // 405: already there.
      const s = r.value.status;
      if (!r.value.ok && s !== 405 && s !== 301) return this.#failure(r.value, path);
    }
    return ok(undefined);
  }

  #conflict<T>(path: string): StorageResult<T> {
    return fail('CONFLICT', `WebDAV: ‘${path}’ changed elsewhere.`, { path, status: 412 });
  }

  async write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (ifRev && !ifRev.startsWith('W/')) headers['If-Match'] = ifRev;
    else if (ifRev) {
      // A weak ETag never satisfies If-Match: compare it just before writing instead.
      const now = await this.#etag(path);
      if (!now.ok) return forward(now);
      if (now.value !== ifRev) return this.#conflict(path);
    } else headers['If-None-Match'] = '*';
    let r = await this.#call('PUT', path, headers, body(bytes));
    if (!r.ok) return forward(r);
    if (r.value.status === 409) {
      // The folder doesn't exist yet.
      const made = await this.#mkcols(path);
      if (!made.ok) return forward(made);
      r = await this.#call('PUT', path, headers, body(bytes));
      if (!r.ok) return forward(r);
    }
    const res = r.value;
    if (res.status === 412) return this.#conflict(path);
    // If-Match on a file that's gone: some servers answer 404.
    if (res.status === 404 && ifRev) return this.#conflict(path);
    if (!res.ok) return this.#failure(res, path);
    let rev = res.headers.get('OC-ETag') ?? res.headers.get('ETag');
    if (!rev) {
      const e = await this.#etag(path);
      if (!e.ok) return forward(e);
      rev = e.value ?? '';
    }
    return ok({ rev });
  }

  async remove(path: string, ifRev: string | null): Promise<StorageResult<void>> {
    const headers: Record<string, string> = {};
    if (ifRev && !ifRev.startsWith('W/')) headers['If-Match'] = ifRev;
    else {
      const now = await this.#etag(path);
      if (!now.ok) return forward(now);
      if (now.value === null) return ok(undefined);
      if (now.value !== ifRev) return this.#conflict(path);
    }
    const r = await this.#call('DELETE', path, headers);
    if (!r.ok) return forward(r);
    if (r.value.ok || r.value.status === 404) return ok(undefined);
    if (r.value.status === 412) return this.#conflict(path);
    return this.#failure(r.value, path);
  }

  async browse(path: string): Promise<StorageResult<RemoteFolder[]>> {
    const r = await this.propfind(path, 1);
    if (!r.ok) return forward(r);
    const folders = r.value.entries
      .filter((e) => e.path !== path && e.folder && !baseName(e.path).startsWith('.'))
      .map((e) => ({ name: baseName(e.path), path: e.path, isProject: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const checked = await pool(folders.slice(0, 100), 4, async (f) => {
      const e = await this.#etag(joinPath(f.path, MANIFEST_FILE));
      if (e.ok) f.isProject = e.value !== null;
      return e;
    });
    return checked.ok ? ok(folders) : forward(checked);
  }
}

/** Nextcloud's WebDAV address for a user, from the server's address. */
export function nextcloudUrl(server: string, username: string): string {
  const base = server.trim().replace(/\/+$/, '');
  if (/\/remote\.php\//.test(base)) return `${base}/`;
  return `${base}/remote.php/dav/files/${encodeURIComponent(username)}/`;
}
