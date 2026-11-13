/** UI state shapes shared by the workbench and the React chrome. */

import type {
  EntityRef,
  Id,
  KernelStatus,
  Measurement,
  MeshQuality,
  PickHit,
  RegenResult,
  SketchSolveResult,
  Vec2,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import type { SheetSnap, SheetTabId, SketchEditToolId, SketchToolId } from '@wren-cad/ui';
import type { FeatureTool, ModelTool } from '../features/factories';
import type { SectionAxis } from '../model/faces';
import type { PlaneFrame } from '../model/frames';
import type { MeasurePick } from '../model/measure';
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
  /** Solved geometry for the values in force when it differs from the stored sketch (display only). */
  shown: import('../sketch/shown').ShownSketch | null;
  /** A dimension that was just placed (its label opens in edit mode). */
  editDimension: Id | null;
  /** Conflict cards hovered in the panel. */
  highlightConstraints: readonly Id[] | null;
  /** A dimension label being dragged: its live position (sketch mm). Committed on release. */
  dimDrag: { id: Id; at: Vec2 } | null;
  /** The geometry of the hovered conflict card (`SketchConflict.entities`). */
  highlightEntities: readonly Id[] | null;
  conflictsDismissed: boolean;
  /** Whether the sketch existed before this edit session (Finish removes new empty sketches). */
  isNew: boolean;
  /** A Pencil stroke in progress: its samples (sketch mm) and what it is recognised as so far. */
  stroke: StrokeUi | null;
  /** The last Pencil stroke's recognised shape (tests, the status line). */
  lastStroke: { shape: string; confidence: number } | null;
  /** An Edit-menu tool in progress (offset, convert, trim/extend, corner, mirror); null otherwise. */
  edit: SketchEditUi | null;
}

/** A model edge or face picked for Convert Entities (or a Re-pick of a lost source). */
export interface ConvertPick {
  bodyId: string;
  kind: 'edge' | 'face';
  index: number;
  point: Vec3;
  ref: EntityRef | null;
}

/**
 * State of the sketch Edit-menu tools (M3, ADR-033…035, ADR-038). Each tool's panel is controlled
 * from here; Apply runs the `@wren-cad/sketch/edit` operation as one undo step.
 */
export interface SketchEditUi {
  tool: SketchEditToolId;
  /** Offset chain / mirror entities (curve ids), or fillet / chamfer corners (point ids). */
  picks: Id[];
  /** Offset distance, fillet radius or chamfer distance (an expression). */
  value: string;
  side: 'left' | 'right';
  both: boolean;
  corner: 'fillet' | 'chamfer';
  trim: 'trim' | 'extend';
  /** Mirror: which pick the next click answers, and the mirror line. */
  phase: 'entities' | 'axis';
  axis: Id | null;
  /** Convert: model edges or one face's outline, and what was picked. */
  source: 'edges' | 'face';
  model: ConvertPick[];
  /** Re-pick of a lost linked source: its stored reference name. */
  relink: string | null;
  busy: boolean;
}

export interface StrokeUi {
  points: Vec2[];
  /** Recognised shape kind so far (`line`, `rectangle`, `circle`, ...), null while unsure. */
  shape: string | null;
  confidence: number;
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

/** Push/pull on planar faces of one body (PLAN §9.2), from tool start to release / typed value. */
export interface PushPullUi {
  bodyId: string;
  faces: Array<{ index: number; normal: Vec3; ref: EntityRef | null }>;
  /** Arrow base at distance 0 (mm) and its direction (the first face's normal). */
  origin: Vec3;
  normal: Vec3;
  /** Current distance (mm) and its expression (a typed value keeps its text, e.g. `2 * t`). */
  distance: number;
  expr: string;
  dragging: boolean;
}

/** Measure (desktop/tablet Inspect tool, phone Measure tab). */
export interface MeasureUi {
  /** Viewport picks go to measure (tool on / phone tab open). */
  active: boolean;
  picks: MeasurePick[];
  /** The result for `picks` (null while measuring or after an error). */
  current: Measurement | null;
  /** Every result this session, oldest first (the panel's history). */
  results: Measurement[];
  busy: boolean;
  error: string | null;
}

export interface SectionUi {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
  /** Tilts (radians) about the base plane's two in-plane axes; the base is the axis or face. */
  tiltU: number;
  tiltV: number;
  face: { origin: Vec3; normal: Vec3; label: string } | null;
  /** The next viewport pick sets the face. */
  picking: boolean;
  /** The section panel is shown (desktop/tablet inspector). */
  open: boolean;
}

/** A context bubble opened by long-press: where (mm), and view actions on empty space. */
export interface BubbleRequest {
  at: Vec3 | null;
  /** Client px for an empty-space press (no world point). */
  screen: { x: number; y: number } | null;
  view: boolean;
}

/** A radial menu request (right click, long-press, held key): where it opens and how. */
export interface RadialRequest {
  /** Client px. */
  x: number;
  y: number;
  source: 'mouse' | 'pen' | 'touch' | 'keyboard';
  /** The opening pointer is still down (touch / pen long-press): drag to an item and lift. */
  held?: boolean;
  pointerId?: number;
  /** `KeyboardEvent.code` of a held opening key. */
  holdCode?: string;
}

/** The rubber band of a box selection (canvas px) and what it will select. */
export interface BoxSelect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mode: 'window' | 'crossing';
}

/** Settings surface (a panel, never a dialog): which tab is showing. */
export type SettingsTab = 'navigation' | 'keyboard' | 'radial' | 'motion';

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
  /** M2.5 project panel (versions, connections, compare, merge); null when closed. */
  project: 'versions' | 'connections' | null;
  /** The welcome card (first launch, ⌘K "Welcome / samples"). */
  welcome: boolean;
  exporting: boolean;
  toast: Toast | null;
  /** The last tool, for Space = repeat last. */
  lastTool: ModelTool | FeatureTool | null;
  pushPull: PushPullUi | null;
  measure: MeasureUi | null;
  section: SectionUi;
  /** The right inspector panel on desktop and tablet (controlled; ADR-099). Desktop starts open, tablet closed. */
  inspectorOpen: boolean;
  /** Phone bottom sheet (controlled). */
  sheetSnap: SheetSnap;
  sheetTab: SheetTabId | null;
  bubble: BubbleRequest | null;
  /** Selection key whose context bubble was closed by choosing an action: it stays closed until the selection changes. */
  bubbleDismissed: string | null;
  /** M3.5: the radial menu, the box-select rubber band, the settings panel. */
  radial: RadialRequest | null;
  box: BoxSelect | null;
  settings: SettingsTab | null;
  /** M4: the drawing route is open (`id` null = a new drawing of the part). */
  drawing: { id: Id | null } | null;
}

export const initialSection: SectionUi = {
  enabled: false,
  axis: 'z',
  offset: 0,
  flipped: false,
  tiltU: 0,
  tiltV: 0,
  face: null,
  picking: false,
  open: false,
};

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
  project: null,
  welcome: false,
  exporting: false,
  toast: null,
  lastTool: null,
  pushPull: null,
  measure: null,
  section: initialSection,
  inspectorOpen: false,
  sheetSnap: 'peek',
  sheetTab: null,
  bubble: null,
  bubbleDismissed: null,
  radial: null,
  box: null,
  settings: null,
  drawing: null,
};

export interface RegenView {
  result: RegenResult;
  quality: MeshQuality;
  doc: WrenDoc;
  /** `cache`: meshes from the document's `.wren/` cache, shown before the kernel is ready. */
  source: 'live' | 'cache';
}

export interface EngineState {
  status: KernelStatus;
  /** The regen engine (kernel + ModelingApi) is wired. */
  ready: boolean;
  error: string | null;
}
