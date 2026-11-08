/**
 * Newton polish (ADR-008 item 9): driving dimensions and coincidences hold to ≤ 1e-10 mm after a
 * solve, so sketches dimensioned to meet are exactly coplanar; exact geometry never moves.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchSolveInput, Vec2 } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/model';
import { type PolishStats, polish } from '../src/polish';
import { core, pos, rectangle, SketchBuilder } from './helpers';

const EXACT = 1e-10;

/**
 * Rectangle (H/V edges) with its first corner at hDistance/vDistance `at` from a fixed origin,
 * width/height dimensioned. `off(i)` displaces drawn corner i from the exact solution.
 */
function placedRectangle(at: Vec2, w: number, h: number, off: (i: number) => Vec2) {
  const b = new SketchBuilder();
  const origin = b.point(0, 0);
  b.geo({ kind: 'fix', entity: origin });
  const exact: Vec2[] = [at, [at[0] + w, at[1]], [at[0] + w, at[1] + h], [at[0], at[1] + h]];
  const p = exact.map((c, i) => b.point(c[0] + off(i)[0], c[1] + off(i)[1]));
  const [p0, p1, p2, p3] = p as [Id, Id, Id, Id];
  const bottom = b.line(p0, p1);
  const right = b.line(p1, p2);
  b.geo({ kind: 'horizontal', line: bottom });
  b.geo({ kind: 'vertical', line: right });
  b.geo({ kind: 'horizontal', line: b.line(p2, p3) });
  b.geo({ kind: 'vertical', line: b.line(p3, p0) });
  b.dim({ kind: 'hDistance', a: origin, b: p0 }, at[0]);
  b.dim({ kind: 'vDistance', a: origin, b: p0 }, at[1]);
  b.dim({ kind: 'length', line: bottom }, w);
  b.dim({ kind: 'distance', a: p1, b: p2 }, h);
  return { input: b.input(), r: { p0, p1, p2, p3 } };
}

/** Deterministic offsets: drawn roughly (mm) or already inside the old 1e-7 × size check. */
const offsets = {
  rough: (i: number): Vec2 => [1.7 * Math.sin(i + 1), -2.2 * Math.cos(2 * i + 1)],
  nearlyExact: (i: number): Vec2 => [3e-5 * Math.sin(i + 1), -2e-5 * Math.cos(2 * i + 1)],
};

describe('polish', () => {
  for (const [name, off] of Object.entries(offsets)) {
    it(`two rectangles dimensioned to share an edge come out exactly coplanar (${name})`, async () => {
      const solver = await core();
      // Awkward values and a large offset from the origin make rounding visible.
      const x0 = 1234.5678901;
      const w1 = 37.31415926535;
      // Sketch A: the left rectangle. Sketch B (a separate sketch) starts where A ends.
      const a = placedRectangle([x0, 250.25], w1, 20.7, off);
      const b = placedRectangle([x0 + w1, 250.25], 25.123456789, 20.7, (i) => off(i + 2));
      const ra = solver.solve(a.input);
      const rb = solver.solve(b.input);
      expect(ra.status).toBe('solved');
      expect(rb.status).toBe('solved');
      const aRight = [pos(ra, a.r.p1), pos(ra, a.r.p2)];
      const bLeft = [pos(rb, b.r.p0), pos(rb, b.r.p3)];
      for (let i = 0; i < 2; i++) {
        const pa = aRight[i] as Vec2;
        const pb = bLeft[i] as Vec2;
        // The shared edge: same x on both sketches (coplanar faces after extrusion).
        expect(Math.abs(pa[0] - pb[0])).toBeLessThanOrEqual(EXACT);
        expect(Math.abs(pa[1] - pb[1])).toBeLessThanOrEqual(EXACT);
        expect(Math.abs(pa[0] - (x0 + w1))).toBeLessThanOrEqual(EXACT);
      }
      // Every driving dimension is exact, not just within the solver's 1e-7 × size check.
      for (const [res, input] of [
        [ra, a.input],
        [rb, b.input],
      ] as const) {
        const m = buildModel({ ...input, entities: res.entities });
        for (const row of m.rows) expect(Math.abs(row.f(m.x0))).toBeLessThanOrEqual(EXACT);
      }
    });
  }

  it('geometry already within the old 1e-7 × size tolerance is pulled exact (no early exit)', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    b.geo({ kind: 'fix', entity: p });
    const q = b.point(100 + 4e-6, 0);
    const l = b.line(p, q);
    b.geo({ kind: 'horizontal', line: l });
    b.dim({ kind: 'length', line: l }, 100);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(Math.abs((pos(res, q)[0] as number) - 100)).toBeLessThanOrEqual(EXACT);
  });

  it('coincident points across a chain are exact', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    let prev: ReturnType<typeof rectangle> | null = null;
    for (let i = 0; i < 6; i++) {
      const r = rectangle(b, 13.37, 7.1, [i * 13.37 + 0.4 * i, 0.3 * i], 1.1);
      if (prev) b.geo({ kind: 'coincident', a: prev.p1, b: r.p0 });
      else b.geo({ kind: 'fix', entity: r.p0 });
      b.dim({ kind: 'length', line: r.bottom }, 13.37);
      b.dim({ kind: 'length', line: r.left }, 7.1);
      prev = r;
    }
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    const m = buildModel({ ...b.input(), entities: res.entities });
    for (const row of m.rows) expect(Math.abs(row.f(m.x0))).toBeLessThanOrEqual(EXACT);
  });

  it('does not move geometry that is already exact (bit for bit)', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const pts = [
      b.point(10.1, 5.3),
      b.point(50.1, 5.3),
      b.point(50.1, 25.3),
      b.point(10.1, 25.3),
    ] as const;
    const lines = pts.map((p, i) => b.line(p, pts[(i + 1) % 4] as Id));
    b.geo({ kind: 'fix', entity: pts[0] });
    b.geo({ kind: 'horizontal', line: lines[0] as Id });
    b.geo({ kind: 'vertical', line: lines[1] as Id });
    b.geo({ kind: 'horizontal', line: lines[2] as Id });
    b.geo({ kind: 'vertical', line: lines[3] as Id });
    b.dim({ kind: 'hDistance', a: pts[0], b: pts[1] }, 50.1 - 10.1);
    b.dim({ kind: 'vDistance', a: pts[1], b: pts[2] }, 25.3 - 5.3);
    const input = b.input();
    const res = solver.solve(input);
    expect(res.status).toBe('solved');
    expect(res.entities).toEqual(input.entities);
    const m = buildModel(input);
    const stats: PolishStats = { steps: -1, before: 0, after: 0 };
    const x = polish(m, m.x0, m.rows, stats);
    expect(stats.steps).toBe(0);
    expect([...x]).toEqual([...m.x0]);
  });

  it('under-constrained geometry gets a minimum-norm correction (no drift)', () => {
    const b = new SketchBuilder();
    const s = b.segment([3, 4], [53 + 2e-6, 4 - 3e-6]);
    b.dim({ kind: 'length', line: s.line }, 50);
    b.geo({ kind: 'horizontal', line: s.line });
    const m = buildModel(b.input());
    const stats: PolishStats = { steps: 0, before: 0, after: 0 };
    const x = polish(m, m.x0, m.rows, stats);
    expect(stats.steps).toBeGreaterThan(0);
    expect(stats.after).toBeLessThanOrEqual(1);
    for (const row of m.rows) expect(Math.abs(row.f(x))).toBeLessThanOrEqual(EXACT);
    // The correction is split between both ends (minimum norm), ~1e-6, not a jump.
    for (let i = 0; i < x.length; i++)
      expect(Math.abs((x[i] as number) - (m.x0[i] as number))).toBeLessThan(1e-5);
    expect(Math.abs((x[0] as number) - 3)).toBeGreaterThan(0);
  });

  it('inconsistent rows are left alone (no blow-up)', () => {
    const b = new SketchBuilder();
    const s = b.segment([0, 0], [10, 0]);
    b.geo({ kind: 'fix', entity: s.start });
    b.geo({ kind: 'fix', entity: s.end });
    b.dim({ kind: 'length', line: s.line }, 10.001);
    const m = buildModel(b.input());
    const x = polish(m, m.x0);
    expect([...x]).toEqual([...m.x0]);
  });
});

/** Drag regression: the polish keeps drag results exact and inside the budget. */
describe('polish during drag', () => {
  it('every drag step keeps dimensions and coincidences exact', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    let prev: ReturnType<typeof rectangle> | null = null;
    let last: Id = '';
    for (let i = 0; i < 4; i++) {
      const r = rectangle(b, 10.123, 6, [i * 10.123, 0], 0);
      if (prev) b.geo({ kind: 'coincident', a: prev.p1, b: r.p0 });
      else b.geo({ kind: 'fix', entity: r.p0 });
      b.dim({ kind: 'length', line: r.bottom }, 10.123);
      prev = r;
      last = r.p2;
    }
    const input: SketchSolveInput = b.input();
    const start = pos(solver.solve(input), last);
    const { session } = solver.beginDrag(input, last, start);
    for (let i = 1; i <= 30; i++) {
      const res = solver.drag(session, [start[0] + 0.37 * i, start[1] + 0.21 * i]);
      expect(res.status).toBe('solved');
      const m = buildModel({ ...input, entities: res.entities });
      for (const row of m.rows) expect(Math.abs(row.f(m.x0))).toBeLessThanOrEqual(EXACT);
    }
    solver.endDrag(session);
  });

  it('a polish that has work to do on 200 entities fits the 4 ms drag budget', () => {
    // The drag-perf chain (drag.test.ts): 25 rectangles, coincident corners, width dimensions.
    const b = new SketchBuilder();
    let prev: ReturnType<typeof rectangle> | null = null;
    for (let i = 0; i < 25; i++) {
      const r = rectangle(b, 10, 6 + (i % 3), [i * 10, 0], 0);
      if (prev) b.geo({ kind: 'coincident', a: prev.p1, b: r.p0 });
      else b.geo({ kind: 'fix', entity: r.p0 });
      b.dim({ kind: 'length', line: r.bottom }, 10);
      prev = r;
    }
    const input = b.input();
    expect(input.entities).toHaveLength(200);
    // An exact solution, then every point nudged by up to 1e-6 mm (what planegcs may leave).
    const exact = buildModel(input);
    const solved = polish(exact, exact.x0);
    for (const row of exact.rows) expect(Math.abs(row.f(solved))).toBeLessThanOrEqual(EXACT);
    const times: number[] = [];
    let steps = 0;
    for (let k = 0; k < 41; k++) {
      const x = Float64Array.from(solved, (v, i) =>
        exact.grounded[i] ? v : v + 1e-6 * Math.sin(17 * i + k),
      );
      const stats: PolishStats = { steps: 0, before: 0, after: 0 };
      const t0 = performance.now();
      const out = polish(exact, x, exact.rows, stats);
      times.push(performance.now() - t0);
      steps = Math.max(steps, stats.steps);
      expect(stats.after).toBeLessThanOrEqual(1);
      for (const row of exact.rows) expect(Math.abs(row.f(out))).toBeLessThanOrEqual(EXACT);
    }
    times.sort((p, q) => p - q);
    const median = times[20] as number;
    console.log(
      `[sketch perf] polish 200 entities (1e-6 mm off): median ${median.toFixed(3)} ms, max ${(times[40] as number).toFixed(3)} ms, ≤ ${steps} Newton steps`,
    );
    expect(steps).toBeGreaterThan(0);
    expect(median).toBeLessThan(process.env.CI ? 12 : 4);
  });
});
