import type { Id } from '@wren-cad/contracts';
import {
  Eye,
  EyeOff,
  FolderInput,
  FolderMinus,
  ListTree,
  Pencil,
  PenLine,
  SkipBack,
  Trash2,
} from 'lucide-react';
import type { MenuItem } from '../components/floating';
import { canFolder, folderRange, type TreeFolder, toggledVisibility } from '../logic/treeFolders';
import { type allowedRollbacks, snapRollback } from '../logic/treeNesting';
import { folderKey } from '../logic/treeRows';
import type { FeatureTreeItem, FeatureTreeProps } from './FeatureTree';
import { suppressMenuItems } from './suppressMenu';

/** What the row and folder menus read from the tree (its props, selection and handlers). */
export interface MenuCtx
  extends Pick<
    FeatureTreeProps,
    | 'onEdit'
    | 'onRename'
    | 'onSuppress'
    | 'configuration'
    | 'onDelete'
    | 'onRollback'
    | 'onAddFolder'
    | 'onRenameFolder'
    | 'onRemoveFolder'
    | 'onSuppressMany'
    | 'onSketchVisibility'
    | 'onNestSketchesChange'
  > {
  features: readonly FeatureTreeItem[];
  folders: readonly TreeFolder[];
  indexOf: ReadonlyMap<Id, number>;
  allowed: ReturnType<typeof allowedRollbacks>;
  nestSketches: boolean;
  effective: readonly Id[];
  setRenaming(key: string): void;
  setPicked(ids: readonly Id[]): void;
  setAnchorId(id: Id): void;
  addFolder(ids: readonly Id[]): void;
  requestDelete(id: Id): boolean;
  isShown(f: FeatureTreeItem): boolean;
  sketchesIn(ids: readonly Id[]): Id[];
  folderIdsFor(ids: readonly Id[]): Id[];
  targetsOf(id: Id): Id[];
  /** Review-only tree: no extras beyond the visibility toggle. */
  review?: boolean;
}

export function folderMenuItems(c: MenuCtx, folder: TreeFolder): MenuItem[] {
  const {
    features,
    indexOf,
    allowed,
    onRollback,
    onRenameFolder,
    onRemoveFolder,
    onSuppressMany,
    onSketchVisibility,
    setRenaming,
    isShown,
    sketchesIn,
  } = c;
  const items: MenuItem[] = [];
  const run = folderRange(features, folder);
  if (onRenameFolder)
    items.push({
      id: 'rename',
      label: 'Rename',
      shortcut: 'F2',
      icon: <Pencil className="size-4" />,
      onSelect: () => setRenaming(folderKey(folder.id)),
    });
  if (onRemoveFolder)
    items.push({
      id: 'ungroup',
      label: 'Ungroup',
      icon: <FolderMinus className="size-4" />,
      onSelect: () => onRemoveFolder(folder.id),
    });
  if (onSuppressMany) {
    const all = folder.features.every((id) => features[indexOf.get(id) ?? -1]?.suppressed);
    items.push({
      id: 'suppress-all',
      label: all ? 'Unsuppress all' : 'Suppress all',
      icon: all ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
      onSelect: () => onSuppressMany(folder.features, !all),
    });
  }
  const sk = sketchesIn(folder.features);
  if (onSketchVisibility && sk.length) {
    const allShown = sk.every((id) => isShown(features[indexOf.get(id) ?? 0] as FeatureTreeItem));
    items.push({
      id: 'folder-sketches',
      label: allShown ? 'Hide sketches' : 'Show sketches',
      icon: allShown ? <EyeOff className="size-4" /> : <Eye className="size-4" />,
      onSelect: () => onSketchVisibility(sk, allShown ? 'hidden' : 'shown'),
    });
  }
  if (onRollback && run)
    items.push({
      id: 'rollto',
      label: 'Roll back to before folder',
      icon: <SkipBack className="size-4" />,
      onSelect: () => onRollback(snapRollback(run.start, allowed, -1)),
    });
  return items;
}

export function menuItems(c: MenuCtx, id: Id, i: number): MenuItem[] {
  const {
    features,
    folders,
    allowed,
    nestSketches,
    effective,
    onEdit,
    onRename,
    onSuppress,
    onDelete,
    onRollback,
    onAddFolder,
    onSketchVisibility,
    onNestSketchesChange,
    setRenaming,
    setPicked,
    setAnchorId,
    addFolder,
    requestDelete,
    isShown,
    folderIdsFor,
    targetsOf,
  } = c;
  const f = features[i];
  if (!f) return [];
  const items: MenuItem[] = [];
  if (onEdit)
    items.push({
      id: 'edit',
      label: 'Edit',
      icon: <PenLine className="size-4" />,
      onSelect: () => onEdit(id),
    });
  if (onRename)
    items.push({
      id: 'rename',
      label: 'Rename',
      shortcut: 'F2',
      icon: <Pencil className="size-4" />,
      onSelect: () => setRenaming(id),
    });
  const scoped = suppressMenuItems(c.configuration, f, !!c.review);
  if (scoped) items.push(...scoped);
  else if (onSuppress)
    items.push({
      id: 'suppress',
      label: f.suppressed ? 'Unsuppress' : 'Suppress',
      icon: f.suppressed ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
      onSelect: () => onSuppress(id, !f.suppressed),
    });
  if (onSketchVisibility && f.type === 'sketch') {
    const shown = isShown(f);
    items.push({
      id: 'viewport',
      label: shown ? 'Hide in viewport' : 'Show in viewport',
      icon: shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />,
      onSelect: () => onSketchVisibility([id], toggledVisibility(shown)),
    });
    if (!c.review && (f.visibility === 'shown' || f.visibility === 'hidden'))
      items.push({
        id: 'viewport-auto',
        label: 'Reset to automatic',
        hint: 'Shown until a feature uses it, then hidden.',
        icon: <Eye className="size-4" />,
        onSelect: () => onSketchVisibility([id], 'auto'),
      });
  }
  if (onRollback)
    items.push({
      id: 'rollto',
      label: 'Roll to here',
      icon: <SkipBack className="size-4 rotate-180" />,
      // A nested sketch rolls to after the feature it sits under.
      onSelect: () => onRollback(snapRollback(i + 1, allowed, 1)),
    });
  if (onAddFolder) {
    const run = folderIdsFor(targetsOf(id));
    const can = canFolder(features, folders, run);
    items.push({
      id: 'add-folder',
      label: 'Add to new folder',
      icon: <FolderInput className="size-4" />,
      separatorBefore: true,
      disabled: !can.ok,
      ...(can.ok ? {} : { hint: can.reason }),
      onSelect: () => addFolder(targetsOf(id)),
    });
    const on = effective.includes(id) && effective.length > 0;
    items.push({
      id: 'select-more',
      label: on ? 'Remove from selection' : 'Add to selection',
      icon: <ListTree className="size-4" />,
      onSelect: () => {
        setPicked(on ? effective.filter((x) => x !== id) : [...effective, id]);
        setAnchorId(id);
      },
    });
  }
  if (onDelete)
    items.push({
      id: 'delete',
      label: 'Delete',
      shortcut: 'Del',
      danger: true,
      separatorBefore: true,
      icon: <Trash2 className="size-4" />,
      onSelect: () => requestDelete(id),
    });
  if (onNestSketchesChange)
    items.push({
      id: 'flat-history',
      label: 'Show sketches in the history',
      checked: !nestSketches,
      separatorBefore: true,
      icon: <ListTree className="size-4" />,
      onSelect: () => onNestSketchesChange(!nestSketches),
    });
  return items;
}
