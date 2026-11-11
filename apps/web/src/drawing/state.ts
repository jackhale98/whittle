/** UI state of the drawing route (kept outside the document: none of it is saved or undoable). */

import type { Id, Vec2 } from '@wren-cad/contracts';
import type { ImportPlan } from '@wren-cad/drawing';
import type { Built } from './pipeline';

export type DrawingTool =
  | 'select'
  | 'section'
  | 'detail'
  | 'dimension'
  | 'datum'
  | 'gdt'
  | 'finish'
  | 'note'
  | 'reattach';

export type DrawingPanel = 'inspector' | 'views' | 'import' | 'attention' | 'sheet' | 'export';

export type Selected =
  | { kind: 'view'; id: Id }
  | { kind: 'placement'; id: Id }
  | { kind: 'note'; id: Id }
  | { kind: 'cell'; slot: string }
  | null;

/** The first-drawing choice (D10) is made inline on the route, before any drawing exists. */
export type RoutePhase = 'choose' | 'drawing' | 'missing';

/** A dimension tool pick: an edge on a view, with what the kernel's curve says it is. */
export interface EdgePick {
  viewId: Id;
  name: string;
  shape: 'line' | 'circle' | 'other';
  /** Sheet position of the pick. */
  at: Vec2;
  /** The curve in the view plane (part mm): a line's ends, or a circle's centre and radius. */
  geom?: { a: Vec2; b: Vec2 } | { centre: Vec2; radius: number; full: boolean };
}

export interface ToolHint {
  /** The prompt chip text. */
  text: string;
  /** Picks so far, drawn as accents. */
  picks: EdgePick[];
}

/** A tool's rubber band while it is dragged, in sheet mm. */
export type Ghost =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; at: Vec2; r: number }
  | { kind: 'rect'; min: Vec2; max: Vec2 }
  | null;

export interface ReattachState {
  annotationId: Id;
  /** The new refs picked so far; completes at `needed`. */
  picked: EdgePick[];
  needed: number;
}

export interface DrawingUiState {
  phase: RoutePhase;
  drawingId: Id | null;
  sheetId: Id | null;
  tool: DrawingTool;
  selected: Selected;
  panel: DrawingPanel;
  /** The last successful build (kept while a newer one is pending). */
  built: Built | null;
  /** The model changed and its regen has not arrived: values are shown dimmed, never as current. */
  pending: boolean;
  error: string | null;
  hint: ToolHint | null;
  ghost: Ghost;
  hover: string | null;
  importPlan: ImportPlan | null;
  importChecked: ReadonlySet<string>;
  reattach: ReattachState | null;
  /** Placement ids to flash after an import. */
  fresh: readonly Id[];
  toast: { id: number; text: string; tone: 'info' | 'error' } | null;
  exporting: string | null;
  /** Title block slot being edited inline. */
  editingCell: string | null;
  kernel: 'placeholder' | 'hlr';
}

export const initialDrawingUi: DrawingUiState = {
  phase: 'drawing',
  drawingId: null,
  sheetId: null,
  tool: 'select',
  selected: null,
  panel: 'inspector',
  built: null,
  pending: false,
  error: null,
  hint: null,
  ghost: null,
  hover: null,
  importPlan: null,
  importChecked: new Set(),
  reattach: null,
  fresh: [],
  toast: null,
  exporting: null,
  editingCell: null,
  kernel: 'placeholder',
};
