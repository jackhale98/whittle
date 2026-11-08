/**
 * DOF analysis, per-entity state, redundancy and driven (reference) dimensions.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { GcsWrapper } from '@salusoft89/planegcs';
import { describe, expect, it, vi } from 'vitest';
import { core, pos, rectangle, SketchBuilder } from './helpers';

function fullyConstrainedRect() {
  const b = new SketchBuilder();
  const r = rectangle(b);
  b.geo({ kind: 'fix', entity: r.p0 });
  const width = b.dim({ kind: 'length', line: r.bottom }, 40);
  const height = b.dim({ kind: 'length', line: r.left }, 20);
  return { b, r, width, height };
}

describe('DOF', () => {
  it('a fully constrained rectangle has dof 0 and every entity fixed', async () => {
    const solver = await core();
    const { b, r } = fullyConstrainedRect();
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(0);
    expect(pos(res, r.p2)[0]).toBeCloseTo(40, 9);
    expect(pos(res, r.p2)[1]).toBeCloseTo(20, 9);
    for (const e of b.entities) expect(res.entityDof[e.id], e.id).toBe('fixed');
    expect(res.conflicts).toEqual([]);
    expect(res.redundant).toEqual([]);
  });

  it('removing the width leaves 1 dof and marks the moving side partial', async () => {
    const solver = await core();
    const { b, r, width } = fullyConstrainedRect();
    b.remove(width);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(1);
    // p1/p2 can slide in x only; the lines touching them change length or position.
    expect(res.entityDof[r.p1]).toBe('partial');
    expect(res.entityDof[r.p2]).toBe('partial');
    expect(res.entityDof[r.bottom]).toBe('partial');
    expect(res.entityDof[r.top]).toBe('partial');
    expect(res.entityDof[r.right]).toBe('partial');
    // The left side is pinned by the fixed corner, the height and the vertical constraint.
    expect(res.entityDof[r.p0]).toBe('fixed');
    expect(res.entityDof[r.p3]).toBe('fixed');
    expect(res.entityDof[r.left]).toBe('fixed');
  });

  it('unconstrained geometry is free; a lone horizontal line is partial', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(5, 5);
    const l = b.segment([0, 0], [10, 1]);
    const free = b.segment([0, 10], [10, 12]);
    b.geo({ kind: 'horizontal', line: l.line });
    const res = solver.solve(b.input());
    expect(res.dof).toBe(2 + 3 + 4);
    expect(res.entityDof[p]).toBe('free');
    expect(res.entityDof[free.line]).toBe('free');
    expect(res.entityDof[l.line]).toBe('partial');
    expect(res.entityDof[l.start]).toBe('free');
  });

  it('counts arc and circle dof (arc rule is internal)', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 10);
    const arc = b.arc(c, s, e);
    const cc = b.point(30, 0);
    const circle = b.circle(cc, 5);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(5 + 3);
    expect(res.entityDof[arc]).toBe('free');
    expect(res.entityDof[circle]).toBe('free');
    b.geo({ kind: 'fix', entity: c });
    b.dim({ kind: 'radius', curve: arc }, 10);
    b.dim({ kind: 'radius', curve: circle }, 5);
    const res2 = solver.solve(b.input());
    expect(res2.dof).toBe(2 + 2);
    expect(res2.entityDof[arc]).toBe('partial');
    expect(res2.entityDof[circle]).toBe('partial');
  });
});

describe('redundant constraints', () => {
  it('horizontal + horizontal + parallel: parallel is redundant, not a conflict', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l1 = b.segment([0, 0], [10, 1]);
    const l2 = b.segment([0, 5], [10, 6]);
    b.geo({ kind: 'horizontal', line: l1.line });
    b.geo({ kind: 'horizontal', line: l2.line });
    const par = b.geo({ kind: 'parallel', a: l1.line, b: l2.line });
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.conflicts).toEqual([]);
    expect(res.redundant).toEqual([par]);
    expect(res.dof).toBe(8 - 2);
  });

  it('a duplicated dimension is redundant', async () => {
    const solver = await core();
    const { b, r } = fullyConstrainedRect();
    const again = b.dim({ kind: 'length', line: r.top }, 40);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(0);
    expect(res.redundant).toEqual([again]);
  });
});

describe('driven (reference) dimensions', () => {
  it('are measured from the solved geometry and never passed to planegcs', async () => {
    const solver = await core();
    const { b, r } = fullyConstrainedRect();
    const diag = b.dim({ kind: 'distance', a: r.p0, b: r.p2 }, 999, false);
    const ang = b.dim({ kind: 'angle', a: r.bottom, b: r.right }, 0, false);
    const rad = b.dim({ kind: 'length', line: r.top }, 1, false);
    const recorder = vi.spyOn(GcsWrapper.prototype, 'push_primitive');
    const res = solver.solve(b.input());
    const ids = recorder.mock.calls.map(([o]) => o.id);
    recorder.mockRestore();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of [diag, ang, rad]) expect(ids.some((x) => x.includes(`:${id}:`))).toBe(false);
    expect(res.status).toBe('solved');
    expect(res.driven[diag]).toBeCloseTo(Math.hypot(40, 20), 9);
    expect(res.driven[ang]).toBeCloseTo(Math.PI / 2, 9);
    expect(res.driven[rad]).toBeCloseTo(40, 9);
    // Reference dimensions don't constrain: dof stays 0, no redundancy/conflict from them.
    expect(res.dof).toBe(0);
    expect(res.redundant).toEqual([]);
  });
});
