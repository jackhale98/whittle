/**
 * Face geometry from render meshes (no kernel): where a face is, which way it points and whether it
 * is planar. Push/pull places its arrow with it, the context bubble offers push/pull and "Sketch"
 * only on planar faces, and a section plane can be taken from a face. Pure functions over
 * `MeshBuffers` so they are unit-tested without a viewport.
 */

import type { MeshBuffers, SectionPlane, Vec3 } from '@wren-cad/contracts';

export interface FaceInfo {
  /** Area-weighted centroid (mm). */
  centroid: Vec3;
  /** Area-weighted unit normal (outward: the mesh winding). */
  normal: Vec3;
  /** Every triangle's normal is within ~0.06° of `normal` (flat to tessellation precision). */
  planar: boolean;
  /** mm². */
  area: number;
  /** Half the diagonal of the face's bounding box (mm), for zoom-to and handle sizing. */
  radius: number;
}

const PLANAR_COS = Math.cos((0.06 * Math.PI) / 180);

/** Geometry of face `index` of a body mesh; null when the face has no triangles. */
export function faceInfo(mesh: MeshBuffers, index: number): FaceInfo | null {
  const first = mesh.faceRanges[index * 2];
  const count = mesh.faceRanges[index * 2 + 1];
  if (first === undefined || !count) return null;
  const P = mesh.positions;
  const I = mesh.indices;
  let area = 0;
  const c: [number, number, number] = [0, 0, 0];
  const n: [number, number, number] = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const tri: Array<[number, number, number]> = [];
  for (let t = first; t < first + count; t++) {
    const ia = (I[t * 3] as number) * 3;
    const ib = (I[t * 3 + 1] as number) * 3;
    const ic = (I[t * 3 + 2] as number) * 3;
    const ax = P[ia] as number;
    const ay = P[ia + 1] as number;
    const az = P[ia + 2] as number;
    const ux = (P[ib] as number) - ax;
    const uy = (P[ib + 1] as number) - ay;
    const uz = (P[ib + 2] as number) - az;
    const vx = (P[ic] as number) - ax;
    const vy = (P[ic + 1] as number) - ay;
    const vz = (P[ic + 2] as number) - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const a2 = Math.hypot(cx, cy, cz);
    if (a2 === 0) continue;
    const a = a2 / 2;
    area += a;
    n[0] += cx / 2;
    n[1] += cy / 2;
    n[2] += cz / 2;
    tri.push([cx / a2, cy / a2, cz / a2]);
    for (const i of [ia, ib, ic]) {
      for (let k = 0; k < 3; k++) {
        const v = P[i + k] as number;
        c[k] = (c[k] as number) + (v * a) / 3;
        if (v < (min[k] as number)) min[k] = v;
        if (v > (max[k] as number)) max[k] = v;
      }
    }
  }
  if (area === 0) return null;
  const nl = Math.hypot(n[0], n[1], n[2]);
  const normal: Vec3 = nl > 0 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 0, 1];
  const planar =
    nl > 0 &&
    tri.every((t) => t[0] * normal[0] + t[1] * normal[1] + t[2] * normal[2] >= PLANAR_COS);
  const radius =
    Math.hypot(
      (max[0] as number) - (min[0] as number),
      (max[1] as number) - (min[1] as number),
      (max[2] as number) - (min[2] as number),
    ) / 2;
  return { centroid: [c[0] / area, c[1] / area, c[2] / area], normal, planar, area, radius };
}

/** Faces grouped by (nearly) equal normal, in first-seen order: one prism preview per group. */
export function groupByNormal(
  faces: ReadonlyArray<{ index: number; normal: Vec3 }>,
): Array<{ normal: Vec3; faces: number[] }> {
  const out: Array<{ normal: Vec3; faces: number[] }> = [];
  for (const f of faces) {
    const g = out.find(
      (x) =>
        x.normal[0] * f.normal[0] + x.normal[1] * f.normal[1] + x.normal[2] * f.normal[2] >
        PLANAR_COS,
    );
    if (g) g.faces.push(f.index);
    else out.push({ normal: f.normal, faces: [f.index] });
  }
  return out;
}

/** An edge shared by two moved faces of different, perpendicular normals, at a convex corner. */
export interface CornerEdge {
  a: Vec3;
  b: Vec3;
  /** The two groups' normals. */
  n1: Vec3;
  n2: Vec3;
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where two push/pull normal groups meet at a convex, perpendicular edge. The kernel moves the
 * groups one after the other (ADR-013 addendum), so the later group's face has already grown by
 * the earlier group's wall and its prism fills the corner; per-group prisms alone leave a notch
 * there. Edges are found on the render mesh: boundary edges of each group's triangles, welded by
 * position (kernel meshes duplicate vertices along face seams), that appear in both groups.
 */
export function convexCorners(
  mesh: MeshBuffers,
  groups: ReadonlyArray<{ normal: Vec3; faces: readonly number[] }>,
): CornerEdge[] {
  if (groups.length < 2) return [];
  const P = mesh.positions;
  const I = mesh.indices;
  const pos = (v: number): Vec3 => [
    P[v * 3] as number,
    P[v * 3 + 1] as number,
    P[v * 3 + 2] as number,
  ];
  const weld = (v: number): string =>
    `${Math.round((P[v * 3] as number) * 1e4)},${Math.round((P[v * 3 + 1] as number) * 1e4)},${Math.round(
      (P[v * 3 + 2] as number) * 1e4,
    )}`;
  type Side = { a: number; b: number; third: number; count: number };
  const boundary = (faces: readonly number[]): Map<string, Side> => {
    const edges = new Map<string, Side>();
    for (const f of faces) {
      const first = mesh.faceRanges[f * 2];
      const count = mesh.faceRanges[f * 2 + 1];
      if (first === undefined || !count) continue;
      for (let t = first; t < first + count; t++) {
        const tri = [I[t * 3] as number, I[t * 3 + 1] as number, I[t * 3 + 2] as number];
        for (let k = 0; k < 3; k++) {
          const a = tri[k] as number;
          const b = tri[(k + 1) % 3] as number;
          const ka = weld(a);
          const kb = weld(b);
          if (ka === kb) continue;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const e = edges.get(key);
          if (e) e.count++;
          else edges.set(key, { a, b, third: tri[(k + 2) % 3] as number, count: 1 });
        }
      }
    }
    for (const [k, e] of edges) if (e.count !== 1) edges.delete(k);
    return edges;
  };
  const sides = groups.map((g) => boundary(g.faces));
  const out: CornerEdge[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const n1 = (groups[i] as { normal: Vec3 }).normal;
      const n2 = (groups[j] as { normal: Vec3 }).normal;
      if (Math.abs(dot3(n1, n2)) > 1e-3) continue; // only perpendicular faces extend each other
      const si = sides[i] as Map<string, Side>;
      for (const [key, ej] of sides[j] as Map<string, Side>) {
        const ei = si.get(key);
        if (!ei) continue;
        const a = pos(ej.a);
        const b = pos(ej.b);
        const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const into = (v: number): Vec3 => {
          const p = pos(v);
          return [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]];
        };
        // Convex: each face runs away from the other's outward side.
        if (dot3(into(ej.third), n1) >= -1e-9 || dot3(into(ei.third), n2) >= -1e-9) continue;
        out.push({ a, b, n1, n2 });
      }
    }
  }
  return out;
}

/**
 * The corner blocks for `convexCorners` at a pull of `distance` mm: each edge swept by both
 * normals (a parallelepiped). Its two faces against the prisms' walls are left out, so nothing is
 * drawn twice. Null for pushes (d ≤ 0: the cut prisms overlap at a convex corner, nothing is
 * missing) or without corners.
 */
export function cornerFillMesh(edges: readonly CornerEdge[], distance: number): MeshBuffers | null {
  if (!(distance > 0) || edges.length === 0) return null;
  // Per edge 8 corners (u, v: the two normals × distance) — 0 a, 1 b, 2 a+u, 3 b+u, 4 a+v,
  // 5 b+v, 6 a+u+v, 7 b+u+v — and 4 quads: the two outer faces and the two ends.
  const quads = [
    [2, 3, 7, 6],
    [4, 5, 7, 6],
    [0, 2, 6, 4],
    [1, 3, 7, 5],
  ] as const;
  const steps = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const;
  const positions = new Float32Array(edges.length * 8 * 3);
  const normals = new Float32Array(edges.length * 8 * 3);
  const indices = new Uint32Array(edges.length * quads.length * 6);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let v = 0;
  let i = 0;
  for (const e of edges) {
    const base = v;
    // Normals are nominal: previews shade by facet.
    const mid = [e.n1[0] + e.n2[0], e.n1[1] + e.n2[1], e.n1[2] + e.n2[2]];
    const ml = Math.hypot(mid[0] as number, mid[1] as number, mid[2] as number) || 1;
    for (const [s, t] of steps) {
      for (const p of [e.a, e.b]) {
        for (let d = 0; d < 3; d++) {
          const x =
            (p[d] as number) + ((e.n1[d] as number) * s + (e.n2[d] as number) * t) * distance;
          positions[v * 3 + d] = x;
          normals[v * 3 + d] = (mid[d] as number) / ml;
          if (x < (min[d] as number)) min[d] = x;
          if (x > (max[d] as number)) max[d] = x;
        }
        v++;
      }
    }
    for (const [q0, q1, q2, q3] of quads) {
      for (const t of [q0, q1, q2, q0, q2, q3]) indices[i++] = base + t;
    }
  }
  return {
    positions,
    normals,
    indices,
    faceRanges: new Uint32Array([0, indices.length / 3]),
    edgePositions: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    faceNames: [''],
    edgeNames: [],
    bbox: { min, max },
  };
}

/**
 * Push/pull drag: the signed distance (mm) for a pointer delta (CSS px), projected onto the
 * screen-space image of the handle axis. `axis` is the screen vector (px) of `axisMm` mm along
 * the face normal: worldToScreen(origin + n · axisMm) − worldToScreen(origin). Null when the axis
 * is (nearly) end-on and the drag would be ill-conditioned.
 */
export function dragDistance(
  delta: { dx: number; dy: number },
  axis: { x: number; y: number },
  axisMm: number,
): number | null {
  const l2 = axis.x * axis.x + axis.y * axis.y;
  if (l2 < 4) return null; // < 2 px for the whole axis
  return ((delta.dx * axis.x + delta.dy * axis.y) / l2) * axisMm;
}

/** Drag distances snap to 0.1 mm; typed values are kept exactly. */
export const snapDistance = (mm: number): number => Math.round(mm * 10) / 10;

/** "12.5 mm", "−3 mm", "0 mm" (as an expression: the minus is ASCII). */
export function distanceExpr(mm: number): string {
  const v = Math.round(mm * 1000) / 1000;
  return `${Object.is(v, -0) ? 0 : v} mm`;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Union of the bodies' bounding boxes; null without bodies. */
export function unionBounds(boxes: readonly Bounds[]): Bounds | null {
  if (boxes.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, b.min[k] as number);
      max[k] = Math.max(max[k] as number, b.max[k] as number);
    }
  return { min, max };
}

export type SectionAxis = 'x' | 'y' | 'z' | 'face';

export interface SectionSettings {
  enabled: boolean;
  axis: SectionAxis;
  /** Along the axis (world coordinate) or, for a face, along its normal from the face. */
  offset: number;
  flipped: boolean;
  face: { origin: Vec3; normal: Vec3 } | null;
}

const AXES: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Base point and unit normal of the section's axis (before offset and flip). */
function sectionFrame(s: SectionSettings): { base: Vec3; normal: Vec3 } | null {
  if (s.axis === 'face') return s.face ? { base: s.face.origin, normal: s.face.normal } : null;
  return { base: [0, 0, 0], normal: AXES[s.axis] };
}

/** Slider range: the part's extent along the axis (relative to the face for `face`). */
export function sectionRange(
  s: SectionSettings,
  bounds: Bounds | null,
): { min: number; max: number } {
  const f = sectionFrame(s);
  if (!f || !bounds) return { min: -50, max: 50 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const d =
          (x - f.base[0]) * f.normal[0] +
          (y - f.base[1]) * f.normal[1] +
          (z - f.base[2]) * f.normal[2];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
  return hi - lo < 1e-9 ? { min: lo - 1, max: hi + 1 } : { min: lo, max: hi };
}

/** The viewport section plane for the settings; null when off (or a face axis without a face). */
export function sectionPlane(s: SectionSettings): SectionPlane | null {
  if (!s.enabled) return null;
  const f = sectionFrame(s);
  if (!f) return null;
  const origin: Vec3 = [
    f.base[0] + f.normal[0] * s.offset,
    f.base[1] + f.normal[1] * s.offset,
    f.base[2] + f.normal[2] * s.offset,
  ];
  const sign = s.flipped ? -1 : 1;
  return {
    origin,
    normal: [f.normal[0] * sign, f.normal[1] * sign, f.normal[2] * sign],
    caps: true,
  };
}
