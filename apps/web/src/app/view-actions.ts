/**
 * Sheet, section view, selection labels, adding features and cancel: the workbench's view-level actions.
 */

import type { Feature, PickHit } from '@wren-cad/contracts';
import type { SheetSnap, SheetTabId } from '@wren-cad/ui';
import { newBox, newCylinder, newPlane } from '../features/factories';
import {
  sectionRange as faceSectionRange,
  type SectionSettings,
  sectionPlane,
  unionBounds,
} from '../model/faces';
import type { SectionUi } from './state';
import type { Workbench } from './workbench';

export function setSheet(wb: Workbench, patch: { snap?: SheetSnap; tab?: SheetTabId }): void {
  const u = wb.ui.get();
  if (patch.snap === 'full' || (patch.snap === 'peek' && u.sheetSnap !== 'peek'))
    wb.sheetOpenedForUser = false; // the user moved it: it is theirs now
  const tab = patch.tab ?? u.sheetTab;
  wb.patchUi({ sheetSnap: patch.snap ?? u.sheetSnap, sheetTab: tab });
  // The phone's Measure tab is the measure tool: open = picking, closed = done.
  if (wb.tier === 'phone' && patch.tab !== undefined && patch.tab !== u.sheetTab) {
    if (patch.tab === 'measure') {
      if (!u.measure?.active) void wb.track(wb.measure.start([]));
    } else if (u.sheetTab === 'measure') wb.measure.stop();
  }
}

export function openSheet(wb: Workbench, tab: SheetTabId, auto = false): void {
  const snap = wb.ui.get().sheetSnap;
  // Opened for the user (a new feature, a measurement): Done puts it back.
  if (auto && snap === 'peek') wb.sheetOpenedForUser = true;
  wb.setSheet({ tab, snap: snap === 'peek' ? 'half' : snap });
}

export function restoreSheet(wb: Workbench): void {
  if (!wb.sheetOpenedForUser) return;
  wb.sheetOpenedForUser = false;
  if (wb.ui.get().sheetSnap === 'half') wb.setSheet({ snap: 'peek' });
}

export function setSection(wb: Workbench, patch: Partial<SectionUi>): void {
  const cur = wb.ui.get().section;
  const next: SectionUi = { ...cur, ...patch };
  const restart =
    (patch.axis !== undefined && patch.axis !== cur.axis) ||
    patch.face !== undefined ||
    (patch.enabled === true && !cur.enabled);
  if (restart) {
    // A new axis, face or a fresh enable starts level (no tilt) unless the caller says otherwise.
    if (patch.tiltU === undefined) next.tiltU = 0;
    if (patch.tiltV === undefined) next.tiltV = 0;
  }
  if (restart && patch.offset === undefined) {
    const r = faceSectionRange(next, wb.bounds());
    // A face plane starts halfway into the part (behind the face), an axis mid-part.
    next.offset = next.axis === 'face' ? (r.min + Math.min(r.max, 0)) / 2 : (r.min + r.max) / 2;
  }
  wb.patchUi({ section: next });
  wb.syncSection();
}

export function openSection(wb: Workbench): void {
  wb.patchUi({ section: { ...wb.ui.get().section, open: true }, featureId: null });
  // auto: closing the panel (Edit, Esc, Exit) puts the sheet back, so it no longer covers the view.
  if (wb.tier !== 'desktop') wb.openSheet(wb.tier === 'phone' ? 'section' : 'inspector', true);
}

/** Closes the panel only; a running cut stays on, with its chip in the viewport. */
export function closeSection(wb: Workbench): void {
  wb.patchUi({ section: { ...wb.ui.get().section, open: false, picking: false } });
  wb.restoreSheet();
}

/** Ends the section: the cut goes away and so do the chip, the panel and the manipulator. */
export function exitSection(wb: Workbench): void {
  if (!wb.ui.get().section.enabled && !wb.ui.get().section.open) return;
  wb.setSection({ enabled: false, open: false, picking: false });
  wb.restoreSheet();
}

export function flipSection(wb: Workbench): void {
  wb.setSection({ flipped: !wb.ui.get().section.flipped });
}

export function sectionRange(wb: Workbench): { min: number; max: number } {
  return faceSectionRange(wb.sectionSettings(), wb.bounds());
}

export function sectionSettings(wb: Workbench): SectionSettings {
  const s = wb.ui.get().section;
  return {
    enabled: s.enabled,
    axis: s.axis,
    offset: s.offset,
    flipped: s.flipped,
    face: s.face,
    tiltU: s.tiltU,
    tiltV: s.tiltV,
  };
}

export function bounds(wb: Workbench) {
  return unionBounds((wb.regen.get()?.result.bodies ?? []).map((b) => b.mesh.bbox));
}

export function syncSection(wb: Workbench): void {
  const v = wb.viewport;
  if (!v) return;
  const plane = sectionPlane(wb.sectionSettings(), wb.bounds());
  wb.sectionTool.sync();
  const key = JSON.stringify(plane);
  if (key === wb.lastSection) return;
  wb.lastSection = key;
  v.setSection(plane);
}

export function sectionFromFace(wb: Workbench, hit: PickHit): void {
  const f = hit.kind === 'face' ? wb.face(hit.bodyId, hit.index) : null;
  if (!f) return;
  if (!f.planar) {
    wb.toast('Pick a flat face for the section plane.', 'info');
    return;
  }
  const label = wb.selectionLabel(hit) ?? 'Face';
  wb.setSection({
    enabled: true,
    axis: 'face',
    face: { origin: f.centroid, normal: f.normal, label },
    picking: false,
  });
}

export function selectionLabel(wb: Workbench, hit: PickHit): string | null {
  const mesh = wb.regen.get()?.result.bodies.find((b) => b.id === hit.bodyId)?.mesh;
  const name =
    hit.kind === 'face'
      ? mesh?.faceNames[hit.index]
      : hit.kind === 'edge'
        ? mesh?.edgeNames[hit.index]
        : undefined;
  const noun = hit.kind[0]?.toUpperCase() + hit.kind.slice(1);
  const owner = name ? wb.part?.features.findLast((f) => name.includes(f.id)) : undefined;
  return owner ? `${noun} of ${owner.name}` : noun;
}

export function addFeature(wb: Workbench, feature: Feature, pickPath?: string): void {
  const part = wb.part;
  if (!part) return;
  if (!wb.apply({ kind: 'addFeature', partId: part.id, feature })) return;
  wb.commit();
  wb.patchUi({
    featureId: feature.id,
    picking: pickPath ? { featureId: feature.id, path: pickPath } : null,
    selection: [],
    prompt: null,
  });
  // Tablet: the new feature's values are in the sheet's inspector (PLAN §9.1).
  if (wb.tier === 'tablet') wb.openSheet('inspector', true);
  wb.refreshSketchVisibility();
  wb.pushHighlights();
}

export function addPrimitive(wb: Workbench, shape: 'box' | 'cylinder'): void {
  const part = wb.part;
  if (!part) return;
  wb.addFeature(shape === 'box' ? newBox(part) : newCylinder(part));
}

export function addPlane(wb: Workbench): void {
  const part = wb.part;
  if (!part) return;
  wb.addFeature(newPlane(part, { name: 'origin:XY', kind: 'face' }), '/definition/from');
}

export function addBoolean(wb: Workbench): void {
  const part = wb.part;
  const bodies = wb.regen.get()?.result.bodies ?? [];
  if (!part) return;
  if (bodies.length < 2) {
    wb.toast('A boolean needs at least two bodies.', 'info');
    return;
  }
  const [target, ...tools] = bodies.map((b) => ({ name: b.id, kind: 'body' as const }));
  if (!target) return;
  void import('../features/factories').then(({ newBoolean }) =>
    wb.addFeature(newBoolean(part, target, tools)),
  );
}

export function cancel(wb: Workbench): boolean {
  const u = wb.ui.get();
  if (u.radial) wb.patchUi({ radial: null });
  else if (u.settings) wb.patchUi({ settings: null });
  else if (u.chooser) wb.patchUi({ chooser: null, hover: null });
  else if (u.bubble) wb.patchUi({ bubble: null });
  else if (u.pushPull) wb.pushPull.cancel();
  else if (u.section.picking) wb.setSection({ picking: false });
  else if (u.measure?.active) wb.measure.stop();
  else if (u.picking) wb.patchUi({ picking: null });
  else if (u.prompt) wb.patchUi({ prompt: null });
  else if (u.selection.length) wb.clearSelection();
  else if (u.featureId) {
    wb.patchUi({ featureId: null });
    wb.restoreSheet();
  } else if (u.section.open) wb.closeSection();
  else if (u.library) wb.patchUi({ library: false });
  else if (u.project) wb.openProjectPanel(null);
  else if (u.welcome) wb.patchUi({ welcome: false });
  else if (u.section.enabled && !u.sketch) wb.exitSection();
  else return false;
  wb.refreshSketchVisibility();
  wb.pushHighlights();
  return true;
}
