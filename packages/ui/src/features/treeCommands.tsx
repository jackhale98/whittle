import type { Id } from '@wren-cad/contracts';
import { Eye, EyeOff, FolderInput, RotateCcw } from 'lucide-react';
import type { PaletteCommand } from '../components/CommandPalette';
import { canFolder, type SketchVisibilityMode, type TreeFolder } from '../logic/treeFolders';

/** Palette command ids for the feature tree (M3.6). */
export const TREE_COMMAND_IDS = {
  showAllSketches: 'tree.sketches.showAll',
  hideAllSketches: 'tree.sketches.hideAll',
  resetSketchVisibility: 'tree.sketches.resetVisibility',
  addToFolder: 'tree.folder.addSelection',
} as const;

/**
 * "Show all sketches", "Hide all sketches" and "Reset sketch visibility" for the ⌘K palette (pass
 * them in the shell's `commands`). Each calls `onSketchVisibility` once with every sketch id, which
 * the app turns into one `setSketchVisibility` (one undo entry).
 */
export function sketchVisibilityCommands(
  features: readonly { id: Id; type: string }[],
  onSketchVisibility: (ids: readonly Id[], visibility: SketchVisibilityMode) => void,
): PaletteCommand[] {
  const ids = features.filter((f) => f.type === 'sketch').map((f) => f.id);
  const none = ids.length === 0;
  const mk = (
    id: string,
    label: string,
    icon: PaletteCommand['icon'],
    visibility: SketchVisibilityMode,
  ): PaletteCommand => ({
    id,
    label,
    icon,
    disabled: none,
    ...(none ? { hint: 'No sketches' } : {}),
    run: () => onSketchVisibility(ids, visibility),
  });
  return [
    mk(TREE_COMMAND_IDS.showAllSketches, 'Show all sketches', <Eye className="size-4" />, 'shown'),
    mk(
      TREE_COMMAND_IDS.hideAllSketches,
      'Hide all sketches',
      <EyeOff className="size-4" />,
      'hidden',
    ),
    mk(
      TREE_COMMAND_IDS.resetSketchVisibility,
      'Reset sketch visibility',
      <RotateCcw className="size-4" />,
      'auto',
    ),
  ];
}

/** "Add selection to new folder" for the palette; disabled (with the reason) when it cannot work. */
export function folderCommands(
  features: readonly { id: Id; name?: string }[],
  folders: readonly TreeFolder[],
  selection: readonly Id[],
  onAddFolder: (ids: readonly Id[]) => void,
): PaletteCommand[] {
  const can = canFolder(features, folders, selection);
  return [
    {
      id: TREE_COMMAND_IDS.addToFolder,
      label: 'Add selection to new folder',
      icon: <FolderInput className="size-4" />,
      disabled: !can.ok,
      ...(can.ok ? {} : { hint: can.reason }),
      run: () => onAddFolder(selection),
    },
  ];
}
