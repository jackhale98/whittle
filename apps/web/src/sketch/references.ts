/**
 * Sketch reference geometry in sketch mode (ADR-017 item 1): the origin (`@origin`) and the axes
 * (`@x`, `@y`) that every sketch has. They are drawn as reference geometry, can be picked by the
 * dimension and constraint tools and selected, but never dragged, deleted or stored in
 * `entities`. Pure helpers so picking priority and overlay geometry are unit-testable.
 */

import type { Id, PickHit, SketchEntity, SketchResult, Vec2 } from '@whittle/contracts';
import {
  isSketchReference,
  referenceEntities,
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
} from '@whittle/sketch';
import { type PlaneFrame, toWorld } from '../model/frames';
import type { SketchData } from './draw';

export { isSketchReference, SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS };

/** Overlay ids of the origin glyph's two short arms (picked as the origin). */
export const ORIGIN_GLYPH_IDS = ['@origin:glyph:u', '@origin:glyph:v'] as const;

const REFERENCE_ENTITIES = referenceEntities();

/** The sketch plus the reference geometry as ordinary entities (measuring, label anchors). */
export function withReferences(sketch: SketchData): SketchData {
  return { entities: [...sketch.entities, ...REFERENCE_ENTITIES], constraints: sketch.constraints };
}

/** `entities` plus the reference pseudo-entities (origin point, axis lines and their ends). */
export function entitiesWithReferences(entities: readonly SketchEntity[]): SketchEntity[] {
  return [...entities, ...REFERENCE_ENTITIES];
}

/** The overlay id a pick hit stands for: the origin glyph's arms are the origin. */
export function pickedEntity(entity: Id): Id {
  return (ORIGIN_GLYPH_IDS as readonly string[]).includes(entity) ? SKETCH_ORIGIN : entity;
}

/** True for overlay ids that are reference geometry (the references and the origin glyph). */
export function isReferenceOverlayId(id: Id): boolean {
  return isSketchReference(pickedEntity(id));
}

/**
 * Picking priority (ADR-017): the user's own geometry always wins over reference geometry at the
 * same spot. Points before curves (as before), then the origin, then the axes; nearest first
 * within a tier.
 */
export function rankSketchHits(hits: readonly PickHit[]): PickHit | null {
  const tier = (h: PickHit): number => {
    const id = pickedEntity(h.entity ?? '');
    if (id === SKETCH_ORIGIN) return 2;
    if (isSketchReference(id)) return 3;
    return h.kind === 'sketchPoint' ? 0 : 1;
  };
  let best: PickHit | null = null;
  let bestTier = Number.POSITIVE_INFINITY;
  for (const h of hits) {
    const t = tier(h);
    if (t < bestTier || (t === bestTier && best && h.distancePx < best.distancePx)) {
      best = h;
      bestTier = t;
    }
  }
  if (!best) return null;
  const entity = pickedEntity(best.entity ?? '');
  return entity === best.entity
    ? best
    : { ...best, entity, kind: entity === SKETCH_ORIGIN ? 'sketchPoint' : best.kind };
}

/** A sketch-space box (mm). */
export interface Box2 {
  min: Vec2;
  max: Vec2;
}

/**
 * Overlay curves for the reference geometry: the axes as dashed (construction) lines across
 * `span`, the origin glyph's two short solid arms (`glyph` mm long each way) and the origin dot as
 * a faded (construction) sketch point. Ids: `@x`, `@y`, `@origin` and `ORIGIN_GLYPH_IDS`.
 */
export function referenceOverlay(
  frame: PlaneFrame,
  span: Box2,
  glyph: number,
): Pick<SketchResult, 'curves' | 'points'> {
  const line = (a: Vec2, b: Vec2) => {
    const pts = new Float32Array(6);
    pts.set(toWorld(frame, a), 0);
    pts.set(toWorld(frame, b), 3);
    return pts;
  };
  const curves: SketchResult['curves'] = [
    {
      entity: SKETCH_X_AXIS,
      points: line([span.min[0], 0], [span.max[0], 0]),
      construction: true,
    },
    {
      entity: SKETCH_Y_AXIS,
      points: line([0, span.min[1]], [0, span.max[1]]),
      construction: true,
    },
    {
      entity: ORIGIN_GLYPH_IDS[0],
      points: line([-glyph, 0], [glyph, 0]),
      construction: false,
    },
    {
      entity: ORIGIN_GLYPH_IDS[1],
      points: line([0, -glyph], [0, glyph]),
      construction: false,
    },
  ];
  return {
    curves,
    points: [{ entity: SKETCH_ORIGIN, at: toWorld(frame, [0, 0]), construction: true }],
  };
}

/**
 * The span the axes are drawn across for a visible sketch-space box: the box grown by `grow`
 * around its centre, always including the origin's neighbourhood. Null view (edge-on plane): a
 * large fixed extent around the sketch.
 */
export function axisSpan(view: Box2 | null, sketchExtent: number, grow = 1.25): Box2 {
  if (!view) {
    const r = Math.max(1000, 4 * sketchExtent);
    return { min: [-r, -r], max: [r, r] };
  }
  const c: Vec2 = [(view.min[0] + view.max[0]) / 2, (view.min[1] + view.max[1]) / 2];
  const hw = ((view.max[0] - view.min[0]) / 2) * grow;
  const hh = ((view.max[1] - view.min[1]) / 2) * grow;
  return { min: [c[0] - hw, c[1] - hh], max: [c[0] + hw, c[1] + hh] };
}

/**
 * Whether axes drawn across `drawn` still suit the visible `view`: it must lie inside, and not be
 * much smaller (zoomed far in, the dashes and the glyph would be oversized).
 */
export function spanCovers(drawn: Box2, view: Box2 | null): boolean {
  if (!view) return true;
  const inside =
    view.min[0] >= drawn.min[0] &&
    view.min[1] >= drawn.min[1] &&
    view.max[0] <= drawn.max[0] &&
    view.max[1] <= drawn.max[1];
  const size = (b: Box2) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  return inside && size(view) * 2.5 >= size(drawn);
}

/** Bounding box of sketch-space points (null when empty or non-finite). */
export function boxOf(points: readonly (Vec2 | null)[]): Box2 | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (!p) return null;
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}
