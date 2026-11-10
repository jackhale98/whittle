/**
 * Offset Entities (PLAN §12 M3): a curve, a chain or a closed loop offset by one driving
 * distance, to one side or both.
 *
 *  - Lines stay parallel; arcs and circles become concentric (radius ± d).
 *  - Corners are joined: a convex corner gets an arc of radius d around the source corner (or,
 *    with `corners: 'sharp'`, line–line corners are extended to meet); a concave corner is
 *    trimmed to the intersection of the two offsets. Smooth (tangent) joints share a point.
 *  - An arc whose offset radius would be ≤ 0, and a segment that the neighbouring trims would
 *    consume, are left out with a note; their neighbours are joined at their intersection.
 *  - A result that would cross itself is refused rather than returned.
 *
 * The result carries one `offset` dimension (driving, the given expression) whose pairs are the
 * source curves → their offsets, plus source corner points → join / cap arcs. The solver keeps the
 * offset (offset-model.ts).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Expr, Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { add, dist, lerp, normalize, perp, scale, sub, TAU } from '../geometry';
import { buildModel, violatedRows } from '../model';
import { OFFSET_TANGENT_TOL } from '../offset-model';
import {
  arcEnd,
  arcStart,
  type Curve,
  carrierIntersections,
  extentIntersections,
  lineLine,
  turnAngle,
} from './curves';
import {
  coincidenceRoots,
  type EditOptions,
  formatMm,
  refuse,
  type SketchData,
  SketchDraft,
  type SketchEditResult,
} from './draft';

export type OffsetSide = 'left' | 'right' | 'both' | 'inside' | 'outside' | { toward: Vec2 };

export interface OffsetOptions extends EditOptions {
  /** Offset distance, mm (> 0): the evaluated value of `expr`. */
  distance: number;
  /**
   * The distance expression (default "<distance> mm"). The offset dimension stores it as is when
   * the offset lies to the right of its (reference) source, as the contract's sign convention
   * reads, and negated (`-5 mm`, `-(wall + 1 mm)`) when it lies to the left.
   */
  expr?: Expr;
  /**
   * Side, relative to the chain direction (the first selected curve's own direction: start → end
   * for a line, counter-clockwise for an arc or circle), or inside/outside a closed loop, or the
   * side a picked point is on. Default `left`.
   */
  side?: OffsetSide;
  /** Open chains offset on both sides: close the ends with a line or a half circle. */
  cap?: 'none' | 'line' | 'arc';
  /** Convex line–line corners: an arc (default) or the extended lines' intersection. */
  corners?: 'round' | 'sharp';
  /** Make the offset construction geometry (default: same as each source). */
  construction?: boolean;
}

type ArcCurve = Extract<Curve, { kind: 'arc' }>;

interface El {
  id: Id;
  kind: 'line' | 'arc';
  /** Traversed against the entity's own direction (end → start, or clockwise for an arc). */
  rev: boolean;
  /** Traversal start / end point ids. */
  sPid: Id;
  ePid: Id;
  construction: boolean;
}

interface Chain {
  els: El[];
  closed: boolean;
}

interface OffEl {
  idx: number;
  el: El;
  /** Line in traversal direction, or the CCW offset arc. */
  curve: Curve;
  start: Vec2;
  end: Vec2;
}

type Joint =
  | { kind: 'shared'; p: Vec2 }
  | { kind: 'round'; p: Vec2; q: Vec2; v: Vec2; vPid: Id; construction: boolean };

interface SideResult {
  /** Traversal start / end point ids of the open chain's offset (null when closed). */
  startPid: Id | null;
  endPid: Id | null;
  /** Whether the chain's first / last source curve kept its offset. */
  firstKept: boolean;
  lastKept: boolean;
}

const MIN_LEN = 1e-6;

export function offsetEntities(
  sketch: SketchData,
  ids: readonly Id[],
  options: OffsetOptions,
): SketchEditResult {
  const d = options.distance;
  if (!(d > 0) || !Number.isFinite(d))
    return refuse('The offset distance must be greater than zero');
  const k = new SketchDraft(sketch, options);
  const selection = [...new Set(ids)];
  const curves: SketchEntity[] = [];
  for (const id of selection) {
    const e = k.get(id);
    if (!e) return refuse('That entity is not in the sketch');
    if (e.kind === 'ellipse' || e.kind === 'ellipticArc')
      return refuse(
        `Ellipses and elliptic arcs can't be offset (${k.name(id)}): the offset of an ellipse is not an ellipse, and Wren doesn't approximate it`,
      );
    if (e.kind === 'bspline')
      return refuse(
        `Splines can't be offset (${k.name(id)}): the offset of a spline is not a spline, and Wren doesn't approximate it`,
      );
    if (e.kind !== 'point') curves.push(e);
  }
  if (curves.length === 0) return refuse('Pick a line, arc or circle to offset');

  const chains = buildChains(k, curves, sketch);
  if (typeof chains === 'string') return refuse(chains);
  const circles = curves.filter((e) => e.kind === 'circle');

  const sources: Id[] = [];
  const targets: Id[] = [];
  const pair = (s: Id, t: Id) => {
    sources.push(s);
    targets.push(t);
  };
  const side = options.side ?? 'left';
  const outCurves: { id: Id; curve: Curve }[] = [];

  for (const chain of chains) {
    const deltas = chainDeltas(k, chain, side, d);
    if (typeof deltas === 'string') return refuse(deltas);
    const results: SideResult[] = [];
    for (const delta of deltas) {
      const r = offsetChain(k, chain, delta, options, pair, outCurves);
      if (typeof r === 'string') return refuse(r);
      results.push(r);
    }
    if (deltas.length === 2 && !chain.closed && (options.cap ?? 'none') !== 'none') {
      capEnds(k, chain, results as [SideResult, SideResult], options, pair, outCurves);
    }
  }

  for (const c of circles) {
    if (c.kind !== 'circle') continue;
    const center = k.pos(c.center);
    const deltas = circleDeltas(c.radius, center, side, d);
    for (const delta of deltas) {
      // Left of a counter-clockwise circle is inside.
      const r = c.radius - delta;
      if (!(r > MIN_LEN * k.scale)) {
        k.notes.push(`${k.name(c.id)} was left out: its offset radius would be ${formatMm(r)}`);
        continue;
      }
      const construction = options.construction ?? c.construction;
      const t = k.circle(k.point(center, construction), r, construction);
      pair(c.id, t);
      outCurves.push({ id: t, curve: { kind: 'circle', c: center, r } });
    }
  }
  if (targets.length === 0) return refuse(`A ${formatMm(d)} offset leaves nothing on that side`);

  const crossing = selfIntersection(k, outCurves);
  if (crossing) {
    return refuse(
      `A ${formatMm(d)} offset would cross itself (${crossing}); try a smaller distance`,
    );
  }

  // Contract sign: positive = right of the reference source's direction. Lead with a pair that
  // is on the right when there is one, so the value reads as typed; else store it negated.
  const sides = targets.map((t, i) => rightOf(k, sources[i] as Id, t));
  let lead = sides.indexOf(1);
  if (lead < 0) lead = sides.findIndex((v) => v !== 0);
  if (lead > 0) {
    sources.unshift(...sources.splice(lead, 1));
    targets.unshift(...targets.splice(lead, 1));
  }
  const sign = lead >= 0 && sides[lead] === -1 ? -1 : 1;
  const expr = options.expr ?? `${d} mm`;
  const offsetId = k.addConstraint({
    kind: 'offset',
    sources,
    targets,
    value: sign > 0 ? expr : negate(expr),
    driving: true,
  });

  // The solver must accept the geometry as built (guards the construction against mistakes).
  const check = checkRows(k, offsetId, sign * d);
  if (check) return refuse(check);

  const both = side === 'both' ? ' on both sides' : '';
  const what = curves.length === 1 ? k.name(curves[0]?.id as Id) : `${curves.length} entities`;
  return k.finish(`Offset ${what} by ${formatMm(d)}${both}`);
}

// ---------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------

function buildChains(
  k: SketchDraft,
  curves: readonly SketchEntity[],
  sketch: SketchData,
): Chain[] | string {
  const root = coincidenceRoots(sketch.constraints);
  const ends = new Map<Id, [Id, Id]>();
  const adj = new Map<Id, Id[]>();
  const order: Id[] = [];
  for (const e of curves) {
    if (e.kind !== 'line' && e.kind !== 'arc') continue;
    const a = root(e.start);
    const b = root(e.end);
    if (a === b) return `${k.name(e.id)} starts and ends at the same point`;
    ends.set(e.id, [a, b]);
    order.push(e.id);
    for (const n of [a, b]) {
      const list = adj.get(n);
      if (list) list.push(e.id);
      else adj.set(n, [e.id]);
    }
  }
  for (const [n, list] of adj) {
    if (list.length > 2) {
      const at = k.get(n)?.kind === 'point' ? k.name(n) : 'a point';
      return `The selection branches at ${at}; offset one chain at a time`;
    }
  }
  const used = new Set<Id>();
  const chains: Chain[] = [];
  const el = (id: Id, rev: boolean): El => {
    const e = k.get(id) as Extract<SketchEntity, { kind: 'line' | 'arc' }>;
    return {
      id,
      kind: e.kind,
      rev,
      sPid: rev ? e.end : e.start,
      ePid: rev ? e.start : e.end,
      construction: e.construction,
    };
  };
  for (const first of order) {
    if (used.has(first)) continue;
    // Walk back from `first` to an open end (or all the way round).
    let node = (ends.get(first) as [Id, Id])[0];
    let prev = first;
    let closed = false;
    for (;;) {
      const next = (adj.get(node) ?? []).find((id) => id !== prev);
      if (next === undefined) break;
      if (next === first) {
        closed = true;
        break;
      }
      const [a, b] = ends.get(next) as [Id, Id];
      node = a === node ? b : a;
      prev = next;
    }
    // Walk forward from the open end (or from `first` itself when closed).
    const els: El[] = [];
    let cur: Id;
    let at: Id;
    if (closed) {
      cur = first;
      at = (ends.get(first) as [Id, Id])[0];
    } else {
      cur = prev;
      at = node;
    }
    for (;;) {
      const [a, b] = ends.get(cur) as [Id, Id];
      const rev = a !== at;
      els.push(el(cur, rev));
      used.add(cur);
      at = rev ? a : b;
      const next = (adj.get(at) ?? []).find((id) => id !== cur);
      if (next === undefined || used.has(next)) break;
      cur = next;
    }
    // The chain runs the way the first selected curve does.
    const f = els.find((x) => x.id === first) as El;
    if (f.rev) {
      els.reverse();
      for (let i = 0; i < els.length; i++) els[i] = el((els[i] as El).id, !(els[i] as El).rev);
    }
    chains.push({ els, closed });
  }
  return chains;
}

interface ElGeom {
  curve: Curve;
  /** Traversal start / end positions and tangents. */
  a: Vec2;
  b: Vec2;
  ta: Vec2;
  tb: Vec2;
}

function elGeom(k: SketchDraft, el: El): ElGeom {
  const c = k.curve(el.id) as Curve;
  if (c.kind === 'line') {
    const a = el.rev ? c.b : c.a;
    const b = el.rev ? c.a : c.b;
    const t = normalize(sub(b, a));
    return { curve: c, a, b, ta: t, tb: t };
  }
  const arc = c as ArcCurve;
  const tan = (ang: number): Vec2 =>
    el.rev ? [Math.sin(ang), -Math.cos(ang)] : [-Math.sin(ang), Math.cos(ang)];
  const s = arcStart(arc);
  const e = arcEnd(arc);
  return el.rev
    ? { curve: arc, a: e, b: s, ta: tan(arc.a0 + arc.sweep), tb: tan(arc.a0) }
    : { curve: arc, a: s, b: e, ta: tan(arc.a0), tb: tan(arc.a0 + arc.sweep) };
}

/** Signed area of a closed chain (CCW > 0), from its sampled outline. */
function chainArea(k: SketchDraft, chain: Chain): number {
  const pts: Vec2[] = [];
  for (const el of chain.els) {
    const g = elGeom(k, el);
    if (g.curve.kind === 'line') pts.push(g.a);
    else if (g.curve.kind === 'arc') {
      const n = 16;
      for (let i = 0; i < n; i++) {
        const t = el.rev ? g.curve.sweep * (1 - i / n) : g.curve.sweep * (i / n);
        pts.push(
          add(g.curve.c, [
            Math.cos(g.curve.a0 + t) * g.curve.r,
            Math.sin(g.curve.a0 + t) * g.curve.r,
          ]),
        );
      }
    }
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Vec2;
    const q = pts[(i + 1) % pts.length] as Vec2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Signed deltas (left of the chain direction positive) for the requested side. */
function chainDeltas(k: SketchDraft, chain: Chain, side: OffsetSide, d: number): number[] | string {
  if (side === 'left') return [d];
  if (side === 'right') return [-d];
  if (side === 'both') return [d, -d];
  if (side === 'inside' || side === 'outside') {
    if (!chain.closed) return 'Inside and outside need a closed loop; pick a side instead';
    const ccw = chainArea(k, chain) > 0;
    // Left of a counter-clockwise loop is its inside.
    return [(side === 'inside') === ccw ? d : -d];
  }
  // The side the picked point is on, relative to the nearest curve of the chain.
  let best = Number.POSITIVE_INFINITY;
  let s = 1;
  for (const el of chain.els) {
    const g = elGeom(k, el);
    const c = g.curve;
    let dd: number;
    let left: boolean;
    if (c.kind === 'line') {
      const t = Math.min(1, Math.max(0, projT(c.a, c.b, side.toward)));
      dd = dist(side.toward, lerp(c.a, c.b, t));
      const dir = sub(g.b, g.a);
      left = dir[0] * (side.toward[1] - g.a[1]) - dir[1] * (side.toward[0] - g.a[0]) > 0;
    } else {
      const r = dist(side.toward, (c as ArcCurve).c);
      dd = Math.abs(r - (c as ArcCurve).r);
      // Left of a counter-clockwise arc is inside.
      left = r < (c as ArcCurve).r !== el.rev;
    }
    if (dd < best) {
      best = dd;
      s = left ? 1 : -1;
    }
  }
  return [s * d];
}

function circleDeltas(r: number, c: Vec2, side: OffsetSide, d: number): number[] {
  if (side === 'both') return [d, -d];
  if (side === 'left' || side === 'inside') return [d];
  if (side === 'right' || side === 'outside') return [-d];
  return [dist(side.toward, c) < r ? d : -d];
}

function projT(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  return l2 === 0 ? 0 : ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2;
}

// ---------------------------------------------------------------------------------------------
// One side of one chain
// ---------------------------------------------------------------------------------------------

function offsetChain(
  k: SketchDraft,
  chain: Chain,
  delta: number,
  options: OffsetOptions,
  pair: (s: Id, t: Id) => void,
  outCurves: { id: Id; curve: Curve }[],
): SideResult | string {
  const d = Math.abs(delta);
  const geoms = chain.els.map((el) => elGeom(k, el));
  const n = chain.els.length;
  const minLen = MIN_LEN * k.scale;

  // 1. Offset every curve; arcs whose radius would vanish are left out.
  const offs: (OffEl | null)[] = chain.els.map((el, idx) => {
    const g = geoms[idx] as ElGeom;
    if (g.curve.kind === 'line') {
      const nrm = scale(perp(normalize(sub(g.b, g.a))), delta);
      const a = add(g.a, nrm);
      const b = add(g.b, nrm);
      return { idx, el, curve: { kind: 'line', a, b }, start: a, end: b };
    }
    const arc = g.curve as ArcCurve;
    // Left of a counter-clockwise arc is towards its centre.
    const r = el.rev ? arc.r + delta : arc.r - delta;
    if (!(r > minLen)) {
      k.notes.push(`${k.name(el.id)} was left out: its offset radius would be ${formatMm(r)}`);
      return null;
    }
    const curve: ArcCurve = { kind: 'arc', c: arc.c, r, a0: arc.a0, sweep: arc.sweep };
    const s = arcStart(curve);
    const e = arcEnd(curve);
    return { idx, el, curve, start: el.rev ? e : s, end: el.rev ? s : e };
  });

  let kept = offs.filter((o): o is OffEl => o !== null);
  let joints: Joint[] = [];
  let trimmed: { start: Vec2; end: Vec2 }[] = [];
  for (let round = 0; round <= n; round++) {
    if (kept.length === 0) return `A ${formatMm(d)} offset leaves nothing of this chain`;
    if (chain.closed && kept.length < 2)
      return `A ${formatMm(d)} offset doesn't fit inside this loop`;
    joints = [];
    const m = kept.length;
    const count = chain.closed ? m : m - 1;
    for (let i = 0; i < count; i++) {
      const a = kept[i] as OffEl;
      const b = kept[(i + 1) % m] as OffEl;
      const j = joint(k, chain, geoms, a, b, delta, options.corners ?? 'round');
      if (typeof j === 'string') return j;
      joints.push(j);
    }
    trimmed = kept.map((o, i) => {
      const before = chain.closed || i > 0 ? joints[(i - 1 + m) % m] : null;
      const after = chain.closed || i < m - 1 ? joints[i] : null;
      const start = before ? (before.kind === 'shared' ? before.p : before.q) : o.start;
      const end = after ? after.p : o.end;
      return { start, end };
    });
    // A curve the trims turn inside out is left out; its neighbours are joined instead.
    let worst = -1;
    let worstExtent = Number.POSITIVE_INFINITY;
    kept.forEach((o, i) => {
      const t = trimmed[i] as { start: Vec2; end: Vec2 };
      const ext = extent(o, t.start, t.end);
      if (ext < minLen && ext < worstExtent) {
        worstExtent = ext;
        worst = i;
      }
    });
    if (worst < 0) break;
    const gone = kept[worst] as OffEl;
    k.notes.push(`${k.name(gone.el.id)} was left out: it is too short for a ${formatMm(d)} offset`);
    kept = kept.filter((_, i) => i !== worst);
    if (round === n) return `A ${formatMm(d)} offset doesn't fit this chain`;
  }

  // 2. Points: joints are shared; round joints get a join arc.
  const m = kept.length;
  const construction = (el: El) => options.construction ?? el.construction;
  const startPid: Id[] = new Array(m);
  const endPid: Id[] = new Array(m);
  const joinArcs: { after: number; j: Extract<Joint, { kind: 'round' }> }[] = [];
  joints.forEach((j, i) => {
    const a = kept[i] as OffEl;
    const next = (i + 1) % m;
    if (j.kind === 'shared') {
      const p = k.point(j.p, construction(a.el));
      endPid[i] = p;
      startPid[next] = p;
    } else {
      endPid[i] = k.point(j.p, construction(a.el));
      startPid[next] = k.point(j.q, construction((kept[next] as OffEl).el));
      joinArcs.push({ after: i, j });
    }
  });
  if (!chain.closed) {
    startPid[0] = k.point(
      (trimmed[0] as { start: Vec2 }).start,
      construction((kept[0] as OffEl).el),
    );
    endPid[m - 1] = k.point(
      (trimmed[m - 1] as { end: Vec2 }).end,
      construction((kept[m - 1] as OffEl).el),
    );
  }

  // 3. Target curves, in the sources' own orientation.
  kept.forEach((o, i) => {
    const s = startPid[i] as Id;
    const e = endPid[i] as Id;
    const con = construction(o.el);
    const t = trimmed[i] as { start: Vec2; end: Vec2 };
    let id: Id;
    let curve: Curve;
    if (o.el.kind === 'line') {
      id = o.el.rev ? k.line(e, s, con) : k.line(s, e, con);
      curve = { kind: 'line', a: t.start, b: t.end };
    } else {
      const arc = o.curve as ArcCurve;
      const c = k.point(arc.c, con);
      id = o.el.rev ? k.arc(c, e, s, con) : k.arc(c, s, e, con);
      curve = arcThrough(arc.c, o.el.rev ? t.end : t.start, o.el.rev ? t.start : t.end);
    }
    pair(o.el.id, id);
    outCurves.push({ id, curve });
  });
  for (const { after, j } of joinArcs) {
    const p = endPid[after] as Id;
    const q = startPid[(after + 1) % m] as Id;
    const c = k.point(j.v, j.construction);
    // Left offsets turn clockwise around a convex corner, right offsets counter-clockwise.
    const id = delta > 0 ? k.arc(c, q, p, j.construction) : k.arc(c, p, q, j.construction);
    pair(j.vPid, id);
    outCurves.push({
      id,
      curve: delta > 0 ? arcThrough(j.v, j.q, j.p) : arcThrough(j.v, j.p, j.q),
    });
  }

  return {
    startPid: chain.closed ? null : (startPid[0] as Id),
    endPid: chain.closed ? null : (endPid[m - 1] as Id),
    firstKept: (kept[0] as OffEl).idx === 0,
    lastKept: (kept[m - 1] as OffEl).idx === n - 1,
  };
}

function arcThrough(c: Vec2, start: Vec2, end: Vec2): ArcCurve {
  const r = dist(c, start);
  const a0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
  let sweep = Math.atan2(end[1] - c[1], end[0] - c[0]) - a0;
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU) sweep -= TAU;
  return { kind: 'arc', c, r, a0, sweep };
}

/** Signed length of a trimmed offset curve (≤ 0 when the trims cross). */
function extent(o: OffEl, start: Vec2, end: Vec2): number {
  if (o.curve.kind === 'line') {
    const dir = normalize(sub(o.end, o.start));
    return (end[0] - start[0]) * dir[0] + (end[1] - start[1]) * dir[1];
  }
  const arc = o.curve as ArcCurve;
  // In counter-clockwise terms: how far the start moved forward, the end moved back.
  const ccwStart = o.el.rev ? end : start;
  const ccwEnd = o.el.rev ? start : end;
  const ang = (p: Vec2) => Math.atan2(p[1] - arc.c[1], p[0] - arc.c[0]);
  const wrap = (a: number) => {
    let r = a % TAU;
    if (r > Math.PI) r -= TAU;
    if (r <= -Math.PI) r += TAU;
    return r;
  };
  const uS = wrap(ang(ccwStart) - arc.a0);
  const uE = arc.sweep + wrap(ang(ccwEnd) - (arc.a0 + arc.sweep));
  const sweep = uE - uS;
  if (sweep >= TAU - 1e-9) return -1;
  return sweep * arc.r;
}

function joint(
  k: SketchDraft,
  chain: Chain,
  geoms: readonly ElGeom[],
  a: OffEl,
  b: OffEl,
  delta: number,
  corners: 'round' | 'sharp',
): Joint | string {
  const n = chain.els.length;
  const adjacent = (a.idx + 1) % n === b.idx;
  const ref = lerp(a.end, b.start, 0.5);
  if (adjacent) {
    const ga = geoms[a.idx] as ElGeom;
    const gb = geoms[b.idx] as ElGeom;
    const theta = turnAngle(ga.tb, gb.ta);
    if (Math.abs(theta) < OFFSET_TANGENT_TOL) return { kind: 'shared', p: ref };
    if (Math.abs(theta) > Math.PI - 1e-6) {
      return `${k.name(b.el.id)} doubles back on ${k.name(a.el.id)}, so the offset can't join them`;
    }
    if (delta * theta < 0) {
      if (corners === 'sharp' && a.curve.kind === 'line' && b.curve.kind === 'line') {
        const x = lineLine(a.curve.a, a.curve.b, b.curve.a, b.curve.b);
        if (x) return { kind: 'shared', p: x };
      }
      return {
        kind: 'round',
        p: a.end,
        q: b.start,
        v: ga.b,
        vPid: a.el.ePid,
        construction: a.el.construction && b.el.construction,
      };
    }
  }
  const xs = carrierIntersections(a.curve, b.curve);
  if (xs.length === 0) {
    return `A ${formatMm(Math.abs(delta))} offset of ${k.name(a.el.id)} and ${k.name(b.el.id)} doesn't meet; try a smaller distance`;
  }
  let best = xs[0] as Vec2;
  for (const x of xs) if (dist(x, ref) < dist(best, ref)) best = x;
  return { kind: 'shared', p: best };
}

// ---------------------------------------------------------------------------------------------
// Caps, checks
// ---------------------------------------------------------------------------------------------

function capEnds(
  k: SketchDraft,
  chain: Chain,
  [left, right]: [SideResult, SideResult],
  options: OffsetOptions,
  pair: (s: Id, t: Id) => void,
  outCurves: { id: Id; curve: Curve }[],
) {
  const first = chain.els[0] as El;
  const last = chain.els[chain.els.length - 1] as El;
  const ends = [
    {
      el: first,
      v: first.sPid,
      l: left.startPid,
      r: right.startPid,
      kept: left.firstKept && right.firstKept,
      atStart: true,
    },
    {
      el: last,
      v: last.ePid,
      l: left.endPid,
      r: right.endPid,
      kept: left.lastKept && right.lastKept,
      atStart: false,
    },
  ];
  for (const e of ends) {
    if (e.l === null || e.r === null) continue;
    const con = options.construction ?? e.el.construction;
    const pl = k.pos(e.l);
    const pr = k.pos(e.r);
    if (options.cap === 'arc' && e.kept) {
      const v = k.pos(e.v);
      const c = k.point(v, con);
      // Around the far side of the end: start → end counter-clockwise.
      const [s, t] = e.atStart ? [e.l, e.r] : [e.r, e.l];
      const id = k.arc(c, s, t, con);
      pair(e.v, id);
      outCurves.push({ id, curve: e.atStart ? arcThrough(v, pl, pr) : arcThrough(v, pr, pl) });
      continue;
    }
    if (options.cap === 'arc') {
      k.notes.push(
        `The ${e.atStart ? 'start' : 'end'} was capped with a line: the offset left ${k.name(e.el.id)} out on one side`,
      );
    }
    const id = k.line(e.l, e.r, con);
    outCurves.push({ id, curve: { kind: 'line', a: pl, b: pr } });
  }
}

/** Names of two result curves that cross (other than where they join), or null. */
function selfIntersection(
  k: SketchDraft,
  curves: readonly { id: Id; curve: Curve }[],
): string | null {
  const tol = 1e-6 * k.scale;
  const endsOf = (c: Curve): Vec2[] =>
    c.kind === 'line' ? [c.a, c.b] : c.kind === 'arc' ? [arcStart(c), arcEnd(c)] : [];
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const a = curves[i] as { id: Id; curve: Curve };
      const b = curves[j] as { id: Id; curve: Curve };
      const shared = endsOf(a.curve).filter((p) =>
        endsOf(b.curve).some((q) => dist(p, q) <= tol * 10),
      );
      const xs = extentIntersections(a.curve, b.curve, tol).filter(
        (x) => !shared.some((s) => dist(s, x) <= 1e3 * tol),
      );
      if (xs.length) return `near ${fmt(xs[0] as Vec2)}`;
    }
  }
  return null;
}

/** +1 when target `t` lies right of source `s`'s direction (outside for arcs), −1 left, 0 n/a. */
function rightOf(k: SketchDraft, s: Id, t: Id): number {
  const se = k.get(s);
  const te = k.get(t);
  if (se?.kind === 'line' && te?.kind === 'line') {
    const a = k.pos(se.start);
    const b = k.pos(se.end);
    const p = k.pos(te.start);
    const left = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    return left > 0 ? -1 : 1;
  }
  const radius = (id: Id): number | null => {
    const c = k.curve(id);
    return c && c.kind !== 'line' ? c.r : null;
  };
  if ((se?.kind === 'arc' || se?.kind === 'circle') && se.kind === te?.kind) {
    return (radius(t) as number) > (radius(s) as number) ? 1 : -1;
  }
  return 0;
}

/** `-expr`, kept readable for a plain quantity ("5 mm" → "-5 mm", "-5 mm" → "5 mm"). */
export function negate(expr: Expr): Expr {
  const e = expr.trim();
  const plain = /^-?\s*\d+(\.\d+)?(\s*[a-zA-Zµ]+)?$/;
  if (plain.test(e)) return e.startsWith('-') ? e.slice(1).trim() : `-${e}`;
  return `-(${e})`;
}

const fmt = (p: Vec2) => `(${Math.round(p[0] * 100) / 100}, ${Math.round(p[1] * 100) / 100})`;

/** Null when the solver's offset rows hold on the built geometry, else a reason. */
function checkRows(k: SketchDraft, offsetId: Id, d: number): string | null {
  const constraints: SketchConstraint[] = k.constraints.filter((c) => c.id === offsetId);
  try {
    const model = buildModel({ entities: k.entities, constraints, values: { [offsetId]: d } });
    const why = model.invalid.get(offsetId);
    if (why) return why;
    const bad = violatedRows(model, model.x0);
    if (bad.length)
      return `A ${formatMm(d)} offset could not be built exactly here; try a smaller distance`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
