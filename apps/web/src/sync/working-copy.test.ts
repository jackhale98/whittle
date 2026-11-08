import { applyPatch, createDocumentStore, newDoc, projectCodec, ulid } from '@whittle/document';
import { describe, expect, it } from 'vitest';
import {
  cloneUrl,
  linkOf,
  loadConnections,
  projectsPer,
  removeConnection,
  saveConnection,
  setLink,
} from './store';
import {
  applyChanges,
  changedPaths,
  patchTo,
  projectFiles,
  restoredExtra,
  splitProject,
} from './working-copy';

const enc = (s: string) => new TextEncoder().encode(s);

function doc(name = 'Bracket') {
  const d = newDoc({ name, firstPart: 'Part 1' });
  return { ...d, meta: { ...d.meta, id: 'LIB1' } };
}

describe('working copy (document files + extra files)', () => {
  it('round-trips through project files, keeping attachments and history, never the cache', () => {
    const d = doc();
    const extra = new Map([
      ['imports/a.step', enc('step')],
      ['.whittle-history/versions/x.json', enc('{}')],
      ['.whittle/meshes/index.json', enc('cache')],
    ]);
    const files = projectFiles(d, extra);
    expect(files.has('whittle.project.json')).toBe(true);
    expect(files.has('.whittle/meshes/index.json')).toBe(false);
    const back = splitProject(files, 'LIB1');
    expect(back.doc.meta.id).toBe('LIB1');
    expect(projectCodec.toFiles(back.doc)).toEqual(projectCodec.toFiles(d));
    expect([...back.extra.keys()].sort()).toEqual([
      '.whittle-history/versions/x.json',
      'imports/a.step',
    ]);
  });

  it('applies sync changes only when the expected bytes are still there (compare-and-swap)', () => {
    const files = new Map([
      ['params.json', enc('a')],
      ['imports/x.bin', enc('x')],
    ]);
    const ok = applyChanges(
      files,
      new Map([
        ['params.json', enc('b')],
        ['imports/x.bin', null],
      ]),
      new Map([
        ['params.json', enc('a')],
        ['imports/new.bin', null],
      ]),
    );
    expect(ok?.get('params.json')).toEqual(enc('b'));
    expect(ok?.has('imports/x.bin')).toBe(false);
    // The user saved meanwhile: nothing is written.
    expect(
      applyChanges(
        files,
        new Map([['params.json', enc('c')]]),
        new Map([['params.json', enc('z')]]),
      ),
    ).toBeNull();
    expect(applyChanges(files, new Map(), new Map([['imports/x.bin', null]]))).toBeNull();
  });

  it('lists the paths that changed, added and removed', () => {
    const a = new Map([
      ['a', enc('1')],
      ['b', enc('2')],
    ]);
    const b = new Map([
      ['a', enc('1')],
      ['b', enc('3')],
      ['c', enc('4')],
    ]);
    expect(changedPaths(a, b)).toEqual(['b', 'c']);
    expect(changedPaths(b, a)).toEqual(['b', 'c']);
  });

  it('a remote document becomes one undo step that keeps its modified time exactly', () => {
    const d = doc();
    const store = createDocumentStore(d);
    const remote = {
      ...d,
      params: [{ id: ulid(), name: 'width', expr: '40 mm' }],
      meta: { ...d.meta, modified: '2026-01-02T03:04:05.000Z' },
    };
    const r = store.apply({ kind: 'patch', ops: patchTo(store.getDoc(), remote, true) });
    expect(r.ok).toBe(true);
    expect(projectCodec.toFiles(store.getDoc())).toEqual(projectCodec.toFiles(remote));
    expect(store.history().past).toHaveLength(1);
    store.undo();
    expect(store.getDoc().params).toEqual([]);
  });

  it('a modified time that already matches still isn’t stamped over', () => {
    const d = doc();
    const remote = { ...d, params: [{ id: ulid(), name: 'w', expr: '1 mm' }] };
    const ops = patchTo(d, remote, true);
    expect(ops.some((o) => 'path' in o && o.path === '/meta/modified')).toBe(true);
    const out = applyPatch(d, ops);
    expect(out.doc.meta.modified).toBe(d.meta.modified);
  });

  it('a restore keeps this copy’s history and takes the version’s other files', () => {
    const current = new Map([
      ['.whittle-history/versions/a.json', enc('a')],
      ['imports/old.step', enc('old')],
    ]);
    const version = new Map([
      ['whittle.project.json', enc('{}')],
      ['imports/v.step', enc('v')],
      ['.whittle-history/versions/stale.json', enc('stale')],
    ]);
    expect([...restoredExtra(current, version).keys()].sort()).toEqual([
      '.whittle-history/versions/a.json',
      'imports/v.step',
    ]);
  });
});

function memoryKv() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe('connection records (no secrets)', () => {
  it('stores connections and links; removing a connection drops its links', () => {
    const kv = memoryKv();
    saveConnection({ id: 'C1', kind: 'dropbox', label: 'Dropbox' }, kv);
    saveConnection({ id: 'C2', kind: 'github', label: 'repo', host: 'github.com' }, kv);
    setLink('P1', { connectionId: 'C1', path: '/CAD/bracket' }, kv);
    setLink('P2', { connectionId: 'C1', path: '/CAD/plate' }, kv);
    expect(linkOf('P1', kv)).toEqual({ connectionId: 'C1', path: '/CAD/bracket' });
    expect(projectsPer(kv).get('C1')).toBe(2);
    removeConnection('C1', kv);
    expect(loadConnections(kv).map((c) => c.id)).toEqual(['C2']);
    expect(linkOf('P1', kv)).toBeNull();
    for (const v of kv.m.values()) expect(v).not.toMatch(/token|password/i);
  });

  it('survives corrupt storage', () => {
    const kv = memoryKv();
    kv.setItem('whittle:connections', '{nope');
    kv.setItem('whittle:links', '[1]');
    expect(loadConnections(kv)).toEqual([]);
    expect(linkOf('P', kv)).toBeNull();
  });
});

describe('clone URLs from the repository field', () => {
  it('owner/name on the host, or a full https URL; never credentials in a URL', () => {
    expect(cloneUrl('github.com', 'ann/bracket')).toBe('https://github.com/ann/bracket.git');
    expect(cloneUrl('github.com', 'ann/bracket.git')).toBe('https://github.com/ann/bracket.git');
    expect(cloneUrl('github.com', 'https://github.com/ann/bracket/')).toBe(
      'https://github.com/ann/bracket.git',
    );
    expect(cloneUrl('127.0.0.1:9000', 'ann/b')).toBe('http://127.0.0.1:9000/ann/b.git');
    expect(cloneUrl('github.com', 'https://tok@github.com/ann/b')).toBeNull();
    expect(cloneUrl('github.com', 'bracket')).toBeNull();
    expect(cloneUrl('', 'ann/b')).toBeNull();
  });
});
