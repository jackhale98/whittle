/**
 * View frames: orientation, in-plane rotation and the parent chain → `{ x, y }` for
 * `ViewProjectionRequest` (ADR-090 §3.5). Part coordinates are Z-up with Front looking along +Y
 * (the viewport's `VIEW_DIRECTIONS`); a frame's `n = x × y` points towards the viewer.
 *
 * Projected and section views turn the parent's frame 90° about the in-plane axis perpendicular
 * to the side the viewer moves to, so a child of a rotated parent re-derives from it (T5). The
 * sheet side of an aligned child follows the drawing's projection (first/third angle), so
 * switching projection moves views with no edits (decision 9).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IsoCorner, Projection, Vec2, Vec3, ViewOrientation } from '@wren-cad/contracts';
import { add3, cross3, dot3, norm3, scale3, sub3 } from '../annotation/geom';

export interface ViewFrame {
  /** View right, part coordinates (unit). */
  x: Vec3;
  /** View up (unit). */
  y: Vec3;
  /** Towards the viewer: x × y. The viewer looks along −n. */
  n: Vec3;
}

export function frameOf(x: Vec3, y: Vec3): ViewFrame {
  return { x, y, n: cross3(x, y) };
}

/** Standard drawing frames per named view (ISO 128-30 / ASME Y14.3 conventions, Z up). */
const NAMED: Record<
  Exclude<ViewOrientation, { kind: 'isometric' | 'matrix' }>['name'],
  [Vec3, Vec3]
> = {
  front: [
    [1, 0, 0],
    [0, 0, 1],
  ],
  back: [
    [-1, 0, 0],
    [0, 0, 1],
  ],
  right: [
    [0, 1, 0],
    [0, 0, 1],
  ],
  left: [
    [0, -1, 0],
    [0, 0, 1],
  ],
  // Top: looking down, the back of the part at the top of the sheet.
  top: [
    [1, 0, 0],
    [0, 1, 0],
  ],
  bottom: [
    [1, 0, 0],
    [0, -1, 0],
  ],
};

/** Rotates `v` by +90° about the unit axis `a` (Rodrigues with cos 0, sin 1). */
function quarterTurn(v: Vec3, a: Vec3): Vec3 {
  return add3(scale3(a, dot3(a, v)), cross3(a, v));
}

/**
 * The frame seen when the viewer moves round the part to the side `s` of the parent (a unit
 * vector in the parent's view plane: (0, 1) = top). The parent's n turns into s.
 */
export function sideFrame(parent: ViewFrame, s: Vec2): ViewFrame {
  const s3 = norm3(add3(scale3(parent.x, s[0]), scale3(parent.y, s[1])));
  const axis = norm3(cross3(parent.n, s3));
  const x = norm3(quarterTurn(parent.x, axis));
  const y = norm3(quarterTurn(parent.y, axis));
  return frameOf(x, y);
}

export type ViewSide = 'top' | 'bottom' | 'left' | 'right';

export const SIDE_VECTORS: Readonly<Record<ViewSide, Vec2>> = {
  top: [0, 1],
  bottom: [0, -1],
  right: [1, 0],
  left: [-1, 0],
};

/** Iso frame from a frame's corner: the viewer at (±x ± y + n), the parent's up kept upright. */
export function isoFrame(parent: ViewFrame, corner: IsoCorner): ViewFrame {
  const sx = corner === 'topRight' || corner === 'bottomRight' ? 1 : -1;
  const sy = corner === 'topLeft' || corner === 'topRight' ? 1 : -1;
  const n = norm3(add3(add3(scale3(parent.x, sx), scale3(parent.y, sy)), parent.n));
  const y = norm3(sub3(parent.y, scale3(n, dot3(parent.y, n))));
  const x = norm3(cross3(y, n));
  return { x, y, n };
}

const FRONT = frameOf([1, 0, 0], [0, 0, 1]);

export function orientationFrame(o: ViewOrientation): ViewFrame {
  switch (o.kind) {
    case 'named': {
      const [x, y] = NAMED[o.name];
      return frameOf(x, y);
    }
    case 'isometric':
      return isoFrame(FRONT, o.corner);
    case 'matrix': {
      // Re-orthonormalise (Gram–Schmidt): stored vectors are rounded.
      const x = norm3(o.x);
      const y = norm3(sub3(o.y, scale3(x, dot3(o.y, x))));
      return frameOf(x, y);
    }
  }
}

/** In-plane rotation: the view's content turns CCW by `angle` (rad) on the sheet. */
export function rotateFrame(f: ViewFrame, angle: number): ViewFrame {
  if (angle === 0) return f;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = norm3(sub3(scale3(f.x, c), scale3(f.y, s)));
  const y = norm3(add3(scale3(f.x, s), scale3(f.y, c)));
  return { x, y, n: f.n };
}

/**
 * Sheet direction from a parent to an aligned child seen from side `s` of it: third angle puts
 * the view on the side it is seen from, first angle on the opposite side.
 */
export function alignedDirection(s: Vec2, projection: Projection): Vec2 {
  return projection === 'third' ? [s[0], s[1]] : [-s[0], -s[1]];
}

/** Part point → view plane (part mm, origin at the projected part origin). */
export function projectToView(f: ViewFrame, p: Vec3): Vec2 {
  return [dot3(p, f.x), dot3(p, f.y)];
}

/** View-plane point (of this frame) → part coordinates on the plane through the origin. */
export function viewToPart(f: ViewFrame, p: Vec2): Vec3 {
  return add3(scale3(f.x, p[0]), scale3(f.y, p[1]));
}

/** Projected centre and extent of a 3D box (its 8 corners), view-plane part mm. */
export function projectBounds(
  f: ViewFrame,
  b: { min: Vec3; max: Vec3 },
): { min: Vec2; max: Vec2; center: Vec2 } {
  let minU = Number.POSITIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [
      i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2],
    ];
    const [u, v] = projectToView(f, p);
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }
  return {
    min: [minU, minV],
    max: [maxU, maxV],
    center: [(minU + maxU) / 2, (minV + maxV) / 2],
  };
}
