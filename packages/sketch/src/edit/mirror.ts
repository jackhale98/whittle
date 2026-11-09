/**
 * Sketch mirror (PLAN §2.1): copies selected entities about a line or an axis (`@x`, `@y` or a
 * sketch line, usually construction).
 *
 * Kept originals: every copied point is tied to its original by `symmetric(original, copy,
 * about)`, so editing the source moves the copy; circles, ellipses and elliptic arcs also get
 * `equal` (symmetry only ties their centres; an ellipse's rotation is not tied: no constraint
 * holds an axis direction, so the notes say so). Splines copy their poles (same order, knots and
 * weights), so symmetric poles tie the whole curve. Points that lie on the mirror line are
 * shared, not copied, so copies connect.
 *
 * Deleted originals ("mirror move"): the originals go, and constraints among them move to the
 * copies (reflection-invariant kinds as they are; an angle reads the other way, so its lines swap;
 * a horizontal/vertical distance swaps its ends across a perpendicular axis). Those that can't be
 * carried over are dropped and reported.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { add, dot, normalize, scale, sub } from '../geometry';
import { entityPoints } from '../model';
import {
  constraintRefs,
  isSketchReference,
  referenceName,
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
} from '../references';
import {
  type EditOptions,
  refuse,
  type SketchData,
  SketchDraft,
  type SketchEditResult,
} from './draft';

export interface MirrorOptions extends EditOptions {
  /** Keep the originals (default true) or remove them, carrying their constraints over. */
  keepOriginals?: boolean;
}

export function mirrorEntities(
  sketch: SketchData,
  ids: readonly Id[],
  axis: Id,
  options: MirrorOptions = {},
): SketchEditResult {
  const keep = options.keepOriginals ?? true;
  const k = new SketchDraft(sketch, options);
  let a: Vec2;
  let u: Vec2;
  if (axis === SKETCH_X_AXIS || axis === SKETCH_Y_AXIS) {
    a = [0, 0];
    u = axis === SKETCH_X_AXIS ? [1, 0] : [0, 1];
  } else {
    const l = k.get(axis);
    if (l?.kind !== 'line') return refuse('Mirror about a line or an axis');
    a = k.pos(l.start);
    u = normalize(sub(k.pos(l.end), a));
    if (u[0] === 0 && u[1] === 0) return refuse(`${k.name(axis)} has no length`);
  }
  const axisName = isSketchReference(axis) ? referenceName(axis) : k.name(axis);
  const axisAngle = Math.atan2(u[1], u[0]);
  /** A major-axis direction reflected about the mirror line. */
  const reflectRotation = (r: number) => 2 * axisAngle - r;
  const reflect = (p: Vec2): Vec2 => {
    const d = sub(p, a);
    const along = scale(u, dot(d, u));
    return add(a, sub(scale(along, 2), d));
  };
  const onAxis = (p: Vec2) => {
    const d = sub(p, a);
    return Math.abs(d[0] * u[1] - d[1] * u[0]) <= 1e-9 * k.scale;
  };

  const selected: SketchEntity[] = [];
  for (const id of new Set(ids)) {
    if (id === axis) continue;
    const e = k.get(id);
    if (!e) return refuse(`Unknown entity ${id}`);
    selected.push(e);
  }
  if (selected.length === 0) return refuse('Pick the entities to mirror');

  // Points to copy (shared ones once), in selection order.
  const pointMap = new Map<Id, Id>();
  const mapPoint = (pid: Id): Id => {
    const done = pointMap.get(pid);
    if (done) return done;
    const p = k.get(pid) as SketchEntity;
    const pos = k.pos(pid);
    let copy = pid;
    if (!onAxis(pos)) {
      copy = k.point(reflect(pos), p.construction);
      if (keep) k.constrain({ kind: 'symmetric', a: pid, b: copy, about: axis });
    }
    pointMap.set(pid, copy);
    return copy;
  };
  const entityMap = new Map<Id, Id>();
  for (const e of selected) {
    switch (e.kind) {
      case 'point':
        entityMap.set(e.id, mapPoint(e.id));
        break;
      case 'line':
        entityMap.set(e.id, k.line(mapPoint(e.start), mapPoint(e.end), e.construction));
        break;
      case 'arc': {
        // A reflection reverses the turning sense: the copy runs from the image of the end.
        const c = mapPoint(e.center);
        entityMap.set(e.id, k.arc(c, mapPoint(e.end), mapPoint(e.start), e.construction));
        break;
      }
      case 'circle': {
        const copy = k.circle(mapPoint(e.center), e.radius, e.construction);
        if (keep) k.constrain({ kind: 'equal', a: e.id, b: copy });
        entityMap.set(e.id, copy);
        break;
      }
      case 'ellipse': {
        const copy = k.addEntity({
          ...e,
          id: k.newId(),
          center: mapPoint(e.center),
          rotation: reflectRotation(e.rotation),
        });
        if (keep) {
          k.constrain({ kind: 'equal', a: e.id, b: copy });
          k.notes.push(`The mirrored copy of ${k.name(e.id)} keeps its size, but not its rotation`);
        }
        entityMap.set(e.id, copy);
        break;
      }
      case 'ellipticArc': {
        // Reflection reverses the turning sense: the copy runs from the image of the end.
        const copy = k.addEntity({
          ...e,
          id: k.newId(),
          center: mapPoint(e.center),
          start: mapPoint(e.end),
          end: mapPoint(e.start),
          rotation: reflectRotation(e.rotation),
        });
        if (keep) k.constrain({ kind: 'equal', a: e.id, b: copy });
        entityMap.set(e.id, copy);
        break;
      }
      case 'bspline': {
        const copy = k.addEntity({
          ...structuredClone(e),
          id: k.newId(),
          poles: e.poles.map(mapPoint),
        });
        entityMap.set(e.id, copy);
        break;
      }
    }
  }
  for (const [from, to] of pointMap) entityMap.set(from, to);
  const what =
    selected.length === 1 ? k.name(selected[0]?.id as Id) : `${selected.length} entities`;
  if (keep) return k.finish(`Mirror ${what} about ${axisName}`);

  // Mirror move: carry constraints over to the copies, then remove the originals.
  const horizontalAxis = Math.abs(u[1]) < 1e-12;
  const verticalAxis = Math.abs(u[0]) < 1e-12;
  // Reference geometry the reflection maps onto itself.
  const invariantRef = (id: Id) =>
    id === axis ||
    (id === SKETCH_ORIGIN && onAxis([0, 0])) ||
    (id === SKETCH_X_AXIS && verticalAxis) ||
    (id === SKETCH_Y_AXIS && horizontalAxis);
  const lineEnds = (id: Id): [Id, Id] | null => {
    const e = k.get(id);
    return e?.kind === 'line' ? [e.start, e.end] : null;
  };
  for (const c of [...k.constraints]) {
    if (k.addedConstraints.includes(c.id)) continue;
    const refs = constraintRefs(c);
    if (!refs.some((id) => entityMap.has(id))) continue;
    const mapped = refs.every((id) => entityMap.has(id) || invariantRef(id));
    const moved = carried(c, entityMap, horizontalAxis, verticalAxis, lineEnds);
    if (!mapped || moved === null) {
      k.dropConstraint(c.id, `it doesn't carry over to the mirrored copy`);
      continue;
    }
    k.updateConstraint(moved);
  }
  const originals = new Set<Id>();
  for (const e of selected) {
    originals.add(e.id);
    for (const p of entityPoints(e)) originals.add(p);
  }
  for (const id of originals)
    if (entityMap.get(id) !== id && k.get(id)?.kind !== 'point') k.removeEntity(id);
  for (const id of originals) {
    if (entityMap.get(id) === id || k.get(id)?.kind !== 'point') continue;
    if (k.pointUsers(id).length === 0) {
      for (const c of k.constraintsOn(id))
        k.dropConstraint(c.id, `it doesn't carry over to the mirrored copy`);
      k.removeEntity(id);
    }
  }
  return k.finish(`Mirror ${what} about ${axisName} (originals removed)`);
}

/** A constraint moved onto the mirrored copies, or null when reflection doesn't preserve it. */
function carried(
  c: SketchConstraint,
  map: ReadonlyMap<Id, Id>,
  horizontalAxis: boolean,
  verticalAxis: boolean,
  lineEnds: (id: Id) => [Id, Id] | null,
): SketchConstraint | null {
  const m = (id: Id) => map.get(id) ?? id;
  const remap = (): SketchConstraint => {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(c)) {
      if (key === 'id' || key === 'kind' || key === 'value' || key === 'driving' || key === 'label')
        out[key] = v;
      else if (typeof v === 'string') out[key] = m(v);
      else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === 'string' ? m(x) : x));
      else out[key] = v;
    }
    return out as unknown as SketchConstraint;
  };
  switch (c.kind) {
    case 'fix':
      return null;
    case 'horizontal':
    case 'vertical':
    case 'horizontalPoints':
    case 'verticalPoints':
      return horizontalAxis || verticalAxis ? remap() : null;
    case 'angle':
      // CCW from a to b reads clockwise after a reflection: CCW from b' to a' keeps the value.
      return { ...c, a: m(c.b), b: m(c.a) };
    case 'hDistance':
    case 'vDistance': {
      const flips =
        (c.kind === 'hDistance' && verticalAxis) || (c.kind === 'vDistance' && horizontalAxis);
      const keeps =
        (c.kind === 'hDistance' && horizontalAxis) || (c.kind === 'vDistance' && verticalAxis);
      if (keeps) return remap();
      if (!flips) return null;
      if (c.a !== c.b) return { ...c, a: m(c.b), b: m(c.a) };
      // A line's own extent (end − start): the copy's start − end, as two points.
      const ends = lineEnds(c.a);
      return ends ? { ...c, a: m(ends[1]), b: m(ends[0]) } : null;
    }
    default:
      return remap();
  }
}
