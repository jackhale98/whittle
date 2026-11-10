/**
 * Feature tree folders in the app (M3.6, ADR-066): default names, and which folders the user has
 * collapsed. Collapsed / expanded is per-user UI state, never document data: it is remembered
 * per document in localStorage, and every read or write tolerates storage being unavailable.
 */

import type { FeatureFolder, Id } from '@wren-cad/contracts';

const KEY = 'wren.collapsedFolders.';

/** "Folder 1", "Folder 2", …: the lowest number no folder of the part uses yet. */
export function nextFolderName(folders: readonly Pick<FeatureFolder, 'name'>[]): string {
  const used = new Set(folders.map((f) => f.name));
  for (let n = 1; ; n++) {
    const name = `Folder ${n}`;
    if (!used.has(name)) return name;
  }
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The folders collapsed in document `docId` (empty when nothing is stored or storage fails). */
export function readCollapsedFolders(
  docId: Id,
  store: KeyValueStore | null = defaultStore(),
): Id[] {
  try {
    const raw = store?.getItem(KEY + docId);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is Id => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCollapsedFolders(
  docId: Id,
  ids: readonly Id[],
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(KEY + docId, JSON.stringify(ids));
  } catch {
    /* storage full or blocked: the folders just start open next time */
  }
}
