import type { MotionSample } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  isWheelEcho,
  MOTION_MAX_DT_S,
  MOTION_WHEEL_ECHO_MS,
  MotionIntegrator,
} from '../src/motion/integrate';

const s = (
  time: number,
  t: [number, number, number] = [0, 0, 0],
  r: [number, number, number] = [0, 0, 0],
): MotionSample => ({
  t,
  r,
  time,
});

describe('MotionIntegrator', () => {
  it('ignores zero samples at rest', () => {
    const m = new MotionIntegrator();
    expect(m.push(s(0))).toEqual({ started: false, ended: false });
    expect(m.active).toBe(false);
  });

  it('the first sample starts the clock; later ones integrate rate x dt', () => {
    const m = new MotionIntegrator();
    expect(m.push(s(1000, [1, 0, 0]))).toEqual({ started: true, ended: false });
    expect(m.take().t[0]).toBe(0); // nothing yet: no previous sample to measure from
    m.push(s(1010, [1, 0, 0], [0, 0.5, 0]));
    m.push(s(1020, [0.5, 0, 0], [0, 0.5, 0]));
    const d = m.take();
    expect(d.t[0]).toBeCloseTo(1 * 0.01 + 0.5 * 0.01);
    expect(d.r[1]).toBeCloseTo(0.5 * 0.01 + 0.5 * 0.01);
    expect(m.take().t[0]).toBe(0); // taken
  });

  it('caps dt so a stalled tab does not jump', () => {
    const m = new MotionIntegrator();
    m.push(s(0, [1, 0, 0]));
    m.push(s(5000, [1, 0, 0])); // 5 s gap
    expect(m.take().t[0]).toBeCloseTo(MOTION_MAX_DT_S);
  });

  it('ignores clocks that run backwards or are not numbers', () => {
    const m = new MotionIntegrator();
    m.push(s(100, [1, 0, 0]));
    m.push(s(50, [1, 0, 0]));
    m.push(s(Number.NaN, [1, 0, 0]));
    expect(m.take().t[0]).toBe(0);
  });

  it('a zero sample ends the session after contributing its own interval', () => {
    const m = new MotionIntegrator();
    m.push(s(0, [0, 0, 1]));
    m.push(s(16, [0, 0, 1]));
    expect(m.push(s(32))).toEqual({ started: false, ended: true });
    expect(m.active).toBe(false);
    expect(m.consumeEnded()).toBe(true);
    expect(m.consumeEnded()).toBe(false);
    expect(m.take().t[2]).toBeCloseTo(0.016); // the 16 ms of the second sample; the zero adds none
  });

  it('stop() ends without a zero sample', () => {
    const m = new MotionIntegrator();
    m.push(s(0, [1, 0, 0]));
    m.stop();
    expect(m.active).toBe(false);
    expect(m.consumeEnded()).toBe(true);
  });

  it('a new session after an end starts its clock again', () => {
    const m = new MotionIntegrator();
    m.push(s(0, [1, 0, 0]));
    m.push(s(10));
    m.take();
    expect(m.push(s(10_000, [1, 0, 0])).started).toBe(true);
    expect(m.take().t[0]).toBe(0);
  });
});

describe('isWheelEcho (ADR-096 item 3)', () => {
  it('drops a wheel event soon after motion when the pointer is still', () => {
    expect(isWheelEcho(1050, 1000, 0)).toBe(true);
    expect(isWheelEcho(1000 + MOTION_WHEEL_ECHO_MS, 1000, 0)).toBe(true);
  });
  it('keeps it when there was no motion, or the motion is old', () => {
    expect(isWheelEcho(1050, 0, 0)).toBe(false);
    expect(isWheelEcho(1000 + MOTION_WHEEL_ECHO_MS + 1, 1000, 0)).toBe(false);
  });
  it('keeps it when the pointer moved in the same window (a real wheel turn)', () => {
    expect(isWheelEcho(1050, 1000, 1020)).toBe(false);
    expect(isWheelEcho(1050, 1000, 900)).toBe(true); // moved long before
  });
});
