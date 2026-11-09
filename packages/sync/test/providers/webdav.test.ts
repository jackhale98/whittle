// Ported from Mycelium src/lib/webdav/api.test.ts.
import { describe, expect, it } from 'vitest';
import { nextcloudUrl, parseMultistatus, WebDavProvider } from '../../src/providers/webdav';
import { FakeDav } from '../support/fake-dav';
import { dec, enc, must } from '../support/fetch';

const ROOT = '/remote.php/dav/files/ada';
const dav = (server: FakeDav, relay: string | null = null) =>
  new WebDavProvider(
    { url: `https://cloud.test${ROOT}/`, username: 'ada', password: 'pässword', relay },
    server.fetch,
  );

describe('parseMultistatus', () => {
  it('reads hrefs, collections, sizes and ETags whatever the namespace prefix', () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
 <D:response><D:href>https://cloud.test/dav/CAD/</D:href>
  <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getetag>"f1"</D:getetag></D:prop></D:propstat></D:response>
 <D:response><D:href>/dav/CAD/caf%C3%A9%20%26%20tea.json</D:href>
  <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>12</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  <D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 404</D:status></D:propstat>
  <D:propstat><D:prop><D:getetag>W/&quot;abc&quot;</D:getetag></D:prop></D:propstat></D:response>
</D:multistatus>`;
    expect(parseMultistatus(xml, '/dav')).toEqual([
      { path: '/CAD', folder: true, etag: '"f1"' },
      { path: '/CAD/café & tea.json', folder: false, etag: 'W/"abc"', size: 12 },
    ]);
  });

  it('builds Nextcloud addresses', () => {
    expect(nextcloudUrl('https://cloud.test/', 'ada')).toBe(
      'https://cloud.test/remote.php/dav/files/ada/',
    );
    expect(nextcloudUrl('https://cloud.test/remote.php/webdav', 'ada')).toBe(
      'https://cloud.test/remote.php/webdav/',
    );
  });
});

describe('WebDAV provider', () => {
  it('sends requests through the relay as /dav/<host>/<path>, with UTF-8 basic auth', async () => {
    const server = new FakeDav(ROOT, { user: 'ada', pass: 'pässword' });
    server.put('/P/a.json', 'A');
    const calls: string[] = [];
    const client = new WebDavProvider(
      {
        url: `https://cloud.test${ROOT}`,
        username: 'ada',
        password: 'pässword',
        relay: 'https://w.test/',
      },
      (async (u: string, i: RequestInit) => {
        calls.push(u);
        return server.fetch(
          `https://cloud.test${new URL(u).pathname.replace('/dav/cloud.test', '')}`,
          i,
        );
      }) as unknown as typeof fetch,
    );
    expect(dec(must(await client.read('/P/a.json')).bytes)).toBe('A');
    expect(calls[0]).toBe(`https://w.test/dav/cloud.test${ROOT}/P/a.json`);
    const bad = new WebDavProvider(
      { ...client.config, password: 'nope', relay: null },
      server.fetch,
    );
    const r = await bad.read('/P/a.json');
    expect(r.ok || r.error.code).toBe('AUTH');
    expect(r.ok || r.error.message).not.toContain('nope');
  });

  it('reports a refused cross-origin request as CORS without the relay, OFFLINE with it', async () => {
    const refuse = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const direct = new WebDavProvider(
      { url: 'https://cloud.test/', username: 'a', password: 'b', relay: null },
      refuse,
    );
    const r1 = await direct.read('/a.json');
    expect(r1.ok || r1.error.code).toBe('CORS');
    const relayed = new WebDavProvider(
      { url: 'https://cloud.test/', username: 'a', password: 'b', relay: 'https://w.test' },
      refuse,
    );
    const r2 = await relayed.read('/a.json');
    expect(r2.ok || r2.error.code).toBe('OFFLINE');
  });

  it('lists a folder tree and every listing is complete', async () => {
    const server = new FakeDav(ROOT);
    server.put('/P/a.json', 'A');
    server.put('/P/parts/d.json', 'D');
    server.put('/P/.wren/h.bin', 'H');
    const r = must(await dav(server).list({ path: '/P' }));
    expect(r.complete).toBe(true);
    expect(r.entries.map((e) => e.path).sort()).toEqual(['/P/a.json', '/P/parts/d.json']);
    const again = must(await dav(server).list({ cursor: r.cursor }));
    expect(again.complete).toBe(true);
    expect(again.entries).toHaveLength(2);
  });

  it('lists the whole tree in one request where the server allows it, and polls faster', async () => {
    const server = new FakeDav(ROOT, { infinity: 'answer' });
    server.put('/P/a.json', 'A');
    server.put('/P/parts/d.json', 'D');
    server.put('/P/.wren/x.bin', 'X');
    const client = dav(server);
    expect(client.pollMs).toBe(300_000);
    const first = must(await client.list({ path: '/P' }));
    server.requests = [];
    const r = must(await client.list({ cursor: first.cursor }));
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.depth).toBe('infinity');
    expect(r.entries.map((e) => e.path).sort()).toEqual(['/P/a.json', '/P/parts/d.json']);
    expect(client.pollMs).toBe(120_000);
  });

  it('falls back to folder by folder when Depth: infinity is refused or ignored, and stops asking', async () => {
    for (const infinity of ['refuse', 'ignore'] as const) {
      const server = new FakeDav(ROOT, { infinity });
      server.put('/P/a.json', 'A');
      server.put('/P/parts/d.json', 'D');
      const client = dav(server);
      const first = must(await client.list({ path: '/P' }));
      expect(first.entries.map((e) => e.path).sort(), infinity).toEqual([
        '/P/a.json',
        '/P/parts/d.json',
      ]);
      server.requests = [];
      must(await client.list({ cursor: first.cursor }));
      expect(
        server.requests.some((q) => q.headers.depth === 'infinity'),
        infinity,
      ).toBe(false);
    }
  });

  it('skips unchanged folders on Nextcloud, and only there', async () => {
    for (const nextcloud of [true, false]) {
      const server = new FakeDav(ROOT, { nextcloud, infinity: 'refuse' });
      server.put('/P/a.json', 'A');
      server.put('/P/parts/d.json', 'D');
      server.put('/P/drawings/p.json', 'P');
      const client = dav(server);
      const first = must(await client.list({ path: '/P' }));
      server.put('/P/drawings/p.json', 'P2');
      server.requests = [];
      const r = must(await client.list({ cursor: first.cursor }));
      const listed = server.requests.filter((q) => q.method === 'PROPFIND').map((q) => q.path);
      expect(listed.includes('/P/parts')).toBe(!nextcloud);
      expect(listed).toContain('/P/drawings');
      expect(r.entries.map((e) => e.path).sort()).toEqual([
        '/P/a.json',
        '/P/drawings/p.json',
        '/P/parts/d.json',
      ]);
    }
  });

  it('writes against the ETag, creates missing folders, and refuses blind overwrites', async () => {
    const server = new FakeDav(ROOT);
    server.put('/P/a.json', 'A');
    const client = dav(server);
    const { rev } = must(await client.read('/P/a.json'));
    const next = must(await client.write('/P/a.json', enc('A2'), rev));
    expect(next.rev).toBe(server.files.get('/P/a.json')!.etag);
    const stale = await client.write('/P/a.json', enc('A3'), rev);
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
    const blind = await client.write('/P/a.json', enc('new'), null);
    expect(blind.ok || blind.error.code).toBe('CONFLICT');
    must(await client.write('/P/new/deep/b.json', enc('B'), null));
    expect(server.text('/P/new/deep/b.json')).toBe('B');
    const del = await client.remove('/P/a.json', rev);
    expect(del.ok || del.error.code).toBe('CONFLICT');
    must(await client.remove('/P/a.json', next.rev));
    must(await client.remove('/P/a.json', null));
    expect(server.text('/P/a.json')).toBeUndefined();
  });

  it('checks weak ETags before writing, since If-Match can never match them', async () => {
    const server = new FakeDav(ROOT, { weak: true });
    server.put('/P/a.json', 'A');
    const client = dav(server);
    const { rev } = must(await client.read('/P/a.json'));
    expect(rev.startsWith('W/')).toBe(true);
    must(await client.write('/P/a.json', enc('A2'), rev));
    expect(server.text('/P/a.json')).toBe('A2');
    const stale = await client.write('/P/a.json', enc('A3'), rev);
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
  });
});
