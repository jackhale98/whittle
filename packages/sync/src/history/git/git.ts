// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Mycelium src/lib/git/repo.ts (same author, GPL-3.0-or-later); its line merge is replaced by DocMerger.
/**
 * Git history for git connections (PLAN §8A.3, ADR-020 item 1), on isomorphic-git. Versions are
 * commits, branches are git branches and releases are annotated tags, so a project interoperates
 * with GitHub/GitLab/Forgejo pull requests, reviews and CI.
 *
 * The repository lives in its own browser filesystem (LightningFS on IndexedDB, see
 * `browserGitFs`); its working tree is written only by this class, from the files the app passes
 * to `saveVersion`/`commitMerge`, so there are never uncommitted edits here to protect.
 *
 * - `pull` fast-forwards, or merges the parsed project with `DocMerger` (model files) and whole
 *   bytes (other files). Clean merges are committed with both parents; conflicts come back as
 *   `{ kind: 'conflicts' }` and nothing is committed until `commitMerge`.
 * - Automatic snapshots are commits under `refs/whittle/auto/<oid>` (never pushed); pruning
 *   deletes those refs.
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
import git, { Errors, type HttpClient, type PromiseFsClient, TREE } from 'isomorphic-git';
import { isModelPath, mergeProjectFiles } from '../../merge/files';
import { docMerger } from '../../merge/merge';
import { hashProjectFiles, isVersionedPath, sameBytes, versionedFiles } from '../hash';
import { gitRefName, nameProblem } from '../names';
import { selectPrunable } from '../prune';
import { basicAuth, type GitHost, retryAuth, secretOf } from './auth';

/** isomorphic-git's public CORS proxy: fine for development, self-host for production (PLAN §8A.2). */
export const DEFAULT_CORS_PROXY = 'https://cors.isomorphic-git.org';

const REMOTE = 'origin';
const AUTO_REFS = 'refs/whittle/auto';
const RELEASE_FILE = 'Whittle-Release-File: ';

export interface GitHistoryOptions {
  /** isomorphic-git filesystem: `browserGitFs(projectId)` in the app, any in-memory fs in tests. */
  fs: PromiseFsClient;
  /** `isomorphic-git/http/web` in the browser, `isomorphic-git/http/node` in Node. */
  http: HttpClient;
  /** Working tree folder inside `fs`, e.g. `/repo`. */
  dir: string;
  /** The `.git` folder, when it isn't `<dir>/.git` (e.g. a File System Access checkout adapter). */
  gitdir?: string;
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

interface GitErrorLike {
  code?: string;
  message?: string;
  data?: { statusCode?: number; reason?: string };
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

/**
 * Paths Whittle manages in a repository (the model, attachments, previews, release exports).
 * Anything else in the user's repository is carried along untouched.
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
  private branchName: string | null;
  /** Shared object cache: repeated reads from packfiles are fast. */
  private cache = {};
  private readonly hashes = new Map<string, string>();
  private secret: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

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

  /**
   * Forgets cached packfile reads. Refs, HEAD, the index and the working tree are read fresh on
   * every call anyway; call this when something else (a desktop git, another tab) may have
   * repacked the repository.
   */
  refresh(): void {
    this.cache = {};
  }

  async workingChanges(): Promise<
    StorageResult<{ path: string; status: 'added' | 'modified' | 'deleted' }[]>
  > {
    if (!(await this.isRepo())) return ok([]);
    try {
      const rows = await git.statusMatrix({ ...this.local(), filter: (p) => isVersionedPath(p) });
      const out: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];
      for (const [path, head, work] of rows) {
        if (head === 0 && work === 2) out.push({ path, status: 'added' });
        else if (head === 1 && work === 2) out.push({ path, status: 'modified' });
        else if (head === 1 && work === 0) out.push({ path, status: 'deleted' });
      }
      return ok(out);
    } catch (e) {
      return fail(
        'REMOTE',
        `Couldn't read the working tree: ${(e as Error)?.message ?? String(e)}`,
      );
    }
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    if (!(await this.isRepo())) return [];
    try {
      const list = await git.listRemotes({
        fs: this.fs,
        dir: this.dir,
        ...(this.o.gitdir === undefined ? {} : { gitdir: this.o.gitdir }),
      });
      return list.map((r) => ({ name: r.remote, url: r.url }));
    } catch {
      return [];
    }
  }

  private async isRepo(): Promise<boolean> {
    try {
      await this.fs.promises.stat(this.o.gitdir ?? `${this.dir}/.git`);
      return true;
    } catch {
      return false;
    }
  }

  /** A local-only history starts its repository on first use. */
  private async ensureRepo(): Promise<void> {
    if (await this.isRepo()) return;
    await mkdirp(this.fs, this.dir);
    await git.init({ ...this.local(), defaultBranch: this.branchName ?? 'main' });
  }

  private noRemote<T>(what: string): StorageResult<T> {
    return fail(
      'NOT_FOUND',
      `This project has no remote repository to ${what}. Add one in Connections.`,
    );
  }

  /**
   * The full tree a commit records: the caller's files plus every file of `head` Whittle doesn't
   * own (a README, CI config in the user's repository), which are left exactly as they are.
   */
  private async compose(files: ProjectFiles, head: string | null): Promise<ProjectFiles> {
    const out = new Map(versionedFiles(files));
    if (head) {
      for (const [p, b] of await this.filesAt(head))
        if (!ownedPath(p) && !out.has(p)) out.set(p, b);
    }
    return versionedFiles(out);
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

  private stamp(a: Author) {
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

  private async remoteHead(branch: string): Promise<string | null> {
    return git
      .resolveRef({ ...this.local(), ref: `refs/remotes/${REMOTE}/${branch}` })
      .catch(() => null);
  }

  /** The versioned files of a commit, sorted by path. */
  private async filesAt(ref: string): Promise<ProjectFiles> {
    const out: ProjectFiles = new Map();
    await git.walk({
      ...this.local(),
      trees: [TREE({ ref })],
      map: async (path, [entry]) => {
        if (path === '.') return true;
        if (!entry) return null;
        const type = await entry.type();
        if (type === 'blob' && isVersionedPath(path)) {
          const bytes = await entry.content();
          if (bytes) out.set(path, bytes);
        }
        return true;
      },
    });
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
  ): Promise<Version> {
    const { commit } = await git.readCommit({ ...this.local(), oid });
    const v: Version = {
      id: oid,
      parents: commit.parent,
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

  /**
   * Stages `files` as the next commit's tree. Files Whittle doesn't own are only written when
   * they differ from HEAD (a merge brought a change), so a user's uncommitted edits to them in
   * their own checkout survive; tracked files are only removed if Whittle owns them or HEAD had them.
   */
  private async writeTree(files: ProjectFiles): Promise<void> {
    const want = versionedFiles(files);
    const head = await this.head();
    const before = head ? await this.filesAt(head) : new Map<string, Uint8Array>();
    const tracked = await git.listFiles(this.local()).catch(() => [] as string[]);
    for (const path of tracked) {
      if (want.has(path) || !isVersionedPath(path)) continue;
      if (!ownedPath(path) && !before.has(path)) continue;
      await this.fs.promises.unlink(`${this.dir}/${path}`).catch(() => undefined);
      await git.remove({ ...this.local(), filepath: path });
    }
    for (const [path, bytes] of want) {
      if (!ownedPath(path) && sameBytes(before.get(path), bytes)) continue;
      const full = `${this.dir}/${path}`;
      await mkdirp(this.fs, full.slice(0, full.lastIndexOf('/')));
      await this.fs.promises.writeFile(full, bytes);
      await git.add({ ...this.local(), filepath: path });
    }
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

  private async autoRefs(): Promise<string[]> {
    const { cache: _, ...at } = this.local();
    return git.listRefs({ ...at, filepath: AUTO_REFS }).catch(() => [] as string[]);
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
        const fetched = await this.fetchNow(onProgress);
        if (!fetched.ok) return fetched;
        const branch = await this.currentBranch();
        const local = await this.head();
        const remote = await this.remoteHead(branch);
        if (remote === null || local === remote) return ok({ kind: 'upToDate' });
        const fastForward = async (): Promise<StorageResult<GitPullResult>> => {
          await git.writeRef({
            ...this.local(),
            ref: `refs/heads/${branch}`,
            value: remote,
            force: true,
          });
          await git.checkout({ ...this.local(), ref: branch, force: true });
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
        const version = await this.commitNow(
          merged.files,
          `Merge ${REMOTE}/${branch}`,
          [local, remote],
          this.defaultAuthor,
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
        for (const tag of await git.listTags(this.local())) {
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
    const commits = await git.log({ ...this.local(), ref, depth }).catch(() => []);
    const releases = await this.releaseMap();
    const out: Version[] = [];
    for (const c of commits) out.push(await this.version(c.oid, false, releases));
    if (options.includeAuto) {
      const onBranch = new Set(out.map((v) => v.id));
      for (const oid of await this.autoRefs()) {
        const v = await this.version(oid, true, releases).catch(() => null);
        if (v?.parents.every((p) => onBranch.has(p))) out.push(v);
      }
      out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    }
    return out.slice(0, depth);
  }

  saveVersion(
    files: ProjectFiles,
    message: string,
    options: { author: Author; auto?: boolean },
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        await this.ensureRepo();
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
          await this.writeTree(content);
          const oid = await git.commit({
            ...this.local(),
            message,
            author: this.stamp(options.author),
            noUpdateBranch: true,
          });
          await git.writeRef({
            ...this.local(),
            ref: `${AUTO_REFS}/${oid}`,
            value: oid,
            force: true,
          });
          this.hashes.set(oid, hash);
          return ok(await this.version(oid, true));
        }
        await this.writeTree(content);
        const oid = await git.commit({
          ...this.local(),
          message,
          author: this.stamp(options.author),
        });
        this.hashes.set(oid, hash);
        return ok(await this.version(oid));
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
        await git.checkout({ ...this.local(), ref: name, remote: REMOTE, force: true });
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

  private async commitNow(
    files: ProjectFiles,
    message: string,
    parents: string[],
    author: Author,
  ): Promise<Version> {
    const content = await this.compose(files, await this.head());
    await this.writeTree(content);
    const oid = await git.commit({
      ...this.local(),
      message,
      author: this.stamp(author),
      parent: parents,
    });
    this.hashes.set(oid, await hashProjectFiles(content));
    return this.version(oid);
  }

  commitMerge(
    files: ProjectFiles,
    message: string,
    parents: [string, string],
    author: Author,
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        const head = await this.head();
        if (head !== parents[0]) {
          return fail('CONFLICT', 'The branch moved since this merge started: pull again');
        }
        return ok(await this.commitNow(files, message, parents, author));
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
        try {
          await git.readCommit({ ...this.local(), oid: versionId });
        } catch {
          return fail('NOT_FOUND', 'That version isn’t in this repository');
        }
        const tag = gitRefName(name);
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
          await this.commitNow(
            current,
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
    for (const tag of await git.listTags(this.local()).catch(() => [] as string[])) {
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
          name: tag,
          versionId: oid,
          at: new Date(commit.author.timestamp * 1000).toISOString(),
          author: { name: commit.author.name },
          files: [],
        });
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
      for (const oid of drop) await git.deleteRef({ ...this.local(), ref: `${AUTO_REFS}/${oid}` });
      await this.flush();
      return drop.length;
    });
  }
}

/** A git history over an injected isomorphic-git `fs` (see `GitHistoryOptions`). */
export function createGitHistory(
  options: GitHistoryOptions,
): GitHistory & { currentBranch(): Promise<string> } {
  return new GitHistoryImpl(options);
}

/**
 * Branch names on a remote repository, without cloning (the connection's "pick a repository"
 * step): an empty list means a new, empty repository a local project can be pushed to.
 */
export async function gitRemoteHeads(options: {
  http: HttpClient;
  url: string;
  host?: GitHost;
  credentials?: () => Credential | null | Promise<Credential | null>;
  corsProxy?: string | null;
}): Promise<StorageResult<string[]>> {
  const cred = (await options.credentials?.()) ?? null;
  const host = options.host ?? 'other';
  let name = 'the git host';
  try {
    name = new URL(options.url).host;
  } catch {
    return fail('NOT_FOUND', 'That isn’t a repository address');
  }
  const proxy = corsProxyFor(options.url, options.corsProxy);
  try {
    const info = await git.getRemoteInfo2({
      http: options.http,
      url: options.url,
      protocolVersion: 1,
      ...(proxy ? { corsProxy: proxy } : {}),
      onAuth: () => (cred ? basicAuth(host, cred) : { cancel: true }),
      onAuthFailure: (_url: string, failed: { username?: string }) =>
        (cred && retryAuth(host, cred, failed)) || { cancel: true },
    });
    return ok(
      (info.refs ?? [])
        .filter((r) => r.ref.startsWith('refs/heads/'))
        .map((r) => r.ref.slice('refs/heads/'.length)),
    );
  } catch (e) {
    return { ok: false, error: gitError(e, secretOf(cred), name) };
  }
}
