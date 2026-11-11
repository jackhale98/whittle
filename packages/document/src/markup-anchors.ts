// SPDX-License-Identifier: GPL-3.0-or-later
import type { Drawing, Id, JsonPatchOp } from '@wren-cad/contracts';
import { diff } from './patch';

/**
 * Ops that clear markup anchors pointing at removed placements or views (the markup stays; an
 * anchor is only a hint to what it was about). Markup on `skipSheetIds` is going away anyway.
 */
export function markupAnchorOps(
  drawing: Drawing,
  drawingPath: string,
  gone: { placementIds?: ReadonlySet<Id>; viewIds?: ReadonlySet<Id> },
  skipSheetIds: ReadonlySet<Id> = new Set(),
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  (drawing.markup ?? []).forEach((m, k) => {
    if (!m.anchor || skipSheetIds.has(m.sheetId)) return;
    const keep: NonNullable<typeof m.anchor> = {};
    if (m.anchor.placementId !== undefined && !gone.placementIds?.has(m.anchor.placementId)) {
      keep.placementId = m.anchor.placementId;
    }
    if (m.anchor.viewId !== undefined && !gone.viewIds?.has(m.anchor.viewId)) {
      keep.viewId = m.anchor.viewId;
    }
    if (keep.placementId === m.anchor.placementId && keep.viewId === m.anchor.viewId) return;
    const base = `${drawingPath}/markup/${k}/anchor`;
    if (Object.keys(keep).length === 0) ops.push({ op: 'remove', path: base });
    else ops.push(...diff(m.anchor, keep, base));
  });
  return ops;
}
