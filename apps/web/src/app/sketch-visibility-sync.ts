/**
 * Sketch visibility subscription: which sketches the viewport shows (resolver in model/sketch-visibility.ts) and the tree's eye set.
 */

import type { Id } from '@wren-cad/contracts';
import { TOOL_NEEDS } from '../features/factories';
import { sketchShown, type VisibilityContext } from '../model/sketch-visibility';
import type { Workbench } from './workbench';

export function refreshSketchVisibility(wb: Workbench): void {
  const part = wb.part;
  const u = wb.ui.get();
  const pickKinds = wb.pickAccepts()?.kinds ?? [];
  // Regions, sketch curves (sweep paths) and sketch points (hole centres) are picked on sketches.
  const wantRegions =
    (u.prompt !== null && TOOL_NEEDS[u.prompt.tool].kinds.includes('region')) ||
    pickKinds.some((k) => k === 'region' || k === 'sketchCurve' || k === 'sketchPoint');
  const features = part?.features ?? [];
  const ctx: VisibilityContext = {
    features,
    rollback: part?.rollbackIndex ?? features.length,
    activeSketch: u.sketch?.featureId,
    editing: u.featureId ? features.find((f) => f.id === u.featureId) : undefined,
    wantRegions,
  };
  const ids = new Set<Id>();
  for (const f of features) if (f.type === 'sketch' && sketchShown(f, ctx)) ids.add(f.id);
  const prev = wb.shownSketchIds.get();
  if (prev.size !== ids.size || [...ids].some((id) => !prev.has(id))) wb.shownSketchIds.set(ids);

  const v = wb.viewport;
  const view = wb.regen.get();
  if (!v || !view) return;
  const next = new Set<string>();
  for (const s of view.result.sketches) {
    if (u.sketch?.featureId === s.featureId) {
      next.add(s.featureId);
      continue; // the sketch session owns the active overlay
    }
    if (!ids.has(s.featureId)) continue;
    v.setSketch(s.featureId, { sketch: s, active: false });
    next.add(s.featureId);
  }
  for (const id of wb.shownSketches) if (!next.has(id)) v.setSketch(id, null);
  wb.shownSketches = next;
}
