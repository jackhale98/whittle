// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Feature tree folders in the merge (M3.6, ADR-066): the membership set merge, and the seam for
 * the normalisation that restores the folder invariant (contiguous, non-overlapping runs of
 * `Part.features`) after two sides' edits were combined.
 *
 * The normaliser is the document package's `normalizeFolders` by default and can be injected
 * (`new StructuralMerger({ normalizeFolders })`), e.g. to test the merge against another policy.
 */

import type { Id, Part } from '@wren-cad/contracts';
import type { NormalizedFolders } from '@wren-cad/document';

export type { FolderChange, NormalizedFolders } from '@wren-cad/document';

/**
 * Restores the folder invariant of one part against its `features` and reports each membership
 * change (ADR-066). Pure. The default is `normalizeFolders` from `@wren-cad/document`.
 */
export type NormalizeFolders = (part: Part) => NormalizedFolders;

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
