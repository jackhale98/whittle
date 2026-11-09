/**
 * Dimension annotations (M3.5, owner request): the drawing geometry of a sketch dimension in
 * sketch-local mm, as other CAD sketchers draw it. Pure, no Wasm; the UI renders it and lets the
 * label be dragged (moving the label changes `DimensionConstraint.label` only, never the value).
 *
 *  - Linear (`distance`, `hDistance`, `vDistance`, `length`, line `offset`s): extension lines from
 *    the measured geometry out to the dimension line (a small gap at the geometry, a small
 *    overshoot past the dimension line) and the dimension line with two arrows. Aligned with the
 *    measurement (point–point, length), across the lines (point–line, line–line, offsets), or
 *    axis-parallel (`hDistance` x, `vDistance` y). The dimension line passes through the label;
 *    a label beyond the extension lines pulls the dimension line out to it.
 *  - Radial (`radius`, `diameter`, circle/arc offsets, the minor radius of an ellipse): a leader
 *    along the line through the centre towards the label; an arc gets an extension arc when the
 *    leader leaves its sweep.
 *  - Angular (`angle`): an arc between the two lines at the label's distance from their
 *    intersection, extension lines when that radius is beyond a line's extent, and an extension
 *    arc when the label sits outside the measured sector.
 *
 * Arrows flip outside (tips at the same ends, pointing inwards, with short stubs outside) when
 * the space between them can't hold the text and both arrowheads.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DimensionConstraint, Id, SketchEntity, Vec2 } from '@wren-cad/contracts';
import {
  add,
  angle0,
  arcGeom,
  dist,
  dot,
  ellipseGeom,
  indexEntities,
  len,
  normalize,
  perp,
  pointPos,
  scale,
  sub,
  TAU,
} from './geometry';
import { isSketchReference, referenceEntities } from './references';

export interface AnnotationArrow {
  /** Arrow tip (on the dimension line, arc or curve). */
  tip: Vec2;
  /** Unit direction the arrow points (from its tail to its tip). */
  dir: Vec2;
}

/** A CCW arc: centre, radius, start angle (rad) and sweep in [0, 2π]. */
export interface AnnotationArc {
  center: Vec2;
  radius: number;
  start: number;
  sweep: number;
}

export interface DimensionAnnotation {
  kind: 'linear' | 'radial' | 'angular';
  /** Extension (witness) lines. */
  extensions: [Vec2, Vec2][];
  /** Dimension line(s) and leaders; with arrows outside, the stubs too. */
  lines: [Vec2, Vec2][];
  /** Dimension arcs (angles) and extension arcs (arcs, angles). */
  arcs: AnnotationArc[];
  arrows: AnnotationArrow[];
  /** Where the text goes (the label) and the unit direction of its baseline. */
  text: { at: Vec2; dir: Vec2 };
  /** Arrows were flipped outside because the text doesn't fit between them. */
  arrowsOutside: boolean;
}

export interface AnnotationOptions {
  /** Label position (default: the constraint's `label`, else a placement next to the geometry). */
  label?: Vec2;
  /** Text width along the dimension line, mm (default 8). */
  textWidth?: number;
  /** Arrowhead length, mm (default 2.5). */
  arrowLength?: number;
  /** Gap between the geometry and an extension line, mm (default 1). */
  gap?: number;
  /** Extension line overshoot past the dimension line, mm (default 1.5). */
  overshoot?: number;
  /** Default label distance from the geometry when there is no label, mm (default 8). */
  offset?: number;
}

type Index = ReadonlyMap<Id, SketchEntity>;

interface Opts {
  textWidth: number;
  arrow: number;
  gap: number;
  over: number;
  offset: number;
}

function opts(o: AnnotationOptions): Opts {
  return {
    textWidth: o.textWidth ?? 8,
    arrow: o.arrowLength ?? 2.5,
    gap: o.gap ?? 1,
    over: o.overshoot ?? 1.5,
    offset: o.offset ?? 8,
  };
}

/** Entities by id with the sketch's origin and axes (ADR-017). */
function indexWithReferences(entities: readonly SketchEntity[]): Index {
  return indexEntities([...entities, ...referenceEntities()]);
}

function lineEnds(index: Index, id: Id): [Vec2, Vec2] | null {
  const l = index.get(id);
  if (l?.kind !== 'line') return null;
  return [pointPos(index, l.start), pointPos(index, l.end)];
}

/** Centre point of a point, circle, arc, ellipse or elliptic arc. */
function centreOf(index: Index, id: Id): Vec2 | null {
  const e = index.get(id);
  if (!e) return null;
  if (e.kind === 'point') return [e.x, e.y];
  if ('center' in e) return pointPos(index, e.center);
  return null;
}

interface Round {
  c: Vec2;
  r: number;
  /** Arcs: start angle and sweep. */
  arc?: { a0: number; sweep: number };
}

function roundOf(index: Index, id: Id): Round | null {
  const e = index.get(id);
  if (e?.kind === 'circle') return { c: pointPos(index, e.center), r: e.radius };
  if (e?.kind === 'arc') {
    const g = arcGeom(index, e);
    return { c: g.c, r: g.r, arc: { a0: g.a0, sweep: g.sweep } };
  }
  return null;
}

/** Nearest point of a segment (or of an axis: the infinite line) to `p`. */
function nearestOnLine(id: Id, [a, b]: [Vec2, Vec2], p: Vec2): Vec2 {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 === 0) return a;
  let t = dot(sub(p, a), d) / l2;
  if (!isSketchReference(id)) t = Math.max(0, Math.min(1, t));
  return add(a, scale(d, t));
}

/** Foot of `p` on the infinite line through a, b. */
function foot([a, b]: [Vec2, Vec2], p: Vec2): Vec2 {
  const d = sub(b, a);
  const l2 = dot(d, d);
  return l2 === 0 ? a : add(a, scale(d, dot(sub(p, a), d) / l2));
}

/** Text baseline direction: along `d`, but never upside down. */
function readable(d: Vec2): Vec2 {
  const u = normalize(d);
  if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0)) return [-u[0], -u[1]];
  return u;
}

// ---------------------------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------------------------

/**
 * A linear dimension measuring along unit `d` between anchors `A` and `B` (points on the
 * measured carriers); `oa`/`ob` are where the real geometry is (extension lines start there).
 */
function linear(A: Vec2, B: Vec2, d: Vec2, L: Vec2, o: Opts, oa = A, ob = B): DimensionAnnotation {
  const n = perp(d);
  const a1 = add(A, scale(n, dot(sub(L, A), n)));
  const b1 = add(B, scale(n, dot(sub(L, B), n)));
  const extensions: [Vec2, Vec2][] = [];
  for (const [from, to] of [
    [oa, a1],
    [ob, b1],
  ] as const) {
    const e = sub(to, from);
    const el = len(e);
    if (el <= o.gap) continue;
    const u = scale(e, 1 / el);
    extensions.push([add(from, scale(u, o.gap)), add(to, scale(u, o.over))]);
  }
  // Order the dimension line ends along d.
  const ta = dot(a1, d);
  const tb = dot(b1, d);
  const [p, q] = ta <= tb ? [a1, b1] : [b1, a1];
  const tp = Math.min(ta, tb);
  const tq = Math.max(ta, tb);
  const tl = dot(L, d);
  const span = tq - tp;
  const textInside = tl >= tp && tl <= tq;
  const fits = span >= o.textWidth + 2 * o.arrow + 2 * o.gap;
  const outside = !fits || !textInside;
  const lines: [Vec2, Vec2][] = [[p, q]];
  const arrows: AnnotationArrow[] = [];
  const back: Vec2 = [-d[0], -d[1]];
  if (!outside) {
    arrows.push({ tip: p, dir: back }, { tip: q, dir: d });
  } else {
    // Arrows outside, pointing in; stubs carry them (and reach out to a label beyond them).
    const stub = 2 * o.arrow;
    const pOut = add(p, scale(back, Math.max(stub, tl < tp ? tp - tl + o.textWidth / 2 : 0)));
    const qOut = add(q, scale(d, Math.max(stub, tl > tq ? tl - tq + o.textWidth / 2 : 0)));
    lines.push([pOut, p], [q, qOut]);
    arrows.push({ tip: p, dir: d }, { tip: q, dir: back });
  }
  return {
    kind: 'linear',
    extensions,
    lines,
    arcs: [],
    arrows,
    text: { at: L, dir: readable(d) },
    arrowsOutside: outside && fits === false ? true : outside,
  };
}

// ---------------------------------------------------------------------------------------------
// Radial
// ---------------------------------------------------------------------------------------------

/**
 * Leader along the ray from `c` through the label: radius = one arrow at the curve point
 * (inside the curve from the centre, outside from the label in); diameter = both sides.
 */
function radial(round: Round, L: Vec2, diameter: boolean, o: Opts): DimensionAnnotation {
  const { c, r } = round;
  let u = sub(L, c);
  if (len(u) < 1e-12) u = [1, 0];
  u = normalize(u);
  const P = add(c, scale(u, r));
  const lines: [Vec2, Vec2][] = [];
  const arrows: AnnotationArrow[] = [];
  const dl = dist(L, c);
  const labelOutside = dl > r;
  let outside = false;
  if (diameter) {
    const Q = add(c, scale(u, -r));
    const fits = 2 * r >= o.textWidth + 2 * o.arrow + 2 * o.gap;
    if (!labelOutside && fits) {
      lines.push([Q, P]);
      arrows.push({ tip: P, dir: u }, { tip: Q, dir: scale(u, -1) });
    } else {
      outside = true;
      const far = labelOutside ? L : add(P, scale(u, 2 * o.arrow));
      lines.push([Q, P], [P, far], [Q, add(Q, scale(u, -2 * o.arrow))]);
      arrows.push({ tip: P, dir: scale(u, -1) }, { tip: Q, dir: u });
    }
  } else if (labelOutside) {
    outside = true;
    lines.push([L, P]);
    arrows.push({ tip: P, dir: scale(u, -1) });
  } else {
    const fits = r >= o.textWidth / 2 + o.arrow + o.gap;
    lines.push([c, P]);
    if (fits) arrows.push({ tip: P, dir: u });
    else {
      outside = true;
      lines.push([P, add(P, scale(u, 2 * o.arrow))]);
      arrows.push({ tip: P, dir: scale(u, -1) });
    }
  }
  const arcs: AnnotationArc[] = [];
  if (round.arc) {
    // The leader meets the arc's circle outside its sweep: extend the arc to it.
    for (const v of diameter ? [u, scale(u, -1)] : [u]) {
      const t = angle0(Math.atan2(v[1], v[0]));
      const rel = angle0(t - round.arc.a0);
      if (rel <= round.arc.sweep + 1e-9) continue;
      const pastEnd = rel - round.arc.sweep;
      const beforeStart = TAU - rel;
      if (pastEnd <= beforeStart)
        arcs.push({ center: c, radius: r, start: round.arc.a0 + round.arc.sweep, sweep: pastEnd });
      else arcs.push({ center: c, radius: r, start: t, sweep: beforeStart });
    }
  }
  return {
    kind: 'radial',
    extensions: [],
    lines,
    arcs,
    arrows,
    text: { at: L, dir: readable(u) },
    arrowsOutside: outside,
  };
}

// ---------------------------------------------------------------------------------------------
// Angular
// ---------------------------------------------------------------------------------------------

function angular(
  la: [Vec2, Vec2],
  lb: [Vec2, Vec2],
  value: number,
  L: Vec2,
  o: Opts,
): DimensionAnnotation | null {
  const da = normalize(sub(la[1], la[0]));
  const db = normalize(sub(lb[1], lb[0]));
  const den = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((lb[0][0] - la[0][0]) * db[1] - (lb[0][1] - la[0][1]) * db[0]) / den;
  const O = add(la[0], scale(da, t));
  const R = Math.max(dist(L, O), 1e-6);
  // The measured sector runs CCW from line a's direction through `value`; its vertical twin
  // (both rays reversed) shows the same angle.
  const thA = Math.atan2(da[1], da[0]);
  const sweep = angle0(value) || TAU;
  const tl = angle0(Math.atan2(L[1] - O[1], L[0] - O[0]));
  const inSector = (start: number) => angle0(tl - start) <= sweep + 1e-9;
  const start = inSector(thA) || !inSector(thA + Math.PI) ? thA : thA + Math.PI;
  const arcs: AnnotationArc[] = [{ center: O, radius: R, start: angle0(start), sweep }];
  const end = start + sweep;
  // Label outside the sector: an extension arc from the nearer end of the arc to it.
  if (!inSector(start)) {
    const pastEnd = angle0(tl - end);
    const beforeStart = angle0(start - tl);
    if (pastEnd <= beforeStart) arcs.push({ center: O, radius: R, start: angle0(end), sweep: pastEnd });
    else arcs.push({ center: O, radius: R, start: tl, sweep: beforeStart });
  }
  // Extension lines along each ray when the arc lies beyond the line's extent on that ray.
  const extensions: [Vec2, Vec2][] = [];
  for (const [ends, th] of [
    [la, start],
    [lb, end],
  ] as const) {
    const ray: Vec2 = [Math.cos(th), Math.sin(th)];
    const reach = Math.max(dot(sub(ends[0], O), ray), dot(sub(ends[1], O), ray), 0);
    if (reach + o.gap >= R) continue;
    extensions.push([add(O, scale(ray, reach + o.gap)), add(O, scale(ray, R + o.over))]);
  }
  const pa = add(O, [Math.cos(start) * R, Math.sin(start) * R]);
  const pb = add(O, [Math.cos(end) * R, Math.sin(end) * R]);
  const ta: Vec2 = [-Math.sin(start), Math.cos(start)]; // CCW tangent at the start
  const tb: Vec2 = [-Math.sin(end), Math.cos(end)];
  const fits = R * sweep >= o.textWidth + 2 * o.arrow + 2 * o.gap;
  const arrows: AnnotationArrow[] = fits
    ? [
        { tip: pa, dir: scale(ta, -1) },
        { tip: pb, dir: tb },
      ]
    : [
        { tip: pa, dir: ta },
        { tip: pb, dir: scale(tb, -1) },
      ];
  const lines: [Vec2, Vec2][] = fits
    ? []
    : [
        [pa, add(pa, scale(ta, -2 * o.arrow))],
        [pb, add(pb, scale(tb, 2 * o.arrow))],
      ];
  return {
    kind: 'angular',
    extensions,
    lines,
    arcs,
    arrows,
    text: { at: L, dir: readable([-Math.sin(tl), Math.cos(tl)]) },
    arrowsOutside: !fits,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

/**
 * Where a dimension is measured: the default label placement (and the reference for `dragLabel`).
 * Null when the dimension's geometry isn't drawable (unknown entities, degenerate lines).
 */
export function dimensionAnnotation(
  entities: readonly SketchEntity[],
  c: DimensionConstraint,
  value: number,
  options: AnnotationOptions = {},
): DimensionAnnotation | null {
  const index = indexWithReferences(entities);
  const o = opts(options);
  const L = options.label ?? c.label ?? defaultLabel(index, c, value, o);
  if (!L) return null;
  switch (c.kind) {
    case 'length': {
      const l = lineEnds(index, c.line);
      if (!l || dist(l[0], l[1]) < 1e-12) return null;
      return linear(l[0], l[1], normalize(sub(l[1], l[0])), L, o);
    }
    case 'hDistance':
    case 'vDistance': {
      const pair = axisAnchors(index, c.a, c.b);
      if (!pair) return null;
      return linear(pair[0], pair[1], c.kind === 'hDistance' ? [1, 0] : [0, 1], L, o);
    }
    case 'distance':
      return distanceAnnotation(index, c.a, c.b, L, o);
    case 'radius':
    case 'diameter': {
      const round = roundOf(index, c.curve);
      if (round) return radial(round, L, c.kind === 'diameter', o);
      const e = index.get(c.curve);
      if (e?.kind === 'ellipse' || e?.kind === 'ellipticArc') {
        // The major radius: a leader along the major axis, on the label's side.
        const g = ellipseGeom(index, e);
        const side = dot(sub(L, g.c), g.u) >= 0 ? 1 : -1;
        const tip = add(g.c, scale(g.u, side * g.a));
        const along = add(g.c, scale(g.u, side * dot(sub(L, g.c), g.u)));
        return radial({ c: g.c, r: g.a }, dist(along, g.c) > 0 ? along : tip, c.kind === 'diameter', o);
      }
      return null;
    }
    case 'angle': {
      const la = lineEnds(index, c.a);
      const lb = lineEnds(index, c.b);
      if (!la || !lb) return null;
      return angular(la, lb, value, L, o);
    }
    case 'offset': {
      const s = c.sources[0];
      const t = c.targets[0];
      if (s === undefined || t === undefined) return null;
      const ls = lineEnds(index, s);
      const lt = lineEnds(index, t);
      if (ls && lt) return acrossLines(s, ls, t, lt, L, o);
      const rt = roundOf(index, t);
      const cs = centreOf(index, s);
      if (rt && cs) {
        // Concentric: between the two circles along the ray through the label.
        const rs = roundOf(index, s);
        let u = sub(L, rt.c);
        if (len(u) < 1e-12) u = [1, 0];
        u = normalize(u);
        const A = add(rt.c, scale(u, rs ? rs.r : 0));
        const B = add(rt.c, scale(u, rt.r));
        if (dist(A, B) < 1e-12) return null;
        return linear(A, B, normalize(sub(B, A)), L, o);
      }
      return null;
    }
  }
}

/** Anchors of a horizontal/vertical distance (a line alone: its start → end). */
function axisAnchors(index: Index, a: Id, b: Id): [Vec2, Vec2] | null {
  if (a === b) return lineEnds(index, a);
  const pa = centreOf(index, a);
  const pb = centreOf(index, b);
  return pa && pb ? [pa, pb] : null;
}

/** Between two parallel lines (or a line and its offset): across them, at the label. */
function acrossLines(
  ia: Id,
  la: [Vec2, Vec2],
  ib: Id,
  lb: [Vec2, Vec2],
  L: Vec2,
  o: Opts,
): DimensionAnnotation | null {
  const A = foot(la, L);
  const B = foot(lb, L);
  if (dist(A, B) < 1e-12) return null;
  const d = normalize(sub(B, A));
  return linear(A, B, d, L, o, nearestOnLine(ia, la, A), nearestOnLine(ib, lb, B));
}

function distanceAnnotation(index: Index, a: Id, b: Id, L: Vec2, o: Opts): DimensionAnnotation | null {
  const ea = index.get(a);
  const eb = index.get(b);
  if (!ea || !eb) return null;
  const isPoint = (e: SketchEntity) => e.kind === 'point';
  if (isPoint(ea) && isPoint(eb)) {
    const A = centreOf(index, a) as Vec2;
    const B = centreOf(index, b) as Vec2;
    if (dist(A, B) < 1e-12) return null;
    return linear(A, B, normalize(sub(B, A)), L, o);
  }
  const la = lineEnds(index, a);
  const lb = lineEnds(index, b);
  if (la && lb) return acrossLines(a, la, b, lb, L, o);
  // Point (or circle) and line: perpendicular to the line.
  for (const [p, l, lid] of [
    [ea, lb, b],
    [eb, la, a],
  ] as const) {
    if (!l) continue;
    const round = roundOf(index, p.id);
    const P = round ? round.c : isPoint(p) ? (centreOf(index, p.id) as Vec2) : null;
    if (!P) continue;
    const F = foot(l, P);
    if (dist(P, F) < 1e-12) return null;
    const d = normalize(sub(F, P));
    const A = round ? add(P, scale(d, round.r)) : P;
    return linear(A, F, d, L, o, A, nearestOnLine(lid, l, F));
  }
  // Ellipse and its centre: the minor radius along the minor axis, on the label's side.
  for (const [p, q] of [
    [ea, eb],
    [eb, ea],
  ] as const) {
    if (isPoint(p) && (q.kind === 'ellipse' || q.kind === 'ellipticArc')) {
      const g = ellipseGeom(index, q);
      const side = dot(sub(L, g.c), g.v) >= 0 ? 1 : -1;
      const B = add(g.c, scale(g.v, side * g.b));
      return linear(g.c, B, scale(g.v, side), L, o);
    }
  }
  // Circles / points around circles: along the line of centres, between the nearest points.
  const ra = roundOf(index, a);
  const rb = roundOf(index, b);
  const ca = ra?.c ?? centreOf(index, a);
  const cb = rb?.c ?? centreOf(index, b);
  if (!ca || !cb) return null;
  let u = sub(cb, ca);
  if (len(u) < 1e-12) u = normalize(sub(L, ca));
  else u = normalize(u);
  const dcc = dist(ca, cb);
  const rA = ra?.r ?? 0;
  const rB = rb?.r ?? 0;
  // Outside each other: facing sides; one inside the other: the near sides.
  const inside = dcc < Math.max(rA, rB);
  const A = add(ca, scale(u, inside && rA > rB ? -rA : rA));
  const B = add(cb, scale(u, inside && rB > rA ? rB : -rB));
  if (dist(A, B) < 1e-12) return null;
  return linear(A, B, normalize(sub(B, A)), L, o);
}

/** A label next to the geometry (when the constraint has none): offset from the measured span. */
function defaultLabel(index: Index, c: DimensionConstraint, value: number, o: Opts): Vec2 | null {
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  switch (c.kind) {
    case 'length': {
      const l = lineEnds(index, c.line);
      if (!l) return null;
      return add(mid(l[0], l[1]), scale(perp(normalize(sub(l[1], l[0]))), o.offset));
    }
    case 'hDistance':
    case 'vDistance': {
      const p = axisAnchors(index, c.a, c.b);
      if (!p) return null;
      const m = mid(p[0], p[1]);
      return c.kind === 'hDistance'
        ? [m[0], Math.max(p[0][1], p[1][1]) + o.offset]
        : [Math.max(p[0][0], p[1][0]) + o.offset, m[1]];
    }
    case 'radius':
    case 'diameter': {
      const r = roundOf(index, c.curve);
      const centre = centreOf(index, c.curve);
      if (!centre) return null;
      const rr = r?.r ?? 10;
      const dir: Vec2 = r?.arc
        ? [Math.cos(r.arc.a0 + r.arc.sweep / 2), Math.sin(r.arc.a0 + r.arc.sweep / 2)]
        : [Math.SQRT1_2, Math.SQRT1_2];
      return add(centre, scale(dir, rr + o.offset));
    }
    case 'angle': {
      const la = lineEnds(index, c.a);
      const lb = lineEnds(index, c.b);
      if (!la || !lb) return null;
      const da = normalize(sub(la[1], la[0]));
      const th = Math.atan2(da[1], da[0]) + value / 2;
      const centre = mid(mid(la[0], la[1]), mid(lb[0], lb[1]));
      return add(centre, [Math.cos(th) * o.offset, Math.sin(th) * o.offset]);
    }
    default: {
      const ids = c.kind === 'offset' ? [c.sources[0], c.targets[0]] : [c.a, c.b];
      const pts = ids
        .map((id) => (id === undefined ? null : (centreOf(index, id) ?? lineMid(index, id))))
        .filter((p): p is Vec2 => p !== null);
      if (pts.length === 0) return null;
      const m = pts.length === 2 ? mid(pts[0] as Vec2, pts[1] as Vec2) : (pts[0] as Vec2);
      const d = pts.length === 2 ? sub(pts[1] as Vec2, pts[0] as Vec2) : ([1, 0] as Vec2);
      return add(m, scale(perp(len(d) > 0 ? normalize(d) : [1, 0]), o.offset));
    }
  }
}

function lineMid(index: Index, id: Id): Vec2 | null {
  const l = lineEnds(index, id);
  return l ? [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2] : null;
}

/**
 * The label position for a dragged label (`to`, sketch mm). Only the label moves; the value never
 * does. A horizontal (vertical) distance keeps its text clear of its two points' vertical
 * (horizontal) span, on the side it was dragged to — above or below (left or right) — so the
 * dimension line never runs through the measured geometry and the placement still reads as
 * horizontal (vertical) when re-picked. Other kinds take `to` as it is.
 */
export function dragDimensionLabel(
  entities: readonly SketchEntity[],
  c: DimensionConstraint,
  to: Vec2,
  options: { clearance?: number } = {},
): Vec2 {
  if (c.kind !== 'hDistance' && c.kind !== 'vDistance') return to;
  const pair = axisAnchors(indexWithReferences(entities), c.a, c.b);
  if (!pair) return to;
  const k = c.kind === 'hDistance' ? 1 : 0;
  const lo = Math.min(pair[0][k], pair[1][k]);
  const hi = Math.max(pair[0][k], pair[1][k]);
  const clear = options.clearance ?? 3;
  const v = to[k];
  const mid = (lo + hi) / 2;
  const out = v >= mid ? Math.max(v, hi + clear) : Math.min(v, lo - clear);
  return k === 1 ? [to[0], out] : [out, to[1]];
}
