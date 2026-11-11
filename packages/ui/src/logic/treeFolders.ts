/**
 * Feature-tree folders and sketch visibility: the pure rules behind the tree (M3.6, ADR-066).
 *
 * A folder is a contiguous run of the flat feature list. These helpers mirror the document
 * layer's membership rules so the tree can label a drop ("goes into Mounting", "leaves Mounting")
 * before it happens. The document layer stays the authority; nothing here writes anything.
 */

import type { Id } from '@wren-cad/contracts';
import type { TreeNesting } from './treeNesting';

/** Structural twin of the contracts' `FeatureFolder`: a named, contiguous run of feature ids. */
export interface TreeFolder {
  id: Id;
  name: string;
  /** Member ids in history order. */
  features: readonly Id[];
}

export type SketchVisibilityMode = 'auto' | 'shown' | 'hidden';

export type CanFolder = { ok: true } | { ok: false; reason: string };

const idsOf = (features: readonly { id: Id }[]): Id[] => features.map((f) => f.id);

/** `[start, end]` document indices of a folder's run (inclusive), or null when a member is gone. */
export function folderRange(
  features: readonly { id: Id }[],
  folder: Pick<TreeFolder, 'features'>,
): { start: number; end: number } | null {
  const index = new Map(idsOf(features).map((id, i) => [id, i]));
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  for (const id of folder.features) {
    const i = index.get(id);
    if (i === undefined) return null;
    start = Math.min(start, i);
    end = Math.max(end, i);
  }
  return end < 0 ? null : { start, end };
}

/** The folder holding feature `id`, if any. */
export function folderOf(folders: readonly TreeFolder[], id: Id): TreeFolder | undefined {
  return folders.find((f) => f.features.includes(id));
}

/**
 * Can these features become a new folder? They must exist, be one contiguous run of the history
 * and not already belong to a folder (folders never overlap or nest). The reason is a sentence
 * for a disabled menu item, so a user learns what to change.
 */
export function canFolder(
  features: readonly { id: Id; name?: string }[],
  folders: readonly TreeFolder[],
  ids: readonly Id[],
): CanFolder {
  if (ids.length === 0) return { ok: false, reason: 'Select the features to group first.' };
  const index = new Map(idsOf(features).map((id, i) => [id, i]));
  const picked = [...new Set(ids)];
  const positions: number[] = [];
  for (const id of picked) {
    const i = index.get(id);
    if (i === undefined) return { ok: false, reason: 'A selected feature no longer exists.' };
    positions.push(i);
  }
  positions.sort((a, b) => a - b);
  for (const id of picked) {
    const f = folderOf(folders, id);
    if (f) {
      const name = features[index.get(id) as number]?.name;
      return {
        ok: false,
        reason: `${name ?? 'A selected feature'} is already in the folder “${f.name}”. A feature can be in one folder.`,
      };
    }
  }
  const first = positions[0] as number;
  const last = positions[positions.length - 1] as number;
  if (last - first + 1 !== positions.length) {
    const gap = features.find((f, i) => i > first && i < last && !picked.includes(f.id));
    return {
      ok: false,
      reason: `The features must be consecutive in the history${gap?.name ? `; ${gap.name} sits between them` : ''}.`,
    };
  }
  return { ok: true };
}

/**
 * The features to group for a selection: the picks plus the sketches nested under them (a feature
 * and its sketch travel together, ADR-015), in history order. Use it before `canFolder` and
 * `addFolder` so a selected Extrude brings its sketch along.
 */
export function runWithNested(
  features: readonly { id: Id }[],
  nesting: TreeNesting,
  ids: readonly Id[],
): Id[] {
  const index = new Map(features.map((f, i) => [f.id, i]));
  const all = new Set<Id>();
  for (const id of ids) {
    all.add(id);
    for (const k of nesting.childrenOf.get(id) ?? []) all.add(k);
  }
  return [...all].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
}

/* ------------------------------------------------------------------ moving */

/** One `moveFeature` of a block move. */
export interface BlockStep {
  id: Id;
  from: number;
  toIndex: number;
}

/**
 * Moves `members` (a feature and its nested sketches, in document order, the feature last) so the
 * block sits right before `ref` (undefined = at the end). The order of the steps keeps every
 * intermediate document valid (sketches first when moving up, the feature first when moving down).
 * Steps that move nothing are dropped.
 */
export function planBlockMove(
  ids: readonly Id[],
  members: readonly Id[],
  ref: Id | undefined,
): BlockStep[] {
  const head = members[members.length - 1] as Id;
  const cur = ids.slice();
  const steps: BlockStep[] = [];
  const down = ref === undefined || cur.indexOf(head) < cur.indexOf(ref);
  const order = down ? members.slice().reverse() : members;
  let anchor = ref;
  for (const m of order) {
    const from = cur.indexOf(m);
    cur.splice(from, 1);
    const at = anchor === undefined ? cur.length : cur.indexOf(anchor);
    cur.splice(at, 0, m);
    if (at !== from) steps.push({ id: m, from, toIndex: at });
    if (down) anchor = m;
  }
  return steps;
}

/** The order after applying `steps`. */
export function applySteps(ids: readonly Id[], steps: readonly BlockStep[]): Id[] {
  const cur = ids.slice();
  for (const s of steps) {
    cur.splice(cur.indexOf(s.id), 1);
    cur.splice(s.toIndex, 0, s.id);
  }
  return cur;
}

export interface Membership {
  /** The folder the moved feature joins (it lands strictly between two members). */
  joins?: Id;
  /** The folder it leaves (it lands outside the run of the others). */
  leaves?: Id;
}

/**
 * What a move does to folder membership, by the document layer's rules: a member moved outside the
 * run of the other members leaves; a non-member strictly between two members joins; landing just
 * before the first or after the last member changes nothing. `after` is the order after the move
 * and `block` the ids that moved (the feature last).
 */
export function membershipAfterMove(
  after: readonly Id[],
  folders: readonly TreeFolder[],
  block: readonly Id[],
): Membership {
  const head = block[block.length - 1] as Id;
  const at = after.indexOf(head);
  const moved = new Set(block);
  const own = folderOf(folders, head);
  // Mirrors the document (foldersAfterPlace): strictly inside a run joins it, anywhere else leaves;
  // a folder whose last member leaves goes. A member can leave its folder and join another.
  const joinsOther = (except?: Id): Id | undefined => {
    for (const f of folders) {
      if (f.id === except) continue;
      const pos = f.features
        .filter((m) => !moved.has(m))
        .map((m) => after.indexOf(m))
        .filter((p) => p >= 0);
      if (pos.length < 2) continue;
      if (at > Math.min(...pos) && at < Math.max(...pos)) return f.id;
    }
    return undefined;
  };
  if (own) {
    const others = own.features.filter((m) => !moved.has(m)).map((m) => after.indexOf(m));
    const stays = others.length > 0 && at > Math.min(...others) && at < Math.max(...others);
    if (stays) return {};
    const joins = joinsOther(own.id);
    return joins ? { leaves: own.id, joins } : { leaves: own.id };
  }
  const joins = joinsOther();
  return joins ? { joins } : {};
}

/** The folder whose run the document gap `g` (before feature index g) lies strictly inside. */
export function folderAtGap(
  features: readonly { id: Id }[],
  folders: readonly TreeFolder[],
  g: number,
): TreeFolder | undefined {
  return folders.find((f) => {
    const r = folderRange(features, f);
    return r ? g > r.start && g <= r.end : false;
  });
}

export type FolderMovePlan =
  | { ok: true; toIndex: number }
  | { ok: false; reason: string }
  | { ok: 'noop' };

/**
 * Where dropping the folder at document gap `g` puts it, as the `moveFolder` `toIndex` (the
 * position of its first member with the run taken out). A gap inside another folder is refused;
 * a gap at or inside its own run changes nothing.
 */
export function planFolderMove(
  features: readonly { id: Id }[],
  folders: readonly TreeFolder[],
  folderId: Id,
  g: number,
): FolderMovePlan {
  const folder = folders.find((f) => f.id === folderId);
  const run = folder ? folderRange(features, folder) : null;
  if (!folder || !run) return { ok: false, reason: 'That folder no longer exists.' };
  if (g >= run.start && g <= run.end + 1) return { ok: 'noop' };
  const inside = folderAtGap(features, folders, g);
  if (inside && inside.id !== folderId) {
    return { ok: false, reason: `That spot is inside the folder “${inside.name}”.` };
  }
  const len = run.end - run.start + 1;
  const toIndex = g > run.end ? g - len : g;
  return toIndex === run.start ? { ok: 'noop' } : { ok: true, toIndex };
}

/* ------------------------------------------------------------------ sketch visibility */

/**
 * Whether a sketch shows in the viewport. `auto` (or absent) follows ADR-060: shown until a
 * feature consumes it, hidden after; `shown` / `hidden` are the user's explicit choice.
 */
export function effectiveSketchShown(
  visibility: SketchVisibilityMode | undefined,
  consumed: boolean,
): boolean {
  if (visibility === 'shown') return true;
  if (visibility === 'hidden') return false;
  return !consumed;
}

/** Plane, axis and point features: reference geometry with a viewport eye (ADR-093). */
export function isReferenceType(type: string): boolean {
  return type === 'plane' || type === 'axis' || type === 'point';
}

/** The explicit value a click on the eye writes: the opposite of what is shown now. */
export function toggledVisibility(shown: boolean): 'shown' | 'hidden' {
  return shown ? 'hidden' : 'shown';
}
