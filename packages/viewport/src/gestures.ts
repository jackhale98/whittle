/**
 * Pure pointer-gesture state machine (no DOM, no timers). The viewport feeds it normalised pointer
 * events and calls `tick(now)` at `nextDeadline()`; it returns what happened:
 *
 * - discrete `gesture` outputs (tap, doubleTap, longPress, twoFingerTap, threeFingerTap),
 * - `twist` deltas for two-finger roll,
 * - `releaseNavigation` when a long-press fired and the camera must let go of that pointer.
 *
 * Rules (PLAN §9.3): a gesture that moved (drag, pinch) never ends in a tap; a long-press fires
 * only for a stationary single pointer; with `penDraws` pen pointers are ignored (the app handles
 * them) but still arm palm rejection, which suppresses every touch gesture while a pen is in
 * contact and for `palmRejectMs` after. A second tap inside the double-tap window yields
 * `doubleTap` instead of a second `tap`.
 */

import type { InputPolicy, ViewportGesture } from '@wren-cad/contracts';
import {
  DEFAULT_PALM_REJECT_MS,
  DOUBLE_TAP_MAX_MS,
  DOUBLE_TAP_SLOP_PX,
  LONG_PRESS_MS,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  TWIST_START_RAD,
} from './constants';

export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface PointerSample {
  type: 'down' | 'move' | 'up' | 'cancel';
  id: number;
  pointerType: PointerKind;
  /** Canvas-relative CSS px. */
  x: number;
  y: number;
  /** Milliseconds, any monotonic clock shared with `tick`. */
  t: number;
  /** Mouse/pen button that changed (0 = primary). Non-primary buttons never form gestures. */
  button?: number;
  /** The pointer went down on a handle: the app drags it, so it never forms gestures. */
  onHandle?: boolean;
}

export type GestureOutput =
  | { type: 'gesture'; gesture: ViewportGesture }
  | { type: 'twist'; delta: number }
  | { type: 'releaseNavigation'; id: number };

interface Tracked {
  id: number;
  pointerType: PointerKind;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

interface Session {
  startT: number;
  maxPointers: number;
  moved: boolean;
  /** Positions at first contact of every pointer in the session (for the centroid). */
  starts: Array<{ x: number; y: number }>;
  longPressDone: boolean;
  /** Palm rejection was active when the session began, or a pen touched down during it. */
  rejected: boolean;
  pointerType: PointerKind;
}

export class GestureRecognizer {
  private policy: Required<InputPolicy> = { penDraws: false, palmRejectMs: DEFAULT_PALM_REJECT_MS };
  private readonly pointers = new Map<number, Tracked>();
  private readonly penDown = new Set<number>();
  private lastPenT = Number.NEGATIVE_INFINITY;
  private session: Session | null = null;
  private lastTap: { x: number; y: number; t: number; pointerType: PointerKind } | null = null;
  /** Deadline (ms) for the pending long-press, or null. */
  private longPressAt: number | null = null;
  // twist
  private prevAngle: number | null = null;
  private twistAcc = 0;
  private twisting = false;

  setPolicy(policy: InputPolicy): void {
    this.policy = {
      penDraws: policy.penDraws,
      palmRejectMs: policy.palmRejectMs ?? DEFAULT_PALM_REJECT_MS,
    };
  }

  getPolicy(): Readonly<Required<InputPolicy>> {
    return this.policy;
  }

  /** True when this pointer type must not drive the camera (the app handles it). */
  blocksCamera(pointerType: PointerKind): boolean {
    return this.policy.penDraws && pointerType === 'pen';
  }

  /** True while touch gestures are suppressed by palm rejection at time `t`. */
  palmRejected(t: number): boolean {
    if (!this.policy.penDraws) return false;
    return this.penDown.size > 0 || t - this.lastPenT < this.policy.palmRejectMs;
  }

  /** Time (same clock as events) at which `tick` must be called next, or null. */
  nextDeadline(): number | null {
    return this.longPressAt;
  }

  handle(e: PointerSample): GestureOutput[] {
    const out: GestureOutput[] = [];
    if (e.pointerType === 'pen' && this.policy.penDraws) {
      this.handlePen(e);
      return out;
    }
    switch (e.type) {
      case 'down':
        this.down(e);
        break;
      case 'move':
        this.move(e, out);
        break;
      case 'up':
        this.up(e, out);
        break;
      case 'cancel':
        this.cancel(e);
        break;
    }
    return out;
  }

  /** Advance time: fires a due long-press. */
  tick(now: number): GestureOutput[] {
    const out: GestureOutput[] = [];
    if (this.longPressAt === null || now < this.longPressAt) return out;
    this.longPressAt = null;
    const s = this.session;
    if (!s || s.moved || s.maxPointers !== 1 || this.pointers.size !== 1) return out;
    const p = [...this.pointers.values()][0] as Tracked;
    s.longPressDone = true;
    if (!s.rejected && !this.palmRejected(now)) {
      out.push({
        type: 'gesture',
        gesture: {
          kind: 'longPress',
          x: p.x,
          y: p.y,
          pointerType: p.pointerType,
          pointerId: p.id,
        },
      });
    }
    // The held pointer must not start orbiting afterwards, whether or not the app saw the press.
    out.push({ type: 'releaseNavigation', id: p.id });
    return out;
  }

  // -------------------------------------------------------------------------------------------

  private handlePen(e: PointerSample): void {
    if (e.type === 'down') {
      this.penDown.add(e.id);
      this.lastPenT = e.t;
      if (this.session) this.session.rejected = true;
      this.longPressAt = null;
    } else if (e.type === 'up' || e.type === 'cancel') {
      this.penDown.delete(e.id);
      this.lastPenT = e.t;
    } else if (this.penDown.size > 0) {
      this.lastPenT = e.t; // a stroke in progress keeps the window open
    }
  }

  private down(e: PointerSample): void {
    if (e.onHandle || (e.pointerType !== 'touch' && (e.button ?? 0) !== 0)) {
      this.lastTap = null; // not part of a gesture, but it breaks a double-tap sequence
      return;
    }
    if (!this.session) {
      this.session = {
        startT: e.t,
        maxPointers: 0,
        moved: false,
        starts: [],
        longPressDone: false,
        rejected: this.palmRejected(e.t),
        pointerType: e.pointerType,
      };
    }
    const s = this.session;
    this.pointers.set(e.id, {
      id: e.id,
      pointerType: e.pointerType,
      startX: e.x,
      startY: e.y,
      x: e.x,
      y: e.y,
    });
    s.starts.push({ x: e.x, y: e.y });
    s.maxPointers = Math.max(s.maxPointers, this.pointers.size);
    // A long-press needs one stationary non-mouse pointer; extra fingers cancel it.
    this.longPressAt =
      this.pointers.size === 1 && e.pointerType !== 'mouse' && !s.rejected
        ? e.t + LONG_PRESS_MS
        : null;
    this.resetTwist();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Tracked, Tracked];
      if (a.pointerType === 'touch' && b.pointerType === 'touch') {
        this.prevAngle = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
  }

  private move(e: PointerSample, out: GestureOutput[]): void {
    const p = this.pointers.get(e.id);
    if (!p) return;
    p.x = e.x;
    p.y = e.y;
    if (this.session && !this.session.moved) {
      if (Math.hypot(p.x - p.startX, p.y - p.startY) > TAP_SLOP_PX) {
        this.session.moved = true;
        this.longPressAt = null;
        this.lastTap = null;
      }
    }
    this.updateTwist(out);
  }

  private up(e: PointerSample, out: GestureOutput[]): void {
    const p = this.pointers.get(e.id);
    if (!p) return;
    p.x = e.x;
    p.y = e.y;
    if (this.session && Math.hypot(p.x - p.startX, p.y - p.startY) > TAP_SLOP_PX) {
      this.session.moved = true;
    }
    this.pointers.delete(e.id);
    this.resetTwist();
    const s = this.session;
    if (!s || this.pointers.size > 0) return; // wait for the last finger
    this.session = null;
    this.longPressAt = null;
    if (s.moved || s.longPressDone || s.rejected || this.palmRejected(e.t)) {
      this.lastTap = null;
      return;
    }
    if (e.t - s.startT > TAP_MAX_MS) {
      this.lastTap = null;
      return;
    }
    const cx = s.starts.reduce((a, b) => a + b.x, 0) / s.starts.length;
    const cy = s.starts.reduce((a, b) => a + b.y, 0) / s.starts.length;
    const pointerType = s.pointerType;
    const emit = (kind: ViewportGesture['kind']) =>
      out.push({ type: 'gesture', gesture: { kind, x: cx, y: cy, pointerType } });
    if (s.maxPointers === 1) {
      const lt = this.lastTap;
      if (
        lt &&
        lt.pointerType === pointerType &&
        e.t - lt.t <= DOUBLE_TAP_MAX_MS &&
        Math.hypot(cx - lt.x, cy - lt.y) <= DOUBLE_TAP_SLOP_PX
      ) {
        this.lastTap = null;
        emit('doubleTap');
      } else {
        this.lastTap = { x: cx, y: cy, t: e.t, pointerType };
        emit('tap');
      }
    } else if (s.maxPointers === 2) {
      this.lastTap = null;
      emit('twoFingerTap');
    } else if (s.maxPointers === 3) {
      this.lastTap = null;
      emit('threeFingerTap');
    }
  }

  private cancel(e: PointerSample): void {
    this.pointers.delete(e.id);
    this.resetTwist();
    this.lastTap = null;
    if (this.pointers.size === 0) {
      this.session = null;
      this.longPressAt = null;
    } else if (this.session) {
      this.session.moved = true; // a cancelled finger spoils the multi-finger tap
      this.longPressAt = null;
    }
  }

  // ---- twist -----------------------------------------------------------------------------

  private resetTwist(): void {
    this.prevAngle = null;
    this.twistAcc = 0;
    this.twisting = false;
  }

  private updateTwist(out: GestureOutput[]): void {
    if (this.pointers.size !== 2) return;
    const [a, b] = [...this.pointers.values()] as [Tracked, Tracked];
    if (a.pointerType !== 'touch' || b.pointerType !== 'touch') return;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (this.prevAngle === null) {
      this.prevAngle = angle;
      return;
    }
    let d = angle - this.prevAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    this.prevAngle = angle;
    if (!this.twisting) {
      this.twistAcc += d;
      if (Math.abs(this.twistAcc) >= TWIST_START_RAD) this.twisting = true;
      return; // the crossing move emits nothing, so the roll starts without a jump
    }
    if (d !== 0) out.push({ type: 'twist', delta: d });
  }
}
