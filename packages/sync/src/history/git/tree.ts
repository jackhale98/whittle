// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tree objects built directly, not from the index: a commit Whittle makes records exactly the
 * project's files, spliced into the parent commit's tree at the project folder. Whatever else the
 * user has staged or changed in their repository is neither committed nor touched.
 */

import git, { type PromiseFsClient, type TreeEntry } from 'isomorphic-git';

export interface GitAt {
  fs: PromiseFsClient;
  dir: string;
  gitdir?: string;
  cache: object;
}

/** A non-tree entry: a file (`100644`/`100755`), a symlink (`120000`) or a submodule (`160000`). */
export interface LeafEntry {
  oid: string;
  mode: string;
  type: 'blob' | 'commit';
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const at = (a: GitAt) => {
  const o = { fs: a.fs, dir: a.dir, cache: a.cache };
  return a.gitdir === undefined ? o : { ...o, gitdir: a.gitdir };
};

/** The entries of a tree (none for `null`). */
export async function treeEntries(a: GitAt, oid: string | null): Promise<TreeEntry[]> {
  if (oid === null) return [];
  return (await git.readTree({ ...at(a), oid })).tree;
}

/** The commit's root tree. */
export async function commitTree(a: GitAt, commit: string): Promise<string> {
  return (await git.readCommit({ ...at(a), oid: commit })).commit.tree;
}

/** The entry at `segments` under `tree`, or `null`. */
export async function entryAt(
  a: GitAt,
  tree: string | null,
  segments: readonly string[],
): Promise<TreeEntry | null> {
  let current: string | null = tree;
  let found: TreeEntry | null = null;
  for (const s of segments) {
    if (current === null) return null;
    found = (await treeEntries(a, current)).find((e) => e.path === s) ?? null;
    if (!found) return null;
    current = found.type === 'tree' ? found.oid : null;
  }
  return found;
}

/** The tree oid at `segments` (the whole tree for none), or `null` when there's no folder there. */
export async function subtreeAt(
  a: GitAt,
  tree: string | null,
  segments: readonly string[],
): Promise<string | null> {
  if (segments.length === 0) return tree;
  const e = await entryAt(a, tree, segments);
  return e?.type === 'tree' ? e.oid : null;
}

/**
 * Writes `files` (relative paths → leaf entries) as nested trees; the root tree's oid, or `null`
 * when there are no files (git has no empty folders).
 */
export async function writeNested(
  a: GitAt,
  files: ReadonlyMap<string, LeafEntry>,
): Promise<string | null> {
  interface Node {
    leaves: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { leaves: [], dirs: new Map() };
  for (const [path, leaf] of files) {
    const segs = path.split('/');
    const name = segs.pop() as string;
    let n = root;
    for (const s of segs) {
      let next = n.dirs.get(s);
      if (!next) {
        next = { leaves: [], dirs: new Map() };
        n.dirs.set(s, next);
      }
      n = next;
    }
    n.leaves.push({ mode: leaf.mode, path: name, oid: leaf.oid, type: leaf.type });
  }
  const write = async (n: Node): Promise<string | null> => {
    const tree: TreeEntry[] = [...n.leaves];
    for (const [name, child] of n.dirs) {
      const oid = await write(child);
      if (oid) tree.push({ mode: '040000', path: name, oid, type: 'tree' });
    }
    if (tree.length === 0) return null;
    return git.writeTree({ ...at(a), tree });
  };
  return write(root);
}

export type TreeEdit = { oid: string; mode: string; type: TreeEntry['type'] } | null;

interface EditNode {
  set?: TreeEdit;
  children: Map<string, EditNode>;
}

/**
 * `tree` with the entries at the given repository paths replaced (removed for `null`). Only the
 * trees on the way down are rewritten, each once, so no intermediate tree is left dangling.
 * Folders left empty disappear. Returns the new root tree (the empty tree when nothing is left).
 * The path `''` replaces the whole tree (its edit must be a tree).
 */
export async function spliceAll(
  a: GitAt,
  tree: string | null,
  edits: ReadonlyMap<string, TreeEdit>,
): Promise<string> {
  const whole = edits.get('');
  if (edits.has('')) {
    if (edits.size > 1) throw new Error('Replacing the whole tree excludes other edits');
    if (whole === null || whole === undefined) return git.writeTree({ ...at(a), tree: [] });
    if (whole.type !== 'tree') throw new Error('The repository root must be a folder');
    return whole.oid;
  }
  const root: EditNode = { children: new Map() };
  for (const [path, edit] of edits) {
    let n = root;
    for (const s of path.split('/')) {
      let next = n.children.get(s);
      if (!next) {
        next = { children: new Map() };
        n.children.set(s, next);
      }
      n = next;
    }
    n.set = edit;
  }
  const go = async (t: string | null, node: EditNode): Promise<string | null> => {
    const entries = new Map((await treeEntries(a, t)).map((e) => [e.path, e]));
    for (const [name, child] of node.children) {
      if (Object.hasOwn(child, 'set')) {
        if (child.children.size > 0) throw new Error(`Overlapping edits at ‘${name}’`);
        if (child.set) entries.set(name, { path: name, ...child.set });
        else entries.delete(name);
        continue;
      }
      const old = entries.get(name);
      const sub = await go(old?.type === 'tree' ? old.oid : null, child);
      if (sub) entries.set(name, { path: name, mode: '040000', oid: sub, type: 'tree' });
      else entries.delete(name);
    }
    if (entries.size === 0) return null;
    return git.writeTree({ ...at(a), tree: [...entries.values()] });
  };
  return (await go(tree, root)) ?? git.writeTree({ ...at(a), tree: [] });
}

/**
 * Paths where a checkout from tree `from` to tree `to` would create or replace a symbolic link
 * (unchanged subtrees are skipped by oid).
 */
export async function linksChanging(
  a: GitAt,
  from: string | null,
  to: string | null,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string, x: string | null, y: string | null): Promise<void> => {
    if (x === y) return;
    const [xe, ye] = await Promise.all([treeEntries(a, x), treeEntries(a, y)]);
    const xm = new Map(xe.map((e) => [e.path, e]));
    const ym = new Map(ye.map((e) => [e.path, e]));
    for (const name of new Set([...xm.keys(), ...ym.keys()])) {
      const p = path ? `${path}/${name}` : name;
      const [xi, yi] = [xm.get(name), ym.get(name)];
      if (xi?.oid === yi?.oid && xi?.mode === yi?.mode) continue;
      if (yi?.mode === '120000') out.push(p);
      if (xi?.type === 'tree' || yi?.type === 'tree') {
        await walk(p, xi?.type === 'tree' ? xi.oid : null, yi?.type === 'tree' ? yi.oid : null);
      }
    }
  };
  await walk('', from, to);
  return out;
}

/** Every leaf under `tree` by relative path (folders flattened). */
export async function flatten(
  a: GitAt,
  tree: string | null,
  prefix = '',
): Promise<Map<string, LeafEntry>> {
  const out = new Map<string, LeafEntry>();
  const walk = async (t: string, p: string) => {
    for (const e of await treeEntries(a, t)) {
      const path = p ? `${p}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, path);
      else
        out.set(path, { oid: e.oid, mode: e.mode, type: e.type === 'commit' ? 'commit' : 'blob' });
    }
  };
  if (tree) await walk(tree, prefix);
  return out;
}
