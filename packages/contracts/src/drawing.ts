/**
 * Drawings (PLAN §12 M4, ADR-090). Lead-owned.
 *
 * Units: every sheet quantity (positions, offsets, styles, text heights) is in **sheet
 * millimetres**, independent of view scale. Sheet coordinates: origin at the sheet's bottom-left
 * corner, x right, y up. Projected geometry is in part mm in the view's projection plane.
 */

import type { GpsStandard, RefPoint, SurfaceFinishStandard } from './annotation';
import type { EntityRef, Expr, Id, Vec2, Vec3 } from './document';
import type { KernelError } from './kernel';
import type { ShapeForDrawing } from './modeling';
import type { StandardView } from './viewport';

/** Project-wide drawing defaults (D10): set by the explicit choice at the first drawing. */
export interface DrawingDefaults {
  standard: DrawingStandard;
  projection: Projection;
  /** Title-block text every new drawing starts with (ISO 7200 legal owner, drawn by …). */
  fields?: TitleBlockFields;
}

export type Projection = 'first' | 'third';

/** The drawing's standard family and editions (shown in the title block, used for validation). */
export interface DrawingStandard {
  family: 'iso' | 'asme';
  /** Must belong to `family` (ISO 1101 with iso, ASME Y14.5 with asme). */
  gps: GpsStandard;
  surfaceFinish: SurfaceFinishStandard;
  /** General tolerance note, e.g. `ISO 2768-mK`; absent = none stated. */
  generalTolerance?: string;
}

/**
 * Line group: thick/thin widths in mm. ISO 128 series groups (thick/thin 1:2) and the ASME
 * Y14.2 preset (0.6/0.3). One renderer maps line roles to widths for SVG, PDF and DXF alike.
 */
export type LineGroupId = 'iso-0.25' | 'iso-0.35' | 'iso-0.5' | 'iso-0.7' | 'asme-0.6';

export type ArrowKind = 'filledClosed' | 'open' | 'oblique' | 'dot';

export interface HatchStyle {
  /** Built-in pattern; `iso-general` = thin lines at `angle`. */
  pattern: 'iso-general' | 'iso-metal-cross' | 'solid' | 'none';
  /** Degrees, sheet. */
  angle: number;
  /** Line spacing, sheet mm. */
  spacing: number;
}

/**
 * Every visual quantity of a drawing, in sheet mm, independent of view scale (trap T8): a 1:20
 * view has the same 1.5 mm extension overshoot as a 1:1 view. Created from the standard's preset
 * (ISO defaults = ADR-055: 1 mm gap, 1.5 mm overshoot) and stored in full, so an app update never
 * changes a drawing that is already made; "reset to preset" is an ordinary edit.
 */
export interface DrawingStyle {
  lineGroup: LineGroupId;
  /** Custom widths (mm) replacing the group's. */
  lineWidths?: { thick: number; thin: number };
  /** Text heights, sheet mm (ISO 3098 series: 2.5, 3.5, 5, 7 …). */
  text: { dimension: number; note: number; viewLabel: number; title: number };
  /** Font id from the bundled set (D5), e.g. `osifont`. */
  font: string;
  dimension: {
    extensionGap: number;
    extensionOvershoot: number;
    arrow: { kind: ArrowKind; length: number /** Degrees (included angle). */; angle: number };
    /** Distance from the view's outline to snap lane 0, and between lanes. */
    firstLane: number;
    laneSpacing: number;
    /** ISO: text aligned with the dimension line; ASME: unidirectional (horizontal). */
    textOrientation: 'aligned' | 'unidirectional';
    /** ISO: above the line; ASME: in a break of the line. */
    textPosition: 'above' | 'inline';
  };
  numbers: {
    decimal: '.' | ',';
    /** Decimals for lengths and angles. */
    lengthPrecision: number;
    anglePrecision: number;
    trailingZeros: 'strip' | 'keep';
    angleFormat: 'decimal' | 'dms';
  };
  hatch: HatchStyle;
  /** Display defaults for new base views (dependent views inherit their parent's). */
  view: ViewDisplay;
}

export type IsoSheetSize = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';
export type AnsiSheetSize = 'ANSI-A' | 'ANSI-B' | 'ANSI-C' | 'ANSI-D' | 'ANSI-E';

export interface SheetFormat {
  /** A named size, or a custom size in mm (no frame zones are generated for custom sizes). */
  size: IsoSheetSize | AnsiSheetSize | { width: number; height: number };
  orientation: 'landscape' | 'portrait';
}

/**
 * Title-block slots. Bound slots resolve from data at render time (never stored): title (document
 * name), partNumber / description / material / mass (the drawing's part in its configuration, M3.7
 * D4 fallback for the part number), configuration, scale (the sheet's), projection, units,
 * standard, generalTolerance, revision (from releases, §8A.3: the release being exported, else the
 * latest release marked as having later changes), sheet (`n / m`), date (of the release or the
 * export). Unbound slots (owner, drawnBy, checkedBy, approvedBy, documentType, documentStatus,
 * language) take text from `TitleBlockFields`. Text for a bound slot overrides the binding (badged).
 */
export type TitleBlockSlot =
  | 'title'
  | 'partNumber'
  | 'description'
  | 'material'
  | 'mass'
  | 'configuration'
  | 'scale'
  | 'projection'
  | 'units'
  | 'standard'
  | 'generalTolerance'
  | 'revision'
  | 'sheet'
  | 'date'
  | 'owner'
  | 'drawnBy'
  | 'checkedBy'
  | 'approvedBy'
  | 'documentType'
  | 'documentStatus'
  | 'language';

export type TitleBlockFields = Partial<Record<TitleBlockSlot, string>>;

/**
 * A generated template: `(sheet format, template) → frame, zones, centring and trim marks, title
 * block`. ISO 5457 frame with an ISO 7200 title block, or an ASME Y14.1 sheet (ANSI A–E). Nothing
 * of the frame is stored. `version` pins the generator's layout so an app update never moves a
 * title block on an existing drawing; "re-apply template" moves it to the latest version.
 * Custom (project) templates are P2 (open question in the .md).
 */
export interface TemplateBinding {
  id: 'iso-5457' | 'asme-y14.1';
  version: number;
  fields?: TitleBlockFields;
}

export interface Sheet {
  id: Id;
  name: string;
  format: SheetFormat;
  /** Default scale for views on the sheet and the title block's scale: a unitless ratio `1/2`, `2`. */
  scale: Expr;
  /** Per-sheet title-block text (over the drawing's `template.fields`). */
  fields?: TitleBlockFields;
}

/**
 * A point in a parent view's projection plane (part mm, origin at the projected part origin,
 * x right, y up): free, or following a projected entity (a hole centre). An unresolved ref is
 * needs attention, never a guess.
 */
export type AnchoredPoint =
  | { kind: 'free'; at: Vec2 }
  | { kind: 'ref'; ref: EntityRef; point?: RefPoint; offset?: Vec2 };

/** Base and stand-alone orientations. Named ones use the viewport's standard view directions. */
export type ViewOrientation =
  | { kind: 'named'; name: Exclude<StandardView, 'iso'> }
  /** Isometric from the front view's corner `corner` (towards the viewer). */
  | { kind: 'isometric'; corner: IsoCorner }
  /** View right (`x`) and up (`y`) in part coordinates, orthonormal; the viewer looks along −(x × y). */
  | { kind: 'matrix'; x: Vec3; y: Vec3 };

export type IsoCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface ViewDisplay {
  lines: 'visible' | 'visibleAndHidden';
  tangentEdges: 'visible' | 'thin' | 'off';
  /** Automatic centre marks on circles seen face-on, centre lines on cylinders seen side-on. */
  centerMarks: boolean;
  centerLines: boolean;
  /** Cosmetic threads (thin lines per ISO 6410 / ASME Y14.6). */
  threads: boolean;
}

/** Where a view sits on its sheet. */
export type ViewLayout =
  /** Centre of the view (see the .md: projected 3D bounding box) at a sheet position, sheet mm. */
  | { kind: 'free'; position: Vec2 }
  /**
   * Locked to the parent: on the projection axis, `distance` sheet mm centre to centre. The side
   * follows the drawing's projection, so switching first/third moves the view with no edit.
   */
  | { kind: 'aligned'; distance: number };

interface ViewBase {
  id: Id;
  sheetId: Id;
  kind: string;
  /** Label override; absent = derived (`SECTION A–A`, `DETAIL B (2:1)`, none for base). */
  label?: string;
  showLabel?: boolean;
  /**
   * Unitless ratio `1/2`, `2`. Absent: base and iso views use the sheet's scale; projected and
   * section views their parent's. Detail views must set it.
   */
  scale?: Expr;
  /** Absent fields inherit (parent, or `style.view` for base views). */
  display?: Partial<ViewDisplay>;
  /**
   * Configuration override (badged in the UI): absent = the drawing's; `null` = Default; an id =
   * that configuration. A missing id is needs attention (never a fall-back, trap T13).
   */
  configurationId?: Id | null;
}

export interface BaseView extends ViewBase {
  kind: 'base';
  orientation: ViewOrientation;
  /** In-plane rotation, an angle `Expr` (CCW). Children re-derive from it. */
  rotation?: Expr;
  layout: { kind: 'free'; position: Vec2 };
}

/** Orthographic projection of the parent, seen from one of its sides. */
export interface ProjectedView extends ViewBase {
  kind: 'projected';
  parentId: Id;
  /** The side of the parent the viewer looks from (`top` = top view of the parent). */
  from: 'top' | 'bottom' | 'left' | 'right';
  layout: ViewLayout;
}

/** Isometric view derived from a parent (rotating the parent re-derives it). */
export interface IsoView extends ViewBase {
  kind: 'iso';
  parentId: Id;
  corner: IsoCorner;
  layout: { kind: 'free'; position: Vec2 };
}

/**
 * Section through the parent along an editable cut line: ≥ 2 points in the parent's projection
 * plane; each segment is a cutting plane perpendicular to the parent view (2 points = full, more =
 * offset/stepped; a half section is an L-shaped line). `look`: the viewer looks towards the left
 * or right side of the line's direction (first → last point); arrows show it.
 */
export interface SectionView extends ViewBase {
  kind: 'section';
  parentId: Id;
  letter: string;
  cut: AnchoredPoint[];
  look: 'left' | 'right';
  /** `full`: everything behind the cut; `slice`: the cut faces only. */
  depth?: 'full' | 'slice';
  /** Over the drawing's hatch style. */
  hatch?: Partial<HatchStyle>;
  layout: ViewLayout;
}

/** Enlarged detail of a circle on the parent. `radius` in part mm (stable under scale changes). */
export interface DetailView extends ViewBase {
  kind: 'detail';
  parentId: Id;
  letter: string;
  center: AnchoredPoint;
  radius: number;
  scale: Expr;
  layout: { kind: 'free'; position: Vec2 };
}

export type DrawingView = BaseView | ProjectedView | IsoView | SectionView | DetailView;
export type DrawingViewKind = DrawingView['kind'];

/** Where a leader starts. */
export type LeaderAttach =
  /** On the annotation's `refs[index]` as projected; `t` ∈ [0, 1] along it (absent = auto). */
  | { kind: 'ref'; index: number; t?: number }
  /** Next to another placement's text (a frame under its size dimension). */
  | { kind: 'placement'; placementId: Id }
  /** On another placement's dimension line at `t` (a datum on a feature-of-size dimension). */
  | { kind: 'dimensionLine'; placementId: Id; t: number };

/**
 * Placement intent, relative to the referenced geometry, in sheet mm (trap T8: never absolute).
 * After a model change every placement keeps its lane or offset.
 */
export type PlacementLayout =
  /** Linear/ordinate along a view axis: snap lane `lane` (0 = nearest) outside the view's outline. */
  | { kind: 'lane'; side: 'top' | 'bottom' | 'left' | 'right'; lane: number }
  /** Signed offset of the dimension line from the measured geometry (sign = side). */
  | { kind: 'offset'; distance: number }
  /** Radius/diameter: leader at `angle` (degrees, CCW from sheet +x), text `distance` beyond the curve (negative = inside). */
  | { kind: 'radial'; angle: number; distance: number }
  /** Angle: arc at `radius` from the vertex; `opposite` draws it in the vertical sector (same value). */
  | { kind: 'arc'; radius: number; opposite?: boolean }
  /** Notes, frames, datums, surface finish, hole and chamfer callouts. `bends` and `text` relative to the attach point. */
  | {
      kind: 'leader';
      attach: LeaderAttach;
      bends?: Vec2[];
      text: Vec2;
      landing?: 'auto' | 'left' | 'right';
    };

/**
 * How one view shows one annotation. The drawing stores this, never a copy of the annotation.
 * At most one placement per (view, annotation); the import never places an annotation twice in a
 * drawing (a second placement is allowed by hand and listed as a duplicate).
 */
export interface AnnotationPlacement {
  id: Id;
  viewId: Id;
  annotationId: Id;
  layout: PlacementLayout;
  /** Text shift along the dimension line from its auto-centred position, sheet mm (ADR-055 rules). */
  text?: { shift?: number };
  /** Witness (extension) lines: mirror to the other end; hide one or both. */
  witness?: { flip?: boolean; hide?: [boolean, boolean] };
  arrows?: 'auto' | 'inside' | 'outside';
}

/** Manually added centre marks and lines (automatic ones come from `ViewDisplay`). */
export interface CenterMark {
  id: Id;
  viewId: Id;
  kind: 'centerMark' | 'centerLine' | 'boltCircle';
  /** Circles / cylinders (mark, bolt circle) or two edges (centre line between them). */
  refs: EntityRef[];
}

export type TableAnchor = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

interface TableBase {
  id: Id;
  sheetId: Id;
  kind: string;
  /** The `anchor` corner's sheet position, sheet mm. */
  position: Vec2;
  anchor: TableAnchor;
}

export type PartPropertyColumn =
  | 'partNumber'
  | 'description'
  | 'material'
  | 'mass'
  | 'configuration';

/**
 * Part properties table (owner D3): one row for the drawing's configuration, or one row per listed
 * configuration (`null` = Default) for tabulated drawings. Values come from the resolved
 * configuration (mass from its background build, ADR-079); never stored. BOM: M6.
 */
export interface PartPropertiesTable extends TableBase {
  kind: 'partProperties';
  columns: PartPropertyColumn[];
  rows: { kind: 'drawing' } | { kind: 'configurations'; configurations: (Id | null)[] };
  massUnit?: 'g' | 'kg';
}

/**
 * Hole table on demand: one row per hole instance of the listed hole features (or all) as seen in
 * `viewId`, X/Y from `origin`, size from the feature's callout. Tags (A1, A2 …) are derived in a
 * deterministic order and drawn at each hole in the view.
 */
export interface DrawingHoleTable extends TableBase {
  kind: 'holeTable';
  viewId: Id;
  origin: AnchoredPoint;
  holes: 'all' | Id[];
}

export type DrawingTable = PartPropertiesTable | DrawingHoleTable;

/** Free text on a sheet (general notes). `{slot}` tokens resolve like title-block slots. */
export interface SheetNote {
  id: Id;
  sheetId: Id;
  /** Top-left of the text box, sheet mm. */
  position: Vec2;
  text: string;
  /** Sheet mm; absent = `style.text.note`. */
  height?: number;
  /** Wrap width, sheet mm; absent = no wrap. */
  width?: number;
}

/**
 * Review markup (D8, recommended): local-first, in the project, pinned to the version it was drawn
 * on. Never exported or released; merges as an append-mostly set.
 */
export interface Markup {
  id: Id;
  sheetId: Id;
  /** `Version.id` the reviewer was looking at. */
  versionId: string;
  author: string;
  /** ISO-8601. */
  at: string;
  /** Pencil/finger strokes, sheet mm. */
  strokes: { points: Vec2[]; width: number }[];
  text?: string;
  /** What it is about, when it was drawn on something (survives revisions). */
  anchor?: { placementId?: Id; viewId?: Id };
  resolved?: boolean;
}

/** M4 drawings show one part; M6 adds `{ kind: 'assembly' }`. */
export type DrawingSubject = { kind: 'part'; partId: Id };

/**
 * A drawing (one file, `drawings/<slug>.drawing.json`). Flat, id-keyed collections reference their
 * sheet or view by id, so moving a view between sheets or a placement between views is one leaf
 * edit for the merge. Order carries meaning only for `sheets` (sheet numbering); every other
 * collection is kept sorted by id. No derived data: HLR output, resolved values, the frame and
 * title block and table rows are computed and cached in `.wren/` (PLAN §8A.1).
 */
export interface Drawing {
  id: Id;
  name: string;
  subject: DrawingSubject;
  /** The drawing's configuration, inherited by views, tables and title block; absent = Default. */
  configurationId?: Id;
  standard: DrawingStandard;
  /** Explicit (trap T4), never implied by the sheet size or the standard. */
  projection: Projection;
  /** Fixed in M4. */
  units: 'mm';
  style: DrawingStyle;
  template: TemplateBinding;
  sheets: Sheet[];
  views: DrawingView[];
  placements: AnnotationPlacement[];
  centerMarks: CenterMark[];
  tables: DrawingTable[];
  notes: SheetNote[];
  markup?: Markup[];
}

// Drawing worker (HLR) — derived, never stored

/** 2D curves in a view's projection plane, part mm (origin = projected part origin, y up). */
export type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** Angles in radians, CCW; a full circle is 0 → 2π. */
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number }
  | { kind: 'ellipse'; center: Vec2; major: Vec2; ratio: number; start: number; end: number }
  | { kind: 'bspline'; degree: number; poles: Vec2[]; knots: number[]; weights?: number[] }
  /** Draft (PolyAlgo) output and anything without an exact 2D form. */
  | { kind: 'polyline'; points: Vec2[] };

export type LineRole = 'visible' | 'hidden';
/** `sharp` edges, `smooth` (tangent) edges, `outline` (silhouettes of curved faces), `sewn` seams. */
export type EdgeClass = 'sharp' | 'smooth' | 'outline' | 'sewn';

export interface ProjectedCurve {
  role: LineRole;
  edge: EdgeClass;
  /** Persistent name of the model edge, when there is one (outlines have none). Picks map to EntityRefs. */
  name?: string;
  curve: Curve2;
}

/**
 * Drawing worker request (HLR). `draft` = HLRBRep_PolyAlgo on the tessellation, fast, shown first;
 * `exact` = HLRBRep_Algo, used for export and once idle. Runs in a worker, never on the main
 * thread (trap T12).
 */
export interface ViewProjectionRequest {
  /** A shape loaded with `loadShape` (`ShapeForDrawing.key`). */
  shapeKey: string;
  /** View right / up in part coordinates (resolved from orientation, rotation and the parent chain). */
  frame: { x: Vec3; y: Vec3 };
  quality: 'draft' | 'exact';
  hidden: boolean;
  smooth: boolean;
  /**
   * Section views: the cut line in part coordinates (on the parent's projection plane), swept
   * along the parent's view direction `along` into the cutting surface; material on the viewer's
   * side (`look` = the section view's viewing direction) is removed. `slice`: cut faces only.
   */
  section?: { cut: Vec3[]; along: Vec3; look: Vec3; depth: 'full' | 'slice' };
  /** Detail views: the clip circle in the view plane (part mm). */
  clip?: { center: Vec2; radius: number };
}

export interface ViewProjection {
  /** Cache key: shape key plus every request field (results cached under `.wren/`). */
  key: string;
  curves: ProjectedCurve[];
  /**
   * Section views: closed loops of each cut face, for hatching. `face` is a synthetic id
   * (`section:<segment>#<k>`), not a persistent name: cut faces have no model face.
   */
  sectionFaces?: { face: string; loops: Curve2[][] }[];
  /** Projection of the part's 3D bounding box: the view's centre for layout (see the .md). */
  bounds: { min: Vec2; max: Vec2 };
  ms: number;
}

/** The drawing worker's Comlink surface (its own trimmed HLR Wasm build). */
export interface DrawingKernelApi {
  /** Idempotent per key; the worker keeps an LRU of shapes. */
  loadShape(shape: ShapeForDrawing): Promise<{ ok: true } | { ok: false; error: KernelError }>;
  hasShape(key: string): Promise<boolean>;
  project(
    request: ViewProjectionRequest,
  ): Promise<{ ok: true; value: ViewProjection } | { ok: false; error: KernelError }>;
}
