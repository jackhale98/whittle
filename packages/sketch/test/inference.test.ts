/**
 * Constraint inference while drawing.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { InferenceCandidate, SketchSolveInput } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { bindCandidate, CURSOR_POINT, DRAWING_ENTITY, infer } from '../src/inference';
import { SketchBuilder } from './helpers';

function scene() {
  const b = new SketchBuilder();
  const base = b.segment([0, 0], [10, 0]);
  const slant = b.segment([30, 0], [40, 10]);
  const cc = b.point(60, 0);
  const circle = b.circle(cc, 5);
  return { input: b.input(), base, slant, cc, circle };
}

const kinds = (c: InferenceCandidate[]) => c.map((x) => x.constraint.kind);
const find = (c: InferenceCandidate[], kind: string) => c.find((x) => x.constraint.kind === kind);

describe('infer', () => {
  it('snaps to an endpoint first', () => {
    const { input, base } = scene();
    const c = infer(input, [10.3, 0.2], null, 1);
    expect(c[0]?.constraint).toEqual({ kind: 'coincident', a: CURSOR_POINT, b: base.end });
    expect(c[0]?.snapped).toEqual([10, 0]);
    expect(c[0]?.score).toBeGreaterThan(0.5);
    expect(c[0]?.score).toBeLessThanOrEqual(1);
    // Point-on-line is offered too, ranked lower.
    const on = find(c, 'pointOn');
    expect(on && on.score < (c[0]?.score ?? 0)).toBe(true);
  });

  it('snaps to a midpoint', () => {
    const { input, base } = scene();
    const c = infer(input, [5.2, 0.3], null, 1);
    expect(c[0]?.constraint).toEqual({ kind: 'midpoint', point: CURSOR_POINT, line: base.line });
    expect(c[0]?.snapped).toEqual([5, 0]);
    expect(kinds(c)).toContain('pointOn');
  });

  it('point on a circle', () => {
    const { input, circle } = scene();
    const c = infer(input, [60, 5.4], null, 1);
    const on = find(c, 'pointOn');
    expect(on?.constraint).toEqual({ kind: 'pointOn', point: CURSOR_POINT, on: circle });
    expect(on?.snapped[0]).toBeCloseTo(60, 9);
    expect(on?.snapped[1]).toBeCloseTo(5, 9);
  });

  it('horizontal within 3°, snapped onto the start height', () => {
    const { input } = scene();
    const c = infer(input, [20, 5.6], { kind: 'line', from: [0, 5] }, 1);
    const h = find(c, 'horizontal');
    expect(h?.constraint).toEqual({ kind: 'horizontal', line: DRAWING_ENTITY });
    expect(h?.snapped).toEqual([20, 5]);
    expect(
      find(infer(input, [20, 9], { kind: 'line', from: [0, 5] }, 1), 'horizontal'),
    ).toBeUndefined();
  });

  it('vertical within 3°', () => {
    const { input } = scene();
    const v = find(infer(input, [100.5, 20], { kind: 'line', from: [100, 0] }, 1), 'vertical');
    expect(v?.snapped).toEqual([100, 20]);
  });

  it('parallel and perpendicular to nearby lines', () => {
    const { input, slant } = scene();
    const par = find(infer(input, [30.3, 20.0], { kind: 'line', from: [20, 10] }, 0.5), 'parallel');
    expect(par?.constraint).toEqual({ kind: 'parallel', a: DRAWING_ENTITY, b: slant.line });
    expect((par?.snapped[0] ?? 0) - 20).toBeCloseTo((par?.snapped[1] ?? 0) - 10, 9);
    const perp = find(
      infer(input, [40.2, 0.1], { kind: 'line', from: [50, -10] }, 0.5),
      'perpendicular',
    );
    expect(perp?.constraint).toEqual({ kind: 'perpendicular', a: DRAWING_ENTITY, b: slant.line });
    expect((perp?.snapped[0] ?? 0) - 50).toBeCloseTo(-((perp?.snapped[1] ?? 0) + 10), 9);
  });

  it('tangent to a circle from an outside point', () => {
    const { input, circle } = scene();
    // From (60, 20) the tangent points of the r=5 circle at (60,0) are at y = 1.25.
    const from: [number, number] = [60, 20];
    const t = find(infer(input, [64.9, 1.4], { kind: 'line', from }, 1), 'tangent');
    expect(t?.constraint).toEqual({ kind: 'tangent', a: DRAWING_ENTITY, b: circle });
    const [x, y] = t?.snapped ?? [0, 0];
    expect(Math.hypot(x - 60, y)).toBeCloseTo(5, 9);
    // Radius ⟂ tangent line.
    expect((x - 60) * (x - from[0]) + y * (y - from[1])).toBeCloseTo(0, 9);
  });

  it('tangent continuation from an arc end', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 10);
    const arc = b.arc(c, s, e);
    const cand = infer(b.input(), [-20, 10.5], { kind: 'line', from: [0, 10] }, 1);
    const t = find(cand, 'tangent');
    expect(t?.constraint).toEqual({ kind: 'tangent', a: DRAWING_ENTITY, b: arc });
    expect(t?.snapped[1]).toBeCloseTo(10, 9);
  });

  it('equal length and equal radius', () => {
    const { input, base, circle } = scene();
    const eq = find(infer(input, [100, 20.4], { kind: 'line', from: [100, 30] }, 1), 'equal');
    expect(eq?.constraint).toEqual({ kind: 'equal', a: DRAWING_ENTITY, b: base.line });
    expect(eq?.snapped[1]).toBeCloseTo(20, 9);
    const er = find(infer(input, [105.3, 0], { kind: 'circle', from: [100, 0] }, 1), 'equal');
    expect(er?.constraint).toEqual({ kind: 'equal', a: DRAWING_ENTITY, b: circle });
    expect(er?.snapped).toEqual([105, 0]);
  });

  it('alignment guides with existing points', () => {
    const { input, cc } = scene();
    const c = infer(input, [80, 0.4], null, 1);
    const h = find(c, 'horizontalPoints');
    expect(h?.snapped).toEqual([80, 0]);
    expect(h?.constraint.kind).toBe('horizontalPoints');
    expect(JSON.stringify(h?.constraint)).toContain(cc);
  });

  it('ignores the point being drawn from and returns nothing far away', () => {
    const { input, base } = scene();
    const c = infer(input, [0.1, 0.1], { kind: 'line', from: [0, 0] }, 1);
    expect(
      c.some(
        (x) =>
          x.constraint.kind === 'coincident' && JSON.stringify(x.constraint).includes(base.start),
      ),
    ).toBe(false);
    const empty: SketchSolveInput = { entities: [], constraints: [], values: {} };
    expect(infer(empty, [1, 1], null, 1)).toEqual([]);
  });

  it('bindCandidate substitutes placeholders', () => {
    expect(
      bindCandidate(
        { kind: 'coincident', a: CURSOR_POINT, b: 'p9' },
        { cursorPoint: 'p1', drawingEntity: 'l1' },
      ),
    ).toEqual({ kind: 'coincident', a: 'p1', b: 'p9' });
    expect(
      bindCandidate({ kind: 'horizontal', line: DRAWING_ENTITY }, { drawingEntity: 'l1' }),
    ).toEqual({
      kind: 'horizontal',
      line: 'l1',
    });
  });
});
