/**
 * PLACEHOLDER drawing kernel, part 2: approximate projection (ADR-092). NOT HLR.
 *
 * Implements `DrawingKernelApi` (contracts drawing.ts) so the drawing UI, its tests and the E2E
 * run before the real HLR worker exists. It projects the regen meshes' B-rep edge polylines and
 * the silhouettes of curved faces, and decides visibility with a software depth buffer of the
 * projected triangles. Results are approximate in these known ways:
 *
 * - visibility is decided per sample on a 1 px grid, so hidden/visible changes are ±1 px off;
 * - silhouettes come from the tessellation (the facet nearest the tangent line), not the surface;
 * - a section keeps the half space on the far side of the cut (stepped cuts pick the nearest
 *   segment's plane per triangle) and caps it by the cut loops; it does not mend the mesh;
 * - circles seen face-on are fitted and returned as arcs; every other curve is a polyline;
 * - `quality: 'exact'` is the same computation as `'draft'`.
 *
 * The real worker replaces this file's role; nothing outside `source.ts` depends on how the
 * numbers are made.
 */

import type {
  Curve2,
  DrawingKernelApi,
  EdgeClass,
  KernelError,
  ProjectedCurve,
  ShapeForDrawing,
  Vec2,
  Vec3,
  ViewProjection,
  ViewProjectionRequest,
} from '@wren-cad/contracts';
import { decodePlaceholderShape, type PlaceholderBody } from './shape';

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

interface Loaded {
  bodies: PlaceholderBody[];
  bounds: { min: V3; max: V3 };
  /** Edge polylines (3D), all bodies, in `edgeNames` order. */
  edges: V3[][];
  /** Triangles (3 vertices each) with a unit normal. */
  tris: { a: V3; b: V3; c: V3; n: V3 }[];
  /** Vertex (quantised) → incident triangle indices, for dihedral angles. */
  incident: Map<string, number[]>;
  /** Silhouette candidates: interior mesh edges (two triangles of one face). */
  interior: { a: V3; b: V3; t1: number; t2: number }[];
}

const q = (p: V3): string =>
  `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;

function build(bodies: PlaceholderBody[]): Loaded {
  const edges: V3[][] = [];
  const tris: Loaded['tris'] = [];
  const incident = new Map<string, number[]>();
  const interior: Loaded['interior'] = [];
  const min: V3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: V3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const b of bodies) {
    const P = b.positions;
    const pt = (i: number): V3 => [
      P[3 * i] as number,
      P[3 * i + 1] as number,
      P[3 * i + 2] as number,
    ];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, P[i + k] as number);
        max[k] = Math.max(max[k] as number, P[i + k] as number);
      }
    }
    const shared = new Map<string, number[]>();
    for (let i = 0; i + 2 < b.indices.length; i += 3) {
      const ia = b.indices[i] as number;
      const ib = b.indices[i + 1] as number;
      const ic = b.indices[i + 2] as number;
      const a = pt(ia);
      const bb = pt(ib);
      const c = pt(ic);
      const n = unit(cross(sub(bb, a), sub(c, a)));
      const ti = tris.length;
      tris.push({ a, b: bb, c, n });
      for (const v of [a, bb, c]) {
        const k = q(v);
        const l = incident.get(k);
        if (l) l.push(ti);
        else incident.set(k, [ti]);
      }
      for (const [u, w] of [
        [ia, ib],
        [ib, ic],
        [ic, ia],
      ] as const) {
        const key = u < w ? `${u}:${w}` : `${w}:${u}`;
        const l = shared.get(key);
        if (l) l.push(ti);
        else shared.set(key, [ti]);
      }
    }
    for (const [key, l] of shared) {
      if (l.length !== 2) continue;
      const [u, w] = key.split(':').map(Number) as [number, number];
      interior.push({ a: pt(u), b: pt(w), t1: l[0] as number, t2: l[1] as number });
    }
    const E = b.edgePositions;
    for (let r = 0; r + 1 < b.edgeRanges.length; r += 2) {
      const first = b.edgeRanges[r] as number;
      const count = b.edgeRanges[r + 1] as number;
      const line: V3[] = [];
      for (let i = 0; i < count; i++) {
        const o = 3 * (first + i);
        line.push([E[o] as number, E[o + 1] as number, E[o + 2] as number]);
      }
      edges.push(line);
    }
  }
  if (!Number.isFinite(min[0])) {
    min.fill(0);
    max.fill(0);
  }
  return { bodies, bounds: { min, max }, edges, tris, incident, interior };
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

interface CutPlane {
  /** A point on the plane and the unit normal pointing into the kept side. */
  c: V3;
  m: V3;
}

function cutPlanes(section: NonNullable<ViewProjectionRequest['section']>): {
  planes: CutPlane[];
  at: (p: V3) => number;
} {
  const along = unit(section.along);
  const look = unit(section.look);
  const planes: CutPlane[] = [];
  const cut = section.cut;
  for (let i = 0; i + 1 < cut.length; i++) {
    const a = cut[i] as V3;
    const b = cut[i + 1] as V3;
    let m = unit(cross(along, sub(b, a)));
    // Keep the far side: the normal points the way the viewer looks.
    if (dot(m, look) < 0) m = [-m[0], -m[1], -m[2]];
    planes.push({ c: a, m });
  }
  /** The plane nearest a point, measured in the parent's plane (the sweep direction removed). */
  const at = (p: V3): number => {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    const pp = sub(p, [
      along[0] * dot(p, along),
      along[1] * dot(p, along),
      along[2] * dot(p, along),
    ]);
    for (let i = 0; i + 1 < cut.length; i++) {
      const a = cut[i] as V3;
      const b = cut[i + 1] as V3;
      const ab = sub(b, a);
      const l2 = dot(ab, ab) || 1;
      const t = Math.max(0, Math.min(1, dot(sub(pp, a), ab) / l2));
      const d = len(sub(pp, lerp3(a, b, t)));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  return { planes, at };
}

const dist = (pl: CutPlane, p: V3): number => dot(sub(p, pl.c), pl.m);

/** Clips a triangle to the kept side of a plane: 0, 1 or 2 triangles. */
function clipTriangle(t: [V3, V3, V3], pl: CutPlane): [V3, V3, V3][] {
  const d = t.map((p) => dist(pl, p)) as [number, number, number];
  const poly: V3[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const a = t[i] as V3;
    const b = t[j] as V3;
    const da = d[i] as number;
    const db = d[j] as number;
    if (da >= 0) poly.push(a);
    if (da >= 0 !== db >= 0) poly.push(lerp3(a, b, da / (da - db)));
  }
  const out: [V3, V3, V3][] = [];
  for (let i = 1; i + 1 < poly.length; i++)
    out.push([poly[0] as V3, poly[i] as V3, poly[i + 1] as V3]);
  return out;
}

/** The part of a polyline on the kept side, as runs. */
function clipPolyline(points: V3[], pl: CutPlane): V3[][] {
  const runs: V3[][] = [];
  let cur: V3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as V3;
    const dp = dist(pl, p);
    if (i > 0) {
      const a = points[i - 1] as V3;
      const da = dist(pl, a);
      if (da >= 0 !== dp >= 0) {
        const x = lerp3(a, p, da / (da - dp));
        if (da >= 0) {
          cur.push(x);
          runs.push(cur);
          cur = [];
        } else cur = [x];
      }
    }
    if (dp >= 0) cur.push(p);
  }
  if (cur.length > 1) runs.push(cur);
  return runs.filter((r) => r.length > 1);
}

/** Chains segments into polylines through shared end points. */
function chain(segments: [V3, V3][]): V3[][] {
  const key = (p: V3) =>
    `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)},${Math.round(p[2] * 500)}`;
  const ends = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      const l = ends.get(k);
      if (l) l.push(i);
      else ends.set(k, [i]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const out: V3[][] = [];
  const next = (p: V3): number => (ends.get(key(p)) ?? []).find((i) => !used[i]) ?? -1;
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const [a, b] = segments[i] as [V3, V3];
    const line: V3[] = [a, b];
    for (const dir of [1, -1]) {
      for (;;) {
        const tip = dir === 1 ? (line[line.length - 1] as V3) : (line[0] as V3);
        const j = next(tip);
        if (j < 0) break;
        used[j] = true;
        const [c, d] = segments[j] as [V3, V3];
        const other = key(c) === key(tip) ? d : c;
        if (dir === 1) line.push(other);
        else line.unshift(other);
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Depth buffer
// ---------------------------------------------------------------------------------------------

interface ZBuf {
  w: number;
  h: number;
  minU: number;
  minV: number;
  s: number;
  z: Float32Array;
  eps: number;
}

function makeZBuf(bounds: { min: Vec2; max: Vec2 }, diag: number): ZBuf {
  const du = Math.max(bounds.max[0] - bounds.min[0], 1e-6);
  const dv = Math.max(bounds.max[1] - bounds.min[1], 1e-6);
  const s = 700 / Math.max(du, dv);
  const w = Math.min(1100, Math.ceil(du * s) + 3);
  const h = Math.min(1100, Math.ceil(dv * s) + 3);
  return {
    w,
    h,
    minU: bounds.min[0] - 1 / s,
    minV: bounds.min[1] - 1 / s,
    s,
    z: new Float32Array(w * h).fill(Number.NEGATIVE_INFINITY),
    eps: Math.max(diag * 0.004, 0.05),
  };
}

function raster(zb: ZBuf, a: V3, b: V3, c: V3): void {
  // Each vertex is (u, v, depth).
  const px = (p: V3): V3 => [(p[0] - zb.minU) * zb.s, (p[1] - zb.minV) * zb.s, p[2]];
  const A = px(a);
  const B = px(b);
  const C = px(c);
  const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  if (Math.abs(den) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
  const x1 = Math.min(zb.w - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
  const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
  const y1 = Math.min(zb.h - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
  const e = -0.02;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const X = x + 0.5;
      const Y = y + 0.5;
      const l1 = ((B[1] - C[1]) * (X - C[0]) + (C[0] - B[0]) * (Y - C[1])) / den;
      const l2 = ((C[1] - A[1]) * (X - C[0]) + (A[0] - C[0]) * (Y - C[1])) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < e || l2 < e || l3 < e) continue;
      const d = l1 * A[2] + l2 * B[2] + l3 * C[2];
      const i = y * zb.w + x;
      if (d > (zb.z[i] as number)) zb.z[i] = d;
    }
  }
}

/** Even-odd fill of closed (u, v) loops at a constant depth (the cut faces' caps). */
function fillLoops(zb: ZBuf, loops: Vec2[][], depth: number): void {
  for (let y = 0; y < zb.h; y++) {
    const Y = y + 0.5;
    const xs: number[] = [];
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i] as Vec2;
        const b = loop[(i + 1) % loop.length] as Vec2;
        const ay = (a[1] - zb.minV) * zb.s;
        const by = (b[1] - zb.minV) * zb.s;
        if (ay <= Y !== by <= Y) {
          const t = (Y - ay) / (by - ay);
          xs.push((a[0] - zb.minU + t * (b[0] - a[0])) * zb.s);
        }
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil((xs[k] as number) - 0.5));
      const xb = Math.min(zb.w - 1, Math.floor((xs[k + 1] as number) - 0.5));
      for (let x = xa; x <= xb; x++) {
        const i = y * zb.w + x;
        if (depth > (zb.z[i] as number)) zb.z[i] = depth;
      }
    }
  }
}

function visibleAt(zb: ZBuf, u: number, v: number, depth: number): boolean {
  const cx = Math.floor((u - zb.minU) * zb.s);
  const cy = Math.floor((v - zb.minV) * zb.s);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= zb.w || y >= zb.h) continue;
      if ((zb.z[y * zb.w + x] as number) <= depth + zb.eps) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------

interface Sample {
  u: number;
  v: number;
  d: number;
  vis: boolean;
}

function simplify(points: Vec2[]): Vec2[] {
  if (points.length <= 2) return points;
  const out: Vec2[] = [points[0] as Vec2];
  for (let i = 1; i + 1 < points.length; i++) {
    const a = out[out.length - 1] as Vec2;
    const b = points[i] as Vec2;
    const c = points[i + 1] as Vec2;
    const abx = c[0] - a[0];
    const aby = c[1] - a[1];
    const l = Math.hypot(abx, aby);
    const off =
      l < 1e-9
        ? Math.hypot(b[0] - a[0], b[1] - a[1])
        : Math.abs((b[0] - a[0]) * aby - (b[1] - a[1]) * abx) / l;
    if (off > 2e-3) out.push(b);
  }
  out.push(points[points.length - 1] as Vec2);
  return out;
}

function toCurve(points: Vec2[]): Curve2 | null {
  const p = simplify(points);
  if (p.length < 2) return null;
  const a = p[0] as Vec2;
  const b = p[p.length - 1] as Vec2;
  if (p.length === 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return null;
  if (p.length === 2) return { kind: 'line', a, b };
  return { kind: 'polyline', points: p };
}

/** A circle through the polyline's points (3D), or null. */
function fitCircle(pts: V3[]): { center: V3; normal: V3; radius: number } | null {
  if (pts.length < 8) return null;
  const a = pts[0] as V3;
  const b = pts[Math.floor(pts.length / 3)] as V3;
  const c = pts[Math.floor((2 * pts.length) / 3)] as V3;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const w1 = dot(ac, ac) / (2 * nn);
  const w2 = dot(ab, ab) / (2 * nn);
  const center: V3 = [
    a[0] + (t1[0] * w1 + t2[0] * w2),
    a[1] + (t1[1] * w1 + t2[1] * w2),
    a[2] + (t1[2] * w1 + t2[2] * w2),
  ];
  const radius = len(sub(a, center));
  const normal = unit(n);
  for (const p of pts) {
    if (Math.abs(len(sub(p, center)) - radius) > radius * 0.004 + 1e-4) return null;
    if (Math.abs(dot(sub(p, center), normal)) > radius * 0.004 + 1e-4) return null;
  }
  return { center, normal, radius };
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

function dihedralSmooth(L: Loaded, line: V3[]): boolean {
  if (line.length < 2) return false;
  const i = Math.floor((line.length - 1) / 2);
  const a = line[i] as V3;
  const b = line[i + 1] as V3;
  const ta = L.incident.get(q(a)) ?? [];
  const tb = new Set(L.incident.get(q(b)) ?? []);
  const both = ta.filter((t) => tb.has(t));
  const normals: V3[] = [];
  for (const t of both) {
    const n = (L.tris[t] as Loaded['tris'][number]).n;
    if (!normals.some((m) => dot(m, n) > 0.9999)) normals.push(n);
  }
  if (normals.length < 2) return false;
  return dot(normals[0] as V3, normals[1] as V3) > Math.cos((8 * Math.PI) / 180);
}

export function projectPlaceholder(
  L: Loaded,
  req: ViewProjectionRequest,
  names: readonly string[] = [],
): ViewProjection {
  const t0 = Date.now();
  const x = unit(req.frame.x as V3);
  const y = unit(req.frame.y as V3);
  const n = unit(cross(x, y));
  const uv = (p: V3): Vec2 => [dot(p, x), dot(p, y)];

  // Bounds: the projected 3D box.
  const bmin = L.bounds.min;
  const bmax = L.bounds.max;
  const b2 = { min: [Infinity, Infinity] as Vec2, max: [-Infinity, -Infinity] as Vec2 };
  for (let i = 0; i < 8; i++) {
    const p: V3 = [i & 1 ? bmax[0] : bmin[0], i & 2 ? bmax[1] : bmin[1], i & 4 ? bmax[2] : bmin[2]];
    const w = uv(p);
    b2.min = [Math.min(b2.min[0], w[0]), Math.min(b2.min[1], w[1])];
    b2.max = [Math.max(b2.max[0], w[0]), Math.max(b2.max[1], w[1])];
  }
  const diag = len(sub(bmax, bmin));

  // Geometry kept by the section.
  const sec = req.section ? cutPlanes(req.section) : null;
  type Tri = [V3, V3, V3];
  const keptTris: Tri[] = [];
  for (const t of L.tris) {
    const tri: Tri = [t.a, t.b, t.c];
    if (!sec) keptTris.push(tri);
    else {
      const pl = sec.planes[sec.at(lerp3(lerp3(t.a, t.b, 0.5), t.c, 1 / 3))] as CutPlane;
      keptTris.push(...clipTriangle(tri, pl));
    }
  }
  // Cut loops (3D segments where the plane meets the mesh), per plane.
  const capLoops: { loop: V3[]; plane: number }[] = [];
  if (sec) {
    const segs = new Map<number, [V3, V3][]>();
    for (const t of L.tris) {
      const pi = sec.at(lerp3(lerp3(t.a, t.b, 0.5), t.c, 1 / 3));
      const pl = sec.planes[pi] as CutPlane;
      const v = [t.a, t.b, t.c];
      const d = v.map((p) => dist(pl, p));
      const pts: V3[] = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        const da = d[i] as number;
        const db = d[j] as number;
        if (da >= 0 !== db >= 0) pts.push(lerp3(v[i] as V3, v[j] as V3, da / (da - db)));
      }
      if (pts.length === 2 && len(sub(pts[0] as V3, pts[1] as V3)) > 1e-6) {
        const l = segs.get(pi) ?? [];
        l.push([pts[0] as V3, pts[1] as V3]);
        segs.set(pi, l);
      }
    }
    for (const [pi, s] of segs) for (const loop of chain(s)) capLoops.push({ loop, plane: pi });
  }

  const zb = makeZBuf(b2, diag);
  const slice = req.section?.depth === 'slice';
  if (!slice) {
    for (const [a, b, c] of keptTris) {
      const pa = uv(a);
      const pb = uv(b);
      const pc = uv(c);
      raster(zb, [pa[0], pa[1], dot(a, n)], [pb[0], pb[1], dot(b, n)], [pc[0], pc[1], dot(c, n)]);
    }
    if (sec) {
      const byPlane = new Map<number, Vec2[][]>();
      for (const { loop, plane } of capLoops) {
        const l = byPlane.get(plane) ?? [];
        l.push(loop.map(uv));
        byPlane.set(plane, l);
      }
      for (const [plane, loops] of byPlane) {
        const pl = sec.planes[plane] as CutPlane;
        fillLoops(zb, loops, dot(pl.c, n) + zb.eps * 0.5);
      }
    }
  }

  const curves: ProjectedCurve[] = [];
  const sampleLine = (pts: V3[]): Sample[] => {
    const out: Sample[] = [];
    const step = 0.6 / zb.s;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as V3;
      if (i > 0) {
        const a = pts[i - 1] as V3;
        const w0 = uv(a);
        const w1 = uv(p);
        const l = Math.hypot(w1[0] - w0[0], w1[1] - w0[1]);
        const k = Math.min(2000, Math.floor(l / step));
        for (let j = 1; j < k; j++) {
          const m = lerp3(a, p, j / k);
          const w = uv(m);
          out.push({ u: w[0], v: w[1], d: dot(m, n), vis: false });
        }
      }
      const w = uv(p);
      out.push({ u: w[0], v: w[1], d: dot(p, n), vis: false });
    }
    for (const s of out) s.vis = slice ? true : visibleAt(zb, s.u, s.v, s.d);
    return out;
  };

  const emit = (line: V3[], name: string | undefined, edge: EdgeClass) => {
    if (line.length < 2) return;
    const samples = sampleLine(line);
    // Whole circle (or arc) seen face-on, in one visibility: an exact arc.
    const circle = edge === 'sharp' ? fitCircle(line) : null;
    const faceOn = circle ? Math.abs(Math.abs(dot(circle.normal, n)) - 1) < 1e-4 : false;
    const allSame = samples.every((s) => s.vis === samples[0]?.vis);
    if (circle && faceOn && allSame) {
      const c2 = uv(circle.center);
      const ang = (p: V3) => {
        const w = uv(p);
        return Math.atan2(w[1] - c2[1], w[0] - c2[0]);
      };
      const first = line[0] as V3;
      const last = line[line.length - 1] as V3;
      const closed = len(sub(first, last)) < circle.radius * 1e-3;
      let a0 = ang(first);
      let a1 = closed ? a0 + TAU : ang(last);
      if (!closed) {
        // Sweep through the middle sample, counter-clockwise in the view.
        const mid = ang(line[Math.floor(line.length / 2)] as V3);
        const ccw = (a: number, b: number) => (((b - a) % TAU) + TAU) % TAU;
        if (ccw(a0, mid) > ccw(a0, a1)) {
          const t = a0;
          a0 = a1;
          a1 = t;
        }
        if (a1 < a0) a1 += TAU;
      }
      const role = samples[0]?.vis ? 'visible' : 'hidden';
      if (role === 'visible' || req.hidden)
        curves.push({
          role,
          edge,
          ...(name ? { name } : {}),
          curve: { kind: 'arc', center: c2, radius: circle.radius, start: a0, end: a1 },
        });
      return;
    }
    let run: Vec2[] = [];
    let vis = samples[0]?.vis ?? true;
    const flush = () => {
      const curve = toCurve(run);
      if (curve && (vis || req.hidden))
        curves.push({
          role: vis ? 'visible' : 'hidden',
          edge,
          ...(name ? { name } : {}),
          curve,
        });
    };
    for (const s of samples) {
      if (s.vis !== vis) {
        run.push([s.u, s.v]);
        flush();
        run = [[s.u, s.v]];
        vis = s.vis;
        continue;
      }
      run.push([s.u, s.v]);
    }
    flush();
  };

  // B-rep edges.
  L.edges.forEach((line, idx) => {
    if (slice) return;
    const smooth = dihedralSmooth(L, line);
    if (smooth && !req.smooth) return;
    const edge: EdgeClass = smooth ? 'smooth' : 'sharp';
    const nm = names[idx] || undefined;
    if (!sec) {
      emit(line, nm, edge);
      return;
    }
    for (const run of clipPolyline(
      line,
      sec.planes[sec.at(line[Math.floor(line.length / 2)] as V3)] as CutPlane,
    ))
      emit(run, nm, edge);
  });

  // Silhouettes of curved faces: tessellation edges whose two triangles face opposite ways.
  if (!slice) {
    const segs: [V3, V3][] = [];
    for (const e of L.interior) {
      const t1 = L.tris[e.t1] as Loaded['tris'][number];
      const t2 = L.tris[e.t2] as Loaded['tris'][number];
      if (dot(t1.n, t2.n) > 0.9995) continue;
      const s1 = dot(t1.n, n);
      const s2 = dot(t2.n, n);
      if (s1 * s2 >= 0 || Math.abs(s1) + Math.abs(s2) < 1e-6) continue;
      if (sec) {
        const pl = sec.planes[sec.at(lerp3(e.a, e.b, 0.5))] as CutPlane;
        if (dist(pl, e.a) < 0 || dist(pl, e.b) < 0) continue;
      }
      segs.push([e.a, e.b]);
    }
    for (const line of chain(segs)) emit(line, undefined, 'outline');
  }

  // The cut faces: outlines as visible curves, loops for the hatch.
  let sectionFaces: ViewProjection['sectionFaces'];
  if (sec) {
    const loops: Curve2[][] = [];
    for (const { loop } of capLoops) {
      const pts = loop.map(uv);
      const first = pts[0] as Vec2;
      const last = pts[pts.length - 1] as Vec2;
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-3) pts.push(first);
      if (pts.length < 4) continue;
      const curve: Curve2 = { kind: 'polyline', points: pts };
      loops.push([curve]);
      curves.push({ role: 'visible', edge: 'sharp', curve });
    }
    if (loops.length) sectionFaces = [{ face: 'cut', loops }];
  }

  return {
    key: `${req.shapeKey}|${JSON.stringify([req.frame, req.hidden, req.smooth, req.section ?? null, req.clip ?? null])}`,
    curves: req.clip ? clipToCircle(curves, req.clip) : curves,
    ...(sectionFaces ? { sectionFaces } : {}),
    bounds: b2,
    ms: Date.now() - t0,
  };
}

/** Detail views: the parts of the curves inside the clip circle (as polylines). */
function clipToCircle(
  curves: ProjectedCurve[],
  clip: NonNullable<ViewProjectionRequest['clip']>,
): ProjectedCurve[] {
  const [cx, cy] = clip.center;
  const inside = (p: Vec2) => Math.hypot(p[0] - cx, p[1] - cy) <= clip.radius;
  const out: ProjectedCurve[] = [];
  for (const c of curves) {
    let pts: Vec2[];
    const k = c.curve;
    if (k.kind === 'line') {
      const l = Math.hypot(k.b[0] - k.a[0], k.b[1] - k.a[1]);
      const m = Math.max(2, Math.ceil(l / (clip.radius / 40)));
      pts = Array.from({ length: m + 1 }, (_, i) => [
        k.a[0] + ((k.b[0] - k.a[0]) * i) / m,
        k.a[1] + ((k.b[1] - k.a[1]) * i) / m,
      ]);
    } else if (k.kind === 'polyline') {
      pts = [];
      for (let i = 0; i < k.points.length; i++) {
        const p = k.points[i] as Vec2;
        const a = k.points[i - 1];
        if (a) {
          const l = Math.hypot(p[0] - a[0], p[1] - a[1]);
          const m = Math.max(1, Math.ceil(l / (clip.radius / 40)));
          for (let j = 1; j < m; j++)
            pts.push([a[0] + ((p[0] - a[0]) * j) / m, a[1] + ((p[1] - a[1]) * j) / m]);
        }
        pts.push(p);
      }
    } else if (k.kind === 'arc') {
      const sweep = k.end - k.start;
      const m = Math.max(16, Math.ceil(Math.abs(sweep) * 24));
      pts = Array.from({ length: m + 1 }, (_, i) => {
        const a = k.start + (sweep * i) / m;
        return [k.center[0] + k.radius * Math.cos(a), k.center[1] + k.radius * Math.sin(a)] as Vec2;
      });
    } else continue;
    let run: Vec2[] = [];
    const flush = () => {
      const curve = toCurve(run);
      if (curve) out.push({ ...c, curve });
      run = [];
    };
    for (const p of pts) {
      if (inside(p)) run.push(p);
      else flush();
    }
    flush();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

const MAX_SHAPES = 4;

export interface PlaceholderLoaded extends Loaded {
  names: string[];
}

export class PlaceholderDrawingKernel implements DrawingKernelApi {
  /** Marks this implementation for the UI's "approximate" badge. */
  readonly placeholder = true as const;
  private readonly shapes = new Map<string, PlaceholderLoaded>();

  async loadShape(
    shape: ShapeForDrawing,
  ): Promise<{ ok: true } | { ok: false; error: KernelError }> {
    if (this.shapes.has(shape.key)) {
      const s = this.shapes.get(shape.key) as PlaceholderLoaded;
      this.shapes.delete(shape.key);
      this.shapes.set(shape.key, s);
      return { ok: true };
    }
    const bodies = decodePlaceholderShape(shape.brep);
    if (!bodies) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_FEATURE',
          message: 'The placeholder drawing kernel reads render meshes, not BREP bytes.',
        },
      };
    }
    this.shapes.set(shape.key, { ...build(bodies), names: shape.edgeNames });
    while (this.shapes.size > MAX_SHAPES) {
      const oldest = this.shapes.keys().next().value;
      if (oldest === undefined) break;
      this.shapes.delete(oldest);
    }
    return { ok: true };
  }

  async hasShape(key: string): Promise<boolean> {
    return this.shapes.has(key);
  }

  async project(
    request: ViewProjectionRequest,
  ): Promise<{ ok: true; value: ViewProjection } | { ok: false; error: KernelError }> {
    const s = this.shapes.get(request.shapeKey);
    if (!s) {
      return {
        ok: false,
        error: { code: 'INVALID_HANDLE', message: 'The drawing kernel does not hold this shape.' },
      };
    }
    try {
      return { ok: true, value: projectPlaceholder(s, request, s.names) };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'The placeholder projection failed.',
          detail: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }
}

export type { Loaded as PlaceholderShape, Vec3 };
export { build as buildPlaceholderShape };
