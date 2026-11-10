/**
 * Feature tree, folders, visibility and inspector handlers (selection in the tree, folders, suppression, sketch visibility, material, mass summary).
 */

import type { Feature, Id, Material, SketchVisibility } from '@wren-cad/contracts';
import { ulid } from '@wren-cad/document';
import { canFolder, computeNesting, runWithNested } from '@wren-cad/ui';
import { nextFolderName, readCollapsedFolders, writeCollapsedFolders } from '../model/folders';
import type { MassSummaryView, Workbench } from './workbench';

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

export function massSummary(wb: Workbench): MassSummaryView | undefined {
  const bodies = wb.regen.get()?.result.bodies ?? [];
  const props = bodies.flatMap((b) => (b.massProperties ? [b.massProperties] : []));
  if (props.length === 0) return undefined;
  let volume = 0;
  let area = 0;
  let mass = 0;
  let hasMass = false;
  const c: [number, number, number] = [0, 0, 0];
  for (const p of props) {
    volume += p.volume;
    area += p.area;
    if (p.mass !== undefined) {
      mass += p.mass;
      hasMass = true;
    }
    for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (p.centroid[k] as number) * p.volume;
  }
  const centroid: [number, number, number] =
    volume > 0 ? [c[0] / volume, c[1] / volume, c[2] / volume] : [0, 0, 0];
  return { volume, area, centroid, ...(hasMass ? { mass } : {}) };
}
