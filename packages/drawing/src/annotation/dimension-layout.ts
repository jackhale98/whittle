/**
 * Dimension geometry in a 2D plane (sheet mm for drawings; an annotation plane in M5): linear,
 * radial, angular and leader layouts with the ADR-055 rules, which hold at every view scale
 * because every size here is a style quantity in sheet mm (trap T8):
 *
 *  - extension lines start `extensionGap` from the geometry and run `extensionOvershoot` past the
 *    dimension line;
 *  - the text is auto-centred and shifted along the line by `text.shift`; text beyond the
 *    extension lines pulls the dimension line out to it;
 *  - arrows flip outside (same tips, pointing in, with stubs) when the span can't hold the text
 *    plus two arrowheads; text wider than the span moves out past the second arrow;
 *  - ISO: text aligned with the line and above it; ASME: unidirectional, in a break of the line.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { ArrowKind, DrawingStyle, Vec2 } from '@wren-cad/contracts';
import type { Primitive } from './display';
import {
  add2,
  angle2,
  dir2,
  dist2,
  dot2,
  norm2,
  perp2,
  rotate2,
  scale2,
  sub2,
  TAU,
  wrapAngle,
} from './geom';
import type { TextBlock } from './label-layout';

export type DimensionStyle = DrawingStyle['dimension'];

/** Arrowhead with its tip at `tip`, pointing along `dir` (unit, tail → tip). */
export function arrowhead(
  tip: Vec2,
  dir: Vec2,
  arrow: { kind: ArrowKind; length: number; angle: number },
): Primitive[] {
  const u = norm2(dir);
  const n = perp2(u);
  const L = arrow.length;
  const half = Math.tan(((arrow.angle / 2) * Math.PI) / 180) * L;
  const base = sub2(tip, scale2(u, L));
  const left = add2(base, scale2(n, half));
  const right = sub2(base, scale2(n, half));
  switch (arrow.kind) {
    case 'filledClosed':
      return [{ kind: 'fill', loops: [[tip, left, right]] }];
    case 'open':
      return [{ kind: 'polyline', points: [left, tip, right] }];
    case 'oblique': {
      const d = scale2(rotate2(u, Math.PI / 4), L / 2);
      return [{ kind: 'line', a: sub2(tip, d), b: add2(tip, d) }];
    }
    case 'dot': {
      const r = L / 4;
      const pts: Vec2[] = [];
      for (let i = 0; i < 12; i++) pts.push(add2(tip, scale2(dir2((i * TAU) / 12), r)));
      return [{ kind: 'fill', loops: [pts] }];
    }
  }
}

/** Reading angle for text along `dir` (ISO 129-1: readable from the bottom or the right). */
export function readableAngle(dir: Vec2): number {
  let a = (angle2(dir) * 180) / Math.PI;
  if (a > 90 + 1e-9) a -= 180;
  if (a <= -90 + 1e-9) a += 180;
  return a;
}

/** Places a label block: centred on `at` along its reading direction, offset `lift` × up. */
function placeLabel(
  label: TextBlock,
  at: Vec2,
  angleDeg: number,
  mode: 'above' | 'inline',
  h: number,
): { prims: Primitive[]; corners: Vec2[] } {
  const a = (angleDeg * Math.PI) / 180;
  const y0 =
    mode === 'above' ? 0.4 * h - label.box.min[1] : -(label.box.min[1] + label.box.max[1]) / 2;
  const x0 = -label.width / 2;
  const pt = (p: Vec2): Vec2 => add2(at, rotate2([p[0] + x0, p[1] + y0], a));
  const prims = label.prims.map((p) => movePrim(p, pt, angleDeg));
  const { min, max } = label.box;
  const corners: Vec2[] = [pt(min), pt([max[0], min[1]]), pt(max), pt([min[0], max[1]])];
  return { prims, corners };
}

/** Applies a rigid point map (rotation by `angleDeg` + translation) to a primitive. */
export function movePrim(p: Primitive, pt: (q: Vec2) => Vec2, angleDeg: number): Primitive {
  const rad = (angleDeg * Math.PI) / 180;
  switch (p.kind) {
    case 'line':
      return { ...p, a: pt(p.a), b: pt(p.b) };
    case 'polyline':
      return { ...p, points: p.points.map(pt) };
    case 'arc':
      return { ...p, center: pt(p.center), start: p.start + rad, end: p.end + rad };
    case 'ellipse':
      return { ...p, center: pt(p.center), major: rotate2(p.major, rad) };
    case 'spline':
      return { ...p, poles: p.poles.map(pt) };
    case 'fill':
      return { ...p, loops: p.loops.map((l) => l.map(pt)) };
    case 'text':
      return { ...p, at: pt(p.at), angle: p.angle + angleDeg };
  }
}

export interface DimensionGeometry {
  prims: Primitive[];
  /** The label's outline (4 corners), for overlap checks and picking. */
  textBox: Vec2[];
  /** The dimension line between the arrow tips (leader attach `dimensionLine`). */
  line: [Vec2, Vec2];
  arrowsOutside: boolean;
}

export interface LinearLayoutInput {
  /** Where the extension lines start: the measured points (sheet). */
  p1: Vec2;
  p2: Vec2;
  /** Measuring direction (unit, sheet). */
  dir: Vec2;
  /** The dimension line's position across `dir`: its coordinate along `perp2(dir)`. */
  across: number;
  label: TextBlock;
  style: DimensionStyle;
  h: number;
  shift?: number;
  witness?: { flip?: boolean; hide?: [boolean, boolean] };
  arrows?: 'auto' | 'inside' | 'outside';
}

/** Linear (and aligned, ordinate-like) dimension: extension lines, dimension line, arrows, text. */
export function linearLayout(input: LinearLayoutInput): DimensionGeometry {
  const { style, h } = input;
  const u = norm2(input.dir);
  const n = perp2(u);
  let s1 = dot2(input.p1, u);
  let s2 = dot2(input.p2, u);
  let q1 = input.p1;
  let q2 = input.p2;
  if (s2 < s1) {
    [s1, s2] = [s2, s1];
    [q1, q2] = [q2, q1];
  }
  const L = input.across;
  const at = (s: number, t: number): Vec2 => add2(scale2(u, s), scale2(n, t));
  const prims: Primitive[] = [];

  // Extension lines.
  const hide = input.witness?.hide ?? [false, false];
  [q1, q2].forEach((q, i) => {
    if (hide[i]) return;
    const t = dot2(q, n);
    const d = L - t;
    if (Math.abs(d) <= style.extensionGap) return;
    const sgn = Math.sign(d);
    const s = dot2(q, u);
    prims.push({
      kind: 'line',
      a: at(s, t + sgn * style.extensionGap),
      b: at(s, L + sgn * style.extensionOvershoot),
    });
  });

  // Text position and arrows.
  const span = s2 - s1;
  const fits = span >= input.label.width + 2 * style.arrow.length;
  const outside = input.arrows === 'outside' || (input.arrows !== 'inside' && !fits);
  const stub = style.arrow.length * 1.5;
  let textS = (s1 + s2) / 2 + (input.shift ?? 0);
  if (!input.shift && input.label.width + 0.5 * h > span)
    textS = s2 + (outside ? stub : 0) + 0.5 * h + input.label.width / 2;
  const half = input.label.width / 2;
  const lineFrom = Math.min(s1, textS - half) - (outside ? stub : 0);
  const lineTo = Math.max(s2, textS + half) + (outside && textS + half <= s2 ? stub : 0);

  const aligned = style.textOrientation === 'aligned';
  const textAngle = aligned ? readableAngle(u) : 0;
  const lab = placeLabel(input.label, at(textS, L), textAngle, style.textPosition, h);

  // Dimension line (with a break for inline text).
  const from = Math.min(lineFrom, s1);
  const to = Math.max(lineTo, s2);
  if (style.textPosition === 'inline') {
    const gap = 0.4 * h;
    const w = aligned ? half : textHalfExtentAlong(lab.corners, u, at(textS, L));
    const b0 = textS - w - gap;
    const b1 = textS + w + gap;
    if (b0 > from) prims.push({ kind: 'line', a: at(from, L), b: at(Math.min(b0, to), L) });
    if (b1 < to) prims.push({ kind: 'line', a: at(Math.max(b1, from), L), b: at(to, L) });
  } else {
    prims.push({ kind: 'line', a: at(from, L), b: at(to, L) });
  }
  const tipDir1 = outside ? u : scale2(u, -1);
  const tipDir2 = outside ? scale2(u, -1) : u;
  prims.push(...arrowhead(at(s1, L), tipDir1, style.arrow));
  prims.push(...arrowhead(at(s2, L), tipDir2, style.arrow));
  prims.push(...lab.prims);
  return { prims, textBox: lab.corners, line: [at(s1, L), at(s2, L)], arrowsOutside: outside };
}

function textHalfExtentAlong(corners: Vec2[], u: Vec2, c: Vec2): number {
  return Math.max(...corners.map((p) => Math.abs(dot2(sub2(p, c), u))));
}

export interface RadialLayoutInput {
  center: Vec2;
  radius: number;
  /** Leader angle, degrees CCW from sheet +x. */
  angle: number;
  /** Text distance beyond the curve (negative = inside), sheet mm. */
  distance: number;
  kind: 'radius' | 'diameter';
  label: TextBlock;
  style: DimensionStyle;
  h: number;
}

/**
 * Radius: a line from the centre along `angle` with the arrow on the curve, out to the text.
 * Diameter: a line through the centre with arrows on both sides of the circle. Text outside the
 * curve sits on a horizontal landing (ISO 129-1); text inside sits on the line.
 */
export function radialLayout(input: RadialLayoutInput): DimensionGeometry {
  const { style, h, center, radius } = input;
  const u = dir2((input.angle * Math.PI) / 180);
  const onCurve = add2(center, scale2(u, radius));
  const textR = radius + input.distance;
  const prims: Primitive[] = [];
  const inside = input.distance < 0;
  const end = add2(center, scale2(u, textR));
  let corners: Vec2[];
  let line: [Vec2, Vec2];
  if (input.kind === 'radius') {
    // Arrow inside the curve pointing out, unless the radius is too small for it.
    const tooSmall = radius < 2 * style.arrow.length && !inside;
    const start = tooSmall ? onCurve : center;
    prims.push({ kind: 'line', a: start, b: inside ? onCurve : end });
    prims.push(...arrowhead(onCurve, tooSmall ? scale2(u, -1) : u, style.arrow));
    line = [center, onCurve];
  } else {
    const opposite = sub2(center, scale2(u, radius));
    prims.push({ kind: 'line', a: opposite, b: inside ? onCurve : end });
    prims.push(...arrowhead(onCurve, u, style.arrow));
    prims.push(...arrowhead(opposite, scale2(u, -1), style.arrow));
    line = [opposite, onCurve];
  }
  if (inside) {
    const angle = style.textOrientation === 'aligned' ? readableAngle(u) : 0;
    const lab = placeLabel(
      input.label,
      add2(center, scale2(u, textR)),
      angle,
      style.textPosition,
      h,
    );
    prims.push(...lab.prims);
    corners = lab.corners;
  } else {
    // Horizontal landing towards the side the leader points to, text on (or in) it.
    const right = u[0] >= 0;
    const landing = input.label.width + 0.6 * h;
    const tip = add2(end, [right ? landing : -landing, 0]);
    prims.push({ kind: 'line', a: end, b: tip });
    const mid: Vec2 = [(end[0] + tip[0]) / 2, end[1]];
    const lab = placeLabel(input.label, mid, 0, 'above', h);
    prims.push(...lab.prims);
    corners = lab.corners;
  }
  return { prims, textBox: corners, line, arrowsOutside: false };
}

export interface AngularLayoutInput {
  vertex: Vec2;
  /** Unit directions of the two measured rays from the vertex. */
  a: Vec2;
  b: Vec2;
  /** Where the geometry ends along each ray (extension lines run beyond it). */
  extentA: number;
  extentB: number;
  radius: number;
  label: TextBlock;
  style: DimensionStyle;
  h: number;
  shift?: number;
}

/** Angle: an arc between the rays at `radius`, arrows at its ends, extension lines as needed. */
export function angularLayout(input: AngularLayoutInput): DimensionGeometry {
  const { style, h, vertex, radius } = input;
  let a0 = wrapAngle(angle2(input.a));
  let a1 = wrapAngle(angle2(input.b));
  let ext0 = input.extentA;
  let ext1 = input.extentB;
  let sweep = wrapAngle(a1 - a0);
  if (sweep > Math.PI) {
    [a0, a1] = [a1, a0];
    [ext0, ext1] = [ext1, ext0];
    sweep = TAU - sweep;
  }
  const prims: Primitive[] = [];
  const ray = (ang: number, r: number): Vec2 => add2(vertex, scale2(dir2(ang), r));
  // Extension lines along each ray when the arc lies beyond the geometry.
  for (const [ang, ext] of [
    [a0, ext0],
    [a1, ext1],
  ] as const) {
    if (radius > ext + style.extensionGap)
      prims.push({
        kind: 'line',
        a: ray(ang, ext + style.extensionGap),
        b: ray(ang, radius + style.extensionOvershoot),
      });
  }
  const arcLen = sweep * radius;
  const outside = arcLen < input.label.width + 2 * style.arrow.length;
  const stubAng = outside ? (style.arrow.length * 1.5) / radius : 0;
  prims.push({
    kind: 'arc',
    center: vertex,
    radius,
    start: a0 - stubAng,
    end: a0 + sweep + stubAng,
  });
  const t0 = dir2(a0 + Math.PI / 2);
  const t1 = dir2(a1 + Math.PI / 2);
  prims.push(...arrowhead(ray(a0, radius), outside ? t0 : scale2(t0, -1), style.arrow));
  prims.push(...arrowhead(ray(a1, radius), outside ? scale2(t1, -1) : t1, style.arrow));
  const mid = a0 + sweep / 2 + (input.shift ?? 0) / radius;
  const tangent = dir2(mid + Math.PI / 2);
  const textAngle = style.textOrientation === 'aligned' ? readableAngle(tangent) : 0;
  const lab = placeLabel(input.label, ray(mid, radius), textAngle, style.textPosition, h);
  prims.push(...lab.prims);
  return {
    prims,
    textBox: lab.corners,
    line: [ray(a0, radius), ray(a1, radius)],
    arrowsOutside: outside,
  };
}

export interface LeaderLayoutInput {
  /** The leader's start on the geometry. */
  attach: Vec2;
  /** Intermediate points (absolute, sheet). */
  bends: Vec2[];
  /** Where the landing starts (absolute). */
  text: Vec2;
  landing?: 'auto' | 'left' | 'right';
  /** Width of the content placed at the landing (0 = no landing line). */
  contentWidth: number;
  terminator: 'arrow' | 'dot' | 'none';
  style: DimensionStyle;
  h: number;
  /** All-around circle at the first bend (or the landing). */
  allAround?: boolean;
}

export interface LeaderGeometry {
  prims: Primitive[];
  /** Where the content's attach point goes, and which side of it the content extends to. */
  contentAt: Vec2;
  side: 'left' | 'right';
}

/** Leader: terminator at the geometry, polyline through the bends, horizontal landing. */
export function leaderLayout(input: LeaderLayoutInput): LeaderGeometry {
  const { style, h } = input;
  const pts = [input.attach, ...input.bends, input.text];
  const prev = pts[pts.length - 2] ?? input.attach;
  const side =
    input.landing === 'left' || input.landing === 'right'
      ? input.landing
      : input.text[0] >= prev[0]
        ? 'right'
        : 'left';
  const landing = input.contentWidth > 0 ? Math.min(2 * h, 6) : 0;
  const end: Vec2 = add2(input.text, [side === 'right' ? landing : -landing, 0]);
  const prims: Primitive[] = [{ kind: 'polyline', points: [...pts, end] }];
  const first = pts[1] ?? end;
  if (input.terminator === 'arrow' && dist2(first, input.attach) > 1e-9)
    prims.push(...arrowhead(input.attach, sub2(input.attach, first), style.arrow));
  if (input.terminator === 'dot')
    prims.push(
      ...arrowhead(input.attach, sub2(input.attach, first), { ...style.arrow, kind: 'dot' }),
    );
  if (input.allAround) {
    const at = input.bends[0] ?? input.text;
    const r = 0.3 * h * 2;
    prims.push({ kind: 'arc', center: at, radius: r / 2, start: 0, end: TAU });
  }
  return { prims, contentAt: end, side };
}
