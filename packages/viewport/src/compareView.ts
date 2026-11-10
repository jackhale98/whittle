import type { CompareOverlay } from '@wren-cad/contracts';
import { applyDisplay, bodyEdgeColor } from './bodies';
import {
  buildCompareGroup,
  COMPARE_COLORS,
  type CompareObjects,
  ghostOpacityOf,
  sameGeometry,
  sideVisibility,
} from './compare';
import { disposeOverlay } from './overlays';
import { requestRender } from './renderLoop';
import type { ViewportImpl } from './viewport';

export function setCompare(vp: ViewportImpl, overlay: CompareOverlay | null): void {
  if (vp.disposed && overlay) return;
  const prev = vp.compare;
  if (!overlay) {
    if (!prev) return;
    disposeCompareObjects(vp, prev.objects);
    vp.compare = null;
    refreshBodiesForCompare(vp);
    requestRender(vp);
    return;
  }
  if (prev && sameGeometry(prev.overlay, overlay)) {
    // show / ghostOpacity only: no geometry rebuild, no material change on the overlay.
    const vis = sideVisibility(overlay.show);
    prev.objects.added.visible = vis.added;
    prev.objects.removed.visible = vis.removed;
    prev.overlay = overlay;
    const ghost = ghostOpacityOf(overlay);
    if (ghost !== prev.ghost) {
      prev.ghost = ghost;
      refreshBodiesForCompare(vp);
    }
  } else {
    buildCompare(vp, overlay);
    if (!prev || prev.ghost !== vp.compare?.ghost) refreshBodiesForCompare(vp);
  }
  requestRender(vp);
}

/** (Re)build overlay objects for `overlay`, replacing and disposing any previous ones. */
export function buildCompare(vp: ViewportImpl, overlay: CompareOverlay): void {
  const prev = vp.compare;
  if (prev) disposeCompareObjects(vp, prev.objects);
  const dash = Math.max(vp.sceneRadius * 0.025, 1e-3);
  const objects = buildCompareGroup(overlay, COMPARE_COLORS[vp.theme], 1.8, dash);
  vp.bodyRoot.add(objects.root); // clipped by sections; never in the ID scene, so not pickable
  vp.compareBuilds++;
  vp.compare = { overlay, objects, ghost: ghostOpacityOf(overlay) };
}

export function disposeCompareObjects(vp: ViewportImpl, objects: CompareObjects): void {
  vp.bodyRoot.remove(objects.root);
  disposeOverlay(objects.root);
}

/** Apply (or restore) the ghost opacity on the live bodies. */
export function refreshBodiesForCompare(vp: ViewportImpl): void {
  for (const e of vp.bodies.values()) applyDisplay(vp, e);
  vp.edgeMaterial.color.set(bodyEdgeColor(vp));
  vp.viewVersion++;
}
