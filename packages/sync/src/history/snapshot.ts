// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Snapshot history for cloud drives and local-only projects (PLAN §8A.3, ADR-020 item 6). Lives
 * in `.whittle-history/` beside the project and syncs with it. Layout (docs/FILE_FORMAT.md §9):
 *
 *   versions/<id>.json                  version metadata (immutable)
 *   snapshots/<sha256>.zip              the project files, packed (content-addressed, immutable)
 *   refs/heads/<branch>/<versionId>     one empty file per branch head
 *   refs/releases/<name>/<versionId>    one file per release, holding its metadata (immutable)
 *
 * Every file is created once and never edited, so two devices adding versions offline merge by
 * union with no conflicts. A branch that ends up with two heads is "diverged": `branches()`
 * lists it once per head, and `commitMerge` joins them. A head ref left behind by a stale copy is
 * ignored when it is an ancestor of another head of the same branch.
 *
 * Automatic snapshots hang off the branch head (their parent) and never become heads, so pruning
 * them can't disconnect the graph. Which branch and version this device is on is device-local
 * state (`SnapshotLocalState`), not synced.
 */

import type {
  Author,
  Branch,
  ProjectFiles,
  PrunePolicy,
  Release,
  SnapshotHistory,
  StorageError,
  StorageResult,
  Version,
} from '@whittle/contracts';
import { canonicalBytes, packFiles, slugify, ulid, unpackFiles } from '@whittle/document';
import type { HistoryFiles } from './files';
import { HISTORY_PREFIX, hashProjectFiles, versionedFiles } from './hash';
import { decodeName, encodeName, nameProblem } from './names';
import { selectPrunable } from './prune';

export interface SnapshotLocalState {
  branch: string;
  /** The version the working copy was last saved as or switched to (`null`: none yet). */
  version: string | null;
}

export interface SnapshotHistoryOptions {
  files: HistoryFiles;
  /** Device-local state to start from (default: branch `main`, no version). */
  state?: SnapshotLocalState;
  /** Called whenever the local state changes, so the app can persist it. */
  onStateChange?: (state: SnapshotLocalState) => void;
  now?: () => Date;
  newId?: () => string;
  /** Default `.whittle-history/`. */
  root?: string;
}

/** `versions/<id>.json`. `branch` records where a version was saved (autos are listed by it). */
interface VersionFile {
  format: 'whittle-version';
  id: string;
  parents: string[];
  message: string;
  author: Author;
  at: string;
  hash: string;
  branch: string;
  auto?: boolean;
}

interface ReleaseFile {
  format: 'whittle-release';
  name: string;
  versionId: string;
  at: string;
  author: Author;
  files: string[];
}

interface Graph {
  versions: Map<string, VersionFile>;
  snapshots: Set<string>;
  /** Branch → version ids with a head ref. */
  refs: Map<string, string[]>;
  releases: Release[];
}

const fail = <T>(code: StorageError['code'], message: string, path?: string): StorageResult<T> => ({
  ok: false,
  error: path === undefined ? { code, message } : { code, message, path },
});
const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });
const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder();
const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

function parseJson<T>(bytes: Uint8Array | null): T | null {
  if (bytes === null) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * Children before their parents (device clocks disagree, so time alone can put a merge below
 * what it merged); among versions whose children are all listed, the newest comes first.
 */
function topological(list: readonly VersionFile[]): VersionFile[] {
  const ids = new Set(list.map((v) => v.id));
  const children = new Map<string, number>();
  for (const v of list) {
    for (const p of v.parents) if (ids.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  }
  const byId = new Map(list.map((v) => [v.id, v]));
  const ready = list.filter((v) => !children.get(v.id));
  const out: VersionFile[] = [];
  while (ready.length > 0) {
    ready.sort(newestFirst);
    const v = ready.shift() as VersionFile;
    out.push(v);
    for (const p of v.parents) {
      const left = (children.get(p) ?? 0) - 1;
      children.set(p, left);
      const pv = byId.get(p);
      if (left === 0 && pv) ready.push(pv);
    }
  }
  return out;
}

function safeExportPath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').some((s) => s === '..' || s === '')
  );
}

class SnapshotHistoryImpl implements SnapshotHistory {
  readonly backend = 'snapshot' as const;
  private readonly files: HistoryFiles;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private local: SnapshotLocalState;
  private readonly onState?: (s: SnapshotLocalState) => void;
  /** Version files are immutable, so parsed ones are cached for good. */
  private readonly cache = new Map<string, VersionFile>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: SnapshotHistoryOptions) {
    this.files = o.files;
    this.root = o.root ?? HISTORY_PREFIX;
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? (() => ulid(this.now().getTime()));
    this.local = { ...(o.state ?? { branch: 'main', version: null }) };
    if (o.onStateChange) this.onState = o.onStateChange;
  }

  /** Device-local: the branch and version this working copy is on. */
  state(): SnapshotLocalState {
    return { ...this.local };
  }

  private setState(s: SnapshotLocalState): void {
    this.local = s;
    this.onState?.({ ...s });
  }

  /** Writes run one at a time, so two saves on one device never race each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private path(...segs: string[]): string {
    return this.root + segs.join('/');
  }

  private async load(): Promise<Graph> {
    const all = await this.files.list(this.root);
    const versions = new Map<string, VersionFile>();
    const snapshots = new Set<string>();
    const refs = new Map<string, string[]>();
    const releaseFiles: string[] = [];
    const reads: Promise<void>[] = [];
    for (const full of all) {
      const rel = full.slice(this.root.length).split('/');
      if (rel[0] === 'versions' && rel.length === 2 && rel[1]?.endsWith('.json')) {
        const vid = (rel[1] as string).slice(0, -5);
        const cached = this.cache.get(vid);
        if (cached) versions.set(vid, cached);
        else {
          reads.push(
            this.files.read(full).then((b) => {
              const v = parseJson<VersionFile>(b);
              if (v?.format === 'whittle-version' && v.id === vid) {
                this.cache.set(vid, v);
                versions.set(vid, v);
              }
            }),
          );
        }
      } else if (rel[0] === 'snapshots' && rel.length === 2 && rel[1]?.endsWith('.zip')) {
        snapshots.add((rel[1] as string).slice(0, -4));
      } else if (rel[0] === 'refs' && rel[1] === 'heads' && rel.length === 4) {
        const branch = decodeName(rel[2] as string);
        refs.set(branch, [...(refs.get(branch) ?? []), rel[3] as string]);
      } else if (rel[0] === 'refs' && rel[1] === 'releases' && rel.length === 4) {
        releaseFiles.push(full);
      }
    }
    await Promise.all(reads);
    const byName = new Map<string, Release>();
    for (const r of await Promise.all(
      releaseFiles.map(async (p) => parseJson<ReleaseFile>(await this.files.read(p))),
    )) {
      if (r?.format !== 'whittle-release' || !versions.has(r.versionId)) continue;
      const prev = byName.get(r.name);
      // Two devices released one name offline: the first release stands.
      if (!prev || r.at < prev.at || (r.at === prev.at && r.versionId < prev.versionId)) {
        byName.set(r.name, {
          name: r.name,
          versionId: r.versionId,
          at: r.at,
          author: r.author,
          files: r.files,
        });
      }
    }
    return { versions, snapshots, refs, releases: [...byName.values()] };
  }

  private ancestors(g: Graph, from: string): Set<string> {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of g.versions.get(id)?.parents ?? []) stack.push(p);
    }
    return seen;
  }

  /** The branch's heads, newest first; stale refs (ancestors of another head) are ignored. */
  private heads(g: Graph, branch: string): VersionFile[] {
    const ids = (g.refs.get(branch) ?? []).filter((id) => g.versions.has(id));
    const stale = new Set<string>();
    for (const id of ids) {
      for (const a of this.ancestors(g, id)) if (a !== id) stale.add(a);
    }
    return ids
      .filter((id) => !stale.has(id))
      .map((id) => g.versions.get(id) as VersionFile)
      .sort(newestFirst);
  }

  /** The head this device builds on: its own version if that's a head, else the newest head. */
  private currentHead(g: Graph): VersionFile | undefined {
    const heads = this.heads(g, this.local.branch);
    return heads.find((h) => h.id === this.local.version) ?? heads[0];
  }

  private toVersion(g: Graph, v: VersionFile): Version {
    const out: Version = {
      id: v.id,
      parents: [...v.parents],
      message: v.message,
      author: { ...v.author },
      at: v.at,
      hash: v.hash,
    };
    if (v.auto) out.auto = true;
    const releases = g.releases.filter((r) => r.versionId === v.id).map((r) => r.name);
    if (releases.length) out.releases = releases;
    return out;
  }

  private async write(
    g: Graph,
    files: ProjectFiles,
    hash: string,
    meta: Omit<VersionFile, 'format' | 'id' | 'at' | 'hash' | 'branch'>,
  ): Promise<VersionFile> {
    const v: VersionFile = {
      format: 'whittle-version',
      id: this.newId(),
      ...meta,
      at: this.now().toISOString(),
      hash,
      branch: this.local.branch,
    };
    if (!v.auto) delete v.auto;
    // Snapshot first, metadata second: a version file never points at a missing snapshot.
    if (!g.snapshots.has(hash))
      await this.files.write(this.path('snapshots', `${hash}.zip`), packFiles(files));
    await this.files.write(this.path('versions', `${v.id}.json`), canonicalBytes(v));
    this.cache.set(v.id, v);
    g.versions.set(v.id, v);
    g.snapshots.add(hash);
    return v;
  }

  /** Points the current branch at `v`, retiring the head refs of `replaced`. */
  private async advance(g: Graph, v: VersionFile, replaced: readonly string[]): Promise<void> {
    const branch = encodeName(this.local.branch);
    await this.files.write(this.path('refs', 'heads', branch, v.id), EMPTY);
    const refs = g.refs.get(this.local.branch) ?? [];
    for (const id of replaced) {
      if (refs.includes(id)) await this.files.remove(this.path('refs', 'heads', branch, id));
    }
    g.refs.set(this.local.branch, [...refs.filter((id) => !replaced.includes(id)), v.id]);
    this.setState({ branch: this.local.branch, version: v.id });
  }

  private guard<T>(fn: () => Promise<StorageResult<T>>): Promise<StorageResult<T>> {
    return fn().catch((e: unknown) =>
      fail<T>(
        'REMOTE',
        `Version history couldn’t be updated: ${(e as Error).message ?? String(e)}`,
      ),
    );
  }

  // ---- HistoryStore -----------------------------------------------------------------------

  async log(
    options: { branch?: string; limit?: number; includeAuto?: boolean } = {},
  ): Promise<Version[]> {
    const g = await this.load();
    const branch = options.branch ?? this.local.branch;
    const seen = new Set<string>();
    for (const h of this.heads(g, branch)) for (const a of this.ancestors(g, h.id)) seen.add(a);
    const list = [...seen]
      .map((id) => g.versions.get(id))
      .filter((v): v is VersionFile => v !== undefined);
    if (options.includeAuto) {
      for (const v of g.versions.values()) {
        if (v.auto && v.branch === branch && g.snapshots.has(v.hash)) list.push(v);
      }
    }
    const out = topological(list.filter((v) => options.includeAuto || !v.auto)).map((v) =>
      this.toVersion(g, v),
    );
    return options.limit === undefined ? out : out.slice(0, options.limit);
  }

  saveVersion(
    files: ProjectFiles,
    message: string,
    options: { author: Author; auto?: boolean },
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        const g = await this.load();
        const content = versionedFiles(files);
        const hash = await hashProjectFiles(content);
        const head = this.currentHead(g);
        if (head && head.hash === hash) return ok(this.toVersion(g, head));
        if (options.auto) {
          // The latest automatic snapshot of the same content is reused, too.
          const last = [...g.versions.values()]
            .filter((v) => v.auto && v.branch === this.local.branch && g.snapshots.has(v.hash))
            .sort(newestFirst)[0];
          if (last && last.hash === hash) return ok(this.toVersion(g, last));
          const v = await this.write(g, content, hash, {
            parents: head ? [head.id] : [],
            message,
            author: options.author,
            auto: true,
          });
          return ok(this.toVersion(g, v));
        }
        const v = await this.write(g, content, hash, {
          parents: head ? [head.id] : [],
          message,
          author: options.author,
        });
        await this.advance(g, v, head ? [head.id] : []);
        return ok(this.toVersion(g, v));
      }),
    );
  }

  read(versionId: string): Promise<StorageResult<ProjectFiles>> {
    return this.guard(async () => {
      const g = await this.load();
      const v = g.versions.get(versionId);
      if (!v) return fail('NOT_FOUND', 'That version isn’t in this project’s history');
      const path = this.path('snapshots', `${v.hash}.zip`);
      const bytes = await this.files.read(path);
      if (!bytes) {
        return fail(
          'NOT_FOUND',
          v.auto ? 'That automatic snapshot was pruned' : 'That version’s snapshot is missing',
          path,
        );
      }
      let files: ProjectFiles;
      try {
        files = unpackFiles(bytes).files;
      } catch {
        return fail('REMOTE', 'That version’s snapshot is damaged', path);
      }
      if ((await hashProjectFiles(files)) !== v.hash) {
        return fail('REMOTE', 'That version’s snapshot doesn’t match its hash', path);
      }
      return ok(files);
    });
  }

  async branches(): Promise<Branch[]> {
    const g = await this.load();
    const out: Branch[] = [];
    for (const name of [...g.refs.keys()].sort()) {
      const heads = this.heads(g, name);
      const mine =
        name === this.local.branch
          ? (heads.find((h) => h.id === this.local.version) ?? heads[0])
          : undefined;
      for (const h of heads) out.push({ name, head: h.id, current: h === mine });
    }
    return out;
  }

  createBranch(name: string, from?: string): Promise<StorageResult<Branch>> {
    return this.serial(() =>
      this.guard(async () => {
        const problem = nameProblem(name, 'branch');
        if (problem) return fail('PERMISSION', problem);
        const g = await this.load();
        if (this.heads(g, name).length > 0)
          return fail('CONFLICT', `There’s already a branch called ‘${name}’`);
        const start = from ?? this.currentHead(g)?.id;
        if (!start) return fail('NOT_FOUND', 'Save a version first, then branch from it');
        const v = g.versions.get(start);
        if (!v || v.auto) return fail('NOT_FOUND', 'A branch has to start at a saved version');
        await this.files.write(this.path('refs', 'heads', encodeName(name), start), EMPTY);
        return ok({ name, head: start, current: false });
      }),
    );
  }

  switchBranch(name: string): Promise<StorageResult<ProjectFiles>> {
    return this.serial(() =>
      this.guard(async () => {
        const g = await this.load();
        const head = this.heads(g, name)[0];
        if (!head) return fail('NOT_FOUND', `There’s no branch called ‘${name}’`);
        const files = await this.read(head.id);
        if (files.ok) this.setState({ branch: name, version: head.id });
        return files;
      }),
    );
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const g = await this.load();
    const ofA = this.ancestors(g, a);
    const common = [...this.ancestors(g, b)].filter((id) => ofA.has(id) && g.versions.has(id));
    // Best common ancestors: those that aren't an ancestor of another common ancestor.
    const below = new Set<string>();
    for (const id of common) for (const x of this.ancestors(g, id)) if (x !== id) below.add(x);
    const best = common
      .filter((id) => !below.has(id))
      .map((id) => g.versions.get(id) as VersionFile)
      .sort(newestFirst);
    return best[0]?.id ?? null;
  }

  commitMerge(
    files: ProjectFiles,
    message: string,
    parents: [string, string],
    author: Author,
  ): Promise<StorageResult<Version>> {
    return this.serial(() =>
      this.guard(async () => {
        const g = await this.load();
        for (const p of parents)
          if (!g.versions.has(p))
            return fail('NOT_FOUND', 'A version being merged isn’t in this history');
        const content = versionedFiles(files);
        const v = await this.write(g, content, await hashProjectFiles(content), {
          parents: [...parents],
          message,
          author,
        });
        await this.advance(g, v, parents);
        return ok(this.toVersion(g, v));
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
        const g = await this.load();
        if (g.releases.some((r) => r.name === name)) {
          return fail('CONFLICT', `‘${name}’ is already released; releases can’t be changed`);
        }
        if (!g.versions.has(versionId))
          return fail('NOT_FOUND', 'That version isn’t in this project’s history');
        const folder = `releases/${slugify(name, 'release')}/`;
        if ((await this.files.list(folder)).length > 0) {
          return fail('CONFLICT', `The folder ‘${folder}’ already holds a release`, folder);
        }
        const paths: string[] = [];
        for (const [p, bytes] of [...exports].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (!safeExportPath(p)) return fail('PERMISSION', `Invalid export file name ‘${p}’`);
          await this.files.write(folder + p, bytes);
          paths.push(folder + p);
        }
        const r: ReleaseFile = {
          format: 'whittle-release',
          name,
          versionId,
          at: this.now().toISOString(),
          author,
          files: paths,
        };
        await this.files.write(
          this.path('refs', 'releases', encodeName(name), versionId),
          canonicalBytes(r),
        );
        return ok({ name, versionId, at: r.at, author, files: paths });
      }),
    );
  }

  async releases(): Promise<Release[]> {
    return (await this.load()).releases.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  prune(policy: Partial<PrunePolicy> = {}): Promise<number> {
    return this.serial(async () => {
      const g = await this.load();
      const keep = new Set(g.releases.map((r) => r.versionId));
      if (this.local.version) keep.add(this.local.version);
      const drop = new Set(selectPrunable([...g.versions.values()], keep, policy, this.now()));
      if (drop.size === 0) return 0;
      const stillUsed = new Set(
        [...g.versions.values()].filter((v) => !drop.has(v.id)).map((v) => v.hash),
      );
      for (const id of drop) {
        const v = g.versions.get(id) as VersionFile;
        await this.files.remove(this.path('versions', `${id}.json`));
        this.cache.delete(id);
        if (!stillUsed.has(v.hash)) {
          await this.files.remove(this.path('snapshots', `${v.hash}.zip`));
          stillUsed.add(v.hash);
        }
      }
      return drop.size;
    });
  }
}

export function createSnapshotHistory(
  options: SnapshotHistoryOptions,
): SnapshotHistory & { state(): SnapshotLocalState } {
  return new SnapshotHistoryImpl(options);
}
