/**
 * The arithmetic of sheet drags (ADR-094), apart from any DOM or document: where a dimension's
 * text goes when it is dragged along or across its line, how an angle's arc and a detail's circle
 * follow the pointer. Pure, in sheet mm (y up).
 */

import type { Vec2 } from '@wren-cad/contracts';

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
const round2 = (x: number) => Math.round(x * 100) / 100;

export type TextSide = 'above' | 'below' | 'inline';

/** Below this the text is back at the auto-centred spot: the stored shift is dropped. */
export const SHIFT_SNAP = 0.5;
/** The text sits above, below or inline by its centre's distance from the line, in text heights. */
export const SIDE_ZONE = 0.45;

export interface TextDragStart {
  /** The dimension line between the arrow tips, first to second along the measuring direction. */
  line: [Vec2, Vec2];
  /** The stored shift (0 = auto-centred). */
  shift: number;
  /** The centre of the text's box where the drag began. */
  centre: Vec2;
  /** The dimension text height. */
  h: number;
}

/**
 * The shift and side a dimension's text takes when it is dragged from `grab` to `p`: along the
 * line it moves (and goes outside the extension lines past them); across it, it snaps to above,
 * inline or below by where its centre is against the line.
 */
export function textDrag(
  s: TextDragStart,
  grab: Vec2,
  p: Vec2,
): { shift: number | undefined; side: TextSide; across: number; along: number } {
  const l = sub(s.line[1], s.line[0]);
  const ll = len(l) || 1;
  const u: Vec2 = [l[0] / ll, l[1] / ll];
  const n = perp(u);
  const d = sub(p, grab);
  const shift = s.shift + dot(d, u);
  const across = dot(sub(s.centre, s.line[0]), n) + dot(d, n);
  const side: TextSide =
    across > SIDE_ZONE * s.h ? 'above' : across < -SIDE_ZONE * s.h ? 'below' : 'inline';
  return {
    shift: Math.abs(shift) < SHIFT_SNAP ? undefined : round2(shift),
    side,
    across,
    along: dot(sub(s.centre, s.line[0]), u) + dot(d, u),
  };
}

/** The angle of `v` (radians, counter-clockwise from +x). */
export const angleOf = (v: Vec2) => Math.atan2(v[1], v[0]);

const wrapPi = (a: number) => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

export interface ArcDragStart {
  vertex: Vec2;
  /** The arc's stored radius and the stored text shift along it (sheet mm). */
  radius: number;
  shift: number;
  /** Where the text's centre is (the angular position of the text is the arc's mid-angle plus shift / radius). */
  centre: Vec2;
}

/**
 * An angle dimension dragged by its text: the arc's radius follows the pointer's distance from the
 * vertex, and the text slides along the arc to the pointer's direction. Dragged by its arc (not the
 * text), only the radius changes.
 */
export function arcDrag(
  s: ArcDragStart,
  p: Vec2,
  part: 'text' | 'arc',
): { radius: number; shift: number | undefined } {
  const v = sub(p, s.vertex);
  const radius = Math.max(2, round2(len(v)));
  if (part === 'arc') return { radius, shift: s.shift || undefined };
  // The mid-angle of the measured sweep: where the text would sit unshifted.
  const mid = angleOf(sub(s.centre, s.vertex)) - s.shift / s.radius;
  const shift = wrapPi(angleOf(v) - mid) * radius;
  return { radius, shift: Math.abs(shift) < SHIFT_SNAP ? undefined : round2(shift) };
}

/** Radius (part mm) a detail circle takes when its handle is at `p`: the distance from its centre. */
export function detailRadius(centre: Vec2, scale: number, p: Vec2): number {
  return Math.max(0.5, round2(len(sub(p, centre)) / scale));
}
