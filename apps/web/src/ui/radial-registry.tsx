/**
 * Labels and icons for the radial menu's commands (the registry the editor and the layer share).
 * Lazy with the layer and the settings panel.
 */

import {
  type RadialEditorCommand,
  type RadialItem,
  sketchCurveTools,
  sketchTools,
  tools,
} from '@wren-cad/ui';
import {
  CircleMinus,
  FolderInput,
  Maximize,
  Redo2,
  Scissors,
  Undo2,
  Box as ViewIcon,
  X as XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { RADIAL_ADD_FOLDER } from '../app/radial';
import { registryIds } from '../app/radial-config';

const ic = 'size-[18px]';

const EXTRA: Record<string, { label: string; icon: ReactNode }> = {
  [RADIAL_ADD_FOLDER]: {
    label: 'Add to new folder',
    icon: <FolderInput className={ic} aria-hidden />,
  },
  cut: { label: 'Cut', icon: <CircleMinus className={ic} aria-hidden /> },
  section: { label: 'Section', icon: <Scissors className={ic} aria-hidden /> },
  fit: { label: 'Fit view', icon: <Maximize className={ic} aria-hidden /> },
  iso: { label: 'Isometric', icon: <ViewIcon className={ic} aria-hidden /> },
  undo: { label: 'Undo', icon: <Undo2 className={ic} aria-hidden /> },
  redo: { label: 'Redo', icon: <Redo2 className={ic} aria-hidden /> },
  'sketch:finish': { label: 'Finish sketch', icon: <XIcon className={ic} aria-hidden /> },
};

export function itemFor(id: string): RadialItem {
  const extra = EXTRA[id];
  if (extra) return { id, ...extra };
  if (id.startsWith('sketch:')) {
    const tool = id.slice(7);
    const spec = [...sketchTools, ...sketchCurveTools].find((t) => t.id === tool);
    if (spec) return { id, label: spec.label, icon: spec.icon };
  }
  const t = tools.find((x) => x.id === id);
  if (t) return { id, label: t.label, icon: <t.Icon className={ic} aria-hidden /> };
  return { id, label: id };
}

const GROUP_VIEW = new Set(['fit', 'iso', 'undo', 'redo']);

/** Everything a ring may hold in a mode, for the editor's list. */
export function registryCommands(sketch: boolean): RadialEditorCommand[] {
  return registryIds(sketch).map((id) => {
    const it = itemFor(id);
    const group = GROUP_VIEW.has(id) ? 'View and history' : sketch ? 'Sketch' : 'Modeling';
    return { id, label: it.label, group, ...(it.icon ? { icon: it.icon } : {}) };
  });
}
