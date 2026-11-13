/**
 * Pure navigation logic (no DOM, no three.js): the mouse/touch mapping state machine, the pivot
 * fallback rules, turntable/trackball rotation about a pivot and the rectangle tests behind
 * `pickRect`. The viewport feeds pointer samples in and applies the outputs to its camera.
 *
 * Left drag is never navigation (ADR-046): the app owns it. A secondary press that is released
 * inside the drag threshold is a click (`contextMenu`); beyond it the press navigates.
 */

import type { NavigationPreset, Vec3 } from '@wren-cad/contracts';
import {
  MENU_HOLD_MS,
  NAV_DRAG_PX,
  REPEAT_CLICK_MAX_MS,
  TAP_SLOP_PX,
  TURNTABLE_POLE_MARGIN,
} from './constants';

export type NavMode = 'orbit' | 'pan';

export interface Mods {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export const NO_MODS: Readonly<Mods> = { ctrl: false, shift: false, alt: false, meta: false };

export type ClickAction = 'menu' | 'menuRepeat' | 'setPivot';

export interface ButtonMap {
  /** What dragging with this button does, or null when it does not navigate. */
  drag: NavMode | null;
  /** What a click (release within the drag threshold) does, or null. */
  click: ClickAction | null;
}

const NONE: ButtonMap = { drag: null, click: null };

/**
 * Mouse button mapping per preset (button 0 = left never navigates, 1 = middle, 2 = right).
 * Right drag under `middleOrbit` pans and under `middlePan` orbits (the contract leaves right
 * drag open; see ADR-057).
 */
export function mapMouseButton(
  preset: NavigationPreset,
  button: number,
  mods: Mods = NO_MODS,
): ButtonMap {
  if (button !== 1 && button !== 2) return NONE;
  switch (preset) {
    case 'rightOrbit':
      return button === 2 ? { drag: 'orbit', click: 'menu' } : { drag: 'pan', click: null };
    case 'rightOrbitRepeat':
      return button === 2 ? { drag: 'orbit', click: 'menuRepeat' } : { drag: 'pan', click: null };
    case 'middleOrbit':
      if (button === 2) return { drag: 'pan', click: 'menu' };
      return mods.ctrl ? { drag: 'pan', click: null } : { drag: 'orbit', click: 'setPivot' };
    case 'middlePan':
      if (button === 2) return { drag: 'orbit', click: 'menu' };
      return mods.shift ? { drag: 'orbit', click: null } : { drag: 'pan', click: null };
  }
}

// ---- state machine ---------------------------------------------------------------------------

export type NavPointerKind = 'mouse' | 'pen' | 'touch';

export interface NavSample {
  type: 'down' | 'move' | 'up' | 'cancel';
  id: number;
  pointerType: NavPointerKind;
  button: number;
  /** Canvas-relative CSS px. */
  x: number;
  y: number;
  /** ms, monotonic. */
  t: number;
  mods?: Mods;
}

export type NavOutput =
  /** The drag crossed the threshold; (x, y) is where the press began (pick the pivot there). */
  | { type: 'begin'; mode: NavMode; x: number; y: number; pointerType: NavPointerKind }
  /** Pointer movement since the previous `drag` (or since the press, for the first one). */
  | { type: 'drag'; mode: NavMode; dx: number; dy: number }
  | { type: 'end'; mode: NavMode }
  | { type: 'click'; kind: 'contextMenu'; x: number; y: number; repeat: boolean }
  /** A middle click under `middleOrbit`; the host sets the pivot only if it hit geometry. */
  | { type: 'click'; kind: 'setPivot'; x: number; y: number; repeat: false };

interface Session {
  id: number;
  pointerType: NavPointerKind;
  button: number;
  map: ButtonMap;
  startX: number;
  startY: number;
  startT: number;
  lastX: number;
  lastY: number;
  begun: boolean;
}

export class NavigationMachine {
  private preset: NavigationPreset = 'rightOrbit';
  private session: Session | null = null;
  private readonly touches = new Set<number>();
  /** A second finger landed: navigation by this machine is off until every touch lifts. */
  private multiTouch = false;

  setPreset(preset: NavigationPreset): void {
    this.preset = preset;
  }

  /** The mode of the drag in progress, or null. */
  activeMode(): NavMode | null {
    return this.session?.begun ? this.session.map.drag : null;
  }

  /** True while a press that may still become a drag or a click is tracked. */
  tracking(): boolean {
    return this.session !== null;
  }

  handle(s: NavSample): NavOutput[] {
    const out: NavOutput[] = [];
    switch (s.type) {
      case 'down':
        this.down(s, out);
        break;
      case 'move':
        this.move(s, out);
        break;
      case 'up':
        this.up(s, out);
        break;
      case 'cancel':
        this.cancel(s, out);
        break;
    }
    return out;
  }

  /** Drop the session (long-press fired, focus lost, ...). */
  abort(out: NavOutput[] = []): NavOutput[] {
    const ss = this.session;
    this.session = null;
    if (ss?.begun && ss.map.drag) out.push({ type: 'end', mode: ss.map.drag });
    return out;
  }

  private down(s: NavSample, out: NavOutput[]): void {
    if (s.pointerType === 'touch') {
      this.touches.add(s.id);
      if (this.touches.size > 1) {
        this.multiTouch = true;
        this.abort(out);
        return;
      }
    }
    if (this.session || this.multiTouch) return; // a second button or pointer never restarts
    let map: ButtonMap;
    if (s.pointerType === 'mouse') {
      map = mapMouseButton(this.preset, s.button, s.mods ?? NO_MODS);
    } else {
      map = s.button === 0 ? { drag: 'orbit', click: null } : NONE;
    }
    if (!map.drag && !map.click) return;
    this.session = {
      id: s.id,
      pointerType: s.pointerType,
      button: s.button,
      map,
      startX: s.x,
      startY: s.y,
      startT: s.t,
      lastX: s.x,
      lastY: s.y,
      begun: false,
    };
  }

  private move(s: NavSample, out: NavOutput[]): void {
    const ss = this.session;
    if (!ss || ss.id !== s.id) return;
    if (!ss.begun) {
      const slop = ss.pointerType === 'touch' ? TAP_SLOP_PX : NAV_DRAG_PX;
      if (Math.hypot(s.x - ss.startX, s.y - ss.startY) <= slop) return;
      if (!ss.map.drag) {
        this.session = null; // click-only press that moved: neither a click nor a drag
        return;
      }
      ss.begun = true;
      out.push({
        type: 'begin',
        mode: ss.map.drag,
        x: ss.startX,
        y: ss.startY,
        pointerType: ss.pointerType,
      });
    }
    const mode = ss.map.drag as NavMode;
    const dx = s.x - ss.lastX;
    const dy = s.y - ss.lastY;
    ss.lastX = s.x;
    ss.lastY = s.y;
    if (dx !== 0 || dy !== 0) out.push({ type: 'drag', mode, dx, dy });
  }

  private up(s: NavSample, out: NavOutput[]): void {
    if (s.pointerType === 'touch') {
      this.touches.delete(s.id);
      if (this.touches.size === 0) this.multiTouch = false;
    }
    const ss = this.session;
    if (!ss || ss.id !== s.id) return;
    if (ss.pointerType === 'mouse' && s.button !== ss.button) return; // another button released
    this.session = null;
    if (ss.begun) {
      out.push({ type: 'end', mode: ss.map.drag as NavMode });
      return;
    }
    switch (ss.map.click) {
      case 'menu':
        out.push({ type: 'click', kind: 'contextMenu', x: s.x, y: s.y, repeat: false });
        break;
      case 'menuRepeat': {
        // Quick click: repeat the last command. Everything slower (the dead zone up to
        // MENU_HOLD_MS included) opens the menu.
        const repeat = s.t - ss.startT < Math.min(REPEAT_CLICK_MAX_MS, MENU_HOLD_MS);
        out.push({ type: 'click', kind: 'contextMenu', x: s.x, y: s.y, repeat });
        break;
      }
      case 'setPivot':
        out.push({ type: 'click', kind: 'setPivot', x: s.x, y: s.y, repeat: false });
        break;
      default:
        break;
    }
  }

  private cancel(s: NavSample, out: NavOutput[]): void {
    if (s.pointerType === 'touch') {
      this.touches.delete(s.id);
      if (this.touches.size === 0) this.multiTouch = false;
    }
    if (this.session && this.session.id === s.id) this.abort(out);
  }
}

// ---- pivot -----------------------------------------------------------------------------------

/** NDC x, y (on screen when both in [-1, 1]) and the distance along the view direction (<= 0: behind). */
export type PivotProjection = (p: Vec3) => {
  nx: number;
  ny: number;
  depth: number;
  /**
   * Whether the point is in front of the eye. Defaults to `depth > 0`; an orthographic camera sets
   * it itself, since there points behind the camera plane are still drawn (ADR-098).
   */
  front?: boolean;
};

export interface PivotInput {
  mode: 'cursor' | 'center';
  /** Surface point under the pointer, or null on a miss. */
  hit: Vec3 | null;
  /** A pivot set by a middle click (`middleOrbit`); only used while still in view. */
  override: Vec3 | null;
  /** Centre of the visible bodies' bounds, or null when nothing is visible. */
  center: Vec3 | null;
  /** Surface under the viewport centre (lazy: only asked when the centre is not usable). */
  centerHit: () => Vec3 | null;
  project: PivotProjection;
  cameraPosition: Vec3;
  /** Unit view direction. */
  forward: Vec3;
  /** Distance used when there is nothing better (the controls' current distance). */
  fallbackDistance: number;
}

export type PivotSource = 'surface' | 'override' | 'center' | 'screenCenter' | 'axis';

export interface PivotResult {
  point: Vec3;
  source: PivotSource;
}

const EYE = 1e-6;

const finite = (p: Vec3 | null): p is Vec3 =>
  p !== null && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

/**
 * The orbit pivot (ADR-046). Cursor mode: the surface point under the pointer; on a miss a
 * still-visible `override`, then the visible bodies' centre if it is in front of the camera and
 * on screen, then the surface at the viewport centre, then a point on the view axis (at the
 * centre's depth when that is in front). Never behind the camera, never a stale target.
 * Centre mode always uses the bodies' centre (unless it is behind the camera).
 */
export function resolvePivot(i: PivotInput): PivotResult {
  const front = (q: ReturnType<PivotProjection>) => q.front ?? q.depth > EYE;
  const inView = (p: Vec3 | null): p is Vec3 => {
    if (!finite(p)) return false;
    const q = i.project(p);
    return front(q) && Math.abs(q.nx) <= 1 && Math.abs(q.ny) <= 1;
  };
  const inFront = (p: Vec3 | null): p is Vec3 => finite(p) && front(i.project(p));
  if (i.mode === 'center') {
    if (inFront(i.center)) return { point: i.center, source: 'center' };
  } else {
    if (inFront(i.hit)) return { point: i.hit, source: 'surface' };
    if (inView(i.override)) return { point: i.override, source: 'override' };
    if (inView(i.center)) return { point: i.center, source: 'center' };
    const ch = i.centerHit();
    if (inFront(ch)) return { point: ch, source: 'screenCenter' };
  }
  let depth = i.fallbackDistance > EYE ? i.fallbackDistance : 1;
  if (finite(i.center)) {
    const q = i.project(i.center);
    if (front(q)) depth = q.depth;
  }
  const c = i.cameraPosition;
  const f = i.forward;
  return {
    point: [c[0] + f[0] * depth, c[1] + f[1] * depth, c[2] + f[2] * depth],
    source: 'axis',
  };
}

// ---- rotation about a pivot ------------------------------------------------------------------

export interface Pose {
  pos: Vec3;
  /** Unit view direction. */
  fwd: Vec3;
  /** Unit camera up, perpendicular to `fwd`. */
  up: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rodrigues rotation of vector `v` about unit `axis` by `angle`. */
export function rotateVec(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

/** Rigid rotation of the whole camera pose about `axis` through `pivot`. */
export function rotatePose(p: Pose, pivot: Vec3, axis: Vec3, angle: number): Pose {
  const rel: Vec3 = [p.pos[0] - pivot[0], p.pos[1] - pivot[1], p.pos[2] - pivot[2]];
  const r = rotateVec(rel, axis, angle);
  return {
    pos: [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]],
    fwd: rotateVec(p.fwd, axis, angle),
    up: rotateVec(p.up, axis, angle),
  };
}

/** Re-orthonormalise after many incremental rotations. */
export function orthonormalize(p: Pose): Pose {
  const fwd = norm(p.fwd);
  const d = dot(p.up, fwd);
  const up = norm([p.up[0] - fwd[0] * d, p.up[1] - fwd[1] * d, p.up[2] - fwd[2] * d]);
  return { pos: p.pos, fwd, up };
}

/**
 * Turntable orbit: yaw about the world up axis and pitch about the horizontal right axis, both
 * through `pivot`; pitch stops short of the poles. `k` is radians per pixel (it already includes
 * the speed gain). Dragging right turns the model to the right; dragging down looks from above.
 */
export function orbitTurntable(
  pose: Pose,
  pivot: Vec3,
  worldUp: Vec3,
  dx: number,
  dy: number,
  k: number,
): Pose {
  const up = norm(worldUp);
  let p = pose;
  const e = Math.asin(Math.max(-1, Math.min(1, dot(norm(p.fwd), up))));
  const max = Math.PI / 2 - TURNTABLE_POLE_MARGIN;
  // The camera moving up (drag down) tilts the view down: elevation of the view falls.
  let target = e - dy * k;
  // Only stop further travel into the pole zone; never yank a camera that is already there.
  target = Math.min(target, Math.max(max, e));
  target = Math.max(target, Math.min(-max, e));
  const pitch = target - e;
  if (pitch !== 0) {
    let right = cross(norm(p.fwd), up);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = cross(norm(p.fwd), p.up);
    p = rotatePose(p, pivot, norm(right), pitch);
  }
  if (dx !== 0) p = rotatePose(p, pivot, up, -dx * k);
  return orthonormalize(p);
}

/** Trackball orbit: free rotation about the camera's own up and right axes through `pivot`. */
export function orbitTrackball(pose: Pose, pivot: Vec3, dx: number, dy: number, k: number): Pose {
  let p = orthonormalize(pose);
  if (dy !== 0) p = rotatePose(p, pivot, norm(cross(p.fwd, p.up)), -dy * k);
  if (dx !== 0) p = rotatePose(p, pivot, norm(p.up), -dx * k);
  return orthonormalize(p);
}

// ---- rectangle tests (pickRect) --------------------------------------------------------------

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Normalise corner order. */
export function normalizeRect(r: Rect): Rect {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

export const pointInRect = (x: number, y: number, r: Rect): boolean =>
  x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Liang-Barsky: does the segment touch the rectangle? */
export function segmentTouchesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dy, ay - r.y0) && clip(dy, r.y1 - ay);
}

/** Does the screen-space triangle overlap the rectangle (area overlap or touch)? */
export function triangleTouchesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: Rect,
): boolean {
  if (Math.max(ax, bx, cx) < r.x0 || Math.min(ax, bx, cx) > r.x1) return false;
  if (Math.max(ay, by, cy) < r.y0 || Math.min(ay, by, cy) > r.y1) return false;
  if (pointInRect(ax, ay, r) || pointInRect(bx, by, r) || pointInRect(cx, cy, r)) return true;
  if (
    segmentTouchesRect(ax, ay, bx, by, r) ||
    segmentTouchesRect(bx, by, cx, cy, r) ||
    segmentTouchesRect(cx, cy, ax, ay, r)
  ) {
    return true;
  }
  // No vertex inside and no edge crossing: the rectangle may sit wholly inside the triangle.
  const side = (px: number, py: number, qx: number, qy: number, sx: number, sy: number) =>
    (px - sx) * (qy - sy) - (qx - sx) * (py - sy);
  const d1 = side(r.x0, r.y0, ax, ay, bx, by);
  const d2 = side(r.x0, r.y0, bx, by, cx, cy);
  const d3 = side(r.x0, r.y0, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Polyline (interleaved screen xy; NaN x = behind the camera) vs the rectangle. */
export function polylineVsRect(
  pts: ArrayLike<number>,
  count: number,
  r: Rect,
): { inside: boolean; touches: boolean } {
  let inside = count > 0;
  let touches = false;
  for (let i = 0; i < count; i++) {
    const x = pts[2 * i] as number;
    const y = pts[2 * i + 1] as number;
    if (Number.isNaN(x)) {
      inside = false;
      continue;
    }
    if (pointInRect(x, y, r)) touches = true;
    else inside = false;
    if (i > 0 && !touches) {
      const px = pts[2 * i - 2] as number;
      const py = pts[2 * i - 1] as number;
      if (!Number.isNaN(px) && segmentTouchesRect(px, py, x, y, r)) touches = true;
    }
  }
  return { inside, touches };
}

/**
 * Count ID-buffer pixels per id inside the inclusive pixel box `[x0, x1] x [y0, y1]` (image
 * coordinates, row 0 at the top). `counts` is indexed by id. When `firstX` / `firstY` are given,
 * the first pixel seen per id is recorded.
 */
export function countIdPixels(
  data: ArrayLike<number>,
  w: number,
  h: number,
  flipY: boolean,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  counts: Uint32Array,
  firstX?: Int32Array,
  firstY?: Int32Array,
): void {
  const xa = Math.max(0, x0);
  const xb = Math.min(w - 1, x1);
  const ya = Math.max(0, y0);
  const yb = Math.min(h - 1, y1);
  const max = counts.length - 1;
  for (let y = ya; y <= yb; y++) {
    const row = flipY ? h - 1 - y : y;
    let o = (row * w + xa) * 4;
    for (let x = xa; x <= xb; x++, o += 4) {
      const id =
        ((data[o] as number) << 16) | ((data[o + 1] as number) << 8) | (data[o + 2] as number);
      if (id === 0 || id > max) continue;
      if (firstX && firstY && counts[id] === 0) {
        firstX[id] = x;
        firstY[id] = y;
      }
      counts[id] = (counts[id] as number) + 1;
    }
  }
}
