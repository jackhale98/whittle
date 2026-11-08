/**
 * Pencil strokes in sketch mode (PLAN §9.3, ADR-011): a recognised stroke becomes a sketch edit
 * the same way a drawing tool's clicks do. The recipe (packages/sketch `strokeFragment`):
 *
 * - confidence < 0.5: keep the stroke as a polyline (the recognised polyline, or the simplified
 *   samples when the guess was another shape);
 * - otherwise `strokeFragment`, merged as is, plus end-point inference against the existing sketch
 *   (`pointAnchor` + `anchorConstraints`, exactly as click drawing does);
 * - a scribble deletes what it crosses.
 *
 * Pure functions over plain data (unit-tested); the sketch session commits the result through its
 * edit queue so pending clicks and solves still order correctly.
 */

import type { Id, SketchEntity, StrokeRecognition, Vec2 } from '@whittle/contracts';
import { indexEntities, polylineTool, type SketchFragment, sampleEntity } from '@whittle/sketch';
import { strokeFragment } from '@whittle/sketch/recognize';
import {
  type Anchor,
  anchorConstraints,
  pointAnchor,
  type SketchData,
  type SketchEdit,
} from './draw';

/** Below this the app keeps the stroke as drawn (contract `StrokeRecognition.confidence`). */
export const MIN_CONFIDENCE = 0.5;

export type StrokeResult =
  | { kind: 'add'; edit: SketchEdit; shape: string }
  | { kind: 'erase'; ids: Id[] }
  | null;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const l2 = ux * ux + uy * uy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / l2));
  return Math.hypot(p[0] - a[0] - ux * t, p[1] - a[1] - uy * t);
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Distance between two 2D segments (0 when they cross). */
export function segmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return 0;
  return Math.min(
    pointSegment(a, c, d),
    pointSegment(b, c, d),
    pointSegment(c, a, b),
    pointSegment(d, a, b),
  );
}

/** Curves a scribble passes over (within `tolerance` mm). */
export function crossedEntities(
  sketch: SketchData,
  scribble: readonly Vec2[],
  tolerance: number,
): Id[] {
  const index = indexEntities(sketch.entities);
  const out: Id[] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'point') continue;
    const poly = sampleEntity(index, e, { chordTolerance: Math.max(tolerance / 4, 0.01) });
    let hit = false;
    for (let i = 0; i + 1 < poly.length && !hit; i++)
      for (let j = 0; j + 1 < scribble.length && !hit; j++)
        hit =
          segmentDistance(
            poly[i] as Vec2,
            poly[i + 1] as Vec2,
            scribble[j] as Vec2,
            scribble[j + 1] as Vec2,
          ) <= tolerance;
    if (hit) out.push(e.id);
  }
  return out;
}

/** Ramer–Douglas–Peucker: the stroke's corners within `tolerance` mm. */
export function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = pointSegment(points[k] as Vec2, points[i] as Vec2, points[j] as Vec2);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, k) => keep[k] === 1);
}

function fragmentFor(
  rec: StrokeRecognition,
  samples: readonly Vec2[],
  tolerance: number,
  construction: boolean,
): { frag: SketchFragment; shape: string } | null {
  if (rec.confidence >= MIN_CONFIDENCE) {
    const frag = strokeFragment(rec, { construction });
    return frag ? { frag, shape: rec.shape.kind } : null;
  }
  // Not sure what it is: keep it as drawn.
  const shape = rec.shape;
  const closed = shape.kind === 'polyline' && shape.closed;
  let pts = shape.kind === 'polyline' ? shape.points : simplify(samples, tolerance / 2);
  if (closed && pts.length > 1 && dist(pts[0] as Vec2, pts[pts.length - 1] as Vec2) < 1e-9)
    pts = pts.slice(0, -1);
  if (pts.length < 2) return null;
  return {
    frag: polylineTool(pts, { construction, closed: closed && pts.length > 2 }),
    shape: 'polyline',
  };
}

/** Points used by exactly one curve end (the free ends of lines and arcs). */
function openEnds(frag: SketchFragment): Set<Id> {
  const uses = new Map<Id, number>();
  for (const e of frag.entities)
    if (e.kind === 'line' || e.kind === 'arc')
      for (const p of [e.start, e.end]) uses.set(p, (uses.get(p) ?? 0) + 1);
  return new Set([...uses].filter(([, n]) => n === 1).map(([p]) => p));
}

/**
 * The sketch edit for a finished stroke. `samples` are the stroke's points in sketch mm (for the
 * low-confidence polyline and the scribble), `tolerance` the recognition tolerance in mm.
 */
export function strokeEdit(
  rec: StrokeRecognition | null,
  samples: readonly Vec2[],
  sketch: SketchData,
  tolerance: number,
  construction = false,
): StrokeResult {
  if (!rec) return null;
  if (rec.shape.kind === 'scribble') {
    const ids = crossedEntities(sketch, rec.shape.points, tolerance / 2);
    return ids.length ? { kind: 'erase', ids } : null;
  }
  const made = fragmentFor(rec, samples, tolerance, construction);
  if (!made) return null;
  const { frag, shape } = made;
  // End-point inference: an open stroke's ends that land on an existing point merge with it (one
  // existing point at most once), or snap onto a curve / midpoint. Closed shapes (rectangles,
  // circles, loops) keep their clean-up: a hole's centre must not jump onto a nearby edge.
  const ends = openEnds(frag);
  const used = new Set<Id>();
  const anchors: Anchor[] = [];
  for (const e of frag.entities) {
    if (e.kind !== 'point' || e.construction || !ends.has(e.id)) continue;
    const a = pointAnchor(sketch, [e.x, e.y], tolerance);
    if (a.pointId) {
      if (used.has(a.pointId)) continue;
      used.add(a.pointId);
    }
    if (a.pointId || a.snap) anchors.push(a);
  }
  const extra = anchorConstraints(frag, anchors);
  return {
    kind: 'add',
    shape,
    edit: {
      entities: frag.entities as SketchEntity[],
      constraints: [...frag.constraints, ...extra],
      created: frag.entities.filter((e) => e.kind !== 'point').map((e) => e.id),
    },
  };
}
