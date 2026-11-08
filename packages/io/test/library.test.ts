// SPDX-License-Identifier: GPL-3.0-or-later
import 'fake-indexeddb/auto';
import type { ProjectFiles, WhittleDoc } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import {
  type BlobStore,
  createOpfsStore,
  isQuotaError,
  type LibraryCodec,
  LibraryError,
  openLibrary,
} from '../src/browser';

const codec: LibraryCodec = {
  toWhittle: (doc, cache) =>
    new TextEncoder().encode(JSON.stringify({ doc, cache: [...(cache ?? new Map()).keys()] })),
  fromWhittle: (bytes) => {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as { doc: WhittleDoc; cache: string[] };
    return { doc: o.doc, cache: new Map(o.cache.map((k) => [k, new Uint8Array([1])])) };
  },
};

function doc(name: string, extra: Record<string, unknown> = {}): WhittleDoc {
  return {
    schemaVersion: 1,
    units: { length: 'mm', angle: 'deg' },
    params: [],
    parts: [],
    assemblies: [],
    drawings: [],
    meta: { name, created: 'c', modified: 'm', app: 'test', ...extra },
  } as WhittleDoc;
}

let n = 0;
const fresh = () => `lib-${++n}`;

/** Minimal in-memory OPFS directory. */
function mockOpfs(opts: { writeError?: () => Error; noWritable?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const dir = {
    files,
    async getFileHandle(name: string, o?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!o?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        files.set(name, new Uint8Array(0));
      }
      return {
        async getFile() {
          const b = files.get(name) as Uint8Array;
          return new File([b as unknown as BlobPart], name);
        },
        ...(opts.noWritable
          ? {}
          : {
              async createWritable() {
                return {
                  async write(d: BufferSource) {
                    if (opts.writeError) throw opts.writeError();
                    files.set(name, new Uint8Array(d as ArrayBuffer).slice());
                  },
                  async close() {},
                };
              },
            }),
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    },
  };
  return dir;
}

const quota = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });

describe('LocalLibrary on IndexedDB blobs', () => {
  it('CRUD, recency order, search, thumbnail', async () => {
    let t = 0;
    const lib = await openLibrary({
      codec,
      dbName: fresh(),
      disableOpfs: true,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t)),
    });
    expect(lib.backend).toBe('idb');
    expect(await lib.list()).toEqual([]);
    const thumb = new Uint8Array([137, 80, 78, 71]);
    const a = await lib.save(doc('Bracket'), undefined, thumb);
    const b = await lib.save(doc('bracket cover'));
    const c = await lib.save(doc('Gear'));
    expect(a.thumbnail).toEqual(thumb);
    expect(a.sizeBytes).toBeGreaterThan(10);
    expect((await lib.list()).map((e) => e.name)).toEqual(['Gear', 'bracket cover', 'Bracket']);
    expect((await lib.search('  BRACKET ')).map((e) => e.name)).toEqual([
      'bracket cover',
      'Bracket',
    ]);
    expect(await lib.search('zzz')).toEqual([]);
    expect((await lib.search('')).length).toBe(3);

    const opened = await lib.open(c.id);
    expect(opened.doc.meta.name).toBe('Gear');
    // re-save same name replaces in place, keeps thumbnail, bumps recency
    const a2 = await lib.save(doc('Bracket'), new Map([['x', new Uint8Array(1)]]) as ProjectFiles);
    expect(a2.id).toBe(a.id);
    expect(a2.thumbnail).toEqual(thumb);
    expect((await lib.list()).map((e) => e.name)[0]).toBe('Bracket');
    expect((await lib.open(a.id)).cache.has('x')).toBe(true);

    await lib.remove(b.id);
    expect((await lib.list()).length).toBe(2);
    await lib.remove(b.id); // idempotent
    await expect(lib.open(b.id)).rejects.toMatchObject({ code: 'not-found' });
    lib.close();
  });

  it('uses doc.meta.id and explicit id so renames do not duplicate', async () => {
    const lib = await openLibrary({ codec, dbName: fresh(), disableOpfs: true });
    const e1 = await lib.save(doc('One', { id: 'doc-1' }));
    const e2 = await lib.save(doc('Renamed', { id: 'doc-1' }));
    expect(e2.id).toBe(e1.id);
    expect((await lib.list()).map((e) => e.name)).toEqual(['Renamed']);
    const e3 = await lib.save(doc('Other'), undefined, undefined, { id: 'explicit' });
    expect(e3.id).toBe('explicit');
    lib.close();
  });

  it('reports corrupt documents', async () => {
    const bad: LibraryCodec = {
      ...codec,
      fromWhittle: () => {
        throw new Error('boom');
      },
    };
    const lib = await openLibrary({ codec: bad, dbName: fresh(), disableOpfs: true });
    const e = await lib.save(doc('X'));
    await expect(lib.open(e.id)).rejects.toMatchObject({ code: 'corrupt' });
    lib.close();
  });

  it('turns quota errors into a human message and leaves no partial entry', async () => {
    const store: BlobStore = {
      kind: 'idb',
      put: async () => {
        throw quota();
      },
      get: async () => undefined,
      remove: async () => {},
    };
    const lib = await openLibrary({ codec, dbName: fresh(), blobStore: store });
    const err = await lib.save(doc('Big')).catch((e) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect(err.code).toBe('quota');
    expect(err.message).toMatch(/Not enough browser storage/);
    expect(await lib.list()).toEqual([]);
    lib.close();
  });

  it('isQuotaError recognises variants', () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('The quota has been exceeded'))).toBe(true);
    expect(isQuotaError(new Error('other'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('OPFS blobs', () => {
  it('stores bytes in OPFS, metadata in IndexedDB', async () => {
    const dir = mockOpfs();
    const store = await createOpfsStore(async () => dir);
    expect(store?.kind).toBe('opfs');
    const lib = await openLibrary({ codec, dbName: fresh(), blobStore: store });
    expect(lib.backend).toBe('opfs');
    const e = await lib.save(doc('Part A'));
    expect([...dir.files.keys()].filter((k) => k.endsWith('.whittle')).length).toBe(1);
    expect((await lib.open(e.id)).doc.meta.name).toBe('Part A');
    await lib.remove(e.id);
    expect([...dir.files.keys()].filter((k) => k.endsWith('.whittle')).length).toBe(0);
    lib.close();
  });

  it('createOpfsStore is undefined when OPFS is missing or has no createWritable', async () => {
    expect(await createOpfsStore(async () => mockOpfs({ noWritable: true }))).toBeUndefined();
    expect(
      await createOpfsStore(async () => {
        throw new Error('no');
      }),
    ).toBeUndefined();
    expect(await createOpfsStore()).toBeUndefined(); // Node: no navigator.storage
  });

  it('falls back to IndexedDB blobs when an OPFS write fails (non-quota)', async () => {
    const dir = mockOpfs();
    const store = (await createOpfsStore(async () => dir)) as BlobStore;
    const failing: BlobStore = {
      ...store,
      put: async () => {
        throw new Error('InvalidStateError');
      },
    };
    const lib = await openLibrary({ codec, dbName: fresh(), blobStore: failing });
    const e = await lib.save(doc('Fallback'));
    expect(dir.files.size).toBe(0);
    expect((await lib.open(e.id)).doc.meta.name).toBe('Fallback');
    await lib.remove(e.id);
    lib.close();
  });

  it('does not fall back on OPFS quota errors', async () => {
    const dir = mockOpfs({ writeError: quota });
    const store = await createOpfsStore(async () => dir);
    const lib = await openLibrary({ codec, dbName: fresh(), blobStore: store });
    await expect(lib.save(doc('Full'))).rejects.toMatchObject({ code: 'quota' });
    expect(await lib.list()).toEqual([]);
    lib.close();
  });

  it('moves a document between stores without leaking the old blob', async () => {
    const dir = mockOpfs();
    const opfs = (await createOpfsStore(async () => dir)) as BlobStore;
    let failNext = true;
    const flaky: BlobStore = {
      ...opfs,
      put: async (id, b) => {
        if (failNext) throw new Error('transient');
        return opfs.put(id, b);
      },
    };
    const lib = await openLibrary({ codec, dbName: fresh(), blobStore: flaky });
    const e = await lib.save(doc('Mover')); // lands in idb
    failNext = false;
    await lib.save(doc('Mover')); // now opfs
    expect(dir.files.size).toBe(1);
    expect((await lib.open(e.id)).doc.meta.name).toBe('Mover');
    lib.close();
  });
});
