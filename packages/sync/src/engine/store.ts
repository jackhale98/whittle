// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/sync/engine.ts (`SyncStore`), extended with state and bases.
/**
 * The local side of a sync: the working copy, the persisted `SyncState` and the merge bases
 * (bytes by SHA-256). The app implements it over its local library (OPFS/IndexedDB); tests use
 * `MemorySyncStore`. See `createIdbSyncStore` for state and bases in IndexedDB.
 */

import type { ProjectFiles, SyncState } from '@wren-cad/contracts';
import { bytesEqual } from './hash';

export type FileChanges = ReadonlyMap<string, Uint8Array | null>;

export interface SyncLocalStore {
  /** The local working copy (may include `.wren/`; the engine ignores it). */
  readFiles(): Promise<ProjectFiles>;
  /**
   * Applies sync's changes (`null` deletes), but only if every path in `expected` still has
   * those bytes (`null`: absent). Otherwise writes nothing and returns `false`: the user saved
   * meanwhile, and the engine merges again instead of overwriting. Must be atomic with respect
   * to the app's own saves.
   */
  writeFiles(changes: FileChanges, expected: FileChanges): Promise<boolean>;
  loadState(): Promise<SyncState | null>;
  saveState(state: SyncState): Promise<void>;
  /** Base bytes by SHA-256 hex, `null` if unknown. */
  getBase(hash: string): Promise<Uint8Array | null>;
  putBase(hash: string, bytes: Uint8Array): Promise<void>;
  /** Optional: forget base bytes no longer referenced by the state. */
  pruneBases?(keep: ReadonlySet<string>): Promise<void>;
}

const clone = (s: SyncState): SyncState => structuredClone(s);

/** Everything in memory. `files` is the working copy; `save` simulates the app saving. */
export class MemorySyncStore implements SyncLocalStore {
  readonly files: ProjectFiles = new Map();
  readonly bases = new Map<string, Uint8Array>();
  state: SyncState | null = null;
  /** How many times `writeFiles` refused because the working copy changed. */
  refusedWrites = 0;

  constructor(files?: ProjectFiles) {
    if (files) for (const [p, b] of files) this.files.set(p, b);
  }

  /** The app saved a file locally (`null` deletes). Doesn't notify the engine. */
  save(path: string, content: Uint8Array | string | null): void {
    if (content === null) this.files.delete(path);
    else
      this.files.set(
        path,
        typeof content === 'string' ? new TextEncoder().encode(content) : content,
      );
  }

  text(path: string): string | undefined {
    const b = this.files.get(path);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  async readFiles(): Promise<ProjectFiles> {
    return new Map(this.files);
  }

  async writeFiles(changes: FileChanges, expected: FileChanges): Promise<boolean> {
    for (const [p, want] of expected) {
      if (!bytesEqual(this.files.get(p) ?? null, want)) {
        this.refusedWrites += 1;
        return false;
      }
    }
    for (const [p, b] of changes) {
      if (b === null) this.files.delete(p);
      else this.files.set(p, b);
    }
    return true;
  }

  async loadState(): Promise<SyncState | null> {
    return this.state ? clone(this.state) : null;
  }

  async saveState(state: SyncState): Promise<void> {
    this.state = clone(state);
  }

  async getBase(hash: string): Promise<Uint8Array | null> {
    return this.bases.get(hash) ?? null;
  }

  async putBase(hash: string, bytes: Uint8Array): Promise<void> {
    this.bases.set(hash, bytes);
  }

  async pruneBases(keep: ReadonlySet<string>): Promise<void> {
    for (const h of [...this.bases.keys()]) if (!keep.has(h)) this.bases.delete(h);
  }
}
