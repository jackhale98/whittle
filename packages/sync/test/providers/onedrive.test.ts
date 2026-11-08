// Ported from Mycelium src/lib/onedrive/api.test.ts.
import { describe, expect, it } from 'vitest';
import {
  exchangeMicrosoftCode,
  GraphAccount,
  graphPath,
  microsoftAuthorizeUrl,
  ONEDRIVE_SCOPES,
  OneDriveProvider,
  parentPath,
  refreshMicrosoftToken,
  SHAREPOINT_SCOPES,
} from '../../src/providers/onedrive';
import { FakeGraph } from '../support/fake-graph';
import { dec, enc, fakeFetch, json, must, tok } from '../support/fetch';

const drive = (g: FakeGraph) => new OneDriveProvider('d1', tok, g.fetch);

describe('Graph paths', () => {
  it('encodes path segments and reads parent references', () => {
    expect(graphPath('/CAD/a b/c#d.json')).toBe('CAD/a%20b/c%23d.json');
    expect(parentPath('/drive/root:/CAD/parts')).toBe('/CAD/parts');
    expect(parentPath('/drives/abc/root:')).toBe('');
    expect(parentPath('/drive/root:/caf%C3%A9')).toBe('/café');
    expect(parentPath(undefined)).toBeNull();
  });
});

describe('OneDrive provider', () => {
  it('lists a folder recursively, skipping the cache but not history', async () => {
    const g = new FakeGraph();
    g.put('/P/whittle.project.json', '{}');
    g.put('/P/parts/a.part.json', '{}');
    g.put('/P/.whittle/meshes/a.bin', 'X');
    g.put('/P/.whittle-history/refs/heads/main/v1', '');
    g.put('/Other/b.json', 'B');
    const r = must(await drive(g).list({ path: '/P' }));
    expect(r.complete).toBe(true);
    expect(r.entries.map((e) => e.path).sort()).toEqual([
      '/P/.whittle-history/refs/heads/main/v1',
      '/P/parts/a.part.json',
      '/P/whittle.project.json',
    ]);
  });

  it('follows changes under the folder only', async () => {
    const g = new FakeGraph();
    g.put('/P/a.json', 'A');
    const d = drive(g);
    const first = must(await d.list({ path: '/P' }));
    g.put('/P/a.json', 'A2');
    g.put('/Other/b.json', 'B');
    g.put('/P/.whittle/c.bin', 'C');
    const r = must(await d.list({ cursor: first.cursor }));
    expect(r.complete).toBe(false);
    expect(r.entries).toEqual([
      expect.objectContaining({ kind: 'file', path: '/P/a.json', rev: g.find('/P/a.json')!.eTag }),
    ]);
    expect(must(await d.list({ cursor: r.cursor })).entries).toEqual([]);
  });

  it('lists the files of a folder that appears, and places deletions', async () => {
    const g = new FakeGraph();
    g.put('/P/a.json', 'A');
    const d = drive(g);
    const first = must(await d.list({ path: '/P' }));
    g.put('/P/parts/p.part.json', 'P');
    must(await d.remove('/P/a.json', g.find('/P/a.json')!.eTag));
    const r = must(await d.list({ cursor: first.cursor }));
    expect(r.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(
      expect.arrayContaining(['file /P/parts/p.part.json', 'deleted /P/a.json']),
    );
  });

  it('lists everything again when a folder is renamed or a deletion can’t be placed', async () => {
    const g = new FakeGraph();
    g.put('/P/parts/x.json', 'X');
    const d = drive(g);
    const first = must(await d.list({ path: '/P' }));
    const parts = g.find('/P/parts')!;
    g.nodes.set(parts.id, { ...parts, name: 'pieces' });
    g.changes.push(g.item(parts.id));
    const r = must(await d.list({ cursor: first.cursor }));
    expect(r.complete).toBe(true);
    expect(r.entries.map((e) => e.path)).toEqual(['/P/pieces/x.json']);
    g.changes.push({ id: 'unknown', deleted: {} });
    expect(must(await d.list({ cursor: r.cursor })).complete).toBe(true);
  });

  it('reports a gone delta (410) or an unreadable cursor as CURSOR_EXPIRED', async () => {
    const g = new FakeGraph();
    const d = drive(g);
    const bad = await d.list({ cursor: 'not json' });
    expect(bad.ok || bad.error.code).toBe('CURSOR_EXPIRED');
    const gone = await d.list({
      cursor: JSON.stringify({
        delta: 'https://graph.microsoft.com/v1.0/drives/d1/root/delta?token=-1',
        root: '/P',
        folders: {},
      }),
    });
    expect(gone.ok || gone.error.code).toBe('CURSOR_EXPIRED');
  });

  it('downloads through the pre-signed link, without the bearer token', async () => {
    const g = new FakeGraph();
    const n = g.put('/P/a.json', '{"a":1}\n');
    const r = must(await drive(g).read('/P/a.json'));
    expect(dec(r.bytes)).toBe('{"a":1}\n');
    expect(r.rev).toBe(n.eTag);
    const last = g.calls.at(-1)!;
    expect(last.url).toBe(`https://download.test/${n.id}`);
    expect(last.headers.Authorization).toBeUndefined();
  });

  it('uploads against the eTag, and refuses to replace a file it didn’t know about', async () => {
    const g = new FakeGraph();
    const n = g.put('/P/a.json', 'A');
    const d = drive(g);
    const { rev } = must(await d.write('/P/a.json', enc('A2'), n.eTag));
    expect(rev).toBe(g.find('/P/a.json')!.eTag);
    const stale = await d.write('/P/a.json', enc('A3'), n.eTag);
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
    const blind = await d.write('/P/a.json', enc('new'), null);
    expect(blind.ok || blind.error.code).toBe('CONFLICT');
    must(await d.write('/P/new folder/b.json', enc('B'), null));
    expect(g.text('/P/new folder/b.json')).toBe('B');
    expect(g.calls.some((c) => c.url.includes('P/new%20folder/b.json:/content'))).toBe(true);
    const gone = await d.write('/P/missing.json', enc('x'), '"old"');
    expect(gone.ok || gone.error.code).toBe('CONFLICT');
  });

  it('deletes only the version it knew', async () => {
    const g = new FakeGraph();
    g.put('/P/a.json', 'A');
    const d = drive(g);
    const stale = await d.remove('/P/a.json', 'stale');
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
    must(await d.remove('/P/a.json', g.find('/P/a.json')!.eTag));
    must(await d.remove('/P/a.json', null));
    expect(g.find('/P/a.json')).toBeUndefined();
  });
});

describe('Graph account and SharePoint', () => {
  it('finds the user, their drive, sites and document libraries', async () => {
    const g = new FakeGraph();
    const a = new GraphAccount(tok, g.fetch);
    expect(must(await a.me())).toEqual({ name: 'Ada', email: 'ada@contoso.test' });
    expect(must(await a.myDrive())).toEqual({
      id: 'd1',
      name: 'OneDrive for work',
      owner: 'OneDrive',
    });
    const sites = must(await a.searchSites('team'));
    expect(sites[0]!.name).toBe('Team CAD');
    expect(must(await a.siteDrives(sites[0]!))).toEqual([
      { id: 'd1', name: 'Documents', owner: 'Team CAD' },
    ]);
  });
});

describe('Microsoft sign-in', () => {
  it('asks for a code with PKCE and minimal scopes', () => {
    const url = new URL(
      microsoftAuthorizeUrl('cid', 'https://x.test/cb/', 's', 'c', ONEDRIVE_SCOPES),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid',
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: 'https://x.test/cb/',
      scope: 'offline_access User.Read Files.ReadWrite',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
    expect(ONEDRIVE_SCOPES).not.toContain('.All');
    expect(SHAREPOINT_SCOPES).toContain('Sites.Read.All');
  });

  it('exchanges and refreshes (rotating refresh tokens) as values', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'ey', refresh_token: 'r1', expires_in: 3600 }),
      json({ access_token: 'ey2', refresh_token: 'r2', expires_in: 3600 }),
      json({ error: 'invalid_grant', error_description: 'AADSTS70000: expired\nTrace' }, 400),
    ]);
    const t = must(
      await exchangeMicrosoftCode(
        { clientId: 'ms', code: 'c', verifier: 'v', redirectUri: 'u', scopes: ONEDRIVE_SCOPES },
        fetcher,
        0,
      ),
    );
    expect(t.refreshToken).toBe('r1');
    expect(new URLSearchParams(calls[0]!.init.body as string).get('scope')).toBe(ONEDRIVE_SCOPES);
    expect(must(await refreshMicrosoftToken('ms', 'r1', fetcher, 0)).refreshToken).toBe('r2');
    const bad = await refreshMicrosoftToken('ms', 'r2', fetcher, 0);
    expect(bad.ok || bad.error).toEqual({
      code: 'AUTH',
      message: 'Microsoft: AADSTS70000: expired',
    });
  });
});
