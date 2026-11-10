/**
 * The feature tree's props for every shell (desktop panel, tablet sheet, phone Features tab) and
 * its palette commands. Folders and the eye route to workbench
 * methods, each of which is one store command (one undo entry).
 */

import type { FeatureStatus, Id } from '@wren-cad/contracts';
import {
  type FeatureTreeItem,
  type FeatureTreeProps,
  folderCommands,
  type MoveResult,
  type MoveStep,
  type PaletteCommand,
  sketchVisibilityCommands,
} from '@wren-cad/ui';
import { useCallback, useMemo } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { featureLineage } from '../model/lineage';
import { reorderFeatures } from '../model/tree-edits';
import { useDoc } from './Inspector';

export interface TreeOptions {
  density: 'compact' | 'touch';
  nestSketches: boolean;
  setNestSketches(nest: boolean): void;
  statuses: readonly FeatureStatus[] | undefined;
}

export interface TreeProps {
  featureTree: FeatureTreeProps | undefined;
  commands: PaletteCommand[];
}

export function useTreeProps(wb: Workbench, o: TreeOptions): TreeProps {
  const { density, nestSketches, setNestSketches, statuses } = o;
  const doc = useDoc(wb);
  const ui = useObservable(wb.ui);
  const part = doc.parts[0];
  const shownIds = useObservable(wb.shownSketchIds);
  const collapsed = useObservable(wb.collapsedFolders);
  const treeSel = useObservable(wb.treeSelection);
  const selectedId = ui.featureId ?? ui.sketch?.featureId ?? null;

  const lineage = useMemo(() => {
    if (!selectedId) return undefined;
    const l = featureLineage(doc, selectedId);
    return { parents: l.parents.map((p) => p.id), children: l.children.map((p) => p.id) };
  }, [doc, selectedId]);

  // The eye of each sketch matches the viewport exactly: `shown` comes from the same resolver.
  const items = useMemo<FeatureTreeItem[]>(
    () =>
      (part?.features ?? []).map((f) =>
        f.type === 'sketch' ? { ...f, shown: shownIds.has(f.id) } : f,
      ),
    [part?.features, shownIds],
  );
  const folders = part?.folders;
  const liveFolders = useMemo(() => new Set((folders ?? []).map((f) => f.id)), [folders]);
  const collapsedLive = useMemo(
    () => collapsed.filter((id) => liveFolders.has(id)),
    [collapsed, liveFolders],
  );

  const reorder = useCallback(
    (steps: readonly MoveStep[]): MoveResult => {
      if (!part) return { ok: false, reason: 'No part' };
      const last = steps[steps.length - 1];
      const name = part.features.find((f) => f.id === last?.id)?.name ?? 'feature';
      return reorderFeatures(wb.store, part.id, steps, `Move ${name}`);
    },
    [wb, part],
  );
  const move = useCallback(
    (id: Id, toIndex: number): MoveResult => {
      if (!part) return { ok: false, reason: 'No part' };
      const r = wb.store.apply({ kind: 'moveFeature', partId: part.id, featureId: id, toIndex });
      wb.commit();
      return r.ok ? { ok: true } : { ok: false, reason: r.error };
    },
    [wb, part],
  );

  const featureTree = useMemo<FeatureTreeProps | undefined>(() => {
    if (!part) return undefined;
    return {
      features: items,
      ...(statuses ? { statuses } : {}),
      rollbackIndex: part.rollbackIndex,
      selectedId,
      selectedIds: treeSel,
      onSelectedIdsChange: (ids) => wb.setTreeSelection(ids),
      ...(lineage ? { lineage } : {}),
      onSelect: (id) => wb.selectFeature(id),
      onRename: (id, name) => {
        const f = part.features.find((x) => x.id === id);
        if (f) {
          wb.apply(
            { kind: 'updateFeature', partId: part.id, featureId: id, feature: { ...f, name } },
            `Rename ${f.name}`,
          );
        }
        wb.commit();
      },
      onRollback: (index) => {
        wb.apply({ kind: 'setRollback', partId: part.id, index }, undefined, 'rollback');
        wb.commit();
      },
      onMove: move,
      onReorder: reorder,
      nestSketches,
      onNestSketchesChange: setNestSketches,
      onEdit: (id) => wb.editFeature(id),
      onSuppress: (id, suppressed) => {
        wb.apply({ kind: 'setSuppressed', partId: part.id, featureId: id, suppressed });
        wb.commit();
      },
      onDelete: (id, alsoIds) => {
        // One undo step for the feature and the sketches deleted with it.
        const key = alsoIds?.length ? `delete:${id}` : undefined;
        const name = part.features.find((f) => f.id === id)?.name;
        wb.apply(
          { kind: 'removeFeature', partId: part.id, featureId: id },
          key && name ? `Delete ${name}` : undefined,
          key,
        );
        for (const sketch of alsoIds ?? []) {
          wb.apply({ kind: 'removeFeature', partId: part.id, featureId: sketch }, undefined, key);
        }
        wb.commit();
      },
      folders: folders ?? [],
      collapsedFolders: collapsedLive,
      onCollapsedFoldersChange: (ids) => wb.setCollapsedFolders(ids),
      onAddFolder: (ids) => void wb.addFolder(ids),
      onRenameFolder: (id, name) => wb.renameFolder(id, name),
      onRemoveFolder: (id) => wb.removeFolder(id),
      onMoveFolder: (id, toIndex) => wb.moveFolder(id, toIndex),
      onSuppressMany: (ids, suppressed) => wb.suppressMany(ids, suppressed),
      onUndo: () => wb.undo(),
      onSketchVisibility: (ids, visibility) => wb.setSketchVisibility(ids, visibility),
      density,
    };
  }, [
    wb,
    part,
    items,
    statuses,
    nestSketches,
    setNestSketches,
    density,
    selectedId,
    treeSel,
    lineage,
    move,
    reorder,
    folders,
    collapsedLive,
  ]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const features = part?.features ?? [];
    const selection = wb.folderRunOf(treeSel.length ? treeSel : selectedId ? [selectedId] : []);
    return [
      ...sketchVisibilityCommands(features, (ids, v) => wb.setSketchVisibility(ids, v)),
      ...folderCommands(features, folders ?? [], selection, (ids) => void wb.addFolder(ids)),
    ];
  }, [wb, part?.features, folders, treeSel, selectedId]);

  return { featureTree, commands };
}
