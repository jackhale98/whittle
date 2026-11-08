/**
 * Local git repo mode (ADR-029): a folder on this computer that is a git working tree. Versions
 * are real commits in it, through isomorphic-git over a File System Access `fs`.
 *
 * Seam: packages/sync is gaining `fsaGitFs`, `openLocalGitRepo` (project folders inside a repo,
 * read-only states) and `ensureCacheIgnored`. Until they land this module uses them when
 * `@whittle/sync` exports them and falls back to the small versions below, so the app merges
 * cleanly either way. The fallback only supports a project at the repo root
 * (`projectFoldersSupported()`), because `GitHistory` doesn't scope commits to a subfolder yet.
 */

import type { Author, Credential, GitHistory } from '@whittle/contracts';
import * as sync from '@whittle/sync';
import { browserGitHttp, createGitHistory } from '@whittle/sync';

/** What the package layer will export (ADR-029); looked up by name so either version compiles. */
const pkg = sync as unknown as Record<string, unknown>;

type GitFs = Parameters<typeof createGitHistory>[0]['fs'];

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'detached';

/** Project folders inside the repo need `createGitHistory({ projectPath })` from packages/sync. */
export function projectFoldersSupported(): boolean {
  return typeof pkg.openLocalGitRepo === 'function';
}

// ------------------------------------------------------------------ File System Access fs

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

function mapDomError(e: unknown, path: string): Error {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotFoundError') return fsError('ENOENT', path);
  if (name === 'TypeMismatchError') return fsError('ENOTDIR', path);
  if (name === 'InvalidModificationError') return fsError('ENOTEMPTY', path);
  return e instanceof Error ? e : new Error(String(e));
}

const segments = (path: string) => path.split('/').filter((s) => s && s !== '.');

interface Stat {
  type: 'file' | 'dir';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function stat(type: 'file' | 'dir', size: number, mtimeMs: number): Stat {
  return {
    type,
    mode: type === 'file' ? 0o100644 : 0o40000,
    size,
    ino: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
  };
}

/** isomorphic-git's promise `fs` over a directory handle; `/` is the handle itself. */
export function fsaGitFsFallback(root: FileSystemDirectoryHandle): GitFs {
  const dir = async (segs: string[], create: boolean, path: string) => {
    let d = root;
    try {
      for (const s of segs) d = await d.getDirectoryHandle(s, { create });
    } catch (e) {
      throw mapDomError(e, path);
    }
    return d;
  };
  const parent = async (path: string, create = false) => {
    const segs = segments(path);
    const name = segs.pop();
    if (!name) throw fsError('EISDIR', path);
    return { d: await dir(segs, create, path), name };
  };
  const promises = {
    async readFile(path: string, opts?: { encoding?: string } | string) {
      const { d, name } = await parent(path);
      let bytes: Uint8Array;
      try {
        const f = await (await d.getFileHandle(name)).getFile();
        bytes = new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        throw mapDomError(e, path);
      }
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      return enc === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
    },
    async writeFile(path: string, data: Uint8Array | string) {
      const { d, name } = await parent(path, true);
      try {
        const w = await (await d.getFileHandle(name, { create: true })).createWritable();
        await w.write(
          (typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data) as Uint8Array<ArrayBuffer>,
        );
        await w.close();
      } catch (e) {
        throw mapDomError(e, path);
      }
    },
    async unlink(path: string) {
      const { d, name } = await parent(path);
      try {
        await d.getFileHandle(name); // a directory is not unlinked
        await d.removeEntry(name);
      } catch (e) {
        throw mapDomError(e, path);
      }
    },
    async readdir(path: string) {
      const d = await dir(segments(path), false, path);
      const out: string[] = [];
      for await (const key of (d as unknown as { keys(): AsyncIterable<string> }).keys())
        out.push(key);
      return out;
    },
    async mkdir(path: string) {
      const { d, name } = await parent(path);
      const exists = await d.getDirectoryHandle(name).then(
        () => true,
        () => false,
      );
      if (exists) throw fsError('EEXIST', path);
      try {
        await d.getDirectoryHandle(name, { create: true });
      } catch (e) {
        throw mapDomError(e, path);
      }
    },
    async rmdir(path: string) {
      const { d, name } = await parent(path);
      try {
        await d.getDirectoryHandle(name);
        await d.removeEntry(name);
      } catch (e) {
        throw mapDomError(e, path);
      }
    },
    async stat(path: string): Promise<Stat> {
      const segs = segments(path);
      if (segs.length === 0) return stat('dir', 0, 0);
      const { d, name } = await parent(path);
      try {
        const f = await (await d.getFileHandle(name)).getFile();
        return stat('file', f.size, f.lastModified);
      } catch (e) {
        if ((e as { name?: string }).name !== 'TypeMismatchError') throw mapDomError(e, path);
      }
      await d.getDirectoryHandle(name).catch((e) => {
        throw mapDomError(e, path);
      });
      return stat('dir', 0, 0);
    },
    lstat(path: string) {
      return promises.stat(path);
    },
    async readlink(path: string): Promise<string> {
      throw fsError('ENOSYS', path);
    },
    async symlink(_target: string, path: string): Promise<void> {
      throw fsError('ENOSYS', path);
    },
    async chmod(): Promise<void> {},
  };
  return { promises } as unknown as GitFs;
}

export function fsaGitFs(root: FileSystemDirectoryHandle): GitFs {
  const f = pkg.fsaGitFs;
  return typeof f === 'function' ? (f(root) as GitFs) : fsaGitFsFallback(root);
}

// ------------------------------------------------------------------ repo checks

async function exists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const segs = segments(path);
  const last = segs.pop();
  let d = root;
  try {
    for (const s of segs) d = await d.getDirectoryHandle(s);
    if (!last) return true;
    const asFile = await d.getFileHandle(last).then(
      () => true,
      () => false,
    );
    return (
      asFile ||
      (await d.getDirectoryHandle(last).then(
        () => true,
        () => false,
      ))
    );
  } catch {
    return false;
  }
}

async function text(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  try {
    const b = await fsaGitFsFallback(root).promises.readFile(path, { encoding: 'utf8' });
    return typeof b === 'string' ? b : new TextDecoder().decode(b as Uint8Array);
  } catch {
    return null;
  }
}

/** The picked folder is a git working tree (has `.git/`). */
export function isGitRepo(root: FileSystemDirectoryHandle): Promise<boolean> {
  return exists(root, '/.git/HEAD');
}

/** Merge or rebase in progress, or a detached HEAD: shown read-only (ADR-029 §5). */
export async function repoState(root: FileSystemDirectoryHandle): Promise<RepoState> {
  if (await exists(root, '/.git/MERGE_HEAD')) return 'merging';
  if ((await exists(root, '/.git/rebase-merge')) || (await exists(root, '/.git/rebase-apply')))
    return 'rebasing';
  const head = (await text(root, '/.git/HEAD'))?.trim() ?? '';
  return head.startsWith('ref:') ? 'clean' : 'detached';
}

const CACHE_LINES = new Set([
  '.whittle/',
  '.whittle',
  '/.whittle/',
  '/.whittle',
  '**/.whittle/',
  '**/.whittle',
]);

/** Whether the repo's root `.gitignore` already ignores the `.whittle/` cache. */
export async function cacheIgnored(
  root: FileSystemDirectoryHandle,
  projectPath: string,
): Promise<boolean> {
  const t = await text(root, '/.gitignore');
  if (t === null) return false;
  const own = projectPath ? [`${projectPath}/.whittle/`, `/${projectPath}/.whittle/`] : [];
  return t.split(/\r?\n/).some((l) => CACHE_LINES.has(l.trim()) || own.includes(l.trim()));
}

/** Adds `.whittle/` to the root `.gitignore` (the user agreed inline). */
export async function ensureCacheIgnored(
  root: FileSystemDirectoryHandle,
  projectPath: string,
): Promise<void> {
  const f = pkg.ensureCacheIgnored;
  if (typeof f === 'function') {
    await f(root, { projectPath });
    return;
  }
  if (await cacheIgnored(root, projectPath)) return;
  const t = (await text(root, '/.gitignore')) ?? '';
  const sep = t === '' || t.endsWith('\n') ? '' : '\n';
  await fsaGitFsFallback(root).promises.writeFile(
    '/.gitignore',
    `${t}${sep}# Whittle's regenerable cache (meshes, thumbnails)\n.whittle/\n`,
  );
}

export interface LocalGitOptions {
  root: FileSystemDirectoryHandle;
  /** Project folder relative to the repo root; `''` for the root. */
  projectPath: string;
  author: Author;
  /** The repo's remote, when the user signed in to its host (push and pull through the proxy). */
  remote?: {
    url: string;
    credentials: () => Promise<Credential | null>;
    host: sync.GitHost;
  } | null;
  corsProxy?: string | null;
}

/** `GitHistory` over the repo, scoped to the project folder (when packages/sync supports it). */
export function openLocalGit(
  o: LocalGitOptions,
): GitHistory & { currentBranch(): Promise<string> } {
  const fs = fsaGitFs(o.root);
  const open = pkg.openLocalGitRepo;
  const base = {
    fs,
    http: browserGitHttp,
    dir: '/',
    url: o.remote?.url ?? null,
    author: o.author,
    ...(o.remote ? { credentials: o.remote.credentials, host: o.remote.host } : {}),
    ...(o.corsProxy !== undefined ? { corsProxy: o.corsProxy } : {}),
    projectPath: o.projectPath,
  };
  if (typeof open === 'function')
    return open(o.root, base) as GitHistory & { currentBranch(): Promise<string> };
  return createGitHistory(base);
}
