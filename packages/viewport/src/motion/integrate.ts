/**
 * Pure 3D mouse motion integration (no DOM, no three.js; ADR-096): rate x dt with dt capped, the
 * start and end of a motion session, and the wheel double-count rule.
 */

import type { MotionSample } from '@wren-cad/contracts';

/** dt cap: a stalled tab or a late report must not jump the camera. */
export const MOTION_MAX_DT_S = 0.05;
/** No sample for this long ends a session (a device that went quiet without a zero report). */
export const MOTION_TIMEOUT_MS = 250;
/** Full-deflection speeds. Translation pans one view width per second (see `applyMotion`). */
export const MOTION_PAN_VIEWS_PER_S = 1;
/** Full rotation deflection, radians per second (about 115 degrees), times `rotateSpeed`. */
export const MOTION_ROTATE_RAD_PER_S = 2;
/** Full push/pull, e-folds of the distance to the zoom anchor per second (about 3.3x per second). */
export const MOTION_ZOOM_PER_S = 1.2;
/** A wheel event this soon after 3D mouse motion, without pointer movement, is the driver's echo. */
export const MOTION_WHEEL_ECHO_MS = 100;

export const isZeroSample = (s: MotionSample): boolean =>
  s.t[0] === 0 && s.t[1] === 0 && s.t[2] === 0 && s.r[0] === 0 && s.r[1] === 0 && s.r[2] === 0;

/** Integrated rate x time since the last `take()`, in device-screen axes (rate-seconds). */
export interface MotionDelta {
  t: [number, number, number];
  r: [number, number, number];
}

const zeroDelta = (): MotionDelta => ({ t: [0, 0, 0], r: [0, 0, 0] });

export function isZeroDelta(d: MotionDelta): boolean {
  return d.t.every((v) => v === 0) && d.r.every((v) => v === 0);
}

export class MotionIntegrator {
  private prevTime = 0;
  private pending: MotionDelta = zeroDelta();
  private running = false;
  private ended = false;

  /** A session is a run of non-zero samples; it ends at the first zero sample or a timeout. */
  get active(): boolean {
    return this.running;
  }

  /**
   * Feeds one sample. The rate of a sample applies to the time since the previous sample, capped
   * at `MOTION_MAX_DT_S`; the first sample of a session only starts the clock.
   * Returns whether it started or ended a session.
   */
  push(s: MotionSample): { started: boolean; ended: boolean } {
    const zero = isZeroSample(s);
    if (!this.running) {
      if (zero) return { started: false, ended: false };
      this.running = true;
      this.ended = false;
      this.prevTime = s.time;
      return { started: true, ended: false };
    }
    const raw = (s.time - this.prevTime) / 1000;
    const dt = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MOTION_MAX_DT_S) : 0;
    this.prevTime = s.time;
    for (let i = 0; i < 3; i++) {
      (this.pending.t[i] as number) += (s.t[i] as number) * dt;
      (this.pending.r[i] as number) += (s.r[i] as number) * dt;
    }
    if (zero) {
      this.running = false;
      this.ended = true;
      return { started: false, ended: true };
    }
    return { started: false, ended: false };
  }

  /** Ends a session without a zero sample (timeout, a pointer gesture took over). */
  stop(): void {
    this.running = false;
    this.ended = true;
  }

  /** True once after a session ended, so the caller can finish up after applying the delta. */
  consumeEnded(): boolean {
    const e = this.ended;
    this.ended = false;
    return e;
  }

  /** The integrated amounts since the previous call. */
  take(): MotionDelta {
    const d = this.pending;
    this.pending = zeroDelta();
    return d;
  }

  reset(): void {
    this.running = false;
    this.ended = false;
    this.pending = zeroDelta();
  }
}

/**
 * ADR-096 item 3: a vendor driver that also emulates the wheel from push/pull would zoom twice.
 * Drop a wheel event that comes within `MOTION_WHEEL_ECHO_MS` of 3D mouse motion while the pointer
 * has not moved in that window (a real wheel turn while the user moves the mouse is kept).
 */
export function isWheelEcho(now: number, lastMotionAt: number, lastPointerMoveAt: number): boolean {
  if (lastMotionAt <= 0) return false;
  if (now - lastMotionAt > MOTION_WHEEL_ECHO_MS) return false;
  return now - lastPointerMoveAt > MOTION_WHEEL_ECHO_MS;
}
