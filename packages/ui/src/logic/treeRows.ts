/**
 * The rows the feature tree shows: top-level features, folders, folder members and nested
 * sketches, in display order. A pure function of the document slice and the UI's expand/collapse
 * state, so it is unit-tested without a DOM.
 */

import type { Id } from '@wren-cad/contracts';
import { folderRange, type TreeFolder } from './treeFolders';
import type { TreeNesting } from './treeNesting';

export interface TreeRow {
  kind: 'feature' | 'folder';
  /** Unique across rows: the feature id, or `folder:<id>` for a folder. */
  key: string;
  /** Feature id or folder id. */
  id: Id;
  /** Document index (a folder: its first member). */
  i: number;
  /** ARIA level: 1 top, 2 a folder member or a sketch under a top-level feature, 3 under a member. */
  level: 1 | 2 | 3;
  /** Position among its siblings (1-based) and their count. */
  pos: number;
  size: number;
  /** The row this one is nested under (a folder or a feature). */
  parent?: string;
  /** The folder a feature row belongs to. */
  folderId?: Id;
  /** A sketch shown under the feature that uses it (ADR-015). */
  nestedSketch: boolean;
}

export const folderKey = (id: Id): string => `folder:${id}`;

export interface RowInput {
  features: readonly { id: Id }[];
  nesting: TreeNesting;
  folders: readonly TreeFolder[];
  /** Features whose nested sketches are open. */
  expanded: ReadonlySet<Id>;
  /** Folders that are closed. */
  collapsed: ReadonlySet<Id>;
}

type Item = { folder: TreeFolder; members: Id[] } | { feature: Id };

/** Display units in order: a folder is one unit at the place of its first member. */
function items({ features, nesting, folders }: RowInput): Item[] {
  const index = new Map(features.map((f, i) => [f.id, i]));
  const tops = features.filter((f) => !nesting.parentOf.has(f.id)).map((f) => f.id);
  const holder = new Map<Id, TreeFolder>();
  for (const f of folders) for (const m of f.features) if (index.has(m)) holder.set(m, f);
  const emitted = new Set<Id>();
  const out: Item[] = [];
  const emitFolder = (folder: TreeFolder) => {
    emitted.add(folder.id);
    out.push({ folder, members: tops.filter((t) => holder.get(t)?.id === folder.id) });
  };
  // A folder whose members all sit nested under outside features still shows, by its first index.
  const start = (f: TreeFolder) => folderRange(features, f)?.start ?? Number.POSITIVE_INFINITY;
  const live = folders.filter((f) => Number.isFinite(start(f)));
  for (const t of tops) {
    for (const f of live) {
      if (
        !emitted.has(f.id) &&
        start(f) < (index.get(t) ?? 0) &&
        !tops.some((x) => holder.get(x) === f)
      ) {
        emitFolder(f);
      }
    }
    const f = holder.get(t);
    if (f) {
      if (!emitted.has(f.id)) emitFolder(f);
    } else out.push({ feature: t });
  }
  for (const f of live) if (!emitted.has(f.id)) emitFolder(f);
  return out;
}

export function buildRows(input: RowInput): TreeRow[] {
  const { features, nesting, expanded, collapsed } = input;
  const index = new Map(features.map((f, i) => [f.id, i]));
  const list = items(input);
  const out: TreeRow[] = [];
  const kidsOf = (id: Id, level: 2 | 3, parent: string, folderId?: Id) => {
    if (!expanded.has(id)) return;
    const kids = nesting.childrenOf.get(id) ?? [];
    kids.forEach((c, j) => {
      out.push({
        kind: 'feature',
        key: c,
        id: c,
        i: index.get(c) ?? 0,
        level,
        pos: j + 1,
        size: kids.length,
        parent,
        ...(folderId ? { folderId } : {}),
        nestedSketch: true,
      });
    });
  };
  list.forEach((item, k) => {
    if ('feature' in item) {
      out.push({
        kind: 'feature',
        key: item.feature,
        id: item.feature,
        i: index.get(item.feature) ?? 0,
        level: 1,
        pos: k + 1,
        size: list.length,
        nestedSketch: false,
      });
      kidsOf(item.feature, 2, item.feature);
      return;
    }
    const { folder, members } = item;
    out.push({
      kind: 'folder',
      key: folderKey(folder.id),
      id: folder.id,
      i: folderRange(features, folder)?.start ?? 0,
      level: 1,
      pos: k + 1,
      size: list.length,
      nestedSketch: false,
    });
    if (collapsed.has(folder.id)) return;
    members.forEach((m, j) => {
      out.push({
        kind: 'feature',
        key: m,
        id: m,
        i: index.get(m) ?? 0,
        level: 2,
        pos: j + 1,
        size: members.length,
        parent: folderKey(folder.id),
        folderId: folder.id,
        nestedSketch: false,
      });
      kidsOf(m, 3, m, folder.id);
    });
  });
  return out;
}

/** Document gap (the index a block moved here would take) just before this head row. */
export function gapBefore(
  row: TreeRow,
  features: readonly { id: Id }[],
  nesting: TreeNesting,
): number {
  if (row.kind === 'folder') return row.i;
  const idx = new Map(features.map((f, i) => [f.id, i]));
  let g = row.i;
  for (const k of nesting.childrenOf.get(row.id) ?? []) g = Math.min(g, idx.get(k) ?? g);
  return g;
}
