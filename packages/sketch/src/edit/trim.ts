/**
 * Trim and extend (PLAN §2.1, M3).
 *
 *  - `trimEntity` removes the picked piece of a line, arc or circle between its nearest
 *    intersections with other sketch geometry (construction and linked geometry included). With
 *    no intersection the entity is deleted; a circle needs two and becomes an arc (same id).
 *    Trimming the middle splits the entity: the original keeps the first piece, a new entity the
 *    other, tied to the original (collinear, or same centre and radius).
 *  - `extendEntity` moves the free end of a line or arc nearest the pick to the next intersection.
 *
 * Rewiring: every new end is attached where it was cut, with `coincident` when it lands on another
 * entity's end point and `pointOn` otherwise. Constraints that no longer apply are dropped and
 * reported in `notes`: those on end points that were trimmed away or moved, length-like ones on a
 * shortened line (`length`, `equal` length, `midpoint`, its own h/v extent), and an offset pair
 * whose target was trimmed (it would pull the end back).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchEntity, Vec2 } from '@whittle/contracts';
import { dist, TAU } from '../geometry';
import { coincidenceRoots } from './draft';
import {
  type Curve,
  arcEnd,
  arcStart,
  carrierIntersections,
  onExtent,
  paramOf,
  paramRange,
  paramTol,
} from './curves';
import { type EditOptions, refuse, type SketchData, SketchDraft, type SketchEditResult } from './draft';

interface Hit {
  t: number;
  p: Vec2;
  other: Id;
  /** An end point of `other` (or a sketch point) at the hit, for a coincident attachment. */
  point?: Id;
}

type Curved = Extract<SketchEntity, { kind: 'line' | 'arc' | 'circle' }>;

function editable(k: SketchDraft, id: Id, verb: string): Curved | string {
  const e = k.get(id);
  if (!e) return `Unknown entity ${id}`;
  if (e.kind !== 'line' && e.kind !== 'arc' && e.kind !== 'circle') {
    return `Only lines, arcs and circles can be ${verb}`;
  }
  if (e.source) return `${k.name(id)} is linked to the model; unlink it to ${verb.replace(/ed$/, '')} it`;
  return e;
}

/** Points where other curves cross `id`'s carrier, on their own extents (sorted by parameter). */
function crossings(k: SketchDraft, id: Id, carrier: Curve, own: Curve): Hit[] {
  const tol = 1e-9 * k.scale;
  const ptol = 1e-7 * k.scale;
  const hits: Hit[] = [];
  const self = k.get(id) as Curved;
  const ownPoints = new Set<Id>(
    self.kind === 'circle' ? [self.center] : self.kind === 'arc' ? [self.start, self.end, self.center] : [self.start, self.end],
  );
  for (const o of k.entities) {
    if (o.id === id || (o.kind !== 'line' && o.kind !== 'arc' && o.kind !== 'circle')) continue;
    const oc = k.curve(o.id) as Curve;
    for (const p of carrierIntersections(carrier, oc)) {
      if (!onExtent(oc, p, tol)) continue;
      const ends = o.kind === 'line' ? [o.start, o.end] : o.kind === 'arc' ? [o.start, o.end] : [];
      const point = ends.find((pid) => dist(k.pos(pid), p) <= ptol);
      // The other curve ends on one of our own points: a connection, not a cut.
      if (point && ownPoints.has(point)) continue;
      hits.push({ t: paramOf(own, p), p, other: o.id, ...(point ? { point } : {}) });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  return hits;
}

function attach(k: SketchDraft, pid: Id, hit: Hit) {
  if (hit.point) k.constrain({ kind: 'coincident', a: pid, b: hit.point });
  else k.constrain({ kind: 'pointOn', point: pid, on: hit.other });
}

/** Drops constraints that measure a line's length (it changed). */
function dropLengthConstraints(k: SketchDraft, lineId: Id, why: string) {
  for (const c of k.constraintsOn(lineId)) {
    if (k.addedConstraints.includes(c.id)) continue;
    const lengthy =
      c.kind === 'length' ||
      (c.kind === 'midpoint' && c.line === lineId) ||
      ((c.kind === 'hDistance' || c.kind === 'vDistance') && c.a === lineId && c.b === lineId) ||
      (c.kind === 'equal' && k.get(c.a)?.kind === 'line' && k.get(c.b)?.kind === 'line');
    if (lengthy) k.dropConstraint(c.id, why);
  }
}

/** Removes `id` from offsets that keep it as a target (its end no longer follows the source). */
export function releaseOffsetTarget(k: SketchDraft, id: Id, why: string) {
  for (const c of k.constraintsOn(id)) {
    if (c.kind !== 'offset' || !c.targets.includes(id)) continue;
    const keep = c.targets.map((t, i) => [c.sources[i] as Id, t] as const).filter(([, t]) => t !== id);
    if (keep.length === 0) {
      k.dropConstraint(c.id, why);
      continue;
    }
    k.updateConstraint({ ...c, sources: keep.map(([s]) => s), targets: keep.map(([, t]) => t) });
    k.notes.push(`${k.name(id)} no longer follows ‘${k.label(c)}’: ${why}`);
  }
}

/** Removes an entity, its constraints and its now-unused points. */
function deleteCurve(k: SketchDraft, e: Curved) {
  const points = e.kind === 'circle' ? [e.center] : e.kind === 'arc' ? [e.center, e.start, e.end] : [e.start, e.end];
  for (const c of k.constraintsOn(e.id)) {
    if (c.kind === 'offset') continue;
    k.dropConstraint(c.id, `${k.name(e.id)} was deleted`);
  }
  k.removeEntity(e.id);
  for (const p of points) k.dropIfOrphan(p, `${k.name(e.id)} was deleted`);
}

/** Moves one end of a line or arc to a cut point (a new point; the old one goes if unused). */
function moveEnd(k: SketchDraft, id: Id, which: 'start' | 'end', hit: Hit): Id {
  const e = k.get(id) as Extract<SketchEntity, { kind: 'line' | 'arc' }>;
  const old = e[which];
  const p = k.point(hit.p, e.construction);
  k.replace({ ...e, [which]: p });
  attach(k, p, hit);
  k.dropIfOrphan(old, 'its end was trimmed away');
  return p;
}

/** Moves tangency to `piece` where the tangent curve meets the piece rather than the original. */
function retargetTangents(k: SketchDraft, original: Id, piece: Id, movedEnd: Id) {
  const root = coincidenceRoots(k.constraints);
  for (const c of k.constraintsOn(original)) {
    if (c.kind !== 'tangent') continue;
    const other = c.a === original ? c.b : c.a;
    const o = k.get(other);
    if (!o || (o.kind !== 'line' && o.kind !== 'arc')) continue;
    if ([o.start, o.end].some((p) => root(p) === root(movedEnd))) {
      k.updateConstraint({ ...c, a: c.a === original ? piece : c.a, b: c.b === original ? piece : c.b });
    }
  }
}

/** Nearest cut parameters below and above `tp` among `ts` (strictly inside the extent). */
function bracket(hits: Hit[], tp: number, lo: number, hi: number, eps: number) {
  const inner = hits.filter((h) => h.t > lo + eps && h.t < hi - eps);
  let below: Hit | null = null;
  let above: Hit | null = null;
  for (const h of inner) {
    if (h.t < tp && (!below || h.t > below.t)) below = h;
    if (h.t > tp && (!above || h.t < above.t)) above = h;
  }
  return { below, above, inner };
}

export function trimEntity(
  sketch: SketchData,
  id: Id,
  pick: Vec2,
  options: EditOptions = {},
): SketchEditResult {
  const k = new SketchDraft(sketch, options);
  const e = editable(k, id, 'trimmed');
  if (typeof e === 'string') return refuse(e);
  const name = k.name(id);
  const own = k.curve(id) as Curve;
  const carrier: Curve = own.kind === 'arc' ? { kind: 'circle', c: own.c, r: own.r } : own;
  const hits = crossings(k, id, carrier, own);
  const eps = paramTol(own, 1e-7 * k.scale);

  if (e.kind === 'circle' && own.kind === 'circle') {
    const angles: Hit[] = [];
    for (const h of hits) if (!angles.some((a) => Math.abs(a.t - h.t) < eps || Math.abs(a.t - h.t) > TAU - eps)) angles.push(h);
    if (angles.length === 0) {
      deleteCurve(k, e);
      return k.finish(`Delete ${name}`);
    }
    if (angles.length === 1) return refuse(`${name} crosses only one curve; trimming a circle needs two`);
    const tp = paramOf(own, pick);
    // The cut just before the pick (going counter-clockwise) and just after it.
    let before = angles[angles.length - 1] as Hit;
    let after = angles[0] as Hit;
    for (const h of angles) {
      if (h.t < tp) before = h;
    }
    for (const h of [...angles].reverse()) {
      if (h.t > tp) after = h;
    }
    const s = k.point(after.p, e.construction);
    const t = k.point(before.p, e.construction);
    k.replace({ id, kind: 'arc', construction: e.construction, center: e.center, start: s, end: t });
    attach(k, s, after);
    attach(k, t, before);
    releaseOffsetTarget(k, id, `${name} is now an arc`);
    dropOffsetSource(k, id, `${name} is now an arc`);
    return k.finish(`Trim ${name}`);
  }

  if (e.kind === 'circle' || own.kind === 'circle') return refuse(`${name} can't be trimmed`);
  const range = paramRange(own);
  let tp = paramOf(own, pick);
  if (own.kind === 'arc' && tp > range) tp = dist(pick, arcStart(own)) < dist(pick, arcEnd(own)) ? 0 : range;
  tp = Math.min(range, Math.max(0, tp));
  const { below, above, inner } = bracket(hits, tp, 0, range, eps);
  if (inner.length === 0) {
    deleteCurve(k, e);
    return k.finish(`Delete ${name}`);
  }
  if (!below && above) {
    moveEnd(k, id, 'start', above);
  } else if (below && !above) {
    moveEnd(k, id, 'end', below);
  } else if (below && above) {
    // Split: the original keeps [start, below], a new entity takes [above, end].
    const farEnd = e.end;
    const a = k.point(below.p, e.construction);
    const b = k.point(above.p, e.construction);
    k.replace({ ...e, end: a });
    const piece = e.kind === 'line' ? k.line(b, farEnd, e.construction) : k.arc(e.center, b, farEnd, e.construction);
    attach(k, a, below);
    attach(k, b, above);
    if (e.kind === 'line') {
      k.constrain({ kind: 'pointOn', point: b, on: id });
      k.constrain({ kind: 'pointOn', point: farEnd, on: id });
    } else {
      k.constrain({ kind: 'equal', a: id, b: piece });
    }
    retargetTangents(k, id, piece, farEnd);
  }
  if (e.kind === 'line') dropLengthConstraints(k, id, `${name} was trimmed`);
  releaseOffsetTarget(k, id, `${name} was trimmed`);
  return k.finish(`Trim ${name}`);
}

/** Offsets whose pair (circle → circle) no longer matches after a circle became an arc. */
function dropOffsetSource(k: SketchDraft, id: Id, why: string) {
  for (const c of k.constraintsOn(id)) {
    if (c.kind !== 'offset') continue;
    const keep = c.targets
      .map((t, i) => [c.sources[i] as Id, t] as const)
      .filter(([s]) => s !== id);
    if (keep.length === c.targets.length) continue;
    if (keep.length === 0) k.dropConstraint(c.id, why);
    else {
      k.updateConstraint({ ...c, sources: keep.map(([s]) => s), targets: keep.map(([, t]) => t) });
      k.notes.push(`‘${k.label(c)}’ no longer offsets ${k.name(id)}: ${why}`);
    }
  }
}

export function extendEntity(
  sketch: SketchData,
  id: Id,
  pick: Vec2,
  options: EditOptions = {},
): SketchEditResult {
  const k = new SketchDraft(sketch, options);
  const e = editable(k, id, 'extended');
  if (typeof e === 'string') return refuse(e);
  if (e.kind === 'circle') return refuse('A circle has no ends to extend');
  const name = k.name(id);
  const own = k.curve(id) as Exclude<Curve, { kind: 'circle' }>;
  const startPos = own.kind === 'line' ? own.a : arcStart(own);
  const endPos = own.kind === 'line' ? own.b : arcEnd(own);
  const which: 'start' | 'end' = dist(pick, startPos) <= dist(pick, endPos) ? 'start' : 'end';
  const pid = e[which];
  const others = k.pointUsers(pid, id);
  if (others.length > 0) {
    return refuse(`That end of ${name} is connected to ${k.name(others[0]?.id as Id)}; extend a free end`);
  }
  const carrier: Curve = own.kind === 'arc' ? { kind: 'circle', c: own.c, r: own.r } : own;
  const hits = crossings(k, id, carrier, own);
  const eps = paramTol(own, 1e-7 * k.scale);
  let best: Hit | null = null;
  for (const h of hits) {
    if (own.kind === 'line') {
      if (which === 'end' && h.t > 1 + eps && (!best || h.t < best.t)) best = h;
      if (which === 'start' && h.t < -eps && (!best || h.t > best.t)) best = h;
    } else {
      // Arc parameters: (sweep, 2π) lies beyond both ends; the end grows CCW, the start CW.
      if (!(h.t > own.sweep + eps && h.t < TAU - eps)) continue;
      if (which === 'end' && (!best || h.t < best.t)) best = h;
      if (which === 'start' && (!best || h.t > best.t)) best = h;
    }
  }
  if (!best) return refuse(`Nothing to extend ${name} to`);
  for (const c of k.constraintsOn(pid)) k.dropConstraint(c.id, `the end of ${name} moved`);
  k.setPos(pid, best.p);
  attach(k, pid, best);
  if (e.kind === 'line') dropLengthConstraints(k, id, `${name} was extended`);
  releaseOffsetTarget(k, id, `${name} was extended`);
  return k.finish(`Extend ${name}`);
}
