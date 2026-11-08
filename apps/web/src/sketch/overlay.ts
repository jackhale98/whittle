/** Sketch display data for the viewport overlay, built from document entities in TS. */

import type { Id, SketchEntity, SketchResult, Vec2 } from '@whittle/contracts';
import { indexEntities, sampleEntity } from '@whittle/sketch';
import { type PlaneFrame, toWorld } from '../model/frames';

/**
 * World-space curves and points of a sketch (display + picking). Points are also emitted as
 * one-point curves: that is how the viewport draws them as dots and picks them as `sketchPoint`
 * (it does not read `SketchResult.points`).
 */
export function sketchCurves(
  entities: readonly SketchEntity[],
  frame: PlaneFrame,
): Pick<SketchResult, 'curves' | 'points'> {
  const index = indexEntities(entities);
  const curves: SketchResult['curves'] = [];
  const points: NonNullable<SketchResult['points']> = [];
  for (const e of entities) {
    if (e.kind === 'point') {
      const at = toWorld(frame, [e.x, e.y]);
      points.push({ entity: e.id, at, construction: e.construction });
      // The viewport draws and picks a one-point curve as a sketch point (dot, `sketchPoint`).
      curves.push({ entity: e.id, points: new Float32Array(at), construction: e.construction });
      continue;
    }
    let poly: Vec2[];
    try {
      poly = sampleEntity(index, e, { chordTolerance: 0.02 });
    } catch {
      continue; // dangling reference: nothing to draw
    }
    const pts = new Float32Array(poly.length * 3);
    poly.forEach((p, i) => {
      pts.set(toWorld(frame, p), i * 3);
    });
    curves.push({ entity: e.id, points: pts, construction: e.construction });
  }
  return { curves, points };
}

/** Midpoint (sketch space) of an entity, for constraint glyphs. */
export function entityAnchor(entities: readonly SketchEntity[], id: Id): Vec2 | null {
  const index = indexEntities(entities);
  const e = index.get(id);
  if (!e) return null;
  try {
    const poly = sampleEntity(index, e, { chordTolerance: 0.5 });
    const p = poly[Math.floor((poly.length - 1) / 2)];
    if (!p) return null;
    if (e.kind === 'line' && poly.length === 2) {
      const [a, b] = poly as [Vec2, Vec2];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    return p;
  } catch {
    return null;
  }
}
