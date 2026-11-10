/**
 * Document store (PLAN §6). Lead-owned contract, implemented by packages/document.
 *
 * The document is immutable; every change is a `Command` compiled to RFC 6902 JSON patches,
 * recorded with its inverse for undo/redo. Continuous edits (drags, slider scrubs) share a
 * `coalesceKey` and collapse into one undo step.
 */

import type {
  Expr,
  Feature,
  FeatureFolder,
  Id,
  Material,
  Param,
  Part,
  SketchVisibility,
  WrenDoc,
} from './document';

export type JsonPointer = string;

export type JsonPatchOp =
  | { op: 'add'; path: JsonPointer; value: unknown }
  | { op: 'remove'; path: JsonPointer }
  | { op: 'replace'; path: JsonPointer; value: unknown }
  | { op: 'move'; from: JsonPointer; path: JsonPointer }
  | { op: 'copy'; from: JsonPointer; path: JsonPointer }
  | { op: 'test'; path: JsonPointer; value: unknown };

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
  /** `'auto'` restores the consumed-sketch default. Non-sketch ids are ignored. */
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
  | { kind: 'addParam'; param: Param }
  | { kind: 'updateParam'; paramId: Id; name?: string; expr?: Expr; description?: string }
  | { kind: 'removeParam'; paramId: Id }
  | { kind: 'setDocName'; name: string }
  | { kind: 'patch'; ops: JsonPatchOp[] };

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
