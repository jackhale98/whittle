// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature tree folders in the merge (M3.6, ADR-066): the membership set merge and the
 * normalisation that restores the folder invariant (contiguous, non-overlapping runs of
 * `Part.features`) after two sides' edits were combined.
 *
 * `normalizeFolders` here is a local stand-in with the semantics ADR-066 gives the document
 * package's `normalizeFolders(part)`. The merge takes the normaliser as an injected
 * `NormalizeFolders` (`new StructuralMerger({ normalizeFolders })`), so switching to the document
 * package's function at integration is a one-line change of the default (plus an adapter if its
 * report has a different shape).
 */

import type { FeatureFolder, Id, Part } from '@wren-cad/contracts';

/** Why a feature left or joined a folder, or why a folder went. */
export type FolderChange =
  /** The feature is no longer in the part (deleted). Not worth a merge note on its own. */
  | { kind: 'left'; folderId: Id; featureId: Id; reason: 'missing' }
  /** Another folder (one that starts earlier in the tree) already holds the feature. */
  | { kind: 'left'; folderId: Id; featureId: Id; reason: 'shared'; keptBy: Id }
  /** The run was broken and couldn't be closed: only its longest piece stays in the folder. */
  | { kind: 'left'; folderId: Id; featureId: Id; reason: 'split' }
  /** The run was broken by a feature in no folder: that feature joined to close the gap. */
  | { kind: 'joined'; folderId: Id; featureId: Id; reason: 'gap' }
  /** No member is left. */
  | { kind: 'removed'; folderId: Id; reason: 'empty' };

export interface FolderNormalization {
  /** The folders that remain, in their input order, each a contiguous run in history order. */
  folders: FeatureFolder[];
  changes: FolderChange[];
}

/** Restores the folder invariant of one part against its `features` (ADR-066). Pure. */
export type NormalizeFolders = (
  part: Readonly<Pick<Part, 'features' | 'folders'>>,
) => FolderNormalization;

/**
 * ADR-066 normalisation, applied to every folder:
 *  1. members are de-duplicated, ids no longer in `features` dropped, the rest sorted into
 *     history order;
 *  2. a feature listed by two folders stays in the one whose first member comes first in the
 *     tree (tie: the smaller folder id) and leaves the others;
 *  3. a broken run is extended over its gaps when no gap feature is in another folder;
 *  4. otherwise the longest contiguous piece is kept (the earliest on a tie) and the rest leave;
 *  5. a folder left with no members is removed.
 * Folders are processed in tree order (first member, then id), so the result doesn't depend on the
 * array's order, and the array keeps its input order.
 */
export const normalizeFolders: NormalizeFolders = (part) => {
  const folders = part.folders ?? [];
  const changes: FolderChange[] = [];
  const index = new Map(part.features.map((f, i) => [f.id, i]));
  const members = new Map<Id, number[]>();
  for (const folder of folders) {
    const seen = new Set<Id>();
    const at: number[] = [];
    for (const fid of folder.features) {
      if (seen.has(fid)) continue;
      seen.add(fid);
      const i = index.get(fid);
      if (i === undefined)
        changes.push({ kind: 'left', folderId: folder.id, featureId: fid, reason: 'missing' });
      else at.push(i);
    }
    members.set(
      folder.id,
      at.sort((a, b) => a - b),
    );
  }
  const first = (f: FeatureFolder) => members.get(f.id)?.[0] ?? Number.POSITIVE_INFINITY;
  const queue = folders
    .slice()
    .sort((a, b) => first(a) - first(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** Feature index → the folder that currently holds it (finished or not yet processed). */
  const owner = new Map<number, Id>();
  for (const f of queue.slice().reverse())
    for (const i of members.get(f.id) ?? []) owner.set(i, f.id);
  const featureId = (i: number) => part.features[i]?.id as Id;
  const done = new Map<Id, number[]>();
  for (const folder of queue) {
    const fid = folder.id;
    let at = members.get(fid) ?? [];
    // 2. Shared members: the earlier folder keeps them. One it let go of (step 4) is free again.
    at = at.filter((i) => {
      const o = owner.get(i);
      if (o === undefined) owner.set(i, fid);
      else if (o !== fid) {
        changes.push({
          kind: 'left',
          folderId: fid,
          featureId: featureId(i),
          reason: 'shared',
          keptBy: o,
        });
        return false;
      }
      return true;
    });
    if (at.length > 1) {
      const lo = at[0] as number;
      const hi = at[at.length - 1] as number;
      if (hi - lo + 1 !== at.length) {
        const mine = new Set(at);
        const gap: number[] = [];
        for (let i = lo; i <= hi; i++) if (!mine.has(i)) gap.push(i);
        if (gap.every((i) => !owner.has(i))) {
          // 3. Close the gap.
          for (const i of gap) {
            owner.set(i, fid);
            changes.push({ kind: 'joined', folderId: fid, featureId: featureId(i), reason: 'gap' });
          }
          at = [...at, ...gap].sort((a, b) => a - b);
        } else {
          // 4. Keep the longest contiguous piece, the earliest on a tie.
          let best: number[] = [];
          let run: number[] = [];
          for (const i of at) {
            if (run.length > 0 && i !== (run[run.length - 1] as number) + 1) run = [];
            run.push(i);
            if (run.length > best.length) best = run.slice();
          }
          const keep = new Set(best);
          for (const i of at) {
            if (keep.has(i)) continue;
            owner.delete(i);
            changes.push({ kind: 'left', folderId: fid, featureId: featureId(i), reason: 'split' });
          }
          at = best;
        }
      }
    }
    done.set(fid, at);
  }
  const out: FeatureFolder[] = [];
  for (const folder of folders) {
    const at = done.get(folder.id) ?? [];
    if (at.length === 0) {
      changes.push({ kind: 'removed', folderId: folder.id, reason: 'empty' });
      continue;
    }
    out.push({ ...folder, features: at.map(featureId) });
  }
  return { folders: out, changes };
};

/**
 * Three-way merge of a folder's member set: a member both sides keep stays, one that either side
 * added (not in base) joins, one that either side removed goes. Never conflicts; the result is
 * normalised afterwards. Ours' order first, then theirs' additions.
 */
export function mergeMembers(
  base: readonly Id[] | undefined,
  ours: readonly Id[] | undefined,
  theirs: readonly Id[] | undefined,
): Id[] {
  const [b, o, t] = [new Set(base ?? []), new Set(ours ?? []), new Set(theirs ?? [])];
  const keep = (id: Id) => (o.has(id) && t.has(id)) || (!b.has(id) && (o.has(id) || t.has(id)));
  return [...new Set([...(ours ?? []), ...(theirs ?? [])])].filter(keep);
}

/** Whether `segs` is a folder's member list: `['parts', id, 'folders', id, 'features']`. */
export function isFolderMembersPath(segs: readonly string[]): boolean {
  return (
    segs.length === 5 && segs[0] === 'parts' && segs[2] === 'folders' && segs[4] === 'features'
  );
}

/** Whether `segs` is a sketch's `visibility` field: `['parts', id, 'features', id, 'visibility']`. */
export function isVisibilityPath(segs: readonly string[]): boolean {
  return (
    segs.length === 5 && segs[0] === 'parts' && segs[2] === 'features' && segs[4] === 'visibility'
  );
}

/** Absent visibility means `'auto'` (ADR-066). */
export const visibilityOf = (v: unknown): unknown => (v === undefined ? 'auto' : v);
