/**
 * Tool and prompt state: running a tool, feature tools and their pick sequences, cutting and the bubble actions.
 */

import type { EntityRef, Feature, SketchFeature } from '@wren-cad/contracts';
import type { ToolId } from '@wren-cad/ui';
import {
  defaultAxisFor,
  FEATURE_PICKS,
  type FeatureTool,
  isFeatureTool,
  isModelTool,
  newChamfer,
  newCut,
  newExtrude,
  newExtrudeCut,
  newFeatureFor,
  newFillet,
  newRevolve,
  newRevolveCut,
  TOOL_NEEDS,
} from '../features/factories';
import { acceptsFor, applyPick } from '../selection/pick';
import type { BubbleActionId } from './gestures';
import type { Workbench } from './workbench';
import { emptyField } from './workbench-util';

export async function runTool(wb: Workbench, tool: ToolId): Promise<void> {
  if (wb.ui.get().sketch) return;
  const part = wb.part;
  if (!part) return;
  if (tool === 'section') {
    if (wb.ui.get().section.open) wb.closeSection();
    else wb.openSection();
    return;
  }
  if (tool === 'measure') {
    if (wb.ui.get().measure?.active) wb.measure.stop();
    else await wb.measure.start(wb.ui.get().selection.map((s) => s.hit));
    return;
  }
  if (isFeatureTool(tool)) return wb.startFeatureTool(tool);
  if (!isModelTool(tool)) return;
  const u = wb.ui.get();
  if (u.welcome) wb.patchUi({ welcome: false });
  if (u.measure?.active) wb.measure.stop();
  const need = TOOL_NEEDS[tool];
  const picked = u.selection.filter((s) => need.kinds.includes(s.hit.kind));
  if (tool === 'pushPull' && picked.length > 0 && picked.length === u.selection.length) {
    // Select first: the arrow appears on the selected face(s).
    if (wb.pushPull.start(picked.map((s) => s.hit))) {
      wb.patchUi({ prompt: null, lastTool: tool, featureId: null, picking: null });
      return;
    }
  }
  if (picked.length === 0 || picked.length !== u.selection.length || tool === 'pushPull') {
    // Act first, select second.
    wb.pushPull.cancel();
    wb.patchUi({
      prompt: { tool, text: need.prompt },
      selection: [],
      featureId: null,
      picking: null,
      lastTool: tool,
    });
    wb.refreshSketchVisibility();
    wb.pushHighlights();
    return;
  }
  const refs: EntityRef[] = [];
  let missing = 0;
  for (const s of picked) {
    // A pick held back by "Export all" is asked again once the hold is over.
    let ref = s.ref ?? (await wb.refFor(s.hit));
    if (!ref && wb.config.exportingAll) {
      await wb.config.whenReleased();
      ref = await wb.refFor(s.hit);
    }
    if (ref) refs.push(ref);
    else missing++;
  }
  // Never drop part of a selection silently: either every item is referenced or nothing is made.
  if (missing > 0) {
    return wb.toast(
      refs.length === 0
        ? 'That selection can’t be referenced yet.'
        : `${missing} of ${picked.length} selected items can’t be referenced yet, so nothing was created. Select again.`,
      'info',
    );
  }
  wb.patchUi({ prompt: null, selection: [], lastTool: tool });
  const bodies = wb.regen.get()?.result.bodies.length ?? 0;
  let feature: Feature;
  switch (tool) {
    case 'sketch':
      return wb.startSketch(refs[0] as EntityRef);
    case 'extrude':
      feature = newExtrude(part, refs, bodies);
      break;
    case 'extrudeCut':
      feature = newExtrudeCut(part, refs);
      break;
    case 'revolve':
    case 'revolveCut': {
      const sk = part.features.find(
        (f): f is SketchFeature =>
          f.type === 'sketch' && (refs[0]?.name ?? '').startsWith(`S${f.id}:`),
      );
      feature =
        tool === 'revolve'
          ? newRevolve(part, refs, defaultAxisFor(sk), bodies)
          : newRevolveCut(part, refs, defaultAxisFor(sk));
      break;
    }
    case 'fillet':
      feature = newFillet(part, refs);
      break;
    case 'chamfer':
      feature = newChamfer(part, refs);
      break;
  }
  wb.addFeature(feature, need.path);
}

export async function startFeatureTool(wb: Workbench, tool: FeatureTool): Promise<void> {
  const part = wb.part;
  if (!part) return;
  const u = wb.ui.get();
  if (u.welcome) wb.patchUi({ welcome: false });
  if (u.measure?.active) wb.measure.stop();
  wb.pushPull.cancel();
  const copies = tool === 'mirror' || tool === 'linearPattern' || tool === 'circularPattern';
  const selected = u.featureId ? part.features.find((f) => f.id === u.featureId) : undefined;
  const sources = copies && selected && selected.type !== 'sketch' ? [selected.id] : [];
  let feature = newFeatureFor(tool, part, {
    bodyCount: wb.regen.get()?.result.bodies.length ?? 0,
    sources,
  });
  const steps = FEATURE_PICKS[tool];
  const first = steps[0];
  if (first && u.selection.length > 0) {
    const accepts = acceptsFor(first.path, feature);
    if (!accepts.features && u.selection.every((s) => accepts.kinds.includes(s.hit.kind))) {
      for (const s of u.selection) {
        const ref = s.ref ?? (await wb.refFor(s.hit, accepts.as));
        if (ref) feature = applyPick(feature, first.path, ref);
      }
    }
  }
  // The first field still empty (a pre-filled list field moves on to the next one).
  const filledFirst = first && !emptyField(feature, first.path);
  const next = steps.find((s, i) => (i > 0 || !filledFirst) && emptyField(feature, s.path));
  wb.patchUi({ lastTool: tool });
  wb.addFeature(feature, next?.path);
}

export function cutSelection(wb: Workbench): Promise<void> {
  return wb.track(
    (async () => {
      const part = wb.part;
      const regions = wb.ui.get().selection.filter((s) => s.hit.kind === 'region');
      if (!part || regions.length === 0) return;
      const refs: EntityRef[] = [];
      for (const s of regions) {
        const ref = s.ref ?? (await wb.refFor(s.hit));
        if (ref) refs.push(ref);
      }
      if (refs.length) wb.addFeature(newCut(part, refs), '/profile');
    })(),
  );
}

export function bubbleAction(wb: Workbench, id: BubbleActionId): void {
  const hits = wb.ui.get().selection.map((s) => s.hit);
  // The bubble closes once an action is chosen; it may return on the next selection, not on its own.
  wb.patchUi({
    bubble: null,
    bubbleDismissed: wb.ui
      .get()
      .selection.map((s) => s.key)
      .join(','),
  });
  switch (id) {
    case 'sketch':
      wb.sketchTool();
      break;
    case 'cut':
      void wb.cutSelection();
      break;
    case 'measure':
      void wb.track(wb.measure.start(hits));
      break;
    case 'section': {
      const face = hits.find((h) => h.kind === 'face');
      if (face) wb.sectionFromFace(face);
      wb.openSheet(wb.tier === 'phone' ? 'section' : 'inspector');
      break;
    }
    case 'fit':
      wb.viewport?.fitAll(true);
      break;
    case 'undo':
      wb.undo();
      break;
    case 'redo':
      wb.redo();
      break;
    default:
      void wb.track(wb.runTool(id));
  }
}
