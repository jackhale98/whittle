/** UI state shapes shared by the workbench and the React chrome. */

import type {
  EntityRef,
  Id,
  KernelStatus,
  MeshQuality,
  PickHit,
  RegenResult,
  SketchSolveResult,
  WhittleDoc,
} from '@whittle/contracts';
import type { SketchToolId } from '@whittle/ui';
import type { ModelTool } from '../features/factories';
import type { PlaneFrame } from '../model/frames';
import type { DrawState } from '../sketch/draw';

export interface SelectionItem {
  key: string;
  hit: PickHit;
  /** Persistent reference (sketch picks locally, body picks via `refFor`); null while unknown. */
  ref: EntityRef | null;
}

export interface SketchUi {
  featureId: Id;
  /** Sketch plane; null until known (sketch on a face: from the first regen). */
  frame: PlaneFrame | null;
  tool: SketchToolId | null;
  variants: Partial<Record<SketchToolId, string>>;
  construction: boolean;
  draw: DrawState | null;
  /** Dimension tool picks so far (entity ids) and the cursor in sketch space. */
  dimPicks: Id[];
  cursor: [number, number] | null;
  selected: Id[];
  selectedConstraint: Id | null;
  hoverEntity: Id | null;
  solve: SketchSolveResult | null;
  /** A dimension that was just placed (its label opens in edit mode). */
  editDimension: Id | null;
  /** Conflict cards hovered in the panel. */
  highlightConstraints: readonly Id[] | null;
  conflictsDismissed: boolean;
  /** Whether the sketch existed before this edit session (Finish removes new empty sketches). */
  isNew: boolean;
}

export interface Chooser {
  /** Client (page) coordinates of the press. */
  x: number;
  y: number;
  hits: PickHit[];
  additive: boolean;
}

/** "Which one?" for an ambiguous reference: the engine's candidate names (PLAN §7.3, §9.2). */
export interface CandidateChooser {
  featureId: Id;
  /** JSON pointer of the reference inside the feature, e.g. `/edges/0`. */
  path: string;
  kind: EntityRef['kind'];
  names: string[];
  /** Client (page) coordinates to show it at. */
  x: number;
  y: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface UiState {
  /** The initial document is resolved (library or new). */
  ready: boolean;
  selection: SelectionItem[];
  hover: PickHit | null;
  /** Feature shown in the inspector (tree selection / edit). */
  featureId: Id | null;
  /** Inspector pick field being filled from the viewport. */
  picking: { featureId: Id; path: string } | null;
  /** Act-first tool waiting for a selection. */
  prompt: { tool: ModelTool; text: string } | null;
  chooser: Chooser | null;
  candidates: CandidateChooser | null;
  sketch: SketchUi | null;
  library: boolean;
  /** The welcome card (first launch, ⌘K "Welcome / samples"). */
  welcome: boolean;
  exporting: boolean;
  toast: Toast | null;
  /** The last tool, for Space = repeat last. */
  lastTool: ModelTool | null;
}

export const initialUi: UiState = {
  ready: false,
  selection: [],
  hover: null,
  featureId: null,
  picking: null,
  prompt: null,
  chooser: null,
  candidates: null,
  sketch: null,
  library: false,
  welcome: false,
  exporting: false,
  toast: null,
  lastTool: null,
};

export interface RegenView {
  result: RegenResult;
  quality: MeshQuality;
  doc: WhittleDoc;
  /** `cache`: meshes from the document's `.whittle/` cache, shown before the kernel is ready. */
  source: 'live' | 'cache';
}

export interface EngineState {
  status: KernelStatus;
  /** The regen engine (kernel + ModelingApi) is wired. */
  ready: boolean;
  error: string | null;
}
