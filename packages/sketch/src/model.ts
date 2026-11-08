/**
 * The solver's internal model of a sketch: a flat parameter vector (mm), the residual equations
 * of every driving constraint (our own, in TS — used to verify planegcs' answer, for DOF/rank
 * analysis and conflict search), the planegcs primitives that encode the same equations, and
 * measurement functions for dimensions (driven/reference values are measured, never solved).
 *
 * Parameters per entity: point (x, y); circle radius; ellipse focus (x, y) + minor radius
 * (planegcs' own ellipse parametrisation). Lines and arcs own no parameters beyond their points;
 * an arc's "start and end are on the same circle" rule is an internal row.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type {
  DimensionConstraint,
  GeometricConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  SketchSolveInput,
} from '@whittle/contracts';
import { anglePi, TAU } from './geometry';
import {
  constraintRefs,
  isReservedSketchId,
  isSketchReference,
  referenceEntities,
  referenceName,
  SKETCH_ORIGIN,
  usesReferences,
} from './references';

/** One scalar residual equation `f(x) = 0`. */
export interface Row {
  /** Constraint id, or the entity id for internal rows (arc rule). */
  owner: Id;
  internal: boolean;
  /** Parameter indices `f` depends on (deduplicated). */
  params: number[];
  f: (x: Float64Array) => number;
  /** Residual is an angle / dimensionless (radians) rather than a length (mm). */
  angular: boolean;
  /** Greedy-basis order for rank analysis: lower goes first (kept), higher is blamed. */
  priority: number;
}

export interface Measure {
  params: number[];
  fn: (x: Float64Array) => number;
  angular: boolean;
}

export class SketchInputError extends Error {
  override name = 'SketchInputError';
}

export interface ModelOptions {
  /** Constraint ids to leave out (conflict search, relaxation). */
  disabled?: ReadonlySet<Id>;
}

export interface SketchModel {
  input: SketchSolveInput;
  index: Map<Id, SketchEntity>;
  /** Parameter values taken from the input geometry. */
  x0: Float64Array;
  /** 1 where a `fix` constraint grounds the parameter. */
  grounded: Uint8Array;
  /** Point id → index of its x (y is +1). Includes internal ellipse foci (`<id>#f`). */
  pointIdx: Map<Id, number>;
  radiusIdx: Map<Id, number>;
  ellipseIdx: Map<Id, { focus: number; radmin: number }>;
  /** Entity id → every parameter that positions it (points included). */
  entityParams: Map<Id, number[]>;
  /** Entity id → degrees of freedom it has when nothing constrains it. */
  entityMaxDof: Map<Id, number>;
  rows: Row[];
  rowsByOwner: Map<Id, Row[]>;
  /** planegcs primitives for entities (points first) then constraints. */
  primitives: SketchPrimitive[];
  /** Driving, valid, enabled constraints (fixes included). */
  active: SketchConstraint[];
  /** Constraints that could not be encoded, with the reason (they are ignored). */
  invalid: Map<Id, string>;
  /** Measurement of every valid dimension (driving or reference), in [0, 2π) for angles. */
  measures: Map<Id, Measure>;
  /** Typical sketch size, mm (≥ 1), for tolerances. */
  lengthScale: number;
}

export const PRIORITY: Record<SketchConstraint['kind'], number> = {
  fix: 0,
  coincident: 1,
  midpoint: 1,
  symmetric: 1,
  concentric: 1,
  pointOn: 2,
  tangent: 3,
  horizontal: 4,
  vertical: 4,
  horizontalPoints: 4,
  verticalPoints: 4,
  parallel: 5,
  perpendicular: 5,
  equal: 6,
  distance: 10,
  hDistance: 10,
  vDistance: 10,
  length: 10,
  radius: 10,
  diameter: 10,
  angle: 10,
};

const uniq = (xs: number[]): number[] => [...new Set(xs)];
const P = (i: number) => [i, i + 1];

/** Planegcs object id for an entity / internal object. */
export const gid = (id: Id): string => `e:${id}`;
const cid = (id: Id, k: number): string => `c:${id}:${k}`;

interface LineRef {
  id: Id;
  s: number;
  e: number;
}
interface RoundRef {
  id: Id;
  kind: 'circle' | 'arc';
  c: number;
  params: number[];
  r: (x: Float64Array) => number;
}

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const AXIS_NO_LENGTH = 'An axis is infinite: it has no length or midpoint';

function hyp(x: Float64Array, i: number, j: number): number {
  return Math.hypot(
    (x[i] as number) - (x[j] as number),
    (x[i + 1] as number) - (x[j + 1] as number),
  );
}

/** Unsigned distance from point i to the line through s, e (NaN when the line is degenerate). */
function p2l(x: Float64Array, p: number, s: number, e: number): number {
  const dx = (x[e] as number) - (x[s] as number);
  const dy = (x[e + 1] as number) - (x[s + 1] as number);
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return Number.NaN;
  const px = (x[p] as number) - (x[s] as number);
  const py = (x[p + 1] as number) - (x[s + 1] as number);
  return Math.abs(dx * py - dy * px) / l;
}

/** Signed distance (left positive) from point p to line s→e. */
function p2lSigned(x: Float64Array, p: number, s: number, e: number): number {
  const dx = (x[e] as number) - (x[s] as number);
  const dy = (x[e + 1] as number) - (x[s + 1] as number);
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return Number.NaN;
  const px = (x[p] as number) - (x[s] as number);
  const py = (x[p + 1] as number) - (x[s + 1] as number);
  return (dx * py - dy * px) / l;
}

function dir(x: Float64Array, l: LineRef): [number, number, number] {
  const dx = (x[l.e] as number) - (x[l.s] as number);
  const dy = (x[l.e + 1] as number) - (x[l.s + 1] as number);
  return [dx, dy, Math.hypot(dx, dy)];
}

/** CCW angle from line a to line b in [0, 2π). NaN for degenerate lines. */
function lineAngle(x: Float64Array, a: LineRef, b: LineRef): number {
  const [ax, ay, al] = dir(x, a);
  const [bx, by, bl] = dir(x, b);
  if (al < 1e-12 || bl < 1e-12) return Number.NaN;
  const t = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  return t < 0 ? t + TAU : t;
}

export function buildModel(input: SketchSolveInput, options: ModelOptions = {}): SketchModel {
  const disabled = options.disabled ?? new Set<Id>();
  const index = new Map<Id, SketchEntity>();
  for (const e of input.entities) {
    if (index.has(e.id)) throw new SketchInputError(`Duplicate entity id ${e.id}`);
    if (isReservedSketchId(e.id))
      throw new SketchInputError(`${e.id} is reserved for the sketch's reference geometry`);
    index.set(e.id, e);
  }

  const values: number[] = [];
  const pointIdx = new Map<Id, number>();
  const radiusIdx = new Map<Id, number>();
  const ellipseIdx = new Map<Id, { focus: number; radmin: number }>();
  const entityParams = new Map<Id, number[]>();
  const entityMaxDof = new Map<Id, number>();

  const pointOf = (id: Id, owner: Id): number => {
    const i = pointIdx.get(id);
    if (i === undefined) {
      if (isSketchReference(id))
        throw new SketchInputError(`${cap(referenceName(id))} is not a point`);
      throw new SketchInputError(`${owner} references ${id}, which is not a point`);
    }
    return i;
  };

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const e of input.entities) {
    if (e.kind !== 'point') continue;
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
      throw new SketchInputError(`Point ${e.id} has a non-finite position`);
    }
    pointIdx.set(e.id, values.length);
    entityParams.set(e.id, [values.length, values.length + 1]);
    entityMaxDof.set(e.id, 2);
    values.push(e.x, e.y);
    minX = Math.min(minX, e.x);
    maxX = Math.max(maxX, e.x);
    minY = Math.min(minY, e.y);
    maxY = Math.max(maxY, e.y);
  }
  let extent = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;

  // Reference geometry (ADR-017): the origin and the axes, fixed, only when a constraint uses them
  // (sketches that don't are solved exactly as before). Not in `entities`, so no DOF and no output.
  const refs = usesReferences(input.constraints) ? referenceEntities() : [];
  const refPrims: SketchPrimitive[] = [];
  const refParams: number[] = [];
  for (const e of refs) {
    if (e.kind === 'point') {
      pointIdx.set(e.id, values.length);
      entityParams.set(e.id, [values.length, values.length + 1]);
      refParams.push(values.length, values.length + 1);
      values.push(e.x, e.y);
      refPrims.push({ id: gid(e.id), type: 'point', x: e.x, y: e.y, fixed: true });
    } else if (e.kind === 'line') {
      const s = pointIdx.get(e.start) as number;
      const t = pointIdx.get(e.end) as number;
      entityParams.set(e.id, [...P(s), ...P(t)]);
      refPrims.push({ id: gid(e.id), type: 'line', p1_id: gid(e.start), p2_id: gid(e.end) });
    }
    if (e.id === SKETCH_ORIGIN || e.kind === 'line') index.set(e.id, e);
  }

  const rows: Row[] = [];
  const primitives: SketchPrimitive[] = [];
  const curvePrims: SketchPrimitive[] = [];
  const pushRow = (row: Row) => rows.push(row);

  for (const e of input.entities) {
    switch (e.kind) {
      case 'point':
        primitives.push({ id: gid(e.id), type: 'point', x: e.x, y: e.y, fixed: false });
        break;
      case 'line': {
        const s = pointOf(e.start, e.id);
        const t = pointOf(e.end, e.id);
        entityParams.set(e.id, uniq([...P(s), ...P(t)]));
        entityMaxDof.set(e.id, s === t ? 2 : 4);
        curvePrims.push({ id: gid(e.id), type: 'line', p1_id: gid(e.start), p2_id: gid(e.end) });
        break;
      }
      case 'circle': {
        const c = pointOf(e.center, e.id);
        if (!(e.radius >= 0) || !Number.isFinite(e.radius)) {
          throw new SketchInputError(`Circle ${e.id} has an invalid radius`);
        }
        radiusIdx.set(e.id, values.length);
        entityParams.set(e.id, [...P(c), values.length]);
        entityMaxDof.set(e.id, 3);
        values.push(e.radius);
        extent = Math.max(extent, 2 * e.radius);
        curvePrims.push({ id: gid(e.id), type: 'circle', c_id: gid(e.center), radius: e.radius });
        break;
      }
      case 'arc': {
        const c = pointOf(e.center, e.id);
        const s = pointOf(e.start, e.id);
        const t = pointOf(e.end, e.id);
        if (c === s || c === t) throw new SketchInputError(`Arc ${e.id} uses its centre as an end`);
        entityParams.set(e.id, uniq([...P(c), ...P(s), ...P(t)]));
        entityMaxDof.set(e.id, s === t ? 3 : 5);
        const cx = values[c] as number;
        const cy = values[c + 1] as number;
        const a0 = Math.atan2((values[s + 1] as number) - cy, (values[s] as number) - cx);
        let a1 = Math.atan2((values[t + 1] as number) - cy, (values[t] as number) - cx);
        while (a1 <= a0) a1 += TAU;
        const r = Math.hypot((values[s] as number) - cx, (values[s + 1] as number) - cy);
        curvePrims.push(
          {
            id: gid(e.id),
            type: 'arc',
            c_id: gid(e.center),
            start_id: gid(e.start),
            end_id: gid(e.end),
            start_angle: a0,
            end_angle: a1,
            radius: r,
          },
          { id: `r:${e.id}`, type: 'arc_rules', a_id: gid(e.id) },
        );
        if (s !== t) {
          pushRow({
            owner: e.id,
            internal: true,
            params: uniq([...P(c), ...P(s), ...P(t)]),
            f: (x) => hyp(x, s, c) - hyp(x, t, c),
            angular: false,
            priority: -1,
          });
        }
        break;
      }
      case 'ellipse': {
        const c = pointOf(e.center, e.id);
        if (!(e.majorRadius >= e.minorRadius && e.minorRadius > 0)) {
          throw new SketchInputError(`Ellipse ${e.id} needs majorRadius ≥ minorRadius > 0`);
        }
        const fd = Math.sqrt(e.majorRadius ** 2 - e.minorRadius ** 2);
        const fx = (values[c] as number) + Math.cos(e.rotation) * fd;
        const fy = (values[c + 1] as number) + Math.sin(e.rotation) * fd;
        const focus = values.length;
        values.push(fx, fy);
        const radmin = values.length;
        values.push(e.minorRadius);
        const fId = `${e.id}#f`;
        pointIdx.set(fId, focus);
        ellipseIdx.set(e.id, { focus, radmin });
        entityParams.set(e.id, [...P(c), focus, focus + 1, radmin]);
        entityMaxDof.set(e.id, 5);
        extent = Math.max(extent, 2 * e.majorRadius);
        primitives.push({ id: gid(fId), type: 'point', x: fx, y: fy, fixed: false });
        curvePrims.push({
          id: gid(e.id),
          type: 'ellipse',
          c_id: gid(e.center),
          focus1_id: gid(fId),
          radmin: e.minorRadius,
        });
        break;
      }
    }
  }
  primitives.push(...refPrims, ...curvePrims);

  const x0 = Float64Array.from(values);
  const grounded = new Uint8Array(values.length);
  for (const i of refParams) grounded[i] = 1;
  const invalid = new Map<Id, string>();
  const active: SketchConstraint[] = [];

  // --- Reference helpers -----------------------------------------------------------------------
  const ent = (id: Id): SketchEntity => {
    const e = index.get(id);
    if (!e) throw new SketchInputError(`Unknown entity ${id}`);
    return e;
  };
  const lineRef = (id: Id): LineRef | null => {
    const e = index.get(id);
    if (e?.kind !== 'line') return null;
    return { id, s: pointOf(e.start, id), e: pointOf(e.end, id) };
  };
  const roundRef = (id: Id): RoundRef | null => {
    const e = index.get(id);
    if (!e) return null;
    if (e.kind === 'circle') {
      const c = pointOf(e.center, id);
      const r = radiusIdx.get(id) as number;
      return { id, kind: 'circle', c, params: [...P(c), r], r: (x) => x[r] as number };
    }
    if (e.kind === 'arc') {
      const c = pointOf(e.center, id);
      const s = pointOf(e.start, id);
      return { id, kind: 'arc', c, params: uniq([...P(c), ...P(s)]), r: (x) => hyp(x, s, c) };
    }
    return null;
  };
  const isPoint = (id: Id) => index.get(id)?.kind === 'point';
  const centerIdx = (id: Id): number | null => {
    const e = index.get(id);
    if (!e) return null;
    if (e.kind === 'point') return pointOf(id, id);
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'ellipse')
      return pointOf(e.center, id);
    return null;
  };

  // Points joined by (enabled) coincident constraints, for endpoint-tangency detection.
  const joined = new Map<Id, Id>();
  const root = (id: Id): Id => {
    let r = id;
    while (joined.has(r) && joined.get(r) !== r) r = joined.get(r) as Id;
    return r;
  };
  for (const c of input.constraints) {
    if (c.kind !== 'coincident' || disabled.has(c.id)) continue;
    const ra = root(c.a);
    const rb = root(c.b);
    if (ra !== rb) joined.set(ra, rb);
  }
  const onCurve = new Map<Id, Id[]>();
  for (const c of input.constraints) {
    if (c.kind !== 'pointOn' || disabled.has(c.id)) continue;
    const list = onCurve.get(c.on);
    if (list) list.push(c.point);
    else onCurve.set(c.on, [c.point]);
  }
  /** Points that lie on an entity by construction: its own ends, plus points put on it. */
  const pointsOnEntity = (id: Id): Id[] => {
    const e = index.get(id);
    const own = e && (e.kind === 'line' || e.kind === 'arc') ? [e.start, e.end] : [];
    return [...own, ...(onCurve.get(id) ?? [])];
  };
  /** A point that is on both `a` and `b` by construction (shared/coincident end, point-on). */
  const sharedEnd = (a: Id, b: Id): Id | null => {
    const ra = new Set(pointsOnEntity(a).map(root));
    for (const p of pointsOnEntity(b)) if (ra.has(root(p))) return p;
    return null;
  };

  // --- Dimensions are measurable whether driving or not -----------------------------------------
  const measures = new Map<Id, Measure>();
  const invalidMeasure = new Map<Id, string>();
  for (const c of input.constraints) {
    if (!('value' in c)) continue;
    try {
      const m = measureOf(c);
      if (typeof m === 'string') invalidMeasure.set(c.id, m);
      else measures.set(c.id, m);
    } catch (err) {
      if (err instanceof SketchInputError) invalidMeasure.set(c.id, err.message);
      else throw err;
    }
  }

  // --- Constraints -----------------------------------------------------------------------------
  for (const c of input.constraints) {
    if (disabled.has(c.id)) continue;
    if ('value' in c && !c.driving) {
      // Reference dimensions are measured after solving and never reach planegcs (PLAN §3).
      const why = invalidMeasure.get(c.id);
      if (why) invalid.set(c.id, why);
      continue;
    }
    try {
      const enc = encode(c);
      if (enc === null) continue;
      if (typeof enc === 'string') {
        invalid.set(c.id, enc);
        continue;
      }
      const ids = constraintRefs(c);
      if (ids.length > 0 && ids.every(isSketchReference)) {
        // Only the origin and axes: nothing can move. True already → ignore; else it can't hold.
        const tolOf = (r: Row) => (r.angular ? 1e-9 : 1e-9 * Math.max(1, extent));
        if (enc.rows.every((r) => Math.abs(r.f(x0)) <= tolOf(r))) continue;
        invalid.set(c.id, 'it only involves the origin and axes, which never move');
        continue;
      }
      active.push(c);
      for (const r of enc.rows) pushRow(r);
      primitives.push(...enc.prims);
    } catch (err) {
      if (err instanceof SketchInputError) invalid.set(c.id, err.message);
      else throw err;
    }
  }

  // Grounding is applied after encoding so `fix` order doesn't matter.
  for (const c of active) {
    if (c.kind !== 'fix') continue;
    for (const i of entityParams.get(c.entity) ?? []) grounded[i] = 1;
  }
  for (const p of primitives) {
    if (p.type === 'point') {
      const i = pointIdx.get(p.id.slice(2));
      if (i !== undefined && grounded[i] && grounded[i + 1]) p.fixed = true;
    }
  }

  const rowsByOwner = new Map<Id, Row[]>();
  for (const r of rows) {
    const list = rowsByOwner.get(r.owner);
    if (list) list.push(r);
    else rowsByOwner.set(r.owner, [r]);
  }

  return {
    input,
    index,
    x0,
    grounded,
    pointIdx,
    radiusIdx,
    ellipseIdx,
    entityParams,
    entityMaxDof,
    rows,
    rowsByOwner,
    primitives,
    active,
    invalid,
    measures,
    lengthScale: Math.max(1, extent),
  };

  /**
   * Encodes one constraint as residual rows + planegcs primitives. Returns null when the
   * constraint is trivially satisfied (e.g. coincident with itself), or a reason string when the
   * combination of entity kinds isn't supported.
   */
  function encode(c: SketchConstraint): { rows: Row[]; prims: SketchPrimitive[] } | string | null {
    const out: Row[] = [];
    const prims: SketchPrimitive[] = [];
    const pr = PRIORITY[c.kind];
    let k = 0;
    const nextId = () => cid(c.id, k++);
    const row = (params: number[], f: (x: Float64Array) => number, angular = false) =>
      out.push({ owner: c.id, internal: false, params: uniq(params), f, angular, priority: pr });

    if ('value' in c) return encodeDimension(c, prims, nextId);
    const g = c as GeometricConstraint;
    switch (g.kind) {
      case 'fix':
        ent(g.entity);
        return { rows: [], prims: [] };
      case 'coincident': {
        const a = pointOf(g.a, g.id);
        const b = pointOf(g.b, g.id);
        if (a === b) return null;
        row([...P(a), ...P(b)], (x) => (x[a] as number) - (x[b] as number));
        row([...P(a), ...P(b)], (x) => (x[a + 1] as number) - (x[b + 1] as number));
        prims.push({ id: nextId(), type: 'p2p_coincident', p1_id: gid(g.a), p2_id: gid(g.b) });
        break;
      }
      case 'pointOn': {
        const p = pointOf(g.point, g.id);
        const on = ent(g.on);
        if (on.kind === 'line') {
          const l = lineRef(g.on) as LineRef;
          if (p === l.s || p === l.e) return null;
          row([...P(p), ...P(l.s), ...P(l.e)], (x) => p2lSigned(x, p, l.s, l.e));
          prims.push({
            id: nextId(),
            type: 'point_on_line_pl',
            p_id: gid(g.point),
            l_id: gid(g.on),
          });
        } else if (on.kind === 'circle' || on.kind === 'arc') {
          const r = roundRef(g.on) as RoundRef;
          if (on.kind === 'arc' && (on.start === g.point || on.end === g.point)) return null;
          row([...P(p), ...r.params], (x) => hyp(x, p, r.c) - r.r(x));
          prims.push(
            on.kind === 'circle'
              ? { id: nextId(), type: 'point_on_circle', p_id: gid(g.point), c_id: gid(g.on) }
              : { id: nextId(), type: 'point_on_arc', p_id: gid(g.point), a_id: gid(g.on) },
          );
        } else if (on.kind === 'ellipse') {
          const el = ellipseIdx.get(on.id) as { focus: number; radmin: number };
          const cc = pointOf(on.center, on.id);
          const f = el.focus;
          const b = el.radmin;
          row([...P(p), ...P(cc), ...P(f), b], (x) => {
            const f2x = 2 * (x[cc] as number) - (x[f] as number);
            const f2y = 2 * (x[cc + 1] as number) - (x[f + 1] as number);
            const a = Math.hypot(hyp(x, f, cc), x[b] as number);
            const px = x[p] as number;
            const py = x[p + 1] as number;
            return hyp(x, p, f) + Math.hypot(px - f2x, py - f2y) - 2 * a;
          });
          prims.push({
            id: nextId(),
            type: 'point_on_ellipse',
            p_id: gid(g.point),
            e_id: gid(g.on),
          });
        } else {
          return 'A point can only lie on a line, circle, arc or ellipse';
        }
        break;
      }
      case 'horizontal':
      case 'vertical': {
        const l = lineRef(g.line);
        if (!l) return `${g.kind} needs a line`;
        const o = g.kind === 'horizontal' ? 1 : 0;
        row([...P(l.s), ...P(l.e)], (x) => (x[l.e + o] as number) - (x[l.s + o] as number));
        prims.push({
          id: nextId(),
          type: g.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l',
          l_id: gid(g.line),
        });
        break;
      }
      case 'horizontalPoints':
      case 'verticalPoints': {
        const a = pointOf(g.a, g.id);
        const b = pointOf(g.b, g.id);
        if (a === b) return null;
        const o = g.kind === 'horizontalPoints' ? 1 : 0;
        row([...P(a), ...P(b)], (x) => (x[b + o] as number) - (x[a + o] as number));
        prims.push({
          id: nextId(),
          type: g.kind === 'horizontalPoints' ? 'horizontal_pp' : 'vertical_pp',
          p1_id: gid(g.a),
          p2_id: gid(g.b),
        });
        break;
      }
      case 'parallel':
      case 'perpendicular': {
        const a = lineRef(g.a);
        const b = lineRef(g.b);
        if (!a || !b) return `${g.kind} needs two lines`;
        if (g.a === g.b)
          return g.kind === 'parallel' ? null : 'A line cannot be perpendicular to itself';
        const par = g.kind === 'parallel';
        row(
          [...P(a.s), ...P(a.e), ...P(b.s), ...P(b.e)],
          (x) => {
            const [ax, ay, al] = dir(x, a);
            const [bx, by, bl] = dir(x, b);
            if (al < 1e-12 || bl < 1e-12) return Number.NaN;
            return (par ? ax * by - ay * bx : ax * bx + ay * by) / (al * bl);
          },
          true,
        );
        prims.push({
          id: nextId(),
          type: par ? 'parallel' : 'perpendicular_ll',
          l1_id: gid(g.a),
          l2_id: gid(g.b),
        });
        break;
      }
      case 'tangent': {
        let la = lineRef(g.a);
        let lb = lineRef(g.b);
        let ra = roundRef(g.a);
        let rb = roundRef(g.b);
        let aId = g.a;
        let bId = g.b;
        if (!la && lb) {
          [la, lb, ra, rb, aId, bId] = [lb, la, rb, ra, bId, aId];
        }
        // Endpoint tangency (the curves share an end): "distance = radius" has a zero gradient
        // there (the shared point already forces distance ≤ radius), so encode the regular
        // condition instead — line ⟂ radius at the joint / centres collinear with the joint.
        const joint = (la || ra) && rb ? sharedEnd(aId, bId) : null;
        if (la && rb && joint !== null) {
          const l = la;
          const c0 = rb.c;
          const pj = pointOf(joint, g.id);
          row(
            [...P(l.s), ...P(l.e), ...P(c0), ...P(pj)],
            (x) => {
              const [dx, dy, dl] = dir(x, l);
              const rx = (x[pj] as number) - (x[c0] as number);
              const ry = (x[pj + 1] as number) - (x[c0 + 1] as number);
              const rl = Math.hypot(rx, ry);
              if (dl < 1e-12 || rl < 1e-12) return Number.NaN;
              return (dx * rx + dy * ry) / (dl * rl);
            },
            true,
          );
          const le = ent(aId) as { start: Id; end: Id };
          const arcE = ent(bId) as { center: Id };
          // The joint's own entity owns the point, so planegcs and our row agree on it.
          prims.push({
            id: nextId(),
            type: 'perpendicular_pppp',
            l1p1_id: gid(le.start),
            l1p2_id: gid(le.end),
            l2p1_id: gid(arcE.center),
            l2p2_id: gid(joint),
          });
        } else if (ra && rb && joint !== null) {
          const c1 = ra.c;
          const c2 = rb.c;
          const pj = pointOf(joint, g.id);
          row([...P(c1), ...P(c2), ...P(pj)], (x) => {
            const ux = (x[pj] as number) - (x[c1] as number);
            const uy = (x[pj + 1] as number) - (x[c1 + 1] as number);
            const ul = Math.hypot(ux, uy);
            if (ul < 1e-12) return Number.NaN;
            const vx = (x[c2] as number) - (x[c1] as number);
            const vy = (x[c2 + 1] as number) - (x[c1 + 1] as number);
            return (ux * vy - uy * vx) / ul;
          });
          prims.push({
            id: nextId(),
            type: 'point_on_line_ppp',
            p_id: gid((ent(bId) as { center: Id }).center),
            lp1_id: gid((ent(aId) as { center: Id }).center),
            lp2_id: gid(joint),
          });
        } else if (la && rb) {
          const l = la;
          const r = rb;
          row([...P(l.s), ...P(l.e), ...r.params], (x) => p2l(x, r.c, l.s, l.e) - r.r(x));
          prims.push(
            r.kind === 'circle'
              ? { id: nextId(), type: 'tangent_lc', l_id: gid(aId), c_id: gid(bId) }
              : { id: nextId(), type: 'tangent_la', l_id: gid(aId), a_id: gid(bId) },
          );
        } else if (ra && rb) {
          if (ra.kind === 'arc' && rb.kind === 'circle') {
            [ra, rb, aId, bId] = [rb, ra, bId, aId];
          }
          const p = ra;
          const q = rb;
          // Same internal/external rule as planegcs' addConstraintTangent(circle, circle).
          const d0 = hyp(x0, p.c, q.c);
          const internal = d0 < p.r(x0) || d0 < q.r(x0);
          row([...p.params, ...q.params], (x) => {
            const d = hyp(x, p.c, q.c);
            return internal ? d - Math.abs(p.r(x) - q.r(x)) : d - (p.r(x) + q.r(x));
          });
          const type =
            p.kind === 'circle'
              ? q.kind === 'circle'
                ? ('tangent_cc' as const)
                : ('tangent_ca' as const)
              : ('tangent_aa' as const);
          if (type === 'tangent_cc')
            prims.push({ id: nextId(), type, c1_id: gid(aId), c2_id: gid(bId) });
          else if (type === 'tangent_ca')
            prims.push({ id: nextId(), type, c_id: gid(aId), a_id: gid(bId) });
          else prims.push({ id: nextId(), type, a1_id: gid(aId), a2_id: gid(bId) });
        } else {
          return 'Tangency is supported between lines, circles and arcs';
        }
        break;
      }
      case 'equal': {
        const la = lineRef(g.a);
        const lb = lineRef(g.b);
        if (g.a === g.b) return null;
        if (isSketchReference(g.a) || isSketchReference(g.b)) return AXIS_NO_LENGTH;
        if (la && lb) {
          row(
            [...P(la.s), ...P(la.e), ...P(lb.s), ...P(lb.e)],
            (x) => hyp(x, la.s, la.e) - hyp(x, lb.s, lb.e),
          );
          prims.push({ id: nextId(), type: 'equal_length', l1_id: gid(g.a), l2_id: gid(g.b) });
          break;
        }
        let ra = roundRef(g.a);
        let rb = roundRef(g.b);
        let aId = g.a;
        let bId = g.b;
        if (ra && rb) {
          if (ra.kind === 'arc' && rb.kind === 'circle') [ra, rb, aId, bId] = [rb, ra, bId, aId];
          const p = ra;
          const q = rb;
          row([...p.params, ...q.params], (x) => p.r(x) - q.r(x));
          if (p.kind === 'circle' && q.kind === 'circle') {
            prims.push({ id: nextId(), type: 'equal_radius_cc', c1_id: gid(aId), c2_id: gid(bId) });
          } else if (p.kind === 'circle') {
            prims.push({ id: nextId(), type: 'equal_radius_ca', c1_id: gid(aId), a2_id: gid(bId) });
          } else {
            prims.push({ id: nextId(), type: 'equal_radius_aa', a1_id: gid(aId), a2_id: gid(bId) });
          }
          break;
        }
        const ea = ellipseIdx.get(g.a);
        const eb = ellipseIdx.get(g.b);
        const ca = centerIdx(g.a);
        const cb = centerIdx(g.b);
        if (ea && eb && ca !== null && cb !== null) {
          row([ea.radmin, eb.radmin], (x) => (x[ea.radmin] as number) - (x[eb.radmin] as number));
          row([...P(ca), ...P(ea.focus), ea.radmin, ...P(cb), ...P(eb.focus), eb.radmin], (x) => {
            const a1 = Math.hypot(hyp(x, ea.focus, ca), x[ea.radmin] as number);
            const a2 = Math.hypot(hyp(x, eb.focus, cb), x[eb.radmin] as number);
            return a1 - a2;
          });
          prims.push({ id: nextId(), type: 'equal_radii_ee', e1_id: gid(g.a), e2_id: gid(g.b) });
          break;
        }
        return 'Equal needs two lines or two circles/arcs (or two ellipses)';
      }
      case 'midpoint': {
        const p = pointOf(g.point, g.id);
        const l = lineRef(g.line);
        if (!l) return 'Midpoint needs a point and a line';
        if (isSketchReference(g.line)) return AXIS_NO_LENGTH;
        if (p === l.s || p === l.e) return 'A line end cannot be its midpoint';
        const ps = [...P(p), ...P(l.s), ...P(l.e)];
        row(ps, (x) => (x[p] as number) - ((x[l.s] as number) + (x[l.e] as number)) / 2);
        row(
          ps,
          (x) => (x[p + 1] as number) - ((x[l.s + 1] as number) + (x[l.e + 1] as number)) / 2,
        );
        const le = ent(g.line) as { start: Id; end: Id };
        prims.push({
          id: nextId(),
          type: 'p2p_symmetric_ppp',
          p1_id: gid(le.start),
          p2_id: gid(le.end),
          p_id: gid(g.point),
        });
        break;
      }
      case 'concentric': {
        const a = centerIdx(g.a);
        const b = centerIdx(g.b);
        if (a === null || b === null) return 'Concentric needs circles, arcs, ellipses or points';
        if (a === b) return null;
        row([...P(a), ...P(b)], (x) => (x[a] as number) - (x[b] as number));
        row([...P(a), ...P(b)], (x) => (x[a + 1] as number) - (x[b + 1] as number));
        const ida = centerId(g.a);
        const idb = centerId(g.b);
        prims.push({ id: nextId(), type: 'p2p_coincident', p1_id: gid(ida), p2_id: gid(idb) });
        break;
      }
      case 'symmetric': {
        const a = pointOf(g.a, g.id);
        const b = pointOf(g.b, g.id);
        if (a === b) return 'Symmetric needs two different points';
        const l = lineRef(g.about);
        if (l) {
          const ps = [...P(a), ...P(b), ...P(l.s), ...P(l.e)];
          // Midpoint of ab on the line, and ab perpendicular to it.
          row(ps, (x) => {
            const [dx, dy, dl] = dir(x, l);
            if (dl < 1e-12) return Number.NaN;
            const mx = ((x[a] as number) + (x[b] as number)) / 2 - (x[l.s] as number);
            const my = ((x[a + 1] as number) + (x[b + 1] as number)) / 2 - (x[l.s + 1] as number);
            return (dx * my - dy * mx) / dl;
          });
          row(ps, (x) => {
            const [dx, dy, dl] = dir(x, l);
            if (dl < 1e-12) return Number.NaN;
            return (
              (dx * ((x[b] as number) - (x[a] as number)) +
                dy * ((x[b + 1] as number) - (x[a + 1] as number))) /
              dl
            );
          });
          prims.push({
            id: nextId(),
            type: 'p2p_symmetric_ppl',
            p1_id: gid(g.a),
            p2_id: gid(g.b),
            l_id: gid(g.about),
          });
        } else if (isPoint(g.about)) {
          const m = pointOf(g.about, g.id);
          const ps = [...P(a), ...P(b), ...P(m)];
          row(ps, (x) => (x[m] as number) - ((x[a] as number) + (x[b] as number)) / 2);
          row(ps, (x) => (x[m + 1] as number) - ((x[a + 1] as number) + (x[b + 1] as number)) / 2);
          prims.push({
            id: nextId(),
            type: 'p2p_symmetric_ppp',
            p1_id: gid(g.a),
            p2_id: gid(g.b),
            p_id: gid(g.about),
          });
        } else {
          return 'Symmetric needs two points and a line (or a point)';
        }
        break;
      }
    }
    return { rows: out, prims };
  }

  function centerId(id: Id): Id {
    const e = ent(id);
    return e.kind === 'point' ? e.id : (e as { center: Id }).center;
  }

  function encodeDimension(
    c: DimensionConstraint,
    prims: SketchPrimitive[],
    nextId: () => string,
  ): { rows: Row[]; prims: SketchPrimitive[] } | string {
    const v = input.values[c.id];
    if (v === undefined || !Number.isFinite(v)) return `Dimension ${c.id} has no resolved value`;
    const m = measures.get(c.id);
    if (!m) return invalidMeasure.get(c.id) ?? 'Unsupported dimension';
    const out: Row[] = [];
    out.push({
      owner: c.id,
      internal: false,
      params: m.params,
      f: m.angular ? (x) => anglePi(m.fn(x) - v) : (x) => m.fn(x) - v,
      angular: m.angular,
      priority: PRIORITY[c.kind],
    });
    switch (c.kind) {
      case 'distance': {
        const pair = distancePair(c.a, c.b);
        if (typeof pair === 'string') return pair;
        const [kind, a, b] = pair;
        if (kind === 'pp')
          prims.push({
            id: nextId(),
            type: 'p2p_distance',
            p1_id: gid(a),
            p2_id: gid(b),
            distance: v,
          });
        else if (kind === 'pl')
          prims.push({
            id: nextId(),
            type: 'p2l_distance',
            p_id: gid(a),
            l_id: gid(b),
            distance: v,
          });
        else if (kind === 'll') {
          const l = ent(a) as { start: Id };
          prims.push({
            id: nextId(),
            type: 'p2l_distance',
            p_id: gid(l.start),
            l_id: gid(b),
            distance: v,
          });
        } else if (kind === 'pc')
          prims.push({
            id: nextId(),
            type: 'p2cdistance',
            p_id: gid(a),
            c_id: gid(b),
            distance: v,
          });
        else if (kind === 'cc')
          prims.push({ id: nextId(), type: 'c2cdistance', c1_id: gid(a), c2_id: gid(b), dist: v });
        else prims.push({ id: nextId(), type: 'c2ldistance', c_id: gid(a), l_id: gid(b), dist: v });
        break;
      }
      case 'hDistance':
      case 'vDistance': {
        const [pa, pb] = axisPair(c.a, c.b) as [Id, Id];
        const prop = c.kind === 'hDistance' ? ('x' as const) : ('y' as const);
        prims.push({
          id: nextId(),
          type: 'difference',
          param1: { o_id: gid(pa), prop },
          param2: { o_id: gid(pb), prop },
          difference: v,
        });
        break;
      }
      case 'length': {
        const l = ent(c.line) as { start: Id; end: Id };
        prims.push({
          id: nextId(),
          type: 'p2p_distance',
          p1_id: gid(l.start),
          p2_id: gid(l.end),
          distance: v,
        });
        break;
      }
      case 'radius':
      case 'diameter': {
        const r = roundRef(c.curve) as RoundRef;
        const radius = c.kind === 'radius' ? v : v / 2;
        prims.push(
          r.kind === 'circle'
            ? { id: nextId(), type: 'circle_radius', c_id: gid(c.curve), radius }
            : { id: nextId(), type: 'arc_radius', a_id: gid(c.curve), radius },
        );
        break;
      }
      case 'angle':
        prims.push({
          id: nextId(),
          type: 'l2l_angle_ll',
          l1_id: gid(c.a),
          l2_id: gid(c.b),
          angle: v,
        });
        break;
    }
    return { rows: out, prims };
  }

  type PairKind = 'pp' | 'pl' | 'll' | 'pc' | 'cc' | 'cl';
  function distancePair(a: Id, b: Id): [PairKind, Id, Id] | string {
    const ea = ent(a);
    const eb = ent(b);
    const round = (e: SketchEntity) => e.kind === 'circle' || e.kind === 'arc';
    if (ea.kind === 'point' && eb.kind === 'point') return ['pp', a, b];
    if (ea.kind === 'point' && eb.kind === 'line') return ['pl', a, b];
    if (ea.kind === 'line' && eb.kind === 'point') return ['pl', b, a];
    if (ea.kind === 'line' && eb.kind === 'line') return ['ll', a, b];
    if (ea.kind === 'point' && round(eb)) return ['pc', a, b];
    if (round(ea) && eb.kind === 'point') return ['pc', b, a];
    if (round(ea) && round(eb)) return ['cc', a, b];
    if (round(ea) && eb.kind === 'line') return ['cl', a, b];
    if (ea.kind === 'line' && round(eb)) return ['cl', b, a];
    return 'Distance needs points, lines, circles or arcs';
  }

  /** Points whose x/y a horizontal/vertical distance compares (line: its start → end). */
  function axisPair(a: Id, b: Id): [Id, Id] | string {
    const ea = ent(a);
    if (a === b) {
      if (isSketchReference(a)) return AXIS_NO_LENGTH;
      if (ea.kind === 'line') return [ea.start, ea.end];
      return 'A horizontal/vertical distance on one entity needs a line';
    }
    const pa = centerOf2(a);
    const pb = centerOf2(b);
    if (pa === null || pb === null) return 'Horizontal/vertical distance needs points or centres';
    return [pa, pb];
  }

  function centerOf2(id: Id): Id | null {
    const e = ent(id);
    if (e.kind === 'point') return id;
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'ellipse') return e.center;
    return null;
  }

  function measureOf(c: DimensionConstraint): Measure | string {
    switch (c.kind) {
      case 'distance': {
        const pair = distancePair(c.a, c.b);
        if (typeof pair === 'string') return pair;
        const [kind, a, b] = pair;
        if (kind === 'pp') {
          const i = pointOf(a, c.id);
          const j = pointOf(b, c.id);
          return { params: uniq([...P(i), ...P(j)]), fn: (x) => hyp(x, i, j), angular: false };
        }
        if (kind === 'pl' || kind === 'll') {
          const l = lineRef(b) as LineRef;
          const p = kind === 'pl' ? pointOf(a, c.id) : (lineRef(a) as LineRef).s;
          return {
            params: uniq([...P(p), ...P(l.s), ...P(l.e)]),
            fn: (x) => p2l(x, p, l.s, l.e),
            angular: false,
          };
        }
        if (kind === 'pc') {
          const p = pointOf(a, c.id);
          const r = roundRef(b) as RoundRef;
          return {
            params: uniq([...P(p), ...r.params]),
            fn: (x) => Math.abs(hyp(x, p, r.c) - r.r(x)),
            angular: false,
          };
        }
        if (kind === 'cc') {
          const p = roundRef(a) as RoundRef;
          const q = roundRef(b) as RoundRef;
          return {
            params: uniq([...p.params, ...q.params]),
            fn: (x) => {
              const d = hyp(x, p.c, q.c);
              const r1 = p.r(x);
              const r2 = q.r(x);
              const big = Math.max(r1, r2);
              return d > big ? d - r1 - r2 : big - d - Math.min(r1, r2);
            },
            angular: false,
          };
        }
        const r = roundRef(a) as RoundRef;
        const l = lineRef(b) as LineRef;
        return {
          params: uniq([...r.params, ...P(l.s), ...P(l.e)]),
          fn: (x) => p2l(x, r.c, l.s, l.e) - r.r(x),
          angular: false,
        };
      }
      case 'hDistance':
      case 'vDistance': {
        const pair = axisPair(c.a, c.b);
        if (typeof pair === 'string') return pair;
        const i = pointOf(pair[0], c.id);
        const j = pointOf(pair[1], c.id);
        const o = c.kind === 'hDistance' ? 0 : 1;
        return {
          params: uniq([...P(i), ...P(j)]),
          fn: (x) => (x[j + o] as number) - (x[i + o] as number),
          angular: false,
        };
      }
      case 'length': {
        const l = lineRef(c.line);
        if (!l) return 'Length needs a line';
        if (isSketchReference(c.line)) return AXIS_NO_LENGTH;
        return {
          params: uniq([...P(l.s), ...P(l.e)]),
          fn: (x) => hyp(x, l.s, l.e),
          angular: false,
        };
      }
      case 'radius':
      case 'diameter': {
        const r = roundRef(c.curve);
        if (!r) return `${c.kind === 'radius' ? 'Radius' : 'Diameter'} needs a circle or arc`;
        const k = c.kind === 'radius' ? 1 : 2;
        return { params: r.params, fn: (x) => k * r.r(x), angular: false };
      }
      case 'angle': {
        const a = lineRef(c.a);
        const b = lineRef(c.b);
        if (!a || !b) return 'Angle needs two lines';
        return {
          params: uniq([...P(a.s), ...P(a.e), ...P(b.s), ...P(b.e)]),
          fn: (x) => lineAngle(x, a, b),
          angular: true,
        };
      }
    }
  }
}

/** Measures a dimension on given geometry; null when it can't be measured (degenerate). */
export function measureDimension(model: SketchModel, id: Id, x: Float64Array): number | null {
  const m = model.measures.get(id);
  if (!m) return null;
  const v = m.fn(x);
  return Number.isFinite(v) ? v : null;
}

/** Writes solved parameters back into contract entities (same ids and order as the input). */
export function entitiesFrom(model: SketchModel, x: Float64Array): SketchEntity[] {
  return model.input.entities.map((e): SketchEntity => {
    switch (e.kind) {
      case 'point': {
        const i = model.pointIdx.get(e.id) as number;
        return { ...e, x: x[i] as number, y: x[i + 1] as number };
      }
      case 'circle': {
        const i = model.radiusIdx.get(e.id) as number;
        return { ...e, radius: Math.abs(x[i] as number) };
      }
      case 'ellipse': {
        const el = model.ellipseIdx.get(e.id) as { focus: number; radmin: number };
        const c = model.pointIdx.get(e.center) as number;
        const fx = (x[el.focus] as number) - (x[c] as number);
        const fy = (x[el.focus + 1] as number) - (x[c + 1] as number);
        const b = Math.abs(x[el.radmin] as number);
        const fd = Math.hypot(fx, fy);
        return {
          ...e,
          minorRadius: b,
          majorRadius: Math.hypot(fd, b),
          rotation: fd > 1e-12 ? Math.atan2(fy, fx) : e.rotation,
        };
      }
      default:
        return { ...e };
    }
  });
}

/** Residual tolerance for a row (mm for length rows, rad for angular rows). */
export function rowTolerance(model: SketchModel, row: Row): number {
  return row.angular ? 1e-7 : 1e-7 * model.lengthScale;
}

/** Rows violated at `x` (NaN counts as violated). */
export function violatedRows(model: SketchModel, x: Float64Array, rows = model.rows): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const v = r.f(x);
    if (!(Math.abs(v) <= rowTolerance(model, r))) out.push(r);
  }
  return out;
}

export function isSatisfied(model: SketchModel, x: Float64Array): boolean {
  for (const r of model.rows) {
    const v = r.f(x);
    if (!(Math.abs(v) <= rowTolerance(model, r))) return false;
  }
  return true;
}
