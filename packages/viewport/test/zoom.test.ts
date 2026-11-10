import { describe, expect, it } from 'vitest';
import { WHEEL_MAX_NOTCHES_PER_EVENT, WHEEL_ZOOM_PER_NOTCH } from '../src/constants';
import {
  anchorStillValid,
  easeDistance,
  missAnchor,
  nextGoalDistance,
  wheelNotches,
  zoomFrame,
  zoomPose,
  zoomScale,
} from '../src/zoom';

describe('wheelNotches', () => {
  it('maps a 100 px notch to one notch, away from the user = in', () => {
    expect(wheelNotches(-100, 0)).toBe(1);
    expect(wheelNotches(100, 0)).toBe(-1);
  });
  it('handles lines and pages, clamps a flick, and inverts', () => {
    expect(wheelNotches(-3, 1)).toBe(1);
    expect(wheelNotches(-5000, 0)).toBe(WHEEL_MAX_NOTCHES_PER_EVENT);
    expect(wheelNotches(-100, 0, true)).toBe(-1);
    expect(wheelNotches(Number.NaN, 0)).toBe(0);
  });
  it('scales small trackpad deltas proportionally', () => {
    expect(wheelNotches(-10, 0)).toBeCloseTo(0.1);
  });
});

describe('zoom distance', () => {
  it('has the same ratio every notch', () => {
    let d = 100;
    const ratios: number[] = [];
    for (let i = 0; i < 10; i++) {
      const n = nextGoalDistance(d, 1, 0.001, 1e6);
      ratios.push(n / d);
      d = n;
    }
    for (const r of ratios) expect(r).toBeCloseTo(WHEEL_ZOOM_PER_NOTCH, 12);
  });
  it('composes: two half notches equal one notch', () => {
    expect(zoomScale(0.5) * zoomScale(0.5)).toBeCloseTo(zoomScale(1), 12);
  });
  it('clamps to min and max', () => {
    expect(nextGoalDistance(1, 50, 0.5, 10)).toBe(0.5);
    expect(nextGoalDistance(9, -50, 0.5, 10)).toBe(10);
  });
});

describe('easeDistance', () => {
  it('jumps with tau 0 (reduced motion)', () => {
    expect(easeDistance(10, 5, 0.016, 0)).toEqual({ value: 5, done: true });
  });
  it('is frame-rate independent', () => {
    const at = (steps: number) => {
      let v = 10;
      for (let i = 0; i < steps; i++) v = easeDistance(v, 5, 0.1 / steps, 0.05).value;
      return v;
    };
    expect(at(1)).toBeCloseTo(at(6), 9);
    expect(at(6)).toBeCloseTo(at(60), 9);
  });
  it('moves on the first frame, never overshoots, and arrives', () => {
    let v = 10;
    const first = easeDistance(v, 5, 1 / 60, 0.05).value;
    expect(first).toBeLessThan(10);
    expect(first).toBeGreaterThan(5);
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      const r = easeDistance(v, 5, 1 / 60, 0.05);
      expect(r.value).toBeGreaterThanOrEqual(5);
      v = r.value;
      done = r.done;
    }
    expect(done).toBe(true);
    expect(v).toBe(5);
  });
});

describe('anchor', () => {
  const a = {
    point: [0, 0, 0] as [number, number, number],
    x: 100,
    y: 100,
    t: 1000,
    source: 'surface' as const,
  };
  it('is kept for the same spot while the wheel turns, dropped otherwise', () => {
    expect(anchorStillValid(a, 101, 100, 1200)).toBe(true);
    expect(anchorStillValid(a, 120, 100, 1200)).toBe(false);
    expect(anchorStillValid(a, 100, 100, 2000)).toBe(false);
    expect(anchorStillValid(null, 0, 0, 0)).toBe(false);
  });
  it('miss anchor sits at the scene centre depth on the cursor ray', () => {
    const p = missAnchor([0, 0, 0], [0, 0, 1], [0, 0, 1], [5, 5, 40], 10);
    expect(p).toEqual([0, 0, 40]);
    // Centre behind the camera: fall back to the given depth.
    expect(missAnchor([0, 0, 0], [0, 0, 1], [0, 0, 1], [0, 0, -4], 10)).toEqual([0, 0, 10]);
  });
});

describe('zoomPose', () => {
  it('keeps the anchor on the cursor ray and the target on the view axis', () => {
    const cam: [number, number, number] = [0, -100, 0];
    const fwd: [number, number, number] = [0, 1, 0];
    const anchor: [number, number, number] = [10, 0, 5]; // off-axis surface point
    const f = zoomFrame(cam, fwd, anchor);
    expect(f).not.toBeNull();
    if (!f) return;
    const d0 = Math.hypot(10, 100, 5);
    const near = zoomPose(f, d0 * 0.5);
    // Same ray: (anchor - position) stays parallel to (anchor - cam).
    const v0 = [anchor[0] - cam[0], anchor[1] - cam[1], anchor[2] - cam[2]];
    const v1 = [
      anchor[0] - near.position[0],
      anchor[1] - near.position[1],
      anchor[2] - near.position[2],
    ];
    expect(v1[0]).toBeCloseTo((v0[0] as number) * 0.5, 9);
    expect(v1[1]).toBeCloseTo((v0[1] as number) * 0.5, 9);
    expect(v1[2]).toBeCloseTo((v0[2] as number) * 0.5, 9);
    // Target: on the axis from the new position along forward, at the anchor's depth.
    expect(near.target[0]).toBeCloseTo(near.position[0], 9);
    expect(near.target[1] - near.position[1]).toBeCloseTo(v1[1] as number, 9);
  });
  it('no frame when the camera sits on the anchor', () => {
    expect(zoomFrame([1, 2, 3], [0, 1, 0], [1, 2, 3])).toBeNull();
  });
});
