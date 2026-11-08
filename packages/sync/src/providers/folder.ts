// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A folder on this computer through the File System Access API (desktop Chromium). Point it at a
 * Dropbox/OneDrive/iCloud/Nextcloud desktop-synced folder and the desktop client does the rest.
 *
 * Paths are absolute from the picked folder (`/CAD/bracket/params.json`). There is no change feed,
 * so every listing is complete. Revisions are `<lastModified>:<size>`. The API has no
 * compare-and-swap, so `ifRev` is checked immediately before writing: a desktop client replacing
 * the file in that instant is the one race this can't see. Writes go through `createWritable`,
 * which replaces the file atomically on close.
 */

import type {
  RemoteEntry,
  RemoteFolder,
  RemoteListing,
  StorageProvider,
  StorageResult,
} from '@whittle/contracts';
import { MANIFEST_FILE } from '@whittle/document';
import { fail, forward, ok, SKIP_FOLDERS } from './common';

const SERVICE = 'The folder';

/** The parts of `FileSystemFileHandle` the provider uses (so tests can pass a fake). */
export interface FolderFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ lastModified: number; size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}

type PermissionMode = { mode: 'read' | 'readwrite' };

/** The parts of `FileSystemDirectoryHandle` the provider uses. */
export interface FolderHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FolderHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FolderFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FolderHandle | FolderFileHandle>;
  queryPermission?(d: PermissionMode): Promise<PermissionState>;
  requestPermission?(d: PermissionMode): Promise<PermissionState>;
}

/**
 * Checks (and with `request`, asks for) read-write access. Browsers forget the grant between
 * sessions; asking again needs a user gesture, so sync only checks and the UI asks on a click.
 */
export async function folderPermission(
  handle: FolderHandle,
  request = false,
): Promise<StorageResult<void>> {
  const mode: PermissionMode = { mode: 'readwrite' };
  try {
    let state: PermissionState = (await handle.queryPermission?.(mode)) ?? 'granted';
    if (state === 'prompt' && request && handle.requestPermission) {
      state = await handle.requestPermission(mode);
    }
    if (state === 'granted') return ok(undefined);
    return fail('PERMISSION', `Allow Whittle to use the folder ‘${handle.name}’ again.`);
  } catch (e) {
    return mapError(e, '');
  }
}

function mapError<T>(e: unknown, path: string): StorageResult<T> {
  const name = (e as { name?: string } | null)?.name;
  const where = path ? { path } : {};
  if (name === 'NotFoundError') return fail('NOT_FOUND', `‘${path}’ isn't in the folder.`, where);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return fail('PERMISSION', 'Whittle no longer has access to the folder. Allow it again.', where);
  }
  if (name === 'QuotaExceededError') return fail('QUOTA', 'The disk is full.', where);
  if (name === 'TypeMismatchError') {
    return fail('REMOTE', `‘${path}’ is a folder, not a file (or the other way round).`, where);
  }
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
    return fail('REMOTE', `‘${path}’ is in use by another program; will retry.`, where);
  }
  return fail('REMOTE', `${SERVICE}: ${(e as Error)?.message ?? 'unknown error'}`, where);
}

const parts = (path: string) => path.split('/').filter(Boolean);

const revOf = (f: { lastModified: number; size: number }) => `${f.lastModified}:${f.size}`;

export class FolderProvider implements StorageProvider {
  readonly kind = 'folder' as const;
  /** Windows and macOS file systems are case-insensitive by default. */
  readonly caseSensitive = false;
  readonly pollMs = 30_000;

  constructor(readonly root: FolderHandle) {}

  async #dir(path: string[], create: boolean): Promise<FolderHandle> {
    let d = this.root;
    for (const p of path) d = await d.getDirectoryHandle(p, { create });
    return d;
  }

  async #file(path: string): Promise<FolderFileHandle> {
    const p = parts(path);
    const name = p.pop();
    if (!name) throw Object.assign(new Error('No file name'), { name: 'TypeMismatchError' });
    return (await this.#dir(p, false)).getFileHandle(name);
  }

  /** The current revision, or `null` if there's no file. */
  async #rev(path: string): Promise<StorageResult<string | null>> {
    try {
      return ok(revOf(await (await this.#file(path)).getFile()));
    } catch (e) {
      if ((e as { name?: string })?.name === 'NotFoundError') return ok(null);
      return mapError(e, path);
    }
  }

  async list(start: { path: string } | { cursor: string }): Promise<StorageResult<RemoteListing>> {
    const perm = await folderPermission(this.root);
    if (!perm.ok) return forward(perm);
    let root: string;
    if ('path' in start) root = start.path;
    else {
      try {
        root = (JSON.parse(start.cursor) as { root: string }).root;
        if (typeof root !== 'string') throw new Error();
      } catch {
        return fail('CURSOR_EXPIRED', 'The folder listing is unreadable; listing again.');
      }
    }
    const entries: RemoteEntry[] = [];
    try {
      const walk = async (dir: FolderHandle, path: string): Promise<void> => {
        for await (const h of dir.values()) {
          const p = `${path}/${h.name}`;
          if (h.kind === 'directory') {
            if (!SKIP_FOLDERS.has(h.name.toLowerCase())) await walk(h, p);
          } else {
            const f = await h.getFile();
            entries.push({ kind: 'file', path: p, rev: revOf(f), size: f.size });
          }
        }
      };
      await walk(await this.#dir(parts(root), false), root.replace(/\/+$/, ''));
    } catch (e) {
      return mapError(e, root);
    }
    return ok({ entries, cursor: JSON.stringify({ root, at: Date.now() }), complete: true });
  }

  async read(path: string): Promise<StorageResult<{ bytes: Uint8Array; rev: string }>> {
    try {
      const f = await (await this.#file(path)).getFile();
      return ok({ bytes: new Uint8Array(await f.arrayBuffer()), rev: revOf(f) });
    } catch (e) {
      return mapError(e, path);
    }
  }

  async write(
    path: string,
    bytes: Uint8Array,
    ifRev: string | null,
  ): Promise<StorageResult<{ rev: string }>> {
    const now = await this.#rev(path);
    if (!now.ok) return forward(now);
    if (now.value !== ifRev) {
      return fail('CONFLICT', `‘${path}’ changed in the folder.`, { path });
    }
    try {
      const p = parts(path);
      const name = p.pop() as string;
      const dir = await this.#dir(p, true);
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      try {
        await w.write(bytes);
        await w.close();
      } catch (e) {
        await w.abort?.().catch(() => undefined);
        throw e;
      }
      return ok({ rev: revOf(await handle.getFile()) });
    } catch (e) {
      return mapError(e, path);
    }
  }

  async remove(path: string, ifRev: string | null): Promise<StorageResult<void>> {
    const now = await this.#rev(path);
    if (!now.ok) return forward(now);
    if (now.value === null) return ok(undefined);
    if (now.value !== ifRev) return fail('CONFLICT', `‘${path}’ changed in the folder.`, { path });
    try {
      const p = parts(path);
      const name = p.pop() as string;
      await (await this.#dir(p, false)).removeEntry(name);
      return ok(undefined);
    } catch (e) {
      if ((e as { name?: string })?.name === 'NotFoundError') return ok(undefined);
      return mapError(e, path);
    }
  }

  async browse(path: string): Promise<StorageResult<RemoteFolder[]>> {
    const perm = await folderPermission(this.root);
    if (!perm.ok) return forward(perm);
    try {
      const dir = await this.#dir(parts(path), false);
      const out: RemoteFolder[] = [];
      for await (const h of dir.values()) {
        if (h.kind !== 'directory' || h.name.startsWith('.')) continue;
        let isProject = false;
        try {
          await h.getFileHandle(MANIFEST_FILE);
          isProject = true;
        } catch {
          /* not a project */
        }
        out.push({ name: h.name, path: `${path.replace(/\/+$/, '')}/${h.name}`, isProject });
      }
      return ok(out.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      return mapError(e, path);
    }
  }
}
