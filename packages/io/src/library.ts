// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-only: IndexedDB (idb) metadata + OPFS blobs with an IndexedDB-blob fallback.
import type { Id, LibraryEntry, LocalLibrary, ProjectFiles, WhittleDoc } from '@whittle/contracts';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

/** The subset of `ProjectCodec` (packages/document) the library needs; inject any instance. */
export interface LibraryCodec {
  toWhittle(doc: WhittleDoc, cache?: ProjectFiles, extra?: ProjectFiles): Uint8Array;
  fromWhittle(bytes: Uint8Array): { doc: WhittleDoc; cache: ProjectFiles; extra?: ProjectFiles };
}

export type LibraryErrorCode = 'quota' | 'not-found' | 'storage' | 'corrupt';

/** Error with a message that is safe to show to the user. */
export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LibraryError';
    this.code = code;
  }
}

/** Where document bytes live. */
export interface BlobStore {
  readonly kind: 'opfs' | 'idb';
  put(id: Id, bytes: Uint8Array): Promise<void>;
  get(id: Id): Promise<Uint8Array | undefined>;
  remove(id: Id): Promise<void>;
}

interface MetaRecord {
  id: Id;
  name: string;
  modified: string;
  sizeBytes: number;
  thumbnail?: Uint8Array;
  /** Which BlobStore holds the bytes. */
  store: 'opfs' | 'idb';
}

interface LibSchema extends DBSchema {
  meta: { key: Id; value: MetaRecord; indexes: { modified: string } };
  blobs: { key: Id; value: Uint8Array };
}

export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; code?: number; message?: string };
  return (
    err.name === 'QuotaExceededError' ||
    err.code === 22 ||
    err.code === 1014 ||
    /quota/i.test(err.message ?? '')
  );
}

const DIR_NAME = 'whittle-library';

// Minimal OPFS typings (not all lib.dom versions include createWritable).
interface OpfsFileHandle {
  getFile(): Promise<File>;
  createWritable?: () => Promise<{
    write(d: BufferSource): Promise<void>;
    close(): Promise<void>;
    abort?: () => Promise<void>;
  }>;
}
interface OpfsDir {
  getFileHandle(name: string, o?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
}

/** OPFS-backed store; `undefined` when OPFS (with `createWritable`) is unavailable. */
export async function createOpfsStore(
  root?: () => Promise<OpfsDir>,
): Promise<BlobStore | undefined> {
  try {
    const getRoot =
      root ??
      (async () => {
        const nav = navigator as unknown as { storage?: { getDirectory?: () => Promise<unknown> } };
        if (!nav.storage?.getDirectory) throw new Error('no OPFS');
        const r = (await nav.storage.getDirectory()) as {
          getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<OpfsDir>;
        };
        return r.getDirectoryHandle(DIR_NAME, { create: true });
      });
    const dir = await getRoot();
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (typeof probe.createWritable !== 'function') return undefined; // Safari main thread
    await dir.removeEntry('.probe').catch(() => undefined);
    const fname = (id: Id) => `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.whittle`;
    return {
      kind: 'opfs',
      async put(id, bytes) {
        const fh = await dir.getFileHandle(fname(id), { create: true });
        const w = await (fh.createWritable as NonNullable<OpfsFileHandle['createWritable']>)();
        try {
          await w.write(bytes as unknown as BufferSource);
          await w.close();
        } catch (e) {
          await w.abort?.().catch(() => undefined);
          throw e;
        }
      },
      async get(id) {
        try {
          const fh = await dir.getFileHandle(fname(id));
          return new Uint8Array(await (await fh.getFile()).arrayBuffer());
        } catch (e) {
          if ((e as { name?: string }).name === 'NotFoundError') return undefined;
          throw e;
        }
      },
      async remove(id) {
        try {
          await dir.removeEntry(fname(id));
        } catch (e) {
          if ((e as { name?: string }).name !== 'NotFoundError') throw e;
        }
      },
    };
  } catch {
    return undefined;
  }
}

export interface LibraryOptions {
  codec: LibraryCodec;
  /** IndexedDB database name (default `whittle-library`). */
  dbName?: string;
  /** Override blob storage (tests). Default: OPFS when usable, else IndexedDB blobs. */
  blobStore?: BlobStore;
  /** Force the IndexedDB blob fallback even if OPFS works. */
  disableOpfs?: boolean;
  now?: () => Date;
  newId?: () => Id;
}

function defaultId(): Id {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Local document library: implements `LocalLibrary`. Create with `openLibrary()`. */
export class IdbLibrary implements LocalLibrary {
  private constructor(
    private readonly db: IDBPDatabase<LibSchema>,
    private readonly primary: BlobStore,
    private readonly idbBlobs: BlobStore,
    private readonly opts: Required<Pick<LibraryOptions, 'codec' | 'now' | 'newId'>>,
  ) {}

  static async open(options: LibraryOptions): Promise<IdbLibrary> {
    const db = await openDB<LibSchema>(options.dbName ?? 'whittle-library', 1, {
      upgrade(d) {
        const meta = d.createObjectStore('meta', { keyPath: 'id' });
        meta.createIndex('modified', 'modified');
        d.createObjectStore('blobs');
      },
    });
    const idbBlobs: BlobStore = {
      kind: 'idb',
      async put(id, bytes) {
        await db.put('blobs', bytes, id);
      },
      get: (id) => db.get('blobs', id),
      async remove(id) {
        await db.delete('blobs', id);
      },
    };
    const primary =
      options.blobStore ?? (options.disableOpfs ? undefined : await createOpfsStore()) ?? idbBlobs;
    return new IdbLibrary(db, primary, idbBlobs, {
      codec: options.codec,
      now: options.now ?? (() => new Date()),
      newId: options.newId ?? defaultId,
    });
  }

  /** Where new documents are written. */
  get backend(): 'opfs' | 'idb' {
    return this.primary.kind;
  }

  close(): void {
    this.db.close();
  }

  private store(kind: 'opfs' | 'idb'): BlobStore {
    return kind === this.primary.kind ? this.primary : this.idbBlobs;
  }

  private toEntry(r: MetaRecord): LibraryEntry {
    const e: LibraryEntry = {
      id: r.id,
      name: r.name,
      modified: r.modified,
      sizeBytes: r.sizeBytes,
    };
    if (r.thumbnail) e.thumbnail = r.thumbnail;
    return e;
  }

  async list(): Promise<LibraryEntry[]> {
    try {
      const all = await this.db.getAll('meta');
      all.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      return all.map((r) => this.toEntry(r));
    } catch (e) {
      throw this.wrap(e, 'list the library');
    }
  }

  async search(query: string): Promise<LibraryEntry[]> {
    const q = query.trim().toLowerCase();
    const all = await this.list();
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
  }

  async open(id: Id): Promise<{ doc: WhittleDoc; cache: ProjectFiles; extra: ProjectFiles }> {
    let meta: MetaRecord | undefined;
    let bytes: Uint8Array | undefined;
    try {
      meta = await this.db.get('meta', id);
      if (meta) bytes = await this.store(meta.store).get(id);
    } catch (e) {
      throw this.wrap(e, 'open the document');
    }
    if (!meta || !bytes) {
      throw new LibraryError('not-found', 'That document is no longer in the library.');
    }
    try {
      const r = this.opts.codec.fromWhittle(bytes);
      return { doc: r.doc, cache: r.cache, extra: r.extra ?? new Map() };
    } catch (e) {
      throw new LibraryError(
        'corrupt',
        `"${meta.name}" could not be read; the saved file may be damaged.`,
        { cause: e },
      );
    }
  }

  /**
   * Save (insert or replace). The id is `options.id`, else `doc.meta.id` when the document carries
   * one, else the id of the entry with the same name, else a fresh UUID.
   */
  async save(
    doc: WhittleDoc,
    cache?: ProjectFiles,
    thumbnail?: Uint8Array,
    options: { id?: Id; extra?: ProjectFiles } = {},
  ): Promise<LibraryEntry> {
    const bytes = this.opts.codec.toWhittle(doc, cache, options.extra);
    const name = doc.meta.name || 'Untitled';
    let id = options.id ?? (doc.meta as { id?: unknown }).id;
    let prev: MetaRecord | undefined;
    try {
      if (typeof id !== 'string') {
        prev = (await this.db.getAll('meta')).find((r) => r.name === name);
        id = prev?.id ?? this.opts.newId();
      } else {
        prev = await this.db.get('meta', id);
      }
    } catch (e) {
      throw this.wrap(e, 'save the document');
    }
    const docId: Id = id as string;

    // 1. blob: primary, falling back to IndexedDB for non-quota failures.
    let kind = this.primary.kind;
    try {
      await this.primary.put(docId, bytes);
    } catch (e) {
      if (isQuotaError(e) || this.primary === this.idbBlobs)
        throw this.wrap(e, 'save the document', name);
      try {
        await this.idbBlobs.put(docId, bytes);
        kind = 'idb';
      } catch (e2) {
        throw this.wrap(e2, 'save the document', name);
      }
    }
    // 2. metadata
    const rec: MetaRecord = {
      id: docId,
      name,
      modified: this.opts.now().toISOString(),
      sizeBytes: bytes.byteLength,
      store: kind,
      ...(thumbnail ? { thumbnail } : prev?.thumbnail ? { thumbnail: prev.thumbnail } : {}),
    };
    try {
      await this.db.put('meta', rec);
    } catch (e) {
      await this.store(kind)
        .remove(docId)
        .catch(() => undefined);
      throw this.wrap(e, 'save the document', name);
    }
    // 3. drop a stale blob if the document moved between stores
    if (prev && prev.store !== kind)
      await this.store(prev.store)
        .remove(docId)
        .catch(() => undefined);
    return this.toEntry(rec);
  }

  async remove(id: Id): Promise<void> {
    try {
      const meta = await this.db.get('meta', id);
      if (!meta) return;
      await this.store(meta.store).remove(id);
      await this.db.delete('meta', id);
    } catch (e) {
      throw this.wrap(e, 'delete the document');
    }
  }

  /** Approximate browser storage usage/quota, when the platform reports it. */
  async estimate(): Promise<{ usage: number; quota: number } | undefined> {
    const s = (globalThis.navigator as Navigator | undefined)?.storage;
    if (!s?.estimate) return undefined;
    const { usage, quota } = await s.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  }

  private wrap(e: unknown, action: string, name?: string): LibraryError {
    if (e instanceof LibraryError) return e;
    if (isQuotaError(e)) {
      return new LibraryError(
        'quota',
        `Not enough browser storage to ${action}${name ? ` ("${name}")` : ''}. Delete some library items or use Save to disk instead.`,
        { cause: e },
      );
    }
    return new LibraryError(
      'storage',
      `Could not ${action}: the browser's local storage is unavailable or failed.`,
      { cause: e },
    );
  }
}

/** Open the local library (IndexedDB metadata, OPFS blobs with IndexedDB fallback). */
export const openLibrary = (options: LibraryOptions): Promise<IdbLibrary> =>
  IdbLibrary.open(options);
