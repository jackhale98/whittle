// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Resolving a drawing view's frame and sheet position from stored intent (ADR-090). Pure math, no
 * geometry. Used by `removeViews { dependents: 'detach' }`, which must turn a child into a base
 * view with "the same resolved orientation and position".
 *
 * Conventions (Z-up, as the viewport): a frame is `x` (right), `y` (up) and `n = x × y`, the
 * direction towards the viewer. `front` has n = −Y, x = X, y = Z.
 *
 * Section views are not resolved here (their frame follows the cut line and may follow geometry);
 * `resolveViewFrame` reports that instead of guessing.
 */

import type {
  Drawing,
  DrawingView,
  Id,
  IsoCorner,
  Projection,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';

export interface ViewFrame {
  x: Vec3;
  y: Vec3;
  /** Towards the viewer: x × y. */
  n: Vec3;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const neg = (a: Vec3): Vec3 => scale(a, -1);
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
/** Removes −0 so equal frames serialise equally. */
const clean = (a: Vec3): Vec3 => [a[0] + 0, a[1] + 0, a[2] + 0];

const frameOf = (y: Vec3, n: Vec3): ViewFrame => {
  const x = cross(y, n);
  return { x: clean(x), y: clean(y), n: clean(n) };
};

const Z: Vec3 = [0, 0, 1];
const NAMED: Record<string, ViewFrame> = {
  front: frameOf(Z, [0, -1, 0]),
  back: frameOf(Z, [0, 1, 0]),
  left: frameOf(Z, [-1, 0, 0]),
  right: frameOf(Z, [1, 0, 0]),
  top: frameOf([0, 1, 0], Z),
  bottom: frameOf([0, -1, 0], [0, 0, -1]),
};

const sameVec = (a: Vec3, b: Vec3): boolean =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) < 1e-12);

/** The standard view name this frame is, if it is exactly one. */
export function namedViewOf(f: ViewFrame): keyof typeof NAMED | undefined {
  return (Object.keys(NAMED) as (keyof typeof NAMED)[]).find((k) => {
    const n = NAMED[k] as ViewFrame;
    return sameVec(n.x, f.x) && sameVec(n.y, f.y);
  });
}

/** The isometric frame seen from a corner of `parent` (towards the viewer). */
function isoFrame(parent: ViewFrame, corner: IsoCorner): ViewFrame {
  const sx = corner.endsWith('Right') ? 1 : -1;
  const sy = corner.startsWith('top') ? 1 : -1;
  const n = unit(add(add(scale(parent.x, sx), scale(parent.y, sy)), parent.n));
  const up = unit(add(parent.y, scale(n, -dot(parent.y, n))));
  return frameOf(up, n);
}

/** Rotates a frame in its own plane, counter-clockwise by `rad` (content turns CCW on the sheet). */
function rotated(f: ViewFrame, rad: number): ViewFrame {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const x = add(scale(f.x, c), scale(f.y, -s));
  const y = add(scale(f.x, s), scale(f.y, c));
  return { x: clean(x), y: clean(y), n: f.n };
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

const byIdMap = (views: readonly DrawingView[]): Map<Id, DrawingView> =>
  new Map(views.map((v) => [v.id, v]));

/**
 * The frame of a view. `angleOf` evaluates a rotation expression to radians (or undefined when it
 * does not evaluate).
 */
export function resolveViewFrame(
  views: readonly DrawingView[],
  viewId: Id,
  angleOf: (expr: string) => number | undefined,
): Resolved<ViewFrame> {
  const map = byIdMap(views);
  const walk = (id: Id, depth: number): Resolved<ViewFrame> => {
    const v = map.get(id);
    if (!v) return { ok: false, reason: 'a parent view is missing' };
    if (depth > views.length) return { ok: false, reason: 'the views form a loop' };
    if (v.kind === 'base') {
      let f: ViewFrame;
      const o = v.orientation;
      if (o.kind === 'named') f = NAMED[o.name] as ViewFrame;
      else if (o.kind === 'isometric') f = isoFrame(NAMED.front as ViewFrame, o.corner);
      else f = frameOf(unit(o.y), cross(unit(o.x), unit(o.y)));
      if (v.rotation !== undefined) {
        const a = angleOf(v.rotation);
        if (a === undefined) return { ok: false, reason: 'its rotation does not evaluate' };
        f = rotated(f, a);
      }
      return { ok: true, value: f };
    }
    const parent = walk(v.parentId, depth + 1);
    if (!parent.ok) return parent;
    const p = parent.value;
    switch (v.kind) {
      case 'detail':
        return { ok: true, value: p };
      case 'iso':
        return { ok: true, value: isoFrame(p, v.corner) };
      case 'section':
        return { ok: false, reason: 'a section view’s orientation follows its cut line' };
      case 'projected':
        switch (v.from) {
          case 'top':
            return { ok: true, value: frameOf(neg(p.n), p.y) };
          case 'bottom':
            return { ok: true, value: frameOf(p.n, neg(p.y)) };
          case 'left':
            return { ok: true, value: frameOf(p.y, neg(p.x)) };
          case 'right':
            return { ok: true, value: frameOf(p.y, p.x) };
        }
    }
  };
  return walk(viewId, 0);
}

/** Where a projected view of side `from` sits relative to its parent on the sheet. */
export function sheetDirection(
  from: 'top' | 'bottom' | 'left' | 'right',
  projection: Projection,
): Vec2 {
  const third: Record<typeof from, Vec2> = {
    top: [0, 1],
    bottom: [0, -1],
    left: [-1, 0],
    right: [1, 0],
  };
  const d = third[from];
  return projection === 'third' ? d : [-d[0], -d[1]];
}

/** The sheet position of a view's centre, following aligned layouts up the parent chain. */
export function resolveViewPosition(drawing: Drawing, viewId: Id): Resolved<Vec2> {
  const map = byIdMap(drawing.views);
  const walk = (id: Id, depth: number): Resolved<Vec2> => {
    const v = map.get(id);
    if (!v) return { ok: false, reason: 'a parent view is missing' };
    if (depth > drawing.views.length) return { ok: false, reason: 'the views form a loop' };
    if (v.layout.kind === 'free') return { ok: true, value: v.layout.position };
    if (v.kind !== 'projected') {
      return { ok: false, reason: 'a section view’s position follows its cut line' };
    }
    const parent = walk(v.parentId, depth + 1);
    if (!parent.ok) return parent;
    const d = sheetDirection(v.from, drawing.projection);
    return {
      ok: true,
      value: [
        parent.value[0] + d[0] * v.layout.distance,
        parent.value[1] + d[1] * v.layout.distance,
      ],
    };
  };
  return walk(viewId, 0);
}
