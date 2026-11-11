/**
 * Document store (PLAN §6). Lead-owned contract, implemented by packages/document.
 *
 * The document is immutable; every change is a `Command` compiled to RFC 6902 JSON patches,
 * recorded with its inverse for undo/redo. Continuous edits (drags, slider scrubs) share a
 * `coalesceKey` and collapse into one undo step.
 */

import type { Annotation, RefPoint } from './annotation';
import type {
  Configuration,
  ConfiguredValue,
  EntityRef,
  Expr,
  Feature,
  FeatureFolder,
  Id,
  Material,
  Param,
  Part,
  PartProperties,
  SketchVisibility,
  WrenDoc,
} from './document';
import type {
  AnnotationPlacement,
  CenterMark,
  Drawing,
  DrawingDefaults,
  DrawingStandard,
  DrawingStyle,
  DrawingSubject,
  DrawingTable,
  DrawingView,
  Markup,
  Projection,
  Sheet,
  SheetFormat,
  SheetNote,
  TemplateBinding,
  TitleBlockSlot,
} from './drawing';

export type JsonPointer = string;

export type JsonPatchOp =
  | { op: 'add'; path: JsonPointer; value: unknown }
  | { op: 'remove'; path: JsonPointer }
  | { op: 'replace'; path: JsonPointer; value: unknown }
  | { op: 'move'; from: JsonPointer; path: JsonPointer }
  | { op: 'copy'; from: JsonPointer; path: JsonPointer }
  | { op: 'test'; path: JsonPointer; value: unknown };

/** What a configuration override applies to (M3.7). */
export type ConfigTarget =
  | { kind: 'param'; paramId: Id }
  | { kind: 'field'; featureId: Id; path: string }
  | { kind: 'suppressed'; featureId: Id }
  | { kind: 'material' }
  | { kind: 'color' }
  | { kind: 'property'; key: keyof PartProperties }
  /** M4: an annotation's `Expr` or option field (`AnnotationOverride.fields`). */
  | { kind: 'annotationField'; annotationId: Id; path: JsonPointer }
  | { kind: 'annotationSuppressed'; annotationId: Id };

/** High-level, intention-revealing edits. The store compiles them to patches. */
export type Command =
  | { kind: 'addPart'; part: Part }
  | { kind: 'renamePart'; partId: Id; name: string }
  | { kind: 'setMaterial'; partId: Id; material: Material | null }
  | { kind: 'addFeature'; partId: Id; feature: Feature; index?: number }
  | { kind: 'updateFeature'; partId: Id; featureId: Id; feature: Feature }
  | { kind: 'removeFeature'; partId: Id; featureId: Id }
  | { kind: 'moveFeature'; partId: Id; featureId: Id; toIndex: number }
  | { kind: 'setSuppressed'; partId: Id; featureId: Id; suppressed: boolean }
  /** Several features at once, one undo entry (a folder's "Suppress all"). */
  | { kind: 'setSuppressedMany'; partId: Id; featureIds: Id[]; suppressed: boolean }
  | { kind: 'setRollback'; partId: Id; index: number }
  /**
   * Sketches and reference geometry (plane, axis, point features; ADR-093). `'auto'` restores the
   * default: consumed sketches hidden, reference geometry shown. Other ids are ignored.
   */
  | {
      kind: 'setSketchVisibility';
      partId: Id;
      featureIds: Id[];
      visibility: SketchVisibility;
    }
  /**
   * Feature tree folders (M3.6, ADR-066). `features` must be a contiguous run that no other folder
   * holds; otherwise the command fails (nothing changes). Folder membership follows edits:
   * - removing a feature drops it from its folder; a folder left empty is removed;
   * - `moveFeature` of a member to outside its run takes it out of the folder;
   * - `moveFeature` / `addFeature` of a non-member strictly inside a run (between two members)
   *   adds it; landing just before the first or after the last member does not.
   * So a run can never be split by an edit.
   */
  | { kind: 'addFolder'; partId: Id; folder: FeatureFolder }
  | { kind: 'renameFolder'; partId: Id; folderId: Id; name: string }
  /** Ungroup: the folder goes, its features stay where they are. */
  | { kind: 'removeFolder'; partId: Id; folderId: Id }
  /**
   * Move the whole run. `toIndex` is the position of its first member in `features` with the run
   * taken out (0 = top of the tree). Fails if that lands inside another folder's run.
   */
  | { kind: 'moveFolder'; partId: Id; folderId: Id; toIndex: number }
  /**
   * M3.7 configurations (ADR-074). `from`: start as a copy of Default (no overrides, the default)
   * or of another configuration's overrides (owner D3: the UI offers Default / Active). The new
   * configuration does not become active by itself.
   */
  | { kind: 'addConfiguration'; partId: Id; configuration: Configuration; from?: 'default' | Id }
  | { kind: 'renameConfiguration'; partId: Id; configurationId: Id; name: string }
  /** Removing the active configuration makes Default active. */
  | { kind: 'removeConfiguration'; partId: Id; configurationId: Id }
  /** `null` = Default. Not an edit of the design: undoable, but merges as a plain field. */
  | { kind: 'setActiveConfiguration'; partId: Id; configurationId: Id | null }
  /**
   * Set or clear (`value` absent) overrides, several at once in one undo entry (a table paste).
   * Editing Default is an ordinary command (`updateParam`, `updateFeature`, `setSuppressed`,
   * `setMaterial`, `setPartProperties`) and so applies to every configuration that inherits.
   */
  | {
      kind: 'setConfigurationOverrides';
      partId: Id;
      edits: {
        configurationId: Id;
        target: ConfigTarget;
        value?: ConfiguredValue | Material | null;
      }[];
    }
  | { kind: 'setPartProperties'; partId: Id; properties: PartProperties }
  | { kind: 'addParam'; param: Param }
  | { kind: 'updateParam'; paramId: Id; name?: string; expr?: Expr; description?: string }
  | { kind: 'removeParam'; paramId: Id }
  | { kind: 'setDocName'; name: string }
  | { kind: 'patch'; ops: JsonPatchOp[] }
  | AnnotationCommand
  | DrawingCommand;

/** Fields `updateDrawing` may set; absent = unchanged. `configurationId: null` = Default. */
export interface DrawingChanges {
  name?: string;
  subject?: DrawingSubject;
  configurationId?: Id | null;
  standard?: DrawingStandard;
  projection?: Projection;
  style?: DrawingStyle;
}

export type AnnotationCommand =
  /**
   * Adds a part annotation; with `place`, also its placement in a view (a dimension drawn on a
   * drawing: one step).
   */
  | {
      kind: 'addAnnotation';
      partId: Id;
      annotation: Annotation;
      place?: { drawingId: Id; placement: AnnotationPlacement };
    }
  /** Whole replacement, like `updateFeature`. Refuses to change `id`. */
  | { kind: 'updateAnnotation'; partId: Id; annotationId: Id; annotation: Annotation }
  /**
   * Removes the annotations, their placements in every drawing and their configuration overrides.
   * Frames bound to a removed datum keep its letter as `{ label }`, and `appliesTo` pointing at a
   * removed dimension stays: both then show as needs attention, never a silent rebinding.
   */
  | { kind: 'removeAnnotation'; partId: Id; annotationIds: Id[] }
  /** User-confirmed reattach (works for every kind). Clears nothing else. */
  | {
      kind: 'reattachAnnotation';
      partId: Id;
      annotationId: Id;
      refs: EntityRef[];
      at?: RefPoint[];
    };

export type DrawingCommand =
  /** D10: the explicit project choice (also offered again from drawing settings). */
  | { kind: 'setDrawingDefaults'; defaults: DrawingDefaults }
  | { kind: 'addDrawing'; drawing: Drawing; index?: number }
  | { kind: 'updateDrawing'; drawingId: Id; changes: DrawingChanges }
  /**
   * `annotations`: `'removeOwn'` (default) also removes annotations whose origin is this drawing
   * and that no other drawing places; `'keep'` leaves them in the part.
   */
  | { kind: 'removeDrawing'; drawingId: Id; annotations?: 'removeOwn' | 'keep' }
  | { kind: 'moveDrawing'; drawingId: Id; toIndex: number }
  /**
   * "Duplicate drawing for configuration": a copy with `ids` mapping every sheet, view, placement,
   * centre mark, table and note id of the source to a fresh ULID (the store fails if one is missing
   * or taken). Annotations are shared, not copied. Markup is not copied.
   */
  | {
      kind: 'duplicateDrawing';
      drawingId: Id;
      newDrawingId: Id;
      name: string;
      configurationId: Id | null;
      ids: Record<Id, Id>;
    }
  /**
   * Re-apply (or switch) the template: sets `template.id` and `version`, optionally sheet formats.
   * Views, placements, tables and notes are kept; title-block text for slots the template doesn't
   * have is kept and listed as unused.
   */
  | {
      kind: 'applyTemplate';
      drawingId: Id;
      template: { id: TemplateBinding['id']; version: number };
      formats?: { sheetId: Id; format: SheetFormat }[];
    }
  /** Title-block text on the drawing (`sheetId` absent) or one sheet; `null` clears a slot. */
  | {
      kind: 'setTitleBlockFields';
      drawingId: Id;
      sheetId?: Id;
      fields: Partial<Record<TitleBlockSlot, string | null>>;
    }
  | { kind: 'addSheet'; drawingId: Id; sheet: Sheet; index?: number }
  | { kind: 'updateSheet'; drawingId: Id; sheet: Sheet }
  /** Also removes the sheet's views (with their placements and marks), tables, notes and markup. */
  | { kind: 'removeSheet'; drawingId: Id; sheetId: Id }
  | { kind: 'moveSheet'; drawingId: Id; sheetId: Id; toIndex: number }
  | { kind: 'addView'; drawingId: Id; view: DrawingView }
  /** Whole replacement (move, scale, display, cut-line edit, re-orient). Drags share a coalesceKey. */
  | { kind: 'updateView'; drawingId: Id; view: DrawingView }
  /**
   * Removes views with their placements and marks. `dependents`: `'remove'` (default) removes the
   * views derived from them too; `'detach'` turns direct children into base views with the same
   * resolved orientation and position.
   */
  | { kind: 'removeViews'; drawingId: Id; viewIds: Id[]; dependents?: 'remove' | 'detach' }
  /**
   * Import model annotations (and the dimension tool's batch paths): places existing annotations
   * and creates promoted ones (`annotation` set) in one step. Refuses an item whose annotation is
   * already placed in this drawing unless `allowDuplicate`.
   */
  | {
      kind: 'placeAnnotations';
      drawingId: Id;
      items: { placement: AnnotationPlacement; annotation?: Annotation }[];
      allowDuplicate?: boolean;
    }
  | { kind: 'updatePlacements'; drawingId: Id; placements: AnnotationPlacement[] }
  /** Hides annotations from views; the part annotations stay. */
  | { kind: 'removePlacements'; drawingId: Id; placementIds: Id[] }
  | { kind: 'addCenterMark'; drawingId: Id; mark: CenterMark }
  | { kind: 'removeCenterMarks'; drawingId: Id; markIds: Id[] }
  | { kind: 'addTable'; drawingId: Id; table: DrawingTable }
  | { kind: 'updateTable'; drawingId: Id; table: DrawingTable }
  | { kind: 'removeTable'; drawingId: Id; tableId: Id }
  | { kind: 'addSheetNote'; drawingId: Id; note: SheetNote }
  | { kind: 'updateSheetNote'; drawingId: Id; note: SheetNote }
  | { kind: 'removeSheetNote'; drawingId: Id; noteId: Id }
  | { kind: 'addMarkup'; drawingId: Id; markup: Markup }
  | { kind: 'setMarkupResolved'; drawingId: Id; markupId: Id; resolved: boolean }
  | { kind: 'removeMarkup'; drawingId: Id; markupId: Id };

export interface ApplyOptions {
  /** Human label for the undo history, e.g. "Edit Fillet 2 radius". */
  label?: string;
  /** Consecutive applies with the same key within the coalesce window merge into one entry. */
  coalesceKey?: string;
}

export interface HistoryEntry {
  label: string;
  /** ISO timestamp of the last merged change. */
  at: string;
}

export type ApplyResult = { ok: true; doc: WrenDoc } | { ok: false; error: string };

export interface DocumentStore {
  getDoc(): WrenDoc;
  /** Listener runs after every change (apply/undo/redo/load). */
  subscribe(listener: (doc: WrenDoc, change: { patches: JsonPatchOp[] }) => void): () => void;
  apply(command: Command, options?: ApplyOptions): ApplyResult;
  /** Ends the current coalescing group (call on pointerup / blur). */
  commit(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  history(): { past: HistoryEntry[]; future: HistoryEntry[] };
  /** Replaces the document (open file); clears history. Runs schema migrations. */
  load(doc: unknown): ApplyResult;
}
