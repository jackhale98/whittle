// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/engine.test.ts (`FakeRemote`), made a full provider.
/**
 * An in-memory file service with revisions, a change log and optimistic concurrency, for tests,
 * demos and the UI workstream. Several devices (sync engines) can share one instance. Switches
 * simulate going offline, expiring cursors and another device racing a write.
 */

import type {
  FileProviderKind,
  RemoteEntry,
  RemoteFolder,
  RemoteListing,
  StorageProvider,
  StorageResult,
} from '@whittle/contracts';
import { MANIFEST_FILE } from '@whittle/document';
import { baseName, fail, ok, SKIP_FOLDERS } from './common';

interface Stored {
  path: string;
  rev: string;
  bytes: Uint8Array;
}

export interface MemoryProviderOptions {
  kind?: FileProviderKind;
  caseSensitive?: boolean;
  pollMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class MemoryProvider implements StorageProvider {
  readonly kind: FileProviderKind;
  readonly caseSensitive: boolean;
  readonly pollMs: number;

  readonly files = new Map<string, Stored>();
  readonly log: RemoteEntry[] = [];
  /** Requests answered, by method (for tests). */
  readonly calls = { list: 0, read: 0, write: 0, remove: 0 };
  /** `false`: every call fails with `OFFLINE`. */
  online = true;
  /** Called before each write or remove (to simulate another device racing it). */
  beforeWrite: ((path: string) => void) | null = null;
  #rev = 0;
  #epoch = 0;

  constructor(options: MemoryProviderOptions = {}) {
    this.kind = options.kind ?? 'dropbox';
    this.caseSensitive = options.caseSensitive ?? false;
    this.pollMs = options.pollMs ?? 60_000;
  }

  #key(path: string): string {
    return this.caseSensitive ? path : path.toLowerCase();
  }

  /** Another device (or person) writes a file directly. Returns the new revision. */
  put(path: string, content: Uint8Array | string): string {
    const rev = `r${++this.#rev}`;
    const bytes = typeof content === 'string' ? enc.encode(content) : content.slice();
    this.files.set(this.#key(path), { path, rev, bytes });
    this.log.push({ kind: 'file', path, rev, size: bytes.length });
    return rev;
  }

  /** Another device deletes a file directly. */
  delete(path: string): void {
    const f = this.files.get(this.#key(path));
    if (!f) return;
    this.files.delete(this.#key(path));
    this.log.push({ kind: 'deleted', path: f.path });
  }

  /** The file's bytes, or `undefined`. */
  bytes(path: string): Uint8Array | undefined {
    return this.files.get(this.#key(path))?.bytes;
  }

  text(path: string): string | undefined {
    const b = this.bytes(path);
    return b ? dec.decode(b) : undefined;
  }

  /** Every cursor handed out so far is now too old (`CURSOR_EXPIRED`). */
  expireCursors(): void {
    this.#epoch += 1;
  }

  #offline<T>(): StorageResult<T> | null {
    return this.online ? null : fail('OFFLINE', 'Can’t reach the service. Changes stay queued.');
  }

  async list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    const off = this.#offline<RemoteListing>();
    if (off) return off;
    this.calls.list += 1;
    const cursor = `${this.#epoch}:${this.log.length}`;
    if ('cursor' in start) {
      const [epoch, at] = start.cursor.split(':').map(Number);
      if (epoch !== this.#epoch || at === undefined || !Number.isFinite(at)) {
        return fail('CURSOR_EXPIRED', 'The change list expired.');
      }
      return ok({ entries: this.log.slice(at).map((e) => ({ ...e })), cursor, complete: false });
    }
    const prefix = `${this.#key(start.path.replace(/\/+$/, ''))}/`;
    const entries: RemoteEntry[] = [];
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rel = f.path.slice(prefix.length);
      if (rel.split('/').some((p) => SKIP_FOLDERS.has(p.toLowerCase()))) continue;
      entries.push({ kind: 'file', path: f.path, rev: f.rev, size: f.bytes.length });
    }
    return ok({ entries, cursor, complete: true });
  }

  async read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    const off = this.#offline<{ bytes: Uint8Array; rev: string }>();
    if (off) return off;
    this.calls.read += 1;
    const f = this.files.get(this.#key(path));
    if (!f) return fail('NOT_FOUND', `‘${path}’ isn’t there.`, { path });
    return ok({ bytes: f.bytes.slice(), rev: f.rev });
  }

  async write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    const off = this.#offline<{ rev: string }>();
    if (off) return off;
    this.beforeWrite?.(path);
    this.calls.write += 1;
    const f = this.files.get(this.#key(path));
    if (ifRev === null ? f !== undefined : f?.rev !== ifRev) {
      return fail('CONFLICT', `‘${path}’ changed elsewhere.`, { path });
    }
    return ok({ rev: this.put(f?.path ?? path, bytes) });
  }

  async remove(path: string, ifRev: string | null): Promise<StorageResult<void>> {
    const off = this.#offline<void>();
    if (off) return off;
    this.beforeWrite?.(path);
    this.calls.remove += 1;
    const f = this.files.get(this.#key(path));
    if (!f) return ok(undefined);
    if (f.rev !== ifRev) return fail('CONFLICT', `‘${path}’ changed elsewhere.`, { path });
    this.delete(path);
    return ok(undefined);
  }

  async browse(path: string): Promise<StorageResult<RemoteFolder[]>> {
    const off = this.#offline<RemoteFolder[]>();
    if (off) return off;
    const prefix = `${this.#key(path.replace(/\/+$/, ''))}/`;
    const found = new Map<string, RemoteFolder>();
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length).split('/');
      if (rest.length < 2) continue;
      const name = rest[0] as string;
      if (name.startsWith('.')) continue;
      const folderPath = `${path.replace(/\/+$/, '')}/${name}`;
      const entry = found.get(name) ?? { name, path: folderPath, isProject: false };
      if (rest.length === 2 && baseName(f.path) === MANIFEST_FILE) entry.isProject = true;
      found.set(name, entry);
    }
    return ok([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
}
