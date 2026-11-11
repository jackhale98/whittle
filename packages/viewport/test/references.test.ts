import { describe, expect, it } from 'vitest';
import { REFERENCE_ENTITY } from '../src/ids';
import {
  axisEnds,
  dashDotSegments,
  originReferences,
  outlineSegments,
  planeCorners,
  rayHitsPlane,
} from '../src/refgeom';
import { OVERLAY_COLORS } from '../src/themes';
import type { ReferenceFrame } from '../src/types';

const xy: ReferenceFrame = { origin: [0, 0, 5], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

describe('reference plane geometry (ADR-093)', () => {
  it('corners are a square of half-size extent around the origin, in the plane', () => {
    expect(planeCorners(xy, 10)).toEqual([
      [-10, -10, 5],
      [10, -10, 5],
      [10, 10, 5],
      [-10, 10, 5],
    ]);
    expect(outlineSegments(xy, 10)).toHaveLength(4 * 6);
  });

  it('a ray hits the square inside, misses outside, behind and when parallel', () => {
    const down = rayHitsPlane([2, 3, 55], [0, 0, -1], xy, 10);
    expect(down?.t).toBeCloseTo(50);
    expect(down?.point).toEqual([2, 3, 5]);
    expect(rayHitsPlane([11, 0, 55], [0, 0, -1], xy, 10)).toBeNull();
    expect(rayHitsPlane([0, 0, 55], [0, 0, 1], xy, 10)).toBeNull();
    expect(rayHitsPlane([0, 0, 55], [1, 0, 0], xy, 10)).toBeNull();
  });

  it('an axis spans [-extent, extent] along z and the dash-dot stays on it', () => {
    const f: ReferenceFrame = { origin: [1, 2, 3], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    expect(axisEnds(f, 8)).toEqual([
      [1, 2, -5],
      [1, 2, 11],
    ]);
    const s = dashDotSegments(f, 24);
    expect(s.length % 6).toBe(0);
    expect(s.length / 6).toBeGreaterThan(8);
    for (let i = 0; i < s.length; i += 3) {
      expect(s[i]).toBe(1);
      expect(s[i + 1]).toBe(2);
      expect(s[i + 2] as number).toBeGreaterThanOrEqual(3 - 24 - 1e-4);
      expect(s[i + 2] as number).toBeLessThanOrEqual(3 + 24 + 1e-4);
    }
    // dash then dot: the first segment is the long dash, the second the short dot.
    const len = (k: number) => (s[6 * k + 5] as number) - (s[6 * k + 2] as number);
    expect(len(0)).toBeGreaterThan(len(1) * 3);
  });

  it('origin references carry the reserved names and right-handed frames', () => {
    const o = originReferences(50);
    expect(o.map((r) => r.name)).toEqual([
      'origin:XY',
      'origin:XZ',
      'origin:YZ',
      'origin:X',
      'origin:Y',
      'origin:Z',
      'origin:O',
    ]);
    for (const r of o) {
      const { x, y, z } = r.frame;
      const c = [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
      ].map((v) => (v === 0 ? 0 : v));
      expect(c).toEqual([...z].map((v) => (v === 0 ? 0 : v)));
      expect(r.origin).toBe(true);
    }
    expect(REFERENCE_ENTITY).toBe('reference');
  });

  it('has a reference colour in both themes', () => {
    expect(OVERLAY_COLORS.light.reference).toMatch(/^#[0-9a-f]{6}$/);
    expect(OVERLAY_COLORS.dark.reference).toMatch(/^#[0-9a-f]{6}$/);
    expect(OVERLAY_COLORS.light.reference).not.toBe(OVERLAY_COLORS.dark.reference);
  });
});
