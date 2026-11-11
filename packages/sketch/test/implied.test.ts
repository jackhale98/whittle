/**
 * M3.8 implied constraints: alignment classes (no redundant horizontal / vertical while drawing),
 * point reuse in tool fragments, and two-point splines that solve.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchBSpline, SketchConstraint, SketchEntity } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { AlignmentClasses, reusePoints } from '../src/implied';
import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS } from '../src/references';
import {
  circleCenterTool,
  polygonTool,
  rectangleCenterTool,
  splineControlTool,
  splineThroughTool,
} from '../src/tools';
import { ids } from './edit-helpers';
import { core, pos } from './helpers';

function must<T>(v: T | null): T {
  if (v === null) throw new Error('the tool made nothing');
  return v;
}

const pt = (id: string, x: number, y: number): SketchEntity => ({
  id,
  kind: 'point',
  construction: false,
  x,
  y,
});
const ln = (id: string, start: string, end: string): SketchEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});

describe('AlignmentClasses', () => {
  const entities = [pt('a', 0, 0), pt('b', 10, 0), pt('c', 10, 10), ln('ab', 'a', 'b')];

  it('a horizontal line, a vertical pair and coincidence share y / x', () => {
    const k = new AlignmentClasses(entities, [
      { id: '1', kind: 'horizontal', line: 'ab' },
      { id: '2', kind: 'verticalPoints', a: 'b', b: 'c' },
    ]);
    expect(k.same('y', 'a', 'b')).toBe(true);
    expect(k.same('x', 'a', 'b')).toBe(false);
    expect(k.same('x', 'b', 'c')).toBe(true);
    expect(k.redundant({ kind: 'horizontalPoints', a: 'b', b: 'a' })).toBe(true);
    expect(k.redundant({ kind: 'verticalPoints', a: 'c', b: 'b' })).toBe(true);
    expect(k.redundant({ kind: 'horizontalPoints', a: 'c', b: 'a' })).toBe(false);
    // A coincident is redundant only when both axes already agree.
    expect(k.redundant({ kind: 'coincident', a: 'a', b: 'b' })).toBe(false);
  });

  it('points on the axes align with the origin; fixed points with each other', () => {
    const k = new AlignmentClasses(entities, [
      { id: '1', kind: 'pointOn', point: 'a', on: SKETCH_X_AXIS },
      { id: '2', kind: 'pointOn', point: 'b', on: SKETCH_X_AXIS },
      { id: '3', kind: 'pointOn', point: 'c', on: SKETCH_Y_AXIS },
      { id: '4', kind: 'fix', entity: 'c' },
    ]);
    expect(k.redundant({ kind: 'horizontal', line: 'ab' })).toBe(true);
    expect(k.same('x', 'c', SKETCH_ORIGIN)).toBe(true);
    // c is fixed, and so is the origin: both coordinates already agree.
    expect(k.redundant({ kind: 'coincident', a: 'c', b: SKETCH_ORIGIN })).toBe(true);
    // Constraints that align nothing are never redundant here.
    expect(k.redundant({ kind: 'tangent', a: 'ab', b: 'x' })).toBe(false);
  });

  it('take adds once and refuses the repeat; lines drawn in the same edit can be registered', () => {
    const k = new AlignmentClasses(entities);
    k.line('@drawing', 'b', 'c');
    expect(k.take({ kind: 'vertical', line: '@drawing' })).toBe(true);
    expect(k.take({ kind: 'verticalPoints', a: 'c', b: 'b' })).toBe(false);
  });
});

describe('reusePoints', () => {
  it('drops the reused point and rewrites entities and constraints', () => {
    const frag = rectangleCenterTool([0, 0], [10, 5], { id: ids('r') });
    const centre = frag.entities.find(
      (e) => e.kind === 'point' && e.construction && e.x === 0 && e.y === 0,
    ) as SketchEntity;
    const out = reusePoints(frag, new Map([[centre.id, 'P']]));
    expect(out.entities.some((e) => e.id === centre.id)).toBe(false);
    expect(out.entities).toHaveLength(frag.entities.length - 1);
    const mid = out.constraints.find((c) => c.kind === 'midpoint');
    expect(mid?.kind === 'midpoint' && mid.point).toBe('P');
  });

  it('rewrites centres and poles', () => {
    const circle = circleCenterTool([0, 0], 5, { id: ids('c') });
    const c = reusePoints(circle, new Map([[circle.entities[0]?.id ?? '', 'P']]));
    expect(c.entities).toEqual([expect.objectContaining({ kind: 'circle', center: 'P' })]);
    const poly = must(polygonTool([0, 0], [5, 0], 4, { id: ids('p') }));
    const centre = poly.entities[0]?.id ?? '';
    const p = reusePoints(poly, new Map([[centre, 'P']]));
    expect(p.entities.find((e) => e.kind === 'circle')).toMatchObject({ center: 'P' });
    const sp = must(
      splineControlTool(
        [
          [0, 0],
          [5, 5],
          [10, 0],
        ],
        { id: ids('s') },
      ),
    );
    const pole = (sp.entities.find((e) => e.kind === 'bspline') as SketchBSpline).poles[1] ?? '';
    const s = reusePoints(sp, new Map([[pole, 'P']]));
    expect((s.entities.find((e) => e.kind === 'bspline') as SketchBSpline).poles[1]).toBe('P');
    expect(reusePoints(sp, new Map())).toBe(sp);
  });
});

describe('two-point splines (M3.8)', () => {
  const two = [
    [0, 0],
    [30, 10],
  ] as const satisfies readonly (readonly [number, number])[];

  it('through two points: a straight clamped cubic, its inner poles free end-tangent handles', async () => {
    const f = splineThroughTool(two.map((p) => [p[0], p[1]]));
    const s = f?.entities.find((e) => e.kind === 'bspline') as SketchBSpline;
    expect(s).toMatchObject({ degree: 3, periodic: false, through: [] });
    expect(s.poles).toHaveLength(4);
    const res = (await core()).solve({
      entities: f?.entities ?? [],
      constraints: f?.constraints ?? [],
      values: {},
    });
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(8); // two ends and two tangent handles
    // Straight: the handles sit on the chord at a third and two thirds.
    expect(pos(res, s.poles[1] ?? '')[0]).toBeCloseTo(10, 6);
    expect(pos(res, s.poles[2] ?? '')[1]).toBeCloseTo(20 / 3, 6);
  });

  it('by two control points: a degree-1 segment', async () => {
    const f = splineControlTool(two.map((p) => [p[0], p[1]]));
    const s = f?.entities.find((e) => e.kind === 'bspline') as SketchBSpline;
    expect(s).toMatchObject({ degree: 1, periodic: false });
    expect(s.poles).toHaveLength(2);
    const res = (await core()).solve({
      entities: f?.entities ?? [],
      constraints: f?.constraints ?? [],
      values: {},
    });
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(4);
  });

  it('a curve through the origin (pointOn with the origin as the point) solves', async () => {
    const f = circleCenterTool([10, 0], 9, { id: ids('o') });
    const circle = f.entities.find((e) => e.kind === 'circle') as SketchEntity;
    const constraints: SketchConstraint[] = [
      { id: 'on', kind: 'pointOn', point: SKETCH_ORIGIN, on: circle.id },
    ];
    const res = (await core()).solve({ entities: f.entities, constraints, values: {} });
    expect(res.status).toBe('solved');
    const r = res.entities.find((e) => e.kind === 'circle');
    const c = pos(res, f.entities[0]?.id ?? '');
    expect(r?.kind === 'circle' && r.radius).toBeCloseTo(Math.hypot(c[0], c[1]), 6);
  });
});
