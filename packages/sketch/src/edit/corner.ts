/**
 * Sketch fillet and chamfer at a corner where two curves (lines or arcs) meet at an end point.
 *
 *  - Fillet: a tangent arc of radius r; both curves are trimmed to the tangent points; the result
 *    carries `tangent` × 2 and a driving `radius` dimension (the given expression).
 *  - Chamfer: a line cutting the corner, by two distances or (between lines) a distance and an
 *    angle, with driving dimensions.
 *
 * The old corner survives as a construction "virtual sharp" on both curves (two `pointOn`) when
 * anything refers to it, so dimensions to the corner keep their meaning (and chamfer distances are
 * measured from it). A line's `length` becomes the distance from its far end to the virtual sharp;
 * its h/v extent and `midpoint` are rewritten the same way. Constraints that can't be kept (equal
 * length) are dropped and reported.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Expr, Id, SketchConstraint, SketchEntity, Vec2 } from '@whittle/contracts';
import { add, angle0, cross, dist, dot, fromAngle, normalize, perp, scale, sub } from '../geometry';
import { type Curve, carrierIntersections, onExtent, paramOf, paramTol, turnAngle } from './curves';
import {
  coincidenceRoots,
  type EditOptions,
  formatMm,
  refuse,
  type SketchData,
  SketchDraft,
  type SketchEditResult,
} from './draft';
import { releaseOffsetTarget } from './trim';

/** A corner: its point (or one of its coincident points), or the two curves that meet there. */
export type CornerPick = Id | { a: Id; b: Id };

interface Arm {
  id: Id;
  kind: 'line' | 'arc';
  /** Which end of the entity is at the corner. */
  end: 'start' | 'end';
  pid: Id;
  /** The far end's point id. */
  far: Id;
  curve: Curve;
  /** Unit direction leaving the corner along the curve. */
  dir: Vec2;
}

interface Corner {
  arms: [Arm, Arm];
  /** Point ids at the corner (coincident class). */
  pids: Id[];
  v: Vec2;
}

type ArmEntity = Extract<SketchEntity, { kind: 'line' | 'arc' }>;

function resolveCorner(k: SketchDraft, pick: CornerPick): Corner | string {
  const root = coincidenceRoots(k.constraints);
  const curves = k.entities.filter((e): e is ArmEntity => e.kind === 'line' || e.kind === 'arc');
  let key: Id;
  if (typeof pick === 'string') {
    if (k.get(pick)?.kind !== 'point') return 'Pick the corner point where two curves meet';
    key = root(pick);
  } else {
    const a = k.get(pick.a);
    const b = k.get(pick.b);
    if (
      !a ||
      !b ||
      (a.kind !== 'line' && a.kind !== 'arc') ||
      (b.kind !== 'line' && b.kind !== 'arc')
    ) {
      return 'A corner is where two lines or arcs meet';
    }
    const shared = [a.start, a.end].find((p) => [b.start, b.end].some((q) => root(q) === root(p)));
    if (!shared) return `${k.name(a.id)} and ${k.name(b.id)} don't meet at an end`;
    key = root(shared);
  }
  const armsAt = curves.filter((e) => root(e.start) === key || root(e.end) === key);
  const pids = k.entities.filter((e) => e.kind === 'point' && root(e.id) === key).map((e) => e.id);
  const others = k.entities.filter(
    (e) =>
      (e.kind === 'circle' || e.kind === 'ellipse' || e.kind === 'arc') && pids.includes(e.center),
  );
  if (armsAt.length !== 2 || others.length > 0) {
    const n = armsAt.length + others.length;
    return `${n} curves meet at this corner; a fillet or chamfer needs exactly two`;
  }
  if (
    typeof pick !== 'string' &&
    !(armsAt.some((e) => e.id === pick.a) && armsAt.some((e) => e.id === pick.b))
  ) {
    return `${k.name(pick.a)} and ${k.name(pick.b)} don't form a corner of two curves`;
  }
  const arms = armsAt.map((e): Arm | string => {
    if (e.source) return `${k.name(e.id)} is linked to the model; unlink it first`;
    const end = root(e.start) === key ? 'start' : 'end';
    const curve = k.curve(e.id) as Curve;
    const pid = e[end];
    const far = end === 'start' ? e.end : e.start;
    let dir: Vec2;
    if (curve.kind === 'line') dir = normalize(sub(k.pos(far), k.pos(pid)));
    else {
      const arc = curve as Extract<Curve, { kind: 'arc' }>;
      const radial = normalize(sub(k.pos(pid), arc.c));
      // Leaving from the start runs counter-clockwise, from the end clockwise.
      dir = end === 'start' ? perp(radial) : scale(perp(radial), -1);
    }
    return { id: e.id, kind: e.kind, end, pid, far, curve, dir };
  });
  for (const a of arms) if (typeof a === 'string') return a;
  const [a1, a2] = arms as [Arm, Arm];
  if (a1.id === a2.id) return 'A fillet or chamfer needs two different curves';
  const turn = Math.abs(turnAngle(a1.dir, a2.dir));
  if (turn < 1e-6) return `${k.name(a1.id)} and ${k.name(a2.id)} overlap at this corner`;
  if (Math.abs(turn - Math.PI) < 1e-6)
    return `${k.name(a1.id)} and ${k.name(a2.id)} already meet smoothly`;
  return { arms: [a1, a2], pids, v: k.pos(a1.pid) };
}

/** Point on the curve's extent closest to `p` (lines: projection; arcs: radial), or null. */
function foot(k: SketchDraft, arm: Arm, p: Vec2): Vec2 | null {
  const c = arm.curve;
  let q: Vec2;
  if (c.kind === 'line') {
    const d = sub(c.b, c.a);
    q = add(c.a, scale(d, dot(sub(p, c.a), d) / dot(d, d)));
  } else if (c.kind === 'arc') {
    q = add(c.c, scale(normalize(sub(p, c.c)), c.r));
  } else return null;
  if (!onExtent(c, q, 1e-9 * k.scale)) return null;
  return q;
}

/** Whether `q` lies on the arm strictly away from the corner (not at the corner nor past the end). */
function inArm(k: SketchDraft, arm: Arm, q: Vec2): boolean {
  const tol = 1e-7 * k.scale;
  if (dist(q, k.pos(arm.pid)) <= tol || dist(q, k.pos(arm.far)) <= tol) return false;
  const t = paramOf(arm.curve, q);
  const e = paramTol(arm.curve, tol);
  if (arm.curve.kind === 'line') return t > e && t < 1 - e;
  if (arm.curve.kind === 'arc') return t > e && t < arm.curve.sweep - e;
  return false;
}

function offsetCarrier(arm: Arm, s: number): Curve | null {
  const c = arm.curve;
  if (c.kind === 'line') {
    const n = scale(perp(normalize(sub(c.b, c.a))), s);
    return { kind: 'line', a: add(c.a, n), b: add(c.b, n) };
  }
  if (c.kind === 'arc') return c.r + s > 0 ? { kind: 'circle', c: c.c, r: c.r + s } : null;
  return null;
}

/** Moves an arm's corner end to a new point and returns its id. */
function trimArm(k: SketchDraft, arm: Arm, p: Vec2): Id {
  const e = k.get(arm.id) as ArmEntity;
  const pid = k.point(p, e.construction);
  k.replace({ ...e, [arm.end]: pid });
  return pid;
}

/**
 * Keeps the old corner as a construction "virtual sharp" when something refers to it (or `force`),
 * else removes it. Returns its id (or null), after the arms were trimmed.
 */
function virtualSharp(k: SketchDraft, corner: Corner, force: boolean): Id | null {
  const [keep, ...rest] = corner.pids as [Id, ...Id[]];
  const inClass = new Set(corner.pids);
  // Coincidences inside the corner are meaningless now; the rest refer to `keep`.
  for (const c of [...k.constraints]) {
    if (c.kind === 'coincident' && inClass.has(c.a) && inClass.has(c.b)) k.dropConstraint(c.id);
  }
  for (const pid of rest) {
    for (const c of k.constraintsOn(pid)) k.updateConstraint(renamed(c, pid, keep));
    if (k.pointUsers(pid).length === 0) k.removeEntity(pid);
  }
  const [a1, a2] = corner.arms;
  const lengthy = (c: SketchConstraint) =>
    c.kind === 'length' ||
    (c.kind === 'midpoint' && (c.line === a1.id || c.line === a2.id)) ||
    ((c.kind === 'hDistance' || c.kind === 'vDistance') &&
      c.a === c.b &&
      (c.a === a1.id || c.a === a2.id));
  const needed =
    force ||
    k.constraintsOn(keep).length > 0 ||
    [a1, a2].some((a) => a.kind === 'line' && k.constraintsOn(a.id).some(lengthy));
  if (!needed) {
    if (k.pointUsers(keep).length === 0) k.removeEntity(keep);
    return null;
  }
  const p = k.get(keep) as SketchEntity;
  if (!p.construction) k.replace({ ...p, construction: true });
  k.constrain({ kind: 'pointOn', point: keep, on: a1.id });
  k.constrain({ kind: 'pointOn', point: keep, on: a2.id });
  return keep;
}

function renamed(c: SketchConstraint, from: Id, to: Id): SketchConstraint {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(c)) {
    if (key === 'id' || key === 'kind') out[key] = v;
    else if (v === from) out[key] = to;
    else if (Array.isArray(v)) out[key] = v.map((x) => (x === from ? to : x));
    else out[key] = v;
  }
  return out as unknown as SketchConstraint;
}

/** Rewrites the line arms' length-like constraints onto the virtual sharp (or drops them). */
function rewireArms(k: SketchDraft, corner: Corner, sharp: Id | null, verb: string) {
  for (const arm of corner.arms) {
    const name = k.name(arm.id);
    releaseOffsetTarget(k, arm.id, `${name} was ${verb}`);
    if (arm.kind !== 'line') continue;
    for (const c of k.constraintsOn(arm.id)) {
      if (k.addedConstraints.includes(c.id)) continue;
      if (c.kind === 'length') {
        if (sharp) {
          k.updateConstraint({
            id: c.id,
            kind: 'distance',
            a: arm.far,
            b: sharp,
            value: c.value,
            driving: c.driving,
            ...(c.label ? { label: c.label } : {}),
          });
        } else k.dropConstraint(c.id, `${name} was ${verb}`);
      } else if (
        (c.kind === 'hDistance' || c.kind === 'vDistance') &&
        c.a === arm.id &&
        c.b === arm.id
      ) {
        // Was end − start of the line; keep the sign with the corner in place of its end.
        const [a, b] = arm.end === 'end' ? [arm.far, sharp] : [sharp, arm.far];
        if (a && b) k.updateConstraint({ ...c, a, b });
        else k.dropConstraint(c.id, `${name} was ${verb}`);
      } else if (c.kind === 'midpoint' && c.line === arm.id) {
        if (sharp) {
          k.updateConstraint({ id: c.id, kind: 'symmetric', a: arm.far, b: sharp, about: c.point });
        } else k.dropConstraint(c.id, `${name} was ${verb}`);
      } else if (c.kind === 'equal' && k.get(c.a)?.kind === 'line' && k.get(c.b)?.kind === 'line') {
        k.dropConstraint(c.id, `${name} is shorter now`);
      }
    }
  }
}

export interface FilletOptions extends EditOptions {
  /** Fillet radius, mm (> 0): the evaluated value of `expr`. */
  radius: number;
  /** Expression for the driving radius dimension (default "<radius> mm"). */
  expr?: Expr;
}

export function filletCorner(
  sketch: SketchData,
  pick: CornerPick,
  options: FilletOptions,
): SketchEditResult {
  const r = options.radius;
  if (!(r > 0) || !Number.isFinite(r)) return refuse('The fillet radius must be greater than zero');
  const k = new SketchDraft(sketch, options);
  const corner = resolveCorner(k, pick);
  if (typeof corner === 'string') return refuse(corner);
  const [a1, a2] = corner.arms;

  // Centres: intersections of the arms' offsets by ±r; keep the one nearest the corner whose
  // tangent points lie on both arms.
  let best: { c: Vec2; t1: Vec2; t2: Vec2; score: number } | null = null;
  for (const s1 of [r, -r]) {
    for (const s2 of [r, -r]) {
      const o1 = offsetCarrier(a1, s1);
      const o2 = offsetCarrier(a2, s2);
      if (!o1 || !o2) continue;
      for (const c of carrierIntersections(o1, o2)) {
        const t1 = foot(k, a1, c);
        const t2 = foot(k, a2, c);
        if (!t1 || !t2 || !inArm(k, a1, t1) || !inArm(k, a2, t2)) continue;
        if (
          Math.abs(dist(c, t1) - r) > 1e-7 * k.scale ||
          Math.abs(dist(c, t2) - r) > 1e-7 * k.scale
        )
          continue;
        const score = dist(t1, corner.v) + dist(t2, corner.v);
        if (!best || score < best.score) best = { c, t1, t2, score };
      }
    }
  }
  if (!best) return refuse(`A ${formatMm(r)} fillet doesn't fit at this corner`);

  const n1 = k.name(a1.id);
  const n2 = k.name(a2.id);
  const p1 = trimArm(k, a1, best.t1);
  const p2 = trimArm(k, a2, best.t2);
  const sharp = virtualSharp(k, corner, false);
  rewireArms(k, corner, sharp, 'filleted');
  const con =
    (k.get(a1.id) as SketchEntity).construction && (k.get(a2.id) as SketchEntity).construction;
  const center = k.point(best.c, con);
  // The arc that bulges towards the old corner.
  const toV = angle0(Math.atan2(corner.v[1] - best.c[1], corner.v[0] - best.c[0]));
  const ang = (p: Vec2) => angle0(Math.atan2(p[1] - best.c[1], p[0] - best.c[0]));
  const contains = (from: Vec2, to: Vec2) => angle0(toV - ang(from)) <= angle0(ang(to) - ang(from));
  const [s, e] = contains(best.t1, best.t2) ? [p1, p2] : [p2, p1];
  const arc = k.arc(center, s, e, con);
  k.constrain({ kind: 'tangent', a: a1.id, b: arc });
  k.constrain({ kind: 'tangent', a: a2.id, b: arc });
  k.addConstraint({ kind: 'radius', curve: arc, value: options.expr ?? `${r} mm`, driving: true });
  return k.finish(`Fillet ${n1} and ${n2} (R${formatMm(r)})`);
}

export type ChamferOptions = EditOptions &
  (
    | {
        /** Distance along the first curve (the one listed first, or the lower id order), mm. */
        distance: number;
        /** Distance along the second curve (default: equal). */
        distance2?: number;
        expr?: Expr;
        expr2?: Expr;
        angle?: undefined;
      }
    | {
        distance: number;
        /** Angle between the first curve (a line) and the chamfer, rad. */
        angle: number;
        expr?: Expr;
        angleExpr?: Expr;
      }
  );

/** Point on an arm at (chord) distance `d` from the corner, or null when the arm is too short. */
function along(k: SketchDraft, arm: Arm, v: Vec2, d: number): Vec2 | null {
  const c = arm.curve;
  let p: Vec2;
  if (c.kind === 'line') p = add(v, scale(arm.dir, d));
  else if (c.kind === 'arc') {
    if (d >= 2 * c.r) return null;
    const step = 2 * Math.asin(d / (2 * c.r));
    const a = Math.atan2(v[1] - c.c[1], v[0] - c.c[0]) + (arm.end === 'start' ? step : -step);
    p = add(c.c, fromAngle(a, c.r));
  } else return null;
  return inArm(k, arm, p) ? p : null;
}

export function chamferCorner(
  sketch: SketchData,
  pick: CornerPick,
  options: ChamferOptions,
): SketchEditResult {
  const d1 = options.distance;
  if (!(d1 > 0) || !Number.isFinite(d1))
    return refuse('The chamfer distance must be greater than zero');
  const k = new SketchDraft(sketch, options);
  const corner = resolveCorner(k, pick);
  if (typeof corner === 'string') return refuse(corner);
  let [a1, a2] = corner.arms;
  if (typeof pick !== 'string' && a1.id !== pick.a) [a1, a2] = [a2, a1];
  const n1 = k.name(a1.id);
  const n2 = k.name(a2.id);
  const p1 = along(k, a1, corner.v, d1);
  if (!p1) return refuse(`${n1} is too short for a ${formatMm(d1)} chamfer`);

  let p2: Vec2 | null;
  let d2 = 0;
  const angleMode = options.angle !== undefined;
  if (options.angle !== undefined) {
    const alpha = options.angle;
    if (a1.kind !== 'line' || a2.kind !== 'line')
      return refuse('A distance–angle chamfer needs two lines');
    if (!(alpha > 0 && alpha < Math.PI))
      return refuse('The chamfer angle must be between 0° and 180°');
    // Triangle corner–P1–P2: angle α at P1, the corner angle φ at the corner.
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(a1.dir, a2.dir))));
    const gamma = Math.PI - alpha - phi;
    if (!(gamma > 1e-9))
      return refuse('That chamfer angle never meets the other side of the corner');
    d2 = (d1 * Math.sin(alpha)) / Math.sin(gamma);
    p2 = along(k, a2, corner.v, d2);
  } else {
    d2 = options.distance2 ?? d1;
    if (!(d2 > 0)) return refuse('The chamfer distance must be greater than zero');
    p2 = along(k, a2, corner.v, d2);
  }
  if (!p2) return refuse(`${n2} is too short for a ${formatMm(d2)} chamfer`);

  const q1 = trimArm(k, a1, p1);
  const q2 = trimArm(k, a2, p2);
  const sharp = virtualSharp(k, { ...corner, arms: [a1, a2] }, true) as Id;
  rewireArms(k, { ...corner, arms: [a1, a2] }, sharp, 'chamfered');
  const con =
    (k.get(a1.id) as SketchEntity).construction && (k.get(a2.id) as SketchEntity).construction;
  const line = k.line(q1, q2, con);
  k.addConstraint({
    kind: 'distance',
    a: sharp,
    b: q1,
    value: options.expr ?? `${d1} mm`,
    driving: true,
  });
  if (options.angle !== undefined) {
    const alpha = options.angle;
    // Pick the line order / direction whose CCW angle reads α (contracts: CCW from a to b).
    const l1 = k.curve(a1.id) as Extract<Curve, { kind: 'line' }>;
    const dirA = sub(l1.b, l1.a);
    const dirC = sub(p2, p1);
    const ccw = (u: Vec2, w: Vec2) => angle0(Math.atan2(cross(u, w), dot(u, w)));
    const near = (x: number) => Math.min(angle0(x - alpha), angle0(alpha - x)) < 1e-6;
    const back = scale(dirC, -1);
    const flip = () => k.replace({ ...(k.get(line) as ArmEntity), start: q2, end: q1 });
    let a = a1.id;
    let b = line;
    if (near(ccw(dirA, dirC))) {
      // As drawn.
    } else if (near(ccw(dirC, dirA))) [a, b] = [line, a1.id];
    else if (near(ccw(dirA, back))) flip();
    else {
      flip();
      [a, b] = [line, a1.id];
    }
    const deg = Math.round(((alpha * 180) / Math.PI) * 1e6) / 1e6;
    k.addConstraint({
      kind: 'angle',
      a,
      b,
      value: options.angleExpr ?? `${deg} deg`,
      driving: true,
    });
  } else {
    const expr2 =
      options.distance2 === undefined
        ? (options.expr ?? `${d1} mm`)
        : (options.expr2 ?? `${d2} mm`);
    k.addConstraint({ kind: 'distance', a: sharp, b: q2, value: expr2, driving: true });
  }
  const deg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1000) / 1000;
  const what = angleMode
    ? `${formatMm(d1)} at ${deg(options.angle as number)}°`
    : d2 === d1
      ? formatMm(d1)
      : `${formatMm(d1)} × ${formatMm(d2)}`;
  return k.finish(`Chamfer ${n1} and ${n2} (${what})`);
}
