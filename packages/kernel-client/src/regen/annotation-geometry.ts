/**
 * Geometry of resolved annotation references (M4, ADR-090): what each resolved ref is (a plane, a
 * line, a circle, an axis, a point…), the `AnnotationAnchor` a drawing view projects, and the value
 * an annotation measures from its refs (`AnnotationResolution.measured`).
 *
 * Everything is read from the façade's exact data: fingerprints (planar face centroids and outward
 * normals, vertex points) and `subShapeGeometry` (line end points; circle centres, normals and
 * radii; cylinder and cone axes with their axial extent; sphere centres): one kernel call per round
 * or straight ref, memoised per shape handle (`EngineCore.exactOf`), so a body that did not change
 * costs only lookups. Against a kernel build without `subShapeGeometry` (and engine fakes) the
 * same values are probed with `measureShapes` (datums.ts, about 27 measurements per round ref).
 * Distances and angles that need the kernel come from `measureShapes`. Curves other than lines
 * and circles are anchored by the body's coarse mesh polyline.
 *
 * Exact data is put in the probes' canonical form, so an anchor does not depend on which path ran
 * or on how OCCT parametrised the curve: a line's ends and an arc's ends in `compareKey` order,
 * circle normals and axis directions by `canonicalDir`, an axis' origin at the foot of the world
 * origin.
 *
 * Conventions (part mm and radians):
 *  - linear with `direction`: the distance between the two refs' measuring points projected on it
 *    (a plane's centroid, a line's mid point, an axis' origin, a circle's or sphere's centre);
 *    `min` / `max` (M4.1, ADR-095) are the ref's extreme points along it (`extremePoint`);
 *  - linear without one: the separation of parallel planes or lines, or of a plane (or a line) and
 *    a point; anything else is not measurable without a direction, and neither are `min` / `max`;
 *  - aligned: point to point, else the exact minimum distance between the two sub-shapes;
 *  - ordinate: |coordinate of refs[1] − refs[0]| along `direction`;
 *  - radius / diameter: of a circular edge, a cylindrical face or a sphere; of a torus face (a
 *    fillet at a shaft step, M4.1) its minor radius;
 *  - angle: the kernel's exact angle for planar faces and straight edges (face–face between outward
 *    normals, edges sharing a vertex the corner angle, other pairs between the lines), else the
 *    same conventions from the directions; `supplement` is π minus it. A planar face at `axis`
 *    (M4.1) is the line along its normal (the pull direction of a draft), as is a circle at `axis`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Annotation,
  AnnotationAnchor,
  Frame,
  RefPoint,
  ShapeHandle,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import type { ExactProjectedCurve, ProjectedLoopEdge, SubShapeGeometry } from '../kernel-api';
import type { EngineCore } from './core';
import { ellipsePoint, prepareBSpline, sampleBSpline } from './curves';
import { canonicalDir, compareKey, footOnLine, sphereCentre } from './datums';
import {
  add,
  cross,
  dist,
  dot,
  norm,
  normalize,
  planeFrame,
  scale,
  sub,
  toWorld,
} from './geometry';

/** A sub-shape the kernel can measure. */
export interface SubTarget {
  shape: ShapeHandle;
  kind: 'face' | 'edge' | 'vertex';
  index: number;
}

/** An axis: a cylinder's, a cone's, a construction axis or an origin axis. */
export interface AxisGeo {
  t: 'axis';
  origin: Vec3;
  dir: Vec3;
  /** Axial range of the face along `dir` from `origin` (`[0, 0]` for construction axes). */
  extent: [number, number];
  /** A cylinder's radius (a size); absent for cones and construction axes. */
  radius?: number;
  /** Radii at `extent[0]` and `extent[1]` (cylinders and cones, exact path only). */
  ends?: [number, number];
  target?: SubTarget;
  /** The face's current persistent name (set by the resolver; hole walls are read from it). */
  name?: string;
}

/** What a resolved ref is, geometrically. */
export type RefGeo =
  | { t: 'plane'; origin: Vec3; normal: Vec3; target?: SubTarget }
  | { t: 'line'; a: Vec3; b: Vec3; target?: SubTarget }
  | {
      t: 'circle';
      center: Vec3;
      normal: Vec3;
      radius: number;
      start?: Vec3;
      end?: Vec3;
      target?: SubTarget;
    }
  | AxisGeo
  | { t: 'sphere'; center: Vec3; radius: number; target: SubTarget }
  | { t: 'point'; at: Vec3; target?: SubTarget }
  | TorusGeo
  /** Another face or edge: its centroid, and a polyline for edges. */
  | { t: 'other'; centroid: Vec3; points?: Vec3[]; target?: SubTarget };

/**
 * A torus face (M4.1: a fillet at a shaft step, whose outline in a view is a B-spline): its centre
 * and canonical axis, major and minor radii, and the face's centroid (what it is measured and
 * anchored by when it is not a size).
 */
export interface TorusGeo {
  t: 'torus';
  center: Vec3;
  axis: Vec3;
  major: number;
  minor: number;
  centroid: Vec3;
  target: SubTarget;
}

/** Geometry of a face, edge or vertex of a live shape (memoised per handle). */
export async function subGeometry(core: EngineCore, t: SubTarget): Promise<RefGeo | null> {
  const fp = await core.fingerprints(t.shape);
  if (!fp) return null;
  if (t.kind === 'vertex') {
    const v = fp.vertices[t.index];
    return v ? { t: 'point', at: v.point, target: t } : null;
  }
  if (t.kind === 'face') {
    const f = fp.faces[t.index];
    if (!f) return null;
    // The fingerprint's centroid and normal are exact, and the normal is outward: `planeOf`
    // reverses left-handed planes too since the M4 kernel build (chamfer faces, mirrored copies).
    // Faces of sketches and planes have no material side and keep their frame's normal.
    if (f.normal) return { t: 'plane', origin: f.centroid, normal: normalize(f.normal), target: t };
    const other: RefGeo = { t: 'other', centroid: f.centroid, target: t };
    if (f.surface === 'torus') {
      // Exact only: the probes have no torus (a kernel build without `subShapeGeometry`).
      const x = await core.exactOf(t);
      return (x ? exactFace(x, t, f.centroid) : null) ?? other;
    }
    if (f.surface !== 'cylinder' && f.surface !== 'cone' && f.surface !== 'sphere') return other;
    const x = await core.exactOf(t);
    if (x) return exactFace(x, t, f.centroid) ?? other;
    return (await probedFace(core, t, f.surface, f.area)) ?? other;
  }
  const e = fp.edges[t.index];
  if (!e) return null;
  if (e.curve === 'line' || e.curve === 'circle') {
    const x = await core.exactOf(t);
    const g = x ? exactEdge(x, t) : await probedEdge(core, t, e.curve);
    if (g) return g;
  }
  const points = await edgePolyline(core, t);
  return points
    ? { t: 'other', centroid: e.centroid, points, target: t }
    : { t: 'other', centroid: e.centroid, target: t };
}

/** A face's `subShapeGeometry` as a ref geometry (null for surfaces anchored by their centroid). */
function exactFace(x: SubShapeGeometry, t: SubTarget, centroid: Vec3): RefGeo | null {
  if (x.kind !== 'face') return null;
  if (x.surface === 'cylinder' && x.radius > 0) {
    const a = canonicalAxis(x.origin, x.axis, x.extent);
    return { t: 'axis', ...a, radius: x.radius, ends: [x.radius, x.radius], target: t };
  }
  if (x.surface === 'cone') {
    // A cone has no single radius: an axis for anchors and angles, never a size. Its radius at
    // an axial station is the distance from the apex times tan(semi-angle), whatever the sign
    // conventions of OCCT's parametrisation.
    const a = canonicalAxis(x.origin, x.axis, x.extent);
    const slope = Math.abs(Math.tan(x.semiAngle));
    const apex = dot(sub(x.apex, a.origin), a.dir);
    const ends: [number, number] = [
      Math.abs(a.extent[0] - apex) * slope,
      Math.abs(a.extent[1] - apex) * slope,
    ];
    return { t: 'axis', ...a, ends, target: t };
  }
  if (x.surface === 'sphere' && x.radius > 0) {
    return { t: 'sphere', center: x.center, radius: x.radius, target: t };
  }
  if (x.surface === 'torus' && x.minorRadius > 0) {
    return {
      t: 'torus',
      center: x.origin,
      axis: canonicalDir(normalize(x.axis)),
      major: x.majorRadius,
      minor: x.minorRadius,
      centroid,
      target: t,
    };
  }
  return null;
}

/** An edge's `subShapeGeometry` as a line or circle (null for other curves). */
function exactEdge(x: SubShapeGeometry, t: SubTarget): RefGeo | null {
  if (x.kind !== 'edge') return null;
  if (x.curve === 'line') {
    const [a, b] = ordered(x.start, x.end);
    return { t: 'line', a, b, target: t };
  }
  if (x.curve === 'circle' && x.radius > 0) {
    const g: RefGeo = {
      t: 'circle',
      center: x.center,
      normal: canonicalDir(x.normal),
      radius: x.radius,
      target: t,
    };
    if (!x.full) [g.start, g.end] = ordered(x.start, x.end);
    return g;
  }
  return null;
}

/** Two points in `compareKey` order (the probes' order, independent of parametrisation). */
const ordered = (a: Vec3, b: Vec3): [Vec3, Vec3] => (compareKey(a, b) <= 0 ? [a, b] : [b, a]);

/**
 * An axis in canonical form: direction by `canonicalDir`, origin at the foot of the world origin
 * (as the probes give it), the extent re-measured from there along that direction.
 */
export function canonicalAxis(
  origin: Vec3,
  axis: Vec3,
  extent: [number, number],
): { origin: Vec3; dir: Vec3; extent: [number, number] } {
  const a = normalize(axis);
  const dir = canonicalDir(a);
  const o = footOnLine({ origin, dir }, [0, 0, 0]);
  const t0 = dot(sub(add(origin, scale(a, extent[0])), o), dir);
  const t1 = dot(sub(add(origin, scale(a, extent[1])), o), dir);
  return { origin: o, dir, extent: [Math.min(t0, t1), Math.max(t0, t1)] };
}

/**
 * Fallback for kernel builds without `subShapeGeometry` (and engine fakes): the datums.ts probes,
 * memoised per handle. Cones stay `other` here.
 */
async function probedFace(
  core: EngineCore,
  t: SubTarget,
  surface: 'cylinder' | 'cone' | 'sphere',
  area: number,
): Promise<RefGeo | null> {
  if (surface === 'cylinder') {
    const a = await core.axisOfFace(t);
    if (!a) return null;
    const extent = await core.memo(t.shape, `extent:${t.index}`, () =>
      axisExtent(core, t, a.origin, a.dir, Math.sqrt(Math.max(area, 0)) + a.radius),
    );
    return { t: 'axis', origin: a.origin, dir: a.dir, extent, radius: a.radius, target: t };
  }
  if (surface === 'sphere') {
    const c = await core.memo(t.shape, `sphere:${t.index}`, () =>
      sphereCentre(core.geo(), t.shape, t.index),
    );
    const r = c ? await radiusOf(core, t) : undefined;
    if (c && r !== undefined) return { t: 'sphere', center: c, radius: r, target: t };
  }
  return null;
}

/** Fallback for kernel builds without `subShapeGeometry`: probed lines and circles. */
async function probedEdge(
  core: EngineCore,
  t: SubTarget,
  curve: 'line' | 'circle',
): Promise<RefGeo | null> {
  if (curve === 'line') {
    const l = await core.lineOfEdge(t);
    return l ? { t: 'line', a: l.a, b: l.b, target: t } : null;
  }
  const c = await core.circleOfEdge(t);
  if (!c) return null;
  const g: RefGeo = { t: 'circle', center: c.centre, normal: c.normal, radius: c.radius };
  g.target = t;
  if (!c.full) {
    const ends = await core.endpointsOf(t, Math.max(1e-6, 1e-6 * c.radius));
    if (ends.length === 2) {
      g.start = ends[0] as Vec3;
      g.end = ends[1] as Vec3;
    }
  }
  return g;
}

/** Exact radius of a circular edge, cylindrical or spherical face (probe fallback, memoised). */
async function radiusOf(core: EngineCore, t: SubTarget): Promise<number | undefined> {
  return core.memo(t.shape, `radius:${t.kind}:${t.index}`, async () => {
    const m = await core.kernel.measureShapes(t);
    const r = m.ok ? m.value.radius : undefined;
    return r !== undefined && r > 0 ? r : undefined;
  });
}

/**
 * Where a cylindrical face runs along its axis (probe fallback): parameters (along `dir`, from
 * `origin`) of the face's closest points to two far points on the axis, one each way (exact, two
 * measurements).
 */
async function axisExtent(
  core: EngineCore,
  t: SubTarget,
  origin: Vec3,
  dir: Vec3,
  size: number,
): Promise<[number, number]> {
  const fp = await core.fingerprints(t.shape);
  const c = fp?.faces[t.index]?.centroid ?? origin;
  const mid = dot(sub(c, origin), dir);
  const reach = 10 * (size + 1) + Math.abs(mid);
  const out: number[] = [];
  for (const s of [-1, 1]) {
    const p = add(origin, scale(dir, mid + s * reach));
    const m = await core.kernel.measureShapes(t, { point: p });
    out.push(m.ok && m.value.distance ? dot(sub(m.value.distance.a, origin), dir) : mid);
  }
  const [lo, hi] = [Math.min(...out), Math.max(...out)];
  return [lo, hi];
}

/** An edge's coarse mesh polyline (world mm), or null when the shape has no mesh edges. */
async function edgePolyline(core: EngineCore, t: SubTarget): Promise<Vec3[] | null> {
  const m = await core.meshOf(t.shape, 'coarse');
  if (!m) return null;
  const first = m.edgeRanges[2 * t.index];
  const count = m.edgeRanges[2 * t.index + 1];
  if (first === undefined || count === undefined || count < 2) return null;
  const out: Vec3[] = [];
  for (let i = first; i < first + count; i++) {
    out.push([
      m.edgePositions[3 * i] as number,
      m.edgePositions[3 * i + 1] as number,
      m.edgePositions[3 * i + 2] as number,
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

/**
 * The circle of a round face at one end of its axial extent (`end` 0 or 1, along the canonical
 * `dir`): the rim a size dimension or a hole callout points at. `outward`: the normal points away
 * from the face at that end (out of a hole's entry); otherwise it is the canonical `dir`. A face
 * that is not a full turn (a fillet) gets the arc's end points from its boundary arc at that end,
 * when exactly one boundary arc lies there; a full rim, or one in several pieces, is a full
 * circle. Null for an axis without a radius at that end.
 */
export async function rimAnchor(
  core: EngineCore,
  g: AxisGeo,
  end: 0 | 1,
  outward: boolean,
): Promise<AnnotationAnchor | null> {
  const r = g.ends?.[end] ?? g.radius;
  if (r === undefined || !(r > 0)) return null;
  const center = add(g.origin, scale(g.dir, g.extent[end]));
  const normal = outward && end === 0 ? scale(g.dir, -1) : g.dir;
  const a: AnnotationAnchor = { kind: 'circle', center, normal, radius: r };
  const arc = g.target ? await rimArc(core, g.target, center, g.dir, r) : null;
  if (arc) {
    a.start = arc[0];
    a.end = arc[1];
  }
  return noNegativeZero(a);
}

/**
 * The end points of the one partial boundary arc of a round face at a station (centre, axis,
 * radius), from the exact geometry of its shape's circular edges there. Null when the rim is a
 * full circle, is in several pieces, or the kernel has no exact geometry: never a guessed arc.
 */
async function rimArc(
  core: EngineCore,
  face: SubTarget,
  center: Vec3,
  dir: Vec3,
  r: number,
): Promise<[Vec3, Vec3] | null> {
  const fp = await core.fingerprints(face.shape);
  if (!fp) return null;
  const tol = 1e-6 * (1 + r);
  let found: [Vec3, Vec3] | null = null;
  for (let i = 0; i < fp.edges.length; i++) {
    const e = fp.edges[i];
    if (e?.curve !== 'circle') continue;
    // An arc's centroid lies in its plane, inside its circle.
    const d = sub(e.centroid, center);
    if (Math.abs(dot(d, dir)) > tol || norm(d) > r + tol) continue;
    const x = await core.exactOf({ shape: face.shape, kind: 'edge', index: i });
    if (x?.kind !== 'edge' || x.curve !== 'circle') {
      if (!x) return null;
      continue;
    }
    if (dist(x.center, center) > tol || Math.abs(x.radius - r) > tol) continue;
    if (x.full || found) return null;
    found = ordered(x.start, x.end);
  }
  return found;
}

/** The anchor of a resolved ref for its point qualifier (`at`). */
export async function anchorOf(
  core: EngineCore,
  g: RefGeo,
  at: RefPoint,
): Promise<AnnotationAnchor> {
  return noNegativeZero(await rawAnchor(core, g, at));
}

/** `-0` → `0` in every number of an anchor (fingerprint normals can carry `-0`). */
function noNegativeZero<T>(v: T): T {
  if (typeof v === 'number') return (v === 0 ? 0 : v) as T;
  if (Array.isArray(v)) return v.map(noNegativeZero) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = noNegativeZero(x);
    return out as T;
  }
  return v;
}

async function rawAnchor(core: EngineCore, g: RefGeo, at: RefPoint): Promise<AnnotationAnchor> {
  switch (g.t) {
    case 'plane':
      if (at === 'self' || at === 'axis') {
        return {
          kind: 'plane',
          origin: g.origin,
          normal: g.normal,
          outline: g.target ? await planeOutline(core, g.target, g.origin, g.normal) : [],
        };
      }
      return { kind: 'point', at: g.origin };
    case 'line':
      if (at === 'start') return { kind: 'point', at: g.a };
      if (at === 'end') return { kind: 'point', at: g.b };
      if (at === 'mid' || at === 'center') return { kind: 'point', at: mid(g.a, g.b) };
      return { kind: 'line', a: g.a, b: g.b };
    case 'circle': {
      if (at === 'center') return { kind: 'point', at: g.center };
      if (at === 'axis') {
        return { kind: 'axis', origin: g.center, direction: g.normal, extent: [0, 0] };
      }
      if (at === 'start' && g.start) return { kind: 'point', at: g.start };
      if (at === 'end' && g.end) return { kind: 'point', at: g.end };
      const a: AnnotationAnchor = {
        kind: 'circle',
        center: g.center,
        normal: g.normal,
        radius: g.radius,
      };
      if (g.start && g.end) {
        a.start = g.start;
        a.end = g.end;
      }
      return a;
    }
    case 'axis':
      if (at === 'center' || at === 'mid') {
        return { kind: 'point', at: add(g.origin, scale(g.dir, (g.extent[0] + g.extent[1]) / 2)) };
      }
      if (at === 'start') return { kind: 'point', at: add(g.origin, scale(g.dir, g.extent[0])) };
      if (at === 'end') return { kind: 'point', at: add(g.origin, scale(g.dir, g.extent[1])) };
      return { kind: 'axis', origin: g.origin, direction: g.dir, extent: g.extent };
    case 'sphere':
      return { kind: 'point', at: g.center };
    case 'torus':
      // As a size (radius, diameter) it is `torusAnchor`; otherwise its centre, its axis, or the
      // face itself by its centroid (as any other curved face).
      if (at === 'center') return { kind: 'point', at: g.center };
      if (at === 'axis')
        return { kind: 'axis', origin: g.center, direction: g.axis, extent: [0, 0] };
      return { kind: 'point', at: g.centroid };
    case 'point':
      return { kind: 'point', at: g.at };
    case 'other':
      if (at === 'self' && g.points) return { kind: 'curve', points: g.points };
      if (g.points && (at === 'start' || at === 'end')) {
        const p = at === 'start' ? g.points[0] : g.points[g.points.length - 1];
        if (p) return { kind: 'point', at: p };
      }
      return { kind: 'point', at: g.centroid };
  }
}

const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);

/** The `torus` anchor of a torus face (M4.1): what a radius on a fillet at a shaft step points at. */
export function torusAnchor(g: TorusGeo): AnnotationAnchor {
  return noNegativeZero({
    kind: 'torus',
    center: g.center,
    axis: g.axis,
    major: g.major,
    minor: g.minor,
  });
}

/**
 * The anchor of a ref at `min` / `max` (M4.1) for a dimension along `direction`: its extreme point
 * (`extremePoint`). Null when the ref has none (a plane), or without a direction (an anchor query):
 * the caller then anchors the entity itself.
 */
export function extremeAnchor(
  g: RefGeo,
  at: 'min' | 'max',
  direction: Vec3 | undefined,
): AnnotationAnchor | null {
  if (!direction) return null;
  const p = extremePoint(g, at, direction);
  return isPoint(p) ? noNegativeZero({ kind: 'point', at: p }) : null;
}

const isPoint = (p: Vec3 | Unmeasurable): p is Vec3 => Array.isArray(p);

/**
 * The outer boundary of a planar face as a closed polygon (world mm): `projectFaceOutline` onto
 * the face's own plane, curves sampled (arcs every 15°), memoised per handle. Empty when the kernel
 * build has no outline projection.
 */
async function planeOutline(
  core: EngineCore,
  t: SubTarget,
  origin: Vec3,
  normal: Vec3,
): Promise<Vec3[]> {
  if (!core.kernel.projectFaceOutline || t.kind !== 'face') return [];
  return core.memo(t.shape, `outline:${t.index}`, async () => {
    const frame: Frame = planeFrame(origin, normal);
    const r = await core.kernel.projectFaceOutline?.(t.shape, t.index, frame);
    if (!r?.ok) return [];
    // The worker returns loop-tagged edges (outer loop 0); engine fakes may return bare curves.
    const items = r.value as unknown as (Partial<ProjectedLoopEdge> & { kind?: string })[];
    const edges = items
      .filter((e) => (e.loop ?? 0) === 0)
      .map((e) => (e.curves ? e.curves : e.kind ? [e as unknown as ExactProjectedCurve] : []));
    // The edges come in wire order, each in its curve's own direction: chain them end to start.
    let loop: Vec2[] = [];
    let chained = 0;
    for (const curves of edges) {
      let pts: Vec2[] = [];
      for (const c of curves) pts.push(...samplePlaneCurve(c));
      if (pts.length === 0) continue;
      const head = pts[0] as Vec2;
      const tail = pts[pts.length - 1] as Vec2;
      // The first edge's direction is only known from the second: it ends where that one touches.
      if (chained === 1) {
        const first = loop[0] as Vec2;
        const last = loop[loop.length - 1] as Vec2;
        if (Math.min(d2(first, head), d2(first, tail)) < Math.min(d2(last, head), d2(last, tail))) {
          loop = loop.reverse();
        }
      }
      chained++;
      const last = loop[loop.length - 1];
      if (last && d2(last, head) > d2(last, tail)) pts = pts.reverse();
      for (const p of pts) {
        const prev = loop[loop.length - 1];
        if (!prev || d2(prev, p) > 1e-18) loop.push(p);
      }
    }
    if (loop.length > 1 && d2(loop[0] as Vec2, loop[loop.length - 1] as Vec2) <= 1e-12) loop.pop();
    return loop.map(([u, v]) => toWorld(frame, u, v));
  });
}

const d2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Points along one projected curve, in order (plane-local mm). */
function samplePlaneCurve(c: ExactProjectedCurve): Vec2[] {
  const STEP = Math.PI / 12;
  const arc = (cx: Vec2, r: number, a0: number, sweep: number): Vec2[] => {
    const n = Math.max(2, Math.ceil(sweep / STEP));
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + (sweep * i) / n;
      return [cx[0] + r * Math.cos(a), cx[1] + r * Math.sin(a)] as Vec2;
    });
  };
  const angle = (cx: Vec2, p: Vec2) => Math.atan2(p[1] - cx[1], p[0] - cx[0]);
  const ccw = (a0: number, a1: number) => {
    let s = a1 - a0;
    while (s <= 1e-12) s += 2 * Math.PI;
    return s;
  };
  switch (c.kind) {
    case 'line':
      return [c.a, c.b];
    case 'polyline':
      return c.points;
    case 'circle':
      return arc(c.c, c.r, 0, 2 * Math.PI);
    case 'arc': {
      const a0 = angle(c.c, c.start);
      return arc(c.c, c.r, a0, ccw(a0, angle(c.c, c.end)));
    }
    case 'ellipse':
    case 'ellipticArc': {
      const e = { c: c.c, a: c.majorRadius, b: c.minorRadius, rotation: c.rotation };
      const param = (p: Vec2) => {
        const cr = Math.cos(e.rotation);
        const sr = Math.sin(e.rotation);
        const dx = p[0] - e.c[0];
        const dy = p[1] - e.c[1];
        return Math.atan2((-dx * sr + dy * cr) / e.b, (dx * cr + dy * sr) / e.a);
      };
      const t0 = c.kind === 'ellipse' ? 0 : param(c.start);
      const sweep = c.kind === 'ellipse' ? 2 * Math.PI : ccw(t0, param(c.end));
      const n = Math.max(2, Math.ceil(sweep / STEP));
      return Array.from({ length: n + 1 }, (_, i) => ellipsePoint(e, t0 + (sweep * i) / n));
    }
    case 'bspline': {
      const b = prepareBSpline(c, c.poles);
      if (typeof b === 'string') return [...c.poles];
      return sampleBSpline(b, 1e-3);
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

/** Why a value could not be measured (shown when no source or nominal gives one). */
export type Unmeasurable = { reason: string; hint?: string };

/** The point a linear or ordinate dimension measures a ref from. */
function measuringPoint(g: RefGeo, at: RefPoint): Vec3 | null {
  switch (g.t) {
    case 'plane':
      return g.origin;
    case 'line':
      if (at === 'start') return g.a;
      if (at === 'end') return g.b;
      return mid(g.a, g.b);
    case 'circle':
      if (at === 'start' && g.start) return g.start;
      if (at === 'end' && g.end) return g.end;
      return g.center;
    case 'axis':
      if (at === 'start') return add(g.origin, scale(g.dir, g.extent[0]));
      if (at === 'end') return add(g.origin, scale(g.dir, g.extent[1]));
      return add(g.origin, scale(g.dir, (g.extent[0] + g.extent[1]) / 2));
    case 'sphere':
      return g.center;
    case 'torus':
      return at === 'center' ? g.center : null;
    case 'point':
      return g.at;
    case 'other':
      return null;
  }
}

/** Extreme points are only defined for these (M4.1). */
const NO_EXTREME: Unmeasurable = {
  reason: 'Only a circle, a cylinder, a sphere or a straight edge has an extreme point',
  hint: 'Measure this reference itself, or pick a round or straight one.',
};

/** `v` without its component along unit `n`, normalised; null when `v` is along `n`. */
function across(v: Vec3, n: Vec3): Vec3 | null {
  const w = sub(v, scale(n, dot(v, n)));
  return norm(w) < 1e-9 ? null : normalize(w);
}

/**
 * The extreme point of a ref along `direction` (M4.1, ADR-095): `max` the farthest along it, `min`
 * the farthest against it. Exact, from the ref's own geometry:
 *  - a circle (an arc too: its circle) and a sphere: the tangent point, the centre plus the radius
 *    across;
 *  - a cylinder or cone face: the farther of its two rim circles' tangent points (the middle of the
 *    face's tangent line when both are as far, as for a cylinder across its axis);
 *  - a straight edge: its farther end (its middle when it is square to the direction);
 *  - a point: itself.
 * A circle seen along its axis is extreme everywhere: its centre. A plane, an axis without a
 * radius and any other surface or curve have no extreme point: unmeasurable, with the reason.
 */
export function extremePoint(g: RefGeo, at: 'min' | 'max', direction: Vec3): Vec3 | Unmeasurable {
  if (norm(direction) < 1e-12) return { reason: 'The dimension has no direction' };
  const d = scale(normalize(direction), at === 'max' ? 1 : -1);
  const farther = (p: Vec3, q: Vec3): Vec3 => {
    const s = dot(sub(q, p), d);
    const tol = 1e-9 * (1 + Math.abs(dot(p, d)) + Math.abs(dot(q, d)));
    return Math.abs(s) <= tol ? mid(p, q) : s > 0 ? q : p;
  };
  switch (g.t) {
    case 'point':
      return g.at;
    case 'line':
      return farther(g.a, g.b);
    case 'sphere':
      return add(g.center, scale(d, g.radius));
    case 'circle': {
      const u = across(d, g.normal);
      return u ? add(g.center, scale(u, g.radius)) : g.center;
    }
    case 'axis': {
      const r = g.ends ?? (g.radius !== undefined ? [g.radius, g.radius] : undefined);
      if (!r) return NO_EXTREME;
      const u = across(d, g.dir);
      const rim = (k: 0 | 1): Vec3 => {
        const c = add(g.origin, scale(g.dir, g.extent[k]));
        return u ? add(c, scale(u, r[k])) : c;
      };
      return farther(rim(0), rim(1));
    }
    case 'plane':
      return {
        reason: 'A flat face has no extreme point along the direction',
        hint: 'Measure the face itself, or pick one of its edges.',
      };
    case 'torus':
    case 'other':
      return NO_EXTREME;
  }
}

/** A ref as a point (vertices, centres, mid points; `self` lines and planes are not points). */
function asPoint(g: RefGeo, at: RefPoint): Vec3 | null {
  if (g.t === 'point' || g.t === 'sphere') return measuringPoint(g, at);
  if (g.t === 'circle') return at === 'self' || at === 'axis' ? g.center : measuringPoint(g, at);
  if (g.t === 'line' || g.t === 'axis')
    return at === 'self' || at === 'axis' ? null : measuringPoint(g, at);
  if (g.t === 'plane') return at === 'center' ? g.origin : null;
  if (g.t === 'torus') return at === 'center' ? g.center : null;
  return null;
}

/** A ref as a line (straight edges and axes; a circle's axis). */
function asLine(g: RefGeo, at: RefPoint): { o: Vec3; d: Vec3 } | null {
  if (at !== 'self' && at !== 'axis') return null;
  if (g.t === 'line') return { o: g.a, d: normalize(sub(g.b, g.a)) };
  if (g.t === 'axis') return { o: g.origin, d: g.dir };
  if (g.t === 'circle' && at === 'axis') return { o: g.center, d: g.normal };
  if (g.t === 'torus' && at === 'axis') return { o: g.center, d: g.axis };
  return null;
}

const PARALLEL = 1e-9;

/** Separation of two refs without a direction (parallel planes or lines, plane or line and point). */
function naturalSeparation(
  a: RefGeo,
  atA: RefPoint,
  b: RefGeo,
  atB: RefPoint,
): number | Unmeasurable {
  const pa = a.t === 'plane' && (atA === 'self' || atA === 'axis') ? a : null;
  const pb = b.t === 'plane' && (atB === 'self' || atB === 'axis') ? b : null;
  const notParallel: Unmeasurable = {
    reason: 'The two references are not parallel',
    hint: 'Choose a direction, or pick parallel faces or edges.',
  };
  if (pa && pb) {
    if (Math.abs(Math.abs(dot(pa.normal, pb.normal)) - 1) > PARALLEL) return notParallel;
    return Math.abs(dot(sub(pb.origin, pa.origin), pa.normal));
  }
  const plane = pa ?? pb;
  const [og, oat] = pa ? [b, atB] : [a, atA];
  if (plane) {
    const line = asLine(og, oat);
    if (line) {
      if (Math.abs(dot(line.d, plane.normal)) > PARALLEL) return notParallel;
      return Math.abs(dot(sub(line.o, plane.origin), plane.normal));
    }
    const p = asPoint(og, oat);
    if (p) return Math.abs(dot(sub(p, plane.origin), plane.normal));
    return notParallel;
  }
  const la = asLine(a, atA);
  const lb = asLine(b, atB);
  if (la && lb) {
    if (norm(cross(la.d, lb.d)) > 1e-9) return notParallel;
    return norm(cross(sub(lb.o, la.o), la.d));
  }
  const line = la ?? lb;
  const p = la ? asPoint(b, atB) : asPoint(a, atA);
  if (line && p) return norm(cross(sub(p, line.o), line.d));
  return {
    reason: 'A distance between two points needs a direction',
    hint: 'Choose a horizontal or vertical direction, or use an aligned dimension.',
  };
}

/**
 * A ref's direction for angles: a plane's normal (`plane`), a line's or an axis' direction. At
 * `axis` (M4.1) a plane is the line along its normal (the pull direction a draft is measured
 * from), and a circle or a torus is the line of its axis.
 */
function directionOf(g: RefGeo, at: RefPoint): { d: Vec3; plane: boolean } | null {
  if (g.t === 'plane') return { d: g.normal, plane: at !== 'axis' };
  if (g.t === 'line') return { d: normalize(sub(g.b, g.a)), plane: false };
  if (g.t === 'axis') return { d: g.dir, plane: false };
  if (g.t === 'circle' && at === 'axis') return { d: g.normal, plane: false };
  if (g.t === 'torus' && at === 'axis') return { d: g.axis, plane: false };
  return null;
}

/** Refs the kernel's exact angle measures as they are: straight edges, planes not at `axis`. */
const kernelAngle = (g: RefGeo, at: RefPoint): boolean =>
  g.t === 'line' || (g.t === 'plane' && at !== 'axis');

const clampUnit = (x: number) => Math.max(-1, Math.min(1, x));

/** The measurement `measured` for an annotation from its resolved refs' geometry. */
export async function measureAnnotation(
  core: EngineCore,
  a: Annotation,
  geos: RefGeo[],
  at: RefPoint[],
): Promise<number | Unmeasurable | undefined> {
  const atOf = (i: number): RefPoint => at[i] ?? 'self';
  const g0 = geos[0];
  const g1 = geos[1];
  const extreme = (p: RefPoint): p is 'min' | 'max' => p === 'min' || p === 'max';
  const linear = a.kind === 'linear' || a.kind === 'ordinate';
  if (geos.some((_, i) => extreme(atOf(i))) && !(linear && a.direction)) {
    // The document rule (annotation-rules.ts) flags it too; never measured some other way.
    return {
      reason: 'An extreme point (min or max) needs a linear or ordinate dimension with a direction',
      hint: 'Choose a horizontal or vertical direction.',
    };
  }
  switch (a.kind) {
    case 'linear':
    case 'ordinate': {
      if (!g0 || !g1) return { reason: 'A dimension needs two references' };
      if (a.direction) {
        const d = normalize(a.direction);
        const point = (g: RefGeo, p: RefPoint): Vec3 | Unmeasurable =>
          extreme(p) ? extremePoint(g, p, d) : (measuringPoint(g, p) ?? centroidOf(g));
        const pa = point(g0, atOf(0));
        if (!isPoint(pa)) return pa;
        const pb = point(g1, atOf(1));
        if (!isPoint(pb)) return pb;
        return Math.abs(dot(sub(pb, pa), d));
      }
      return naturalSeparation(g0, atOf(0), g1, atOf(1));
    }
    case 'aligned': {
      if (!g0 || !g1) return { reason: 'A dimension needs two references' };
      const pa = asPoint(g0, atOf(0));
      const pb = asPoint(g1, atOf(1));
      if (pa && pb) return dist(pa, pb);
      if (g0.target && g1.target) {
        const m = await core.kernel.measureShapes(g0.target, g1.target);
        if (m.ok && m.value.distance) return m.value.distance.value;
      }
      return { reason: 'The distance between these references could not be measured' };
    }
    case 'radius':
    case 'diameter': {
      if (!g0) return { reason: 'A dimension needs a reference' };
      const r =
        g0.t === 'circle' || g0.t === 'sphere'
          ? g0.radius
          : g0.t === 'axis'
            ? g0.radius
            : g0.t === 'torus'
              ? g0.minor
              : undefined;
      if (r === undefined) {
        return {
          reason: 'This reference is not round',
          hint: 'Pick a circular edge, or a cylindrical, spherical or toroidal face.',
        };
      }
      return a.kind === 'diameter' ? 2 * r : r;
    }
    case 'angle': {
      if (!g0 || !g1) return { reason: 'An angle needs two references' };
      const angle = await angleBetween(core, g0, atOf(0), g1, atOf(1));
      if (angle === null) {
        return {
          reason: 'An angle is measured between straight edges, flat faces or axes',
          hint: 'Pick two straight edges, flat faces or axes.',
        };
      }
      return a.measure === 'supplement' ? Math.PI - angle : angle;
    }
    default:
      return undefined;
  }
}

function centroidOf(g: RefGeo): Vec3 {
  switch (g.t) {
    case 'plane':
      return g.origin;
    case 'line':
      return mid(g.a, g.b);
    case 'circle':
    case 'sphere':
      return g.center;
    case 'axis':
      return add(g.origin, scale(g.dir, (g.extent[0] + g.extent[1]) / 2));
    case 'point':
      return g.at;
    case 'torus':
    case 'other':
      return g.centroid;
  }
}

/**
 * Angle between two refs ([0, π]). Two planes: between their outward normals, from the exact
 * fingerprint directions already at hand (the kernel's face–face angle is the same since the M4
 * `planeOf` fix, at the price of a call). Pairs of a straight edge and a straight edge or a plane:
 * the kernel's exact angle where it gives one. A plane at `axis` is the line along its normal
 * (M4.1) and never goes to the kernel (which would measure the face): a draft angle, refs
 * [drafted face, neutral face] at ['self', 'axis'], is the angle between the drafted face and the
 * pull direction.
 */
async function angleBetween(
  core: EngineCore,
  a: RefGeo,
  atA: RefPoint,
  b: RefGeo,
  atB: RefPoint,
): Promise<number | null> {
  const da = directionOf(a, atA);
  const db = directionOf(b, atB);
  if (!da || !db) return null;
  const exact = kernelAngle(a, atA) && kernelAngle(b, atB) && !(da.plane && db.plane);
  if (exact && a.target && b.target) {
    const m = await core.kernel.measureShapes(a.target, b.target);
    if (m.ok && m.value.angle !== undefined && Number.isFinite(m.value.angle)) return m.value.angle;
  }
  const c = dot(da.d, db.d);
  if (da.plane && db.plane) return Math.acos(clampUnit(c));
  if (da.plane !== db.plane) return Math.asin(clampUnit(Math.abs(c)));
  return Math.acos(clampUnit(Math.abs(c)));
}
