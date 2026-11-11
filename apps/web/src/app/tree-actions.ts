/**
 * Feature tree, folders, visibility and inspector handlers (selection in the tree, folders, suppression, sketch visibility, material, mass summary).
 */

import type { Feature, Id, Material, SketchVisibility } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';
import { canFolder, computeNesting, runWithNested } from '@wren-cad/ui';
import { nextFolderName, readCollapsedFolders, writeCollapsedFolders } from '../model/folders';
import { type MassSummaryView, summarizeMass } from './config-model';
import type { Workbench } from './workbench';

export function selectFeature(wb: Workbench, id: Id | null): void {
  // A tree click while a mirror / pattern picks its sources adds that feature.
  if (id && wb.pickAccepts()?.features) {
    wb.addSourceFeature(id);
    return;
  }
  wb.patchUi({ featureId: id, picking: null, selection: [], prompt: null });
  if (id === null) wb.restoreSheet();
  wb.refreshSketchVisibility();
  wb.pushHighlights();
}

export function setTreeSelection(wb: Workbench, ids: readonly Id[]): void {
  const cur = wb.treeSelection.get();
  if (cur.length === ids.length && cur.every((x, i) => x === ids[i])) return;
  wb.treeSelection.set(ids);
}

export function syncCollapsed(wb: Workbench): void {
  const id = wb.doc.meta.id ?? '';
  if (id === wb.collapsedFor) return;
  wb.collapsedFor = id;
  wb.collapsedFolders.set(readCollapsedFolders(id));
}

export function setCollapsedFolders(wb: Workbench, ids: readonly Id[]): void {
  wb.collapsedFolders.set(ids);
  writeCollapsedFolders(wb.doc.meta.id ?? '', ids);
}

export function addFolder(wb: Workbench, ids: readonly Id[]): boolean {
  const part = wb.part;
  if (!part) return false;
  const can = canFolder(part.features, part.folders ?? [], ids);
  if (!can.ok) {
    wb.toast(can.reason, 'info');
    return false;
  }
  const ok = wb.apply({
    kind: 'addFolder',
    partId: part.id,
    folder: { id: ulid(), name: nextFolderName(part.folders ?? []), features: [...ids] },
  });
  wb.commit();
  if (ok) wb.setTreeSelection([]);
  return ok;
}

export function folderRunOf(wb: Workbench, ids: readonly Id[]): Id[] {
  const part = wb.part;
  if (!part) return [];
  return runWithNested(part.features, computeNesting(part.features), ids);
}

export function renameFolder(wb: Workbench, folderId: Id, name: string): void {
  const part = wb.part;
  if (!part) return;
  wb.apply({ kind: 'renameFolder', partId: part.id, folderId, name });
  wb.commit();
}

export function removeFolder(wb: Workbench, folderId: Id): void {
  const part = wb.part;
  if (!part) return;
  wb.apply({ kind: 'removeFolder', partId: part.id, folderId });
  wb.commit();
}

export function moveFolder(
  wb: Workbench,
  folderId: Id,
  toIndex: number,
): { ok: true } | { ok: false; reason: string } {
  const part = wb.part;
  if (!part) return { ok: false, reason: 'No part' };
  const r = wb.store.apply({ kind: 'moveFolder', partId: part.id, folderId, toIndex });
  wb.commit();
  return r.ok ? { ok: true } : { ok: false, reason: r.error };
}

export function suppressMany(wb: Workbench, featureIds: readonly Id[], suppressed: boolean): void {
  const part = wb.part;
  if (!part) return;
  wb.apply({
    kind: 'setSuppressedMany',
    partId: part.id,
    featureIds: [...featureIds],
    suppressed,
  });
  wb.commit();
}

export function setSketchVisibility(
  wb: Workbench,
  featureIds: readonly Id[],
  visibility: SketchVisibility,
): void {
  const part = wb.part;
  if (!part || featureIds.length === 0) return;
  wb.apply({
    kind: 'setSketchVisibility',
    partId: part.id,
    featureIds: [...featureIds],
    visibility,
  });
  wb.commit();
}

export function editFeature(wb: Workbench, id: Id): void {
  const f = wb.part?.features.find((x) => x.id === id);
  if (!f) return;
  if (f.type === 'sketch') void wb.enterSketch(f.id, false);
  else wb.selectFeature(id);
}

export function updateFeature(wb: Workbench, feature: Feature, mode: 'commit' | 'preview'): void {
  const part = wb.part;
  if (!part) return;
  const key = `edit:${feature.id}`;
  wb.apply(
    { kind: 'updateFeature', partId: part.id, featureId: feature.id, feature },
    undefined,
    key,
  );
  if (mode === 'commit') wb.commit();
}

export function startPicking(wb: Workbench, featureId: Id, path: string): void {
  wb.patchUi({ picking: { featureId, path }, selection: [] });
  wb.refreshSketchVisibility();
}

export function setMaterial(wb: Workbench, material: Material | null): void {
  const part = wb.part;
  if (part) wb.apply({ kind: 'setMaterial', partId: part.id, material });
  wb.commit();
  wb.syncViewport();
}

export function renameDocument(wb: Workbench, name: string): void {
  const n = name.trim();
  if (!n || n === wb.doc.meta.name) return;
  wb.apply({ kind: 'setDocName', name: n });
  wb.commit();
}

/**
 * Mass properties of the displayed result, only when every live body has them: while some are
 * still being computed (ADR-084) this is undefined and `massPending` is true, so no readout ever
 * shows a partial sum or the previous geometry's values.
 */
export function massSummary(wb: Workbench): MassSummaryView | undefined {
  if (massPending(wb)) return undefined;
  return summarizeMass(wb.regen.get()?.result.bodies ?? []);
}

/** The live result has a body whose mass properties have not arrived yet. */
export function massPending(wb: Workbench): boolean {
  const view = wb.regen.get();
  if (view?.source !== 'live' || view.result.revision === wb.massSettledRevision) return false;
  return view.result.bodies.some((b) => !b.massProperties && b.shape !== 0);
}
