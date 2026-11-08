// Ported from Mycelium tests/support/fake-dav.ts (bytes instead of text).
/// An in-memory WebDAV server for tests: PROPFIND, GET, PUT, DELETE and MKCOL with ETags and
/// If-Match / If-None-Match, optionally behaving like Nextcloud (folder ETags that change when
/// anything inside changes).

export interface DavReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export class FakeDav {
  files = new Map<string, { bytes: Uint8Array; etag: string }>();
  folders = new Set<string>(['']);
  requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  #n = 0;
  #folderTag = new Map<string, string>();

  constructor(
    /** URL path of the WebDAV root, e.g. `/remote.php/dav/files/ada`. */
    readonly root: string,
    readonly options: {
      nextcloud?: boolean;
      weak?: boolean;
      user?: string;
      pass?: string;
      /** `Depth: infinity`: answer it, refuse it (403), or quietly answer one level. */
      infinity?: 'answer' | 'refuse' | 'ignore';
    } = {},
  ) {}

  #etag() {
    const tag = `"e${++this.#n}"`;
    return this.options.weak ? `W/${tag}` : tag;
  }
  #touch(path: string) {
    for (let p = path; ; ) {
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (!this.folders.has(parent)) this.folders.add(parent);
      this.#folderTag.set(parent, this.#etag());
      if (!parent) break;
      p = parent;
    }
  }

  put(path: string, content: Uint8Array | string) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.set(path, { bytes, etag: this.#etag() });
    this.#touch(path);
  }
  text(path: string) {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : undefined;
  }

  handle(
    method: string,
    urlPath: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): DavReply {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const path = decodeURIComponent(urlPath.slice(this.root.length)).replace(/\/+$/, '');
    this.requests.push({ method, path, headers: h });
    const reply = (
      status: number,
      b: Uint8Array | string = '',
      extra: Record<string, string> = {},
    ): DavReply => ({ status, headers: extra, body: b });
    if (this.options.user) {
      const expected = `Basic ${Buffer.from(`${this.options.user}:${this.options.pass}`).toString('base64')}`;
      if (h.authorization !== expected) return reply(401);
    }
    const file = this.files.get(path);
    switch (method) {
      case 'PROPFIND': {
        const isFolder = this.folders.has(path);
        if (!isFolder && !file) return reply(404);
        let depth = h.depth ?? '1';
        if (depth === 'infinity') {
          const mode = this.options.infinity ?? (this.options.nextcloud ? 'refuse' : 'answer');
          if (mode === 'refuse') return reply(403);
          if (mode === 'ignore') depth = '1';
        }
        const under = (p: string) =>
          depth === 'infinity' ? p.startsWith(`${path}/`) : p.slice(0, p.lastIndexOf('/')) === path;
        const items: { path: string; folder: boolean; etag: string; size?: number }[] = [];
        const tagOf = (p: string) =>
          this.options.nextcloud ? (this.#folderTag.get(p) ?? '"root"') : '';
        if (isFolder) {
          items.push({ path, folder: true, etag: tagOf(path) });
          if (depth !== '0') {
            for (const f of this.folders)
              if (f !== path && under(f)) items.push({ path: f, folder: true, etag: tagOf(f) });
            for (const [p, v] of this.files)
              if (under(p))
                items.push({ path: p, folder: false, etag: v.etag, size: v.bytes.length });
          }
        } else
          items.push({
            path,
            folder: false,
            etag: file?.etag ?? '',
            size: file?.bytes.length ?? 0,
          });
        const ns = this.options.nextcloud ? ' xmlns:oc="http://owncloud.org/ns"' : '';
        const xml =
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"${ns}>` +
          items
            .map(
              (i) =>
                `<d:response><d:href>${this.root}${i.path
                  .split('/')
                  .map(encodeURIComponent)
                  .join('/')}${i.folder ? '/' : ''}</d:href><d:propstat><d:prop>` +
                `<d:resourcetype>${i.folder ? '<d:collection/>' : ''}</d:resourcetype>` +
                (i.etag ? `<d:getetag>${i.etag.replace(/"/g, '&quot;')}</d:getetag>` : '') +
                (i.size !== undefined ? `<d:getcontentlength>${i.size}</d:getcontentlength>` : '') +
                `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            )
            .join('') +
          '</d:multistatus>';
        return reply(207, xml, { 'Content-Type': 'application/xml' });
      }
      case 'GET':
        if (!file) return reply(404);
        return reply(200, file.bytes, { ETag: file.etag });
      case 'PUT': {
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (!this.folders.has(parent)) return reply(409);
        const ifMatch = h['if-match'];
        if (ifMatch && file?.etag !== ifMatch) return reply(412);
        if (h['if-none-match'] === '*' && file) return reply(412);
        this.put(path, body.slice());
        return reply(file ? 204 : 201, '', { ETag: this.files.get(path)?.etag ?? '' });
      }
      case 'DELETE': {
        if (!file) return reply(404);
        if (h['if-match'] && h['if-match'] !== file.etag) return reply(412);
        this.files.delete(path);
        this.#touch(path);
        return reply(204);
      }
      case 'MKCOL':
        if (this.folders.has(path)) return reply(405);
        this.folders.add(path);
        this.#touch(`${path}/x`);
        return reply(201);
    }
    return reply(405);
  }

  /** As a `fetch` for unit tests. */
  fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const raw = init.body;
    const body =
      raw instanceof Uint8Array
        ? raw
        : new TextEncoder().encode(typeof raw === 'string' ? raw : '');
    const r = this.handle(
      init.method ?? 'GET',
      url.pathname,
      (init.headers ?? {}) as Record<string, string>,
      body,
    );
    return new Response(r.status === 204 ? null : (r.body as BodyInit), {
      status: r.status,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
}
