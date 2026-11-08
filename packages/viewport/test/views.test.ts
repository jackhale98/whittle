import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  boundsRadius,
  cameraPositionFor,
  clipPlanes,
  EMPTY_BOUNDS,
  fitDistance,
  gridCellSize,
  unionBounds,
  VIEW_DIRECTIONS,
} from '../src/views';

describe('VIEW_DIRECTIONS (Z-up)', () => {
  it('has unit vectors for all seven standard views', () => {
    expect(Object.keys(VIEW_DIRECTIONS).sort()).toEqual(
      ['back', 'bottom', 'front', 'iso', 'left', 'right', 'top'].sort(),
    );
    for (const d of Object.values(VIEW_DIRECTIONS)) {
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 10);
    }
  });

  it('places the camera on the expected side', () => {
    expect(VIEW_DIRECTIONS.front).toEqual([0, -1, 0]);
    expect(VIEW_DIRECTIONS.top).toEqual([0, 0, 1]);
    expect(VIEW_DIRECTIONS.right).toEqual([1, 0, 0]);
    const iso = VIEW_DIRECTIONS.iso;
    expect(iso[0]).toBeGreaterThan(0);
    expect(iso[1]).toBeLessThan(0);
    expect(iso[2]).toBeGreaterThan(0);
  });

  it('opposite views are opposite', () => {
    for (const [a, b] of [
      ['front', 'back'],
      ['left', 'right'],
      ['top', 'bottom'],
    ] as const) {
      const da = VIEW_DIRECTIONS[a];
      const db = VIEW_DIRECTIONS[b];
      expect([da[0] + db[0], da[1] + db[1], da[2] + db[2]]).toEqual([0, 0, 0]);
    }
  });
});

describe('bounds helpers', () => {
  const box = { min: [0, 0, 0], max: [40, 30, 20] } as const;
  it('centre and radius', () => {
    expect(boundsCenter({ min: [...box.min], max: [...box.max] })).toEqual([20, 15, 10]);
    expect(boundsRadius({ min: [...box.min], max: [...box.max] })).toBeCloseTo(
      Math.hypot(40, 30, 20) / 2,
    );
  });
  it('union of several boxes; null for none', () => {
    const u = unionBounds([
      { min: [0, 0, 0], max: [1, 1, 1] },
      { min: [-5, 2, 0.5], max: [0.5, 3, 9] },
    ]);
    expect(u).toEqual({ min: [-5, 0, 0], max: [1, 3, 9] });
    expect(unionBounds([])).toBeNull();
    expect(boundsRadius(EMPTY_BOUNDS)).toBeGreaterThan(0);
  });
});

describe('fitDistance', () => {
  it('the fitted sphere exactly touches the limiting frustum edge (no padding)', () => {
    const r = 10;
    const d = fitDistance(r, 40, 1, 1);
    expect(Math.asin(r / d)).toBeCloseTo((40 * Math.PI) / 360, 10);
  });
  it('is farther on narrow (portrait) viewports, horizontal fov limits', () => {
    expect(fitDistance(10, 35, 0.5)).toBeGreaterThan(fitDistance(10, 35, 1.5));
    expect(fitDistance(10, 35, 1.5)).toBeCloseTo(fitDistance(10, 35, 1.0));
  });
  it('scales linearly with radius and padding', () => {
    expect(fitDistance(20, 35, 1.6, 1.2)).toBeCloseTo(2 * fitDistance(10, 35, 1.6, 1.2));
    expect(fitDistance(10, 35, 1.6, 2)).toBeCloseTo((2 / 1.2) * fitDistance(10, 35, 1.6, 1.2));
  });
});

describe('cameraPositionFor / clipPlanes / gridCellSize', () => {
  it('offsets from the target along a normalised direction', () => {
    expect(cameraPositionFor([1, 2, 3], [0, 0, 5], 10)).toEqual([1, 2, 13]);
  });
  it('keeps near < far, with the whole scene inside', () => {
    const r = 30;
    for (const dist of [5, 60, 500]) {
      const { near, far } = clipPlanes(dist, r);
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(dist + r);
      expect(near).toBeLessThan(far);
      if (dist > r * 3) expect(near).toBeLessThan(dist - r);
    }
  });
  it('grid cell is a power of ten tracking the scene size', () => {
    expect(gridCellSize(27)).toBe(10);
    expect(gridCellSize(3)).toBe(1);
    expect(gridCellSize(300)).toBe(100);
  });
});
