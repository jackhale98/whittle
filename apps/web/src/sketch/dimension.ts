/**
 * Dimension tool (PLAN §2.1, §9.4 `D`): which driving dimension a set of picked sketch entities
 * makes, its current measured value, where its label sits, and its display text.
 */

import type {
  DimensionConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  Vec2,
} from '@whittle/contracts';
import { indexEntities, newId } from '@whittle/sketch';
import type { SketchData } from './draw';

type Index = ReadonlyMap<Id, SketchEntity>;

const pos = (index: Index, id: Id): Vec2 | null => {
  const e = index.get(id);
  return e?.kind === 'point' ? [e.x, e.y] : null;
};
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function lineEnds(index: Index, id: Id): [Vec2, Vec2] | null {
  const l = index.get(id);
  if (l?.kind !== 'line') return null;
  const a = pos(index, l.start);
  const b = pos(index, l.end);
  return a && b ? [a, b] : null;
}

function radiusOf(index: Index, id: Id): number | null {
  const e = index.get(id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind === 'arc') {
    const c = pos(index, e.center);
    const s = pos(index, e.start);
    return c && s ? len(sub(s, c)) : null;
  }
  return null;
}

/** Distance from p to the infinite line through a, b. */
function pointLine(p: Vec2, [a, b]: [Vec2, Vec2]): number {
  const d = sub(b, a);
  const l = len(d);
  if (l < 1e-12) return len(sub(p, a));
  return Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / l;
}

/** A dimension without id/value/driving/label (distributes over the union). */
export type DimensionDraft = DimensionConstraint extends infer C
  ? C extends DimensionConstraint
    ? Omit<C, 'id' | 'value' | 'driving' | 'label'>
    : never
  : never;

/**
 * The dimension for picked entities: line → length; circle → diameter; arc → radius; two points
 * → distance; point + line/circle → distance; two lines → distance when parallel, else angle.
 */
export function dimensionFor(sketch: SketchData, picks: readonly Id[]): DimensionDraft | null {
  const index = indexEntities(sketch.entities);
  const [a, b] = picks.map((id) => index.get(id));
  if (!a) return null;
  if (!b) {
    if (a.kind === 'line') return { kind: 'length', line: a.id };
    if (a.kind === 'circle') return { kind: 'diameter', curve: a.id };
    if (a.kind === 'arc') return { kind: 'radius', curve: a.id };
    return null;
  }
  if (a.kind === 'point' && b.kind === 'point') return { kind: 'distance', a: a.id, b: b.id };
  if (a.kind === 'point' && b.kind !== 'point') return { kind: 'distance', a: a.id, b: b.id };
  if (b.kind === 'point' && a.kind !== 'point') return { kind: 'distance', a: b.id, b: a.id };
  if (a.kind === 'line' && b.kind === 'line') {
    const la = lineEnds(index, a.id);
    const lb = lineEnds(index, b.id);
    if (!la || !lb) return null;
    const u = sub(la[1], la[0]);
    const v = sub(lb[1], lb[0]);
    const sin = Math.abs(u[0] * v[1] - u[1] * v[0]) / (len(u) * len(v) || 1);
    return sin < Math.sin((1 * Math.PI) / 180)
      ? { kind: 'distance', a: a.id, b: b.id }
      : { kind: 'angle', a: a.id, b: b.id };
  }
  return null;
}

/** Current value of a dimension (mm or rad), or null if its entities are missing. */
export function measure(sketch: SketchData, d: DimensionDraft): number | null {
  const index = indexEntities(sketch.entities);
  switch (d.kind) {
    case 'length': {
      const l = lineEnds(index, d.line);
      return l ? len(sub(l[1], l[0])) : null;
    }
    case 'radius':
      return radiusOf(index, d.curve);
    case 'diameter': {
      const r = radiusOf(index, d.curve);
      return r === null ? null : 2 * r;
    }
    case 'angle': {
      const la = lineEnds(index, d.a);
      const lb = lineEnds(index, d.b);
      if (!la || !lb) return null;
      const u = sub(la[1], la[0]);
      const v = sub(lb[1], lb[0]);
      let t = Math.atan2(v[1], v[0]) - Math.atan2(u[1], u[0]);
      t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return t;
    }
    case 'distance':
    case 'hDistance':
    case 'vDistance': {
      const pa = pos(index, d.a);
      const eb = index.get(d.b);
      if (d.kind !== 'distance') {
        const pb = pos(index, d.b);
        if (!pa || !pb) return null;
        return d.kind === 'hDistance' ? pb[0] - pa[0] : pb[1] - pa[1];
      }
      if (pa && eb?.kind === 'point') return len(sub([eb.x, eb.y], pa));
      if (pa && eb?.kind === 'line') {
        const l = lineEnds(index, eb.id);
        return l ? pointLine(pa, l) : null;
      }
      if (pa && (eb?.kind === 'circle' || eb?.kind === 'arc')) {
        const c = pos(index, eb.center);
        const r = radiusOf(index, eb.id);
        return c && r !== null ? Math.abs(len(sub(pa, c)) - r) : null;
      }
      const la = lineEnds(index, d.a);
      const lb = lineEnds(index, d.b);
      if (la && lb) return pointLine(la[0], lb);
      return null;
    }
  }
}

/** Sketch-space anchor of a dimension's label (stored `label`, else next to its geometry). */
export function labelAnchor(sketch: SketchData, c: DimensionConstraint): Vec2 | null {
  if (c.label) return c.label;
  const index = indexEntities(sketch.entities);
  const center = (id: Id): Vec2 | null => {
    const e = index.get(id);
    if (!e) return null;
    if (e.kind === 'point') return [e.x, e.y];
    if (e.kind === 'line') {
      const l = lineEnds(index, id);
      return l ? mid(l[0], l[1]) : null;
    }
    if (e.kind === 'circle' || e.kind === 'arc') {
      const p = pos(index, e.center);
      const r = radiusOf(index, id) ?? 0;
      return p ? [p[0] + r * Math.SQRT1_2, p[1] + r * Math.SQRT1_2] : null;
    }
    return null;
  };
  switch (c.kind) {
    case 'length':
      return center(c.line);
    case 'radius':
    case 'diameter':
      return center(c.curve);
    default: {
      const a = center(c.a);
      const b = center(c.b);
      return a && b ? mid(a, b) : (a ?? b);
    }
  }
}

/** Expression text for a freshly placed dimension: the measured value, rounded. */
export function initialExpr(kind: DimensionDraft['kind'], value: number): string {
  if (kind === 'angle') return `${Math.round(((value * 180) / Math.PI) * 100) / 100} deg`;
  return `${Math.round(value * 100) / 100} mm`;
}

export function makeDimension(
  draft: DimensionDraft,
  value: string,
  label?: Vec2,
): DimensionConstraint {
  return {
    ...draft,
    id: newId(),
    value,
    driving: true,
    ...(label ? { label } : {}),
  } as DimensionConstraint;
}

/** Entities a constraint refers to (for highlighting and deletion cascades). */
export function constraintEntities(c: SketchConstraint): Id[] {
  const out: Id[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === 'id' || k === 'kind' || k === 'value' || k === 'driving' || k === 'label') continue;
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * Deleting entities also deletes what depends on them: lines/arcs/circles whose points are gone
 * and constraints that mention any removed entity. Points still used by others are kept.
 */
export function removeEntities(sketch: SketchData, ids: readonly Id[]): SketchData {
  const gone = new Set(ids);
  const index = indexEntities(sketch.entities);
  for (const id of ids) {
    const e = index.get(id);
    if (!e) continue;
    // Removing a curve removes its now-unused points.
    const pts =
      e.kind === 'line'
        ? [e.start, e.end]
        : e.kind === 'arc'
          ? [e.center, e.start, e.end]
          : e.kind === 'circle' || e.kind === 'ellipse'
            ? [e.center]
            : [];
    for (const p of pts) {
      const usedElsewhere = sketch.entities.some(
        (o) =>
          !gone.has(o.id) && o.id !== e.id && o.kind !== 'point' && Object.values(o).includes(p),
      );
      if (!usedElsewhere) gone.add(p);
    }
  }
  // Curves that lost a point go too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of sketch.entities) {
      if (gone.has(e.id) || e.kind === 'point') continue;
      if (Object.values(e).some((v) => typeof v === 'string' && gone.has(v))) {
        gone.add(e.id);
        changed = true;
      }
    }
  }
  return {
    entities: sketch.entities.filter((e) => !gone.has(e.id)),
    constraints: sketch.constraints.filter(
      (c) => !constraintEntities(c).some((id) => gone.has(id)),
    ),
  };
}
