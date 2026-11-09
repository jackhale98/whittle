/**
 * Solver encoding of the M3 `offset` dimension (contracts/sketch.ts): `targets[i]` stays offset
 * from `sources[i]` by one driving distance d.
 *
 * Pairs: line → line (parallel at d), arc → arc and circle → circle (concentric, radius ± d), and
 * point → arc (a join or cap arc of radius d centred on a source corner or chain end). Each
 * target's side is the side it is on in the geometry handed to the solver (like `distance`, which
 * is unsigned, and tangency, whose internal/external choice is read the same way), so one
 * positive value drives both sides of a two-sided offset.
 *
 * Rows are chosen so the Jacobian stays regular (no redundant rows, no tangent intersections):
 *
 *  - A target end point that no other target shares (a free end of an open chain) lies on its
 *    offset curve and on the source's normal through the matching source end ("square end"), so
 *    the offset follows its source when the source grows.
 *  - A point where two targets meet at an angle (a trimmed concave corner) lies on both offset
 *    curves.
 *  - Where two targets meet tangentially (smooth source joints, join and cap arcs), "on both
 *    curves" is degenerate. The point keeps one membership plus the square-end row, and the other
 *    target gets that membership through the shared point. Lines give theirs up first; an arc
 *    gives up at most one (its two end memberships are its radius row and its own arc rule).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type { DimensionConstraint, Id, SketchEntity } from '@whittle/contracts';
import type { Measure, Row } from './model';
import { isSketchReference } from './references';

type OffsetConstraint = Extract<DimensionConstraint, { kind: 'offset' }>;

/** Joints whose curve normals differ by less than this (rad) are tangent (smooth). */
export const OFFSET_TANGENT_TOL = 1e-6;

export interface OffsetContext {
  index: ReadonlyMap<Id, SketchEntity>;
  x0: Float64Array;
  radiusIdx: ReadonlyMap<Id, number>;
  pointOf(id: Id, owner: Id): number;
  /** Representative of a point's coincidence class. */
  root(id: Id): Id;
  gid(id: Id): string;
}

interface LinePair {
  kind: 'line';
  s: Id;
  t: Id;
  ss: number;
  se: number;
  ssId: Id;
  seId: Id;
  ts: number;
  te: number;
  tsId: Id;
  teId: Id;
  /** Target runs the same way as its source (target start ↔ source start). */
  same: boolean;
  sigma: number;
  /** Infinite source (an axis): no square ends. */
  infinite: boolean;
}
interface ArcPair {
  kind: 'arc';
  s: Id;
  t: Id;
  sc: number;
  scId: Id;
  sStart: number;
  sStartId: Id;
  sEnd: number;
  sEndId: Id;
  tc: number;
  tcId: Id;
  ts: number;
  tsId: Id;
  te: number;
  teId: Id;
  sigma: number;
}
interface PointArcPair {
  kind: 'pointArc';
  s: Id;
  t: Id;
  v: number;
  vId: Id;
  tc: number;
  tcId: Id;
  ts: number;
  tsId: Id;
  te: number;
  teId: Id;
}
interface CirclePair {
  kind: 'circle';
  s: Id;
  t: Id;
  sc: number;
  scId: Id;
  sr: number;
  tc: number;
  tcId: Id;
  tr: number;
  sigma: number;
}
type Pair = LinePair | ArcPair | PointArcPair | CirclePair;

const P = (i: number) => [i, i + 1];
const uniq = (xs: number[]): number[] => [...new Set(xs)];
const X = (x: Float64Array, i: number) => x[i] as number;

function hyp(x: Float64Array, i: number, j: number): number {
  return Math.hypot(X(x, i) - X(x, j), X(x, i + 1) - X(x, j + 1));
}

/** Signed distance (left positive) from point p to the line s→e. */
function signedDist(x: Float64Array, p: number, s: number, e: number): number {
  const dx = X(x, e) - X(x, s);
  const dy = X(x, e + 1) - X(x, s + 1);
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return Number.NaN;
  return (dx * (X(x, p + 1) - X(x, s + 1)) - dy * (X(x, p) - X(x, s))) / l;
}

const sign = (v: number): number => (v < 0 ? -1 : 1);

/** Resolves and checks the pairs of an offset dimension (shared by measuring and encoding). */
export function offsetPairs(ctx: OffsetContext, c: OffsetConstraint): Pair[] | string {
  if (c.sources.length === 0 || c.sources.length !== c.targets.length) {
    return 'An offset needs one source for each target';
  }
  const seen = new Set<Id>();
  const pairs: Pair[] = [];
  const x = ctx.x0;
  for (let i = 0; i < c.targets.length; i++) {
    const sId = c.sources[i] as Id;
    const tId = c.targets[i] as Id;
    if (seen.has(tId)) return 'An entity can only be offset once in the same offset';
    seen.add(tId);
    if (sId === tId) return 'An entity cannot be offset from itself';
    if (isSketchReference(tId)) return 'The origin and axes cannot be offset copies';
    const s = ctx.index.get(sId);
    const t = ctx.index.get(tId);
    if (!s || !t) return `Unknown entity ${s ? tId : sId}`;
    if (s.kind === 'line' && t.kind === 'line') {
      const ss = ctx.pointOf(s.start, c.id);
      const se = ctx.pointOf(s.end, c.id);
      const ts = ctx.pointOf(t.start, c.id);
      const te = ctx.pointOf(t.end, c.id);
      const dot =
        (X(x, se) - X(x, ss)) * (X(x, te) - X(x, ts)) +
        (X(x, se + 1) - X(x, ss + 1)) * (X(x, te + 1) - X(x, ts + 1));
      const d = (signedDist(x, ts, ss, se) + signedDist(x, te, ss, se)) / 2;
      pairs.push({
        kind: 'line',
        s: sId,
        t: tId,
        ss,
        se,
        ssId: s.start,
        seId: s.end,
        ts,
        te,
        tsId: t.start,
        teId: t.end,
        same: dot >= 0,
        sigma: Number.isFinite(d) ? sign(d) : 1,
        infinite: isSketchReference(sId),
      });
    } else if (s.kind === 'arc' && t.kind === 'arc') {
      const sc = ctx.pointOf(s.center, c.id);
      const sStart = ctx.pointOf(s.start, c.id);
      const sEnd = ctx.pointOf(s.end, c.id);
      const tc = ctx.pointOf(t.center, c.id);
      const ts = ctx.pointOf(t.start, c.id);
      const te = ctx.pointOf(t.end, c.id);
      pairs.push({
        kind: 'arc',
        s: sId,
        t: tId,
        sc,
        scId: s.center,
        sStart,
        sStartId: s.start,
        sEnd,
        sEndId: s.end,
        tc,
        tcId: t.center,
        ts,
        tsId: t.start,
        te,
        teId: t.end,
        sigma: sign(hyp(x, ts, tc) - hyp(x, sStart, sc)),
      });
    } else if (s.kind === 'point' && t.kind === 'arc') {
      pairs.push({
        kind: 'pointArc',
        s: sId,
        t: tId,
        v: ctx.pointOf(sId, c.id),
        vId: sId,
        tc: ctx.pointOf(t.center, c.id),
        tcId: t.center,
        ts: ctx.pointOf(t.start, c.id),
        tsId: t.start,
        te: ctx.pointOf(t.end, c.id),
        teId: t.end,
      });
    } else if (s.kind === 'circle' && t.kind === 'circle') {
      const sr = ctx.radiusIdx.get(sId) as number;
      const tr = ctx.radiusIdx.get(tId) as number;
      pairs.push({
        kind: 'circle',
        s: sId,
        t: tId,
        sc: ctx.pointOf(s.center, c.id),
        scId: s.center,
        sr,
        tc: ctx.pointOf(t.center, c.id),
        tcId: t.center,
        tr,
        sigma: sign(X(x, tr) - X(x, sr)),
      });
    } else {
      return `A ${t.kind} can't be the offset of a ${s.kind === 'point' ? 'point' : s.kind}`;
    }
  }
  return pairs;
}

/** The offset distance measured on pair `p` (≥ 0 on the side the target is on). */
function pairMeasure(p: Pair): { params: number[]; fn: (x: Float64Array) => number } {
  switch (p.kind) {
    case 'line':
      return {
        params: uniq([...P(p.ss), ...P(p.se), ...P(p.ts), ...P(p.te)]),
        fn: (x) =>
          (p.sigma * (signedDist(x, p.ts, p.ss, p.se) + signedDist(x, p.te, p.ss, p.se))) / 2,
      };
    case 'arc':
      return {
        params: uniq([...P(p.sc), ...P(p.sStart), ...P(p.tc), ...P(p.ts)]),
        fn: (x) => p.sigma * (hyp(x, p.ts, p.tc) - hyp(x, p.sStart, p.sc)),
      };
    case 'circle':
      return {
        params: [p.sr, p.tr],
        fn: (x) => p.sigma * (X(x, p.tr) - X(x, p.sr)),
      };
    case 'pointArc':
      return { params: uniq([...P(p.tc), ...P(p.ts)]), fn: (x) => hyp(x, p.ts, p.tc) };
  }
}

export function offsetMeasure(ctx: OffsetContext, c: OffsetConstraint): Measure | string {
  const pairs = offsetPairs(ctx, c);
  if (typeof pairs === 'string') return pairs;
  const best = pairs.find((p) => p.kind !== 'pointArc') ?? (pairs[0] as Pair);
  return { ...pairMeasure(best), angular: false };
}

interface Member {
  pair: Pair;
  /** Which end of the target this is. */
  role: 'start' | 'end';
  p: number;
  pid: Id;
}

/** Unit normal of a target's curve at one of its ends (geometry `x`), or null if degenerate. */
function memberNormal(m: Member, x: Float64Array): [number, number] | null {
  const pr = m.pair;
  if (pr.kind === 'line') {
    const dx = X(x, pr.te) - X(x, pr.ts);
    const dy = X(x, pr.te + 1) - X(x, pr.ts + 1);
    const l = Math.hypot(dx, dy);
    return l < 1e-12 ? null : [-dy / l, dx / l];
  }
  if (pr.kind === 'arc' || pr.kind === 'pointArc') {
    const dx = X(x, m.p) - X(x, pr.tc);
    const dy = X(x, m.p + 1) - X(x, pr.tc + 1);
    const l = Math.hypot(dx, dy);
    return l < 1e-12 ? null : [dx / l, dy / l];
  }
  return null;
}

/**
 * Rows and planegcs primitives for a driving offset of value `v` (> 0). Returns a reason string
 * when the offset can't be encoded.
 */
export function encodeOffset(
  ctx: OffsetContext,
  c: OffsetConstraint,
  v: number,
  priority: number,
  nextId: () => string,
): { rows: Row[]; prims: SketchPrimitive[] } | string {
  if (!(v > 0)) return 'An offset distance must be greater than zero';
  const pairs = offsetPairs(ctx, c);
  if (typeof pairs === 'string') return pairs;
  const rows: Row[] = [];
  const prims: SketchPrimitive[] = [];
  const gid = ctx.gid;
  const row = (params: number[], f: (x: Float64Array) => number) =>
    rows.push({ owner: c.id, internal: false, params: uniq(params), f, angular: false, priority });

  // Concentric centres and circle radii.
  for (const p of pairs) {
    if (p.kind === 'line') continue;
    const sc = p.kind === 'pointArc' ? p.v : p.sc;
    const scId = p.kind === 'pointArc' ? p.vId : p.scId;
    if (sc !== p.tc) {
      row([...P(sc), ...P(p.tc)], (x) => X(x, p.tc) - X(x, sc));
      row([...P(sc), ...P(p.tc)], (x) => X(x, p.tc + 1) - X(x, sc + 1));
      prims.push({ id: nextId(), type: 'p2p_coincident', p1_id: gid(p.tcId), p2_id: gid(scId) });
    }
    if (p.kind === 'circle') {
      const d = p.sigma * v;
      row([p.sr, p.tr], (x) => X(x, p.tr) - X(x, p.sr) - d);
      prims.push({
        id: nextId(),
        type: 'difference',
        param1: { o_id: gid(p.s), prop: 'radius' },
        param2: { o_id: gid(p.t), prop: 'radius' },
        difference: d,
      });
    }
  }

  // Group target end points by coincidence class, in pair order.
  const groups = new Map<Id, Member[]>();
  for (const pair of pairs) {
    if (pair.kind === 'circle') continue;
    const ends: Member[] = [
      { pair, role: 'start', p: pair.ts, pid: pair.tsId },
      { pair, role: 'end', p: pair.te, pid: pair.teId },
    ];
    for (const m of ends) {
      const key = ctx.root(m.pid);
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
  }

  const drops = new Map<Id, number>();
  const membership = (m: Member) => {
    const pr = m.pair;
    // Arcs: memberships are the radius row (added below unless dropped) and the arc rule.
    if (pr.kind !== 'line') return;
    const d = pr.sigma * v;
    row([...P(m.p), ...P(pr.ss), ...P(pr.se)], (x) => signedDist(x, m.p, pr.ss, pr.se) - d);
    prims.push({ id: nextId(), type: 'p2l_distance', p_id: gid(m.pid), l_id: gid(pr.s), distance: v });
  };
  const squareEnd = (m: Member): boolean => {
    const pr = m.pair;
    const p = m.p;
    if (pr.kind === 'line') {
      if (pr.infinite) return false;
      const startEnd = (m.role === 'start') === pr.same;
      const vv = startEnd ? pr.ss : pr.se;
      const vId = startEnd ? pr.ssId : pr.seId;
      row([...P(p), ...P(vv), ...P(pr.ss), ...P(pr.se)], (x) => {
        const dx = X(x, pr.se) - X(x, pr.ss);
        const dy = X(x, pr.se + 1) - X(x, pr.ss + 1);
        const l = Math.hypot(dx, dy);
        if (l < 1e-12) return Number.NaN;
        return ((X(x, p) - X(x, vv)) * dx + (X(x, p + 1) - X(x, vv + 1)) * dy) / l;
      });
      // Signed for planegcs too (its point–line distance is unsigned): the end leaves the
      // source end at +90° (left) or −90° (right) to the source direction.
      prims.push({
        id: nextId(),
        type: 'l2l_angle_pppp',
        l1p1_id: gid(pr.ssId),
        l1p2_id: gid(pr.seId),
        l2p1_id: gid(vId),
        l2p2_id: gid(m.pid),
        angle: (pr.sigma * Math.PI) / 2,
      });
      return true;
    }
    if (pr.kind === 'arc') {
      const vv = m.role === 'start' ? pr.sStart : pr.sEnd;
      const vId = m.role === 'start' ? pr.sStartId : pr.sEndId;
      row([...P(p), ...P(vv), ...P(pr.sc)], (x) => {
        const ux = X(x, vv) - X(x, pr.sc);
        const uy = X(x, vv + 1) - X(x, pr.sc + 1);
        const l = Math.hypot(ux, uy);
        if (l < 1e-12) return Number.NaN;
        return ((X(x, p) - X(x, pr.sc)) * uy - (X(x, p + 1) - X(x, pr.sc + 1)) * ux) / l;
      });
      prims.push({
        id: nextId(),
        type: 'point_on_line_ppp',
        p_id: gid(m.pid),
        lp1_id: gid(pr.scId),
        lp2_id: gid(vId),
      });
      return true;
    }
    return false;
  };

  for (const members of groups.values()) {
    if (members.length === 1) {
      const m = members[0] as Member;
      membership(m);
      squareEnd(m);
      continue;
    }
    if (members.length > 2) {
      for (const m of members) membership(m);
      continue;
    }
    const [a, b] = members as [Member, Member];
    const na = memberNormal(a, ctx.x0);
    const nb = memberNormal(b, ctx.x0);
    const tangent =
      na === null || nb === null || Math.abs(na[0] * nb[1] - na[1] * nb[0]) < OFFSET_TANGENT_TOL;
    if (!tangent) {
      membership(a);
      membership(b);
      continue;
    }
    // Tangent joint: one membership + a square end. Lines give theirs up first, then the arc
    // that has given up fewer (the second on a tie).
    let drop: Member;
    if (b.pair.kind === 'line') drop = b;
    else if (a.pair.kind === 'line') drop = a;
    else drop = (drops.get(a.pair.t) ?? 0) < (drops.get(b.pair.t) ?? 0) ? a : b;
    const keep = drop === a ? b : a;
    drops.set(drop.pair.t, (drops.get(drop.pair.t) ?? 0) + 1);
    membership(keep);
    if (!squareEnd(keep)) squareEnd(drop);
  }

  for (const p of pairs) {
    if (p.kind !== 'arc' && p.kind !== 'pointArc') continue;
    if ((drops.get(p.t) ?? 0) > 0) continue;
    if (p.kind === 'arc') {
      const d = p.sigma * v;
      row([...P(p.ts), ...P(p.tc), ...P(p.sStart), ...P(p.sc)], (x) => {
        return hyp(x, p.ts, p.tc) - hyp(x, p.sStart, p.sc) - d;
      });
      prims.push({
        id: nextId(),
        type: 'difference',
        param1: { o_id: gid(p.s), prop: 'radius' },
        param2: { o_id: gid(p.t), prop: 'radius' },
        difference: d,
      });
    } else {
      row([...P(p.ts), ...P(p.tc)], (x) => hyp(x, p.ts, p.tc) - v);
      prims.push({ id: nextId(), type: 'arc_radius', a_id: gid(p.t), radius: v });
    }
  }
  return { rows, prims };
}
