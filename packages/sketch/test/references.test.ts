/**
 * Sketch reference geometry (ADR-017 item 1): `@origin`, `@x` and `@y` as fixed geometry in solve,
 * DOF, driven dimensions, conflicts, polish, drag and inference.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  type Id,
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type SketchSolveInput,
  type Vec2,
} from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import { infer } from '../src/inference';
import { buildModel, isSatisfied } from '../src/model';
import { type PolishStats, polish } from '../src/polish';
import { isSketchReference, referenceEntities } from '../src/references';
import { core, deg, pos, rectangle, SketchBuilder } from './helpers';

const O = SKETCH_ORIGIN;
const X = SKETCH_X_AXIS;
const Y = SKETCH_Y_AXIS;
const REFS = [O, X, Y];

/** Rectangle anchored to the origin by dimensions only (no `fix`). */
function anchoredRect(dx = 10, dy = 5, w = 40, h = 20) {
  const b = new SketchBuilder();
  const r = rectangle(b, w, h, [dx + 2, dy - 1]);
  const hd = b.dim({ kind: 'hDistance', a: O, b: r.p0 }, dx);
  const vd = b.dim({ kind: 'vDistance', a: O, b: r.p0 }, dy);
  b.dim({ kind: 'length', line: r.bottom }, w);
  b.dim({ kind: 'length', line: r.left }, h);
  return { b, r, hd, vd };
}

function expectNoReferences(res: { entities: { id: Id }[]; entityDof: Record<Id, unknown> }) {
  for (const id of [...REFS, '@x:end', '@y:end']) {
    expect(res.entities.some((e) => e.id === id)).toBe(false);
    expect(id in res.entityDof).toBe(false);
  }
}

describe('reference geometry: solve and DOF', () => {
  it('a rectangle dimensioned from the origin is fully constrained without fix', async () => {
    const solver = await core();
    const { b, r } = anchoredRect();
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.dof).toBe(0);
    expect(pos(res, r.p0)[0]).toBeCloseTo(10, 9);
    expect(pos(res, r.p0)[1]).toBeCloseTo(5, 9);
    expect(pos(res, r.p2)[0]).toBeCloseTo(50, 9);
    expect(pos(res, r.p2)[1]).toBeCloseTo(25, 9);
    for (const e of b.entities) expect(res.entityDof[e.id], e.id).toBe('fixed');
    expect(res.entities).toHaveLength(b.entities.length);
    expectNoReferences(res);
    expect(res.redundant).toEqual([]);
  });

  it('changing the origin distance moves the rectangle', async () => {
    const solver = await core();
    const { b, r, hd } = anchoredRect();
    b.values[hd] = 25;
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, r.p0)[0]).toBeCloseTo(25, 9);
    expect(pos(res, r.p2)[0]).toBeCloseTo(65, 9);
  });

  it('without the origin dimensions the rectangle keeps its 2 translational DOF', async () => {
    const solver = await core();
    const { b, hd, vd } = anchoredRect();
    b.remove(hd);
    b.remove(vd);
    const res = solver.solve(b.input());
    expect(res.dof).toBe(2);
  });

  it('coincident with the origin pins a point; references never count as DOF', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(0.4, -0.3);
    const q = b.point(7, 3);
    b.geo({ kind: 'coincident', a: p, b: O });
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, p)[0]).toBe(0);
    expect(pos(res, p)[1]).toBe(0);
    expect(res.entityDof[p]).toBe('fixed');
    expect(res.entityDof[q]).toBe('free');
    expect(res.dof).toBe(2);
    expectNoReferences(res);
  });

  it('point on an axis leaves one DOF; on both axes it is at the origin', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(3, 0.7);
    const k = b.geo({ kind: 'pointOn', point: p, on: X });
    let res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, p)[1]).toBeCloseTo(0, 12);
    expect(pos(res, p)[0]).toBeCloseTo(3, 6);
    expect(res.entityDof[p]).toBe('partial');
    expect(res.dof).toBe(1);
    b.geo({ kind: 'pointOn', point: p, on: Y });
    res = solver.solve(b.input());
    expect(pos(res, p)[0]).toBeCloseTo(0, 12);
    expect(pos(res, p)[1]).toBeCloseTo(0, 12);
    expect(res.dof).toBe(0);
    b.remove(k);
    res = solver.solve(b.input());
    expect(pos(res, p)[0]).toBeCloseTo(0, 12);
    expect(res.dof).toBe(1);
  });

  it('horizontal/vertical alignment with the origin', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(4, 0.6);
    const q = b.point(-0.5, 9);
    b.geo({ kind: 'horizontalPoints', a: O, b: p });
    b.geo({ kind: 'verticalPoints', a: q, b: O });
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, p)[1]).toBeCloseTo(0, 12);
    expect(pos(res, q)[0]).toBeCloseTo(0, 12);
    expect(res.dof).toBe(2);
  });

  it('midpoint at the origin and symmetry about an axis or the origin', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l = b.segment([-9, 1], [11, 2]);
    b.geo({ kind: 'midpoint', point: O, line: l.line });
    const p = b.point(5, 3);
    const q = b.point(-4, 3.5);
    b.geo({ kind: 'symmetric', a: p, b: q, about: Y });
    const s = b.point(2, -6);
    const t = b.point(-2.5, 5);
    b.geo({ kind: 'symmetric', a: s, b: t, about: O });
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    const [a, e] = [pos(res, l.start), pos(res, l.end)];
    expect(a[0] + e[0]).toBeCloseTo(0, 10);
    expect(a[1] + e[1]).toBeCloseTo(0, 10);
    expect(pos(res, p)[0] + pos(res, q)[0]).toBeCloseTo(0, 10);
    expect(pos(res, p)[1] - pos(res, q)[1]).toBeCloseTo(0, 10);
    expect(pos(res, s)[0] + pos(res, t)[0]).toBeCloseTo(0, 10);
    expect(pos(res, s)[1] + pos(res, t)[1]).toBeCloseTo(0, 10);
  });

  it('parallel / perpendicular / angle to the axes', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l1 = b.segment([0, 0], [10, 1.5]);
    const l2 = b.segment([5, 5], [6, 15]);
    const l3 = b.segment([20, 0], [28, 5]);
    b.geo({ kind: 'parallel', a: l1.line, b: X });
    b.geo({ kind: 'perpendicular', a: X, b: l2.line });
    b.dim({ kind: 'angle', a: X, b: l3.line }, deg(30));
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, l1.end)[1] - pos(res, l1.start)[1]).toBeCloseTo(0, 10);
    expect(pos(res, l2.end)[0] - pos(res, l2.start)[0]).toBeCloseTo(0, 10);
    const d: Vec2 = [
      pos(res, l3.end)[0] - pos(res, l3.start)[0],
      pos(res, l3.end)[1] - pos(res, l3.start)[1],
    ];
    expect(Math.atan2(d[1], d[0])).toBeCloseTo(deg(30), 10);
  });

  it('tangent to an axis, and centre distances to the axes', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const c = b.point(12, 9);
    const circle = b.circle(c, 4);
    b.geo({ kind: 'tangent', a: circle, b: X });
    b.dim({ kind: 'distance', a: c, b: Y }, 15);
    b.dim({ kind: 'radius', curve: circle }, 6);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(pos(res, c)[0]).toBeCloseTo(15, 9);
    expect(Math.abs(pos(res, c)[1])).toBeCloseTo(6, 9);
    expect(res.dof).toBe(0);
  });

  it('distance from the origin, perpendicular distance to an axis, line–axis distance', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(3, 4.5);
    b.dim({ kind: 'distance', a: O, b: p }, 10);
    b.geo({ kind: 'pointOn', point: p, on: b.segment([0, 0], [6, 8]).line });
    const q = b.point(30, 7);
    b.dim({ kind: 'distance', a: q, b: X }, 12);
    const l = b.segment([0, 3], [10, 3.4]);
    b.geo({ kind: 'horizontal', line: l.line });
    b.dim({ kind: 'distance', a: l.line, b: X }, 20);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(Math.hypot(...pos(res, p))).toBeCloseTo(10, 9);
    expect(Math.abs(pos(res, q)[1])).toBeCloseTo(12, 9);
    expect(Math.abs(pos(res, l.start)[1])).toBeCloseTo(20, 9);
    expect(Math.abs(pos(res, l.end)[1])).toBeCloseTo(20, 9);
  });

  it('reference (driven) dimensions to the origin and axes are measured', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(7, -3);
    b.geo({ kind: 'fix', entity: p });
    const l = b.segment([1, 1], [4, 4]);
    b.geo({ kind: 'fix', entity: l.line });
    const c = b.point(-6, 8);
    const circle = b.circle(c, 2);
    b.geo({ kind: 'fix', entity: circle });
    const dd = b.dim({ kind: 'distance', a: O, b: p }, 0, false);
    const hd = b.dim({ kind: 'hDistance', a: O, b: p }, 0, false);
    const vd = b.dim({ kind: 'vDistance', a: O, b: p }, 0, false);
    const px = b.dim({ kind: 'distance', a: p, b: X }, 0, false);
    const py = b.dim({ kind: 'distance', a: Y, b: p }, 0, false);
    const ang = b.dim({ kind: 'angle', a: X, b: l.line }, 0, false);
    const angY = b.dim({ kind: 'angle', a: l.line, b: Y }, 0, false);
    const cc = b.dim({ kind: 'distance', a: c, b: Y }, 0, false);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(res.driven[dd]).toBeCloseTo(Math.hypot(7, 3), 12);
    expect(res.driven[hd]).toBeCloseTo(7, 12);
    expect(res.driven[vd]).toBeCloseTo(-3, 12);
    expect(res.driven[px]).toBeCloseTo(3, 12);
    expect(res.driven[py]).toBeCloseTo(7, 12);
    expect(res.driven[ang]).toBeCloseTo(deg(45), 12);
    expect(res.driven[angY]).toBeCloseTo(deg(45), 12);
    expect(res.driven[cc]).toBeCloseTo(6, 12);
  });

  it('constraints only between references are ignored when true, refused when false', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    b.point(1, 1);
    const ok1 = b.geo({ kind: 'perpendicular', a: X, b: Y });
    const ok2 = b.geo({ kind: 'pointOn', point: O, on: Y });
    const ok3 = b.geo({ kind: 'fix', entity: O });
    const ok4 = b.geo({ kind: 'horizontal', line: X });
    const bad = b.geo({ kind: 'parallel', a: X, b: Y });
    const res = solver.solve(b.input());
    expect(res.status).toBe('conflicting');
    expect(res.conflicts.map((c) => c.constraints)).toEqual([[bad]]);
    expect(res.conflicts[0]?.explanation).toMatch(/the horizontal axis, the vertical axis/);
    expect(res.conflicts[0]?.explanation).toMatch(/origin and axes, which never move/);
    for (const id of [ok1, ok2, ok3, ok4])
      expect(res.conflicts.some((c) => c.constraints.includes(id))).toBe(false);
  });

  it('axes have no length or midpoint; the origin is not a line', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l = b.segment([0, 5], [10, 5]);
    const p = b.point(2, 2);
    const k1 = b.dim({ kind: 'length', line: X }, 5);
    const k2 = b.geo({ kind: 'equal', a: l.line, b: Y });
    const k3 = b.geo({ kind: 'midpoint', point: p, line: X });
    const k4 = b.geo({ kind: 'coincident', a: p, b: X });
    const res = solver.solve(b.input());
    const byId = new Map(res.conflicts.map((c) => [c.constraints[0], c.explanation]));
    expect(byId.get(k1)).toMatch(/no length/);
    expect(byId.get(k2)).toMatch(/no length/);
    expect(byId.get(k3)).toMatch(/midpoint/);
    expect(byId.get(k4)).toMatch(/The horizontal axis is not a point/);
    for (const c of res.conflicts) expect(c.explanation).not.toMatch(/@/);
  });

  it('user entities may not take a reserved id', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    b.point(0, 0, O);
    const res = solver.solve(b.input());
    expect(res.status).toBe('failed');
  });

  it('a sketch without references builds exactly the same model as before', () => {
    const b = new SketchBuilder();
    rectangle(b);
    const m = buildModel(b.input());
    expect(m.x0.length).toBe(8);
    expect(m.index.has(O)).toBe(false);
    expect(referenceEntities().map((e) => e.id)).toEqual([O, '@x:end', '@y:end', X, Y]);
    expect(REFS.every(isSketchReference)).toBe(true);
    expect(isSketchReference('@x:end')).toBe(false);
  });
});

describe('reference geometry: conflicts', () => {
  it('on the horizontal axis and 5 mm above the origin: names them in plain words', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(3, 1);
    const on = b.geo({ kind: 'pointOn', point: p, on: X });
    const vd = b.dim({ kind: 'vDistance', a: O, b: p }, 5);
    const res = solver.solve(b.input());
    expect(res.status).toBe('conflicting');
    const c = res.conflicts[0];
    if (!c) throw new Error('no conflict');
    expect([...c.constraints].sort()).toEqual([on, vd].sort());
    expect(c.explanation).toMatch(/^Point 1 can't be both /);
    expect(c.explanation).toContain('on the horizontal axis');
    expect(c.explanation).toContain('5 mm vertically from the origin');
    expect(c.fixed ?? []).toEqual([]);
    // Fixes act on the user's constraints only; the references are never offered for removal.
    for (const f of c.fixes) {
      expect([on, vd]).toContain(f.action.constraint);
      expect(REFS).not.toContain(f.action.constraint);
      expect(f.label).not.toMatch(/@/);
    }
    const set = c.fixes.find((f) => f.action.kind === 'setValue');
    expect(set?.action.kind === 'setValue' && Math.abs(set.action.value)).toBeLessThan(1e-9);
  });

  it('a point at the origin cannot be 10 mm from it', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(1, 1);
    const k = b.geo({ kind: 'coincident', a: O, b: p });
    const d = b.dim({ kind: 'hDistance', a: O, b: p }, 10);
    const res = solver.solve(b.input());
    expect(res.status).toBe('conflicting');
    const c = res.conflicts[0];
    expect([...(c?.constraints ?? [])].sort()).toEqual([k, d].sort());
    expect(c?.explanation).toBe(
      "Point 1 can't be both at the origin and 10 mm horizontally from the origin",
    );
  });

  it('a line parallel to an axis cannot be at 30° to it', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const l = b.segment([0, 2], [10, 3]);
    const par = b.geo({ kind: 'parallel', a: l.line, b: Y });
    const ang = b.dim({ kind: 'angle', a: Y, b: l.line }, deg(30));
    const res = solver.solve(b.input());
    expect(res.status).toBe('conflicting');
    const c = res.conflicts[0];
    expect([...(c?.constraints ?? [])].sort()).toEqual([par, ang].sort());
    expect(c?.explanation).toMatch(
      /^Line 1 can't be both parallel to the vertical axis and at 30° to the vertical axis/,
    );
  });
});

describe('reference geometry: polish and drag', () => {
  it('polish drives origin dimensions to ≤ 1e-10 mm far from the origin', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const at: Vec2 = [1234.5678901, -987.654321];
    const r = rectangle(b, 33.3333333, 17.7777777, [at[0] + 0.7, at[1] - 0.4]);
    b.dim({ kind: 'hDistance', a: O, b: r.p0 }, at[0]);
    b.dim({ kind: 'vDistance', a: O, b: r.p0 }, at[1]);
    b.dim({ kind: 'length', line: r.bottom }, 33.3333333);
    b.dim({ kind: 'length', line: r.left }, 17.7777777);
    const res = solver.solve(b.input());
    expect(res.status).toBe('solved');
    expect(Math.abs(pos(res, r.p0)[0] - at[0])).toBeLessThan(1e-10);
    expect(Math.abs(pos(res, r.p0)[1] - at[1])).toBeLessThan(1e-10);
    expect(Math.abs(pos(res, r.p2)[0] - (at[0] + 33.3333333))).toBeLessThan(1e-10);
  });

  it('polish moves only user parameters (the references stay exactly put)', () => {
    const b = new SketchBuilder();
    const p = b.point(5 + 3e-8, 2e-8);
    b.dim({ kind: 'hDistance', a: O, b: p }, 5);
    b.geo({ kind: 'pointOn', point: p, on: X });
    const input: SketchSolveInput = b.input();
    const model = buildModel(input);
    expect(isSatisfied(model, model.x0)).toBe(true); // within the 1e-7 × size check
    const stats: PolishStats = { steps: 0, before: 0, after: 0 };
    const x = polish(model, model.x0, model.rows, stats);
    expect(stats.steps).toBeGreaterThan(0);
    const i = model.pointIdx.get(p) as number;
    expect(Math.abs((x[i] as number) - 5)).toBeLessThan(1e-11);
    expect(Math.abs(x[i + 1] as number)).toBeLessThan(1e-11);
    for (const id of [O, '@x:end', '@y:end']) {
      const k = model.pointIdx.get(id) as number;
      expect([x[k], x[k + 1]]).toEqual([model.x0[k], model.x0[k + 1]]);
    }
  });

  it('dragging a point on an axis slides along it; references cannot be dragged', async () => {
    const solver = await core();
    const b = new SketchBuilder();
    const p = b.point(4, 0);
    b.geo({ kind: 'pointOn', point: p, on: X });
    const { session } = solver.beginDrag(b.input(), p, [4, 0]);
    const res = solver.drag(session, [9, 3]);
    expect(res.status).toBe('solved');
    expect(pos(res, p)[0]).toBeCloseTo(9, 6);
    expect(Math.abs(pos(res, p)[1])).toBeLessThan(1e-10);
    const end = solver.endDrag(session);
    expect(end.status).toBe('solved');
    expectNoReferences(end);

    const r = solver.beginDrag(b.input(), X, [5, 0]);
    const moved = solver.drag(r.session, [5, 10]);
    expect(pos(moved, p)).toEqual([4, 0]);
    solver.endDrag(r.session);
  });
});

describe('reference geometry: inference', () => {
  const empty: SketchSolveInput = { entities: [], constraints: [], values: {} };

  it('snaps coincident to the origin', () => {
    const c = infer(empty, [0.3, -0.2], null, 1);
    expect(c[0]?.constraint).toEqual({ kind: 'coincident', a: '@cursor', b: O });
    expect(c[0]?.snapped).toEqual([0, 0]);
    // No "point on axis" at the origin: coincident says it all.
    expect(c.some((k) => k.constraint.kind === 'pointOn')).toBe(false);
  });

  it('snaps onto the axes (point on) and offers origin alignment guides', () => {
    const c = infer(empty, [12, 0.4], null, 1);
    expect(c[0]?.constraint).toEqual({ kind: 'pointOn', point: '@cursor', on: X });
    expect(c[0]?.snapped).toEqual([12, 0]);
    const guide = c.find((k) => k.constraint.kind === 'horizontalPoints');
    expect(guide?.constraint).toEqual({ kind: 'horizontalPoints', a: '@cursor', b: O });
    expect(guide?.snapped).toEqual([12, 0]);

    const v = infer(empty, [-0.5, 30], null, 1);
    expect(v[0]?.constraint).toEqual({ kind: 'pointOn', point: '@cursor', on: Y });
    expect(v[0]?.snapped).toEqual([0, 30]);
    expect(v.find((k) => k.constraint.kind === 'verticalPoints')?.snapped).toEqual([0, 30]);
  });

  it('real geometry at the same spot wins over the references', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const l = b.segment([-5, 0], [20, 0]);
    const at = infer(b.input(), [0.2, 0.1], null, 1);
    expect(at[0]?.constraint).toEqual({ kind: 'coincident', a: '@cursor', b: p });
    expect(at.find((k) => k.constraint.kind === 'coincident' && k.constraint.b === O)).toBeTruthy();
    const on = infer(b.input(), [12, 0.3], null, 1);
    expect(on[0]?.constraint).toEqual({ kind: 'pointOn', point: '@cursor', on: l.line });
    expect(on.some((k) => k.constraint.kind === 'pointOn' && k.constraint.on === X)).toBe(true);
  });

  it('the origin is not offered while drawing from it', () => {
    const c = infer(empty, [0.2, 0.2], { kind: 'line', from: [0, 0] }, 1);
    expect(c.some((k) => k.constraint.kind === 'coincident')).toBe(false);
  });
});
