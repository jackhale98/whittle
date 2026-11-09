/**
 * Linked sketch entities (M3 Convert Entities, ADR-019 item 6): the seam between the regen
 * engine, the kernel's projection calls and packages/sketch's re-projection.
 *
 * Flow per sketch with `source`d entities, before solving:
 *  1. the engine resolves every distinct `source.ref` against the current upstream state (§7.3:
 *     name → name + fingerprint → fingerprint → unresolved; an unresolved source makes the sketch
 *     "needs attention" with the entity ids — never a re-pick);
 *  2. it projects each source onto the sketch plane (`LinkedCurve`s, sketch-local mm): model edges
 *     and face outlines through the kernel's `projectEdges` / `projectFaceOutline` when the
 *     façade has them, reference geometry (origin, axes, planes, points) and other sketches'
 *     curves in TypeScript, and straight / plane-parallel circular edges in TypeScript as a
 *     fallback;
 *  3. it hands entities + projections to a `ReprojectLinked` function, which moves the linked
 *     entities onto their projections in place and reports entities whose source no longer fits
 *     (`lost`, also "needs attention"). packages/sketch owns the real one (sketch engineer, M3);
 *     until it lands the engine uses `reprojectLinkedFallback` below.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  Frame,
  Id,
  Result,
  ShapeHandle,
  SketchEntity,
  SketchPoint,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { heightAbove, type Line, toLocal } from './datums';
import { cross, dot, norm, normalize, sub } from './geometry';

/**
 * A projected curve as the kernel returns it (kernel engineer, M3 `KernelLowLevelApi`):
 * coordinates in the target plane frame's local (u, v), mm. Arcs run counter-clockwise from
 * `start` to `end` about the plane normal, as `SketchArc`.
 */
export type ProjectedCurve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'arc'; c: Vec2; r: number; start: Vec2; end: Vec2 }
  | { kind: 'polyline'; points: Vec2[] };

/**
 * What a linked entity is re-projected onto: a kernel curve, a point (vertices, construction
 * points), or a line marked `infinite` (axes and plane traces: only its position and direction
 * matter, the entity keeps its own extent along it).
 */
export type LinkedCurve =
  | ProjectedCurve
  | { kind: 'point'; p: Vec2 }
  | { kind: 'line'; a: Vec2; b: Vec2; infinite: true };

/** The M3 projection calls (`KernelLowLevelApi` once the kernel engineer's work is merged). */
export interface ProjectionApi {
  projectEdges(
    shape: ShapeHandle,
    edges: number[],
    plane: Frame,
  ): Promise<Result<{ edge: number; curves: ProjectedCurve[] }[]>>;
  projectFaceOutline(
    shape: ShapeHandle,
    face: number,
    plane: Frame,
  ): Promise<Result<{ edge: number; curves: ProjectedCurve[] }[] | ProjectedCurve[]>>;
}

/** One distinct source of a sketch's linked entities, projected. */
export interface LinkedSource {
  /** The stored reference (shared by `entities`). */
  ref: EntityRef;
  /** Ids of the entities linked to this source, in document order. */
  entities: Id[];
  /** The projection onto the sketch plane (sketch-local mm). */
  curves: LinkedCurve[];
  /** The projection had to be fitted (e.g. a B-spline seen at an angle → polyline). */
  approximate?: boolean;
}

export interface ReprojectResult {
  /** All entities, linked ones moved onto their projections (same ids and order). */
  entities: SketchEntity[];
  /** Linked entities that no longer fit their source (e.g. a line whose edge became an arc). */
  lost: { entity: Id; reason: string }[];
}

/**
 * packages/sketch's re-projection (expected export `reprojectLinked` from `@wren-cad/sketch`).
 * Pure; never re-picks a different source.
 */
export type ReprojectLinked = (
  entities: readonly SketchEntity[],
  sources: readonly LinkedSource[],
) => ReprojectResult;

/** Flattens either `projectFaceOutline` result shape into curves. */
export function flattenProjection(
  v: { edge: number; curves: ProjectedCurve[] }[] | ProjectedCurve[],
): ProjectedCurve[] {
  const out: ProjectedCurve[] = [];
  for (const x of v as unknown[]) {
    if (x && typeof x === 'object' && 'curves' in x) {
      out.push(...(x as { curves: ProjectedCurve[] }).curves);
    } else out.push(x as ProjectedCurve);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TypeScript projections (reference geometry, sketch curves, simple edges)
// ---------------------------------------------------------------------------------------------

export function projectPoint(plane: Frame, p: Vec3): LinkedCurve {
  return { kind: 'point', p: toLocal(plane, p) };
}

/** A line (axis) seen in the sketch: an infinite line, or a point when it is along the normal. */
export function projectAxis(plane: Frame, l: Line): LinkedCurve {
  const n = normalize(plane.z);
  const along = sub(l.dir, scaleV(n, dot(l.dir, n)));
  if (norm(along) <= 1e-9) return projectPoint(plane, l.origin);
  const a = toLocal(plane, l.origin);
  const b = toLocal(plane, [
    l.origin[0] + l.dir[0],
    l.origin[1] + l.dir[1],
    l.origin[2] + l.dir[2],
  ]);
  return { kind: 'line', a, b, infinite: true };
}

/** Where a plane cuts the sketch plane (ADR-017: perpendicular planes project to lines). */
export function projectPlaneTrace(plane: Frame, other: Frame): LinkedCurve | { error: string } {
  const n = normalize(plane.z);
  const m = normalize(other.z);
  const d = cross(n, m);
  if (norm(d) <= 1e-9) {
    return {
      error:
        'A plane parallel to the sketch cannot be projected; dimension the sketch plane’s offset instead',
    };
  }
  // A point on both planes: solve in the sketch plane along the direction in it perpendicular to d.
  const dir = normalize(d);
  const inPlane = normalize(cross(n, dir));
  const t = (dot(m, other.origin) - dot(m, plane.origin)) / dot(m, inPlane);
  const p: Vec3 = [
    plane.origin[0] + inPlane[0] * t,
    plane.origin[1] + inPlane[1] * t,
    plane.origin[2] + inPlane[2] * t,
  ];
  return projectAxis(plane, { origin: p, dir });
}

/**
 * A circle in space seen in the sketch: a circle (or arc from `start` to `end` CCW about its own
 * normal) when it is parallel to the sketch plane; otherwise an error (an ellipse needs the
 * kernel's projection).
 */
export function projectCircle(
  plane: Frame,
  c: { centre: Vec3; normal: Vec3; radius: number },
  arc?: { start: Vec3; end: Vec3 },
): LinkedCurve | { error: string } {
  const n = normalize(plane.z);
  const cn = dot(normalize(c.normal), n);
  if (Math.abs(Math.abs(cn) - 1) > 1e-9) {
    return { error: 'This curved edge is not parallel to the sketch' };
  }
  const centre = toLocal(plane, c.centre);
  if (!arc) return { kind: 'circle', c: centre, r: c.radius };
  const s = toLocal(plane, arc.start);
  const e = toLocal(plane, arc.end);
  // CCW about the sketch normal: swap when the arc's own sense is opposite.
  return cn > 0
    ? { kind: 'arc', c: centre, r: c.radius, start: s, end: e }
    : { kind: 'arc', c: centre, r: c.radius, start: e, end: s };
}

/** A curve of another sketch (its solved entities, in its frame) projected onto this sketch. */
export function projectSketchEntity(
  plane: Frame,
  srcFrame: Frame,
  e: SketchEntity,
  points: ReadonlyMap<Id, Vec2>,
): LinkedCurve | { error: string } {
  const w = (uv: Vec2 | undefined): Vec3 => {
    const [u, v] = uv ?? [0, 0];
    const y = cross(srcFrame.z, srcFrame.x);
    return [
      srcFrame.origin[0] + srcFrame.x[0] * u + y[0] * v,
      srcFrame.origin[1] + srcFrame.x[1] * u + y[1] * v,
      srcFrame.origin[2] + srcFrame.x[2] * u + y[2] * v,
    ];
  };
  switch (e.kind) {
    case 'point':
      return projectPoint(plane, w([e.x, e.y]));
    case 'line':
      return {
        kind: 'line',
        a: toLocal(plane, w(points.get(e.start))),
        b: toLocal(plane, w(points.get(e.end))),
      };
    case 'circle':
      return projectCircle(plane, {
        centre: w(points.get(e.center)),
        normal: srcFrame.z,
        radius: e.radius,
      });
    case 'arc': {
      const c = points.get(e.center) ?? [0, 0];
      const s = points.get(e.start) ?? [0, 0];
      return projectCircle(
        plane,
        { centre: w(c), normal: srcFrame.z, radius: Math.hypot(s[0] - c[0], s[1] - c[1]) },
        { start: w(s), end: w(points.get(e.end)) },
      );
    }
    case 'ellipse':
      return { error: 'Ellipses cannot be projected yet' };
  }
}

/** Is the world point on the sketch plane (within `tol`)? */
export function onPlane(plane: Frame, p: Vec3, tol: number): boolean {
  return Math.abs(heightAbove(plane, p)) <= tol;
}

function scaleV(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

// ---------------------------------------------------------------------------------------------
// Fallback re-projection (until packages/sketch's `reprojectLinked` lands)
// ---------------------------------------------------------------------------------------------

/**
 * Minimal re-projection: a source with one curve moves its one linked curve entity (or its
 * points) onto it — line → line (keeping its orientation; an infinite line keeps the entity's own
 * extent), circle → circle, arc → arc, point → point; a source with several curves (a face
 * outline, a polyline) maps them one to one onto its linked curve entities in document order when
 * the kinds match (polyline segments as lines). Anything else is `lost` with a reason: the sketch
 * then needs attention; nothing is re-picked.
 */
export const reprojectLinkedFallback: ReprojectLinked = (entities, sources) => {
  const out = entities.map((e) => ({ ...e }) as SketchEntity);
  const byId = new Map(out.map((e) => [e.id, e]));
  const lost: ReprojectResult['lost'] = [];
  const pt = (id: Id): SketchPoint | undefined => {
    const e = byId.get(id);
    return e?.kind === 'point' ? e : undefined;
  };
  const setPt = (id: Id, p: Vec2) => {
    const e = pt(id);
    if (e) {
      e.x = p[0];
      e.y = p[1];
    }
  };
  for (const src of sources) {
    const linked = src.entities.map((id) => byId.get(id)).filter((e) => e !== undefined);
    // Points used by linked curves of this source follow their curve.
    const owned = new Set<Id>();
    for (const e of linked) {
      if (e.kind === 'line') owned.add(e.start).add(e.end);
      if (e.kind === 'circle') owned.add(e.center);
      if (e.kind === 'arc') owned.add(e.center).add(e.start).add(e.end);
    }
    const curvesE = linked.filter((e) => e.kind !== 'point');
    const pointsE = linked.filter((e) => e.kind === 'point' && !owned.has(e.id));
    const curves = src.curves.flatMap((c): LinkedCurve[] =>
      c.kind === 'polyline'
        ? c.points.slice(1).map((p, i) => ({ kind: 'line', a: c.points[i] as Vec2, b: p }))
        : [c],
    );
    const fail = (reason: string) => {
      for (const e of linked) lost.push({ entity: e.id, reason });
    };
    if (curves.length === 1 && curves[0]?.kind === 'point') {
      const c = curves[0];
      if (curvesE.length > 0) {
        fail('The source is now a point');
        continue;
      }
      for (const p of pointsE) setPt(p.id, c.p);
      continue;
    }
    if (pointsE.length > 0 && curvesE.length === 0) {
      fail('The source is no longer a point');
      continue;
    }
    if (curvesE.length !== curves.length) {
      fail(
        `The source now projects to ${curves.length} curve${curves.length === 1 ? '' : 's'}, not ${curvesE.length}`,
      );
      continue;
    }
    let ok = true;
    const placed = new Map<Id, Vec2>();
    curvesE.forEach((e, i) => {
      const c = curves[i] as LinkedCurve;
      if (!ok) return;
      if (e.kind === 'line' && c.kind === 'line') {
        const s = pt(e.start);
        const t = pt(e.end);
        if (!s || !t) return;
        if ('infinite' in c) {
          setPt(e.start, footLocal(c, [s.x, s.y]));
          setPt(e.end, footLocal(c, [t.x, t.y]));
        } else {
          // A point already placed by the previous curve of this source (a chain) decides the
          // orientation; otherwise the one nearest the entity's current position.
          const at = (id: Id, p: SketchPoint): Vec2 => placed.get(id) ?? [p.x, p.y];
          let swap: boolean;
          if (placed.has(e.start) || placed.has(e.end)) {
            const id = placed.has(e.start) ? e.start : e.end;
            const q = placed.get(id) as Vec2;
            const startIsA = id === e.start ? d2(q, c.a) <= d2(q, c.b) : d2(q, c.b) <= d2(q, c.a);
            swap = !startIsA;
          } else {
            const keep = d2(at(e.start, s), c.a) + d2(at(e.end, t), c.b);
            swap = d2(at(e.start, s), c.b) + d2(at(e.end, t), c.a) < keep;
          }
          setPt(e.start, swap ? c.b : c.a);
          setPt(e.end, swap ? c.a : c.b);
          placed.set(e.start, swap ? c.b : c.a);
          placed.set(e.end, swap ? c.a : c.b);
        }
      } else if (e.kind === 'circle' && c.kind === 'circle') {
        setPt(e.center, c.c);
        e.radius = c.r;
      } else if (e.kind === 'arc' && c.kind === 'arc') {
        setPt(e.center, c.c);
        setPt(e.start, c.start);
        setPt(e.end, c.end);
      } else {
        ok = false;
        fail(`A linked ${e.kind} cannot follow a source that is now ${article(c.kind)}`);
      }
    });
  }
  return { entities: out, lost };
};

function d2(a: Vec2, b: Vec2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function footLocal(l: { a: Vec2; b: Vec2 }, p: Vec2): Vec2 {
  const dx = l.b[0] - l.a[0];
  const dy = l.b[1] - l.a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - l.a[0]) * dx + (p[1] - l.a[1]) * dy) / len2;
  return [l.a[0] + t * dx, l.a[1] + t * dy];
}

function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}
