/**
 * M3.5 sketch curves in the regen engine (ADR-046): exact B-spline evaluation (de Boor, rational
 * weights, clamped and periodic default knots) checked against independent closed forms
 * (Bernstein polynomials, Cox–de Boor basis sums, the rational quarter circle), elliptic-arc
 * sampling checked against the ellipse equation, and the chord tolerance of every sample.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchBSpline, SketchEllipticArc, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  defaultKnots,
  ellipsePoint,
  evalBSpline,
  type PreparedBSpline,
  prepareBSpline,
  sampleBSpline,
} from '../../src/regen/curves';
import { sampleEntity } from '../../src/regen/geometry';

const prep = (
  poles: Vec2[],
  degree: number,
  periodic = false,
  extra: Partial<SketchBSpline> = {},
): PreparedBSpline => {
  const b = prepareBSpline({ degree, periodic, ...extra }, poles);
  if (typeof b === 'string') throw new Error(b);
  return b;
};

const near = (a: Vec2, b: Vec2, tol = 1e-12) => {
  expect(Math.abs(a[0] - b[0]), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(a[1] - b[1]), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
};

/** Independent Cox–de Boor basis N_{i,p}(t) on a flat knot vector (right-open spans). */
function basis(flat: number[], i: number, p: number, t: number, last: boolean): number {
  if (p === 0) {
    const a = flat[i] as number;
    const b = flat[i + 1] as number;
    return (t >= a && t < b) || (last && t === b && b > a) ? 1 : 0;
  }
  const a = flat[i] as number;
  const b = flat[i + p] as number;
  const c = flat[i + 1] as number;
  const d = flat[i + p + 1] as number;
  const l = b > a ? ((t - a) / (b - a)) * basis(flat, i, p - 1, t, last) : 0;
  const r = d > c ? ((d - t) / (d - c)) * basis(flat, i + 1, p - 1, t, last) : 0;
  return l + r;
}

/** Distance from p to the segment ab. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Max distance of dense curve points to the polyline (each point to its nearest segment). */
function maxDeviation(curve: Vec2[], poly: Vec2[]): number {
  let worst = 0;
  for (const p of curve) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < poly.length; i++) {
      best = Math.min(best, segDist(p, poly[i - 1] as Vec2, poly[i] as Vec2));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const dense = (b: PreparedBSpline, n = 2000): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => evalBSpline(b, b.t0 + ((b.t1 - b.t0) * i) / n));

describe('B-spline knots (ADR-046 defaults)', () => {
  it('clamped: degree + 1 end multiplicity, uniform interior knots in [0, 1]', () => {
    expect(defaultKnots(6, 3, false)).toEqual({
      knots: [0, 1 / 3, 2 / 3, 1],
      multiplicities: [4, 1, 1, 4],
    });
    expect(defaultKnots(4, 3, false)).toEqual({ knots: [0, 1], multiplicities: [4, 4] });
  });

  it('periodic: n + 1 uniform knots of multiplicity 1 (period 1)', () => {
    expect(defaultKnots(4, 3, true)).toEqual({
      knots: [0, 0.25, 0.5, 0.75, 1],
      multiplicities: [1, 1, 1, 1, 1],
    });
  });

  it('periodic flat knots follow OCCT BSplCLib::KnotSequence', () => {
    const b = prep(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      3,
      true,
    );
    // p + 1 − m₀ = 3 knots of the neighbouring periods on each side.
    expect(b.flat).toEqual([-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
    expect([b.t0, b.t1]).toEqual([0, 1]);
    const k = prep(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      2,
      true,
      {
        knots: [0, 1, 3, 4],
        multiplicities: [2, 1, 1, 2],
      },
    );
    // m₀ = 2: one knot before (3 − 4) and one after (1 + 4).
    expect(k.flat).toEqual([-1, 0, 0, 1, 3, 4, 4, 5]);
  });

  it('rejects inconsistent definitions (the display then shows the control polygon)', () => {
    const P: Vec2[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    expect(prepareBSpline({ degree: 3, periodic: false }, P)).toMatch(/at least 4/);
    expect(prepareBSpline({ degree: 2, periodic: false, weights: [1, 0, 1] }, P)).toMatch(/weight/);
    expect(prepareBSpline({ degree: 2, periodic: false, knots: [0, 1] }, P)).toMatch(/together/);
    expect(
      prepareBSpline({ degree: 2, periodic: false, knots: [0, 1], multiplicities: [3, 2] }, P),
    ).toMatch(/need 6 knots/);
    const e: SketchEntity = {
      id: 's',
      kind: 'bspline',
      poles: ['a', 'b', 'c'],
      degree: 3,
      periodic: false,
      construction: false,
    };
    const pts = new Map<string, Vec2>([
      ['a', [0, 0]],
      ['b', [1, 1]],
      ['c', [2, 0]],
    ]);
    expect(sampleEntity(e, pts, 0.01)).toEqual(P);
  });
});

describe('B-spline evaluation (de Boor)', () => {
  const P: Vec2[] = [
    [0, 0],
    [1, 2],
    [3, 2],
    [4, 0],
  ];

  it('a clamped cubic with four poles is the Bézier curve (Bernstein form)', () => {
    const b = prep(P, 3);
    for (const t of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      const s = 1 - t;
      const w = [s ** 3, 3 * s * s * t, 3 * s * t * t, t ** 3];
      const x = w.reduce((a, wi, i) => a + wi * (P[i] as Vec2)[0], 0);
      const y = w.reduce((a, wi, i) => a + wi * (P[i] as Vec2)[1], 0);
      near(evalBSpline(b, t), [x, y]);
    }
    near(evalBSpline(b, 0.5), [2, 1.5]);
  });

  it('clamped with interior knots: equals Σ N_i,p(t)·P_i, starts and ends at the end poles', () => {
    const Q: Vec2[] = [
      [0, 0],
      [1, 3],
      [2, -1],
      [4, 2],
      [5, 0],
      [7, 1],
      [8, 4],
    ];
    for (const degree of [1, 2, 3, 4]) {
      const b = prep(Q, degree);
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        let x = 0;
        let y = 0;
        for (let i = 0; i < Q.length; i++) {
          const N = basis(b.flat, i, degree, t, t === 1);
          x += N * (Q[i] as Vec2)[0];
          y += N * (Q[i] as Vec2)[1];
        }
        near(evalBSpline(b, t), [x, y], 1e-12);
      }
      near(evalBSpline(b, 0), Q[0] as Vec2);
      near(evalBSpline(b, 1), Q[Q.length - 1] as Vec2);
    }
  });

  it('explicit knots: distinct values + multiplicities, or a flat vector, give the same curve', () => {
    const Q: Vec2[] = [
      [0, 0],
      [1, 3],
      [2, -1],
      [4, 2],
      [5, 0],
    ];
    const a = prep(Q, 2, false, { knots: [0, 1, 3, 4], multiplicities: [3, 1, 1, 3] });
    const f = prep(Q, 2, false, { knots: [0, 0, 0, 1, 3, 4, 4, 4] });
    for (let k = 0; k <= 20; k++) {
      const t = (4 * k) / 20;
      near(evalBSpline(a, t), evalBSpline(f, t));
    }
    // Non-uniform: the knot at 1 pulls the second span short.
    expect(a.spans.map((s) => a.flat[s])).toEqual([0, 1, 3]);
  });

  it('rational: weights 1, √2/2, 1 on a quadratic make an exact quarter circle', () => {
    const b = prep(
      [
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      2,
      false,
      { weights: [1, Math.SQRT1_2, 1] },
    );
    for (let k = 0; k <= 50; k++) {
      const [x, y] = evalBSpline(b, k / 50);
      expect(Math.abs(Math.hypot(x, y) - 1)).toBeLessThan(1e-14);
    }
    const mid = evalBSpline(b, 0.5);
    near(mid, [Math.SQRT1_2, Math.SQRT1_2], 1e-14);
  });

  it('periodic: closed, smooth across the seam, the default cubic starts at (P₀ + 4P₁ + P₂)/6', () => {
    const Q: Vec2[] = [
      [0, 0],
      [4, -1],
      [6, 2],
      [3, 5],
      [-1, 3],
    ];
    const b = prep(Q, 3, true);
    const p0 = Q[0] as Vec2;
    const p1 = Q[1] as Vec2;
    const p2 = Q[2] as Vec2;
    near(evalBSpline(b, 0), [(p0[0] + 4 * p1[0] + p2[0]) / 6, (p0[1] + 4 * p1[1] + p2[1]) / 6]);
    near(evalBSpline(b, 0), evalBSpline(b, 1), 1e-12);
    // Rotating the poles cyclically moves the seam, not the curve: C(t) = C'(t − 1/n), so the
    // seam is evaluated exactly like the smooth interior.
    const rot = prep([...Q.slice(1), Q[0] as Vec2], 3, true);
    for (let k = 0; k <= 50; k++) {
      const t = k / 50;
      const u = (((t - 1 / Q.length) % 1) + 1) % 1;
      near(evalBSpline(b, t), evalBSpline(rot, u), 1e-12);
    }
    // Partition of unity on the extended (wrapped) basis.
    for (const t of [0, 0.13, 0.5, 0.99]) {
      let sum = 0;
      for (let i = 0; i < b.poles.length; i++) sum += basis(b.flat, i, 3, t, false);
      expect(sum).toBeCloseTo(1, 12);
    }
  });
});

describe('sampling at the chord tolerance', () => {
  it('every spline sample is on the curve and no chord deviates more than the tolerance', () => {
    const Q: Vec2[] = [
      [0, 0],
      [10, 30],
      [20, -30],
      [40, 20],
      [50, 0],
      [70, 10],
    ];
    for (const chord of [0.5, 0.05, 0.002]) {
      const b = prep(Q, 3);
      const s = sampleBSpline(b, chord);
      near(s[0] as Vec2, Q[0] as Vec2);
      near(s[s.length - 1] as Vec2, Q[Q.length - 1] as Vec2);
      expect(maxDeviation(dense(b), s)).toBeLessThanOrEqual(chord * 1.0001);
      // Knots are samples: the polyline meets the exact curve where spans join.
      for (const sIdx of b.spans) {
        const k = evalBSpline(b, b.flat[sIdx] as number);
        expect(s.some((p) => Math.hypot(p[0] - k[0], p[1] - k[1]) < 1e-12)).toBe(true);
      }
    }
  });

  it('a degree-1 spline samples to exactly its control polygon', () => {
    const Q: Vec2[] = [
      [0, 0],
      [3, 4],
      [6, 0],
    ];
    expect(sampleBSpline(prep(Q, 1), 0.01)).toEqual(Q);
  });

  it('a periodic spline closes exactly', () => {
    const b = prep(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      3,
      true,
    );
    const s = sampleBSpline(b, 0.01);
    near(s[0] as Vec2, s[s.length - 1] as Vec2, 1e-12);
    expect(maxDeviation(dense(b), s)).toBeLessThanOrEqual(0.01 * 1.0001);
  });

  it('sampleEntity samples a weighted spline from its pole entities', () => {
    const e: SketchBSpline = {
      id: 's',
      kind: 'bspline',
      poles: ['a', 'b', 'c'],
      degree: 2,
      periodic: false,
      weights: [1, Math.SQRT1_2, 1],
      construction: false,
    };
    const pts = new Map<string, Vec2>([
      ['a', [5, 0]],
      ['b', [5, 5]],
      ['c', [0, 5]],
    ]);
    const s = sampleEntity(e, pts, 0.001);
    expect(s.length).toBeGreaterThan(10);
    for (const [x, y] of s) expect(Math.abs(Math.hypot(x, y) - 5)).toBeLessThan(1e-12);
  });

  it('elliptic arcs: closed-form points, counter-clockwise from start to end, chord tolerance', () => {
    const a = 20;
    const b = 8;
    const rot = 0.4;
    const c: Vec2 = [3, -2];
    const g = { c, a, b, rotation: rot };
    const start = ellipsePoint(g, -0.5);
    const end = ellipsePoint(g, 2.0);
    const e: SketchEllipticArc = {
      id: 'ea',
      kind: 'ellipticArc',
      center: 'c',
      start: 's',
      end: 'e',
      majorRadius: a,
      minorRadius: b,
      rotation: rot,
      construction: false,
    };
    const pts = new Map<string, Vec2>([
      ['c', c],
      ['s', start],
      ['e', end],
    ]);
    const chord = 0.01;
    const s = sampleEntity(e, pts, chord);
    expect(s[0]).toEqual(start);
    expect(s[s.length - 1]).toEqual(end);
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    let prevT = -0.5;
    for (const p of s) {
      const u = (p[0] - c[0]) * cr + (p[1] - c[1]) * sr;
      const v = -(p[0] - c[0]) * sr + (p[1] - c[1]) * cr;
      expect(Math.abs((u / a) ** 2 + (v / b) ** 2 - 1)).toBeLessThan(1e-12);
      const t = Math.atan2(v / b, u / a);
      expect(t).toBeGreaterThanOrEqual(prevT - 1e-12); // increasing: counter-clockwise
      prevT = t;
    }
    const exact = Array.from({ length: 2001 }, (_, i) => ellipsePoint(g, -0.5 + (2.5 * i) / 2000));
    expect(maxDeviation(exact, s)).toBeLessThanOrEqual(chord);
    // Across the angle seam: CCW from t = 3 to t = −3 is the short way through π.
    const wrap = sampleEntity(
      e,
      new Map<string, Vec2>([
        ['c', c],
        ['s', ellipsePoint(g, 3)],
        ['e', ellipsePoint(g, -3)],
      ]),
      chord,
    );
    expect(wrap.length).toBeGreaterThan(2);
    for (const p of wrap) {
      const u = (p[0] - c[0]) * cr + (p[1] - c[1]) * sr;
      const v = -(p[0] - c[0]) * sr + (p[1] - c[1]) * cr;
      expect(Math.abs(Math.atan2(v / b, u / a))).toBeGreaterThanOrEqual(3 - 1e-9);
    }
  });
});
