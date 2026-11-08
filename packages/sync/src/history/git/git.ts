// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/git/repo.ts (same author, GPL-3.0-or-later); its line merge is replaced by DocMerger.
/**
 * Git history for git connections (PLAN §8A.3, ADR-020 item 1) and local git repo mode
 * (ADR-029), on isomorphic-git. Versions are commits, branches are git branches and releases are
 * annotated tags, so a project interoperates with GitHub/GitLab/Forgejo pull requests, reviews
 * and CI, and with the user's own git tools.
 *
 * - The repository is any isomorphic-git `fs`: LightningFS on IndexedDB for hosted connections
 *   (`browserGitFs`), or the user's checkout through File System Access (`fsaGitFs`,
 *   `openLocalGitRepo`).
 * - `projectPath` scopes everything to the project's folder in the repository: versioned paths,
 *   `read`, `saveVersion`, `workingChanges`, `log`, diffs, merges and releases. Files read back are
 *   project-relative.
 * - Commits are built from tree objects, never from the index: a commit records exactly the
 *   project's files spliced into the parent's tree, so anything else the user has staged or
 *   edited stays as it is. The branch moves with a compare-and-swap; a branch that moved
 *   underneath is a `CONFLICT`, never an overwrite. A working file that changed since the commit
 *   being replaced (and isn't what is being committed) refuses the commit instead of being
 *   overwritten.
 * - `pull` fast-forwards, or merges the parsed project with `DocMerger` (model files) and whole
 *   bytes (other files); files outside the project merge whole-file. Clean merges are committed
 *   with both parents; conflicts come back as `{ kind: 'conflicts' }` and nothing is committed
 *   until `commitMerge`.
 * - Switching branches and fast-forwarding refuse while the project has uncommitted changes, and
 *   never force a checkout: other files with local edits the checkout would replace refuse it too.
 * - Automatic snapshots are commits under `refs/whittle/auto/…` (never pushed, never checked out);
 *   pruning deletes those refs.
 * - Every network call goes through the CORS proxy (browsers can't talk to git hosts directly),
 *   except to `localhost`. Tokens come from the `credentials` callback per request.
 */

import './polyfill';
import type {
  Author,
  Branch,
  Credential,
  DocMerger,
  GitHistory,
  GitProgress,
  GitPullResult,
  GitPushResult,
  ProjectFiles,
  PrunePolicy,
  Release,
  StorageError,
  StorageResult,
  Version,
} from '@whittle/contracts';
import { slugify } from '@whittle/document';
import git, {
  Errors,
  type HttpClient,
  type PromiseFsClient,
  type ReadCommitResult,
} from 'isomorphic-git';
import { isModelPath, mergeProjectFiles } from '../../merge/files';
import { docMerger } from '../../merge/merge';
import { hashProjectFiles, isVersionedPath, sameBytes, versionedFiles } from '../hash';
import { gitRefName, nameProblem } from '../names';
import { selectPrunable } from '../prune';
import { basicAuth, type GitHost, retryAuth, secretOf } from './auth';
import { lfsPointer, matchesLfs } from './lfs';
import { appendReflog, type ReflogEntry } from './reflog';
import { ProjectScope } from './scope';
import { gitdirOf, projectStatus, type StatusCounters, type WorkingChange } from './status';
import {
  commitTree,
  flatten,
  type GitAt,
  type LeafEntry,
  linksChanging,
  spliceAll,
  subtreeAt,
  type TreeEdit,
  treeEntries,
  writeNested,
} from './tree';

/** isomorphic-git's public CORS proxy: fine for development, self-host for production (PLAN §8A.2). */
export const DEFAULT_CORS_PROXY = 'https://cors.isomorphic-git.org';

const REMOTE = 'origin';
const AUTO_REFS = 'refs/whittle/auto';
const RELEASE_FILE = 'Whittle-Release-File: ';
const OID = /^[0-9a-f]{40}$/;

export interface GitHistoryOptions {
  /** isomorphic-git filesystem: `browserGitFs(projectId)` in the app, any in-memory fs in tests. */
  fs: PromiseFsClient;
  /** `isomorphic-git/http/web` in the browser, `isomorphic-git/http/node` in Node. */
  http: HttpClient;
  /** Working tree folder inside `fs`, e.g. `/repo`. */
  dir: string;
  /** The `.git` folder, when it isn't `<dir>/.git` (e.g. a File System Access checkout adapter). */
  gitdir?: string;
  /**
   * The project's folder inside the repository (`ProjectLink.path`), `''` (the default) for the
   * repository root. Everything is scoped to it; files are project-relative.
   */
  projectPath?: string;
  /** HTTPS clone URL, or `null` for a local-only repository. */
  url: string | null;
  /** How the host takes tokens (default `other`). */
  host?: GitHost;
  /** Read per request from `CredentialVault`; `null` for public repositories. */
  credentials?: () => Credential | null | Promise<Credential | null>;
  /** Prefix for git's HTTP requests; `null` for none. Default `DEFAULT_CORS_PROXY`. Never used for localhost. */
  corsProxy?: string | null;
  /** Branch to work on; default: the remote's default branch (or `main`). */
  branch?: string | null;
  /** Who merge commits made by `pull` are by. */
  author?: Author;
  merger?: DocMerger;
  now?: () => Date;
  /**
   * Start a repository on the first save when there is none (default `true`). Local git repo
   * mode passes `false`: Whittle never runs `git init` in a user's folder.
   */
  init?: boolean;
  /** A bare repository: there is no working tree (`workingChanges` is always empty). */
  bare?: boolean;
  /**
   * The fs can create symbolic links (default `true`). File System Access can't: a switch or
   * fast-forward that would check out a symlink is refused before anything is written.
   */
  symlinks?: boolean;
  /**
   * Asked before anything that changes the repository's commits, branches or working tree
   * (`saveVersion`, `commitMerge`, `switchBranch`, `pull`, `release`); an error refuses the
   * operation with it. Local git repo mode reports a merge or rebase in progress, a detached HEAD
   * or a bare repository here.
   */
  writable?: () => Promise<StorageError | null>;
}

/** The proxy to use for `url`: none for local servers or when disabled. */
export function corsProxyFor(
  url: string | null,
  proxy: string | null | undefined,
): string | undefined {
  if (proxy === null || url === null) return undefined;
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return undefined;
  } catch {
    return undefined;
  }
  return proxy ?? DEFAULT_CORS_PROXY;
}

const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });
const fail = <T>(code: StorageError['code'], message: string): StorageResult<T> => ({
  ok: false,
  error: { code, message },
});

/** An operation refused with a StorageError (thrown inside, returned as a value by `guard`). */
class Refusal extends Error {
  constructor(readonly error: StorageError) {
    super(error.message);
  }
}
const refuse = (code: StorageError['code'], message: string, path?: string) =>
  new Refusal(path === undefined ? { code, message } : { code, message, path });

interface GitErrorLike {
  code?: string;
  message?: string;
  data?: { statusCode?: number; reason?: string; filepaths?: string[] };
}

/** A human, token-free StorageError for anything isomorphic-git throws. */
export function gitError(e: unknown, secret: string | null, host: string): StorageError {
  const err = (e ?? {}) as GitErrorLike;
  let message = String(err.message ?? e);
  if (secret) message = message.split(secret).join('•••');
  message = message.replace(/\/\/[^/@\s]+@/g, '//');
  const status = err.data?.statusCode;
  if (err.code === 'HttpError' && status !== undefined) {
    if (status === 401 || status === 403) {
      return {
        code: 'AUTH',
        status,
        message: `${host} refused the sign-in. Check the token and that it can read and write this repository.`,
      };
    }
    if (status === 404)
      return {
        code: 'NOT_FOUND',
        status,
        message: `${host} has no such repository (or the token can’t see it).`,
      };
    if (status === 429)
      return {
        code: 'RATE_LIMITED',
        status,
        message: `${host} is limiting requests. Try again in a minute.`,
      };
    return { code: 'REMOTE', status, message: `${host} answered ${status}: ${message}` };
  }
  if (err.code === 'UserCanceledError')
    return { code: 'AUTH', message: `Sign in to ${host} to continue.` };
  if (err.code === 'NotFoundError') return { code: 'NOT_FOUND', message };
  if (err.code === 'CheckoutConflictError') {
    const files = err.data?.filepaths ?? [];
    return {
      code: 'CONFLICT',
      message: `These files have changes that the switch would replace: ${listOf(files)}. Commit or stash them with your git tools first.`,
    };
  }
  if (err.code === 'UnmergedPathsError') {
    return {
      code: 'CONFLICT',
      message:
        'The repository has unresolved merge conflicts. Finish the merge with your git tools first.',
    };
  }
  const fsCode = (e as { code?: string } | null)?.code;
  if (fsCode === 'EACCES') {
    return {
      code: 'PERMISSION',
      message: 'Whittle no longer has access to the folder. Allow it again.',
    };
  }
  if (fsCode === 'ENOSPC') return { code: 'QUOTA', message: 'The disk is full.' };
  const offline = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false;
  if (offline || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/.test(message)) {
    return {
      code: 'OFFLINE',
      message: `Couldn’t reach ${host}. Changes stay here until you’re back online.`,
    };
  }
  if (e instanceof TypeError && /fetch/i.test(message)) {
    return {
      code: 'CORS',
      message: `The browser couldn’t reach ${host}. Check the CORS proxy setting.`,
    };
  }
  return { code: 'REMOTE', message: `${host}: ${message}` };
}

/** CRLF → LF for UTF-8 text (git's autocrlf clean step); other bytes as they are. */
function toLf(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(13)) return bytes;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  } catch {
    return bytes;
  }
}

function listOf(paths: readonly string[], max = 6): string {
  const shown = paths.slice(0, max).map((p) => `‘${p}’`);
  return paths.length > max
    ? `${shown.join(', ')} and ${paths.length - max} more`
    : shown.join(', ');
}

/**
 * Paths Whittle manages in a project (the model, attachments, previews, release exports).
 * Anything else in the project folder is carried along untouched.
 */
export function ownedPath(path: string): boolean {
  return isModelPath(path) || /^(imports|previews|releases)\//.test(path);
}

async function mkdirp(fs: PromiseFsClient, dir: string): Promise<void> {
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
    }
  }
}

/** One path whose committed entry changes, and the bytes to put there. */
interface TreeChange {
  /** Repository-relative. */
  path: string;
  before: LeafEntry | null;
  after: LeafEntry | null;
  bytes?: Uint8Array;
}

type Stamp = { name: string; email: string; timestamp: number; timezoneOffset: number };

class GitHistoryImpl implements GitHistory {
  readonly backend = 'git' as const;
  private readonly fs: PromiseFsClient;
  private readonly http: HttpClient;
  private readonly dir: string;
  private readonly url: string | null;
  private readonly hostKind: GitHost;
  private readonly hostName: string;
  private readonly proxy: string | undefined;
  private readonly merger: DocMerger;
  private readonly now: () => Date;
  private readonly defaultAuthor: Author;
  private readonly scope: ProjectScope;
  private branchName: string | null;
  /** Shared object cache: repeated reads from packfiles are fast. */
  private cache = {};
  private readonly hashes = new Map<string, string>();
  private readonly projectTrees = new Map<string, string | null>();
  private secret: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** How many working files `workingChanges` hashed last time (diagnostics, tests). */
  readonly statusCounters: StatusCounters = { hashed: 0 };

  constructor(private readonly o: GitHistoryOptions) {
    this.fs = o.fs;
    this.http = o.http;
    this.dir = o.dir;
    this.url = o.url;
    this.hostKind = o.host ?? 'other';
    this.proxy = corsProxyFor(o.url, o.corsProxy);
    this.merger = o.merger ?? docMerger;
    this.now = o.now ?? (() => new Date());
    this.defaultAuthor = o.author ?? { name: 'Whittle' };
    this.branchName = o.branch ?? null;
    this.scope = new ProjectScope(o.projectPath ?? '');
    let host = 'the git host';
    try {
      if (o.url) host = new URL(o.url).host;
    } catch {
      // Keep the generic name.
    }
    this.hostName = host;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private local() {
    const at = { fs: this.fs, dir: this.dir, cache: this.cache };
    return this.o.gitdir === undefined ? at : { ...at, gitdir: this.o.gitdir };
  }

  private at(): GitAt {
    return this.local();
  }

  private get gitdir(): string {
    return gitdirOf(this.at());
  }

  /** The path of a repository file in `fs`. */
  private wpath(repoPath: string): string {
    return `${this.dir.replace(/\/+$/, '')}/${repoPath}`;
  }

  /**
   * Forgets cached repository reads (another program may have committed, checked out or
   * repacked). Refs, HEAD, the index and the working tree are read fresh on every call anyway.
   */
  refresh(): void {
    this.cache = {};
    this.projectTrees.clear();
  }

  workingChanges(): Promise<StorageResult<WorkingChange[]>> {
    return this.guard(async () => {
      if (this.o.bare || !(await this.isRepo())) return ok([]);
      return ok(await this.projectChanges());
    });
  }

  private async projectChanges(): Promise<WorkingChange[]> {
    this.statusCounters.hashed = 0;
    return projectStatus(this.at(), this.scope, this.statusCounters);
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    if (!(await this.isRepo())) return [];
    try {
      const { cache: _, ...at } = this.local();
      const list = await git.listRemotes(at);
      return list.map((r) => ({ name: r.remote, url: r.url }));
    } catch {
      return [];
    }
  }

  private async isRepo(): Promise<boolean> {
    try {
      await this.fs.promises.stat(this.gitdir);
      return true;
    } catch {
      return false;
    }
  }

  /** A local-only history starts its repository on first use (unless `init: false`). */
  private async ensureRepo(): Promise<void> {
    if (await this.isRepo()) return;
    if (this.o.init === false) {
      throw refuse('NOT_FOUND', 'This folder isn’t a git repository any more (its .git is gone).');
    }
    await mkdirp(this.fs, this.dir);
    await git.init({ ...this.local(), defaultBranch: this.branchName ?? 'main' });
  }

  private async assertWritable(): Promise<void> {
    const problem = (await this.o.writable?.()) ?? null;
    if (problem) throw new Refusal(problem);
  }

  /** Refuses while the project has uncommitted changes (ADR-029 item 5). */
  private async assertClean(what: string): Promise<void> {
    const changes = await this.projectChanges();
    if (changes.length === 0) return;
    throw refuse(
      'CONFLICT',
      `The project has uncommitted changes (${listOf(
        changes.map((c) => c.path),
        4,
      )}). Save a version first, then ${what}.`,
    );
  }

  private noRemote<T>(what: string): StorageResult<T> {
    return fail(
      'NOT_FOUND',
      `This project has no remote repository to ${what}. Add one in Connections.`,
    );
  }

  /**
   * The project a commit of `files` records: the caller's files, plus every file of `head` in the
   * project folder Whittle doesn't own (a README, CI config), left exactly as it is. An LFS
   * pointer stays the pointer when the content matches it. New files the repository ignores are
   * left out, as `git add` would.
   */
  private async compose(files: ProjectFiles, head: string | null): Promise<ProjectFiles> {
    const out = new Map(versionedFiles(files));
    const before = head ? await this.filesAt(head) : new Map<string, Uint8Array>();
    for (const [p, b] of before) if (!ownedPath(p) && !out.has(p)) out.set(p, b);
    for (const [p, b] of [...out]) {
      const was = before.get(p);
      if (was && !sameBytes(was, b) && lfsPointer(was)) {
        if (await matchesLfs(was, b)) out.set(p, was);
        else {
          throw refuse(
            'UNSUPPORTED',
            `‘${p}’ is stored with Git LFS, which Whittle doesn’t write. Commit that change with your git tools.`,
            p,
          );
        }
      }
      if (!was && (await this.ignored(this.scope.toRepo(p)))) out.delete(p);
    }
    return versionedFiles(out);
  }

  private async ignored(repoPath: string): Promise<boolean> {
    try {
      return await git.isIgnored({
        fs: this.fs,
        dir: this.dir,
        gitdir: this.gitdir,
        filepath: repoPath,
      });
    } catch {
      return false;
    }
  }

  private async net() {
    const cred = (await this.o.credentials?.()) ?? null;
    this.secret = secretOf(cred);
    const host = this.hostKind;
    return {
      ...this.local(),
      http: this.http,
      ...(this.proxy ? { corsProxy: this.proxy } : {}),
      onAuth: () => (cred ? basicAuth(host, cred) : { cancel: true }),
      onAuthFailure: (_url: string, failed: { username?: string }) =>
        (cred && retryAuth(host, cred, failed)) || { cancel: true },
    };
  }

  /** Runs `fn`, turning anything thrown into a StorageError. */
  private async guard<T>(fn: () => Promise<StorageResult<T>>): Promise<StorageResult<T>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, error: e.error };
      return { ok: false, error: gitError(e, this.secret, this.hostName) };
    } finally {
      await this.flush();
    }
  }

  /** LightningFS persists its file table lazily; flush so a closed tab can't lose a commit. */
  private async flush(): Promise<void> {
    const p = this.fs.promises as { flush?: () => Promise<void> };
    await p.flush?.();
  }

  private stamp(a: Author): Stamp {
    return {
      name: a.name,
      email: a.email ?? '',
      timestamp: Math.floor(this.now().getTime() / 1000),
      timezoneOffset: 0,
    };
  }

  async currentBranch(): Promise<string> {
    return (
      (await git.currentBranch({ ...this.local(), fullname: false }).catch(() => undefined)) ??
      this.branchName ??
      'main'
    );
  }

  private async head(): Promise<string | null> {
    return git.resolveRef({ ...this.local(), ref: 'HEAD' }).catch(() => null);
  }

  /** The branch HEAD names (`refs/heads/main`, also when it has no commits yet), or `null` when detached. */
  private async headRef(): Promise<string | null> {
    let text: string;
    try {
      text = String(await this.fs.promises.readFile(`${this.gitdir}/HEAD`, { encoding: 'utf8' }));
    } catch {
      return null;
    }
    const m = /^ref:\s*(\S+)/.exec(text);
    return m?.[1] ?? null;
  }

  private async remoteHead(branch: string): Promise<string | null> {
    return git
      .resolveRef({ ...this.local(), ref: `refs/remotes/${REMOTE}/${branch}` })
      .catch(() => null);
  }

  /** The project's folder tree in a commit (`null`: the project isn't in it). */
  private async projectTree(oid: string): Promise<string | null> {
    if (this.projectTrees.has(oid)) return this.projectTrees.get(oid) ?? null;
    const t = await subtreeAt(this.at(), await commitTree(this.at(), oid), this.scope.segments);
    this.projectTrees.set(oid, t);
    return t;
  }

  /** Every entry of the project folder in a commit, project-relative (all of them, cache too). */
  private async leavesAt(oid: string | null): Promise<Map<string, LeafEntry>> {
    if (oid === null) return new Map();
    return flatten(this.at(), await this.projectTree(oid));
  }

  /** The versioned files of a commit (or ref), project-relative, sorted by path. */
  private async filesAt(ref: string): Promise<ProjectFiles> {
    const oid = OID.test(ref) ? ref : await git.resolveRef({ ...this.local(), ref });
    const out: ProjectFiles = new Map();
    for (const [path, leaf] of await this.leavesAt(oid)) {
      if (leaf.type !== 'blob' || !isVersionedPath(path)) continue;
      const { blob } = await git.readBlob({ ...this.local(), oid: leaf.oid });
      out.set(path, blob);
    }
    return versionedFiles(out);
  }

  private async hashOf(oid: string): Promise<string> {
    const known = this.hashes.get(oid);
    if (known) return known;
    const h = await hashProjectFiles(await this.filesAt(oid));
    this.hashes.set(oid, h);
    return h;
  }

  private async version(
    oid: string,
    auto = false,
    releases?: Map<string, string[]>,
    parents?: string[],
  ): Promise<Version> {
    const { commit } = await git.readCommit({ ...this.local(), oid });
    const v: Version = {
      id: oid,
      parents: parents ?? commit.parent,
      message: commit.message.trim(),
      author: commit.author.email
        ? { name: commit.author.name, email: commit.author.email }
        : { name: commit.author.name },
      at: new Date(commit.author.timestamp * 1000).toISOString(),
      hash: await this.hashOf(oid),
    };
    if (auto) v.auto = true;
    const names = releases?.get(oid);
    if (names?.length) v.releases = names;
    return v;
  }

  // ---- Building commits ---------------------------------------------------------------------

  /**
   * The root tree of a commit recording `content` (project-relative) on top of `head`, with
   * `outside` (repository paths outside the project, from a merge) applied too; and the paths
   * whose entries change.
   */
  private async buildTree(
    content: ProjectFiles,
    head: string | null,
    outside?: Map<string, { before: LeafEntry | null; after: LeafEntry | null }>,
  ): Promise<{ tree: string; changes: TreeChange[] }> {
    const a = this.at();
    const baseTree = head ? await commitTree(a, head) : null;
    const before = await this.leavesAt(head);
    const leaves = new Map<string, LeafEntry>();
    // Kept as they are: submodules, and committed paths that are never versioned (`.whittle/`).
    for (const [p, leaf] of before) {
      if (leaf.type === 'commit' || !isVersionedPath(p)) leaves.set(p, leaf);
    }
    for (const [p, bytes] of content) {
      const prev = before.get(p);
      const { oid } = await git.hashBlob({ object: bytes });
      if (oid !== prev?.oid) await git.writeBlob({ ...this.local(), blob: bytes });
      leaves.set(p, { oid, mode: prev?.type === 'blob' ? prev.mode : '100644', type: 'blob' });
    }
    const changes: TreeChange[] = [];
    for (const p of new Set([...before.keys(), ...leaves.keys()])) {
      const b = before.get(p) ?? null;
      const n = leaves.get(p) ?? null;
      if (b?.oid === n?.oid && b?.mode === n?.mode) continue;
      const bytes = content.get(p);
      changes.push({
        path: this.scope.toRepo(p),
        before: b,
        after: n,
        ...(bytes ? { bytes } : {}),
      });
    }
    const edits = new Map<string, TreeEdit>();
    for (const [path, c] of outside ?? []) {
      edits.set(path, c.after);
      changes.push({ path, before: c.before, after: c.after });
    }
    const sub = await writeNested(a, leaves);
    edits.set(this.scope.prefix, sub === null ? null : { oid: sub, mode: '040000', type: 'tree' });
    return { tree: await spliceAll(a, baseTree, edits), changes };
  }

  /** The bytes of a working file, `null` when there's none, `'dir'` for a folder. */
  private async readWork(repoPath: string): Promise<Uint8Array | null | 'dir'> {
    const full = this.wpath(repoPath);
    try {
      const st = (await this.fs.promises.stat(full)) as { isDirectory(): boolean };
      if (st.isDirectory()) return 'dir';
      return new Uint8Array((await this.fs.promises.readFile(full)) as Uint8Array);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw e;
    }
  }

  private async bytesOf(entry: LeafEntry, given?: Uint8Array): Promise<Uint8Array> {
    if (given) return given;
    return (await git.readBlob({ ...this.local(), oid: entry.oid })).blob;
  }

  /**
   * Every working file a commit changes must still be what the replaced commit had, or already
   * what is being committed: anything else is someone's edit, and the commit is refused.
   */
  private async preflight(changes: readonly TreeChange[]): Promise<void> {
    const dirty: string[] = [];
    // With core.autocrlf a checkout holds CRLF text that git stores as LF: compare like git does.
    const autocrlf = await git
      .getConfig({ ...this.local(), path: 'core.autocrlf' })
      .catch(() => undefined);
    const clean = (b: Uint8Array) => (String(autocrlf) === 'true' ? toLf(b) : b);
    for (const c of changes) {
      if (c.after?.type === 'commit' || c.before?.type === 'commit' || c.after?.mode === '120000') {
        throw refuse(
          'UNSUPPORTED',
          `‘${c.path}’ is a submodule or symbolic link, which Whittle can’t update. Merge with your git tools.`,
          c.path,
        );
      }
      const disk = await this.readWork(c.path);
      if (disk === 'dir') {
        dirty.push(c.path);
        continue;
      }
      if (c.after && disk && sameBytes(clean(disk), await this.bytesOf(c.after, c.bytes))) continue;
      if (!c.after && disk === null) continue;
      if (!c.before && disk === null) continue;
      if (c.before && disk) {
        if ((await git.hashBlob({ object: clean(disk) })).oid === c.before.oid) continue;
        const was = await this.bytesOf(c.before);
        if (lfsPointer(was) && (await matchesLfs(was, disk))) continue;
      }
      dirty.push(c.path);
    }
    if (dirty.length > 0) {
      throw refuse(
        'CONFLICT',
        `${listOf(dirty)} changed on disk since the last version and isn’t what’s being saved. Nothing was committed; reload the project or commit those edits with your git tools.`,
        dirty[0],
      );
    }
  }

  /** Brings the working files of `changes` to their new content (before the branch moves). */
  private async writeWork(changes: readonly TreeChange[]): Promise<void> {
    for (const c of changes) {
      const full = this.wpath(c.path);
      const disk = await this.readWork(c.path);
      if (!c.after) {
        if (disk === null || disk === 'dir') continue;
        await this.fs.promises.unlink(full);
        await this.pruneEmptyFolders(c.path);
        continue;
      }
      const bytes = await this.bytesOf(c.after, c.bytes);
      if (disk !== 'dir' && sameBytes(disk ?? undefined, bytes)) continue;
      await mkdirp(this.fs, full.slice(0, full.lastIndexOf('/')));
      await this.fs.promises.writeFile(full, bytes);
    }
  }

  /** Removes folders a deletion left empty, like git does (never the project or repo root). */
  private async pruneEmptyFolders(repoPath: string): Promise<void> {
    const segs = repoPath.split('/');
    segs.pop();
    while (segs.length > this.scope.segments.length) {
      try {
        await this.fs.promises.rmdir(this.wpath(segs.join('/')));
      } catch {
        return;
      }
      segs.pop();
    }
  }

  /** The index follows the commit for the changed paths only (with the files' own stats). */
  private async updateIndex(changes: readonly TreeChange[]): Promise<void> {
    for (const c of changes) {
      if (!c.after) {
        await git
          .updateIndex({ ...this.local(), filepath: c.path, remove: true, force: true })
          .catch(() => undefined);
        continue;
      }
      const oid = await git
        .updateIndex({ ...this.local(), filepath: c.path, add: true })
        .catch(() => undefined);
      if (oid !== c.after.oid) {
        await git.updateIndex({
          ...this.local(),
          filepath: c.path,
          oid: c.after.oid,
          mode: Number.parseInt(c.after.mode, 8),
          add: true,
        });
      }
    }
  }

  /** Moves the current branch from `expected` to `to` (compare-and-swap), with reflog entries. */
  private async moveBranch(
    expected: string | null,
    to: string,
    message: string,
    who: Stamp,
  ): Promise<void> {
    const ref = await this.headRef();
    if (!ref) {
      throw refuse(
        'CONFLICT',
        'HEAD is detached (not on a branch), so a commit would be lost. Check out a branch with your git tools first.',
      );
    }
    const now = await git.resolveRef({ ...this.local(), ref }).catch(() => null);
    if (now !== expected) {
      throw refuse(
        'CONFLICT',
        'The branch moved while Whittle was saving (another git program committed). Nothing was overwritten; try again.',
      );
    }
    await git.writeRef({ ...this.local(), ref, value: to, force: true });
    const entry = (r: string): ReflogEntry => ({ ref: r, from: expected, to, who, message });
    await appendReflog(this.fs, this.gitdir, [entry(ref), entry('HEAD')]);
  }

  /**
   * Commits `content` (already composed) with `parents` on the current branch: working files,
   * then the commit, then the branch (compare-and-swap), then the index.
   */
  private async commitContent(
    content: ProjectFiles,
    message: string,
    parents: string[],
    author: Author,
    outside?: Map<string, { before: LeafEntry | null; after: LeafEntry | null }>,
  ): Promise<Version> {
    const head = await this.head();
    if ((parents[0] ?? null) !== head) {
      throw refuse('CONFLICT', 'The branch moved since this started: try again');
    }
    const { tree, changes } = await this.buildTree(content, head, outside);
    await this.preflight(changes);
    await this.writeWork(changes);
    const who = this.stamp(author);
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const oid = await git.writeCommit({
      ...this.local(),
      commit: { message: text, tree, parent: parents, author: who, committer: who },
    });
    const kind = parents.length > 1 ? 'commit (merge)' : head ? 'commit' : 'commit (initial)';
    await this.moveBranch(head, oid, `${kind}: ${message}`, who);
    await this.updateIndex(changes);
    this.hashes.set(oid, await hashProjectFiles(content));
    return this.version(oid);
  }

  /**
   * Whole-file three-way merge of everything outside the project (a multi-project repository):
   * the changes to apply on top of `ours`. Both sides changing one path differently refuses the
   * merge: such files can't be shown in Whittle's merge panel.
   */
  private async mergeOutside(
    base: string | null,
    ours: string,
    theirs: string,
  ): Promise<Map<string, { before: LeafEntry | null; after: LeafEntry | null }>> {
    const out = new Map<string, { before: LeafEntry | null; after: LeafEntry | null }>();
    if (this.scope.whole) return out;
    const a = this.at();
    const conflicts: string[] = [];
    const key = (e: { oid: string; mode: string } | undefined) => (e ? `${e.mode} ${e.oid}` : '');
    const leaf = (e: { oid: string; mode: string; type: string } | undefined): LeafEntry | null =>
      e ? { oid: e.oid, mode: e.mode, type: e.type === 'commit' ? 'commit' : 'blob' } : null;
    const walk = async (path: string, b: string | null, o: string | null, t: string | null) => {
      if (o === t || b === t) return;
      const [be, oe, te] = await Promise.all([
        treeEntries(a, b),
        treeEntries(a, o),
        treeEntries(a, t),
      ]);
      const by = (list: typeof be) => new Map(list.map((e) => [e.path, e]));
      const [bm, om, tm] = [by(be), by(oe), by(te)];
      for (const name of new Set([...bm.keys(), ...om.keys(), ...tm.keys()])) {
        const p = path ? `${path}/${name}` : name;
        const [x, y, z] = [bm.get(name), om.get(name), tm.get(name)];
        const inProject = !this.scope.outside(p);
        const leadsToProject =
          inProject && this.scope.toProject(p) === null && p !== this.scope.prefix;
        if (inProject && !leadsToProject) continue;
        if (key(y) === key(z) || key(x) === key(z)) continue;
        const types = [x, y, z].filter(Boolean).map((e) => e?.type);
        if (types.every((t) => t === 'tree')) {
          await walk(p, x?.oid ?? null, y?.oid ?? null, z?.oid ?? null);
        } else if (leadsToProject || types.includes('tree')) {
          conflicts.push(p);
        } else if (key(x) === key(y)) {
          out.set(p, { before: leaf(y), after: leaf(z) });
        } else conflicts.push(p);
      }
    };
    await walk(
      '',
      base ? await commitTree(a, base) : null,
      await commitTree(a, ours),
      await commitTree(a, theirs),
    );
    if (conflicts.length > 0) {
      throw refuse(
        'CONFLICT',
        `Files outside this project changed on both sides (${listOf(conflicts)}). Merge with your git tools.`,
      );
    }
    return out;
  }

  private async aheadBehind(
    local: string | null,
    remote: string | null,
  ): Promise<{ ahead: number; behind: number }> {
    if (!local) return { ahead: 0, behind: 0 };
    const ids = async (ref: string) =>
      new Set((await git.log({ ...this.local(), ref, depth: 500 })).map((c) => c.oid));
    if (!remote) return { ahead: this.url ? (await ids(local)).size : 0, behind: 0 };
    if (remote === local) return { ahead: 0, behind: 0 };
    const [mine, theirs] = await Promise.all([ids(local), ids(remote)]);
    let ahead = 0;
    let behind = 0;
    for (const id of mine) if (!theirs.has(id)) ahead++;
    for (const id of theirs) if (!mine.has(id)) behind++;
    return { ahead, behind };
  }

  private async releaseMap(): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    for (const r of await this.releases())
      m.set(r.versionId, [...(m.get(r.versionId) ?? []), r.name]);
    return m;
  }

  /** Where this project's automatic snapshots live. */
  private get autoDir(): string {
    return this.scope.whole ? AUTO_REFS : `${AUTO_REFS}/${gitRefName(this.scope.prefix)}`;
  }

  private async autoRefs(): Promise<string[]> {
    const { cache: _, ...at } = this.local();
    const names = await git.listRefs({ ...at, filepath: this.autoDir }).catch(() => [] as string[]);
    return names.filter((n) => OID.test(n));
  }

  /** This project's tags (all tags for the root project). */
  private async tags(): Promise<string[]> {
    const all = await git.listTags(this.local()).catch(() => [] as string[]);
    const prefix = this.scope.tagPrefix;
    return prefix ? all.filter((t) => t.startsWith(prefix)) : all;
  }

  /**
   * Checks the working tree out at `oid` without moving HEAD and without force: files with local
   * edits the checkout would replace make it throw `CheckoutConflictError`, before anything is
   * written.
   */
  private async checkoutTree(ref: string): Promise<void> {
    await this.assertNoLinks(ref);
    await git.checkout({ ...this.local(), ref, noUpdateHead: true, force: false });
  }

  /** Without symlink support, refuses a checkout of `target` that would create a link. */
  private async assertNoLinks(target: string): Promise<void> {
    if (this.o.symlinks !== false) return;
    const a = this.at();
    const head = await this.head();
    const to = OID.test(target) ? target : await git.resolveRef({ ...this.local(), ref: target });
    const links = await linksChanging(
      a,
      head ? await commitTree(a, head) : null,
      await commitTree(a, to),
    );
    if (links.length > 0) {
      throw refuse(
        'UNSUPPORTED',
        `${listOf(links)} would be a symbolic link, which the browser can’t create. Switch with your git tools.`,
        links[0],
      );
    }
  }

  // ---- GitHistory -------------------------------------------------------------------------

  clone(onProgress?: (p: GitProgress) => void): Promise<StorageResult<ProjectFiles>> {
    return this.serial(() =>
      this.guard(async () => {
        if (!this.url) return fail('NOT_FOUND', 'This project has no remote repository to clone');
        onProgress?.({ phase: `Contacting ${this.hostName}`, loaded: 0, total: 0 });
        const net = await this.net();
        const info = await git.getRemoteInfo2({ ...net, url: this.url, protocolVersion: 1 });
        const heads = (info.refs ?? [])
          .filter((r) => r.ref.startsWith('refs/heads/'))
          .map((r) => r.ref.slice('refs/heads/'.length));
        if (heads.length === 0) {
          // An empty repository: start one locally on the requested branch, ready to push.
          const branch = this.branchName ?? 'main';
          await git.init({ ...this.local(), defaultBranch: branch });
          await git.addRemote({ ...this.local(), remote: REMOTE, url: this.url, force: true });
          await git.setConfig({ ...this.local(), path: `branch.${branch}.remote`, value: REMOTE });
          await git.setConfig({
            ...this.local(),
            path: `branch.${branch}.merge`,
            value: `refs/heads/${branch}`,
          });
          this.branchName = branch;
          return ok(new Map());
        }
        if (this.branchName && !heads.includes(this.branchName)) {
          return fail(
            'NOT_FOUND',
            `The branch “${this.branchName}” isn't in this repository. It has: ${heads.slice(0, 8).join(', ')}${heads.length > 8 ? '…' : ''}.`,
          );
        }
        const target = (info.refs ?? []).find((r) => r.ref === 'HEAD')?.target;
        const branch =
          this.branchName ??
          (target?.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : null) ??
          (heads.includes('main')
            ? 'main'
            : heads.includes('master')
              ? 'master'
              : (heads[0] as string));
        await git.clone({
          ...net,
          url: this.url,
          ref: branch,
          singleBranch: true,
          noTags: false,
          onProgress: (e) => onProgress?.({ phase: e.phase, loaded: e.loaded, total: e.total }),
        });
        this.branchName = await this.currentBranch();
        return ok(await this.filesAt('HEAD'));
      }),
    );
  }

  fetch(
    onProgress?: (p: GitProgress) => void,
  ): Promise<StorageResult<{ ahead: number; behind: number }>> {
    return this.serial(() => this.guard(() => this.fetchNow(onProgress)));
  }

  private async fetchNow(
    onProgress?: (p: GitProgress) => void,
  ): Promise<StorageResult<{ ahead: number; behind: number }>> {
    const branch = await this.currentBranch();
    if (!this.url) return this.noRemote('fetch from');
    try {
      await git.fetch({
        ...(await this.net()),
        remote: REMOTE,
        ref: branch,
        // All refs: with `singleBranch` isomorphic-git asks only for the branch head, so
        // annotated tags (releases) would never arrive. Project repositories are small.
        singleBranch: false,
        tags: true,
        onProgress: (e) => onProgress?.({ phase: e.phase, loaded: e.loaded, total: e.total }),
      });
    } catch (e) {
      // The branch isn't on the remote yet (a new, empty repository): nothing to fetch.
      if (!(e instanceof Errors.NotFoundError)) throw e;
    }
    return ok(await this.aheadBehind(await this.head(), await this.remoteHead(branch)));
  }

  pull(onProgress?: (p: GitProgress) => void): Promise<StorageResult<GitPullResult>> {
    return this.serial(() =>
      this.guard(async (): Promise<StorageResult<GitPullResult>> => {
        if (!this.url) return this.noRemote('pull from');
        await this.assertWritable();
        const fetched = await this.fetchNow(onProgress);
        if (!fetched.ok) return fetched;
        const branch = await this.currentBranch();
        const local = await this.head();
        const remote = await this.remoteHead(branch);
        if (remote === null || local === remote) return ok({ kind: 'upToDate' });
        const fastForward = async (): Promise<StorageResult<GitPullResult>> => {
          await this.assertClean('pull');
          await this.checkoutTree(remote);
          const ref = (await this.headRef()) ?? `refs/heads/${branch}`;
          if (local === null) {
            await git.writeRef({ ...this.local(), ref, value: remote, force: true });
          } else {
            await this.moveBranch(
              local,
              remote,
              'pull: Fast-forward',
              this.stamp(this.defaultAuthor),
            );
          }
          return ok({ kind: 'fastForward', files: await this.filesAt(remote) });
        };
        if (local === null) return fastForward();
        const [base] = await git.findMergeBase({ ...this.local(), oids: [local, remote] });
        if (base === remote) return ok({ kind: 'upToDate' });
        if (base === local) return fastForward();
        const merged = await mergeProjectFiles(
          base ? await this.filesAt(base) : new Map(),
          await this.filesAt(local),
          await this.filesAt(remote),
          this.merger,
        );
        if (merged.merge.conflicts.length > 0) {
          return ok({ kind: 'conflicts', merge: merged.merge, theirs: remote });
        }
        await this.assertClean('pull');
        const outside = await this.mergeOutside(base ?? null, local, remote);
        const version = await this.commitContent(
          versionedFiles(merged.files),
          `Merge ${REMOTE}/${branch}`,
          [local, remote],
          this.defaultAuthor,
          outside,
        );
        return ok({ kind: 'merged', files: merged.files, version });
      }),
    );
  }

  push(onProgress?: (p: GitProgress) => void): Promise<StorageResult<GitPushResult>> {
    return this.serial(() =>
      this.guard(async (): Promise<StorageResult<GitPushResult>> => {
        if (!this.url) return this.noRemote('push to');
        const branch = await this.currentBranch();
        const net = await this.net();
        try {
          const result = await git.push({
            ...net,
            remote: REMOTE,
            ref: branch,
            onProgress: (e) => onProgress?.({ phase: e.phase, loaded: e.loaded, total: e.total }),
          });
          if (!result.ok) {
            const why = `${result.error ?? ''} ${Object.values(result.refs ?? {})
              .map((r) => r.error ?? '')
              .join(' ')}`;
            if (/protect/i.test(why)) return ok({ kind: 'rejected', reason: 'protected' });
            return ok({ kind: 'rejected', reason: 'behind' });
          }
        } catch (e) {
          if ((e as GitErrorLike).code === 'PushRejectedError')
            return ok({ kind: 'rejected', reason: 'behind' });
          if (/protect/i.test(String((e as Error).message)))
            return ok({ kind: 'rejected', reason: 'protected' });
          throw e;
        }
        // Releases travel too. A tag the remote already has is fine.
        for (const tag of await this.tags()) {
          await git.push({ ...net, remote: REMOTE, ref: tag }).catch((e: GitErrorLike) => {
            if (e.code !== 'PushRejectedError') throw e;
          });
        }
        return ok({ kind: 'pushed' });
      }),
    );
  }

  // ---- HistoryStore -------------------------------------------------------------------------

  async log(
    options: { branch?: string; limit?: number; includeAuto?: boolean } = {},
  ): Promise<Version[]> {
    const ref = options.branch ?? 'HEAD';
    const depth = options.limit ?? 50;
    const releases = await this.releaseMap();
    let commits: ReadCommitResult[];
    let parentsOf: (c: ReadCommitResult) => string[] = (c) => c.commit.parent;
    if (this.scope.whole) {
      commits = await git.log({ ...this.local(), ref, depth }).catch(() => []);
    } else {
      ({ commits, parentsOf } = await this.projectLog(ref, depth));
    }
    const out: Version[] = [];
    for (const c of commits) out.push(await this.version(c.oid, false, releases, parentsOf(c)));
    if (options.includeAuto) {
      const onBranch = new Set(out.map((v) => v.id));
      const all = await git.log({ ...this.local(), ref, depth: depth * 20 }).catch(() => []);
      const reachable = new Set(all.map((c) => c.oid));
      for (const oid of await this.autoRefs()) {
        const v = await this.version(oid, true, releases).catch(() => null);
        if (v?.parents.every((p) => onBranch.has(p) || reachable.has(p))) out.push(v);
      }
      out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    }
    return out.slice(0, depth);
  }

  /**
   * The commits that change the project folder (git's history simplification, as in
   * `git log -- <folder>`): a commit is kept unless its project tree equals a parent's. Parents
   * are rewritten to the nearest kept ancestors, so the version graph stays connected.
   */
  private async projectLog(
    ref: string,
    limit: number,
  ): Promise<{ commits: ReadCommitResult[]; parentsOf: (c: ReadCommitResult) => string[] }> {
    const all = await git
      .log({ ...this.local(), ref, depth: Math.max(limit * 20, 500) })
      .catch(() => [] as ReadCommitResult[]);
    const byId = new Map(all.map((c) => [c.oid, c]));
    const tree = async (oid: string) => this.projectTree(oid).catch(() => null);
    const kept = new Set<string>();
    const sameAs = new Map<string, string | null>();
    for (const c of all) {
      const mine = await tree(c.oid);
      const parents = c.commit.parent;
      if (parents.length === 0) {
        if (mine !== null) kept.add(c.oid);
        else sameAs.set(c.oid, null);
        continue;
      }
      let same: string | null = null;
      for (const p of parents) {
        if ((await tree(p)) === mine) {
          same = p;
          break;
        }
      }
      if (same === null) kept.add(c.oid);
      else sameAs.set(c.oid, same);
    }
    const rewrite = (p: string): string | null => {
      let at: string | null = p;
      const seen = new Set<string>();
      while (at !== null && !kept.has(at) && byId.has(at) && !seen.has(at)) {
        seen.add(at);
        at = sameAs.get(at) ?? null;
      }
      return at;
    };
    const commits = all.filter((c) => kept.has(c.oid)).slice(0, limit);
    const parentsOf = (c: ReadCommitResult) => [
      ...new Set(c.commit.parent.map(rewrite).filter((p): p is string => p !== null)),
    ];
    return { commits, parentsOf };
  }

  saveVersion(
    files: ProjectFiles,
    message: string,
    options: { author: Author; auto?: boolean },
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        await this.ensureRepo();
        await this.assertWritable();
        const head = await this.head();
        const content = await this.compose(files, head);
        const hash = await hashProjectFiles(content);
        if (head && (await this.hashOf(head)) === hash) return ok(await this.version(head));
        if (options.auto) {
          for (const oid of await this.autoRefs()) {
            const { commit } = await git.readCommit({ ...this.local(), oid });
            if (commit.parent[0] === (head ?? undefined) && (await this.hashOf(oid)) === hash) {
              return ok(await this.version(oid, true));
            }
          }
          // A snapshot is objects and a ref only: the branch, index and working tree stay.
          const { tree } = await this.buildTree(content, head);
          const who = this.stamp(options.author);
          const oid = await git.writeCommit({
            ...this.local(),
            commit: {
              message: message.endsWith('\n') ? message : `${message}\n`,
              tree,
              parent: head ? [head] : [],
              author: who,
              committer: who,
            },
          });
          await git.writeRef({
            ...this.local(),
            ref: `${this.autoDir}/${oid}`,
            value: oid,
            force: true,
          });
          this.hashes.set(oid, hash);
          return ok(await this.version(oid, true));
        }
        return ok(await this.commitContent(content, message, head ? [head] : [], options.author));
      }),
    );
  }

  read(versionId: string): Promise<StorageResult<ProjectFiles>> {
    return this.guard(async () => {
      try {
        await git.readCommit({ ...this.local(), oid: versionId });
      } catch {
        return fail('NOT_FOUND', 'That version isn’t in this repository');
      }
      return ok(await this.filesAt(versionId));
    });
  }

  async branches(): Promise<Branch[]> {
    const current = await this.currentBranch();
    const out: Branch[] = [];
    for (const name of await git.listBranches(this.local()).catch(() => [] as string[])) {
      const head = await git.resolveRef({ ...this.local(), ref: `refs/heads/${name}` });
      const remote = await this.remoteHead(name);
      const b: Branch = { name, head, current: name === current };
      if (remote) Object.assign(b, await this.aheadBehind(head, remote));
      out.push(b);
    }
    return out;
  }

  createBranch(name: string, from?: string): Promise<StorageResult<Branch>> {
    return this.serial(() =>
      this.guard(async () => {
        const problem = nameProblem(name, 'branch');
        if (problem) return fail('PERMISSION', problem);
        const ref = gitRefName(name);
        if ((await git.listBranches(this.local())).includes(ref)) {
          return fail('CONFLICT', `There’s already a branch called ‘${ref}’`);
        }
        const object = from ?? (await this.head());
        if (!object) return fail('NOT_FOUND', 'Save a version first, then branch from it');
        await git.branch({ ...this.local(), ref, object, checkout: false });
        return ok({ name: ref, head: object, current: false });
      }),
    );
  }

  switchBranch(name: string): Promise<StorageResult<ProjectFiles>> {
    return this.serial(() =>
      this.guard(async () => {
        await this.assertWritable();
        await this.assertClean('switch branches');
        const local = await git.listBranches(this.local());
        if (!local.includes(name) && this.url) {
          await git.fetch({
            ...(await this.net()),
            remote: REMOTE,
            ref: name,
            singleBranch: true,
            tags: true,
          });
        }
        const before = await this.head();
        const from = await this.currentBranch();
        const target = local.includes(name)
          ? `refs/heads/${name}`
          : `refs/remotes/${REMOTE}/${name}`;
        if (await git.resolveRef({ ...this.local(), ref: target }).catch(() => null)) {
          await this.assertNoLinks(target);
        }
        // Never forced: a file with local edits the switch would replace refuses it.
        await git.checkout({ ...this.local(), ref: name, remote: REMOTE, force: false });
        const after = await this.head();
        if (after) {
          await appendReflog(this.fs, this.gitdir, [
            {
              ref: 'HEAD',
              from: before,
              to: after,
              who: this.stamp(this.defaultAuthor),
              message: `checkout: moving from ${from} to ${name}`,
            },
          ]);
        }
        this.branchName = name;
        return ok(await this.filesAt('HEAD'));
      }),
    );
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      const [base] = await git.findMergeBase({ ...this.local(), oids: [a, b] });
      return base ?? null;
    } catch {
      return null;
    }
  }

  commitMerge(
    files: ProjectFiles,
    message: string,
    parents: [string, string],
    author: Author,
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        await this.assertWritable();
        const head = await this.head();
        if (head !== parents[0]) {
          return fail('CONFLICT', 'The branch moved since this merge started: pull again');
        }
        const base = await this.mergeBase(parents[0], parents[1]);
        const outside = await this.mergeOutside(base, parents[0], parents[1]);
        const content = await this.compose(files, head);
        return ok(await this.commitContent(content, message, parents, author, outside));
      }),
    );
  }

  release(
    versionId: string,
    name: string,
    exports: ProjectFiles,
    author: Author,
  ): Promise<StorageResult<Release>> {
    return this.serial(() =>
      this.guard(async () => {
        const problem = nameProblem(name, 'release');
        if (problem) return fail('PERMISSION', problem);
        await this.assertWritable();
        try {
          await git.readCommit({ ...this.local(), oid: versionId });
        } catch {
          return fail('NOT_FOUND', 'That version isn’t in this repository');
        }
        const tag = this.scope.tagPrefix + gitRefName(name);
        const existing = await this.releases();
        if (
          (await git.listTags(this.local())).includes(tag) ||
          existing.some((r) => r.name === name)
        ) {
          return fail('CONFLICT', `‘${name}’ is already released; releases can’t be changed`);
        }
        const folder = `releases/${slugify(name, 'release')}/`;
        const paths = [...exports.keys()].sort().map((p) => folder + p);
        if (paths.some((p) => p.split('/').includes('..')))
          return fail('PERMISSION', 'Invalid export file name');
        if (exports.size > 0) {
          // Frozen exports are committed to the branch beside the model.
          const head = await this.head();
          const current = head ? await this.filesAt(head) : new Map<string, Uint8Array>();
          if ([...current.keys()].some((p) => p.startsWith(folder))) {
            return fail('CONFLICT', `The folder ‘${folder}’ already holds a release`);
          }
          for (const [p, bytes] of exports) current.set(folder + p, bytes);
          await this.commitContent(
            await this.compose(current, head),
            `Release ${name}: frozen exports`,
            head ? [head] : [],
            author,
          );
        }
        const message = `${name}\n\n${paths.map((p) => RELEASE_FILE + p).join('\n')}\n`;
        await git.annotatedTag({
          ...this.local(),
          ref: tag,
          object: versionId,
          message,
          tagger: this.stamp(author),
        });
        return ok({ name, versionId, at: this.now().toISOString(), author, files: paths });
      }),
    );
  }

  async releases(): Promise<Release[]> {
    const out: Release[] = [];
    for (const tag of await this.tags()) {
      try {
        const oid = await git.resolveRef({ ...this.local(), ref: `refs/tags/${tag}` });
        try {
          const { tag: t } = await git.readTag({ ...this.local(), oid });
          const lines = t.message.split('\n');
          out.push({
            name: lines[0]?.trim() || tag,
            versionId: t.object,
            at: new Date(t.tagger.timestamp * 1000).toISOString(),
            author: t.tagger.email
              ? { name: t.tagger.name, email: t.tagger.email }
              : { name: t.tagger.name },
            files: lines
              .filter((l) => l.startsWith(RELEASE_FILE))
              .map((l) => l.slice(RELEASE_FILE.length)),
          });
        } catch {
          // A lightweight tag made elsewhere: a release with no recorded exports.
          const { commit } = await git.readCommit({ ...this.local(), oid });
          out.push({
            name: tag.slice(this.scope.tagPrefix.length),
            versionId: oid,
            at: new Date(commit.author.timestamp * 1000).toISOString(),
            author: { name: commit.author.name },
            files: [],
          });
        }
      } catch {
        // A tag on something that isn't a commit (a tree or blob): not a release.
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  prune(policy: Partial<PrunePolicy> = {}): Promise<number> {
    return this.serial(async () => {
      const keep = new Set((await this.releases()).map((r) => r.versionId));
      const candidates = [];
      for (const oid of await this.autoRefs()) {
        const { commit } = await git.readCommit({ ...this.local(), oid });
        candidates.push({
          id: oid,
          at: new Date(commit.author.timestamp * 1000).toISOString(),
          auto: true,
        });
      }
      const drop = selectPrunable(candidates, keep, policy, this.now());
      for (const oid of drop)
        await git.deleteRef({ ...this.local(), ref: `${this.autoDir}/${oid}` });
      await this.flush();
      return drop.length;
    });
  }
}

/** A git history over an injected isomorphic-git `fs` (see `GitHistoryOptions`). */
export function createGitHistory(
  options: GitHistoryOptions,
): GitHistory & { currentBranch(): Promise<string>; readonly statusCounters: StatusCounters } {
  return new GitHistoryImpl(options);
}
