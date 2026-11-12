/**
 * Dragging a view onto a sheet tab moves it to that sheet (ADR-094). This wraps whatever drag a
 * press on the sheet started without changing it: while a selected view is being moved, the
 * pointer is checked against the sheet tabs (they sit outside the viewer, which keeps the
 * pointer captured); released over another sheet's tab, the move is cancelled (the view goes back
 * where it was, nothing in history) and `moveViewToSheet` moves it there in one undo step.
 */

import { viewOutline } from '@wren-cad/drawing';
import type { SheetDrag, SheetPointer } from '@wren-cad/ui/drawing';
import type { DrawingController } from './controller';
import { moveViewToSheet } from './ops-sheets';

/** The sheet tab under a viewer-relative point, if any (and not the current sheet's). */
function tabAt(c: DrawingController, px: { x: number; y: number }): string | null {
  const viewer = document.querySelector<HTMLElement>('[data-testid="sheet-viewer"]');
  if (!viewer || typeof document.elementFromPoint !== 'function') return null;
  const r = viewer.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + px.x, r.top + px.y);
  const tab = el?.closest<HTMLElement>('[data-sheet-tab]');
  const id = tab?.dataset.sheetTab ?? null;
  return id && id !== c.sheet()?.id ? id : null;
}

/** `drag` (what `beginInteraction` returned for `p`), able to drop a moved view on a tab. */
export function withSheetDrop(
  c: DrawingController,
  p: SheetPointer,
  drag: SheetDrag | null,
): SheetDrag | null {
  const sel = c.ui.get().selected;
  if (!drag || sel?.kind !== 'view' || c.ui.get().tool !== 'select') return drag;
  // Only a press inside the selected view moves it (its handles sit outside its outline).
  const sv = c.built()?.build.views.get(sel.id);
  if (!sv?.ok) return drag;
  const o = viewOutline(sv);
  const inside =
    p.at[0] >= o.min[0] && p.at[0] <= o.max[0] && p.at[1] >= o.min[1] && p.at[1] <= o.max[1];
  if (!inside) return drag;
  const viewId = sel.id;
  const setDrop = (id: string | null) => {
    if (c.ui.get().dropSheet !== id) c.patch({ dropSheet: id });
  };
  return {
    move(q) {
      setDrop(tabAt(c, q.px));
      drag.move?.(q);
    },
    up(q, moved) {
      const target = moved ? tabAt(c, q.px) : null;
      setDrop(null);
      if (!target) {
        drag.up?.(q, moved);
        return;
      }
      drag.cancel?.();
      moveViewToSheet(c, viewId, target);
    },
    cancel() {
      setDrop(null);
      drag.cancel?.();
    },
  };
}
