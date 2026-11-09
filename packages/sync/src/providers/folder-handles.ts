// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Folder connections keep their `FileSystemDirectoryHandle` in IndexedDB (handles are
 * structured-cloneable, not JSON), under `Connection.handleKey`.
 */

import { ulid } from '@wren-cad/document';
import { type DBSchema, openDB } from 'idb';
import type { FolderHandle } from './folder';

interface HandleSchema extends DBSchema {
  handles: { key: string; value: FolderHandle };
}

const db = (name: string) =>
  openDB<HandleSchema>(name, 1, {
    upgrade(d) {
      d.createObjectStore('handles');
    },
  });

/** Stores a picked folder; returns its `handleKey`. */
export async function saveFolderHandle(
  handle: FolderHandle,
  options: { key?: string; dbName?: string } = {},
): Promise<string> {
  const key = options.key ?? ulid();
  const d = await db(options.dbName ?? 'whittle-folders');
  await d.put('handles', handle, key);
  d.close();
  return key;
}

export async function loadFolderHandle(
  key: string,
  options: { dbName?: string } = {},
): Promise<FolderHandle | null> {
  const d = await db(options.dbName ?? 'whittle-folders');
  const h = (await d.get('handles', key)) ?? null;
  d.close();
  return h;
}

export async function removeFolderHandle(
  key: string,
  options: { dbName?: string } = {},
): Promise<void> {
  const d = await db(options.dbName ?? 'whittle-folders');
  await d.delete('handles', key);
  d.close();
}
