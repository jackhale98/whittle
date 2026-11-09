/**
 * The solver's internal model of a sketch: a flat parameter vector (mm), the residual equations
 * of every driving constraint (our own, in TS — used to verify planegcs' answer, for DOF/rank
 * analysis and conflict search), the planegcs primitives that encode the same equations, and
 * measurement functions for dimensions (driven/reference values are measured, never solved).
 *
 * Parameters per entity: point (x, y); circle radius; ellipse and elliptic arc focus (x, y) +
 * minor radius (planegcs' own ellipse parametrisation). Lines, arcs, elliptic arcs and splines own
 * no parameters beyond their points; an arc's "start and end are on the same circle" rule and an
 * elliptic arc's "start and end are on the ellipse" rules are internal rows; a spline is a function
 * of its poles (bspline.ts). Constraints may add auxiliary parameters: the curve parameter of a
 * point held on a spline, and the contact point of a tangency away from shared ends
 * (DECISIONS "Sketch curves in the solver").
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type {
  DimensionConstraint,
  GeometricConstraint,
  Id,
  SketchBSpline,
  SketchConstraint,
  SketchEntity,
  SketchSolveInput,
  Vec2,
} from '@wren-cad/contracts';
import { handleCounts, SplineBasis, splineDefError } from './bspline';
import { Namer } from './explain';
import {
  anglePi,
  closestParam,
  indexEntities,
  type ParamCurve,
  paramCurve,
  refineCurveParam,
  TAU,
} from './geometry';
import { encodeOffset, type OffsetContext, offsetMeasure } from './offset-model';
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
  /**
   * False when planegcs has no counterpart for this row (G2 curvature): the solver then finishes
   * planegcs' answer with Newton steps on its own rows.
   */
  gcs?: boolean;
}

/** A spline entity in the parameter vector. */
export interface SplineRef {
  id: Id;
  entity: SketchBSpline;
  basis: SplineBasis;
  /** Index of each pole's x in the parameter vector. */
  poles: Int32Array;
  /** Every pole parameter (deduplicated). */
  params: number[];
}

/** A planegcs sketch parameter (a spline's curve parameter): free when `idx` ≥ 0, else fixed. */
export interface GcsParam {
  name: string;
  /** Model parameter index (−1: a constant pushed as a fixed planegcs parameter). */
  idx: number;
  value: number;
}

/**
 * A spline drawn through points (interpolating; DECISIONS "Sketch B-splines"): its through points
 * are held at its knots, and its `derived` poles are a function of the through points and the
 * free handle poles. The solver may solve those poles downstream of everything else.
 */
export interface InterpolationGroup {
  spline: Id;
  /** The `pointOn` constraints holding the through points at the knots. */
  constraints: Id[];
  /** Parameter indices of the derived poles. */
  derived: number[];
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
  /**
   * Linked (converted) entities to treat as free instead of fixed (conflict search: does the
   * conflict only exist because linked geometry can't move?). A curve frees its points too.
   */
  unlinked?: ReadonlySet<Id>;
}

export interface SketchModel {
  input: SketchSolveInput;
  /** The options the model was built with (so a variant can be rebuilt). */
  options: ModelOptions;
  index: Map<Id, SketchEntity>;
  /** Parameter values taken from the input geometry. */
  x0: Float64Array;
  /** 1 where a `fix` constraint, a linked source or the reference geometry grounds the parameter. */
  grounded: Uint8Array;
  /**
   * Linked (converted) entities that are grounded, top level only: curves, and points that no
   * linked curve uses. Conflict explanations name them ("while Line 1 is linked to the model").
   */
  linked: Id[];
  /** Point id → index of its x (y is +1). Includes internal ellipse foci (`<id>#f`). */
  pointIdx: Map<Id, number>;
  radiusIdx: Map<Id, number>;
  /** Ellipses and elliptic arcs: focus x index and minor radius index. */
  ellipseIdx: Map<Id, { focus: number; radmin: number }>;
  splineIdx: Map<Id, SplineRef>;
  /** planegcs sketch parameters to push before the primitives (spline curve parameters). */
  gcsParams: GcsParam[];
  /** Interpolating splines whose derived poles may be solved downstream. */
  interpolations: InterpolationGroup[];
  /** Some rows have no planegcs counterpart (`Row.gcs === false`). */
  tsOnly: boolean;
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
  curvature: 3,
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
  offset: 10,
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
  let namer: Namer | null = null;
  /** Human name for messages ("Line 2"); never a bare id. */
  const nm = (id: Id): string => {
    if (isSketchReference(id)) return referenceName(id);
    namer ??= new Namer(input.entities);
    return namer.entity(id);
  };
  for (const e of input.entities) {
    if (index.has(e.id)) throw new SketchInputError(`Two entities share the id ${e.id}`);
    if (isReservedSketchId(e.id))
      throw new SketchInputError(`${e.id} is reserved for the sketch's reference geometry`);
    index.set(e.id, e);
  }

  const values: number[] = [];
  const pointIdx = new Map<Id, number>();
  const radiusIdx = new Map<Id, number>();
  const ellipseIdx = new Map<Id, { focus: number; radmin: number }>();
  const splineIdx = new Map<Id, SplineRef>();
  const gcsParams: GcsParam[] = [];
  const entityParams = new Map<Id, number[]>();
  const entityMaxDof = new Map<Id, number>();

  const pointOf = (id: Id, owner: Id): number => {
    const i = pointIdx.get(id);
    if (i === undefined) {
      if (isSketchReference(id))
        throw new SketchInputError(`${cap(referenceName(id))} is not a point`);
      throw new SketchInputError(`${nm(owner)} refers to ${nm(id)}, which is not a point`);
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
      throw new SketchInputError(`${nm(e.id)} has a non-finite position`);
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

  /** An internal focus point + minor radius for an ellipse or elliptic arc. */
  const conicParams = (
    e: Extract<SketchEntity, { kind: 'ellipse' | 'ellipticArc' }>,
    c: number,
  ): { focus: number; radmin: number; fId: Id } => {
    if (
      !(e.majorRadius >= e.minorRadius && e.minorRadius > 0) ||
      !Number.isFinite(e.majorRadius) ||
      !Number.isFinite(e.rotation)
    ) {
      throw new SketchInputError(`${nm(e.id)} needs a major radius ≥ its minor radius > 0`);
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
    extent = Math.max(extent, 2 * e.majorRadius);
    primitives.push({ id: gid(fId), type: 'point', x: fx, y: fy, fixed: false });
    return { focus, radmin, fId };
  };

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
          throw new SketchInputError(`${nm(e.id)} has an invalid radius`);
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
        if (c === s || c === t) throw new SketchInputError(`${nm(e.id)} uses its centre as an end`);
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
        const { focus, radmin, fId } = conicParams(e, c);
        entityParams.set(e.id, [...P(c), focus, focus + 1, radmin]);
        entityMaxDof.set(e.id, 5);
        curvePrims.push({
          id: gid(e.id),
          type: 'ellipse',
          c_id: gid(e.center),
          focus1_id: gid(fId),
          radmin: e.minorRadius,
        });
        break;
      }
      case 'ellipticArc': {
        const c = pointOf(e.center, e.id);
        const s = pointOf(e.start, e.id);
        const t = pointOf(e.end, e.id);
        if (c === s || c === t || s === t)
          throw new SketchInputError(`${nm(e.id)} needs distinct centre, start and end points`);
        const { focus, radmin, fId } = conicParams(e, c);
        entityParams.set(e.id, uniq([...P(c), focus, focus + 1, radmin, ...P(s), ...P(t)]));
        entityMaxDof.set(e.id, 7);
        curvePrims.push(
          {
            id: gid(e.id),
            type: 'arc_of_ellipse',
            c_id: gid(e.center),
            focus1_id: gid(fId),
            start_id: gid(e.start),
            end_id: gid(e.end),
            start_angle: 0,
            end_angle: 1,
            radmin: e.minorRadius,
          },
          { id: `r:${e.id}`, type: 'arc_of_ellipse_rules', a_id: gid(e.id) },
        );
        const ps = [...P(c), focus, focus + 1, radmin];
        for (const q of [s, t]) {
          pushRow({
            owner: e.id,
            internal: true,
            params: uniq([...ps, ...P(q)]),
            f: (x) => onConic(x, q, c, focus, radmin),
            angular: false,
            priority: -1,
          });
        }
        break;
      }
      case 'bspline': {
        const why = splineDefError(e.poles.length, e);
        if (why) throw new SketchInputError(`${nm(e.id)}: ${why}`);
        const poles = Int32Array.from(e.poles.map((id) => pointOf(id, e.id)));
        const params = uniq([...poles].flatMap((i) => P(i)));
        const basis = new SplineBasis(e.poles.length, e);
        splineIdx.set(e.id, { id: e.id, entity: e, basis, poles, params });
        entityParams.set(e.id, params);
        entityMaxDof.set(e.id, params.length);
        curvePrims.push({
          id: gid(e.id),
          type: 'bspline',
          pole_ids: e.poles.map(gid),
          weights: e.weights ? [...e.weights] : e.poles.map(() => 1),
          knots: [...basis.knots],
          mult: [...basis.mults],
          degree: e.degree,
          periodic: e.periodic,
        });
        break;
      }
    }
  }
  primitives.push(...refPrims, ...curvePrims);

  // Geometry as given (aux parameters are appended below; `x0` is rebuilt at the end).
  let x0 = Float64Array.from(values);
  const invalid = new Map<Id, string>();
  const active: SketchConstraint[] = [];
  const geomIndex = indexEntities(input.entities);

  // --- Reference helpers -----------------------------------------------------------------------
  const ent = (id: Id): SketchEntity => {
    const e = index.get(id);
    if (!e) throw new SketchInputError(`${nm(id)} is not in the sketch`);
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
  const conicRef = (id: Id): ConicRef | null => {
    const e = index.get(id);
    if (e?.kind !== 'ellipse' && e?.kind !== 'ellipticArc') return null;
    const el = ellipseIdx.get(id) as { focus: number; radmin: number };
    const c = pointOf(e.center, id);
    return {
      id,
      kind: e.kind,
      c,
      f: el.focus,
      b: el.radmin,
      params: [...P(c), el.focus, el.focus + 1, el.radmin],
    };
  };
  const isPoint = (id: Id) => index.get(id)?.kind === 'point';
  const centerIdx = (id: Id): number | null => {
    const e = index.get(id);
    if (!e) return null;
    if (e.kind === 'point') return pointOf(id, id);
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'ellipse' || e.kind === 'ellipticArc')
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
    let own: Id[] = [];
    if (e && (e.kind === 'line' || e.kind === 'arc' || e.kind === 'ellipticArc'))
      own = [e.start, e.end];
    else if (e?.kind === 'bspline' && !e.periodic)
      own = [e.poles[0] as Id, e.poles[e.poles.length - 1] as Id];
    return [...own, ...(onCurve.get(id) ?? [])];
  };
  /** A point that is on both `a` and `b` by construction (shared/coincident end, point-on). */
  const sharedEnd = (a: Id, b: Id): Id | null => {
    const ra = new Set(pointsOnEntity(a).map(root));
    for (const p of pointsOnEntity(b)) if (ra.has(root(p))) return p;
    return null;
  };

  const offsetCtx: OffsetContext = { index, x0, radiusIdx, pointOf, root, gid };
  const lengthScale = () => Math.max(1, extent);

  // --- Spline curve parameters (pointOn) -------------------------------------------------------
  // Allocated before any constraint is encoded, so a tangent or curvature constraint at a point
  // held on a spline can use that point's curve parameter.
  interface SplineSite {
    /** Model index of a free curve parameter, or −1 when the parameter is the constant `u`. */
    idx: number;
    u: number;
    /** planegcs sketch parameter name. */
    name: string;
  }
  const splineSites = new Map<Id, SplineSite>(); // pointOn constraint id → site
  const knotPoints = new Map<Id, { spline: Id; knot: number }>();
  for (const c of input.constraints) {
    if (c.kind !== 'pointOn' || disabled.has(c.id)) continue;
    const sp = splineIdx.get(c.on);
    const pi = pointIdx.get(c.point);
    if (!sp || pi === undefined) continue;
    const e = sp.entity;
    if (!e.periodic && (c.point === e.poles[0] || c.point === e.poles[e.poles.length - 1]))
      continue; // a clamped spline's end poles are on it
    const p: Vec2 = [values[pi] as number, values[pi + 1] as number];
    const curve = paramCurve(geomIndex, e) as ParamCurve;
    // A through point (an interpolating spline's point at a knot) stays at its knot.
    if (e.knots) {
      let bestK = Number.NaN;
      let bestD = Number.POSITIVE_INFINITY;
      for (const k of sp.basis.innerKnots()) {
        const q = curve.at(k);
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      if (bestD <= KNOT_POINT_TOL * lengthScale()) {
        splineSites.set(c.id, { idx: -1, u: bestK, name: `k:${c.id}` });
        knotPoints.set(c.id, { spline: e.id, knot: bestK });
        gcsParams.push({ name: `k:${c.id}`, idx: -1, value: bestK });
        continue;
      }
    }
    const u = closestParam(curve, p, 16 * Math.max(1, sp.basis.knots.length));
    const idx = values.length;
    values.push(u);
    splineSites.set(c.id, { idx, u, name: `u:${c.id}` });
    gcsParams.push({ name: `u:${c.id}`, idx, value: u });
  }
  /** Where point `pid` sits on spline `sid`: an end of a clamped spline, or a curve parameter. */
  const splineSiteOf = (sid: Id, pid: Id): 'start' | 'end' | SplineSite | null => {
    const sp = splineIdx.get(sid) as SplineRef;
    const e = sp.entity;
    const r = root(pid);
    if (!e.periodic) {
      if (root(e.poles[0] as Id) === r) return 'start';
      if (root(e.poles[e.poles.length - 1] as Id) === r) return 'end';
    }
    for (const c of input.constraints) {
      if (c.kind !== 'pointOn' || c.on !== sid || disabled.has(c.id)) continue;
      if (root(c.point) !== r) continue;
      const site = splineSites.get(c.id);
      if (site) return site;
    }
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

  // Every parameter is known now (constraints may have added auxiliary ones).
  x0 = Float64Array.from(values);
  const grounded = new Uint8Array(values.length);
  for (const i of refParams) grounded[i] = 1;

  // Grounding is applied after encoding so `fix` order doesn't matter.
  for (const c of active) {
    if (c.kind !== 'fix') continue;
    for (const i of entityParams.get(c.entity) ?? []) grounded[i] = 1;
  }
  // Linked (converted) geometry is fixed for the solver (contracts: `EntityBase.source`).
  const freed = new Set(options.unlinked ?? []);
  for (const e of input.entities) {
    if (!e.source || !freed.has(e.id) || e.kind === 'point') continue;
    for (const p of entityPoints(e)) freed.add(p);
  }
  const linkedCurvePoints = new Set<Id>();
  for (const e of input.entities) {
    if (!e.source || e.kind === 'point') continue;
    for (const p of entityPoints(e)) linkedCurvePoints.add(p);
  }
  const linked: Id[] = [];
  for (const e of input.entities) {
    if (!e.source) continue;
    if (e.kind !== 'point' || !linkedCurvePoints.has(e.id)) linked.push(e.id);
    if (freed.has(e.id)) continue;
    for (const i of entityParams.get(e.id) ?? []) grounded[i] = 1;
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

  // Interpolating splines (the tool's layout: every inner knot holds one through point).
  const interpolations: InterpolationGroup[] = [];
  const activeIds = new Set(active.map((c) => c.id));
  for (const sp of splineIdx.values()) {
    const e = sp.entity;
    if (!e.knots) continue;
    const at = [...knotPoints].filter(([id, k]) => k.spline === e.id && activeIds.has(id));
    const inner = sp.basis.innerKnots();
    const used = new Set(at.map(([, k]) => k.knot));
    if (at.length !== inner.length || used.size !== inner.length) continue;
    const n = e.poles.length;
    const p = e.degree;
    let derivedPoles: number[];
    if (e.periodic) {
      if (n !== inner.length) continue;
      derivedPoles = Array.from({ length: n }, (_, i) => i);
    } else {
      if (n !== inner.length + p + 1) continue;
      const [h1, h2] = handleCounts(p);
      derivedPoles = [];
      for (let i = 1 + h1; i <= n - 2 - h2; i++) derivedPoles.push(i);
    }
    const derived = uniq(derivedPoles.flatMap((i) => P(sp.poles[i] as number)));
    if (derived.some((i) => grounded[i])) continue;
    interpolations.push({ spline: e.id, constraints: at.map(([id]) => id), derived });
  }

  return {
    input,
    options,
    index,
    x0,
    grounded,
    linked,
    pointIdx,
    radiusIdx,
    ellipseIdx,
    splineIdx,
    gcsParams,
    interpolations,
    tsOnly: rows.some((r) => r.gcs === false),
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

  // --- Curve helpers for the M3.5 encodings ------------------------------------------------------

  /** A curve as the new encodings see it. */
  function curveRef(id: Id): CurveRef | null {
    const l = lineRef(id);
    if (l) return { k: 'line', id, line: l, params: uniq([...P(l.s), ...P(l.e)]) };
    const r = roundRef(id);
    if (r) return { k: 'round', id, round: r, params: r.params };
    const q = conicRef(id);
    if (q) return { k: 'conic', id, conic: q, params: q.params };
    const sp = splineIdx.get(id);
    if (sp) return { k: 'spline', id, spline: sp, params: sp.params };
    return null;
  }

  /**
   * The tangent (in planegcs' curve direction: lines start → end, circles and conics CCW, splines
   * increasing u) and curvature vector of `ref` at point `pj` lying on it by construction, plus how
   * planegcs refers to the curve there. Null when `pj` isn't a known site of a spline.
   */
  function siteOf(ref: CurveRef, pj: number, pjId: Id, owner: Id): Site | string {
    switch (ref.k) {
      case 'line': {
        const l = ref.line;
        return {
          params: ref.params,
          t: (x) => {
            const [dx, dy] = dir(x, l);
            return [dx, dy];
          },
          k: () => [0, 0],
          crv: gid(ref.id),
          ends: (() => {
            const le = ent(ref.id) as { start: Id; end: Id };
            return [le.start, le.end] as [Id, Id];
          })(),
        };
      }
      case 'round': {
        const r = ref.round;
        return {
          params: uniq([...r.params, ...P(pj)]),
          t: (x) => [-((x[pj + 1] as number) - (x[r.c + 1] as number)), (x[pj] as number) - (x[r.c] as number)],
          k: (x) => {
            const rx = (x[r.c] as number) - (x[pj] as number);
            const ry = (x[r.c + 1] as number) - (x[pj + 1] as number);
            const r2 = rx * rx + ry * ry;
            return [rx / r2, ry / r2];
          },
          crv: gid(ref.id),
          center: (ent(ref.id) as { center: Id }).center,
        };
      }
      case 'conic': {
        const q = ref.conic;
        return {
          params: uniq([...q.params, ...P(pj)]),
          t: (x) => {
            const n = conicNormal(x, q, pj);
            return [n[1], -n[0]];
          },
          k: (x) => conicCurvature(x, q, pj),
          crv: gid(ref.id),
        };
      }
      case 'spline': {
        const sp = ref.spline;
        const where = splineSiteOf(ref.id, pjId);
        if (where === null)
          return `${nm(owner)} needs ${nm(pjId)} to be an end of ${nm(ref.id)} or a point held on it`;
        const n = sp.poles.length;
        if (where === 'start' || where === 'end') {
          const u = where === 'start' ? sp.basis.lo : sp.basis.hi;
          const [i0, i1] = where === 'start' ? [0, 1] : [n - 2, n - 1];
          const a = sp.poles[i0] as number;
          const b = sp.poles[i1] as number;
          const support = sp.basis.support(u).flatMap((i) => P(sp.poles[i] as number));
          return {
            params: uniq([...P(a), ...P(b)]),
            kParams: uniq([...support, ...P(a), ...P(b)]),
            t: (x) => [(x[b] as number) - (x[a] as number), (x[b + 1] as number) - (x[a + 1] as number)],
            k: (x) => splineCurvature(x, sp, u),
            crv: `h:${owner}:${sp.id}`,
            line: [sp.entity.poles[i0] as Id, sp.entity.poles[i1] as Id],
            ends: [sp.entity.poles[i0] as Id, sp.entity.poles[i1] as Id],
            end: where,
          };
        }
        const site = where;
        const params = site.idx >= 0 ? uniq([...sp.params, site.idx]) : uniq([...sp.basis.support(site.u)].flatMap((i) => P(sp.poles[i] as number)));
        const uOf = (x: Float64Array) => (site.idx >= 0 ? (x[site.idx] as number) : site.u);
        return {
          params,
          t: (x) => {
            const r = evalSpline(x, sp, uOf(x), 1);
            return [r[2] as number, r[3] as number];
          },
          k: (x) => splineCurvature(x, sp, uOf(x)),
          crv: gid(ref.id),
          param: site.name,
        };
      }
    }
  }

  /** planegcs primitives for "the tangents of a and b at point `p` are parallel" (+ helper lines). */
  function angleAtPoint(sa: Site, sb: Site, p: Id, angle: number, nextId: () => string): SketchPrimitive[] {
    const out: SketchPrimitive[] = [];
    for (const s of [sa, sb]) {
      if (s.line) out.push({ id: s.crv, type: 'line', p1_id: gid(s.line[0]), p2_id: gid(s.line[1]) });
    }
    // Straight against straight, or against a circle: planegcs' exact line constraints.
    if (sa.ends && sb.ends) {
      out.push({ id: nextId(), type: 'parallel', l1_id: sa.crv, l2_id: sb.crv });
      return out;
    }
    const straight = sa.ends ? sa : sb.ends ? sb : null;
    const round = sa.center ? sa : sb.center ? sb : null;
    if (straight?.ends && round?.center) {
      out.push({
        id: nextId(),
        type: 'perpendicular_pppp',
        l1p1_id: gid(straight.ends[0]),
        l1p2_id: gid(straight.ends[1]),
        l2p1_id: gid(round.center),
        l2p2_id: gid(p),
      });
      return out;
    }
    if (sa.param && sb.param) {
      out.push({
        id: nextId(),
        type: 'angle_via_point_and_two_params',
        crv1_id: sa.crv,
        crv2_id: sb.crv,
        p_id: gid(p),
        cparam1: sa.param,
        cparam2: sb.param,
        angle,
      });
    } else if (sa.param || sb.param) {
      const [s1, s2] = sa.param ? [sa, sb] : [sb, sa];
      out.push({
        id: nextId(),
        type: 'angle_via_point_and_param',
        crv1_id: s1.crv,
        crv2_id: s2.crv,
        p_id: gid(p),
        cparam: s1.param as string,
        angle,
      });
    } else {
      out.push({ id: nextId(), type: 'angle_via_point', crv1_id: sa.crv, crv2_id: sb.crv, p_id: gid(p), angle });
    }
    return out;
  }

  /** Joint tangency of two curves at a shared point (the M3.5 pairs): one regular angular row. */
  function encodeJointTangent(
    g: Extract<GeometricConstraint, { kind: 'tangent' | 'curvature' }>,
    a: CurveRef,
    b: CurveRef,
    joint: Id,
    out: Row[],
    prims: SketchPrimitive[],
    nextId: () => string,
  ): { sa: Site; sb: Site; pj: number } | string {
    const pj = pointOf(joint, g.id);
    const sa = siteOf(a, pj, joint, g.id);
    if (typeof sa === 'string') return sa;
    const sb = siteOf(b, pj, joint, g.id);
    if (typeof sb === 'string') return sb;
    out.push({
      owner: g.id,
      internal: false,
      params: uniq([...sa.params, ...sb.params, ...P(pj)]),
      f: (x) => unitCross(sa.t(x), sb.t(x)),
      angular: true,
      priority: PRIORITY[g.kind],
    });
    const ta = sa.t(x0snapshot());
    const tb = sb.t(x0snapshot());
    const angle = ta[0] * tb[0] + ta[1] * tb[1] >= 0 ? 0 : Math.PI;
    prims.push(...angleAtPoint(sa, sb, joint, angle, nextId));
    return { sa, sb, pj };
  }

  /** The current parameter vector (aux parameters included). */
  function x0snapshot(): Float64Array {
    return values.length === x0.length ? x0 : Float64Array.from(values);
  }

  /** "Point i lies on curve ref" rows (+ planegcs primitive); splines need a curve parameter. */
  function onRows(
    ref: CurveRef,
    pi: number,
    pId: Id,
    owner: Id,
    pr: number,
    uIdx: number,
    uName: string,
    nextId: () => string,
  ): { rows: Row[]; prims: SketchPrimitive[] } {
    const rows: Row[] = [];
    const prims: SketchPrimitive[] = [];
    const row = (params: number[], f: (x: Float64Array) => number) =>
      rows.push({ owner, internal: false, params: uniq(params), f, angular: false, priority: pr });
    switch (ref.k) {
      case 'line': {
        const l = ref.line;
        row([...P(pi), ...P(l.s), ...P(l.e)], (x) => p2lSigned(x, pi, l.s, l.e));
        prims.push({ id: nextId(), type: 'point_on_line_pl', p_id: gid(pId), l_id: gid(ref.id) });
        break;
      }
      case 'round': {
        const r = ref.round;
        row([...P(pi), ...r.params], (x) => hyp(x, pi, r.c) - r.r(x));
        prims.push(
          r.kind === 'circle'
            ? { id: nextId(), type: 'point_on_circle', p_id: gid(pId), c_id: gid(ref.id) }
            : { id: nextId(), type: 'point_on_arc', p_id: gid(pId), a_id: gid(ref.id) },
        );
        break;
      }
      case 'conic': {
        const q = ref.conic;
        row([...P(pi), ...q.params], (x) => onConic(x, pi, q.c, q.f, q.b));
        prims.push({ id: nextId(), type: 'point_on_ellipse', p_id: gid(pId), e_id: gid(ref.id) });
        break;
      }
      case 'spline': {
        const sp = ref.spline;
        const params = [...P(pi), ...sp.params, uIdx];
        for (const k of [0, 1]) {
          row(params, (x) => (x[pi + k] as number) - (evalSpline(x, sp, x[uIdx] as number, 0)[k] as number));
        }
        prims.push({ id: nextId(), type: 'point_on_bspline', p_id: gid(pId), b_id: gid(ref.id), pointparam: uName });
        break;
      }
    }
    return { rows, prims };
  }

  /**
   * Tangency away from shared points, for pairs involving an ellipse, elliptic arc or spline: an
   * auxiliary contact point on both curves where their tangents are parallel (planegcs:
   * point-on-curve twice + angle via point), seeded at the closest approach of the two curves.
   */
  function encodeContactTangent(
    g: Extract<GeometricConstraint, { kind: 'tangent' }>,
    a: CurveRef,
    b: CurveRef,
    out: Row[],
    prims: SketchPrimitive[],
    nextId: () => string,
  ): string | null {
    const ca = paramCurve(geomIndex, ent(a.id));
    const cb = paramCurve(geomIndex, ent(b.id));
    if (!ca || !cb) return 'Tangency needs two curves';
    const [ta, tb] = closestPair(ca, cb);
    const pa = ca.at(ta);
    const pb = cb.at(tb);
    const tId = `${g.id}#t`;
    const ti = values.length;
    values.push((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2);
    pointIdx.set(tId, ti);
    prims.push({ id: gid(tId), type: 'point', x: values[ti] as number, y: values[ti + 1] as number, fixed: false });
    const pr = PRIORITY.tangent;
    const sites: Site[] = [];
    for (const [ref, t] of [
      [a, ta],
      [b, tb],
    ] as const) {
      let uIdx = -1;
      let uName = '';
      if (ref.k === 'spline') {
        uIdx = values.length;
        values.push(t);
        uName = `u:${g.id}:${ref.id === a.id ? 'a' : 'b'}`;
        gcsParams.push({ name: uName, idx: uIdx, value: t });
      }
      const on = onRows(ref, ti, tId, g.id, pr, uIdx, uName, nextId);
      out.push(...on.rows);
      prims.push(...on.prims);
      if (ref.k === 'spline') {
        const sp = ref.spline;
        const u = uIdx;
        sites.push({
          params: [...sp.params, u],
          t: (x) => {
            const r = evalSpline(x, sp, x[u] as number, 1);
            return [r[2] as number, r[3] as number];
          },
          k: (x) => splineCurvature(x, sp, x[u] as number),
          crv: gid(ref.id),
          param: uName,
        });
      } else {
        const s = siteOf(ref, ti, tId, g.id);
        if (typeof s === 'string') return s;
        sites.push(s);
      }
    }
    const [sa, sb] = sites as [Site, Site];
    out.push({
      owner: g.id,
      internal: false,
      params: uniq([...sa.params, ...sb.params, ...P(ti)]),
      f: (x) => unitCross(sa.t(x), sb.t(x)),
      angular: true,
      priority: pr,
    });
    const xs = x0snapshot();
    const va = sa.t(xs);
    const vb = sb.t(xs);
    prims.push(...angleAtPoint(sa, sb, tId, va[0] * vb[0] + va[1] * vb[1] >= 0 ? 0 : Math.PI, nextId));
    return null;
  }

  /** G2: tangent at the shared point plus equal curvature vectors there (DECISIONS "G2"). */
  function encodeCurvature(
    g: Extract<GeometricConstraint, { kind: 'curvature' }>,
    out: Row[],
    prims: SketchPrimitive[],
    nextId: () => string,
  ): string | null {
    if (g.a === g.b) return 'A curve cannot be curvature-continuous with itself';
    const a = curveRef(g.a);
    const b = curveRef(g.b);
    if (!a || !b) return 'Curvature continuity (G2) joins two curves';
    if (a.k !== 'spline' && b.k !== 'spline')
      return 'Curvature continuity (G2) needs a spline on at least one side';
    const joint = sharedEnd(g.a, g.b);
    if (joint === null)
      return `Curvature continuity (G2) needs ${nm(g.a)} and ${nm(g.b)} to share an end point`;
    const t = encodeJointTangent(g, a, b, joint, out, prims, nextId);
    if (typeof t === 'string') return t;
    const { sa, sb, pj } = t;
    const L = lengthScale();
    const L2 = L * L;
    const row: Row = {
      owner: g.id,
      internal: false,
      params: uniq([...(sa.kParams ?? sa.params), ...(sb.kParams ?? sb.params), ...P(pj)]),
      f: (x) => {
        const ta = sa.t(x);
        const tl = Math.hypot(ta[0], ta[1]);
        if (!(tl > 0)) return Number.NaN;
        const ka = sa.k(x);
        const kb = sb.k(x);
        // Signed along A's left normal (both are normal to the common tangent under G1).
        return (((ka[0] - kb[0]) * -ta[1] + (ka[1] - kb[1]) * ta[0]) / tl) * L2;
      },
      angular: false,
      priority: PRIORITY.curvature,
      gcs: false,
    };
    // A straight side: the spline's second control leg continues the line (expressible).
    const splineEnd = a.k === 'line' ? sb : b.k === 'line' ? sa : null;
    if (splineEnd?.end) {
      const sp = (a.k === 'spline' ? a : b) as Extract<CurveRef, { k: 'spline' }>;
      const n = sp.spline.poles.length;
      const ids = sp.spline.entity.poles;
      if (n < 3 || sp.spline.entity.degree < 2) return null; // straight: zero curvature already
      {
        const [p0, p1, p2] =
          splineEnd.end === 'start' ? [ids[0], ids[1], ids[2]] : [ids[n - 1], ids[n - 2], ids[n - 3]];
        const i0 = pointOf(p0 as Id, g.id);
        const i1 = pointOf(p1 as Id, g.id);
        const i2 = pointOf(p2 as Id, g.id);
        row.params = uniq([...row.params, ...P(i0), ...P(i1), ...P(i2)]);
        row.f = (x) => p2lSigned(x, i2, i0, i1);
        row.gcs = true;
        prims.push({ id: nextId(), type: 'point_on_line_ppp', p_id: gid(p2 as Id), lp1_id: gid(p0 as Id), lp2_id: gid(p1 as Id) });
      }
    }
    out.push(row);
    return null;
  }

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
        } else if (on.kind === 'ellipse' || on.kind === 'ellipticArc') {
          if (on.kind === 'ellipticArc' && (on.start === g.point || on.end === g.point)) return null;
          const q = conicRef(g.on) as ConicRef;
          row([...P(p), ...q.params], (x) => onConic(x, p, q.c, q.f, q.b));
          prims.push({
            id: nextId(),
            type: 'point_on_ellipse',
            p_id: gid(g.point),
            e_id: gid(g.on),
          });
        } else if (on.kind === 'bspline') {
          const sp = splineIdx.get(on.id) as SplineRef;
          const site = splineSites.get(g.id);
          if (!site) return null; // a clamped spline's end pole
          if (site.idx >= 0) {
            const u = site.idx;
            const ps = [...P(p), ...sp.params, u];
            for (const k of [0, 1])
              row(ps, (x) => (x[p + k] as number) - (evalSpline(x, sp, x[u] as number, 0)[k] as number));
          } else {
            // A through point at its knot: only the poles of that knot's span move it.
            const uk = site.u;
            const ps = [...P(p), ...sp.basis.support(uk).flatMap((i) => P(sp.poles[i] as number))];
            for (const k of [0, 1])
              row(ps, (x) => (x[p + k] as number) - (evalSpline(x, sp, uk, 0)[k] as number));
          }
          prims.push({
            id: nextId(),
            type: 'point_on_bspline',
            p_id: gid(g.point),
            b_id: gid(g.on),
            pointparam: site.name,
          });
        } else {
          return 'A point can only lie on a curve';
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
      case 'curvature': {
        const why = encodeCurvature(g, out, prims, nextId);
        if (why) return why;
        break;
      }
      case 'tangent': {
        if (g.a === g.b) return 'A curve cannot be tangent to itself';
        const ca = curveRef(g.a);
        const cb = curveRef(g.b);
        if (!ca || !cb) return 'Tangency needs two curves';
        if (ca.k === 'line' && cb.k === 'line') return 'Two lines cannot be tangent (make them collinear)';
        if (ca.k === 'conic' || ca.k === 'spline' || cb.k === 'conic' || cb.k === 'spline') {
          const joint = sharedEnd(g.a, g.b);
          if (joint !== null) {
            const t = encodeJointTangent(g, ca, cb, joint, out, prims, nextId);
            if (typeof t === 'string') return t;
          } else {
            const why = encodeContactTangent(g, ca, cb, out, prims, nextId);
            if (why) return why;
          }
          break;
        }
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
          return 'Tangency needs two curves';
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
        const ca = conicRef(g.a)?.c ?? null;
        const cb = conicRef(g.b)?.c ?? null;
        if (ea && eb && ca !== null && cb !== null) {
          row([ea.radmin, eb.radmin], (x) => (x[ea.radmin] as number) - (x[eb.radmin] as number));
          row([...P(ca), ...P(ea.focus), ea.radmin, ...P(cb), ...P(eb.focus), eb.radmin], (x) => {
            const a1 = Math.hypot(hyp(x, ea.focus, ca), x[ea.radmin] as number);
            const a2 = Math.hypot(hyp(x, eb.focus, cb), x[eb.radmin] as number);
            return a1 - a2;
          });
          if (ent(g.a).kind === 'ellipse' && ent(g.b).kind === 'ellipse') {
            prims.push({ id: nextId(), type: 'equal_radii_ee', e1_id: gid(g.a), e2_id: gid(g.b) });
          } else {
            // planegcs' equal radii rejects arcs of ellipses: equal minor radii and equal
            // centre–focus distances (helper lines) say the same.
            const ha = `h:${g.id}:a`;
            const hb = `h:${g.id}:b`;
            const ce = (id: Id) => (ent(id) as { center: Id }).center;
            prims.push(
              { id: ha, type: 'line', p1_id: gid(ce(g.a)), p2_id: gid(`${g.a}#f`) },
              { id: hb, type: 'line', p1_id: gid(ce(g.b)), p2_id: gid(`${g.b}#f`) },
              { id: nextId(), type: 'equal_length', l1_id: ha, l2_id: hb },
              {
                id: nextId(),
                type: 'equal',
                param1: { o_id: gid(g.a), prop: 'radmin' },
                param2: { o_id: gid(g.b), prop: 'radmin' },
              },
            );
          }
          break;
        }
        return 'Equal needs two lines, two circles or arcs, or two ellipses or elliptic arcs';
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
        if (a === null || b === null)
          return 'Concentric needs circles, arcs, ellipses, elliptic arcs or points';
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
    if (v === undefined || !Number.isFinite(v)) return 'its value could not be evaluated';
    const m = measures.get(c.id);
    if (!m) return invalidMeasure.get(c.id) ?? 'Unsupported dimension';
    if (c.kind === 'offset') return encodeOffset(offsetCtx, c, v, PRIORITY.offset, nextId);
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
        else if (kind === 'pe')
          prims.push({
            id: nextId(),
            type: 'equal',
            param1: { o_id: gid(b), prop: 'radmin' },
            param2: v,
          });
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
        const radius = c.kind === 'radius' ? v : v / 2;
        if (conicRef(c.curve)) {
          // The major radius √(|CF|² + b²): no planegcs counterpart (its internal alignment of a
          // vertex point ignores the vertex kind in this build), so Newton finishes it.
          (out[0] as Row).gcs = false;
          break;
        }
        const r = roundRef(c.curve) as RoundRef;
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

  type PairKind = 'pp' | 'pl' | 'll' | 'pc' | 'cc' | 'cl' | 'pe';
  function distancePair(a: Id, b: Id): [PairKind, Id, Id] | string {
    const ea = ent(a);
    const eb = ent(b);
    const round = (e: SketchEntity) => e.kind === 'circle' || e.kind === 'arc';
    const conic = (e: SketchEntity): e is Extract<SketchEntity, { kind: 'ellipse' | 'ellipticArc' }> =>
      e.kind === 'ellipse' || e.kind === 'ellipticArc';
    // From an ellipse's own centre the nearest point of the curve is a minor vertex: the minor
    // radius (DECISIONS "Ellipse dimensions"). Other point–ellipse distances are not supported.
    for (const [p, q] of [
      [ea, eb],
      [eb, ea],
    ] as const) {
      if (p.kind !== 'point' || !conic(q)) continue;
      if (root(p.id) === root(q.center)) return ['pe', p.id, q.id];
      return `A distance to ${nm(q.id)} is measured from its centre (its minor radius)`;
    }
    if (conic(ea) || conic(eb) || ea.kind === 'bspline' || eb.kind === 'bspline')
      return 'Distance needs points, lines, circles or arcs (or an ellipse and its centre)';
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
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'ellipse' || e.kind === 'ellipticArc')
      return e.center;
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
        if (kind === 'pe') {
          const q = conicRef(b) as ConicRef;
          return { params: [q.b], fn: (x) => Math.abs(x[q.b] as number), angular: false };
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
        const q = conicRef(c.curve);
        if (q) {
          // An ellipse's radius / diameter is its major one (DECISIONS "Ellipse dimensions").
          const k = c.kind === 'radius' ? 1 : 2;
          return {
            params: q.params,
            fn: (x) => k * Math.hypot(hyp(x, q.f, q.c), x[q.b] as number),
            angular: false,
          };
        }
        const r = roundRef(c.curve);
        if (!r)
          return `${c.kind === 'radius' ? 'Radius' : 'Diameter'} needs a circle, arc, ellipse or elliptic arc`;
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
      case 'offset':
        return offsetMeasure(offsetCtx, c);
    }
  }
}

/** A point within this × the sketch size of a knot's curve point is held at that knot. */
const KNOT_POINT_TOL = 1e-6;

interface ConicRef {
  id: Id;
  kind: 'ellipse' | 'ellipticArc';
  c: number;
  f: number;
  b: number;
  params: number[];
}

type CurveRef =
  | { k: 'line'; id: Id; line: LineRef; params: number[] }
  | { k: 'round'; id: Id; round: RoundRef; params: number[] }
  | { k: 'conic'; id: Id; conic: ConicRef; params: number[] }
  | { k: 'spline'; id: Id; spline: SplineRef; params: number[] };

/** A curve at a point: tangent and curvature vector there, and planegcs' handle on it. */
interface Site {
  /** Parameters the tangent depends on. */
  params: number[];
  /** Parameters the curvature vector depends on (defaults to `params`). */
  kParams?: number[];
  t: (x: Float64Array) => [number, number];
  k: (x: Float64Array) => [number, number];
  /** planegcs curve id (a helper line for a spline end). */
  crv: string;
  /** Helper line through a spline's end leg (start → end in the curve direction). */
  line?: [Id, Id];
  /** A clamped spline's start or end. */
  end?: 'start' | 'end';
  /** planegcs sketch parameter of a point on a spline. */
  param?: string;
  /** Straight sites (a line, a spline's end leg): the two points of the direction. */
  ends?: [Id, Id];
  /** Circles and arcs: the centre point. */
  center?: Id;
}

/** Focal residual of point p on the ellipse (c, focus f, minor radius b): |pF1| + |pF2| − 2a. */
function onConic(x: Float64Array, p: number, c: number, f: number, b: number): number {
  const f2x = 2 * (x[c] as number) - (x[f] as number);
  const f2y = 2 * (x[c + 1] as number) - (x[f + 1] as number);
  const a = Math.hypot(hyp(x, f, c), x[b] as number);
  const px = x[p] as number;
  const py = x[p + 1] as number;
  return hyp(x, p, f) + Math.hypot(px - f2x, py - f2y) - 2 * a;
}

/** Inward normal of an ellipse at a point on it: the sum of the unit vectors to the foci. */
function conicNormal(x: Float64Array, q: ConicRef, p: number): [number, number] {
  const px = x[p] as number;
  const py = x[p + 1] as number;
  const f1x = (x[q.f] as number) - px;
  const f1y = (x[q.f + 1] as number) - py;
  const f2x = 2 * (x[q.c] as number) - (x[q.f] as number) - px;
  const f2y = 2 * (x[q.c + 1] as number) - (x[q.f + 1] as number) - py;
  const l1 = Math.hypot(f1x, f1y);
  const l2 = Math.hypot(f2x, f2y);
  return [f1x / l1 + f2x / l2, f1y / l1 + f2y / l2];
}

/** Curvature vector of an ellipse at a point on it: κ = ab / (r1 r2)^{3/2}, towards the inside. */
function conicCurvature(x: Float64Array, q: ConicRef, p: number): [number, number] {
  const b = x[q.b] as number;
  const a = Math.hypot(hyp(x, q.f, q.c), b);
  const px = x[p] as number;
  const py = x[p + 1] as number;
  const r1 = Math.hypot((x[q.f] as number) - px, (x[q.f + 1] as number) - py);
  const r2 = Math.hypot(
    2 * (x[q.c] as number) - (x[q.f] as number) - px,
    2 * (x[q.c + 1] as number) - (x[q.f + 1] as number) - py,
  );
  const k = (a * b) / (r1 * r2) ** 1.5;
  const n = conicNormal(x, q, p);
  const nl = Math.hypot(n[0], n[1]);
  return [(k * n[0]) / nl, (k * n[1]) / nl];
}

const splineBuf = new Float64Array(6);

/** Spline point and derivatives from the parameter vector (shared buffer: copy what you keep). */
function evalSpline(x: Float64Array, sp: SplineRef, u: number, order: number): Float64Array {
  const poles = sp.poles;
  return sp.basis.evaluate(
    u,
    order,
    (i) => x[poles[i] as number] as number,
    (i) => x[(poles[i] as number) + 1] as number,
    splineBuf,
  );
}

/** Curvature vector of a spline at u: (C″ − (C″·T) T) / |C′|². */
function splineCurvature(x: Float64Array, sp: SplineRef, u: number): [number, number] {
  const r = evalSpline(x, sp, u, 2);
  const dx = r[2] as number;
  const dy = r[3] as number;
  const ddx = r[4] as number;
  const ddy = r[5] as number;
  const l2 = dx * dx + dy * dy;
  const along = (ddx * dx + ddy * dy) / l2;
  return [(ddx - along * dx) / l2, (ddy - along * dy) / l2];
}

/** sin of the angle between two directions (NaN when either is degenerate). */
function unitCross(a: [number, number], b: [number, number]): number {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la < 1e-12 || lb < 1e-12) return Number.NaN;
  return (a[0] * b[1] - a[1] * b[0]) / (la * lb);
}

/** Parameters of the closest approach of two curves (sampled, then alternating projections). */
function closestPair(a: ParamCurve, b: ParamCurve): [number, number] {
  const n = 48;
  const pb: Vec2[] = [];
  for (let j = 0; j <= n; j++) pb.push(b.at(b.t0 + ((b.t1 - b.t0) * j) / n));
  let best = Number.POSITIVE_INFINITY;
  let ta = a.t0;
  let tb = b.t0;
  for (let i = 0; i <= n; i++) {
    const t = a.t0 + ((a.t1 - a.t0) * i) / n;
    const q = a.at(t);
    pb.forEach((r, j) => {
      const d = (q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2;
      if (d < best) {
        best = d;
        ta = t;
        tb = b.t0 + ((b.t1 - b.t0) * j) / n;
      }
    });
  }
  for (let it = 0; it < 8; it++) {
    ta = refineCurveParam(a, b.at(tb), ta);
    tb = refineCurveParam(b, a.at(ta), tb);
  }
  return [ta, tb];
}

/** The point ids an entity is built on (its own id for a point). */
export function entityPoints(e: SketchEntity): Id[] {
  switch (e.kind) {
    case 'point':
      return [e.id];
    case 'line':
      return [e.start, e.end];
    case 'arc':
      return [e.center, e.start, e.end];
    case 'circle':
    case 'ellipse':
      return [e.center];
    case 'ellipticArc':
      return [e.center, e.start, e.end];
    case 'bspline':
      return [...e.poles];
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
      case 'ellipse':
      case 'ellipticArc': {
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
