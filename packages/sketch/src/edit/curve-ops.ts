/**
 * Trim and extend for the M3.5 curves (ellipses, elliptic arcs, splines), and intersections of
 * any two sketch curves (sampled, then refined by Newton on the exact curves). Called from trim.ts.
 *
 *  - An ellipse needs two cuts and becomes an elliptic arc (same id), like a circle becomes an arc.
 *  - An elliptic arc is shortened or split like an arc; the split-off piece shares the centre and
 *    is tied by `equal` and a `pointOn` of its start on the original.
 *  - A spline is split by knot insertion (the curve doesn't change; the pieces keep the original
 *    knot values, so through points stay at their knots and keep reshaping their piece). Pieces
 *    get new poles, except the original's end poles, which stay with the piece that ends there.
 *    Through points on a removed part lose their `pointOn`. A closed spline needs two cuts and
 *    becomes an open one (same id).
 *  - Extending: elliptic arcs along their ellipse; splines and ellipses are refused.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchBSpline, SketchEllipticArc, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { type SplineGeom, splineBasis, subSpline } from '../bspline';
import {
  angle0,
  closestParam,
  dist,
  ellipseGeom,
  ellipseParam,
  ellipsePoint,
  ellipticArcGeom,
  type ParamCurve,
  paramCurve,
  splineGeom,
  TAU,
} from '../geometry';
import { refuse, type SketchDraft, type SketchEditResult } from './draft';

export interface CurveHit {
  /** Parameter on the trimmed curve. */
  t: number;
  p: Vec2;
  other: Id;
  /** An end point of `other` at the hit (coincident attachment). */
  point?: Id;
}

/** Sample count of a curve for intersection seeding. */
function samplesOf(e: SketchEntity): number {
  if (e.kind === 'line') return 1;
  if (e.kind === 'bspline') return Math.max(64, 24 * e.poles.length);
  return 128;
}

/**
 * Intersections of curves a and b (parameter ranges as given): segment crossings of their
 * samplings, refined by Newton on a(ta) = b(tb). Tangential touches are not found.
 */
export function curveIntersections(
  a: ParamCurve,
  na: number,
  b: ParamCurve,
  nb: number,
  tol: number,
): { ta: number; tb: number; p: Vec2 }[] {
  const sample = (c: ParamCurve, n: number) => {
    const ts: number[] = [];
    for (let i = 0; i <= n; i++) ts.push(c.t0 + ((c.t1 - c.t0) * i) / n);
    return { ts, ps: ts.map((t) => c.at(t)) };
  };
  const A = sample(a, na);
  const B = sample(b, nb);
  const out: { ta: number; tb: number; p: Vec2 }[] = [];
  const box = (p: Vec2, q: Vec2) => [
    Math.min(p[0], q[0]),
    Math.min(p[1], q[1]),
    Math.max(p[0], q[0]),
    Math.max(p[1], q[1]),
  ];
  const bBoxes = B.ps.slice(1).map((q, j) => box(B.ps[j] as Vec2, q));
  for (let i = 0; i < na; i++) {
    const p0 = A.ps[i] as Vec2;
    const p1 = A.ps[i + 1] as Vec2;
    const ab = box(p0, p1);
    for (let j = 0; j < nb; j++) {
      const bb = bBoxes[j] as number[];
      if (
        (ab[2] as number) < (bb[0] as number) - tol ||
        (bb[2] as number) < (ab[0] as number) - tol
      )
        continue;
      if (
        (ab[3] as number) < (bb[1] as number) - tol ||
        (bb[3] as number) < (ab[1] as number) - tol
      )
        continue;
      const q0 = B.ps[j] as Vec2;
      const q1 = B.ps[j + 1] as Vec2;
      const r: Vec2 = [p1[0] - p0[0], p1[1] - p0[1]];
      const s: Vec2 = [q1[0] - q0[0], q1[1] - q0[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-300) continue;
      const w: Vec2 = [q0[0] - p0[0], q0[1] - p0[1]];
      const u = (w[0] * s[1] - w[1] * s[0]) / den;
      const v = (w[0] * r[1] - w[1] * r[0]) / den;
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) continue;
      let ta = (A.ts[i] as number) + ((A.ts[i + 1] as number) - (A.ts[i] as number)) * u;
      let tb = (B.ts[j] as number) + ((B.ts[j + 1] as number) - (B.ts[j] as number)) * v;
      for (let it = 0; it < 20; it++) {
        const pa = a.at(ta);
        const pb = b.at(tb);
        const fx = pa[0] - pb[0];
        const fy = pa[1] - pb[1];
        if (Math.hypot(fx, fy) < 1e-13 * Math.max(1, Math.hypot(pa[0], pa[1]))) break;
        const da = a.d1(ta);
        const db = b.d1(tb);
        // [da, −db] [Δta, Δtb]ᵀ = −f
        const det = -da[0] * db[1] + da[1] * db[0];
        if (Math.abs(det) < 1e-300) break;
        const dta = (-fx * -db[1] - -fy * -db[0]) / det;
        const dtb = (da[0] * -fy - da[1] * -fx) / det;
        ta += dta;
        tb += dtb;
      }
      const pa = a.at(ta);
      if (dist(pa, b.at(tb)) > tol) continue;
      const inRange = (c: ParamCurve, t: number) =>
        c.closed || (t >= c.t0 - 1e-9 && t <= c.t1 + 1e-9);
      if (!inRange(a, ta) || !inRange(b, tb)) continue;
      if (out.some((h) => dist(h.p, pa) <= 10 * tol)) continue;
      out.push({ ta, tb, p: pa });
    }
  }
  return out;
}

/** End points of a curve entity (for coincident attachments at a cut). */
export function endPoints(e: SketchEntity): Id[] {
  if (e.kind === 'line' || e.kind === 'arc' || e.kind === 'ellipticArc') return [e.start, e.end];
  if (e.kind === 'bspline' && !e.periodic)
    return [e.poles[0] as Id, e.poles[e.poles.length - 1] as Id];
  return [];
}

/** Hits of other curves (own extents) on `carrier`, as parameters of the trimmed curve. */
export function hitsOn(
  k: SketchDraft,
  self: SketchEntity,
  carrier: ParamCurve,
  nSelf: number,
  param: (p: Vec2) => number,
  only?: (o: SketchEntity) => boolean,
): CurveHit[] {
  const tol = 1e-7 * k.scale;
  const ptol = 1e-7 * k.scale;
  const index = new Map(k.entities.map((e) => [e.id, e]));
  const own = new Set(endPoints(self));
  const hits: CurveHit[] = [];
  for (const o of k.entities) {
    if (o.id === self.id || o.kind === 'point') continue;
    if (only && !only(o)) continue;
    const oc = paramCurve(index, o);
    if (!oc) continue;
    for (const x of curveIntersections(carrier, nSelf, oc, samplesOf(o), tol)) {
      const point = endPoints(o).find((pid) => dist(k.pos(pid), x.p) <= ptol);
      if (point && own.has(point)) continue;
      hits.push({ t: param(x.p), p: x.p, other: o.id, ...(point ? { point } : {}) });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

function attach(k: SketchDraft, pid: Id, hit: CurveHit) {
  if (hit.point) k.constrain({ kind: 'coincident', a: pid, b: hit.point });
  else k.constrain({ kind: 'pointOn', point: pid, on: hit.other });
}

/** Removes a curve, the constraints on it and its now-unused points. */
function deleteCurve(k: SketchDraft, e: SketchEntity, points: Id[]) {
  for (const c of k.constraintsOn(e.id)) {
    if (c.kind === 'offset') continue;
    k.dropConstraint(c.id, `${k.name(e.id)} was deleted`);
  }
  k.removeEntity(e.id);
  for (const p of points) k.dropIfOrphan(p, `${k.name(e.id)} was deleted`);
}

/** Nearest cuts below and above `tp` (strictly inside (lo, hi)). */
function bracket(hits: CurveHit[], tp: number, lo: number, hi: number, eps: number) {
  const inner = hits.filter((h) => h.t > lo + eps && h.t < hi - eps);
  let below: CurveHit | null = null;
  let above: CurveHit | null = null;
  for (const h of inner) {
    if (h.t < tp && (!below || h.t > below.t)) below = h;
    if (h.t > tp && (!above || h.t < above.t)) above = h;
  }
  return { below, above, inner };
}

/** Distinct cyclic parameters (closed curves) of the hits, sorted. */
function cyclicCuts(hits: CurveHit[], period: number, eps: number): CurveHit[] {
  const out: CurveHit[] = [];
  for (const h of hits)
    if (!out.some((a) => Math.abs(a.t - h.t) < eps || Math.abs(a.t - h.t) > period - eps))
      out.push(h);
  return out.sort((a, b) => a.t - b.t);
}

/** The cuts just before and after `tp` going round a closed curve. */
function aroundPick(cuts: CurveHit[], tp: number): { before: CurveHit; after: CurveHit } {
  let before = cuts[cuts.length - 1] as CurveHit;
  let after = cuts[0] as CurveHit;
  for (const h of cuts) if (h.t < tp) before = h;
  for (const h of [...cuts].reverse()) if (h.t > tp) after = h;
  return { before, after };
}

// ---------------------------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------------------------

export function trimCurve(k: SketchDraft, e: SketchEntity, pick: Vec2): SketchEditResult {
  const name = k.name(e.id);
  const index = new Map(k.entities.map((x) => [x.id, x]));
  if (e.kind === 'ellipse') {
    const g = ellipseGeom(index, e);
    const carrier = paramCurve(index, e) as ParamCurve;
    const hits = hitsOn(k, e, carrier, 128, (p) => ellipseParam(g, p));
    const cuts = cyclicCuts(hits, TAU, 1e-9);
    if (cuts.length === 0) {
      deleteCurve(k, e, [e.center]);
      return k.finish(`Delete ${name}`);
    }
    if (cuts.length === 1)
      return refuse(`${name} crosses only one curve; trimming an ellipse needs two`);
    const { before, after } = aroundPick(cuts, ellipseParam(g, pick));
    const s = k.point(after.p, e.construction);
    const t = k.point(before.p, e.construction);
    const arc: SketchEllipticArc = {
      id: e.id,
      kind: 'ellipticArc',
      construction: e.construction,
      ...(e.source ? { source: e.source } : {}),
      center: e.center,
      start: s,
      end: t,
      majorRadius: e.majorRadius,
      minorRadius: e.minorRadius,
      rotation: e.rotation,
    };
    k.replace(arc);
    attach(k, s, after);
    attach(k, t, before);
    return k.finish(`Trim ${name}`);
  }
  if (e.kind === 'ellipticArc') return trimEllipticArc(k, e, pick);
  if (e.kind === 'bspline') return trimSpline(k, e, pick);
  return refuse(`${name} can't be trimmed`);
}

function trimEllipticArc(k: SketchDraft, e: SketchEllipticArc, pick: Vec2): SketchEditResult {
  const name = k.name(e.id);
  const index = new Map(k.entities.map((x) => [x.id, x]));
  const g = ellipticArcGeom(index, e);
  const carrier: ParamCurve = {
    ...(paramCurve(index, e) as ParamCurve),
    t0: 0,
    t1: TAU,
    closed: true,
  };
  const rel = (p: Vec2) => angle0(ellipseParam(g, p) - g.t0);
  const hits = hitsOn(k, e, carrier, 128, rel);
  const eps = 1e-7;
  let tp = rel(pick);
  if (tp > g.sweep) tp = dist(pick, g.start) <= dist(pick, g.end) ? 0 : g.sweep;
  const { below, above, inner } = bracket(hits, tp, 0, g.sweep, eps);
  if (inner.length === 0) {
    deleteCurve(k, e, [e.center, e.start, e.end]);
    return k.finish(`Delete ${name}`);
  }
  const moveEnd = (which: 'start' | 'end', hit: CurveHit) => {
    const cur = k.get(e.id) as SketchEllipticArc;
    const old = cur[which];
    const p = k.point(hit.p, e.construction);
    k.replace({ ...cur, [which]: p });
    attach(k, p, hit);
    k.dropIfOrphan(old, 'its end was trimmed away');
  };
  if (!below && above) moveEnd('start', above);
  else if (below && !above) moveEnd('end', below);
  else if (below && above) {
    const farEnd = e.end;
    const a = k.point(below.p, e.construction);
    const b = k.point(above.p, e.construction);
    k.replace({ ...e, end: a });
    const piece = k.newId();
    k.addEntity({ ...e, id: piece, start: b, end: farEnd });
    attach(k, a, below);
    attach(k, b, above);
    k.constrain({ kind: 'equal', a: e.id, b: piece });
    k.constrain({ kind: 'pointOn', point: b, on: e.id });
  }
  return k.finish(`Trim ${name}`);
}

/** A spline entity for `geom` with new poles, except the given end pole ids. */
function splineEntity(
  k: SketchDraft,
  e: SketchBSpline,
  geom: SplineGeom,
  id: Id,
  keepFirst?: Id,
  keepLast?: Id,
): SketchBSpline {
  const n = geom.poles.length;
  const poles = geom.poles.map((p, i) => {
    if (i === 0 && keepFirst) return keepFirst;
    if (i === n - 1 && keepLast) return keepLast;
    const end = !geom.periodic && (i === 0 || i === n - 1);
    return k.point(p, end ? e.construction : true);
  });
  const through = pieceThrough(e, geom);
  return {
    id,
    kind: 'bspline',
    construction: e.construction,
    poles,
    degree: geom.degree,
    periodic: geom.periodic,
    ...(geom.weights ? { weights: [...geom.weights] } : {}),
    ...(geom.knots ? { knots: [...geom.knots] } : {}),
    ...(geom.multiplicities ? { multiplicities: [...geom.multiplicities] } : {}),
    ...(through ? { through } : {}),
  };
}

/**
 * The original's through points (ADR-050) at a piece's inner knots, in order: a piece keeps the
 * original knot values (a closed original's may be one period on). Undefined when the original
 * has none, or when an inner knot of the piece has no through point (then nothing is listed).
 */
function pieceThrough(e: SketchBSpline, piece: SplineGeom): Id[] | undefined {
  if (!e.through) return undefined;
  const orig = splineBasis(e.poles.length, e);
  const knots = orig.innerKnots();
  const T = orig.hi - orig.lo;
  const inner = splineBasis(piece.poles.length, piece).innerKnots();
  const out: Id[] = [];
  for (const u of inner) {
    const i = knots.findIndex((k) =>
      [k, k + T, k - T].some((v) => Math.abs(v - u) <= 1e-12 * Math.max(1, Math.abs(u))),
    );
    const id = i >= 0 ? e.through[i] : undefined;
    if (!id) return undefined;
    out.push(id);
  }
  return out;
}

function trimSpline(k: SketchDraft, e: SketchBSpline, pick: Vec2): SketchEditResult {
  const name = k.name(e.id);
  const index = new Map(k.entities.map((x) => [x.id, x]));
  const g = splineGeom(index, e);
  const basis = splineBasis(g.poles.length, g);
  const curve = paramCurve(index, e) as ParamCurve;
  const n = 24 * e.poles.length;
  const param = (p: Vec2) => closestParam(curve, p, n);
  const hits = hitsOn(k, e, curve, n, param);
  const eps = 1e-7 * (basis.hi - basis.lo);
  const tp = param(pick);
  // Points held on the spline: where they sit, to keep them on the right piece.
  const held = k.constraints
    .filter((c) => c.kind === 'pointOn' && c.on === e.id)
    .map((c) => ({ c, u: param(k.pos((c as { point: Id }).point)) }));
  const oldPoles = [...e.poles];
  const cleanup = (kept: Set<Id>) => {
    for (const p of oldPoles)
      if (!kept.has(p)) k.dropIfOrphan(p, `its control point was trimmed away`);
  };
  const reassign = (ranges: { id: Id; lo: number; hi: number }[]) => {
    for (const { c, u } of held) {
      const r = ranges.find((x) => u >= x.lo - eps && u <= x.hi + eps);
      if (!r) k.dropConstraint(c.id, 'its point is on a part that was trimmed away');
      else if (r.id !== e.id) k.updateConstraint({ ...c, on: r.id } as typeof c);
    }
  };

  if (e.periodic) {
    const cuts = cyclicCuts(hits, basis.hi - basis.lo, eps);
    if (cuts.length === 0) {
      deleteCurve(k, e, oldPoles);
      return k.finish(`Delete ${name}`);
    }
    if (cuts.length === 1)
      return refuse(`${name} crosses only one curve; trimming a closed spline needs two`);
    const { before, after } = aroundPick(cuts, tp);
    const sub = subSpline(g, after.t, before.t);
    const next = splineEntity(k, e, sub, e.id);
    k.replace(next);
    attach(k, next.poles[0] as Id, after);
    attach(k, next.poles[next.poles.length - 1] as Id, before);
    // Kept range: after → before going forward (across the seam).
    const T = basis.hi - basis.lo;
    const a0 = after.t;
    let b0 = before.t;
    if (b0 <= a0) b0 += T;
    for (const { c, u } of held) {
      let uu = u;
      if (uu < a0) uu += T;
      if (uu > b0 + eps) k.dropConstraint(c.id, 'its point is on a part that was trimmed away');
    }
    cleanup(new Set());
    return k.finish(`Trim ${name}`);
  }

  const { below, above, inner } = bracket(hits, tp, basis.lo, basis.hi, eps);
  if (inner.length === 0) {
    deleteCurve(k, e, oldPoles);
    return k.finish(`Delete ${name}`);
  }
  const first = oldPoles[0] as Id;
  const last = oldPoles[oldPoles.length - 1] as Id;
  if (!below && above) {
    const next = splineEntity(k, e, subSpline(g, above.t, basis.hi), e.id, undefined, last);
    k.replace(next);
    attach(k, next.poles[0] as Id, above);
    reassign([{ id: e.id, lo: above.t, hi: basis.hi }]);
    cleanup(new Set([last]));
  } else if (below && !above) {
    const next = splineEntity(k, e, subSpline(g, basis.lo, below.t), e.id, first);
    k.replace(next);
    attach(k, next.poles[next.poles.length - 1] as Id, below);
    reassign([{ id: e.id, lo: basis.lo, hi: below.t }]);
    cleanup(new Set([first]));
  } else if (below && above) {
    const left = splineEntity(k, e, subSpline(g, basis.lo, below.t), e.id, first);
    k.replace(left);
    const right = splineEntity(k, e, subSpline(g, above.t, basis.hi), k.newId(), undefined, last);
    k.addEntity(right);
    attach(k, left.poles[left.poles.length - 1] as Id, below);
    attach(k, right.poles[0] as Id, above);
    reassign([
      { id: e.id, lo: basis.lo, hi: below.t },
      { id: right.id, lo: above.t, hi: basis.hi },
    ]);
    cleanup(new Set([first, last]));
  }
  return k.finish(`Trim ${name}`);
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

export function extendCurve(k: SketchDraft, e: SketchEntity, pick: Vec2): SketchEditResult {
  const name = k.name(e.id);
  if (e.kind === 'ellipse') return refuse('An ellipse has no ends to extend');
  if (e.kind === 'bspline')
    return refuse(
      `${name} is a spline: drag its end point (or add a point to it) to make it longer`,
    );
  if (e.kind !== 'ellipticArc') return refuse(`${name} can't be extended`);
  const index = new Map(k.entities.map((x) => [x.id, x]));
  const g = ellipticArcGeom(index, e);
  const which: 'start' | 'end' = dist(pick, g.start) <= dist(pick, g.end) ? 'start' : 'end';
  const pid = e[which];
  const others = k.pointUsers(pid, e.id);
  if (others.length > 0)
    return refuse(
      `That end of ${name} is connected to ${k.name(others[0]?.id as Id)}; extend a free end`,
    );
  const carrier: ParamCurve = {
    ...(paramCurve(index, e) as ParamCurve),
    t0: 0,
    t1: TAU,
    closed: true,
  };
  const hits = hitsOn(k, e, carrier, 128, (p) => angle0(ellipseParam(g, p) - g.t0));
  const eps = 1e-7;
  let best: CurveHit | null = null;
  for (const h of hits) {
    if (!(h.t > g.sweep + eps && h.t < TAU - eps)) continue;
    if (which === 'end' && (!best || h.t < best.t)) best = h;
    if (which === 'start' && (!best || h.t > best.t)) best = h;
  }
  if (!best) return refuse(`Nothing to extend ${name} to`);
  for (const c of k.constraintsOn(pid)) k.dropConstraint(c.id, `the end of ${name} moved`);
  k.setPos(pid, ellipsePoint(g, g.t0 + best.t));
  attach(k, pid, best);
  return k.finish(`Extend ${name}`);
}
