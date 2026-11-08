/**
 * Compare overlay (PLAN §8A.3): material added by a change in green, removed in red, drawn over
 * the live bodies, which fade to a ghost. Pure parts (palette, opacity, bounds, reuse test) live
 * here and are unit-tested; `buildCompareGroup` makes the three.js objects.
 *
 * Colours: Okabe-Ito-family bluish green and vermillion (darkened red) on light, brighter tints on
 * dark. They differ in luminance as well as hue, so protan/deutan/tritan viewers still separate
 * them; on top of that the edge style is a non-colour cue (added = solid, removed = dashed).
 * Values are documented in docs/DECISIONS.md.
 */

import type { CompareOverlay, MeshBuffers } from '@whittle/contracts';
import { Group } from 'three/webgpu';
import { edgesToSegments, meshBuffersToGeometry } from './geometry';
import { makeFill, makeLines } from './overlays';
import { type Bounds, unionBounds } from './views';

export interface CompareColors {
  added: string;
  removed: string;
}

export const COMPARE_COLORS: Readonly<Record<'light' | 'dark', CompareColors>> = {
  light: { added: '#00a878', removed: '#c2410c' },
  dark: { added: '#3ddc97', removed: '#ff6a2e' },
};

export const DEFAULT_GHOST_OPACITY = 0.15;
/** Fill opacities: removed is lighter because it is drawn without depth occlusion (x-ray). */
export const ADDED_FILL_OPACITY = 0.45;
export const REMOVED_FILL_OPACITY = 0.38;

export type CompareShow = 'both' | 'added' | 'removed';

export function ghostOpacityOf(overlay: CompareOverlay): number {
  const g = overlay.ghostOpacity ?? DEFAULT_GHOST_OPACITY;
  return Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : DEFAULT_GHOST_OPACITY;
}

export function sideVisibility(show: CompareShow | undefined): {
  added: boolean;
  removed: boolean;
} {
  const s = show ?? 'both';
  return { added: s !== 'removed', removed: s !== 'added' };
}

/** A body's drawn opacity: its own, or the ghost opacity (never higher) while comparing. */
export function effectiveOpacity(own: number, ghost: number | null): number {
  return ghost === null ? own : Math.min(own, ghost);
}

/** Bounds of the overlay meshes on the visible sides; null when there are none. */
export function compareBounds(overlay: CompareOverlay): Bounds | null {
  const vis = sideVisibility(overlay.show);
  const list: Bounds[] = [];
  const add = (meshes: readonly MeshBuffers[]) => {
    for (const m of meshes) list.push({ min: [...m.bbox.min], max: [...m.bbox.max] });
  };
  if (vis.added) add(overlay.added);
  if (vis.removed) add(overlay.removed);
  return unionBounds(list);
}

/** Same geometry (array identity): only `show` / `ghostOpacity` changed, so keep the GPU buffers. */
export function sameGeometry(a: CompareOverlay, b: CompareOverlay): boolean {
  return a.added === b.added && a.removed === b.removed;
}

export interface CompareObjects {
  root: Group;
  added: Group;
  removed: Group;
}

const ORDER_FILL = 8;
const ORDER_EDGE = 9;

/**
 * Added: translucent fill depth-tested (it sits outside the old body, which as a ghost writes no
 * depth anyway) with solid edges. Removed: fill and dashed edges drawn without depth test, so
 * they stay visible inside the ghosted body and even when a caller sets ghostOpacity 1 (an opaque
 * body writes depth and would hide the hole's material).
 */
export function buildCompareGroup(
  overlay: CompareOverlay,
  colors: CompareColors,
  edgeWidth: number,
  dash: number,
): CompareObjects {
  const root = new Group();
  const added = new Group();
  const removed = new Group();
  root.add(added, removed);
  const side = (
    g: Group,
    meshes: readonly MeshBuffers[],
    color: string,
    opacity: number,
    dashed: boolean,
    onTop: boolean,
  ) => {
    for (const m of meshes) {
      g.add(makeFill(meshBuffersToGeometry(m), color, opacity, onTop, ORDER_FILL));
      const segs = edgesToSegments(m.edgePositions, m.edgeRanges);
      if (segs.length === 0) continue;
      g.add(
        makeLines(segs, { color, width: edgeWidth, dashed, dash, onTop, renderOrder: ORDER_EDGE }),
      );
    }
  };
  side(added, overlay.added, colors.added, ADDED_FILL_OPACITY, false, false);
  side(removed, overlay.removed, colors.removed, REMOVED_FILL_OPACITY, true, true);
  const vis = sideVisibility(overlay.show);
  added.visible = vis.added;
  removed.visible = vis.removed;
  return { root, added, removed };
}
