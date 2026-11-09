/**
 * Document store (PLAN §6). Lead-owned contract, implemented by packages/document.
 *
 * The document is immutable; every change is a `Command` compiled to RFC 6902 JSON patches,
 * recorded with its inverse for undo/redo. Continuous edits (drags, slider scrubs) share a
 * `coalesceKey` and collapse into one undo step.
 */

import type { Expr, Feature, Id, Material, Param, Part, WrenDoc } from './document';

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
  | { kind: 'setRollback'; partId: Id; index: number }
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
