/**
 * Drawing-tool helpers (PLAN §2.1): pure functions that turn picked positions into entities and
 * the constraints that keep the shape's intent (a rectangle stays a rectangle). The UI appends
 * the fragment to the sketch, then applies inferred constraints on top.
 *
 * Polylines and rectangles share corner points between consecutive lines (contract: "a polyline
 * shares points"), so no `coincident` constraints are needed between their own segments.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  GeometricConstraint,
  Id,
  SketchConstraint,
  SketchEntity,
  Vec2,
} from '@wren-cad/contracts';
import { monotonicFactory } from 'ulid';
import { DEFAULT_SPLINE_DEGREE, interpolate } from './bspline';
import {
  add,
  angle0,
  circumcircle,
  dist,
  dot,
  fromAngle,
  indexEntities,
  len,
  normalize,
  perp,
  pointPos,
  scale,
  sub,
} from './geometry';

const monotonic = monotonicFactory();

/** New ULID (monotonic within a millisecond, so ids created together sort in order). */
export function newId(): Id {
  return monotonic();
}

export interface SketchFragment {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export interface ToolOptions {
  /** Create construction geometry (default false). */
  construction?: boolean;
  /** Id generator (default ULID). */
  id?: () => Id;
}

type GeometricDraft = GeometricConstraint extends infer C
  ? C extends GeometricConstraint
    ? Omit<C, 'id'>
    : never
  : never;

class Builder {
  readonly entities: SketchEntity[] = [];
  readonly constraints: SketchConstraint[] = [];
  private readonly nextId: () => Id;
  private readonly construction: boolean;

  constructor(options: ToolOptions = {}) {
    this.nextId = options.id ?? newId;
    this.construction = options.construction ?? false;
  }

  point(p: Vec2, construction = this.construction): Id {
    const id = this.nextId();
    this.entities.push({ id, kind: 'point', construction, x: p[0], y: p[1] });
    return id;
  }

  line(start: Id, end: Id, construction = this.construction): Id {
    const id = this.nextId();
    this.entities.push({ id, kind: 'line', construction, start, end });
    return id;
  }

  circle(center: Id, radius: number, construction = this.construction): Id {
    const id = this.nextId();
    this.entities.push({ id, kind: 'circle', construction, center, radius });
    return id;
  }

  arc(center: Id, start: Id, end: Id, construction = this.construction): Id {
    const id = this.nextId();
    this.entities.push({ id, kind: 'arc', construction, center, start, end });
    return id;
  }

  push(e: SketchEntity): Id {
    this.entities.push(e);
    return e.id;
  }

  id(): Id {
    return this.nextId();
  }

  get isConstruction(): boolean {
    return this.construction;
  }

  constrain(c: GeometricDraft): Id {
    const id = this.nextId();
    this.constraints.push({ ...c, id } as SketchConstraint);
    return id;
  }

  done(): SketchFragment {
    return { entities: this.entities, constraints: this.constraints };
  }
}

/** A single line from `a` to `b`. */
export function lineTool(a: Vec2, b: Vec2, options?: ToolOptions): SketchFragment {
  const k = new Builder(options);
  k.line(k.point(a), k.point(b));
  return k.done();
}

/** Connected lines through `points` sharing their corner points; `closed` joins last to first. */
export function polylineTool(
  points: readonly Vec2[],
  options: ToolOptions & { closed?: boolean } = {},
): SketchFragment {
  const k = new Builder(options);
  const ids = points.map((p) => k.point(p));
  for (let i = 0; i + 1 < ids.length; i++) k.line(ids[i] as Id, ids[i + 1] as Id);
  if (options.closed && ids.length > 2) k.line(ids[ids.length - 1] as Id, ids[0] as Id);
  return k.done();
}

function rectFromCorners(k: Builder, corners: [Vec2, Vec2, Vec2, Vec2]): Id[] {
  const p = corners.map((c) => k.point(c));
  return [0, 1, 2, 3].map((i) => k.line(p[i] as Id, p[(i + 1) % 4] as Id));
}

/** Axis-aligned rectangle from two opposite corners: 4 lines, 2 horizontal + 2 vertical. */
export function rectangleCornerTool(a: Vec2, b: Vec2, options?: ToolOptions): SketchFragment {
  const k = new Builder(options);
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const [bottom, right, top, left] = rectFromCorners(k, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) as [Id, Id, Id, Id];
  k.constrain({ kind: 'horizontal', line: bottom });
  k.constrain({ kind: 'horizontal', line: top });
  k.constrain({ kind: 'vertical', line: right });
  k.constrain({ kind: 'vertical', line: left });
  return k.done();
}

/**
 * Axis-aligned rectangle from its centre and a corner. Adds a construction centre point at the
 * midpoint of a construction diagonal so the centre stays put when the size changes.
 */
export function rectangleCenterTool(
  center: Vec2,
  corner: Vec2,
  options?: ToolOptions,
): SketchFragment {
  const opposite: Vec2 = [2 * center[0] - corner[0], 2 * center[1] - corner[1]];
  const frag = rectangleCornerTool(opposite, corner, options);
  const k = new Builder(options);
  const pts = frag.entities.filter((e) => e.kind === 'point');
  const c = k.point(center, true);
  const diag = k.line((pts[0] as SketchEntity).id, (pts[2] as SketchEntity).id, true);
  k.constrain({ kind: 'midpoint', point: c, line: diag });
  return {
    entities: [...frag.entities, ...k.entities],
    constraints: [...frag.constraints, ...k.constraints],
  };
}

/**
 * Rotated rectangle: `a`→`b` is the first edge, `c` sets the width (its distance from that edge).
 * Constraints: opposite edges parallel, first two edges perpendicular. Null when degenerate.
 */
export function rectangle3PointTool(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  options?: ToolOptions,
): SketchFragment | null {
  const u = sub(b, a);
  if (len(u) < 1e-9) return null;
  const n = perp(normalize(u));
  const h = dot(sub(c, a), n);
  if (Math.abs(h) < 1e-9) return null;
  const k = new Builder(options);
  const off = scale(n, h);
  const [l0, l1, l2, l3] = rectFromCorners(k, [a, b, add(b, off), add(a, off)]) as [Id, Id, Id, Id];
  k.constrain({ kind: 'parallel', a: l0, b: l2 });
  k.constrain({ kind: 'parallel', a: l1, b: l3 });
  k.constrain({ kind: 'perpendicular', a: l0, b: l1 });
  return k.done();
}

/** Circle from its centre and a radius (or a point on it). */
export function circleCenterTool(
  center: Vec2,
  radiusOrPoint: number | Vec2,
  options?: ToolOptions,
): SketchFragment {
  const r = typeof radiusOrPoint === 'number' ? radiusOrPoint : dist(center, radiusOrPoint);
  const k = new Builder(options);
  k.circle(k.point(center), r);
  return k.done();
}

/** Circle through three points; null when they're collinear. */
export function circle3PointTool(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  options?: ToolOptions,
): SketchFragment | null {
  const g = circumcircle(a, b, c);
  if (!g) return null;
  return circleCenterTool(g.c, g.r, options);
}

/** Arc from `start` to `end` passing through `through`; null when collinear. */
export function arc3PointTool(
  start: Vec2,
  end: Vec2,
  through: Vec2,
  options?: ToolOptions,
): SketchFragment | null {
  const g = circumcircle(start, through, end);
  if (!g) return null;
  const ang = (p: Vec2) => Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
  const a0 = ang(start);
  const ccw = angle0(ang(through) - a0) < angle0(ang(end) - a0);
  const k = new Builder(options);
  const c = k.point(g.c);
  const s = k.point(start);
  const e = k.point(end);
  if (ccw) k.arc(c, s, e);
  else k.arc(c, e, s);
  return k.done();
}

/**
 * Arc around `center` from `start`, ending on the ray towards `end` (radius = |start − centre|).
 * Counter-clockwise unless `clockwise`.
 */
export function arcCenterTool(
  center: Vec2,
  start: Vec2,
  end: Vec2,
  options: ToolOptions & { clockwise?: boolean } = {},
): SketchFragment | null {
  const r = dist(center, start);
  const d = sub(end, center);
  if (r < 1e-9 || len(d) < 1e-9) return null;
  const endP = add(center, scale(normalize(d), r));
  const k = new Builder(options);
  const c = k.point(center);
  const s = k.point(start);
  const e = k.point(endP);
  if (options.clockwise) k.arc(c, e, s);
  else k.arc(c, s, e);
  return k.done();
}

/**
 * Tangent arc continuing from an existing line/arc end (`startPoint`) to `end`. Reuses the
 * existing point, adds the arc, its centre and end point, and a `tangent` constraint. Returns
 * null when there's no line/arc ending at `startPoint` or `end` lies straight ahead.
 */
export function arcTangentTool(
  existing: readonly SketchEntity[],
  startPoint: Id,
  end: Vec2,
  options: ToolOptions & { tangentTo?: Id } = {},
): SketchFragment | null {
  const index = indexEntities(existing);
  const p = pointPos(index, startPoint);
  const owner = existing.find(
    (e) =>
      (options.tangentTo === undefined || e.id === options.tangentTo) &&
      (e.kind === 'line' || e.kind === 'arc') &&
      (e.start === startPoint || e.end === startPoint),
  );
  if (!owner || (owner.kind !== 'line' && owner.kind !== 'arc')) return null;
  let t: Vec2;
  if (owner.kind === 'line') {
    const other = pointPos(index, owner.start === startPoint ? owner.end : owner.start);
    t = normalize(sub(p, other));
  } else {
    const c = pointPos(index, owner.center);
    // CCW tangent at the end; reversed at the start (we leave the arc backwards).
    t =
      owner.end === startPoint ? normalize(perp(sub(p, c))) : scale(normalize(perp(sub(p, c))), -1);
  }
  const n = perp(t);
  const chord = sub(end, p);
  const denom = 2 * dot(chord, n);
  if (Math.abs(denom) < 1e-9 * Math.max(1, len(chord))) return null;
  const rho = dot(chord, chord) / denom;
  const center = add(p, scale(n, rho));
  const k = new Builder(options);
  const c = k.point(center);
  const e = k.point(end);
  const arc = rho > 0 ? k.arc(c, startPoint, e) : k.arc(c, e, startPoint);
  k.constrain({ kind: 'tangent', a: owner.id, b: arc });
  return k.done();
}

/**
 * Slot (stadium) between two centres with end-cap `radius`: two arcs, two lines, tangency at all
 * four joins (shared points) and equal radii. Remaining DOF: both centres and the radius.
 */
export function slotTool(
  c1: Vec2,
  c2: Vec2,
  radius: number,
  options?: ToolOptions,
): SketchFragment | null {
  const u = sub(c2, c1);
  if (len(u) < 1e-9 || radius <= 0) return null;
  const n = scale(perp(normalize(u)), radius);
  const k = new Builder(options);
  const pc1 = k.point(c1);
  const pc2 = k.point(c2);
  const a = k.point(add(c1, n));
  const b = k.point(add(c2, n));
  const c = k.point(sub(c2, n));
  const d = k.point(sub(c1, n));
  const top = k.line(a, b);
  const cap2 = k.arc(pc2, c, b);
  const bottom = k.line(c, d);
  const cap1 = k.arc(pc1, a, d);
  k.constrain({ kind: 'tangent', a: top, b: cap2 });
  k.constrain({ kind: 'tangent', a: bottom, b: cap2 });
  k.constrain({ kind: 'tangent', a: bottom, b: cap1 });
  k.constrain({ kind: 'tangent', a: top, b: cap1 });
  k.constrain({ kind: 'equal', a: cap1, b: cap2 });
  return k.done();
}

/**
 * Regular polygon with `sides` vertices on a construction circumcircle through `vertex`
 * (vertices on the circle + equal edges). Remaining DOF: centre, size, rotation.
 */
export function polygonTool(
  center: Vec2,
  vertex: Vec2,
  sides: number,
  options?: ToolOptions,
): SketchFragment | null {
  const r = dist(center, vertex);
  if (sides < 3 || !Number.isInteger(sides) || r < 1e-9) return null;
  const a0 = Math.atan2(vertex[1] - center[1], vertex[0] - center[0]);
  const k = new Builder(options);
  const c = k.point(center, true);
  const circle = k.circle(c, r, true);
  const pts: Id[] = [];
  for (let i = 0; i < sides; i++)
    pts.push(k.point(add(center, fromAngle(a0 + (i * 2 * Math.PI) / sides, r))));
  const lines = pts.map((p, i) => k.line(p, pts[(i + 1) % sides] as Id));
  for (const p of pts) k.constrain({ kind: 'pointOn', point: p, on: circle });
  for (let i = 1; i < lines.length; i++)
    k.constrain({ kind: 'equal', a: lines[0] as Id, b: lines[i] as Id });
  return k.done();
}

// ---------------------------------------------------------------------------------------------
// M3.5: ellipses, elliptic arcs and splines
// ---------------------------------------------------------------------------------------------

/** Major/minor radii and rotation from a centre, a major-axis point and a minor-radius point. */
function ellipseAxes(
  center: Vec2,
  axisPoint: Vec2,
  minorPoint: Vec2,
): { a: number; b: number; rotation: number } | null {
  const d = sub(axisPoint, center);
  const r = len(d);
  if (r < 1e-9) return null;
  const u = scale(d, 1 / r);
  // The minor radius is the minor point's distance from the major axis line.
  const h = Math.abs(dot(sub(minorPoint, center), perp(u)));
  if (h < 1e-9) return null;
  let rotation = Math.atan2(u[1], u[0]);
  let a = r;
  let b = h;
  if (b > a) {
    // The picked "axis" is the minor one: same ellipse, major axis turned by 90°.
    [a, b] = [b, a];
    rotation += Math.PI / 2;
  }
  // Normalise the direction to (−π/2, π/2] (an axis has no sense).
  while (rotation > Math.PI / 2) rotation -= Math.PI;
  while (rotation <= -Math.PI / 2) rotation += Math.PI;
  return { a, b, rotation };
}

/**
 * Ellipse from its centre, a point at the end of an axis and a point fixing the other radius
 * (its distance from that axis). The larger radius becomes the major one, so the axis point may
 * sit on either axis. Null when degenerate.
 */
export function ellipseTool(
  center: Vec2,
  axisPoint: Vec2,
  minorPoint: Vec2,
  options?: ToolOptions,
): SketchFragment | null {
  const ax = ellipseAxes(center, axisPoint, minorPoint);
  if (!ax) return null;
  return ellipseFromRadii(center, ax.a, ax.b, ax.rotation, options);
}

/** Ellipse from centre, radii (major ≥ minor after sorting) and rotation (major axis direction). */
export function ellipseFromRadii(
  center: Vec2,
  majorRadius: number,
  minorRadius: number,
  rotation: number,
  options?: ToolOptions,
): SketchFragment | null {
  if (!(majorRadius > 1e-9) || !(minorRadius > 1e-9)) return null;
  const swap = minorRadius > majorRadius;
  const k = new Builder(options);
  const c = k.point(center);
  k.push({
    id: k.id(),
    kind: 'ellipse',
    construction: k.isConstruction,
    center: c,
    majorRadius: swap ? minorRadius : majorRadius,
    minorRadius: swap ? majorRadius : minorRadius,
    rotation: swap ? rotation + Math.PI / 2 : rotation,
  });
  return k.done();
}

/**
 * Elliptic arc: the ellipse of `ellipseTool`, counter-clockwise (unless `clockwise`) from `start`
 * to `end`, both projected onto the ellipse along their eccentric angle. Null when degenerate or
 * when start and end project to the same point.
 */
export function ellipticArcTool(
  center: Vec2,
  axisPoint: Vec2,
  minorPoint: Vec2,
  start: Vec2,
  end: Vec2,
  options: ToolOptions & { clockwise?: boolean } = {},
): SketchFragment | null {
  const ax = ellipseAxes(center, axisPoint, minorPoint);
  if (!ax) return null;
  const u: Vec2 = [Math.cos(ax.rotation), Math.sin(ax.rotation)];
  const v = perp(u);
  const onEllipse = (p: Vec2): { at: Vec2; t: number } => {
    const d = sub(p, center);
    const t = Math.atan2(dot(d, v) / ax.b, dot(d, u) / ax.a);
    const x = ax.a * Math.cos(t);
    const y = ax.b * Math.sin(t);
    return { at: add(center, add(scale(u, x), scale(v, y))), t };
  };
  const s = onEllipse(start);
  const e = onEllipse(end);
  if (Math.abs(angle0(e.t - s.t)) < 1e-9 || dist(s.at, e.at) < 1e-9) return null;
  const k = new Builder(options);
  const c = k.point(center);
  const ps = k.point(s.at);
  const pe = k.point(e.at);
  const [from, to] = options.clockwise ? [pe, ps] : [ps, pe];
  k.push({
    id: k.id(),
    kind: 'ellipticArc',
    construction: k.isConstruction,
    center: c,
    start: from,
    end: to,
    majorRadius: ax.a,
    minorRadius: ax.b,
    rotation: ax.rotation,
  });
  return k.done();
}

export interface SplineToolOptions extends ToolOptions {
  /** Degree (default 3); lowered to fit few points. */
  degree?: number;
  /** A closed (periodic) spline. */
  closed?: boolean;
}

/**
 * Spline by control points: the poles are new points (interior ones, and all of a closed spline's,
 * are construction: they shape the curve, they are not on it). Open splines are clamped, so they
 * start and end at the first and last picked points. Uniform knots (the defaults). Null for fewer
 * than 2 points (3 when closed).
 */
export function splineControlTool(
  points: readonly Vec2[],
  options: SplineToolOptions = {},
): SketchFragment | null {
  const closed = options.closed === true;
  const pts = dedupe(points, closed);
  if (pts.length < (closed ? 3 : 2)) return null;
  const degree = Math.max(1, Math.min(options.degree ?? DEFAULT_SPLINE_DEGREE, pts.length - 1));
  const k = new Builder(options);
  const poles = pts.map((p, i) => {
    const end = !closed && (i === 0 || i === pts.length - 1);
    return k.point(p, end ? k.isConstruction : true);
  });
  k.push({
    id: k.id(),
    kind: 'bspline',
    construction: k.isConstruction,
    poles,
    degree,
    periodic: closed,
  });
  return k.done();
}

/**
 * Spline through points (DECISIONS "Sketch B-splines"): the picked points become the through
 * points, the poles interpolate them with knots at the points (chord-length parameters), and each
 * inner through point (every one when closed) is listed in `through` (ADR-050) and held on the
 * curve by `pointOn` at its knot, so
 * moving a through point reshapes the curve. An open spline's ends are its first and last poles
 * (shared with the end through points); the poles next to them are free tangent handles. Natural
 * ends (zero curvature) initially. Null when degenerate (repeated points, fewer than 2; 3 closed).
 */
export function splineThroughTool(
  points: readonly Vec2[],
  options: SplineToolOptions = {},
): SketchFragment | null {
  const closed = options.closed === true;
  const pts = dedupe(points, closed);
  if (pts.length < (closed ? 3 : 2)) return null;
  const it = interpolate(pts, options.degree ?? DEFAULT_SPLINE_DEGREE, closed);
  if (!it) return null;
  const k = new Builder(options);
  const through = pts.map((p) => k.point(p));
  const poles = it.poles.map((p, i) => {
    if (!closed && i === 0) return through[0] as Id;
    if (!closed && i === it.poles.length - 1) return through[through.length - 1] as Id;
    return k.point(p, true);
  });
  const spline = k.push({
    id: k.id(),
    kind: 'bspline',
    construction: k.isConstruction,
    poles,
    degree: it.degree,
    periodic: closed,
    knots: it.knots,
    multiplicities: it.multiplicities,
    through: closed ? [...through] : through.slice(1, -1),
  });
  for (const t of closed ? through : through.slice(1, -1))
    k.constrain({ kind: 'pointOn', point: t, on: spline });
  return k.done();
}

/** Consecutive duplicates removed (and a closing duplicate of the first point). */
function dedupe(points: readonly Vec2[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || dist(p, q) > 1e-9) out.push([p[0], p[1]]);
  }
  if (closed && out.length > 1 && dist(out[0] as Vec2, out[out.length - 1] as Vec2) <= 1e-9)
    out.pop();
  return out;
}

/** Sets (or toggles, when `value` is omitted) the construction flag on `ids`. */
export function setConstruction(
  entities: readonly SketchEntity[],
  ids: readonly Id[],
  value?: boolean,
): SketchEntity[] {
  const set = new Set(ids);
  return entities.map((e) =>
    set.has(e.id) ? { ...e, construction: value ?? !e.construction } : e,
  );
}

/** Appends a fragment to a sketch's entity/constraint lists. */
export function mergeFragment(
  sketch: { entities: readonly SketchEntity[]; constraints: readonly SketchConstraint[] },
  fragment: SketchFragment,
): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  return {
    entities: [...sketch.entities, ...fragment.entities],
    constraints: [...sketch.constraints, ...fragment.constraints],
  };
}
