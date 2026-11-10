import type { SketchOverlay } from '@wren-cad/contracts';
import { Group } from 'three/webgpu';
import { rebuildHighlights } from './adornments';
import { applyDimming } from './bodies';
import { meshBuffersToGeometry } from './geometry';
import type { SketchEntry } from './internal';
import { type Dot, disposeOverlay, makeDot, makeFill, makeLines } from './overlays';
import { requestRender } from './renderLoop';
import { entityColor, mixHex } from './sketchStyle';
import type { ViewportImpl } from './viewport';

export function setSketch(
  vp: ViewportImpl,
  featureId: string,
  overlay: SketchOverlay | null,
): void {
  const prev = vp.sketches.get(featureId);
  if (prev) {
    vp.scene.remove(prev.group);
    disposeOverlay(prev.group);
    vp.sketches.delete(featureId);
  }
  if (overlay && !vp.disposed) vp.sketches.set(featureId, buildSketch(vp, overlay));
  applyDimming(vp);
  rebuildHighlights(vp);
  requestRender(vp);
}

export function buildSketch(vp: ViewportImpl, overlay: SketchOverlay): SketchEntry {
  const ui = vp.ui;
  const { sketch } = overlay;
  const onTop = overlay.active === true;
  const conflicting = new Set(overlay.conflicting ?? []);
  const group = new Group();
  const dots: Dot[] = [];
  const curves: SketchEntry['curves'] = [];

  // Extent for dash sizing.
  let diag = 0;
  {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of sketch.curves) {
      for (let i = 0; i < c.points.length; i++) {
        const v = c.points[i] as number;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    diag = Number.isFinite(max - min) ? max - min : vp.sceneRadius;
  }
  const dash = Math.max(diag / 60, 1e-3);

  // Bucket curve segments by (colour, dashed) -> one fat-line object each.
  const buckets = new Map<string, { color: string; dashed: boolean; segs: number[] }>();
  for (const c of sketch.curves) {
    const count = Math.floor(c.points.length / 3);
    const isPoint = count === 1;
    curves.push({ entity: c.entity, points: c.points, isPoint });
    const color = entityColor(ui, overlay.dof?.[c.entity], conflicting.has(c.entity));
    if (isPoint) {
      const dot = makeDot(8, color, vp.palette.background, 31, [
        c.points[0] as number,
        c.points[1] as number,
        c.points[2] as number,
      ]);
      group.add(dot.sprite);
      dots.push(dot);
      continue;
    }
    if (count < 2) continue;
    const key = `${color}|${c.construction ? 'd' : 's'}`;
    const b = buckets.get(key) ?? { color, dashed: c.construction, segs: [] as number[] };
    buckets.set(key, b);
    for (let i = 0; i < count - 1; i++) {
      for (let k = 0; k < 6; k++) b.segs.push(c.points[3 * i + k] as number);
    }
  }
  for (const b of buckets.values()) {
    const lines = makeLines(Float32Array.from(b.segs), {
      color: b.color,
      width: b.dashed ? 1.8 : 2.4,
      dashed: b.dashed,
      dash,
      onTop,
      renderOrder: onTop ? 30 : 6,
    });
    group.add(lines);
  }
  // SketchResult.points: dots, picked as sketchPoint. Skip ids already drawn as one-point curves.
  const drawn = new Set(curves.map((c) => c.entity));
  for (const pt of sketch.points ?? []) {
    if (drawn.has(pt.entity)) continue;
    drawn.add(pt.entity);
    curves.push({
      entity: pt.entity,
      points: Float32Array.of(pt.at[0], pt.at[1], pt.at[2]),
      isPoint: true,
    });
    const base = entityColor(ui, overlay.dof?.[pt.entity], conflicting.has(pt.entity));
    const color = pt.construction ? mixHex(base, vp.palette.background, 0.4) : base;
    const dot = makeDot(8, color, vp.palette.background, 31, pt.at);
    group.add(dot.sprite);
    dots.push(dot);
  }
  // Faint region fills (also the pick surface for profiles).
  for (const r of sketch.regions) {
    group.add(makeFill(meshBuffersToGeometry(r.mesh), ui.accent, 0.1, onTop, onTop ? 28 : 5));
  }
  vp.scene.add(group);
  return { overlay, group, dots, curves, regions: sketch.regions };
}

export function anySketchActive(vp: ViewportImpl): boolean {
  for (const s of vp.sketches.values()) if (s.overlay.active) return true;
  return false;
}
