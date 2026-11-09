/**
 * Every constraint and dimension kind solves to the right geometry.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchSolveResult, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { core, deg, pos, radius, SketchBuilder } from './helpers';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dir = (a: Vec2, b: Vec2): Vec2 => {
  const l = dist(a, b);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

async function solved(b: SketchBuilder): Promise<SketchSolveResult> {
  const res = (await core()).solve(b.input());
  expect(res.status, JSON.stringify(res.conflicts)).toBe('solved');
  return res;
}

function pointLineDistance(p: Vec2, a: Vec2, b: Vec2) {
  const d = dir(a, b);
  return Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]);
}

describe('geometric constraints', () => {
  it('coincident', async () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(3, 4);
    b.geo({ kind: 'coincident', a: p, b: q });
    const r = await solved(b);
    expect(dist(pos(r, p), pos(r, q))).toBeLessThan(1e-7);
  });

  it('pointOn line / circle / arc', async () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [10, 0]);
    b.geo({ kind: 'fix', entity: l.line });
    const p = b.point(4, 3);
    b.geo({ kind: 'pointOn', point: p, on: l.line });
    const c = b.point(20, 0);
    b.geo({ kind: 'fix', entity: c });
    const circle = b.circle(c, 5);
    b.dim({ kind: 'radius', curve: circle }, 5);
    const q = b.point(27, 1);
    b.geo({ kind: 'pointOn', point: q, on: circle });
    const ac = b.point(40, 0);
    const as = b.point(46, 0);
    const ae = b.point(40, 6);
    const arc = b.arc(ac, as, ae);
    b.geo({ kind: 'fix', entity: arc });
    const s = b.point(45, 5);
    b.geo({ kind: 'pointOn', point: s, on: arc });
    const r = await solved(b);
    expect(pos(r, p)[1]).toBeCloseTo(0, 7);
    expect(dist(pos(r, q), [20, 0])).toBeCloseTo(5, 7);
    expect(dist(pos(r, s), [40, 0])).toBeCloseTo(6, 7);
  });

  it('horizontal / vertical (lines and point pairs)', async () => {
    const b = new SketchBuilder();
    const h = b.segment([0, 0], [10, 2]);
    const v = b.segment([0, 0], [1, 10]);
    b.geo({ kind: 'horizontal', line: h.line });
    b.geo({ kind: 'vertical', line: v.line });
    const p = b.point(0, 0);
    const q = b.point(5, 3);
    const s = b.point(8, -2);
    b.geo({ kind: 'horizontalPoints', a: p, b: q });
    b.geo({ kind: 'verticalPoints', a: q, b: s });
    const r = await solved(b);
    expect(pos(r, h.end)[1] - pos(r, h.start)[1]).toBeCloseTo(0, 8);
    expect(pos(r, v.end)[0] - pos(r, v.start)[0]).toBeCloseTo(0, 8);
    expect(pos(r, q)[1]).toBeCloseTo(pos(r, p)[1], 8);
    expect(pos(r, s)[0]).toBeCloseTo(pos(r, q)[0], 8);
  });

  it('parallel / perpendicular', async () => {
    const b = new SketchBuilder();
    const a = b.segment([0, 0], [10, 3]);
    b.geo({ kind: 'fix', entity: a.line });
    const p = b.segment([0, 5], [10, 6]);
    const q = b.segment([0, -5], [2, -12]);
    b.geo({ kind: 'parallel', a: a.line, b: p.line });
    b.geo({ kind: 'perpendicular', a: a.line, b: q.line });
    const r = await solved(b);
    const da = dir(pos(r, a.start), pos(r, a.end));
    const dp = dir(pos(r, p.start), pos(r, p.end));
    const dq = dir(pos(r, q.start), pos(r, q.end));
    expect(da[0] * dp[1] - da[1] * dp[0]).toBeCloseTo(0, 8);
    expect(da[0] * dq[0] + da[1] * dq[1]).toBeCloseTo(0, 8);
  });

  it('tangent: line–circle, line–arc, circle–circle (external and internal)', async () => {
    const b = new SketchBuilder();
    const c1 = b.point(0, 0);
    b.geo({ kind: 'fix', entity: c1 });
    const k1 = b.circle(c1, 10);
    b.dim({ kind: 'radius', curve: k1 }, 10);
    const l = b.segment([-10, 12], [10, 13]);
    b.geo({ kind: 'tangent', a: l.line, b: k1 });
    const c2 = b.point(17, 1);
    const k2 = b.circle(c2, 5);
    b.dim({ kind: 'radius', curve: k2 }, 5);
    b.geo({ kind: 'tangent', a: k1, b: k2 });
    const c3 = b.point(2, 1);
    const k3 = b.circle(c3, 3);
    b.dim({ kind: 'radius', curve: k3 }, 3);
    b.geo({ kind: 'tangent', a: k3, b: k1 }); // internal: centre inside k1
    const ac = b.point(50, 0);
    b.geo({ kind: 'fix', entity: ac });
    const as = b.point(58, 0);
    const ae = b.point(50, 8);
    const arc = b.arc(ac, as, ae);
    b.dim({ kind: 'radius', curve: arc }, 8);
    const la = b.segment([40, 9], [60, 10]);
    b.geo({ kind: 'tangent', a: arc, b: la.line });
    const r = await solved(b);
    expect(pointLineDistance([0, 0], pos(r, l.start), pos(r, l.end))).toBeCloseTo(10, 7);
    expect(dist(pos(r, c2), [0, 0])).toBeCloseTo(15, 7);
    expect(dist(pos(r, c3), [0, 0])).toBeCloseTo(7, 7);
    expect(pointLineDistance([50, 0], pos(r, la.start), pos(r, la.end))).toBeCloseTo(8, 7);
  });

  it('endpoint tangency: line–arc and arc–arc sharing a point, line end on a circle', async () => {
    const b = new SketchBuilder();
    // Line ending where an arc starts.
    const l = b.segment([-10, 1], [0, 0]);
    b.geo({ kind: 'fix', entity: l.start });
    const c1 = b.point(1, 9);
    const e1 = b.point(9, 10);
    const arc1 = b.arc(c1, l.end, e1);
    b.geo({ kind: 'tangent', a: l.line, b: arc1 });
    // Second arc continuing from the first one's end (coincident, different point ids).
    const s2 = b.point(9.5, 10.2);
    b.geo({ kind: 'coincident', a: e1, b: s2 });
    const c2 = b.point(16, 4);
    const e2 = b.point(20, 12);
    const arc2 = b.arc(c2, e2, s2);
    b.geo({ kind: 'tangent', a: arc1, b: arc2 });
    // A line whose end is put on a circle, tangent there.
    const cc = b.point(50, 0);
    b.geo({ kind: 'fix', entity: cc });
    const k = b.circle(cc, 5);
    b.dim({ kind: 'radius', curve: k }, 5);
    const t = b.segment([40, 8], [51, 5.5]);
    b.geo({ kind: 'pointOn', point: t.end, on: k });
    b.geo({ kind: 'tangent', a: t.line, b: k });
    const r = await solved(b);
    const dot = (u: Vec2, v: Vec2) => u[0] * v[0] + u[1] * v[1];
    const sub = (u: Vec2, v: Vec2): Vec2 => [u[0] - v[0], u[1] - v[1]];
    expect(dot(dir(pos(r, l.start), pos(r, l.end)), dir(pos(r, c1), pos(r, l.end)))).toBeCloseTo(
      0,
      7,
    );
    const j = pos(r, e1);
    const u = sub(j, pos(r, c1));
    const v = sub(pos(r, c2), pos(r, c1));
    expect((u[0] * v[1] - u[1] * v[0]) / Math.hypot(...u)).toBeCloseTo(0, 7);
    expect(dist(pos(r, t.end), [50, 0])).toBeCloseTo(5, 7);
    expect(pointLineDistance([50, 0], pos(r, t.start), pos(r, t.end))).toBeCloseTo(5, 6);
    // The tangent rows are regular here, so nothing is reported redundant.
    expect(r.redundant).toEqual([]);
  });

  it('equal length and equal radius', async () => {
    const b = new SketchBuilder();
    const a = b.segment([0, 0], [10, 0]);
    b.dim({ kind: 'length', line: a.line }, 12);
    const c = b.segment([0, 5], [3, 9]);
    b.geo({ kind: 'equal', a: a.line, b: c.line });
    const k1 = b.circle(b.point(30, 0), 4);
    b.dim({ kind: 'radius', curve: k1 }, 4);
    const k2 = b.circle(b.point(50, 0), 9);
    b.geo({ kind: 'equal', a: k1, b: k2 });
    const r = await solved(b);
    expect(dist(pos(r, c.start), pos(r, c.end))).toBeCloseTo(12, 7);
    expect(radius(r, k2)).toBeCloseTo(4, 7);
  });

  it('midpoint, concentric, symmetric', async () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [10, 4]);
    b.geo({ kind: 'fix', entity: l.line });
    const m = b.point(3, 3);
    b.geo({ kind: 'midpoint', point: m, line: l.line });
    const ca = b.point(20, 0);
    b.geo({ kind: 'fix', entity: ca });
    const k1 = b.circle(ca, 3);
    const k2 = b.circle(b.point(22, 1), 6);
    b.geo({ kind: 'concentric', a: k1, b: k2 });
    const axis = b.segment([0, -10], [10, -10]);
    b.geo({ kind: 'fix', entity: axis.line });
    const p = b.point(2, -6);
    b.geo({ kind: 'fix', entity: p });
    const q = b.point(3, -15);
    b.geo({ kind: 'symmetric', a: p, b: q, about: axis.line });
    const r = await solved(b);
    expect(pos(r, m)[0]).toBeCloseTo(5, 8);
    expect(pos(r, m)[1]).toBeCloseTo(2, 8);
    const centre2 = r.entities.find((e) => e.id === k2);
    expect(centre2?.kind).toBe('circle');
    if (centre2?.kind === 'circle')
      expect(dist(pos(r, centre2.center), [20, 0])).toBeLessThan(1e-7);
    expect(pos(r, q)[0]).toBeCloseTo(2, 7);
    expect(pos(r, q)[1]).toBeCloseTo(-14, 7);
  });

  it('ellipse (P1): point on a fixed ellipse', async () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const id = 'e1';
    b.entities.push({
      id,
      kind: 'ellipse',
      construction: false,
      center: c,
      majorRadius: 10,
      minorRadius: 5,
      rotation: 0,
    });
    b.geo({ kind: 'fix', entity: id });
    const p = b.point(1, 7);
    b.geo({ kind: 'verticalPoints', a: c, b: p });
    b.geo({ kind: 'pointOn', point: p, on: id });
    const r = await solved(b);
    expect(Math.abs(pos(r, p)[1])).toBeCloseTo(5, 7);
    const e = r.entities.find((x) => x.id === id);
    expect(e?.kind === 'ellipse' && e.majorRadius).toBeCloseTo(10, 9);
    expect(e?.kind === 'ellipse' && e.minorRadius).toBeCloseTo(5, 9);
    expect(r.dof).toBe(0);
  });

  it('fix holds geometry in place', async () => {
    const b = new SketchBuilder();
    const l = b.segment([1, 2], [5, 9]);
    b.geo({ kind: 'fix', entity: l.line });
    b.geo({ kind: 'horizontalPoints', a: l.start, b: b.point(7, 7) });
    const r = await solved(b);
    expect(pos(r, l.start)).toEqual([1, 2]);
    expect(pos(r, l.end)).toEqual([5, 9]);
  });
});

describe('dimensions', () => {
  it('distance point–point, point–line, line–line, point–circle, circle–circle, circle–line', async () => {
    const b = new SketchBuilder();
    const o = b.point(0, 0);
    b.geo({ kind: 'fix', entity: o });
    const p = b.point(3, 3);
    b.geo({ kind: 'horizontalPoints', a: o, b: p });
    b.dim({ kind: 'distance', a: o, b: p }, 7);
    const base = b.segment([0, -20], [20, -20]);
    b.geo({ kind: 'fix', entity: base.line });
    const q = b.point(5, -10);
    b.geo({ kind: 'verticalPoints', a: base.start, b: q });
    b.dim({ kind: 'distance', a: q, b: base.line }, 4);
    const par = b.segment([0, -30], [20, -31]);
    b.geo({ kind: 'parallel', a: base.line, b: par.line });
    b.dim({ kind: 'distance', a: par.line, b: base.line }, 6);
    b.geo({ kind: 'verticalPoints', a: base.start, b: par.start });
    const cc = b.point(50, 0);
    b.geo({ kind: 'fix', entity: cc });
    const k = b.circle(cc, 10);
    b.dim({ kind: 'radius', curve: k }, 10);
    const s = b.point(50, 13);
    b.geo({ kind: 'verticalPoints', a: cc, b: s });
    b.dim({ kind: 'distance', a: s, b: k }, 5);
    const c2p = b.point(75, 1);
    const k2 = b.circle(c2p, 4);
    b.dim({ kind: 'radius', curve: k2 }, 4);
    b.geo({ kind: 'horizontalPoints', a: cc, b: c2p });
    b.dim({ kind: 'distance', a: k, b: k2 }, 3);
    const tl = b.segment([40, 20], [60, 21]);
    b.geo({ kind: 'horizontal', line: tl.line });
    b.dim({ kind: 'distance', a: k, b: tl.line }, 2);
    const r = await solved(b);
    expect(pos(r, p)[0]).toBeCloseTo(7, 7);
    expect(pos(r, q)[1]).toBeCloseTo(-16, 7);
    expect(pos(r, par.start)[1]).toBeCloseTo(-26, 7);
    expect(pos(r, s)[1]).toBeCloseTo(15, 7);
    const c2 = r.entities.find((e) => e.id === k2);
    if (c2?.kind !== 'circle') throw new Error('circle');
    expect(dist(pos(r, c2.center), [50, 0])).toBeCloseTo(17, 7);
    expect(pos(r, tl.start)[1]).toBeCloseTo(12, 7);
  });

  it('hDistance / vDistance are signed: b minus a', async () => {
    const b = new SketchBuilder();
    const o = b.point(0, 0);
    b.geo({ kind: 'fix', entity: o });
    const p = b.point(5, 5);
    b.dim({ kind: 'hDistance', a: o, b: p }, -8);
    b.dim({ kind: 'vDistance', a: o, b: p }, 3);
    const l = b.segment([10, 10], [12, 11]);
    b.dim({ kind: 'hDistance', a: l.line, b: l.line }, 6);
    b.dim({ kind: 'vDistance', a: l.line, b: l.line }, -2);
    const r = await solved(b);
    expect(pos(r, p)[0]).toBeCloseTo(-8, 8);
    expect(pos(r, p)[1]).toBeCloseTo(3, 8);
    expect(pos(r, l.end)[0] - pos(r, l.start)[0]).toBeCloseTo(6, 8);
    expect(pos(r, l.end)[1] - pos(r, l.start)[1]).toBeCloseTo(-2, 8);
  });

  it('length, radius, diameter', async () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [3, 4]);
    b.geo({ kind: 'fix', entity: l.start });
    b.dim({ kind: 'length', line: l.line }, 10);
    const k = b.circle(b.point(20, 0), 1);
    b.dim({ kind: 'diameter', curve: k }, 9);
    const ac = b.point(40, 0);
    const arc = b.arc(ac, b.point(42, 0), b.point(40, 2));
    b.dim({ kind: 'radius', curve: arc }, 6);
    const r = await solved(b);
    expect(dist(pos(r, l.start), pos(r, l.end))).toBeCloseTo(10, 7);
    expect(radius(r, k)).toBeCloseTo(4.5, 7);
    const a = r.entities.find((e) => e.id === arc);
    if (a?.kind !== 'arc') throw new Error('arc');
    expect(dist(pos(r, a.center), pos(r, a.start))).toBeCloseTo(6, 7);
    expect(dist(pos(r, a.center), pos(r, a.end))).toBeCloseTo(6, 7);
  });

  it('angle is measured counter-clockwise from a to b', async () => {
    for (const target of [30, 120, 330, -30]) {
      const b = new SketchBuilder();
      const a = b.segment([0, 0], [10, 0]);
      b.geo({ kind: 'fix', entity: a.line });
      const c = b.segment([0, 0], [8, 3]);
      b.geo({ kind: 'fix', entity: c.start });
      b.dim({ kind: 'length', line: c.line }, 10);
      b.dim({ kind: 'angle', a: a.line, b: c.line }, deg(target));
      const r = await solved(b);
      const e = pos(r, c.end);
      const got = (Math.atan2(e[1], e[0]) * 180) / Math.PI;
      expect((((got - target) % 360) + 360) % 360, `target ${target}`).toBeCloseTo(0, 6);
    }
  });

  it('a reference angle reports the CCW angle in [0, 2π)', async () => {
    const b = new SketchBuilder();
    const a = b.segment([0, 0], [10, 0]);
    const c = b.segment([0, 0], [10, -10]);
    const ref = b.dim({ kind: 'angle', a: a.line, b: c.line }, 0, false);
    const res = (await core()).solve(b.input());
    expect(res.driven[ref]).toBeCloseTo(deg(315), 9);
  });
});
