// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * isomorphic-git's `fs` over the File System Access API (local git repo mode, ADR-029): the
 * user's own checkout, through the folder handle they picked (the repository root).
 *
 * - Paths are POSIX and relative to the handle: `/` is the picked folder, `/.git/HEAD` its git
 *   directory. `.` segments are dropped, and `..` is resolved lexically and may never climb above
 *   the root; such a path reads as missing and refuses writes, so nothing is ever read or written
 *   outside the picked folder.
 * - Errors are Node-style (`code` = `ENOENT`, `EEXIST`, `ENOTDIR`, `ENOTEMPTY`, `EISDIR`, `EPERM`,
 *   `ENOTSUP`), which isomorphic-git branches on.
 * - Every file write goes through `createWritable` + `close`, which Chromium commits atomically
 *   (it writes a swap file and moves it into place on close); a failed write is aborted, so a
 *   reader sees the old file or the new one, never half of one.
 * - File System Access has no symlinks, modes, inodes or ctimes. Stats are synthesised from the
 *   file's `size` and `lastModified` (ms) with `ino`/`uid`/`gid`/`dev` = 0 and `ctime` = `mtime`.
 *   They are stable for an unchanged file, so after isomorphic-git refreshes an index entry once,
 *   later status checks match it from the stats alone and don't rehash the file.
 */

import type { PromiseFsClient } from 'isomorphic-git';
import type { FolderFileHandle, FolderHandle } from '../../providers/folder';

export type FsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EISDIR'
  | 'EPERM'
  | 'ENOTSUP'
  | 'EACCES'
  | 'ENOSPC'
  | 'EBUSY'
  | 'EIO';

/** A Node-style filesystem error (`err.code`), as isomorphic-git expects. */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly syscall: string;
  readonly path: string;
  constructor(code: FsErrorCode, syscall: string, path: string, detail?: string) {
    super(`${code}: ${detail ?? describe(code)}, ${syscall} '${path}'`);
    this.name = 'FsError';
    this.code = code;
    this.syscall = syscall;
    this.path = path;
  }
}

function describe(code: FsErrorCode): string {
  switch (code) {
    case 'ENOENT':
      return 'no such file or directory';
    case 'EEXIST':
      return 'file already exists';
    case 'ENOTDIR':
      return 'not a directory';
    case 'ENOTEMPTY':
      return 'directory not empty';
    case 'EISDIR':
      return 'illegal operation on a directory';
    case 'EPERM':
      return 'operation not permitted';
    case 'ENOTSUP':
      return 'operation not supported (File System Access has no symlinks)';
    case 'EACCES':
      return 'permission denied';
    case 'ENOSPC':
      return 'no space left on device';
    case 'EBUSY':
      return 'resource busy';
    default:
      return 'i/o error';
  }
}

/** Stats in the shape isomorphic-git reads (`normalizeStats`, `compareStats`). */
export class FsaStats {
  readonly type: 'file' | 'dir';
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly ino = 0;
  readonly dev = 0;
  readonly uid = 0;
  readonly gid = 0;
  constructor(type: 'file' | 'dir', size: number, mtimeMs: number) {
    this.type = type;
    this.mode = type === 'file' ? 0o100644 : 0o040000;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = mtimeMs;
    this.mtime = new Date(mtimeMs);
    this.ctime = this.mtime;
  }
  isFile(): boolean {
    return this.type === 'file';
  }
  isDirectory(): boolean {
    return this.type === 'dir';
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

type Encoding = { encoding?: string | null } | string | undefined;

const encodingOf = (o: Encoding): string | null =>
  typeof o === 'string' ? o : (o?.encoding ?? null);

/**
 * Resolves a POSIX path against the root: the segments, or `null` when `..` would climb above it.
 * Backslashes and NUL are not path separators here; names containing them are refused by the
 * browser (and by `checkName`).
 */
export function resolveSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const s of String(path).split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

const domName = (e: unknown): string | undefined =>
  (e as { name?: string } | null | undefined)?.name;

/** Maps a DOMException from the File System Access API to a Node-style error. */
function mapDom(e: unknown, syscall: string, path: string): FsError {
  if (e instanceof FsError) return e;
  switch (domName(e)) {
    case 'NotFoundError':
      return new FsError('ENOENT', syscall, path);
    case 'TypeMismatchError':
      return new FsError('ENOTDIR', syscall, path);
    case 'InvalidModificationError':
      return new FsError('ENOTEMPTY', syscall, path);
    case 'NotAllowedError':
    case 'SecurityError':
      return new FsError('EACCES', syscall, path, 'Whittle no longer has access to the folder');
    case 'QuotaExceededError':
      return new FsError('ENOSPC', syscall, path);
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return new FsError('EBUSY', syscall, path, 'the file is in use by another program');
    case 'TypeError':
      // The browser refused the name (e.g. `..`, or characters the OS can't store).
      return new FsError('ENOENT', syscall, path, 'invalid file name');
    default:
      return new FsError('EIO', syscall, path, (e as Error)?.message ?? String(e));
  }
}

type Found =
  | { kind: 'dir'; handle: FolderHandle }
  | { kind: 'file'; handle: FolderFileHandle; parent: FolderHandle; name: string };

/**
 * A plain `Uint8Array` the writer owns. isomorphic-git hands over Node-style `Buffer`s, which
 * can be views into a shared pool that is reused afterwards, so bytes are always copied.
 */
const toBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  let view: Uint8Array;
  if (data instanceof ArrayBuffer) view = new Uint8Array(data);
  else if (ArrayBuffer.isView(data))
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new TypeError('writeFile: data must be a string or bytes');
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
};

/** The operations behind `fsaGitFs` (exported for tests and the local repo opener). */
export class FsaPromises {
  constructor(readonly root: FolderHandle) {}

  async #dirAt(segs: readonly string[], syscall: string, path: string): Promise<FolderHandle> {
    let d = this.root;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s);
      } catch (e) {
        throw mapDom(e, syscall, path);
      }
    }
    return d;
  }

  async #find(path: string, syscall: string): Promise<Found> {
    const segs = resolveSegments(path);
    if (segs === null) throw new FsError('ENOENT', syscall, path, 'outside the picked folder');
    if (segs.length === 0) return { kind: 'dir', handle: this.root };
    const name = segs[segs.length - 1] as string;
    const parent = await this.#dirAt(segs.slice(0, -1), syscall, path);
    try {
      return { kind: 'file', handle: await parent.getFileHandle(name), parent, name };
    } catch (e) {
      if (domName(e) !== 'TypeMismatchError') throw mapDom(e, syscall, path);
    }
    try {
      return { kind: 'dir', handle: await parent.getDirectoryHandle(name) };
    } catch (e) {
      throw mapDom(e, syscall, path);
    }
  }

  /** The parent folder of a path that is to be created or removed, and the entry's name. */
  async #parentOf(
    path: string,
    syscall: string,
    create: boolean,
  ): Promise<{ parent: FolderHandle; name: string }> {
    const segs = resolveSegments(path);
    if (segs === null) throw new FsError('EPERM', syscall, path, 'outside the picked folder');
    const name = segs.pop();
    if (name === undefined) throw new FsError('EPERM', syscall, path, 'the picked folder itself');
    if (!create) return { parent: await this.#dirAt(segs, syscall, path), name };
    let d = this.root;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s, { create: true });
      } catch (e) {
        throw mapDom(e, syscall, path);
      }
    }
    return { parent: d, name };
  }

  async readFile(path: string, options?: Encoding): Promise<Uint8Array | string> {
    if (path === undefined) throw new FsError('ENOENT', 'open', String(path));
    const found = await this.#find(path, 'open');
    if (found.kind === 'dir') throw new FsError('EISDIR', 'read', path);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await (await found.handle.getFile()).arrayBuffer());
    } catch (e) {
      throw mapDom(e, 'read', path);
    }
    const enc = encodingOf(options);
    return enc === 'utf8' || enc === 'utf-8' ? new TextDecoder().decode(bytes) : bytes;
  }

  /** Creates missing parent folders; replaces the file atomically. Options (`mode`) are ignored. */
  async writeFile(path: string, data: unknown, _options?: unknown): Promise<void> {
    const bytes = toBytes(data);
    const { parent, name } = await this.#parentOf(path, 'open', true);
    let handle: FolderFileHandle;
    try {
      handle = await parent.getFileHandle(name, { create: true });
    } catch (e) {
      if (domName(e) === 'TypeMismatchError') throw new FsError('EISDIR', 'open', path);
      throw mapDom(e, 'open', path);
    }
    let w: Awaited<ReturnType<FolderFileHandle['createWritable']>>;
    try {
      w = await handle.createWritable();
    } catch (e) {
      throw mapDom(e, 'open', path);
    }
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => undefined);
      throw mapDom(e, 'write', path);
    }
  }

  async unlink(path: string): Promise<void> {
    const found = await this.#find(path, 'unlink');
    if (found.kind === 'dir') throw new FsError('EISDIR', 'unlink', path);
    try {
      await found.parent.removeEntry(found.name);
    } catch (e) {
      throw mapDom(e, 'unlink', path);
    }
  }

  async readdir(path: string, _options?: unknown): Promise<string[]> {
    const found = await this.#find(path, 'scandir');
    if (found.kind === 'file') throw new FsError('ENOTDIR', 'scandir', path);
    const names: string[] = [];
    try {
      for await (const h of found.handle.values()) names.push(h.name);
    } catch (e) {
      throw mapDom(e, 'scandir', path);
    }
    return names;
  }

  /** What `name` is in `parent`: a file, a folder, or nothing. */
  async #kindIn(parent: FolderHandle, name: string, syscall: string, path: string) {
    try {
      await parent.getFileHandle(name);
      return 'file' as const;
    } catch (e) {
      if (domName(e) === 'TypeMismatchError') return 'dir' as const;
      if (domName(e) === 'NotFoundError') return null;
      throw mapDom(e, syscall, path);
    }
  }

  /** Single level unless `{ recursive: true }`: the parent must exist (`ENOENT`), like Node. */
  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const recursive = typeof options === 'object' && options?.recursive === true;
    const { parent, name } = await this.#parentOf(path, 'mkdir', recursive);
    const there = await this.#kindIn(parent, name, 'mkdir', path);
    if (there === 'dir' && recursive) return;
    if (there !== null) throw new FsError('EEXIST', 'mkdir', path);
    try {
      await parent.getDirectoryHandle(name, { create: true });
    } catch (e) {
      throw mapDom(e, 'mkdir', path);
    }
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const found = await this.#find(path, 'rmdir');
    if (found.kind === 'file') throw new FsError('ENOTDIR', 'rmdir', path);
    const recursive = options?.recursive === true;
    if (!recursive) {
      const first = await found.handle.values()[Symbol.asyncIterator]().next();
      if (!first.done) throw new FsError('ENOTEMPTY', 'rmdir', path);
    }
    const { parent, name } = await this.#parentOf(path, 'rmdir', false);
    try {
      await parent.removeEntry(name, { recursive });
    } catch (e) {
      throw mapDom(e, 'rmdir', path);
    }
  }

  /** Node's `rm`: files, or folders with `recursive`; `force` ignores a missing path. */
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    let found: Found;
    try {
      found = await this.#find(path, 'rm');
    } catch (e) {
      if (options?.force && (e as FsError).code === 'ENOENT') return;
      throw e;
    }
    if (found.kind === 'file') return this.unlink(path);
    if (!options?.recursive) throw new FsError('EISDIR', 'rm', path);
    return this.rmdir(path, { recursive: true });
  }

  async stat(path: string, _options?: unknown): Promise<FsaStats> {
    const found = await this.#find(path, 'stat');
    if (found.kind === 'dir') return new FsaStats('dir', 0, 0);
    try {
      const f = await found.handle.getFile();
      return new FsaStats('file', f.size, f.lastModified);
    } catch (e) {
      throw mapDom(e, 'stat', path);
    }
  }

  /** There are no symlinks, so `lstat` is `stat`. */
  lstat(path: string, options?: unknown): Promise<FsaStats> {
    return this.stat(path, options);
  }

  async readlink(path: string, _options?: unknown): Promise<never> {
    // A missing path is ENOENT (from the lookup); anything else isn't a link, as nothing can be.
    await this.#find(path, 'readlink');
    throw new FsError('ENOTSUP', 'readlink', path);
  }

  async symlink(_target: string, path: string): Promise<never> {
    throw new FsError('ENOTSUP', 'symlink', path);
  }
}

/**
 * An isomorphic-git `PromiseFsClient` over a folder the user picked (desktop Chromium). `/` is the
 * folder itself; pass `dir: '/'` (and `gitdir: '/.git'`) to isomorphic-git.
 */
export function fsaGitFs(root: FolderHandle): PromiseFsClient & { promises: FsaPromises } {
  // isomorphic-git binds `fs.promises` only when it's an own, enumerable property.
  return { promises: new FsaPromises(root) };
}
