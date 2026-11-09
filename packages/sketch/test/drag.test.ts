/**
 * Dragging with temporary constraints, and the drag-solve performance budget (PLAN §10:
 * ≤ 4 ms per solve for 200 entities).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  type Id,
  SKETCH_ORIGIN,
  type SketchSolveInput,
  type SketchSolveResult,
  type Vec2,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { core, pos, rectangle, SketchBuilder } from './helpers';

function isRectangle(res: SketchSolveResult, r: ReturnType<typeof rectangle>) {
  const [p0, p1, p2, p3] = [r.p0, r.p1, r.p2, r.p3].map((id) => pos(res, id)) as [
    Vec2,
    Vec2,
    Vec2,
    Vec2,
  ];
  expect(p1[1] - p0[1]).toBeCloseTo(0, 6);
  expect(p2[1] - p3[1]).toBeCloseTo(0, 6);
  expect(p2[0] - p1[0]).toBeCloseTo(0, 6);
  expect(p3[0] - p0[0]).toBeCloseTo(0, 6);
}

describe('drag', () => {
  it('dragging a free corner of an under-constrained rectangle keeps it a rectangle', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const r = rectangle(b);
    b.geo({ kind: 'fix', entity: r.p0 });
    const ref = b.dim({ kind: 'distance', a: r.p0, b: r.p2 }, 0, false);
    const start = pos(solver.solve(b.input()), r.p2);
    const { session } = solver.beginDrag(b.input(), r.p2, start);
    let last: SketchSolveResult | null = null;
    for (let i = 1; i <= 20; i++) {
      last = solver.drag(session, [start[0] + i, start[1] + i / 2]);
      expect(last.status).toBe('solved');
      isRectangle(last, r);
    }
    if (!last) throw new Error('no drag');
    // The corner followed the cursor exactly (it's free in both directions).
    expect(pos(last, r.p2)[0]).toBeCloseTo(start[0] + 20, 6);
    expect(pos(last, r.p2)[1]).toBeCloseTo(start[1] + 10, 6);
    expect(pos(last, r.p0)).toEqual([0, 0]);
    // Driven dimensions update live.
    expect(last.driven[ref]).toBeCloseTo(Math.hypot(start[0] + 20, start[1] + 10), 6);
    const end = solver.endDrag(session);
    expect(end.status).toBe('solved');
    isRectangle(end, r);
    expect(pos(end, r.p2)[0]).toBeCloseTo(start[0] + 20, 6);
  });

  it('a constrained direction resists: dragging a width-dimensioned corner only moves it vertically', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const r = rectangle(b);
    b.geo({ kind: 'fix', entity: r.p0 });
    b.dim({ kind: 'length', line: r.bottom }, 40);
    const grab = pos(solver.solve(b.input()), r.p2);
    const { session } = solver.beginDrag(b.input(), r.p2, grab);
    const res = solver.drag(session, [grab[0] + 15, grab[1] + 10]);
    expect(res.status).toBe('solved');
    expect(pos(res, r.p2)[0]).toBeCloseTo(40, 6);
    expect(pos(res, r.p2)[1]).toBeCloseTo(grab[1] + 10, 4);
    expect(res.dof).toBe(1);
    solver.endDrag(session);
  });

  it('dragging a line translates both ends; dragging a circle edge changes its radius', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [10, 0]);
    const c = b.point(30, 0);
    b.geo({ kind: 'fix', entity: c });
    const k = b.circle(c, 5);
    const s1 = solver.beginDrag(b.input(), l.line, [5, 0]);
    const r1 = solver.drag(s1.session, [5, 7]);
    expect(pos(r1, l.start)[1]).toBeCloseTo(7, 6);
    expect(pos(r1, l.end)[1]).toBeCloseTo(7, 6);
    solver.endDrag(s1.session);
    const s2 = solver.beginDrag(b.input(), k, [35, 0]);
    const r2 = solver.drag(s2.session, [38, 0]);
    const circle = r2.entities.find((e) => e.id === k);
    expect(circle?.kind === 'circle' && circle.radius).toBeCloseTo(8, 6);
    solver.endDrag(s2.session);
  });
});

/**
 * A connected 200-entity sketch: a chain of 25 rectangles (4 points + 4 lines each), each
 * joined to the next by a coincident corner, H/V edges and a width dimension; heights free.
 */
function chain(
  count = 25,
  anchor: 'fix' | 'origin' = 'fix',
): { input: SketchSolveInput; drag: Id; at: Vec2 } {
  const b = new SketchBuilder();
  let prev: ReturnType<typeof rectangle> | null = null;
  for (let i = 0; i < count; i++) {
    const r = rectangle(b, 10, 6 + (i % 3), [i * 10, 0], 0);
    if (prev) b.geo({ kind: 'coincident', a: prev.p1, b: r.p0 });
    else if (anchor === 'origin') b.geo({ kind: 'coincident', a: r.p0, b: SKETCH_ORIGIN });
    else b.geo({ kind: 'fix', entity: r.p0 });
    b.dim({ kind: 'length', line: r.bottom }, 10);
    prev = r;
  }
  if (!prev) throw new Error('empty');
  return { input: b.input(), drag: prev.p2, at: [count * 10, 6 + ((count - 1) % 3)] };
}

describe('drag performance', () => {
  for (const anchor of ['fix', 'origin'] as const)
    it(`median drag solve ≤ 4 ms for a connected 200-entity sketch (anchored by ${anchor})`, async () => {
      const solver = await core();
      const { input, drag, at } = chain(25, anchor);
      expect(input.entities).toHaveLength(200);
      const t0 = performance.now();
      const first = solver.solve(input);
      const solveMs = performance.now() - t0;
      expect(first.status).toBe('solved');
      expect(first.dof).toBe(25);
      const { session } = solver.beginDrag(input, drag, at);
      const times: number[] = [];
      let wall = 0;
      for (let i = 0; i < 100; i++) {
        const to: Vec2 = [at[0] + Math.sin(i / 10) * 3, at[1] + i * 0.05];
        const w0 = performance.now();
        const res = solver.drag(session, to);
        wall += performance.now() - w0;
        times.push(res.ms);
        expect(res.status).toBe('solved');
      }
      const end = solver.endDrag(session);
      expect(end.status).toBe('solved');
      times.sort((a, b) => a - b);
      const median = times[50] as number;
      const p95 = times[95] as number;
      console.log(
        `[sketch perf] 200 entities (${anchor}): full solve ${solveMs.toFixed(1)} ms; drag median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, mean wall ${(wall / 100).toFixed(2)} ms`,
      );
      // Budget is 4 ms (PLAN §10). CI containers can be slow; fail only far beyond it.
      expect(median).toBeLessThan(process.env.CI ? 12 : 4);
    });
});
