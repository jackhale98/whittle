// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local git repo mode (ADR-029): a folder the user picked (desktop Chromium, File System Access)
 * that is a git working tree. Whittle's versions are that repository's commits.
 *
 * `openLocalGitRepo(root, { projectPath })` finds the git directory:
 * - `.git/` in the picked folder;
 * - a `.git` *file* (`gitdir: <path>`, linked worktrees and submodules) whose git directory is
 *   inside the picked folder (File System Access can't reach anything outside it); a linked
 *   worktree's shared `commondir` must be inside too;
 * - the picked folder itself being a bare repository (read-only: there's no working tree).
 *
 * Then `state()` reports what makes the project read-only right now (a merge, rebase,
 * cherry-pick, revert or bisect in progress, a detached HEAD, a bare repository, another git
 * holding `index.lock`, an index format isomorphic-git can't write), and the history refuses
 * saving, switching, pulling and releasing while it lasts. `ensureCacheIgnored()` keeps Whittle's
 * `.whittle/` cache out of the repository.
 */

import type {
  Author,
  Credential,
  DocMerger,
  GitHistory,
  StorageError,
  StorageResult,
} from '@whittle/contracts';
import git, { type HttpClient, type PromiseFsClient } from 'isomorphic-git';
import { type FolderHandle, folderPermission } from '../../providers/folder';
import { CACHE_PREFIX } from '../hash';
import type { GitHost } from './auth';
import { type FsError, fsaGitFs, resolveSegments } from './fsa-fs';
import { createGitHistory } from './git';
import { ProjectScope } from './scope';
import type { StatusCounters } from './status';

export interface LocalGitRepoOptions {
  /** The project folder inside the repository (`ProjectLink.path`), `''` (default) for the root. */
  projectPath?: string;
  /** Who merge commits made by `pull` are by. */
  author?: Author;
  /**
   * To fetch, pull and push through the CORS proxy when the repository has an `origin` remote
   * and the user signed in to its host. Without it the history is local-only (push and pull stay
   * with the user's own git tools).
   */
  http?: HttpClient;
  host?: GitHost;
  credentials?: () => Credential | null | Promise<Credential | null>;
  corsProxy?: string | null;
  merger?: DocMerger;
  now?: () => Date;
  /** Skip the folder permission check (tests; the app checks on a click first). */
  skipPermission?: boolean;
}

export type LocalRepoProblem =
  | 'merge'
  | 'rebase'
  | 'cherryPick'
  | 'revert'
  | 'bisect'
  | 'detached'
  | 'bare'
  | 'busy'
  | 'indexFormat';

export interface LocalRepoState {
  /** The checked-out branch (`main`), `null` when HEAD is detached or the repository is bare. */
  branch: string | null;
  /** HEAD's commit, `null` before the first commit. */
  head: string | null;
  /** Why the project is read-only right now, with an explanation for the UI; `null`: it isn't. */
  readOnly: { reason: LocalRepoProblem; message: string } | null;
}

export interface LocalGitRepo {
  history: GitHistory & {
    currentBranch(): Promise<string>;
    readonly statusCounters: StatusCounters;
  };
  /** isomorphic-git `fs` over the picked folder (`dir` is `/`). */
  fs: PromiseFsClient;
  dir: '/';
  gitdir: string;
  /** Normalised `ProjectLink.path` (`''` for the root). */
  projectPath: string;
  /** How the repository was found. */
  layout: 'dotgit' | 'gitfile' | 'worktree' | 'bare';
  /** Read fresh on every call (the user's git may have started or finished a merge). */
  state(): Promise<LocalRepoState>;
  /**
   * Whether `.whittle/` (the regenerable cache) is gitignored for this project. With
   * `{ add: true }`, appends `.whittle/` to the repository's root `.gitignore` when it isn't
   * (the UI asks the user first).
   */
  ensureCacheIgnored(options?: {
    add?: boolean;
  }): Promise<StorageResult<{ ignored: boolean; added: boolean }>>;
}

const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });
const fail = <T>(code: StorageError['code'], message: string): StorageResult<T> => ({
  ok: false,
  error: { code, message },
});

// Per-worktree paths of a linked worktree's git directory; everything else is shared and lives
// in its `commondir` (git's `common_list`, path.c).
const SHARED_TOP = new Set([
  'branches',
  'common',
  'hooks',
  'info',
  'logs',
  'lost-found',
  'objects',
  'refs',
  'remotes',
  'worktrees',
  'rr-cache',
  'svn',
  'config',
  'gc.pid',
  'packed-refs',
  'shallow',
]);
const PRIVATE = [
  'info/sparse-checkout',
  'logs/HEAD',
  'logs/refs/bisect',
  'logs/refs/rewritten',
  'logs/refs/worktree',
  'refs/bisect',
  'refs/rewritten',
  'refs/worktree',
];

export function sharedGitPath(rel: string): boolean {
  if (PRIVATE.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
  return SHARED_TOP.has(rel.split('/')[0] ?? '');
}

/**
 * An fs where `/.git/…` is a linked worktree's git directory: per-worktree files (HEAD, index,
 * MERGE_HEAD…) from `gitdir`, shared ones (objects, refs, config…) from `commondir`, the way git
 * reads them. isomorphic-git has no `commondir` support of its own.
 */
export function worktreeGitFs(
  base: PromiseFsClient,
  gitdir: string,
  commondir: string,
): PromiseFsClient {
  const map = (path: unknown): string => {
    const p = String(path);
    const segs = resolveSegments(p);
    if (segs === null || segs[0] !== '.git') return p;
    const rel = segs.slice(1).join('/');
    const root = rel !== '' && sharedGitPath(rel) ? commondir : gitdir;
    return rel === '' ? root : `${root}/${rel}`;
  };
  const b = base.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const wrap =
    (name: string) =>
    (path: unknown, ...rest: unknown[]) =>
      (b[name] as (...args: unknown[]) => Promise<unknown>).call(base.promises, map(path), ...rest);
  return {
    promises: {
      readFile: wrap('readFile'),
      writeFile: wrap('writeFile'),
      unlink: wrap('unlink'),
      readdir: wrap('readdir'),
      mkdir: wrap('mkdir'),
      rmdir: wrap('rmdir'),
      stat: wrap('stat'),
      lstat: wrap('lstat'),
      readlink: wrap('readlink'),
      // symlink(target, path): map the second argument.
      symlink: (target: unknown, path: unknown) =>
        (b.symlink as (...args: unknown[]) => Promise<unknown>).call(
          base.promises,
          target,
          map(path),
        ),
      rm: wrap('rm'),
    },
  } as PromiseFsClient;
}

async function kind(fs: PromiseFsClient, path: string): Promise<'file' | 'dir' | null> {
  try {
    const st = (await fs.promises.stat(path)) as { isDirectory(): boolean };
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

async function text(fs: PromiseFsClient, path: string): Promise<string | null> {
  try {
    return String(await fs.promises.readFile(path, { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const isAbsolute = (p: string) =>
  p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** `gitdir: ../x` resolved against `from` (segments); `null` when it leaves the picked folder. */
function resolveInside(from: readonly string[], target: string): string | null {
  if (isAbsolute(target)) return null;
  const segs = resolveSegments([...from, ...target.replace(/\\/g, '/').split('/')].join('/'));
  return segs === null ? null : `/${segs.join('/')}`;
}

interface Located {
  fs: PromiseFsClient;
  gitdir: string;
  layout: LocalGitRepo['layout'];
}

async function locate(root: FolderHandle): Promise<StorageResult<Located>> {
  const base = fsaGitFs(root);
  const dotgit = await kind(base, '/.git');
  if (dotgit === 'dir') return ok({ fs: base, gitdir: '/.git', layout: 'dotgit' });
  if (dotgit === 'file') {
    const body = (await text(base, '/.git')) ?? '';
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(body)?.[1];
    if (!target) {
      return fail(
        'UNSUPPORTED',
        `The .git file in ‘${root.name}’ doesn’t say where its repository is.`,
      );
    }
    const gitdir = resolveInside([], target);
    const outside = (what: string) =>
      fail<Located>(
        'UNSUPPORTED',
        `This folder is a git ${what} whose repository is outside ‘${root.name}’ (${target}). The browser can only reach the folder you picked: pick the folder that holds the repository, or use a normal clone.`,
      );
    if (gitdir === null) return outside('worktree or submodule');
    if ((await kind(base, gitdir)) !== 'dir') {
      return fail('NOT_FOUND', `The repository this .git file points to (${target}) isn’t there.`);
    }
    const common = await text(base, `${gitdir}/commondir`);
    if (common === null) return ok({ fs: base, gitdir, layout: 'gitfile' });
    const commondir = resolveInside(gitdir.split('/').filter(Boolean), common.trim());
    if (commondir === null) return outside('worktree');
    if ((await kind(base, commondir)) !== 'dir') {
      return fail(
        'NOT_FOUND',
        `The repository this worktree belongs to (${common.trim()}) isn’t there.`,
      );
    }
    return ok({ fs: worktreeGitFs(base, gitdir, commondir), gitdir: '/.git', layout: 'worktree' });
  }
  // The picked folder may be a bare repository itself.
  if (
    (await kind(base, '/HEAD')) === 'file' &&
    (await kind(base, '/objects')) === 'dir' &&
    (await kind(base, '/refs')) === 'dir'
  ) {
    return ok({ fs: base, gitdir: '/', layout: 'bare' });
  }
  return fail(
    'NOT_FOUND',
    `‘${root.name}’ isn’t a git repository (it has no .git folder). Pick the repository’s top folder.`,
  );
}

const MESSAGES: Record<LocalRepoProblem, string> = {
  merge:
    'A git merge is in progress in this repository. Finish it (or run git merge --abort) with your git tools; until then Whittle shows the project read-only.',
  rebase:
    'A git rebase is in progress in this repository. Finish it (or run git rebase --abort) with your git tools; until then Whittle shows the project read-only.',
  cherryPick:
    'A git cherry-pick is in progress in this repository. Finish or abort it with your git tools; until then Whittle shows the project read-only.',
  revert:
    'A git revert is in progress in this repository. Finish or abort it with your git tools; until then Whittle shows the project read-only.',
  bisect:
    'A git bisect is in progress in this repository. Run git bisect reset when you’re done; until then Whittle shows the project read-only.',
  detached:
    'HEAD is detached (a commit is checked out, not a branch), so new versions would belong to no branch. Check out a branch with your git tools, or switch to one here; until then the project is read-only.',
  bare: 'This is a bare repository: it has no working files, so Whittle can only show its history.',
  busy: 'Another git program is working on this repository (.git/index.lock exists). Try again when it has finished; if no git is running, delete that file.',
  indexFormat:
    'This repository’s index uses a format Whittle can’t write (only version 2). Run git update-index --index-version 2 to change it.',
};

/** Opens a local git working tree (see the module comment). */
export async function openLocalGitRepo(
  root: FolderHandle,
  options: LocalGitRepoOptions = {},
): Promise<StorageResult<LocalGitRepo>> {
  if (!options.skipPermission) {
    const perm = await folderPermission(root);
    if (!perm.ok) return perm;
  }
  let scope: ProjectScope;
  try {
    scope = new ProjectScope(options.projectPath ?? '');
  } catch (e) {
    return fail('NOT_FOUND', (e as Error).message);
  }
  let found: StorageResult<Located>;
  try {
    found = await locate(root);
  } catch (e) {
    return fail(
      (e as FsError).code === 'EACCES' ? 'PERMISSION' : 'REMOTE',
      `Couldn’t read ‘${root.name}’: ${(e as Error).message}`,
    );
  }
  if (!found.ok) return found;
  const { fs, gitdir } = found.value;
  let layout = found.value.layout;
  const at = { fs, dir: '/', gitdir };
  const config = async (path: string) =>
    git.getConfig({ ...at, path }).catch(() => undefined) as Promise<unknown>;
  const format = String((await config('extensions.objectformat')) ?? 'sha1').toLowerCase();
  if (format !== 'sha1') {
    return fail(
      'UNSUPPORTED',
      `This repository uses ${format} object names, which Whittle can’t read yet.`,
    );
  }
  if (Number((await config('core.repositoryformatversion')) ?? 0) > 1) {
    return fail('UNSUPPORTED', 'This repository uses a newer git format than Whittle can read.');
  }
  const bare = layout === 'bare' || String(await config('core.bare')) === 'true';
  if (bare) layout = 'bare';

  const state = async (): Promise<LocalRepoState> => {
    const head = await git.resolveRef({ ...at, ref: 'HEAD' }).catch(() => null);
    const headText = (await text(fs, `${gitdir}/HEAD`)) ?? '';
    const symbolic = /^ref:\s*refs\/heads\/(\S+)/.exec(headText)?.[1] ?? null;
    const branch = bare ? null : symbolic;
    const has = async (p: string) => (await kind(fs, `${gitdir}/${p}`)) !== null;
    let reason: LocalRepoProblem | null = null;
    if (bare) reason = 'bare';
    else if (await has('MERGE_HEAD')) reason = 'merge';
    else if ((await has('rebase-merge')) || (await has('rebase-apply'))) reason = 'rebase';
    else if (await has('CHERRY_PICK_HEAD')) reason = 'cherryPick';
    else if (await has('REVERT_HEAD')) reason = 'revert';
    else if (await has('BISECT_LOG')) reason = 'bisect';
    else if (symbolic === null) reason = 'detached';
    else if (await has('index.lock')) reason = 'busy';
    else {
      try {
        const bytes = (await fs.promises.readFile(`${gitdir}/index`)) as Uint8Array;
        const version =
          bytes.length >= 8 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(4) : 2;
        if (version !== 2) reason = 'indexFormat';
      } catch {
        // No index yet (nothing staged ever): fine.
      }
    }
    return { branch, head, readOnly: reason ? { reason, message: MESSAGES[reason] } : null };
  };

  let url: string | null = null;
  if (options.http) {
    const u = await config('remote.origin.url');
    url = typeof u === 'string' && /^https?:\/\//.test(u) ? u : null;
  }
  const http: HttpClient = options.http ?? {
    request: async () => {
      throw new Error('This local repository has no network access configured');
    },
  };
  const history = createGitHistory({
    fs,
    http,
    dir: '/',
    gitdir,
    projectPath: scope.prefix,
    url,
    init: false,
    bare,
    symlinks: false,
    writable: async () => {
      const s = await state();
      return s.readOnly ? { code: 'READ_ONLY', message: s.readOnly.message } : null;
    },
    ...(options.author ? { author: options.author } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.corsProxy !== undefined ? { corsProxy: options.corsProxy } : {}),
    ...(options.merger ? { merger: options.merger } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const ensureCacheIgnored = async (
    o: { add?: boolean } = {},
  ): Promise<StorageResult<{ ignored: boolean; added: boolean }>> => {
    if (bare) return fail('UNSUPPORTED', MESSAGES.bare);
    const probe = scope.toRepo(`${CACHE_PREFIX}cache`);
    const check = () => git.isIgnored({ fs, dir: '/', gitdir, filepath: probe }).catch(() => false);
    try {
      if (await check()) return ok({ ignored: true, added: false });
      if (!o.add) return ok({ ignored: false, added: false });
      const before = (await text(fs, '/.gitignore')) ?? '';
      const sep = before === '' || before.endsWith('\n') ? '' : '\n';
      await fs.promises.writeFile(
        '/.gitignore',
        `${before}${sep}# Whittle's regenerable cache (meshes, thumbnails)\n${CACHE_PREFIX}\n`,
      );
      return ok({ ignored: await check(), added: true });
    } catch (e) {
      return fail(
        (e as FsError).code === 'EACCES' ? 'PERMISSION' : 'REMOTE',
        `Couldn’t update .gitignore: ${(e as Error).message}`,
      );
    }
  };

  return ok({
    history,
    fs,
    dir: '/',
    gitdir,
    projectPath: scope.prefix,
    layout,
    state,
    ensureCacheIgnored,
  });
}
