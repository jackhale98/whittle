/**
 * Pure edits of a section's cut line (PLAN §2.4 P1: half and offset sections). The cut is
 * a list of points in the parent's view plane (part mm); each segment is a cutting plane
 * perpendicular to the parent, so two points are a full section, an L-shaped line is a half
 * section, and a jogged line is an offset one. No document access: tested in isolation.
 */

import type { AnchoredPoint, Vec2 } from '@wren-cad/contracts';

const free = (at: Vec2): AnchoredPoint => ({ kind: 'free', at });
const round = (n: number) => Math.round(n * 1000) / 1000;
const at = (p: AnchoredPoint | undefined): Vec2 | null => (p?.kind === 'free' ? p.at : null);

/** The vertex moved to `to` (a vertex that followed a model entity becomes a free point). */
export function moveVertex(
  cut: readonly AnchoredPoint[],
  index: number,
  to: Vec2,
): AnchoredPoint[] {
  return cut.map((p, i) => (i === index ? free([round(to[0]), round(to[1])]) : p));
}

/** A vertex in the middle of the longest segment, so the line can be bent there. */
export function addVertex(cut: readonly AnchoredPoint[]): AnchoredPoint[] {
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i + 1 < cut.length; i++) {
    const a = at(cut[i]);
    const b = at(cut[i + 1]);
    if (!a || !b) continue;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > bestLen) {
      best = i;
      bestLen = l;
    }
  }
  if (best < 0) return [...cut];
  const a = at(cut[best]) as Vec2;
  const b = at(cut[best + 1]) as Vec2;
  const out = [...cut];
  out.splice(best + 1, 0, free([round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)]));
  return out;
}

/** The vertex removed; a cut line keeps at least two points. */
export function removeVertex(cut: readonly AnchoredPoint[], index: number): AnchoredPoint[] {
  return cut.length <= 2 ? [...cut] : cut.filter((_, i) => i !== index);
}

/** The left-hand perpendicular of the first-to-last direction, unit length. */
function leftNormal(a: Vec2, b: Vec2): Vec2 | null {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]);
  return l < 1e-9 ? null : [-d[1] / l, d[0] / l];
}

/**
 * A straight cut turned into a half section: in to the middle, then a right angle out to the side
 * the viewer looks from, as far as the half the line has gone. `null` unless it is a plain
 * two-point cut of free points.
 */
export function toHalfSection(
  cut: readonly AnchoredPoint[],
  look: 'left' | 'right',
): AnchoredPoint[] | null {
  if (cut.length !== 2) return null;
  const a = at(cut[0]);
  const b = at(cut[1]);
  const n = a && b ? leftNormal(a, b) : null;
  if (!a || !b || !n) return null;
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const half = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
  const s = look === 'left' ? 1 : -1;
  return [
    free([round(a[0]), round(a[1])]),
    free([round(mid[0]), round(mid[1])]),
    free([round(mid[0] + n[0] * half * s), round(mid[1] + n[1] * half * s)]),
  ];
}

/**
 * A straight cut turned into an offset section: along to the middle, a jog across, then on in a
 * parallel plane a quarter of the cut's length away. `null` unless it is a plain two-point cut.
 */
export function toOffsetSection(
  cut: readonly AnchoredPoint[],
  look: 'left' | 'right',
): AnchoredPoint[] | null {
  if (cut.length !== 2) return null;
  const a = at(cut[0]);
  const b = at(cut[1]);
  const n = a && b ? leftNormal(a, b) : null;
  if (!a || !b || !n) return null;
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const jog = Math.hypot(b[0] - a[0], b[1] - a[1]) / 4;
  const s = look === 'left' ? 1 : -1;
  const o: Vec2 = [n[0] * jog * s, n[1] * jog * s];
  return [
    free([round(a[0]), round(a[1])]),
    free([round(mid[0]), round(mid[1])]),
    free([round(mid[0] + o[0]), round(mid[1] + o[1])]),
    free([round(b[0] + o[0]), round(b[1] + o[1])]),
  ];
}

/** What a cut line is, in a word: full (straight), half (L-shaped), offset (one jog) or stepped. */
export function cutKind(cut: readonly AnchoredPoint[]): 'full' | 'half' | 'offset' | 'stepped' {
  if (cut.length <= 2) return 'full';
  if (cut.length === 3) {
    const [a, m, b] = cut.map(at);
    if (a && m && b) {
      const u: Vec2 = [m[0] - a[0], m[1] - a[1]];
      const v: Vec2 = [b[0] - m[0], b[1] - m[1]];
      if (Math.abs(u[0] * v[0] + u[1] * v[1]) < 1e-6 * Math.hypot(...u) * Math.hypot(...v))
        return 'half';
    }
  }
  return cut.length === 4 ? 'offset' : 'stepped';
}
