/**
 * B-spline maths (src/bspline.ts): knot conventions shared with the kernel (ADR-pending "Sketch
 * B-splines"), evaluation and derivatives, interpolation, knot insertion / splitting, area.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  closestSplineParam,
  defaultKnots,
  interpolate,
  reverseSpline,
  type SplineGeom,
  splineAreaIntegral,
  splineAt,
  splineDefError,
  splinePoint,
  splitSpline,
  subSpline,
} from '../src/bspline';

const near = (a: Vec2, b: Vec2, tol = 1e-9) =>
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);

const bezier: SplineGeom = {
  poles: [
    [0, 0],
    [1, 2],
    [3, 2],
    [4, 0],
  ],
  degree: 3,
  periodic: false,
};

/** Polygon area of a dense sampling (shoelace), for cross-checks. */
function sampledArea(g: SplineGeom, a: number, b: number, n = 20000): number {
  let s = 0;
  let prev = splinePoint(g, a);
  for (let i = 1; i <= n; i++) {
    const q = splinePoint(g, a + ((b - a) * i) / n);
    s += prev[0] * q[1] - prev[1] * q[0];
    prev = q;
  }
  return s / 2;
}

describe('B-spline conventions', () => {
  it('default knots: uniform clamped and uniform periodic', () => {
    expect(defaultKnots(4, 3, false)).toEqual({ knots: [0, 1], multiplicities: [4, 4] });
    expect(defaultKnots(6, 3, false)).toEqual({
      knots: [0, 1, 2, 3],
      multiplicities: [4, 1, 1, 4],
    });
    expect(defaultKnots(5, 3, true)).toEqual({
      knots: [0, 1, 2, 3, 4, 5],
      multiplicities: [1, 1, 1, 1, 1, 1],
    });
  });

  it('validation names the problem', () => {
    expect(splineDefError(4, { degree: 3, periodic: false })).toBeNull();
    expect(splineDefError(3, { degree: 3, periodic: false })).toMatch(/at least 4/);
    expect(
      splineDefError(4, { degree: 3, periodic: false, knots: [0, 1], multiplicities: [3, 3] }),
    ).toMatch(/clamped/);
    expect(splineDefError(4, { degree: 3, periodic: false, weights: [1, 1, 0, 1] })).toMatch(
      /weights/,
    );
    expect(
      splineDefError(4, { degree: 3, periodic: true, knots: [0, 1, 2, 3, 4], multiplicities: [1, 1, 1, 1, 1] }),
    ).toBeNull();
  });

  it('a clamped cubic with 4 poles is the Bézier curve; it starts and ends at its end poles', () => {
    for (const u of [0, 0.2, 0.5, 0.9, 1]) {
      const b = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
      const x = bezier.poles.reduce((s, p, i) => s + p[0] * (b[i] as number), 0);
      const y = bezier.poles.reduce((s, p, i) => s + p[1] * (b[i] as number), 0);
      near(splinePoint(bezier, u), [x, y], 1e-12);
    }
    // The end tangents run along the first / last control legs.
    const d0 = splineAt(bezier, 0, 1);
    expect([d0[2], d0[3]]).toEqual([3, 6]);
  });

  it('periodic: the span [k0, k1] uses poles 0…p (a uniform cubic starts at (P0 + 4P1 + P2) / 6)', () => {
    const g: SplineGeom = {
      poles: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      degree: 3,
      periodic: true,
    };
    near(splinePoint(g, 0), [(0 + 16 + 4) / 6, (0 + 0 + 4) / 6], 1e-12);
    // Matches planegcs' value at u = 0.5 (measured: 3.8333, 2).
    near(splinePoint(g, 0.5), [23 / 6, 2], 1e-12);
    // Periodic: u and u + period are the same point.
    near(splinePoint(g, 0.3), splinePoint(g, 4.3), 1e-12);
  });

  it('first and second derivatives agree with finite differences (rational too)', () => {
    const rational: SplineGeom = {
      poles: [
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      degree: 2,
      periodic: false,
      weights: [1, Math.SQRT1_2, 1],
    };
    // A rational quadratic with these weights is an exact quarter circle.
    for (const u of [0, 0.3, 0.71, 1]) expect(Math.hypot(...splinePoint(rational, u))).toBeCloseTo(1, 14);
    for (const g of [bezier, rational]) {
      for (const u of [0.13, 0.5, 0.77]) {
        const h = 1e-5;
        const r = splineAt(g, u, 2);
        const p = splineAt(g, u + h, 1);
        const m = splineAt(g, u - h, 1);
        expect(r[2]).toBeCloseTo(((p[0] as number) - (m[0] as number)) / (2 * h), 6);
        expect(r[5]).toBeCloseTo(((p[3] as number) - (m[3] as number)) / (2 * h), 4);
      }
    }
  });
});

describe('interpolation', () => {
  const pts: Vec2[] = [
    [0, 0],
    [10, 8],
    [25, 5],
    [32, -6],
    [45, 0],
  ];

  it('open: passes through every point at its knot, Bessel ends, end poles = end points', () => {
    const it3 = interpolate(pts, 3, false);
    if (!it3) throw new Error('no interpolation');
    expect(it3.poles).toHaveLength(pts.length + 2);
    expect(it3.poles[0]).toEqual(pts[0]);
    expect(it3.poles[it3.poles.length - 1]).toEqual(pts[pts.length - 1]);
    const g: SplineGeom = { ...it3, periodic: false };
    pts.forEach((p, i) => near(splinePoint(g, it3.params[i] as number), p, 1e-9));
    expect(it3.params).toEqual(it3.knots);
    // Bessel: the end tangent is the parabola's through the first three points.
    const t = it3.params;
    const [h0, h1] = [(t[1] as number) - (t[0] as number), (t[2] as number) - (t[1] as number)];
    const a = (2 * h0 + h1) / (h0 * (h0 + h1));
    const b = h0 / (h1 * (h0 + h1));
    const d0 = splineAt(g, 0, 1);
    expect(d0[2]).toBeCloseTo(a * (10 - 0) - b * (25 - 10), 9);
    // Accurate: a quarter circle through 6 points stays within 0.1% of its radius.
    const arc = Array.from({ length: 6 }, (_, i): Vec2 => {
      const ang = (Math.PI / 2) * (i / 5);
      return [50 * Math.cos(ang), 50 * Math.sin(ang)];
    });
    const q = interpolate(arc, 3, false);
    if (!q) throw new Error('no arc');
    for (let j = 0; j <= 100; j++)
      expect(Math.abs(Math.hypot(...splinePoint({ ...q, periodic: false }, j / 100)) - 50)).toBeLessThan(0.05);
  });

  it('closed: periodic, every point at a knot', () => {
    const it3 = interpolate(pts, 3, true);
    if (!it3) throw new Error('no interpolation');
    expect(it3.poles).toHaveLength(pts.length);
    const g: SplineGeom = { ...it3, periodic: true };
    pts.forEach((p, i) => near(splinePoint(g, it3.params[i] as number), p, 1e-9));
    expect(splineDefError(g.poles.length, g)).toBeNull();
    // Three points: the degree drops to 2 (an odd count, so the collocation is regular).
    const tri = interpolate(pts.slice(0, 3), 3, true);
    expect(tri?.degree).toBe(2);
  });

  it('refuses repeated points', () => {
    expect(interpolate([[0, 0], [0, 0], [1, 1]], 3, false)).toBeNull();
  });
});

describe('knot insertion and splitting', () => {
  const it3 = interpolate(
    [
      [0, 0],
      [10, 8],
      [25, 5],
      [32, -6],
      [45, 0],
    ],
    3,
    false,
  );
  if (!it3) throw new Error('no interpolation');
  const g: SplineGeom = { ...it3, periodic: false };

  it('split at u: two clamped splines covering the same curve', () => {
    const u = 0.41;
    const [a, b] = splitSpline(g, u);
    expect(splineDefError(a.poles.length, a)).toBeNull();
    expect(splineDefError(b.poles.length, b)).toBeNull();
    near(a.poles[a.poles.length - 1] as Vec2, splinePoint(g, u), 1e-9);
    near(b.poles[0] as Vec2, splinePoint(g, u), 1e-9);
    for (const v of [0, 0.1, 0.3, 0.41]) near(splinePoint(a, v), splinePoint(g, v), 1e-9);
    for (const v of [0.41, 0.6, 0.95, 1]) near(splinePoint(b, v), splinePoint(g, v), 1e-9);
  });

  it('a sub-curve of a periodic spline across the seam', () => {
    const c = interpolate(
      [
        [0, 0],
        [20, 0],
        [20, 10],
        [0, 10],
      ],
      3,
      true,
    );
    if (!c) throw new Error('no interpolation');
    const loop: SplineGeom = { ...c, periodic: true };
    const s = subSpline(loop, 0.8, 0.3); // across u = 1 ≡ 0
    expect(s.periodic).toBe(false);
    expect(splineDefError(s.poles.length, s)).toBeNull();
    near(splinePoint(s, 0.8), splinePoint(loop, 0.8), 1e-9);
    near(splinePoint(s, 1.1), splinePoint(loop, 0.1), 1e-9);
    near(splinePoint(s, 1.3), splinePoint(loop, 0.3), 1e-9);
  });

  it('closest point and reversal', () => {
    const q = splinePoint(g, 0.63);
    expect(closestSplineParam(g, [q[0] + 0.01, q[1] + 0.01])).toBeCloseTo(0.63, 2);
    const r = reverseSpline(g);
    near(splinePoint(r, 0.2), splinePoint(g, 0.8), 1e-9);
  });
});

describe('area integral', () => {
  it('matches a dense polygon for open and periodic splines', () => {
    const c = interpolate(
      [
        [0, 0],
        [20, -3],
        [24, 10],
        [3, 14],
      ],
      3,
      true,
    );
    if (!c) throw new Error('no interpolation');
    const loop: SplineGeom = { ...c, periodic: true };
    const exact = splineAreaIntegral(loop, 0, 1);
    expect(exact).toBeGreaterThan(0); // CCW points → positive
    expect(Math.abs(exact - sampledArea(loop, 0, 1)) / exact).toBeLessThan(1e-6);
    // Across the seam equals the sum of the parts.
    expect(splineAreaIntegral(loop, 0.7, 1.2)).toBeCloseTo(
      splineAreaIntegral(loop, 0.7, 1) + splineAreaIntegral(loop, 0, 0.2),
      12,
    );
    expect(splineAreaIntegral(bezier, 0, 1)).toBeCloseTo(sampledArea(bezier, 0, 1), 6);
  });
});
