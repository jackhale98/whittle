/**
 * Section-plane maths (pure). A section is a base plane (an X/Y/Z axis plane or a picked flat
 * face), two tilt angles, an offset along the tilted normal and a flip.
 *
 * Frame: every base plane has a right-handed in-plane frame (u, v, n0) with u × v = n0. The tilted
 * normal is `n = Ru(a) · Rv(b) · n0`: first b about v, then a about u (both fixed base axes), so
 * in (u, v, n0) coordinates `n = (sin b, −cos b · sin a, cos b · cos a)`. The inverse is closed
 * form (`tiltsForNormal`), which is how snapping to the world planes works for any base.
 *
 * Offset: for an axis, the world coordinate along the base axis where the plane crosses the line
 * through the part's bounding-box centre, i.e. at zero tilt exactly the old "plane at x = offset".
 * The plane then moves along the tilted normal through the centre. For a face the offset is the
 * distance from the face's centroid along the tilted normal.
 */

import type { SectionPlane, Vec3 } from '@wren-cad/contracts';
import type { Bounds } from './faces';

export type SectionAxis = 'x' | 'y' | 'z' | 'face';

export interface SectionSettings {
  enabled: boolean;
  axis: SectionAxis;
  /** Along the axis (world coordinate) or, for a face, along its normal from the face. */
  offset: number;
  flipped: boolean;
  face: { origin: Vec3; normal: Vec3 } | null;
  /** Tilt about the base plane's first in-plane axis `u` (radians). Default 0. */
  tiltU?: number;
  /** Tilt about the base plane's second in-plane axis `v` (radians). Default 0. */
  tiltV?: number;
}

export const SECTION_SNAP_DEG = 15;
/** Within this of an X/Y/Z-aligned plane the tilt snaps onto it. */
export const SECTION_AXIS_SNAP_DEG = 3;

const DEG = Math.PI / 180;
const AXES: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const WORLD: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rodrigues rotation of `p` about the unit `axis` by `angle`. */
export function rotateAbout(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, p);
  const d = dot(axis, p) * (1 - c);
  return [
    p[0] * c + k[0] * s + axis[0] * d,
    p[1] * c + k[1] * s + axis[1] * d,
    p[2] * c + k[2] * s + axis[2] * d,
  ];
}

export interface SectionFrame {
  u: Vec3;
  v: Vec3;
  n0: Vec3;
}

/** The base plane's right-handed frame (axes are cyclic: Z → X, Y; X → Y, Z; Y → Z, X). */
export function sectionFrame(s: Pick<SectionSettings, 'axis' | 'face'>): SectionFrame | null {
  if (s.axis === 'face') {
    if (!s.face) return null;
    const n0 = unit(s.face.normal);
    // The world axis least aligned with the normal seeds a stable u.
    let k = 0;
    for (let i = 1; i < 3; i++)
      if (Math.abs(dot(WORLD[i] as Vec3, n0)) < Math.abs(dot(WORLD[k] as Vec3, n0))) k = i;
    const u = unit(cross(cross(n0, WORLD[k] as Vec3), n0));
    return { u, v: cross(n0, u), n0 };
  }
  const n0 = AXES[s.axis];
  const u = s.axis === 'x' ? AXES.y : s.axis === 'y' ? AXES.z : AXES.x;
  return { u, v: cross(n0, u), n0 };
}

/** The (unflipped) unit normal for the tilts. */
export function tiltedNormal(f: SectionFrame, tiltU: number, tiltV: number): Vec3 {
  const afterV = rotateAbout(f.n0, f.v, tiltV);
  return unit(rotateAbout(afterV, f.u, tiltU));
}

/** The plane's in-plane axes now: the fixed `u` tilt axis and the `v` carried by the u tilt. */
export function tiltAxes(f: SectionFrame, tiltU: number): { u: Vec3; v: Vec3 } {
  return { u: f.u, v: rotateAbout(f.v, f.u, tiltU) };
}

/** Tilts giving normal `target` (a world vector) in frame `f`; the v tilt is in [−90°, 90°]. */
export function tiltsForNormal(f: SectionFrame, target: Vec3): { tiltU: number; tiltV: number } {
  const t = unit(target);
  const tu = dot(t, f.u);
  const tv = dot(t, f.v);
  const tn = dot(t, f.n0);
  const tiltV = Math.asin(Math.max(-1, Math.min(1, tu)));
  const tiltU = Math.hypot(tv, tn) < 1e-9 ? 0 : Math.atan2(-tv, tn);
  return { tiltU, tiltV };
}

export interface TiltSnap {
  tiltU: number;
  tiltV: number;
  /** What it snapped to: a world plane, the angle step, or nothing. */
  to: 'axis' | 'step' | null;
}

/**
 * Snaps a tilt pair. `step` (Shift or a held finger): both angles to 15° steps. Otherwise the
 * normal snaps onto an X/Y/Z plane when within 3° of one (either side), whatever the base.
 */
export function snapTilts(f: SectionFrame, tiltU: number, tiltV: number, step: boolean): TiltSnap {
  if (step) {
    const q = SECTION_SNAP_DEG * DEG;
    return { tiltU: Math.round(tiltU / q) * q, tiltV: Math.round(tiltV / q) * q, to: 'step' };
  }
  const n = tiltedNormal(f, tiltU, tiltV);
  let best: Vec3 | null = null;
  let bestAng = SECTION_AXIS_SNAP_DEG * DEG;
  for (const w of WORLD)
    for (const sign of [1, -1]) {
      const a = Math.acos(Math.max(-1, Math.min(1, dot(n, scale(w, sign)))));
      if (a <= bestAng) {
        bestAng = a;
        best = scale(w, sign);
      }
    }
  return best ? { ...tiltsForNormal(f, best), to: 'axis' } : { tiltU, tiltV, to: null };
}

/** The point tilts and offsets pivot about, and the offset's value at that point. */
function pivot(
  s: SectionSettings,
  f: SectionFrame,
  bounds: Bounds | null,
): { c: Vec3; c0: number } {
  if (s.axis === 'face') return { c: s.face?.origin ?? [0, 0, 0], c0: 0 };
  const c: Vec3 = bounds
    ? [
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      ]
    : [0, 0, 0];
  return { c, c0: dot(c, f.n0) };
}

function normalOf(s: SectionSettings, f: SectionFrame): Vec3 {
  return tiltedNormal(f, s.tiltU ?? 0, s.tiltV ?? 0);
}

/** Slider range: the part's extent along the tilted normal, in offset units. */
export function sectionRange(
  s: SectionSettings,
  bounds: Bounds | null,
): { min: number; max: number } {
  const f = sectionFrame(s);
  if (!f || !bounds) return { min: -50, max: 50 };
  const n = normalOf(s, f);
  const { c, c0 } = pivot(s, f, bounds);
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const d = dot([x - c[0], y - c[1], z - c[2]], n) + c0;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
  return hi - lo < 1e-9 ? { min: lo - 1, max: hi + 1 } : { min: lo, max: hi };
}

/** The tilted, unflipped unit normal, the point on the plane nearest the pivot and the frame. */
export function sectionGeometry(
  s: SectionSettings,
  bounds: Bounds | null = null,
): { origin: Vec3; normal: Vec3; frame: SectionFrame } | null {
  const frame = sectionFrame(s);
  if (!frame) return null;
  const normal = normalOf(s, frame);
  const { c, c0 } = pivot(s, frame, bounds);
  return { origin: add(c, scale(normal, s.offset - c0)), normal, frame };
}

/**
 * The viewport section plane for the settings; null when off (or a face axis without a face).
 * `bounds` gives an axis plane its pivot (the part's centre); without it the pivot is the origin.
 */
export function sectionPlane(
  s: SectionSettings,
  bounds: Bounds | null = null,
): SectionPlane | null {
  if (!s.enabled) return null;
  const g = sectionGeometry(s, bounds);
  if (!g) return null;
  const sign = s.flipped ? -1 : 1;
  return { origin: g.origin, normal: scale(g.normal, sign), caps: true };
}
