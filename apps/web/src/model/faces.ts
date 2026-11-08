/**
 * Face geometry from render meshes (no kernel): where a face is, which way it points and whether it
 * is planar. Push/pull places its arrow with it, the context bubble offers push/pull and "Sketch"
 * only on planar faces, and a section plane can be taken from a face. Pure functions over
 * `MeshBuffers` so they are unit-tested without a viewport.
 */

import type { MeshBuffers, SectionPlane, Vec3 } from '@whittle/contracts';

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
