// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Document store (implements `DocumentStore`).
 *
 * - The document is immutable; `getDoc()` returns a stable reference until the next change.
 * - `apply` compiles a `Command` to patches (`commands.ts`), applies them with structural sharing
 *   and records the inverse for undo/redo.
 * - Edits sharing a `coalesceKey` merge into one history entry while the group is open: it stays
 *   open until `commit()`, any other apply/undo/redo/load, or `coalesceWindowMs` of inactivity.
 */

import type {
  ApplyOptions,
  ApplyResult,
  Command,
  DocumentStore,
  HistoryEntry,
  JsonPatchOp,
  WhittleDoc,
} from '@whittle/contracts';
import { compileCommand } from './commands';
import { newDoc } from './factory';
import { type Migration, migrateDoc } from './migrations';
import { applyPatch, PatchError } from './patch';

export interface StoreOptions {
  /** Milliseconds clock (injectable for tests). */
  clock?: () => number;
  /** Idle time after which a coalescing group closes by itself. Default 1000 ms. */
  coalesceWindowMs?: number;
  /** Undo depth. Default 500. */
  maxHistory?: number;
  /** Keep `meta.modified` current on every change. Default true. */
  trackModified?: boolean;
  migrations?: readonly Migration[];
}

interface Entry {
  label: string;
  at: string;
  patches: JsonPatchOp[];
  inverse: JsonPatchOp[];
  coalesceKey?: string;
  lastTime: number;
  open: boolean;
}

type Listener = (doc: WhittleDoc, change: { patches: JsonPatchOp[] }) => void;

/** Merges two consecutive entries' ops; collapses pure `replace` runs so drags stay O(1). */
function mergeOps(
  aP: JsonPatchOp[],
  bP: JsonPatchOp[],
  aI: JsonPatchOp[],
  bI: JsonPatchOp[],
): { patches: JsonPatchOp[]; inverse: JsonPatchOp[] } {
  const all = [...aP, ...bP, ...aI, ...bI];
  if (all.every((o) => o.op === 'replace')) {
    const fwd = new Map<string, JsonPatchOp>();
    for (const o of [...aP, ...bP]) if (o.op === 'replace') fwd.set(o.path, o);
    const back = new Map<string, JsonPatchOp>();
    // Inverse restores the state before `a`: earliest recorded old value wins.
    for (const o of [...bI, ...aI]) if (o.op === 'replace') back.set(o.path, o);
    return { patches: [...fwd.values()], inverse: [...back.values()] };
  }
  return { patches: [...aP, ...bP], inverse: [...bI, ...aI] };
}

export class DocumentStoreImpl implements DocumentStore {
  private doc: WhittleDoc;
  private past: Entry[] = [];
  private future: Entry[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly clock: () => number;
  private readonly coalesceMs: number;
  private readonly maxHistory: number;
  private readonly trackModified: boolean;
  private readonly migrations?: readonly Migration[];

  constructor(initial: WhittleDoc = newDoc(), options: StoreOptions = {}) {
    this.doc = initial;
    this.clock = options.clock ?? Date.now;
    this.coalesceMs = options.coalesceWindowMs ?? 1000;
    this.maxHistory = options.maxHistory ?? 500;
    this.trackModified = options.trackModified ?? true;
    this.migrations = options.migrations;
  }

  getDoc(): WhittleDoc {
    return this.doc;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(patches: JsonPatchOp[]): void {
    for (const l of [...this.listeners]) {
      try {
        l(this.doc, { patches });
      } catch (e) {
        // A faulty subscriber must not break the store; surface the error asynchronously.
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  private closeGroup(): void {
    const top = this.past[this.past.length - 1];
    if (top) top.open = false;
  }

  apply(command: Command, options: ApplyOptions = {}): ApplyResult {
    const compiled = compileCommand(this.doc, command);
    if (!compiled.ok) return { ok: false, error: compiled.error };
    if (compiled.ops.length === 0) return { ok: true, doc: this.doc };

    const now = this.clock();
    const ops = compiled.ops.slice();
    if (this.trackModified && !ops.some((o) => 'path' in o && o.path === '/meta/modified')) {
      ops.push({ op: 'replace', path: '/meta/modified', value: new Date(now).toISOString() });
    }
    let result: ReturnType<typeof applyPatch<WhittleDoc>>;
    try {
      result = applyPatch(this.doc, ops);
    } catch (e) {
      if (e instanceof PatchError)
        return { ok: false, error: `That edit could not be applied: ${e.message}` };
      throw e;
    }

    const key = options.coalesceKey;
    const top = this.past[this.past.length - 1];
    const at = new Date(now).toISOString();
    if (
      key !== undefined &&
      top?.open &&
      top.coalesceKey === key &&
      now - top.lastTime <= this.coalesceMs
    ) {
      const merged = mergeOps(top.patches, ops, top.inverse, result.inverse);
      top.patches = merged.patches;
      top.inverse = merged.inverse;
      top.lastTime = now;
      top.at = at;
      if (options.label !== undefined) top.label = options.label;
    } else {
      this.closeGroup();
      const entry: Entry = {
        label: options.label ?? compiled.label,
        at,
        patches: ops,
        inverse: result.inverse,
        lastTime: now,
        open: key !== undefined,
      };
      if (key !== undefined) entry.coalesceKey = key;
      this.past.push(entry);
      if (this.past.length > this.maxHistory) this.past.shift();
    }
    this.future = [];
    this.doc = result.doc;
    this.notify(ops);
    return { ok: true, doc: this.doc };
  }

  commit(): void {
    this.closeGroup();
  }

  undo(): boolean {
    this.closeGroup();
    const entry = this.past[this.past.length - 1];
    if (!entry) return false;
    let next: WhittleDoc;
    try {
      next = applyPatch(this.doc, entry.inverse).doc;
    } catch {
      return false;
    }
    this.past.pop();
    this.future.push(entry);
    this.doc = next;
    this.notify(entry.inverse);
    return true;
  }

  redo(): boolean {
    this.closeGroup();
    const entry = this.future[this.future.length - 1];
    if (!entry) return false;
    let next: WhittleDoc;
    try {
      next = applyPatch(this.doc, entry.patches).doc;
    } catch {
      return false;
    }
    this.future.pop();
    entry.open = false;
    this.past.push(entry);
    this.doc = next;
    this.notify(entry.patches);
    return true;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** `past`: oldest → newest. `future`: the next redo first. */
  history(): { past: HistoryEntry[]; future: HistoryEntry[] } {
    const pub = (e: Entry): HistoryEntry => ({ label: e.label, at: e.at });
    return { past: this.past.map(pub), future: this.future.slice().reverse().map(pub) };
  }

  load(raw: unknown): ApplyResult {
    const r = migrateDoc(raw, this.migrations ? { migrations: this.migrations } : {});
    if (!r.ok) return { ok: false, error: r.error };
    this.doc = r.doc;
    this.past = [];
    this.future = [];
    this.notify([{ op: 'replace', path: '', value: r.doc }]);
    return { ok: true, doc: this.doc };
  }
}

export function createDocumentStore(
  initial?: WhittleDoc,
  options?: StoreOptions,
): DocumentStoreImpl {
  return new DocumentStoreImpl(initial, options);
}
