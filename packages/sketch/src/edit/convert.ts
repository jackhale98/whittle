/**
 * Convert Entities (PLAN §12 M3), the sketch side of projected model edges.
 *
 * The modeling side projects B-rep edges onto the sketch plane and hands over curves in
 * sketch-plane coordinates; here they become **linked** entities (`EntityBase.source`) that the
 * solver keeps fixed. Every regen calls `reprojectLinked` with fresh curves: linked entities are
 * updated in place (same ids, so constraints on them survive). A source missing from the fresh set
 * is reported as *lost* and its entities are left as they were (the app shows a ghost and Re-pick);
 * it is never matched to another edge. `unlinkEntities` turns linked geometry into ordinary
 * geometry.
 *
 * Splines and other curves arrive as polylines and become chains of lines, or of arcs where the
 * points lie on a circle, all marked `approximate`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, Id, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { add, circumcircle, cross, dist, fromAngle, lerp, sub, TAU } from '../geometry';
import { type EditOptions, type SketchData, SketchDraft, type SketchEdit } from './draft';

/** A projected model curve in sketch-plane coordinates (mm). */
export type ProjectedCurve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  /** Counter-clockwise from `start` to `end`: angles (rad) or points on the circle. */
  | { kind: 'arc'; c: Vec2; r: number; start: number | Vec2; end: number | Vec2 }
  | { kind: 'polyline'; points: Vec2[] };

export interface ProjectedEdge {
  ref: EntityRef;
  curve: ProjectedCurve;
}

export interface ConvertOptions extends EditOptions {
  /** Make the linked geometry construction (dimension references, ADR-017 item 2). */
  construction?: boolean;
  /** Fit tolerance for polylines, mm (default 0.01). */
  tolerance?: number;
  /**
   * Share end points: a converted line or arc end that lands on an existing linked point (within
   * 1e-6 of the sketch size) uses that point, so edges converted together, or one after another,
   * make a connected chain or loop (offset, trim and regions follow it). Default false.
   */
  join?: boolean;
}

export interface LostSource {
  ref: EntityRef;
  /** The linked entities that follow it (left unchanged: the app draws them as a ghost). */
  entities: Id[];
}

export type ReprojectResult = { ok: true } & SketchEdit & {
    /** Sources that no longer resolve: the sketch needs attention (ghost + Re-pick). */
    lost: LostSource[];
  };

type LinkedEntity = SketchEntity & { source: NonNullable<SketchEntity['source']> };

const isLinked = (e: SketchEntity): e is LinkedEntity => e.source !== undefined;

// ---------------------------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------------------------

export function convertEntities(
  sketch: SketchData,
  edges: readonly ProjectedEdge[],
  options: ConvertOptions = {},
): ({ ok: true } & SketchEdit) | { ok: false; reason: string } {
  if (edges.length === 0) return { ok: false, reason: 'Pick model edges to convert' };
  const k = new SketchDraft(sketch, options);
  const tol = options.tolerance ?? 0.01;
  const existing = new Set(sketch.entities.filter(isLinked).map((e) => e.source.ref.name));
  let made = 0;
  for (const edge of edges) {
    if (existing.has(edge.ref.name)) {
      k.notes.push(`${edge.ref.name} is already converted in this sketch`);
      continue;
    }
    const bad = invalidCurve(edge.curve);
    if (bad) return { ok: false, reason: `${edge.ref.name}: ${bad}` };
    existing.add(edge.ref.name);
    build(k, edge, options.construction ?? false, tol, options.join === true);
    made++;
  }
  if (made === 0) return { ok: false, reason: 'Those edges are already converted' };
  return k.finish(made === 1 ? 'Convert 1 edge' : `Convert ${made} edges`);
}

function invalidCurve(c: ProjectedCurve): string | null {
  const finite = (p: Vec2) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  switch (c.kind) {
    case 'line':
      return finite(c.a) && finite(c.b) ? null : 'the projected line is not finite';
    case 'circle':
    case 'arc':
      return finite(c.c) && c.r >= 0 && Number.isFinite(c.r)
        ? null
        : 'the projected circle is not valid';
    case 'polyline':
      return c.points.length >= 1 && c.points.every(finite)
        ? null
        : 'the projected polyline is empty';
  }
}

const angleOf = (c: Vec2, v: number | Vec2): number =>
  typeof v === 'number' ? v : Math.atan2(v[1] - c[1], v[0] - c[0]);

/** Creates the linked entities for one edge. */
function build(
  k: SketchDraft,
  edge: ProjectedEdge,
  construction: boolean,
  tol: number,
  join = false,
) {
  const exact = { ref: edge.ref };
  const approx = { ref: edge.ref, approximate: true };
  const linkPoint = (p: Vec2, source: LinkedEntity['source']): Id => {
    const id = k.point(p, construction);
    (k.get(id) as SketchEntity).source = source;
    return id;
  };
  /** A curve end: an existing linked point there when joining (corners of a converted loop). */
  const endPoint = (p: Vec2, source: LinkedEntity['source']): Id => {
    if (join) {
      const eps = 1e-6 * k.scale;
      const hit = k.entities.find(
        (e) => e.kind === 'point' && e.source !== undefined && dist([e.x, e.y], p) <= eps,
      );
      if (hit) return hit.id;
    }
    return linkPoint(p, source);
  };
  const link = (id: Id, source: LinkedEntity['source']) => {
    (k.get(id) as SketchEntity).source = source;
  };
  const c = edge.curve;
  switch (c.kind) {
    case 'line': {
      if (dist(c.a, c.b) <= 1e-9 * Math.max(1, Math.hypot(...c.a))) {
        linkPoint(c.a, exact); // An edge seen end-on projects to a point.
        return;
      }
      link(k.line(endPoint(c.a, exact), endPoint(c.b, exact), construction), exact);
      return;
    }
    case 'circle': {
      const center = linkPoint(c.c, exact);
      if (c.r <= 1e-9 * Math.max(1, c.r)) return;
      link(k.circle(center, c.r, construction), exact);
      return;
    }
    case 'arc': {
      const a0 = angleOf(c.c, c.start);
      const a1 = angleOf(c.c, c.end);
      const center = linkPoint(c.c, exact);
      if (c.r <= 0) return;
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += TAU;
      if (Math.abs(sweep - TAU) < 1e-12) {
        link(k.circle(center, c.r, construction), exact);
        return;
      }
      const s = endPoint(add(c.c, fromAngle(a0, c.r)), exact);
      const e = endPoint(add(c.c, fromAngle(a1, c.r)), exact);
      link(k.arc(center, s, e, construction), exact);
      return;
    }
    case 'polyline': {
      const pts = dedupe(c.points, tol * 1e-3);
      if (pts.length === 1) {
        linkPoint(pts[0] as Vec2, approx);
        return;
      }
      const closed = pts.length > 2 && dist(pts[0] as Vec2, pts[pts.length - 1] as Vec2) <= tol;
      if (closed) pts.pop();
      const segs = fitPolyline(closed ? [...pts, pts[0] as Vec2] : pts, tol);
      const ids = pts.map((p) => linkPoint(p, approx));
      const idAt = (i: number) => ids[i % ids.length] as Id;
      for (const s of segs) {
        if (s.kind === 'line') link(k.line(idAt(s.i), idAt(s.j), construction), approx);
        else {
          const center = linkPoint(s.c, approx);
          const [a, b] = s.ccw ? [idAt(s.i), idAt(s.j)] : [idAt(s.j), idAt(s.i)];
          link(k.arc(center, a, b, construction), approx);
        }
      }
      // Polyline vertices that ended up inside an arc or line are not needed.
      const used = new Set<Id>();
      for (const s of segs) {
        used.add(idAt(s.i));
        used.add(idAt(s.j));
      }
      for (const id of ids) if (!used.has(id)) k.removeEntity(id);
      return;
    }
  }
}

function dedupe(points: readonly Vec2[], eps: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (out.length && dist(out[out.length - 1] as Vec2, p) <= eps) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

type Segment =
  | { kind: 'line'; i: number; j: number }
  | { kind: 'arc'; i: number; j: number; c: Vec2; ccw: boolean };

/**
 * Greedy fit of a polyline: from each vertex, the longest run that stays within `tol` of a chord
 * (a line) or of a circle turning one way (an arc of at least three segments), whichever covers
 * more. Vertex indices refer to `pts`.
 */
export function fitPolyline(pts: readonly Vec2[], tol: number): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  const n = pts.length;
  while (i < n - 1) {
    let jl = i + 1;
    while (jl + 1 < n && fitsLine(pts, i, jl + 1, tol)) jl++;
    let arc: Segment | null = null;
    for (let j = i + 3; j < n; j++) {
      const a = fitArc(pts, i, j, tol);
      if (!a) break;
      arc = a;
    }
    if (arc && arc.j > jl) {
      out.push(arc);
      i = arc.j;
    } else {
      out.push({ kind: 'line', i, j: jl });
      i = jl;
    }
  }
  return out;
}

function fitsLine(pts: readonly Vec2[], i: number, j: number, tol: number): boolean {
  const a = pts[i] as Vec2;
  const b = pts[j] as Vec2;
  const ab = sub(b, a);
  const l = Math.hypot(ab[0], ab[1]);
  if (l === 0) return false;
  let last = 0;
  for (let m = i + 1; m < j; m++) {
    const p = sub(pts[m] as Vec2, a);
    if (Math.abs(cross(ab, p)) / l > tol) return false;
    const t = (p[0] * ab[0] + p[1] * ab[1]) / l;
    if (t < last) return false;
    last = t;
  }
  return true;
}

function fitArc(pts: readonly Vec2[], i: number, j: number, tol: number): Segment | null {
  const a = pts[i] as Vec2;
  const b = pts[j] as Vec2;
  const m = pts[Math.floor((i + j) / 2)] as Vec2;
  const circle = circumcircle(a, m, b);
  if (!circle) return null;
  let turn = 0;
  let total = 0;
  for (let q = i; q <= j; q++) {
    if (Math.abs(dist(pts[q] as Vec2, circle.c) - circle.r) > tol) return null;
    if (q + 2 <= j) {
      const t = cross(
        sub(pts[q + 1] as Vec2, pts[q] as Vec2),
        sub(pts[q + 2] as Vec2, pts[q + 1] as Vec2),
      );
      if (t === 0) return null;
      if (turn === 0) turn = Math.sign(t);
      else if (Math.sign(t) !== turn) return null;
    }
    if (q < j) {
      const u = sub(pts[q] as Vec2, circle.c);
      const v = sub(pts[q + 1] as Vec2, circle.c);
      total += Math.atan2(cross(u, v), u[0] * v[0] + u[1] * v[1]);
    }
  }
  // Chords must be short against the radius (else a line fits better), and less than a full turn.
  if (Math.abs(total) >= TAU - 1e-6) return null;
  return { kind: 'arc', i, j, c: circle.c, ccw: total > 0 };
}

// ---------------------------------------------------------------------------------------------
// Re-projection, re-pick, unlink
// ---------------------------------------------------------------------------------------------

interface Group {
  ref: EntityRef;
  approximate: boolean;
  entities: LinkedEntity[];
}

function groups(entities: readonly SketchEntity[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const e of entities) {
    if (!isLinked(e)) continue;
    const g = out.get(e.source.ref.name);
    if (g) {
      g.entities.push(e);
      g.approximate ||= e.source.approximate === true;
    } else {
      out.set(e.source.ref.name, {
        ref: e.source.ref,
        approximate: e.source.approximate === true,
        entities: [e],
      });
    }
  }
  return out;
}

/**
 * Updates linked entities in place from freshly projected curves (keyed by `ref.name`). Sources
 * missing from `fresh` are reported in `lost` and left untouched; fresh curves that no entity
 * links to are ignored (converting them is an explicit user action).
 */
export function reprojectLinked(
  sketch: SketchData,
  fresh: readonly ProjectedEdge[],
  options: ConvertOptions = {},
): ReprojectResult {
  const k = new SketchDraft(sketch, options);
  const byName = new Map(fresh.map((e) => [e.ref.name, e]));
  const lost: LostSource[] = [];
  for (const [name, g] of groups(sketch.entities)) {
    const edge = byName.get(name);
    if (!edge || invalidCurve(edge.curve)) {
      lost.push({ ref: g.ref, entities: g.entities.map((e) => e.id) });
      continue;
    }
    update(k, g, edge, options.tolerance ?? 0.01);
  }
  const n = k.changed.size;
  const result = k.finish(n === 1 ? 'Update 1 linked entity' : `Update ${n} linked entities`);
  return { ...result, lost };
}

/**
 * Re-pick: links the entities that followed `refName` to a new model edge and projects them onto
 * it (ids kept, so constraints survive).
 */
export function relinkEntities(
  sketch: SketchData,
  refName: string,
  edge: ProjectedEdge,
  options: ConvertOptions = {},
): ({ ok: true } & SketchEdit) | { ok: false; reason: string } {
  const g = groups(sketch.entities).get(refName);
  if (!g) return { ok: false, reason: `Nothing in this sketch is linked to ${refName}` };
  const bad = invalidCurve(edge.curve);
  if (bad) return { ok: false, reason: `${edge.ref.name}: ${bad}` };
  const k = new SketchDraft(sketch, options);
  const approximate = edge.curve.kind === 'polyline' || g.approximate;
  for (const e of g.entities) {
    const cur = k.get(e.id) as SketchEntity;
    cur.source = approximate ? { ref: edge.ref, approximate: true } : { ref: edge.ref };
    k.touch(e.id);
  }
  const moved = groups(k.entities).get(edge.ref.name) as Group;
  update(k, moved, edge, options.tolerance ?? 0.01);
  return k.finish(
    `Re-pick ${g.entities.length === 1 ? k.name(g.entities[0]?.id as Id) : 'linked entities'}`,
  );
}

/**
 * Removes `source` from the given entities (and from their points, unless another linked curve
 * still uses them), leaving ordinary geometry.
 */
export function unlinkEntities(
  sketch: SketchData,
  ids: readonly Id[],
  options: EditOptions = {},
): ({ ok: true } & SketchEdit) | { ok: false; reason: string } {
  const k = new SketchDraft(sketch, options);
  const targets = ids.map((id) => k.get(id)).filter((e): e is LinkedEntity => !!e && isLinked(e));
  if (targets.length === 0) return { ok: false, reason: 'Nothing selected is linked' };
  const unlink = new Set(targets.map((e) => e.id));
  const pointsOf = (e: SketchEntity): Id[] =>
    e.kind === 'line'
      ? [e.start, e.end]
      : e.kind === 'arc'
        ? [e.center, e.start, e.end]
        : e.kind === 'point'
          ? []
          : [e.center];
  for (const e of targets) for (const p of pointsOf(e)) unlink.add(p);
  // Points another still-linked curve needs stay linked.
  for (const e of k.entities) {
    if (!isLinked(e) || unlink.has(e.id) || e.kind === 'point') continue;
    for (const p of pointsOf(e)) {
      if (unlink.has(p) && !ids.includes(p)) {
        unlink.delete(p);
      }
    }
  }
  for (const id of unlink) {
    const e: SketchEntity | undefined = k.get(id);
    if (!e?.source) continue;
    delete e.source;
    k.touch(id);
  }
  const name = targets.length === 1 ? k.name(targets[0]?.id as Id) : `${targets.length} entities`;
  return k.finish(`Unlink ${name}`);
}

/** Moves a group's entities onto a fresh curve. */
function update(k: SketchDraft, g: Group, edge: ProjectedEdge, tol: number) {
  const curves = g.entities.filter((e) => e.kind !== 'point');
  const c = edge.curve;
  if (!g.approximate && curves.length <= 1 && c.kind !== 'polyline') {
    const target = curves[0];
    if (!target) {
      // A projected point (edge seen end-on, or a vertex).
      const p = g.entities.find((e) => e.kind === 'point');
      if (p) k.setPos(p.id, c.kind === 'line' ? c.a : c.c);
      return;
    }
    updateExact(k, target.id, edge, g.ref);
    return;
  }
  updateChain(k, g, edge, tol);
}

function updateExact(k: SketchDraft, id: Id, edge: ProjectedEdge, ref: EntityRef) {
  const e = k.get(id) as SketchEntity;
  const c = edge.curve;
  const src = { ref };
  k.touch(id);
  const newPoint = (p: Vec2) => {
    const pid = k.point(p, e.construction);
    (k.get(pid) as SketchEntity).source = src;
    return pid;
  };
  if (c.kind === 'line') {
    if (e.kind === 'line') {
      // Keep the orientation that moves the ends least (so angles don't flip).
      const s = k.pos(e.start);
      const t = k.pos(e.end);
      const swap = dist(s, c.b) + dist(t, c.a) < dist(s, c.a) + dist(t, c.b);
      k.setPos(e.start, swap ? c.b : c.a);
      k.setPos(e.end, swap ? c.a : c.b);
      return;
    }
    const [a, b] = reuse(k, e, newPoint, [c.a, c.b]);
    k.replace({ id, kind: 'line', construction: e.construction, source: src, start: a, end: b });
    k.notes.push(`${k.name(id)} now follows a straight edge`);
    return;
  }
  if (c.kind === 'circle' || (c.kind === 'arc' && fullTurn(c))) {
    if (e.kind === 'circle') {
      k.setPos(e.center, c.c);
      k.replace({ ...e, radius: c.r });
      return;
    }
    const center = e.kind === 'arc' ? e.center : newPoint(c.c);
    k.setPos(center, c.c);
    k.replace({
      id,
      kind: 'circle',
      construction: e.construction,
      source: src,
      center,
      radius: c.r,
    });
    k.notes.push(`${k.name(id)} now follows a full circle`);
    return;
  }
  if (c.kind === 'arc') {
    const a0 = angleOf(c.c, c.start);
    const a1 = angleOf(c.c, c.end);
    const ps = add(c.c, fromAngle(a0, c.r));
    const pe = add(c.c, fromAngle(a1, c.r));
    if (e.kind === 'arc') {
      k.setPos(e.center, c.c);
      k.setPos(e.start, ps);
      k.setPos(e.end, pe);
      return;
    }
    const center = e.kind === 'circle' ? e.center : newPoint(c.c);
    k.setPos(center, c.c);
    const [s, t] = reuse(k, e, newPoint, [ps, pe]);
    k.replace({
      id,
      kind: 'arc',
      construction: e.construction,
      source: src,
      center,
      start: s,
      end: t,
    });
    k.notes.push(`${k.name(id)} now follows an arc`);
  }
}

const fullTurn = (c: Extract<ProjectedCurve, { kind: 'arc' }>) => {
  let sweep = angleOf(c.c, c.end) - angleOf(c.c, c.start);
  while (sweep <= 0) sweep += TAU;
  return Math.abs(sweep - TAU) < 1e-12;
};

/** End points of `e` reused for a new kind (line ends ↔ arc ends), new ones created as needed. */
function reuse(k: SketchDraft, e: SketchEntity, make: (p: Vec2) => Id, at: [Vec2, Vec2]): [Id, Id] {
  const ends = e.kind === 'line' || e.kind === 'arc' ? [e.start, e.end] : [];
  const one = (i: 0 | 1): Id => {
    const id = ends[i];
    if (!id) return make(at[i]);
    k.setPos(id, at[i]);
    return id;
  };
  return [one(0), one(1)];
}

/** Samples a projected curve as a polyline. */
function samplePoints(c: ProjectedCurve): { pts: Vec2[]; closed: boolean } {
  switch (c.kind) {
    case 'line':
      return { pts: [c.a, c.b], closed: false };
    case 'polyline': {
      const closed =
        c.points.length > 2 &&
        dist(c.points[0] as Vec2, c.points[c.points.length - 1] as Vec2) < 1e-9;
      return { pts: closed ? c.points.slice(0, -1) : [...c.points], closed };
    }
    case 'circle':
    case 'arc': {
      const a0 = c.kind === 'arc' ? angleOf(c.c, c.start) : 0;
      let sweep = c.kind === 'arc' ? angleOf(c.c, c.end) - a0 : TAU;
      while (sweep <= 0) sweep += TAU;
      const closed = c.kind === 'circle' || Math.abs(sweep - TAU) < 1e-12;
      const n = 64;
      const pts: Vec2[] = [];
      for (let i = 0; i < (closed ? n : n + 1); i++)
        pts.push(add(c.c, fromAngle(a0 + (sweep * i) / n, c.r)));
      return { pts, closed };
    }
  }
}

/**
 * Approximate (or multi-entity) groups: the chain keeps its entities and their order; each
 * vertex moves to the point at the same fraction of length along the fresh polyline, and arcs are
 * re-fitted through their ends and middle.
 */
function updateChain(k: SketchDraft, g: Group, edge: ProjectedEdge, tol: number) {
  const chain = orderChain(g);
  const { pts, closed } = samplePoints(edge.curve);
  if (chain.length === 0 || pts.length < 2) {
    const p = g.entities.find((e) => e.kind === 'point');
    if (p && pts[0]) k.setPos(p.id, pts[0]);
    return;
  }
  // Fractions of length at every chain vertex, on the current geometry.
  const lengths = chain.map((c) => curveLength(k, c.id));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const fresh = closed ? [...pts, pts[0] as Vec2] : pts;
  const cum: number[] = [0];
  for (let i = 1; i < fresh.length; i++)
    cum.push((cum[i - 1] as number) + dist(fresh[i - 1] as Vec2, fresh[i] as Vec2));
  const L = cum[cum.length - 1] as number;
  const at = (f: number): Vec2 => {
    const s = Math.min(1, Math.max(0, f)) * L;
    let i = 1;
    while (i < cum.length - 1 && (cum[i] as number) < s) i++;
    const a = cum[i - 1] as number;
    const b = cum[i] as number;
    return lerp(fresh[i - 1] as Vec2, fresh[i] as Vec2, b > a ? (s - a) / (b - a) : 0);
  };
  let acc = 0;
  chain.forEach((c, i) => {
    const f0 = acc / total;
    acc += lengths[i] as number;
    const f1 = acc / total;
    const e = k.get(c.id) as SketchEntity;
    const p0 = at(f0);
    const p1 = closed && i === chain.length - 1 ? at(0) : at(f1);
    const [s, t] = c.rev ? [p1, p0] : [p0, p1];
    if (e.kind === 'line') {
      k.setPos(e.start, s);
      k.setPos(e.end, t);
    } else if (e.kind === 'arc') {
      const mid = at((f0 + f1) / 2);
      const circle = circumcircle(p0, mid, p1);
      if (!circle || circle.r > 1e6 * Math.max(dist(p0, p1), tol)) {
        k.setPos(e.start, s);
        k.setPos(e.end, t);
        k.replace({
          id: e.id,
          kind: 'line',
          construction: e.construction,
          source: e.source,
          start: e.start,
          end: e.end,
        });
        k.notes.push(`${k.name(e.id)} now follows a straight part of ${g.ref.name}`);
        return;
      }
      // Counter-clockwise from start to end.
      const ccw = cross(sub(mid, p0), sub(p1, mid)) > 0;
      const [as, ae] = ccw ? [p0, p1] : [p1, p0];
      const [is, ie] = c.rev === !ccw ? [e.start, e.end] : [e.end, e.start];
      k.setPos(e.center, circle.c);
      k.setPos(is, as);
      k.setPos(ie, ae);
      if (is !== e.start) k.replace({ ...e, start: is, end: ie });
    }
  });
}

/** Chain order of a group's curves (by shared points), with traversal direction. */
function orderChain(g: Group): { id: Id; rev: boolean }[] {
  const curves = g.entities.filter(
    (e) => e.kind === 'line' || e.kind === 'arc',
  ) as (LinkedEntity & {
    start: Id;
    end: Id;
  })[];
  if (curves.length === 0) return [];
  const users = new Map<Id, Id[]>();
  for (const c of curves) {
    for (const p of [c.start, c.end]) {
      const l = users.get(p);
      if (l) l.push(c.id);
      else users.set(p, [c.id]);
    }
  }
  // Start at an open end (a point only one curve uses) or at the first curve.
  let first = curves[0] as (typeof curves)[number];
  let startAt = first.start;
  for (const c of curves) {
    const s =
      (users.get(c.start) ?? []).length === 1
        ? c.start
        : (users.get(c.end) ?? []).length === 1
          ? c.end
          : null;
    if (s) {
      first = c;
      startAt = s;
      break;
    }
  }
  const out: { id: Id; rev: boolean }[] = [];
  const seen = new Set<Id>();
  let cur: (typeof curves)[number] | undefined = first;
  let at = startAt;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const rev = cur.start !== at;
    out.push({ id: cur.id, rev });
    at = rev ? cur.start : cur.end;
    const nextId = (users.get(at) ?? []).find((id) => !seen.has(id));
    cur = curves.find((c) => c.id === nextId);
  }
  for (const c of curves) if (!seen.has(c.id)) out.push({ id: c.id, rev: false });
  return out;
}

function curveLength(k: SketchDraft, id: Id): number {
  const c = k.curve(id);
  if (!c) return 0;
  if (c.kind === 'line') return dist(c.a, c.b);
  if (c.kind === 'arc') return c.r * c.sweep;
  return c.r * TAU;
}
