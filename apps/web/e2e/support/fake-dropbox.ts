/**
 * A fake Dropbox (HTTP API v2 + OAuth 2 PKCE) for M2.5 end-to-end tests, on its own origin so
 * the browser applies real CORS and COEP rules. It serves the request and response shapes
 * `DropboxProvider` uses (and its unit tests assert, packages/sync/test/providers/dropbox.test.ts):
 * `list_folder` (+ `/continue` deltas with deleted entries), `get_metadata`, `download` with
 * `Dropbox-API-Result`, `upload` with add/update modes and `strict_conflict`, `delete_v2` with
 * `parent_rev`, `get_current_account`, `/oauth2/authorize` and `/oauth2/token`.
 *
 * The app reaches it through `__wrenSyncOverrides.endpoints` (apps/web src/sync/env.ts).
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface FileRec {
  path: string;
  bytes: Buffer;
  rev: string;
}

export interface FakeDropbox {
  origin: string;
  /** Lower-cased path → file. */
  files: Map<string, FileRec>;
  folders: Set<string>;
  /** Every request: method, path, time. */
  log: { path: string; at: number }[];
  /** Access tokens handed out (tests scan storage for them). */
  issued: string[];
  /** Codes handed out by `/oauth2/authorize`, with the PKCE challenge they were issued for. */
  text(path: string): string | undefined;
  close(): Promise<void>;
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

export async function startFakeDropbox(seedFolders: string[] = []): Promise<FakeDropbox> {
  const files = new Map<string, FileRec>();
  const folders = new Set<string>(seedFolders.map((f) => f.toLowerCase()));
  const display = new Map<string, string>(seedFolders.map((f) => [f.toLowerCase(), f]));
  /** Change log for cursors: sequence → lower-cased path. */
  const changes: string[] = [];
  const log: { path: string; at: number }[] = [];
  const issued: string[] = [];
  const codes = new Map<string, string>();
  let revs = 0;
  let tokens = 0;

  const json = (res: ServerResponse, status: number, body: unknown, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  };
  const conflict = (res: ServerResponse, summary: string) =>
    json(res, 409, { error_summary: summary, error: { '.tag': summary.split('/')[0] } });
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const arg = (req: IncomingMessage) =>
    JSON.parse(String(req.headers['dropbox-api-arg'] ?? '{}')) as Record<string, unknown>;
  const fileEntry = (f: FileRec) => ({
    '.tag': 'file',
    name: f.path.split('/').pop(),
    path_display: f.path,
    path_lower: f.path.toLowerCase(),
    rev: f.rev,
    size: f.bytes.length,
  });
  const folderEntry = (lower: string) => ({
    '.tag': 'folder',
    name: (display.get(lower) ?? lower).split('/').pop(),
    path_display: display.get(lower) ?? lower,
    path_lower: lower,
  });
  const addFolders = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`;
      if (!folders.has(p.toLowerCase())) {
        folders.add(p.toLowerCase());
        display.set(p.toLowerCase(), p);
      }
    }
  };
  const under = (lower: string, root: string, recursive: boolean) => {
    if (root && !lower.startsWith(`${root}/`)) return false;
    if (recursive) return true;
    return !lower.slice(root.length + 1).includes('/');
  };
  const authed = (req: IncomingMessage) => {
    const h = String(req.headers.authorization ?? '');
    return h.startsWith('Bearer ') && issued.includes(h.slice(7));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.invalid');
    log.push({ path: url.pathname, at: Date.now() });
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Dropbox-API-Arg');
      res.setHeader('access-control-expose-headers', 'Dropbox-API-Result');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (url.pathname === '/oauth2/authorize') {
      // The user "approves": back to the app with a one-time code (PKCE checked at /token).
      const code = `code-${codes.size + 1}`;
      codes.set(code, url.searchParams.get('code_challenge') ?? '');
      const back = new URL(url.searchParams.get('redirect_uri') ?? '/');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams((await body(req)).toString());
      if (form.get('grant_type') === 'authorization_code') {
        const want = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!want || s256(form.get('code_verifier') ?? '') !== want)
          return json(res, 400, {
            error: 'invalid_grant',
            error_description: 'bad code or verifier',
          });
      } else if (form.get('grant_type') !== 'refresh_token') {
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      tokens += 1;
      const access = `sl.fake-access-${tokens}-${Math.random().toString(36).slice(2)}`;
      issued.push(access);
      return json(res, 200, {
        access_token: access,
        refresh_token: 'fake-refresh-token-secret',
        expires_in: 14_400,
        token_type: 'bearer',
      });
    }
    if (!authed(req)) return json(res, 401, { error_summary: 'invalid_access_token/' });

    const rpc = async () =>
      JSON.parse((await body(req)).toString() || 'null') as Record<string, unknown>;
    switch (url.pathname) {
      case '/2/users/get_current_account':
        return json(res, 200, { name: { display_name: 'Ann' }, email: 'ann@example.com' });
      case '/2/files/list_folder': {
        const a = await rpc();
        const root = String(a.path ?? '').toLowerCase();
        if (root && !folders.has(root)) return conflict(res, 'path/not_found/');
        const recursive = !!a.recursive;
        const entries = [
          ...[...folders].filter((f) => f !== root && under(f, root, recursive)).map(folderEntry),
          ...[...files.entries()]
            .filter(([l]) => under(l, root, recursive))
            .map(([, f]) => fileEntry(f)),
        ];
        return json(res, 200, { entries, cursor: String(changes.length), has_more: false });
      }
      case '/2/files/list_folder/continue': {
        const a = await rpc();
        const from = Number(a.cursor);
        const seen = [...new Set(changes.slice(from))];
        const entries = seen.map((l) => {
          const f = files.get(l);
          return f
            ? fileEntry(f)
            : { '.tag': 'deleted', path_lower: l, path_display: l, name: l.split('/').pop() };
        });
        return json(res, 200, { entries, cursor: String(changes.length), has_more: false });
      }
      case '/2/files/get_metadata': {
        const a = await rpc();
        const l = String(a.path).toLowerCase();
        const f = files.get(l);
        if (f) return json(res, 200, fileEntry(f));
        if (folders.has(l)) return json(res, 200, folderEntry(l));
        return conflict(res, 'path/not_found/');
      }
      case '/2/files/download': {
        const f = files.get(String(arg(req).path).toLowerCase());
        if (!f) return conflict(res, 'path/not_found/');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'dropbox-api-result': JSON.stringify({ rev: f.rev, path_display: f.path }),
        });
        return void res.end(f.bytes);
      }
      case '/2/files/upload': {
        const a = arg(req);
        const path = String(a.path);
        const l = path.toLowerCase();
        const mode = a.mode as { '.tag': string; update?: string };
        const bytes = await body(req);
        const cur = files.get(l);
        if (mode['.tag'] === 'add' && cur) return conflict(res, 'path/conflict/file/');
        if (mode['.tag'] === 'update' && (!cur || cur.rev !== mode.update))
          return conflict(res, 'path/conflict/file/');
        revs += 1;
        const rec = { path: cur?.path ?? path, bytes, rev: `rev${String(revs).padStart(6, '0')}` };
        files.set(l, rec);
        addFolders(rec.path);
        changes.push(l);
        return json(res, 200, fileEntry(rec));
      }
      case '/2/files/delete_v2': {
        const a = await rpc();
        const l = String(a.path).toLowerCase();
        const cur = files.get(l);
        if (!cur) return conflict(res, 'path_lookup/not_found/');
        if (a.parent_rev && cur.rev !== a.parent_rev) return conflict(res, 'path/conflict/');
        files.delete(l);
        changes.push(l);
        return json(res, 200, { metadata: fileEntry(cur) });
      }
      default:
        return json(res, 404, { error_summary: 'unknown_endpoint/' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    files,
    folders,
    log,
    issued,
    text: (p) => files.get(p.toLowerCase())?.bytes.toString('utf8'),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The init script value that points the app's Dropbox at the fake (and supplies an app key). */
export function dropboxOverrides(origin: string) {
  return {
    endpoints: {
      'https://api.dropboxapi.com': origin,
      'https://content.dropboxapi.com': origin,
      'https://www.dropbox.com': origin,
    },
    config: { dropboxAppKey: 'e2e-app-key' },
  };
}
