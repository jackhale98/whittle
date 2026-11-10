/**
 * Editing the M3.5 curves: trim (ellipse → elliptic arc, elliptic arc shortened / split, spline
 * split by knot insertion, closed spline opened), extend, lines stopping at the new curves,
 * mirror, offset refusals and Convert Entities (exact linked ellipses and splines).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchBSpline, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { interpolate, splinePoint } from '../src/bspline';
import {
  convertEntities,
  extendEntity,
  mirrorEntities,
  offsetEntities,
  reprojectLinked,
  trimEntity,
} from '../src/edit';
import { closestParam, indexEntities, paramCurve, splineGeom } from '../src/geometry';
import { at, ent, ids, ok, solve } from './edit-helpers';
import { SketchBuilder } from './helpers';

const data = (b: SketchBuilder) => ({ entities: b.entities, constraints: b.constraints });

/** Distance from p to an entity's curve. */
function offCurve(
  s: { entities: import('@wren-cad/contracts').SketchEntity[] },
  id: Id,
  p: Vec2,
): number {
  const index = indexEntities(s.entities);
  const c = paramCurve(index, index.get(id) as import('@wren-cad/contracts').SketchEntity);
  if (!c) throw new Error('no curve');
  const q = c.at(closestParam(c, p, 400));
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
}

/** A cubic through-point spline from (0, 0) to (40, 0) with three inner points, as the tool makes it. */
function throughSpline(b: SketchBuilder) {
  const pts: Vec2[] = [
    [0, 0],
    [10, 8],
    [20, 6],
    [30, -6],
    [40, 0],
  ];
  const it3 = interpolate(pts, 3, false);
  if (!it3) throw new Error('no spline');
  const through = pts.map((p) => b.point(p[0], p[1]));
  const poles = it3.poles.map((p, i) =>
    i === 0
      ? (through[0] as Id)
      : i === it3.poles.length - 1
        ? (through[4] as Id)
        : b.point(p[0], p[1]),
  );
  const s = b.bspline(poles, { knots: it3.knots, multiplicities: it3.multiplicities });
  for (const t of through.slice(1, 4)) b.geo({ kind: 'pointOn', point: t, on: s });
  return { s, through, it: it3 };
}

describe('trim', () => {
  it('an ellipse cut by two lines becomes an elliptic arc (same id) without the picked piece', async () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(0, 0), 10, 5, 0);
    b.segment([-3, -10], [-3, 10]);
    b.segment([3, -10], [3, 10]);
    const r = ok(trimEntity(data(b), e, [0, 5], { id: ids() }));
    const arc = ent(r.sketch, e);
    expect(arc.kind).toBe('ellipticArc');
    if (arc.kind !== 'ellipticArc') return;
    // The top piece is gone: the kept part runs CCW from the upper left cut round the bottom
    // to the upper right one.
    expect(at(r.sketch, arc.start)[0]).toBeCloseTo(-3, 7);
    expect(at(r.sketch, arc.start)[1]).toBeGreaterThan(0);
    expect(at(r.sketch, arc.end)[0]).toBeCloseTo(3, 7);
    expect(at(r.sketch, arc.end)[1]).toBeGreaterThan(0);
    expect(r.addedConstraints).toHaveLength(2);
    expect((await solve(r.sketch)).status).toBe('solved');
  });

  it('an elliptic arc split in the middle: two arcs tied by equal and a shared centre', async () => {
    const b = new SketchBuilder();
    const s = b.pointOnEllipse([0, 0], 10, 5, 0, -0.2);
    const t = b.pointOnEllipse([0, 0], 10, 5, 0, Math.PI + 0.2);
    const c = b.point(0, 0);
    const ea = b.ellipticArc(c, 10, 5, 0, s, t);
    b.segment([-2, -10], [-2, 10]);
    b.segment([2, -10], [2, 10]);
    const r = ok(trimEntity(data(b), ea, [0, 5], { id: ids() }));
    const arcs = r.sketch.entities.filter((x) => x.kind === 'ellipticArc');
    expect(arcs).toHaveLength(2);
    expect(arcs.every((x) => x.kind === 'ellipticArc' && x.center === c)).toBe(true);
    expect(r.sketch.constraints.some((k) => k.kind === 'equal')).toBe(true);
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
  });

  it('a spline split by knot insertion: same curve, through points stay on their piece at their knots', async () => {
    const b = new SketchBuilder();
    const { s, through, it: it3 } = throughSpline(b);
    b.segment([15, -10], [15, 10]);
    b.segment([25, -10], [25, 10]);
    const before = data(b);
    const g0 = splineGeom(indexEntities(before.entities), ent(before, s) as SketchBSpline);
    const r = ok(trimEntity(before, s, [20, 6], { id: ids() }));
    const splines = r.sketch.entities.filter((x): x is SketchBSpline => x.kind === 'bspline');
    expect(splines).toHaveLength(2);
    // The original keeps its first pole, the new piece the original's last.
    expect(splines[0]?.id).toBe(s);
    expect(splines[0]?.poles[0]).toBe(through[0]);
    expect(splines[1]?.poles[splines[1].poles.length - 1]).toBe(through[4]);
    // Each piece is exactly the original curve over its range.
    for (const sp of splines) {
      const g = splineGeom(indexEntities(r.sketch.entities), sp);
      const k = sp.knots as number[];
      for (let i = 0; i <= 10; i++) {
        const u = (k[0] as number) + (((k[k.length - 1] as number) - (k[0] as number)) * i) / 10;
        const p = splinePoint(g, u);
        const q = splinePoint(g0, u);
        expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-9);
      }
    }
    // The through point at x = 20 was on the removed part: its pointOn went; the others moved over.
    const ons = r.sketch.constraints.filter((k) => k.kind === 'pointOn' && k.point !== undefined);
    const heldOn = (pid: Id) => ons.find((k) => k.kind === 'pointOn' && k.point === pid);
    expect(heldOn(through[1] as Id)?.kind === 'pointOn' && heldOn(through[1] as Id)).toMatchObject({
      on: s,
    });
    expect(heldOn(through[3] as Id)).toMatchObject({ on: splines[1]?.id });
    expect(heldOn(through[2] as Id)).toBeUndefined();
    void it3;
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
    // Still interpolating: dragging-free solve leaves the through points where they were.
    expect(at(res, through[1] as Id)).toEqual([10, 8]);
  });

  it('a spline trimmed at one end; a closed spline needs two cuts and becomes open', () => {
    const b = new SketchBuilder();
    const poles = [b.point(0, 0), b.point(10, 10), b.point(20, 10), b.point(30, 0)];
    const s = b.bspline(poles);
    b.segment([22, -5], [22, 15]);
    const r = ok(trimEntity(data(b), s, [28, 2], { id: ids() }));
    const sp = ent(r.sketch, s) as SketchBSpline;
    expect(sp.poles[0]).toBe(poles[0]);
    expect(at(r.sketch, sp.poles[sp.poles.length - 1] as Id)[0]).toBeCloseTo(22, 7);
    expect(r.sketch.constraints.some((k) => k.kind === 'pointOn')).toBe(true);

    const c = new SketchBuilder();
    const it3 = interpolate(
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      3,
      true,
    );
    if (!it3) throw new Error('no spline');
    const loop = c.bspline(
      it3.poles.map((p) => c.point(p[0], p[1])),
      { periodic: true, knots: it3.knots, multiplicities: it3.multiplicities },
    );
    c.segment([10, -10], [10, 5]); // crosses the loop once
    const one = trimEntity(data(c), loop, [20, 10]);
    expect(one.ok === false && one.reason).toMatch(/needs two/);
    c.segment([-10, 10], [30, 10]);
    const r2 = ok(trimEntity(data(c), loop, [20, 10], { id: ids() }));
    const open = ent(r2.sketch, loop) as SketchBSpline;
    expect(open.periodic).toBe(false);
    for (const end of [open.poles[0], open.poles[open.poles.length - 1]] as Id[]) {
      const p = at(r2.sketch, end);
      expect(Math.min(Math.abs(p[0] - 10), Math.abs(p[1] - 10))).toBeLessThan(1e-7);
    }
  });

  it('a line trims at an ellipse and a spline; a curve with no cut is deleted', () => {
    const b = new SketchBuilder();
    b.ellipse(b.point(0, 0), 10, 5, 0);
    const l = b.segment([-20, 0], [20, 0]);
    const r = ok(trimEntity(data(b), l.line, [-15, 0], { id: ids() }));
    expect(at(r.sketch, (ent(r.sketch, l.line) as { start: Id }).start)[0]).toBeCloseTo(-10, 7);
    const c = new SketchBuilder();
    const lone = c.bspline([c.point(0, 0), c.point(5, 5), c.point(10, 0)], { degree: 2 });
    const del = ok(trimEntity(data(c), lone, [5, 2]));
    expect(del.removed).toContain(lone);
    expect(del.sketch.entities).toHaveLength(0);
  });
});

describe('extend', () => {
  it('an elliptic arc extends along its ellipse; splines and ellipses are refused', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.pointOnEllipse([0, 0], 10, 5, 0, 0.3);
    const t = b.pointOnEllipse([0, 0], 10, 5, 0, 1.2);
    const ea = b.ellipticArc(c, 10, 5, 0, s, t);
    b.segment([-3, -10], [-3, 10]);
    const r = ok(extendEntity(data(b), ea, at(data(b), t), { id: ids() }));
    expect(at(r.sketch, t)[0]).toBeCloseTo(-3, 7);
    const sp = b.bspline([b.point(20, 0), b.point(25, 5), b.point(30, 0)], { degree: 2 });
    const no = extendEntity(data(b), sp, [30, 0]);
    expect(no.ok === false && no.reason).toMatch(/^Spline 1 is a spline/);
  });
});

describe('mirror', () => {
  it('ellipses, elliptic arcs and splines mirror; the copies follow their originals', async () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(10, 5), 6, 3, 0.4);
    const s = b.pointOnEllipse([20, 5], 5, 2, 0, 0);
    const t = b.pointOnEllipse([20, 5], 5, 2, 0, 2);
    const ea = b.ellipticArc(b.point(20, 5), 5, 2, 0, s, t);
    const sp = b.bspline([b.point(30, 0), b.point(35, 6), b.point(40, 3), b.point(45, 8)]);
    const r = ok(mirrorEntities(data(b), [e, ea, sp], '@y', { id: ids() }));
    const copies = r.created.map((id) => ent(r.sketch, id)).filter((x) => x.kind !== 'point');
    const ce = copies.find((x) => x.kind === 'ellipse');
    expect(ce?.kind === 'ellipse' && ce.rotation).toBeCloseTo(Math.PI - 0.4, 12);
    const ca = copies.find((x) => x.kind === 'ellipticArc');
    if (ca?.kind !== 'ellipticArc') throw new Error('no arc copy');
    // Reflection reverses the sense: the copy starts at the image of the end.
    expect(at(r.sketch, ca.start)[0]).toBeCloseTo(-at(data(b), t)[0], 9);
    const cs = copies.find((x) => x.kind === 'bspline');
    if (cs?.kind !== 'bspline') throw new Error('no spline copy');
    expect(at(r.sketch, cs.poles[1] as Id)).toEqual([-35, 6]);
    expect(r.notes.some((n) => /rotation/.test(n))).toBe(true);
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
  });
});

describe('offset refusals', () => {
  it('ellipses, elliptic arcs and splines are refused with the reason', () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(0, 0), 6, 3, 0);
    const sp = b.bspline([b.point(30, 0), b.point(35, 6), b.point(40, 3)], { degree: 2 });
    const r1 = offsetEntities(data(b), [e], { distance: 2 });
    expect(r1.ok === false && r1.reason).toMatch(/offset of an ellipse is not an ellipse/);
    const r2 = offsetEntities(data(b), [sp], { distance: 2 });
    expect(r2.ok === false && r2.reason).toMatch(/offset of a spline is not a spline/);
  });
});

describe('Convert Entities: exact ellipses and splines', () => {
  const ref = (name: string) => ({ kind: 'edge' as const, name });

  it('creates exact linked ellipses, elliptic arcs and splines; re-projection follows them in place', () => {
    const base = { entities: [], constraints: [] };
    const r = ok(
      convertEntities(
        base,
        [
          {
            ref: ref('E1'),
            curve: { kind: 'ellipse', c: [0, 0], majorRadius: 8, minorRadius: 3, rotation: 0.2 },
          },
          {
            ref: ref('E2'),
            curve: {
              kind: 'ellipticArc',
              c: [20, 0],
              majorRadius: 5,
              minorRadius: 2,
              rotation: 0,
              start: [25, 0],
              end: [15, 0],
            },
          },
          {
            ref: ref('E3'),
            curve: {
              kind: 'bspline',
              poles: [
                [0, 10],
                [5, 15],
                [10, 10],
                [15, 15],
              ],
              degree: 3,
              periodic: false,
            },
          },
        ],
        { id: ids() },
      ),
    );
    const kinds = r.sketch.entities.filter((x) => x.kind !== 'point').map((x) => x.kind);
    expect(kinds).toEqual(['ellipse', 'ellipticArc', 'bspline']);
    expect(r.sketch.entities.every((x) => x.source !== undefined)).toBe(true);
    const sp = r.sketch.entities.find((x) => x.kind === 'bspline') as SketchBSpline;
    const moved = reprojectLinked(r.sketch, [
      {
        ref: ref('E1'),
        curve: { kind: 'ellipse', c: [1, 0], majorRadius: 9, minorRadius: 3, rotation: 0.2 },
      },
      {
        ref: ref('E2'),
        curve: {
          kind: 'ellipticArc',
          c: [20, 0],
          majorRadius: 5,
          minorRadius: 2,
          rotation: 0,
          start: [25, 0],
          end: [15, 0],
        },
      },
      {
        ref: ref('E3'),
        curve: {
          kind: 'bspline',
          poles: [
            [0, 11],
            [5, 16],
            [10, 11],
            [15, 16],
          ],
          degree: 3,
          periodic: false,
        },
      },
    ]);
    expect(moved.lost).toEqual([]);
    const e1 = moved.sketch.entities.find((x) => x.kind === 'ellipse');
    expect(e1?.kind === 'ellipse' && e1.majorRadius).toBe(9);
    expect(at(moved.sketch, sp.poles[1] as Id)).toEqual([5, 16]);
    expect(offCurve(moved.sketch, sp.id, [5, 16])).toBeGreaterThan(0);
  });

  it('a spline whose source gains control points needs attention: lost, never refitted', () => {
    const r = ok(
      convertEntities(
        { entities: [], constraints: [] },
        [
          {
            ref: ref('S'),
            curve: {
              kind: 'bspline',
              poles: [
                [0, 0],
                [5, 5],
                [10, 0],
                [15, 5],
              ],
              degree: 3,
              periodic: false,
            },
          },
        ],
        { id: ids() },
      ),
    );
    const again = reprojectLinked(r.sketch, [
      {
        ref: ref('S'),
        curve: {
          kind: 'bspline',
          poles: [
            [0, 0],
            [4, 5],
            [8, 0],
            [12, 5],
            [16, 0],
          ],
          degree: 3,
          periodic: false,
        },
      },
    ]);
    expect(again.lost.map((l) => l.ref.name)).toEqual(['S']);
    // Untouched.
    expect(again.sketch.entities).toEqual(r.sketch.entities);
  });
});
