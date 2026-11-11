/**
 * Reference geometry subscription (ADR-093): which planes, axes and points the viewport draws and
 * picks (`model/references.ts`), the tree's eye set, and the origin planes and axes (a per-device
 * toggle, also shown while the sketch plane chooser is open).
 */

import type { Id, TouchViewport } from '@wren-cad/contracts';
import type { ViewportReference } from '@wren-cad/viewport';
import { originShown, viewportReferences } from '../model/references';
import type { Workbench } from './workbench';

/** The viewport engine's reference methods (the contract's `TouchViewport` predates ADR-093). */
export type ReferenceViewport = TouchViewport & {
  setReferences?(refs: readonly ViewportReference[]): void;
  setOriginReferences?(show: boolean): void;
};

export function syncReferences(wb: Workbench): void {
  const view = wb.regen.get();
  const { refs, shown } = viewportReferences(view?.result, wb.part?.features ?? []);
  const prev = wb.shownReferenceIds.get();
  if (prev.size !== shown.size || [...shown].some((id: Id) => !prev.has(id))) {
    wb.shownReferenceIds.set(shown);
  }
  const v = wb.viewport as ReferenceViewport | null;
  if (!v) return;
  const key = JSON.stringify(refs);
  if (key !== wb.referenceKey) {
    wb.referenceKey = key;
    v.setReferences?.(refs);
  }
  // The origin planes and axes show while the sketch plane chooser is open. (Not while a field
  // picks a plane or axis: they would sit in front of the faces that field also accepts, and the
  // chips already offer them.)
  const origin = originShown(wb.originPlanes.get(), wb.ui.get().prompt?.tool === 'sketch');
  if (origin !== wb.originApplied) {
    wb.originApplied = origin;
    v.setOriginReferences?.(origin);
  }
}
