/**
 * Drag budget with splines (PLAN §10: ≤ 4 ms per drag solve for 200 entities), M3.5.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchSolveInput, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { interpolate } from '../src/bspline';
import { core, pos, SketchBuilder } from './helpers';

/**
 * 200 entities with 20 cubic splines drawn through points (4 through points each: 8 points + the
 * spline), joined by 19 lines tangent to the splines at both ends, plus one fixed anchor point.
 */
function splineChain(): { input: SketchSolveInput; drag: Id; at: Vec2; others: Id[] } {
  const b = new SketchBuilder();
  const anchor = b.point(-5, 0);
  b.geo({ kind: 'fix', entity: anchor });
  let prevEnd: Id | null = null;
  let prevSpline: Id | null = null;
  let drag: Id = anchor;
  let at: Vec2 = [0, 0];
  const others: Id[] = [];
  for (let i = 0; i < 20; i++) {
    const x0 = i * 40;
    const pts: Vec2[] = [
      [x0, 0],
      [x0 + 10, 6 + (i % 3)],
      [x0 + 20, -4],
      [x0 + 30, 0],
    ];
    const it = interpolate(pts, 3, false);
    if (!it) throw new Error('no interpolation');
    const through = pts.map((p) => b.point(p[0], p[1]));
    const poles = it.poles.map((p, k) =>
      k === 0
        ? (through[0] as Id)
        : k === it.poles.length - 1
          ? (through[3] as Id)
          : b.point(p[0], p[1]),
    );
    const s = b.bspline(poles, { knots: it.knots, multiplicities: it.multiplicities });
    for (const t of through.slice(1, 3)) b.geo({ kind: 'pointOn', point: t, on: s });
    if (prevEnd && prevSpline) {
      const l = b.line(prevEnd, through[0] as Id);
      b.geo({ kind: 'tangent', a: prevSpline, b: l });
      b.geo({ kind: 'tangent', a: l, b: s });
    } else b.geo({ kind: 'coincident', a: anchor, b: through[0] as Id });
    prevEnd = through[3] as Id;
    prevSpline = s;
    if (i === 10) {
      drag = through[1] as Id;
      at = pts[1] as Vec2;
      others.push(through[0] as Id, through[2] as Id, through[3] as Id);
    }
  }
  return { input: b.input(), drag, at, others };
}

describe('drag performance with splines', () => {
  it('median drag solve ≤ 4 ms for 200 entities with 20 splines', async () => {
    const solver = await core();
    const { input, drag, at, others } = splineChain();
    expect(input.entities).toHaveLength(200);
    expect(input.entities.filter((e) => e.kind === 'bspline')).toHaveLength(20);
    const t0 = performance.now();
    const first = solver.solve(input);
    const solveMs = performance.now() - t0;
    expect(first.status).toBe('solved');
    const before = others.map((id) => pos(first, id));
    const { session } = solver.beginDrag(input, drag, at);
    const times: number[] = [];
    let last = first;
    for (let i = 0; i < 100; i++) {
      const to: Vec2 = [at[0] + Math.sin(i / 10) * 3, at[1] + i * 0.03];
      last = solver.drag(session, to);
      times.push(last.ms);
      expect(last.status).toBe('solved');
    }
    // The dragged spline's other through points stay put.
    others.forEach((id, i) => expect(pos(last, id)).toEqual(before[i]));
    const end = solver.endDrag(session);
    expect(end.status).toBe('solved');
    times.sort((a, b) => a - b);
    const median = times[50] as number;
    console.log(
      `[sketch perf] 200 entities, 20 splines: full solve ${solveMs.toFixed(1)} ms; drag median ${median.toFixed(2)} ms, p95 ${(times[95] as number).toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(process.env.CI ? 12 : 4);
  });
});
