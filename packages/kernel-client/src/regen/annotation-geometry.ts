/**
 * Geometry of resolved annotation references (M4, ADR-090): what each resolved ref is (a plane, a
 * line, a circle, an axis, a point…), the `AnnotationAnchor` a drawing view projects, and the value
 * an annotation measures from its refs (`AnnotationResolution.measured`).
 *
 * Everything is read from the façade's exact data: fingerprints (planar face centroids and normals,
 * vertex points), exact measurements (`measureShapes`: radii, distances, angles) and the memoised
 * probes of datums.ts for line end points, circle centres and cylinder axes. Every probe is
 * memoised per shape handle (`EngineCore.memo`), so a body that did not change costs only lookups.
 * Curves other than lines and circles are anchored by the body's coarse mesh polyline.
 *
 * Conventions (part mm and radians):
 *  - linear with `direction`: the distance between the two refs' measuring points projected on it
 *    (a plane's centroid, a line's mid point, an axis' origin, a circle's or sphere's centre);
 *  - linear without one: the separation of parallel planes or lines, or of a plane (or a line) and
 *    a point; anything else is not measurable without a direction;
 *  - aligned: point to point, else the exact minimum distance between the two sub-shapes;
 *  - ordinate: |coordinate of refs[1] − refs[0]| along `direction`;
 *  - radius / diameter: of a circular edge, a cylindrical face or a sphere;
 *  - angle: the kernel's exact angle for planar faces and straight edges (face–face between outward
 *    normals, edges sharing a vertex the corner angle, other pairs between the lines), else the
 *    same conventions from the directions; `supplement` is π minus it.
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
import type { ExactProjectedCurve, ProjectedLoopEdge } from '../kernel-api';
import type { EngineCore } from './core';
import { ellipsePoint, prepareBSpline, sampleBSpline } from './curves';
import { sphereCentre } from './datums';
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
  | {
      t: 'axis';
      origin: Vec3;
      dir: Vec3;
      extent: [number, number];
      radius?: number;
      target?: SubTarget;
    }
  | { t: 'sphere'; center: Vec3; radius: number; target: SubTarget }
  | { t: 'point'; at: Vec3; target?: SubTarget }
  /** Another face or edge: its centroid, and a polyline for edges. */
  | { t: 'other'; centroid: Vec3; points?: Vec3[]; target?: SubTarget };

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
    if (f.normal) {
      const normal = await outwardNormal(core, t, normalize(f.normal));
      return { t: 'plane', origin: f.centroid, normal, target: t };
    }
    if (f.surface === 'cylinder') {
      const a = await core.axisOfFace(t);
      if (a) {
        const extent = await core.memo(t.shape, `extent:${t.index}`, () =>
          axisExtent(core, t, a.origin, a.dir, Math.sqrt(Math.max(f.area, 0)) + a.radius),
        );
        return { t: 'axis', origin: a.origin, dir: a.dir, extent, radius: a.radius, target: t };
      }
    }
    if (f.surface === 'sphere') {
      const c = await core.memo(t.shape, `sphere:${t.index}`, () =>
        sphereCentre(core.geo(), t.shape, t.index),
      );
      const r = c ? await radiusOf(core, t) : undefined;
      if (c && r !== undefined) return { t: 'sphere', center: c, radius: r, target: t };
    }
    return { t: 'other', centroid: f.centroid, target: t };
  }
  const e = fp.edges[t.index];
  if (!e) return null;
  if (e.curve === 'line') {
    const l = await core.lineOfEdge(t);
    if (l) return { t: 'line', a: l.a, b: l.b, target: t };
  }
  if (e.curve === 'circle') {
    const c = await core.circleOfEdge(t);
    if (c) {
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
  }
  const points = await edgePolyline(core, t);
  return points
    ? { t: 'other', centroid: e.centroid, points, target: t }
    : { t: 'other', centroid: e.centroid, target: t };
}

/**
 * A planar face's outward normal. The fingerprint's normal is exact but, in the current kernel
 * build, reversed on faces whose plane has a left-handed (indirect) frame, such as chamfer faces
 * (`planeOf` in whittle_modeling.cpp reverses for `TopAbs_REVERSED` faces only; reported as a
 * façade gap). The render mesh's vertex normals follow the face orientation, so their sign
 * decides; the exact fingerprint direction is kept. Faces of sketches and planes have no
 * material side and keep the fingerprint's. Memoised per handle; the mesh is the regen's own.
 */
async function outwardNormal(core: EngineCore, t: SubTarget, n: Vec3): Promise<Vec3> {
  return core.memo(t.shape, `outward:${t.index}`, async () => {
    const m = core.cachedMesh(t.shape) ?? (await core.meshOf(t.shape, 'coarse'));
    const first = m?.faceRanges[2 * t.index];
    const count = m?.faceRanges[2 * t.index + 1];
    if (!m || first === undefined || !count) return n;
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const v = m.indices[3 * first + k] as number;
      s +=
        (m.normals[3 * v] as number) * n[0] +
        (m.normals[3 * v + 1] as number) * n[1] +
        (m.normals[3 * v + 2] as number) * n[2];
    }
    return s < 0 ? scale(n, -1) : n;
  });
}

/** Exact radius of a circular edge, cylindrical or spherical face (memoised). */
async function radiusOf(core: EngineCore, t: SubTarget): Promise<number | undefined> {
  return core.memo(t.shape, `radius:${t.kind}:${t.index}`, async () => {
    const m = await core.kernel.measureShapes(t);
    const r = m.ok ? m.value.radius : undefined;
    return r !== undefined && r > 0 ? r : undefined;
  });
}

/**
 * Where a cylindrical face runs along its axis: parameters (along `dir`, from `origin`) of the
 * face's closest points to two far points on the axis, one each way (exact, two measurements).
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
    const loop: Vec2[] = [];
    for (const curves of edges) {
      let pts: Vec2[] = [];
      for (const c of curves) pts.push(...samplePlaneCurve(c));
      if (pts.length === 0) continue;
      const last = loop[loop.length - 1];
      if (last && d2(last, pts[0] as Vec2) > d2(last, pts[pts.length - 1] as Vec2)) {
        pts = pts.reverse();
      }
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
    case 'point':
      return g.at;
    case 'other':
      return null;
  }
}

/** A ref as a point (vertices, centres, mid points; `self` lines and planes are not points). */
function asPoint(g: RefGeo, at: RefPoint): Vec3 | null {
  if (g.t === 'point' || g.t === 'sphere') return measuringPoint(g, at);
  if (g.t === 'circle') return at === 'self' || at === 'axis' ? g.center : measuringPoint(g, at);
  if (g.t === 'line' || g.t === 'axis')
    return at === 'self' || at === 'axis' ? null : measuringPoint(g, at);
  if (g.t === 'plane') return at === 'center' ? g.origin : null;
  return null;
}

/** A ref as a line (straight edges and axes; a circle's axis). */
function asLine(g: RefGeo, at: RefPoint): { o: Vec3; d: Vec3 } | null {
  if (at !== 'self' && at !== 'axis') return null;
  if (g.t === 'line') return { o: g.a, d: normalize(sub(g.b, g.a)) };
  if (g.t === 'axis') return { o: g.origin, d: g.dir };
  if (g.t === 'circle' && at === 'axis') return { o: g.center, d: g.normal };
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

/** A ref's direction for angles: a plane's normal, a line's or an axis' direction. */
function directionOf(g: RefGeo): { d: Vec3; plane: boolean } | null {
  if (g.t === 'plane') return { d: g.normal, plane: true };
  if (g.t === 'line') return { d: normalize(sub(g.b, g.a)), plane: false };
  if (g.t === 'axis') return { d: g.dir, plane: false };
  return null;
}

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
  switch (a.kind) {
    case 'linear':
    case 'ordinate': {
      if (!g0 || !g1) return { reason: 'A dimension needs two references' };
      if (a.direction) {
        const d = normalize(a.direction);
        const pa = measuringPoint(g0, atOf(0)) ?? centroidOf(g0);
        const pb = measuringPoint(g1, atOf(1)) ?? centroidOf(g1);
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
            : undefined;
      if (r === undefined) {
        return {
          reason: 'This reference is not round',
          hint: 'Pick a circular edge, a cylindrical face or a sphere.',
        };
      }
      return a.kind === 'diameter' ? 2 * r : r;
    }
    case 'angle': {
      if (!g0 || !g1) return { reason: 'An angle needs two references' };
      const angle = await angleBetween(core, g0, g1);
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
    case 'other':
      return g.centroid;
  }
}

/**
 * Angle between two refs ([0, π]). Two planes: between their outward normals (exact fingerprint
 * directions, `outwardNormal`; the kernel's face–face angle reads the normal that is reversed on
 * left-handed planes). Pairs with a straight edge: the kernel's exact angle where it gives one.
 */
async function angleBetween(core: EngineCore, a: RefGeo, b: RefGeo): Promise<number | null> {
  const da = directionOf(a);
  const db = directionOf(b);
  if (!da || !db) return null;
  if (a.target && b.target && a.t !== 'axis' && b.t !== 'axis' && !(da.plane && db.plane)) {
    const m = await core.kernel.measureShapes(a.target, b.target);
    if (m.ok && m.value.angle !== undefined && Number.isFinite(m.value.angle)) return m.value.angle;
  }
  const c = dot(da.d, db.d);
  if (da.plane && db.plane) return Math.acos(clampUnit(c));
  if (da.plane !== db.plane) return Math.asin(clampUnit(Math.abs(c)));
  return Math.acos(clampUnit(Math.abs(c)));
}
