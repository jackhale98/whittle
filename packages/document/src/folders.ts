// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature tree folders (M3.6, ADR-066): membership rules, merge normalisation, patch helpers.
 *
 * A folder is `{ id, name, features }`; `features` is a contiguous run of the part's feature
 * ids in history order. Folders never overlap and never nest. Everything here is pure.
 */

import type { FeatureFolder, Id, JsonPatchOp, Part } from '@wren-cad/contracts';
import { diff } from './patch';

/** One membership change `normalizeFolders` made; sync shows these after a merge. */
export interface FolderChange {
  folderId: Id;
  folderName: string;
  /**
   * - `missing`: members that no longer exist were dropped;
   * - `shared`: members also held by another folder were dropped (the lowest folder id keeps them);
   * - `extended`: features inside a gap were added so the run is contiguous again;
   * - `trimmed`: members outside the longest contiguous run were dropped;
   * - `removed`: the folder was removed because it ended up empty.
   */
  kind: 'missing' | 'shared' | 'extended' | 'trimmed' | 'removed';
  /** The features dropped or added (empty for `removed`). */
  featureIds: Id[];
}

export interface NormalizedFolders {
  /** The same object when nothing changed. */
  part: Part;
  changes: FolderChange[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const contiguous = (idx: readonly number[]): boolean =>
  idx.every((v, k) => k === 0 || v === (idx[k - 1] as number) + 1);

/** Splits sorted indices into maximal consecutive runs. */
function runs(idx: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const v of idx) {
    const last = out[out.length - 1];
    if (last && (last[last.length - 1] as number) + 1 === v) last.push(v);
    else out.push([v]);
  }
  return out;
}

/**
 * ADR-066 merge normalisation. Returns the part itself (same reference) when nothing changed.
 *
 * 1. members are sorted into history order; duplicates and ids that no longer exist are dropped;
 * 2. a feature held by several folders stays with the folder of the lowest id;
 * 3. empty folders are removed;
 * 4. a broken run is extended over its gap when the gap holds no other folder's member, otherwise
 *    the longest contiguous run is kept (the earliest on a tie). Folders are handled in order of
 *    their first member, so the result does not depend on the array order.
 *
 * Reordering alone is not reported; only membership changes are.
 */
export function normalizeFolders(part: Part): NormalizedFolders {
  const folders = part.folders;
  if (!folders || folders.length === 0) return { part, changes: [] };
  const order = part.features.map((f) => f.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  const changes: FolderChange[] = [];
  const at = (k: number): FeatureFolder => folders[k] as FeatureFolder;

  // Working state: sorted member indices per folder.
  const members: number[][] = [];
  folders.forEach((f, k) => {
    const idx = new Set<number>();
    const missing: Id[] = [];
    for (const m of f.features) {
      const i = pos.get(m);
      if (i === undefined) missing.push(m);
      else idx.add(i);
    }
    members[k] = [...idx].sort((a, b) => a - b);
    if (missing.length > 0) {
      changes.push({ folderId: f.id, folderName: f.name, kind: 'missing', featureIds: missing });
    }
  });

  // Shared members: the lowest folder id keeps them.
  const owner = new Map<number, number>();
  const byId = folders.map((_, k) => k).sort((a, b) => cmp(at(a).id, at(b).id));
  for (const k of byId) {
    const kept: number[] = [];
    const lost: number[] = [];
    for (const i of members[k] as number[]) {
      if (owner.has(i)) lost.push(i);
      else {
        owner.set(i, k);
        kept.push(i);
      }
    }
    members[k] = kept;
    if (lost.length > 0) {
      changes.push({
        folderId: at(k).id,
        folderName: at(k).name,
        kind: 'shared',
        featureIds: lost.map((i) => order[i] as Id),
      });
    }
  }

  // Contiguity, folders in history order of their first member.
  const live = folders
    .map((_, k) => k)
    .filter((k) => (members[k] as number[]).length > 0)
    .sort(
      (a, b) =>
        ((members[a] as number[])[0] as number) - ((members[b] as number[])[0] as number) ||
        cmp(at(a).id, at(b).id),
    );
  for (const k of live) {
    const idx = members[k] as number[];
    if (contiguous(idx)) continue;
    const lo = idx[0] as number;
    const hi = idx[idx.length - 1] as number;
    const mine = new Set(idx);
    const gap: number[] = [];
    for (let i = lo; i <= hi; i++) if (!mine.has(i)) gap.push(i);
    if (gap.every((i) => !owner.has(i))) {
      for (const i of gap) owner.set(i, k);
      members[k] = Array.from({ length: hi - lo + 1 }, (_, n) => lo + n);
      changes.push({
        folderId: at(k).id,
        folderName: at(k).name,
        kind: 'extended',
        featureIds: gap.map((i) => order[i] as Id),
      });
      continue;
    }
    let best = runs(idx)[0] as number[];
    for (const r of runs(idx)) if (r.length > best.length) best = r;
    const keep = new Set(best);
    const drop = idx.filter((i) => !keep.has(i));
    for (const i of drop) owner.delete(i);
    members[k] = best;
    changes.push({
      folderId: at(k).id,
      folderName: at(k).name,
      kind: 'trimmed',
      featureIds: drop.map((i) => order[i] as Id),
    });
  }

  const next: FeatureFolder[] = [];
  folders.forEach((f, k) => {
    const idx = members[k] as number[];
    if (idx.length === 0) {
      changes.push({ folderId: f.id, folderName: f.name, kind: 'removed', featureIds: [] });
      return;
    }
    const ids = idx.map((i) => order[i] as Id);
    const same = f.features.length === ids.length && f.features.every((m, n) => m === ids[n]);
    next.push(same ? f : { ...f, features: ids });
  });
  const unchanged = next.length === folders.length && next.every((f, k) => f === folders[k]);
  if (unchanged) return { part, changes };
  const out: Part = { ...part };
  if (next.length > 0) out.folders = next;
  else delete out.folders;
  return { part: out, changes };
}

/** Problems with a part's folders (existence, contiguity, overlap, order); empty when sound. */
export function folderProblems(part: Part): string[] {
  const errs: string[] = [];
  const order = part.features.map((f) => f.id);
  const claimed = new Map<Id, string>();
  part.folders?.forEach((f, k) => {
    const at = `folders[${k}]`;
    if (f.features.length === 0) errs.push(`${at} (‘${f.name}’) has no features`);
    for (const m of f.features) {
      const other = claimed.get(m);
      if (other !== undefined) errs.push(`${at}.features: ‘${m}’ is also in ${other}`);
      else claimed.set(m, at);
    }
    const idx = f.features.map((m) => order.indexOf(m));
    if (idx.includes(-1)) {
      errs.push(`${at}.features names a feature that is not in the part`);
      return;
    }
    if (new Set(idx).size !== idx.length) errs.push(`${at}.features lists a feature twice`);
    else if (!contiguous([...idx].sort((a, b) => a - b))) {
      errs.push(`${at}.features is not a contiguous run`);
    } else if (!contiguous(idx)) errs.push(`${at}.features is not in history order`);
  });
  return errs;
}

// ---------------------------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------------------------

/**
 * Patch ops turning the part's folders into `next` (key absent when empty, so files stay
 * canonical). `i` is the part's index in `doc.parts`.
 */
export function folderOps(
  i: number,
  old: FeatureFolder[] | undefined,
  next: FeatureFolder[],
): JsonPatchOp[] {
  const path = `/parts/${i}/folders`;
  if (next.length === 0) return old === undefined ? [] : [{ op: 'remove', path }];
  if (old === undefined) return [{ op: 'add', path, value: next }];
  return diff(old, next, path);
}

/** Folders after a feature is deleted. */
export function foldersAfterRemove(
  folders: readonly FeatureFolder[] | undefined,
  featureId: Id,
): FeatureFolder[] {
  return (folders ?? [])
    .map((f) =>
      f.features.includes(featureId)
        ? { ...f, features: f.features.filter((m) => m !== featureId) }
        : f,
    )
    .filter((f) => f.features.length > 0);
}

/**
 * Folders after `featureId` lands in `newOrder` (an insert or a move; `newOrder` already holds
 * it). Per the Command doc: strictly between two members of a folder joins it, anywhere else
 * leaves it. A folder's only member takes the folder along (moving a one-feature folder).
 */
export function foldersAfterPlace(
  folders: readonly FeatureFolder[] | undefined,
  newOrder: readonly Id[],
  featureId: Id,
): FeatureFolder[] {
  const out: FeatureFolder[] = [];
  const at = newOrder.indexOf(featureId);
  for (const f of folders ?? []) {
    const others = f.features.filter((m) => m !== featureId);
    if (others.length === 0) {
      out.push(f);
      continue;
    }
    const idx = others.map((m) => newOrder.indexOf(m)).sort((a, b) => a - b);
    const inside = at > (idx[0] as number) && at < (idx[idx.length - 1] as number);
    const kept = (inside ? [...others, featureId] : others).sort(
      (a, b) => newOrder.indexOf(a) - newOrder.indexOf(b),
    );
    const same = kept.length === f.features.length && kept.every((m, n) => m === f.features[n]);
    out.push(same ? f : { ...f, features: kept });
  }
  return out;
}
