/**
 * Sketch fillet and chamfer: analytic geometry, constraints, virtual sharps and round trips.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { chamferCorner, filletCorner } from '../src/edit/corner';
import type { SketchData } from '../src/edit/draft';
import {
  arcOf,
  at,
  close,
  constraint,
  ent,
  fixAll,
  ids,
  lineEnds,
  ok,
  polyline,
  sideDist,
  solve,
  unchanged,
} from './edit-helpers';

const created = (r: { created: Id[]; sketch: SketchData }, kind: SketchEntity['kind']) =>
  r.created.filter((id) => ent(r.sketch, id).kind === kind);

function corner90(constraints: SketchConstraint[] = []): SketchData {
  const s = polyline([
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  return { entities: s.entities, constraints };
}

describe('fillet', () => {
  it('a right-angle corner: tangent points at r from the corner, centre inside, R dimension', async () => {
    const r = ok(filletCorner(corner90(), 'p2', { radius: 2, id: ids() }));
    expect(r.description).toBe('Fillet Line 1 and Line 2 (R2 mm)');
    const [arc] = created(r, 'arc');
    const g = arcOf(r.sketch, arc as Id);
    close(g.c, [8, 2]);
    expect(g.r).toBeCloseTo(2, 12);
    // Counter-clockwise from (8, 0) to (10, 2) bulges towards the old corner.
    close(g.start, [8, 0]);
    close(g.end, [10, 2]);
    expect(lineEnds(r.sketch, 'l1')[1]).toEqual([8, 0]);
    expect(lineEnds(r.sketch, 'l2')[0]).toEqual([10, 2]);
    // The corner point had no constraints: it is gone.
    expect(r.removed).toEqual(['p2']);
    const added = r.addedConstraints.map((id) => constraint(r.sketch, id));
    expect(added.filter((c) => c.kind === 'tangent')).toHaveLength(2);
    const radius = added.find((c) => c.kind === 'radius');
    expect(radius).toMatchObject({ value: '2 mm', driving: true, curve: arc });
    const res = await solve(r.sketch, { [radius?.id as Id]: 2 });
    expect(res.status).toBe('solved');
    expect(res.redundant).toEqual([]);
    unchanged(r.sketch, res, 1e-9);
    // The DOF is unchanged by the fillet (the corner's freedom moves into the arc).
    const before = await solve(corner90());
    expect(res.dof).toBe(before.dof);
  });

  it('round trip: a new radius re-solves tangent to fixed lines', async () => {
    const r = ok(filletCorner(corner90(), 'p2', { radius: 2, expr: 'rf', id: ids() }));
    const radius = r.sketch.constraints.find((c) => c.kind === 'radius') as SketchConstraint;
    expect('value' in radius && radius.value).toBe('rf');
    // Hold the far ends and the directions; the trimmed ends follow the radius.
    const sketch: SketchData = {
      entities: r.sketch.entities,
      constraints: [
        ...r.sketch.constraints,
        { id: 'f1', kind: 'fix', entity: 'p1' },
        { id: 'f3', kind: 'fix', entity: 'p3' },
        { id: 'h', kind: 'horizontal', line: 'l1' },
        { id: 'v', kind: 'vertical', line: 'l2' },
      ],
    };
    const res = await solve(sketch, { [radius.id]: 3.5 });
    expect(res.status).toBe('solved');
    const g = arcOf(res, created(r, 'arc')[0] as Id);
    expect(g.r).toBeCloseTo(3.5, 9);
    expect(g.c[1]).toBeCloseTo(3.5, 9);
    expect(g.c[0]).toBeCloseTo(10 - 3.5, 9);
  });

  it('a 60° corner: tangent distance r / tan(30°)', () => {
    const s = polyline([
      [10, 0],
      [0, 0],
      [5, 5 * Math.sqrt(3)],
    ]);
    const r = ok(filletCorner(s, 'p2', { radius: 1 }));
    const t = 1 / Math.tan(Math.PI / 6);
    close(lineEnds(r.sketch, 'l1')[1], [t, 0], 9);
    const g = arcOf(r.sketch, created(r, 'arc')[0] as Id);
    close(g.c, [t, 1], 9);
  });

  it('a dimension to the corner keeps a construction virtual sharp; length reads to it', async () => {
    const s = corner90([
      { id: 'len', kind: 'length', line: 'l1', value: '10 mm', driving: true },
      { id: 'dx', kind: 'hDistance', a: '@origin', b: 'p2', value: '10 mm', driving: true },
    ]);
    const r = ok(filletCorner(s, 'p2', { radius: 2, id: ids() }));
    expect(ent(r.sketch, 'p2')).toMatchObject({ kind: 'point', construction: true, x: 10, y: 0 });
    expect(constraint(r.sketch, 'len')).toMatchObject({
      kind: 'distance',
      a: 'p1',
      b: 'p2',
      value: '10 mm',
    });
    expect(
      r.sketch.constraints.filter((c) => c.kind === 'pointOn' && c.point === 'p2'),
    ).toHaveLength(2);
    expect(r.notes).toEqual([]);
    const radius = r.sketch.constraints.find((c) => c.kind === 'radius') as SketchConstraint;
    const res = await solve(r.sketch, { len: 10, dx: 10, [radius.id]: 2 });
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
  });

  it('a line–arc corner: tangent to both', async () => {
    // A line along y = 0 into an arc of radius 10 centred at (10, 10) that leaves upwards-right.
    const s: SketchData = {
      entities: [
        { id: 'p1', kind: 'point', construction: false, x: -10, y: 0 },
        { id: 'p2', kind: 'point', construction: false, x: 0, y: 10 },
        { id: 'c', kind: 'point', construction: false, x: 10, y: 10 },
        { id: 'p3', kind: 'point', construction: false, x: 10, y: 0 },
        // The arc from (10, 0) counter-clockwise… no: a convex corner at p2 between a vertical line
        // from (0, -10) up to (0, 10) and the quarter arc from (0, 10) clockwise to (10, 20).
        { id: 'q1', kind: 'point', construction: false, x: 0, y: -10 },
        { id: 'q2', kind: 'point', construction: false, x: 10, y: 20 },
        { id: 'l', kind: 'line', construction: false, start: 'q1', end: 'p2' },
        // Centre (10, 10), radius 10: CCW from (10, 20) [90°] to (0, 10) [180°].
        { id: 'a', kind: 'arc', construction: false, center: 'c', start: 'q2', end: 'p2' },
      ],
      constraints: [],
    };
    // The line meets the arc at (0, 10) with the arc's tangent there vertical: that is smooth.
    expect(filletCorner(s, 'p2', { radius: 1 }).ok).toBe(false);
    // Tilt the line so the corner is sharp.
    const tilted = structuredClone(s);
    const q1 = tilted.entities.find((e) => e.id === 'q1');
    if (q1?.kind === 'point') q1.x = 8;
    const r = ok(filletCorner(tilted, 'p2', { radius: 1.5, id: ids() }));
    const f = arcOf(r.sketch, created(r, 'arc')[0] as Id);
    const [a, b] = lineEnds(r.sketch, 'l');
    expect(Math.abs(sideDist(f.c, a, b))).toBeCloseTo(1.5, 9);
    const dc = Math.hypot(f.c[0] - 10, f.c[1] - 10);
    expect(Math.abs(dc - 10) - 1.5).toBeCloseTo(0, 9);
    const radius = r.sketch.constraints.find((c) => c.kind === 'radius') as SketchConstraint;
    const res = await solve(r.sketch, { [radius.id]: 1.5 });
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
  });

  it('refuses: too large, three curves at a point, linked curves', () => {
    expect(filletCorner(corner90(), 'p2', { radius: 20 }).ok).toBe(false);
    const three: SketchData = {
      entities: [
        ...corner90().entities,
        { id: 'p9', kind: 'point', construction: false, x: 20, y: 0 },
        { id: 'l9', kind: 'line', construction: false, start: 'p2', end: 'p9' },
      ],
      constraints: [],
    };
    const r3 = filletCorner(three, 'p2', { radius: 1 });
    expect(!r3.ok && r3.reason).toMatch(/3 curves meet/);
    const linked = corner90();
    (linked.entities.find((e) => e.id === 'l1') as SketchEntity).source = {
      ref: { name: 'e', kind: 'edge' },
    };
    const rl = filletCorner(linked, 'p2', { radius: 1 });
    expect(!rl.ok && rl.reason).toMatch(/linked to the model/);
  });

  it('two coincident points make a corner too', () => {
    const s: SketchData = {
      entities: [
        { id: 'a', kind: 'point', construction: false, x: 0, y: 0 },
        { id: 'b', kind: 'point', construction: false, x: 10, y: 0 },
        { id: 'b2', kind: 'point', construction: false, x: 10, y: 0 },
        { id: 'c', kind: 'point', construction: false, x: 10, y: 10 },
        { id: 'l1', kind: 'line', construction: false, start: 'a', end: 'b' },
        { id: 'l2', kind: 'line', construction: false, start: 'b2', end: 'c' },
      ],
      constraints: [{ id: 'co', kind: 'coincident', a: 'b', b: 'b2' }],
    };
    const r = ok(filletCorner(s, { a: 'l1', b: 'l2' }, { radius: 2 }));
    expect(r.sketch.constraints.some((c) => c.id === 'co')).toBe(false);
    expect(r.sketch.entities.some((e) => e.id === 'b' || e.id === 'b2')).toBe(false);
  });
});

describe('chamfer', () => {
  it('two distances: points on each line, measured from a construction virtual sharp', async () => {
    const r = ok(
      chamferCorner(corner90(), { a: 'l1', b: 'l2' }, { distance: 2, distance2: 3, id: ids() }),
    );
    expect(r.description).toBe('Chamfer Line 1 and Line 2 (2 mm × 3 mm)');
    const [line] = created(r, 'line');
    const [a, b] = lineEnds(r.sketch, line as Id);
    close(a, [8, 0]);
    close(b, [10, 3]);
    expect(ent(r.sketch, 'p2')).toMatchObject({ construction: true });
    const dims = r.sketch.constraints.filter((c) => c.kind === 'distance');
    expect(dims.map((c) => ('value' in c ? c.value : ''))).toEqual(['2 mm', '3 mm']);
    const values = Object.fromEntries(dims.map((c, i) => [c.id, i === 0 ? 2 : 3]));
    const res = await solve(fixAll(r.sketch, ['p1', 'p3']), values);
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
    // Round trip: new distances.
    const res2 = await solve(
      {
        entities: r.sketch.entities,
        constraints: [
          ...r.sketch.constraints,
          { id: 'f1', kind: 'fix', entity: 'p1' },
          { id: 'h', kind: 'horizontal', line: 'l1' },
          { id: 'f2', kind: 'fix', entity: 'p3' },
          { id: 'v', kind: 'vertical', line: 'l2' },
        ],
      },
      Object.fromEntries(dims.map((c, i) => [c.id, i === 0 ? 1 : 4])),
    );
    expect(res2.status).toBe('solved');
    close(at(res2, (ent(r.sketch, line as Id) as { end: Id }).end), [10, 4], 8);
  });

  it('a distance and an angle (lines only)', async () => {
    const r = ok(
      chamferCorner(
        corner90(),
        { a: 'l1', b: 'l2' },
        { distance: 2, angle: Math.PI / 4, id: ids() },
      ),
    );
    expect(r.description).toBe('Chamfer Line 1 and Line 2 (2 mm at 45°)');
    const [line] = created(r, 'line');
    const [a, b] = lineEnds(r.sketch, line as Id);
    const pts = [a, b].sort((p, q) => p[0] - q[0]);
    close(pts[0] as Vec2, [8, 0]);
    close(pts[1] as Vec2, [10, 2]);
    const angle = r.sketch.constraints.find((c) => c.kind === 'angle') as SketchConstraint;
    expect('value' in angle && angle.value).toBe('45 deg');
    const dist = r.sketch.constraints.find((c) => c.kind === 'distance') as SketchConstraint;
    const res = await solve(r.sketch, { [angle.id]: Math.PI / 4, [dist.id]: 2 });
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
  });

  it('refuses when a side is too short', () => {
    const r = chamferCorner(corner90(), 'p2', { distance: 12 });
    expect(!r.ok && r.reason).toMatch(/too short for a 12 mm chamfer/);
  });
});
