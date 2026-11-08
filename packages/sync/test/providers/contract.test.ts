/// Provider contract tests (ADR-020 §3): every file provider honours `ifRev`, reports errors as
/// values, round-trips bytes, lists `.whittle-history/` but never `.whittle/`, and reports changes
/// made elsewhere. Run against each provider's mock service.

import type { StorageProvider } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { FolderProvider } from '../../src/providers/folder';
import { MemoryProvider } from '../../src/providers/memory';
import { OneDriveProvider } from '../../src/providers/onedrive';
import { WebDavProvider } from '../../src/providers/webdav';
import { FakeDav } from '../support/fake-dav';
import { FakeDir } from '../support/fake-dir';
import { FakeGraph } from '../support/fake-graph';
import { dec, enc, must, tok } from '../support/fetch';

interface Harness {
  provider: StorageProvider;
  /** Another device writes or deletes directly in the service. */
  put(path: string, text: string): Promise<void> | void;
  del(path: string): Promise<void> | void;
}

const ROOT = '/remote.php/dav/files/ada';

const harnesses: Record<string, () => Harness> = {
  memory: () => {
    const m = new MemoryProvider();
    return { provider: m, put: (p, t) => void m.put(p, t), del: (p) => m.delete(p) };
  },
  folder: () => {
    const d = new FakeDir();
    return {
      provider: new FolderProvider(d),
      put: (p, t) => d.put(p, t),
      del: async (p) => {
        const parts = p.split('/').filter(Boolean);
        const name = parts.pop()!;
        let dir = d;
        for (const x of parts) dir = await dir.getDirectoryHandle(x);
        await dir.removeEntry(name);
      },
    };
  },
  webdav: () => {
    const s = new FakeDav(ROOT);
    return {
      provider: new WebDavProvider(
        { url: `https://cloud.test${ROOT}/`, username: 'ada', password: 'pw', relay: null },
        s.fetch,
      ),
      put: (p, t) => s.put(p, t),
      del: (p) => void s.files.delete(p),
    };
  },
  nextcloud: () => {
    const s = new FakeDav(ROOT, { nextcloud: true });
    return {
      provider: new WebDavProvider(
        { url: `https://cloud.test${ROOT}/`, username: 'ada', password: 'pw', relay: null },
        s.fetch,
      ),
      put: (p, t) => s.put(p, t),
      del: (p) => {
        s.files.delete(p);
        s.put('/touch', 'x'); // folder ETags move with any change on Nextcloud
        s.files.delete('/touch');
      },
    };
  },
  onedrive: () => {
    const g = new FakeGraph();
    return {
      provider: new OneDriveProvider('d1', tok, g.fetch),
      put: (p, t) => void g.put(p, t),
      del: (p) => {
        const n = g.find(p)!;
        const where = g.path(n.parent!);
        g.nodes.delete(n.id);
        g.changes.push({
          id: n.id,
          deleted: {},
          name: n.name,
          parentReference: { path: `/drive/root:${where}` },
        });
      },
    };
  },
};

describe.each(Object.keys(harnesses))('%s provider contract', (name) => {
  const make = harnesses[name]!;

  it('creates only when absent, and round-trips arbitrary bytes', async () => {
    const { provider } = make();
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { rev } = must(await provider.write('/P/imports/a.step', bytes, null));
    const back = must(await provider.read('/P/imports/a.step'));
    expect([...back.bytes]).toEqual([...bytes]);
    expect(back.rev).toBe(rev);
    const again = await provider.write('/P/imports/a.step', enc('x'), null);
    expect(again.ok || again.error.code).toBe('CONFLICT');
  });

  it('writes against the revision and refuses a stale one (never overwrites)', async () => {
    const h = make();
    const { rev: r1 } = must(await h.provider.write('/P/params.json', enc('one'), null));
    const { rev: r2 } = must(await h.provider.write('/P/params.json', enc('two'), r1));
    expect(r2).not.toBe(r1);
    const stale = await h.provider.write('/P/params.json', enc('three'), r1);
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
    expect(dec(must(await h.provider.read('/P/params.json')).bytes)).toBe('two');
    // Changed elsewhere: our revision is now stale.
    await h.put('/P/params.json', 'elsewhere');
    const raced = await h.provider.write('/P/params.json', enc('mine'), r2);
    expect(raced.ok || raced.error.code).toBe('CONFLICT');
    expect(dec(must(await h.provider.read('/P/params.json')).bytes)).toBe('elsewhere');
  });

  it('removes only the revision it knew; missing files are fine', async () => {
    const { provider } = make();
    const { rev } = must(await provider.write('/P/a.json', enc('A'), null));
    must(await provider.write('/P/b.json', enc('B'), null));
    const stale = await provider.remove('/P/a.json', 'not-a-rev');
    expect(stale.ok || stale.error.code).toBe('CONFLICT');
    const blind = await provider.remove('/P/b.json', null);
    expect(blind.ok || blind.error.code).toBe('CONFLICT');
    must(await provider.remove('/P/a.json', rev));
    must(await provider.remove('/P/a.json', rev));
    must(await provider.remove('/P/never.json', null));
    const gone = await provider.read('/P/a.json');
    expect(gone.ok || gone.error.code).toBe('NOT_FOUND');
  });

  it('lists the project, with history but never the cache', async () => {
    const h = make();
    await h.put('/P/whittle.project.json', '{}');
    await h.put('/P/parts/a.part.json', '{}');
    await h.put('/P/.whittle-history/versions/v1.json', '{}');
    await h.put('/P/.whittle/meshes/a.bin', 'mesh');
    await h.put('/Other/x.json', '{}');
    const r = must(await h.provider.list({ path: '/P' }));
    expect(r.complete).toBe(true);
    expect(
      r.entries
        .filter((e) => e.kind === 'file')
        .map((e) => e.path)
        .sort(),
    ).toEqual([
      '/P/.whittle-history/versions/v1.json',
      '/P/parts/a.part.json',
      '/P/whittle.project.json',
    ]);
    for (const e of r.entries) if (e.kind === 'file') expect(e.rev).toBeTruthy();
  });

  it('reports a change made elsewhere since the cursor', async () => {
    const h = make();
    await h.put('/P/a.json', 'A');
    await h.put('/P/b.json', 'B');
    const first = must(await h.provider.list({ path: '/P' }));
    await h.put('/P/a.json', 'A2');
    await h.del('/P/b.json');
    const next = must(await h.provider.list({ cursor: first.cursor }));
    const a = next.entries.find((e) => e.path === '/P/a.json');
    const before = first.entries.find((e) => e.path === '/P/a.json');
    expect(a?.kind).toBe('file');
    expect(a?.rev).not.toBe(before?.rev);
    const b = next.entries.find((e) => e.path === '/P/b.json');
    if (next.complete) expect(b).toBeUndefined();
    else expect(b?.kind).toBe('deleted');
  });

  it('browses folders and spots projects', async () => {
    const h = make();
    await h.put('/CAD/bracket/whittle.project.json', '{}');
    await h.put('/CAD/notes/readme.txt', 'x');
    await h.put('/CAD/.hidden/x.txt', 'x');
    const r = must(await h.provider.browse('/CAD'));
    expect(r).toEqual([
      { name: 'bracket', path: '/CAD/bracket', isProject: true },
      { name: 'notes', path: '/CAD/notes', isProject: false },
    ]);
  });

  it('reports a missing file as NOT_FOUND', async () => {
    const r = await make().provider.read('/P/nope.json');
    expect(r.ok || r.error.code).toBe('NOT_FOUND');
  });
});
