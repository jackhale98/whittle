// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Uncommitted changes of one project in a working tree (`GitHistory.workingChanges`). Walks HEAD,
 * the working tree and the index for the project folder only.
 *
 * Unchanged files are recognised without reading them: when the index entry still has HEAD's
 * blob and the file's size and modification time (to the millisecond) are the ones the index
 * recorded, the file is clean. This holds for an index written by the user's git as well as by
 * isomorphic-git, because only size and mtime are compared (File System Access has no inode,
 * ctime or owner, which isomorphic-git's own stat check also compares). A file modified at or
 * after the index was written ("racy git") is always hashed. Anything else is hashed and compared
 * with HEAD; an LFS pointer in HEAD matches the content it stands for.
 */

import git, { STAGE, TREE, type Walker, WORKDIR } from 'isomorphic-git';
import { isVersionedPath } from '../hash';
import { lfsPointer, matchesLfs } from './lfs';
import type { ProjectScope } from './scope';
import type { GitAt } from './tree';

export type WorkingChange = { path: string; status: 'added' | 'modified' | 'deleted' };

interface StatLike {
  size: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
}

const msOf = (s: StatLike) => s.mtimeSeconds * 1000 + Math.floor(s.mtimeNanoseconds / 1e6);

export function gitdirOf(a: GitAt): string {
  return a.gitdir ?? `${a.dir.replace(/\/+$/, '')}/.git`;
}

const base = (a: GitAt) => {
  const o = { fs: a.fs, dir: a.dir, cache: a.cache };
  return a.gitdir === undefined ? o : { ...o, gitdir: a.gitdir };
};

/** Counts how many working files had to be hashed (for tests and diagnostics). */
export interface StatusCounters {
  hashed: number;
}

export async function projectStatus(
  a: GitAt,
  scope: ProjectScope,
  counters?: StatusCounters,
): Promise<WorkingChange[]> {
  const out: WorkingChange[] = [];
  const gitdir = gitdirOf(a);
  const indexStat = (await a.fs.promises.stat(`${gitdir}/index`).catch(() => null)) as {
    mtimeMs?: number;
  } | null;
  const indexMs = Math.floor(indexStat?.mtimeMs ?? 0);
  const hasHead = await git
    .resolveRef({ ...base(a), ref: 'HEAD' })
    .then(() => true)
    .catch(() => false);
  const trees: Walker[] = hasHead
    ? [TREE({ ref: 'HEAD' }), WORKDIR(), STAGE()]
    : [WORKDIR(), STAGE()];
  await git.walk({
    ...base(a),
    trees,
    map: async (path, entries) => {
      if (path === '.') return true;
      const [head, work, stage] = hasHead ? entries : [null, ...entries];
      if (!scope.worthWalking(path)) return null;
      if (path.slice(path.lastIndexOf('/') + 1) === '.git') return null;
      const rel = scope.toProject(path);
      // The cache (`.wren/`) and snapshot history are never part of a version.
      if (rel !== null && !isVersionedPath(`${rel}/`)) return null;
      if (!head && !stage && work) {
        if (await git.isIgnored({ fs: a.fs, dir: a.dir, gitdir, filepath: path })) return null;
      }
      const [ht, wt, st] = await Promise.all([head?.type(), work?.type(), stage?.type()]);
      if (rel === null) return true;
      const hBlob = ht === 'blob';
      const wBlob = wt === 'blob';
      if (!hBlob && !wBlob) return true;
      if (hBlob && !wBlob) {
        out.push({ path: rel, status: 'deleted' });
        return true;
      }
      if (!hBlob) {
        out.push({ path: rel, status: 'added' });
        return true;
      }
      const headOid = await head?.oid();
      if (st === 'blob' && stage && (await stage.oid()) === headOid) {
        const [ws, ss] = (await Promise.all([work?.stat(), stage.stat()])) as StatLike[];
        if (
          ws &&
          ss &&
          ws.size === ss.size &&
          msOf(ws) === msOf(ss) &&
          (indexMs === 0 || msOf(ws) < indexMs)
        ) {
          return true;
        }
      }
      const content = await work?.content();
      if (content === undefined) return true;
      if (counters) counters.hashed++;
      const { oid } = await git.hashBlob({ object: content });
      if (oid === headOid) return true;
      const pointer = await head?.content();
      if (pointer && lfsPointer(pointer) && (await matchesLfs(pointer, content))) return true;
      out.push({ path: rel, status: 'modified' });
      return true;
    },
  });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
