/**
 * Feature-tree edits that touch several features at once (ADR-015): a feature moves with its
 * nested sketches, and a delete can take the nested sketches with it. Each is one undo step and
 * all or nothing. They use the ordinary `moveFeature` / `removeFeature` commands, so the
 * document's own rules (a feature cannot move above geometry it uses) still apply.
 */

import type { ApplyOptions, ApplyResult, Command, Id, WrenDoc } from '@wren-cad/contracts';
import { DocumentStoreImpl } from '@wren-cad/document';

/** The part of the document store these edits need. */
export interface EditStore {
  getDoc(): WrenDoc;
  apply(command: Command, options?: ApplyOptions): ApplyResult;
  commit(): void;
}

export type EditResult = { ok: true } | { ok: false; reason: string };

export interface ReorderStep {
  id: Id;
  toIndex: number;
}

/**
 * Applies `steps` (in order) as one undo entry named `label`. A refusal anywhere, found by a dry
 * run on a scratch copy, leaves the document and its history untouched.
 */
export function reorderFeatures(
  store: EditStore,
  partId: Id,
  steps: readonly ReorderStep[],
  label: string,
): EditResult {
  const cmds = steps.map(
    (s): Command => ({ kind: 'moveFeature', partId, featureId: s.id, toIndex: s.toIndex }),
  );
  const scratch = new DocumentStoreImpl(store.getDoc());
  for (const c of cmds) {
    const r = scratch.apply(c);
    if (!r.ok) return { ok: false, reason: r.error };
  }
  const coalesceKey = `reorder:${partId}`;
  for (const c of cmds) store.apply(c, { coalesceKey, label });
  store.commit();
  return { ok: true };
}
