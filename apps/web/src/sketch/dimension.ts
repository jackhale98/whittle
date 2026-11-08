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

/**
 * Horizontal or vertical distance by where the label is placed (PLAN §2.1, as in most CAD): for
 * two points — or an oblique line — a label above/below their span measures horizontally, a label
 * left/right of it vertically, anywhere else (or `aligned`, e.g. Shift held) stays aligned. The
 * points are ordered so the value is positive. Axis-aligned lines keep their length.
 */
export function dimensionAt(
  sketch: SketchData,
  picks: readonly Id[],
  at: Vec2 | null,
  options: { aligned?: boolean } = {},
): DimensionDraft | null {
  const base = dimensionFor(sketch, picks);
  if (!base || !at || options.aligned) return base;
  const index = indexEntities(sketch.entities);
  let ends: [Id, Id] | null = null;
  if (base.kind === 'distance') {
    const ea = index.get(base.a);
    const eb = index.get(base.b);
    if (ea?.kind === 'point' && eb?.kind === 'point') ends = [ea.id, eb.id];
  } else if (base.kind === 'length') {
    const l = index.get(base.line);
    if (l?.kind === 'line') ends = [l.start, l.end];
    const le = lineEnds(index, base.line);
    // Horizontal/vertical lines: their length already is the h/v distance.
    if (le && (Math.abs(le[0][0] - le[1][0]) < 1e-6 || Math.abs(le[0][1] - le[1][1]) < 1e-6))
      ends = null;
  }
  if (!ends) return base;
  const pa = pos(index, ends[0]);
  const pb = pos(index, ends[1]);
  if (!pa || !pb) return base;
  const [x0, x1] = [Math.min(pa[0], pb[0]), Math.max(pa[0], pb[0])];
  const [y0, y1] = [Math.min(pa[1], pb[1]), Math.max(pa[1], pb[1])];
  const m = 0.02 * Math.max(x1 - x0, y1 - y0, 1e-6);
  const outX = at[0] < x0 - m || at[0] > x1 + m;
  const outY = at[1] < y0 - m || at[1] > y1 + m;
  let kind: 'hDistance' | 'vDistance' | null = null;
  if (outY && !outX && x1 - x0 > 1e-9) kind = 'hDistance';
  else if (outX && !outY && y1 - y0 > 1e-9) kind = 'vDistance';
  if (!kind) return base;
  const axis = kind === 'hDistance' ? 0 : 1;
  const [a, b] = (pb[axis] as number) >= (pa[axis] as number) ? ends : [ends[1], ends[0]];
  return { kind, a, b };
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
        if (d.a === d.b) {
          // A line: end − start (contract convention).
          const l = lineEnds(index, d.a);
          if (!l) return null;
          return d.kind === 'hDistance' ? l[1][0] - l[0][0] : l[1][1] - l[0][1];
        }
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

/**
 * The expression of a radius dimension shown as a diameter (`toDiameter`) or back: literals are
 * converted (`3 mm` ↔ `6 mm`), parametric expressions wrapped (`hole_d/2` ↔ `hole_d`).
 */
export function convertRadiusDiameter(expr: string, toDiameter: boolean): string {
  const t = expr.trim();
  const lit = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Zµ]*)$/.exec(t);
  if (lit) {
    const n = Number.parseFloat((Number(lit[1]) * (toDiameter ? 2 : 0.5)).toPrecision(12));
    return lit[2] ? `${n} ${lit[2]}` : String(n);
  }
  const ident = /^[A-Za-z_]\w*$/;
  // One parenthesised group spanning the whole text: "(a + b)" yes, "(a) * (b)" no.
  const wrapped = (x: string) => {
    if (!x.startsWith('(')) return false;
    let depth = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === '(') depth++;
      else if (x[i] === ')' && --depth === 0) return i === x.length - 1;
    }
    return false;
  };
  const atom = (x: string) => ident.test(x) || wrapped(x);
  const m = toDiameter ? /^(.*\S)\s*\/\s*2$/.exec(t) : /^2\s*\*\s*(.+)$/.exec(t);
  const inner = m?.[1]?.trim();
  if (inner && atom(inner)) return wrapped(inner) ? inner.slice(1, -1).trim() : inner;
  if (toDiameter) return ident.test(t) ? `2 * ${t}` : `2 * (${t})`;
  return ident.test(t) ? `${t}/2` : `(${t})/2`;
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
