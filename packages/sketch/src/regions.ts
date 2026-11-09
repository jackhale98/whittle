/**
 * Sketch regions (M3.5): the bounded faces of the planar arrangement of every non-construction
 * curve, as the kernel builds them (DECISIONS "Sketch regions in TS"; the kernel's General Fuse +
 * BOPAlgo_BuilderFace is the source of truth for profiles). For previews, region picking and
 * checks before the kernel answers. Pure, no Wasm.
 *
 *  1. Curves are split where they cross or touch each other (sampled crossings refined by Newton
 *     on the exact curves; end points lying on another curve), within a fuzzy tolerance of
 *     1e-6 × the sketch size (the kernel's fuzzy value), which also merges nearby end points.
 *  2. Dangling pieces are removed; faces are traced on the planar graph (half-edges ordered by
 *     their leaving direction). Bounded faces run counter-clockwise.
 *  3. Areas are exact per piece by Green's theorem: closed forms for lines, arcs and circles,
 *     Gauss–Legendre per knot span for splines, per eighth of a turn for ellipses.
 *  4. A loop nested inside a face is its hole (and a region of its own), like the kernel.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { gauss8, splineAreaIntegral } from './bspline';
import { curveIntersections } from './edit/curve-ops';
import {
  closestParam,
  indexEntities,
  type ParamCurve,
  paramCurve,
  splineGeom,
  TAU,
} from './geometry';

/** A piece of a curve, traversed from parameter `from` to `to` (to < from: backwards). */
export interface RegionEdge {
  entity: Id;
  from: number;
  to: number;
}

export interface RegionLoop {
  edges: RegionEdge[];
  /** Signed area, mm² (counter-clockwise positive). */
  area: number;
}

export interface SketchRegion {
  /** The outer boundary, counter-clockwise. */
  outer: RegionLoop;
  /** Loops nested inside it, clockwise. */
  holes: RegionLoop[];
  /** Outer area minus the holes, mm². */
  area: number;
}

export interface RegionOptions {
  /** Merge / touch tolerance, mm (default 1e-6 × the sketch size, as the kernel's fuzzy value). */
  tolerance?: number;
}

interface Curve {
  id: Id;
  e: SketchEntity;
  c: ParamCurve;
  samples: number;
  period: number;
}

interface Piece {
  curve: Curve;
  from: number;
  to: number;
  a: number;
  b: number;
}

interface Half {
  piece: Piece;
  /** Forward along the curve's parameter. */
  fwd: boolean;
  origin: number;
  angle: number;
  twin: Half | null;
  next: Half | null;
  used: boolean;
}

const samplesOf = (e: SketchEntity): number =>
  e.kind === 'line' ? 1 : e.kind === 'bspline' ? Math.max(64, 24 * e.poles.length) : 128;

/** ½ ∫ (x y′ − y x′) along a piece of a curve (Green's theorem). */
function pieceArea(curve: CurveWithIndex, from: number, to: number): number {
  const e = curve.e;
  const c = curve.c;
  if (e.kind === 'line') {
    const p = c.at(from);
    const q = c.at(to);
    return (p[0] * q[1] - p[1] * q[0]) / 2;
  }
  if (e.kind === 'circle' || e.kind === 'arc') {
    const ctr = c.at(0);
    const r = Math.hypot(c.d1(0)[0], c.d1(0)[1]);
    const cx = ctr[0] - r;
    const cy = ctr[1];
    return (
      (r * cx * (Math.sin(to) - Math.sin(from)) -
        r * cy * (Math.cos(to) - Math.cos(from)) +
        r * r * (to - from)) /
      2
    );
  }
  if (e.kind === 'bspline') return splineAreaIntegral(splineGeom(curve.index, e), from, to);
  // Ellipses: smooth, 8-point Gauss–Legendre per eighth of a turn.
  const f = (t: number) => {
    const p = c.at(t);
    const d = c.d1(t);
    return 0.5 * (p[0] * d[1] - p[1] * d[0]);
  };
  const steps = Math.max(1, Math.ceil((Math.abs(to - from) / TAU) * 8));
  let s = 0;
  for (let i = 0; i < steps; i++)
    s += gauss8(f, from + ((to - from) * i) / steps, from + ((to - from) * (i + 1)) / steps);
  return s;
}

interface CurveWithIndex extends Curve {
  index: ReadonlyMap<Id, SketchEntity>;
}

/** The bounded regions of a sketch's non-construction curves. */
export function sketchRegions(
  entities: readonly SketchEntity[],
  options: RegionOptions = {},
): SketchRegion[] {
  const index = indexEntities(entities);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const e of entities) {
    if (e.kind !== 'point') continue;
    minX = Math.min(minX, e.x);
    maxX = Math.max(maxX, e.x);
    minY = Math.min(minY, e.y);
    maxY = Math.max(maxY, e.y);
  }
  const size = Number.isFinite(minX) ? Math.max(1, maxX - minX, maxY - minY) : 1;
  const tol = options.tolerance ?? 1e-6 * size;

  const curves: CurveWithIndex[] = [];
  for (const e of entities) {
    if (e.kind === 'point' || e.construction) continue;
    const c = paramCurve(index, e);
    if (!c) continue;
    curves.push({ id: e.id, e, c, samples: samplesOf(e), period: c.t1 - c.t0, index });
  }

  // 1. Cut parameters per curve.
  const cuts: number[][] = curves.map((k) => (k.c.closed ? [] : [k.c.t0, k.c.t1]));
  const addCut = (i: number, t: number) => {
    const k = curves[i] as CurveWithIndex;
    const list = cuts[i] as number[];
    let tt = t;
    if (k.c.closed) {
      tt = k.c.t0 + ((((t - k.c.t0) % k.period) + k.period) % k.period);
    } else tt = Math.min(k.c.t1, Math.max(k.c.t0, t));
    const p = k.c.at(tt);
    if (list.some((u) => dist2(k.c.at(u), p) <= tol * tol)) return;
    list.push(tt);
  };
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const a = curves[i] as CurveWithIndex;
      const b = curves[j] as CurveWithIndex;
      for (const x of curveIntersections(a.c, a.samples, b.c, b.samples, tol)) {
        addCut(i, x.ta);
        addCut(j, x.tb);
      }
    }
  }
  // End points lying on other curves (T-junctions the sampled crossings can miss).
  for (let i = 0; i < curves.length; i++) {
    const a = curves[i] as CurveWithIndex;
    if (a.c.closed) continue;
    for (const t of [a.c.t0, a.c.t1]) {
      const p = a.c.at(t);
      for (let j = 0; j < curves.length; j++) {
        if (j === i) continue;
        const b = curves[j] as CurveWithIndex;
        const u = closestParam(b.c, p, b.samples);
        if (dist2(b.c.at(u), p) <= tol * tol) addCut(j, u);
      }
    }
  }

  // 2. Vertices (merged within tol) and pieces.
  const verts: Vec2[] = [];
  const vertexOf = (p: Vec2): number => {
    for (let v = 0; v < verts.length; v++)
      if (dist2(verts[v] as Vec2, p) <= 4 * tol * tol) return v;
    verts.push(p);
    return verts.length - 1;
  };
  const pieces: Piece[] = [];
  curves.forEach((k, i) => {
    const ts = [...(cuts[i] as number[])].sort((x, y) => x - y);
    if (k.c.closed) {
      if (ts.length === 0) ts.push(k.c.t0);
      for (let s = 0; s < ts.length; s++) {
        const from = ts[s] as number;
        const to = s + 1 < ts.length ? (ts[s + 1] as number) : (ts[0] as number) + k.period;
        pieces.push({ curve: k, from, to, a: vertexOf(k.c.at(from)), b: vertexOf(k.c.at(to)) });
      }
    } else {
      for (let s = 0; s + 1 < ts.length; s++) {
        const from = ts[s] as number;
        const to = ts[s + 1] as number;
        if (to - from <= 0) continue;
        pieces.push({ curve: k, from, to, a: vertexOf(k.c.at(from)), b: vertexOf(k.c.at(to)) });
      }
    }
  });

  // Dangling pieces bound nothing.
  let live = pieces.filter((p) => p.a !== p.b || p.curve.c.closed || p.to - p.from > 0);
  for (let guard = 0; guard < pieces.length + 1; guard++) {
    const degree = new Map<number, number>();
    for (const p of live) {
      degree.set(p.a, (degree.get(p.a) ?? 0) + 1);
      degree.set(p.b, (degree.get(p.b) ?? 0) + 1);
    }
    const next = live.filter((p) => (degree.get(p.a) ?? 0) > 1 && (degree.get(p.b) ?? 0) > 1);
    if (next.length === live.length) break;
    live = next;
  }

  // 3. Half-edges ordered around their origin by the direction they leave it.
  const halves: Half[] = [];
  const around = new Map<number, Half[]>();
  const leave = (p: Piece, fwd: boolean): number => {
    const t = fwd ? p.from : p.to;
    const h = (p.to - p.from) * 1e-4;
    const q0 = p.curve.c.at(t);
    const q1 = p.curve.c.at(fwd ? t + h : t - h);
    return Math.atan2(q1[1] - q0[1], q1[0] - q0[0]);
  };
  for (const p of live) {
    const f: Half = {
      piece: p,
      fwd: true,
      origin: p.a,
      angle: leave(p, true),
      twin: null,
      next: null,
      used: false,
    };
    const r: Half = {
      piece: p,
      fwd: false,
      origin: p.b,
      angle: leave(p, false),
      twin: f,
      next: null,
      used: false,
    };
    f.twin = r;
    halves.push(f, r);
    for (const h of [f, r]) {
      const l = around.get(h.origin);
      if (l) l.push(h);
      else around.set(h.origin, [h]);
    }
  }
  for (const l of around.values()) l.sort((x, y) => x.angle - y.angle);
  for (const h of halves) {
    // next(h): at h's end, the half-edge just clockwise of h's twin (keeps the face on the left).
    const twin = h.twin as Half;
    const l = around.get(twin.origin) as Half[];
    const i = l.indexOf(twin);
    h.next = l[(i - 1 + l.length) % l.length] as Half;
  }

  // 4. Faces.
  const loops: { edges: RegionEdge[]; area: number; halves: Half[] }[] = [];
  for (const h0 of halves) {
    if (h0.used) continue;
    const cyc: Half[] = [];
    let h: Half | null = h0;
    for (let guard = 0; h && !h.used && guard <= halves.length; guard++) {
      h.used = true;
      cyc.push(h);
      h = h.next;
    }
    const edges = cyc.map((x) => ({
      entity: x.piece.curve.id,
      from: x.fwd ? x.piece.from : x.piece.to,
      to: x.fwd ? x.piece.to : x.piece.from,
    }));
    let area = 0;
    for (const x of cyc) {
      const a = pieceArea(x.piece.curve as CurveWithIndex, x.piece.from, x.piece.to);
      area += x.fwd ? a : -a;
    }
    loops.push({ edges, area, halves: cyc });
  }
  const faceEps = tol * size;
  const outers = loops.filter((l) => l.area > faceEps);
  const inners = loops.filter((l) => l.area < -faceEps);
  const polys = new Map(outers.map((l) => [l, loopPolygon(index, l)]));
  // The connected component of each loop (by vertices), so a component's own outer boundary
  // isn't a hole of its own faces.
  const comp = components(live);
  const compOf = (l: { halves: Half[] }) => comp.get((l.halves[0] as Half).origin);

  const regions: SketchRegion[] = outers.map((l) => ({
    outer: { edges: l.edges, area: l.area },
    holes: [],
    area: l.area,
  }));
  for (const hole of inners) {
    const probe = verts[(hole.halves[0] as Half).origin] as Vec2;
    let best = -1;
    let bestArea = Number.POSITIVE_INFINITY;
    outers.forEach((o, i) => {
      if (compOf(o) === compOf(hole)) return;
      if (o.area < bestArea && inside(probe, polys.get(o) as Vec2[])) {
        best = i;
        bestArea = o.area;
      }
    });
    if (best < 0) continue; // the unbounded outside of a component
    const r = regions[best] as SketchRegion;
    r.holes.push({ edges: hole.edges, area: hole.area });
    r.area += hole.area;
  }
  return regions;
}

/** A loop's outline as a polyline (for display and containment tests). */
export function loopPolygon(
  index: ReadonlyMap<Id, SketchEntity>,
  loop: { edges: readonly RegionEdge[] },
  segments = 32,
): Vec2[] {
  const out: Vec2[] = [];
  for (const e of loop.edges) {
    const ent = index.get(e.entity);
    const c = ent ? paramCurve(index, ent) : null;
    if (!c) continue;
    const n = ent?.kind === 'line' ? 1 : segments;
    for (let i = 0; i < n; i++) out.push(c.at(e.from + ((e.to - e.from) * i) / n));
  }
  return out;
}

function inside(p: Vec2, poly: readonly Vec2[]): boolean {
  let wn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      wn = !wn;
  }
  return wn;
}

function components(pieces: readonly Piece[]): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
    parent.set(v, r);
    return r;
  };
  for (const p of pieces) {
    if (!parent.has(p.a)) parent.set(p.a, p.a);
    if (!parent.has(p.b)) parent.set(p.b, p.b);
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const out = new Map<number, number>();
  for (const v of parent.keys()) out.set(v, find(v));
  return out;
}

const dist2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
