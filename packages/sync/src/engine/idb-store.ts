// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `SyncState` and merge bases in IndexedDB, one database for every project on this device. The
 * app supplies the working copy (its local library); this keeps the rest. Bases are stored by
 * SHA-256 per project, so identical files share nothing across projects (simple pruning).
 */

import type { SyncState } from '@whittle/contracts';
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { SyncLocalStore } from './store';

interface SyncSchema extends DBSchema {
  states: { key: string; value: { project: string; state: SyncState } };
  bases: { key: [string, string]; value: { project: string; hash: string; bytes: Uint8Array } };
}

let dbs = new Map<string, Promise<IDBPDatabase<SyncSchema>>>();

function open(name: string): Promise<IDBPDatabase<SyncSchema>> {
  let db = dbs.get(name);
  if (!db) {
    db = openDB<SyncSchema>(name, 1, {
      upgrade(d) {
        d.createObjectStore('states', { keyPath: 'project' });
        d.createObjectStore('bases', { keyPath: ['project', 'hash'] });
      },
    });
    dbs.set(name, db);
  }
  return db;
}

/** Closes cached connections (tests). */
export async function closeSyncDatabases(): Promise<void> {
  const all = [...dbs.values()];
  dbs = new Map();
  for (const d of all) (await d).close();
}

export function createIdbSyncStore(
  /** Library id of the project. */
  project: string,
  workingCopy: Pick<SyncLocalStore, 'readFiles' | 'writeFiles'>,
  options: { dbName?: string } = {},
): SyncLocalStore {
  const name = options.dbName ?? 'whittle-sync';
  return {
    readFiles: () => workingCopy.readFiles(),
    writeFiles: (changes, expected) => workingCopy.writeFiles(changes, expected),
    async loadState() {
      return (await (await open(name)).get('states', project))?.state ?? null;
    },
    async saveState(state) {
      await (await open(name)).put('states', { project, state });
    },
    async getBase(hash) {
      return (await (await open(name)).get('bases', [project, hash]))?.bytes ?? null;
    },
    async putBase(hash, bytes) {
      await (await open(name)).put('bases', { project, hash, bytes });
    },
    async pruneBases(keep) {
      const db = await open(name);
      const tx = db.transaction('bases', 'readwrite');
      const range = IDBKeyRange.bound([project, ''], [project, '￿']);
      for await (const cursor of tx.store.iterate(range)) {
        if (!keep.has(cursor.value.hash)) await cursor.delete();
      }
      await tx.done;
    },
  };
}
