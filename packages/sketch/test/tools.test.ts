/**
 * Drawing-tool helpers create valid, solvable entity/constraint sets with the expected DOF.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchEntity, SketchSolveResult, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { arcGeom, indexEntities, sampleEntity, sampleSketch, sketchBounds } from '../src/geometry';
import {
  arc3PointTool,
  arcCenterTool,
  arcTangentTool,
  circle3PointTool,
  circleCenterTool,
  lineTool,
  mergeFragment,
  newId,
  polygonTool,
  polylineTool,
  rectangle3PointTool,
  rectangleCenterTool,
  rectangleCornerTool,
  type SketchFragment,
  setConstruction,
  slotTool,
} from '../src/tools';
import { core } from './helpers';

async function solveFragment(f: SketchFragment | null): Promise<SketchSolveResult> {
  if (!f) throw new Error('tool returned null');
  const res = (await core()).solve({
    entities: f.entities,
    constraints: f.constraints,
    values: {},
  });
  expect(res.status, JSON.stringify(res.conflicts)).toBe('solved');
  expect(res.redundant).toEqual([]);
  // The tool's geometry already satisfies its constraints: nothing moves.
  res.entities.forEach((e, i) => {
    const before = f.entities[i] as SketchEntity;
    if (e.kind === 'point' && before.kind === 'point') {
      expect(e.x).toBeCloseTo(before.x, 9);
      expect(e.y).toBeCloseTo(before.y, 9);
    }
  });
  return res;
}

const pt = (es: SketchEntity[], id: string): Vec2 => {
  const p = es.find((e) => e.id === id);
  if (p?.kind !== 'point') throw new Error('not a point');
  return [p.x, p.y];
};

describe('tools', () => {
  it('ids are ULIDs', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const ids = lineTool([0, 0], [1, 1]).entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('line and polyline (shared points)', async () => {
    expect((await solveFragment(lineTool([0, 0], [5, 5]))).dof).toBe(4);
    const poly = polylineTool(
      [
        [0, 0],
        [10, 0],
        [10, 5],
        [3, 8],
      ],
      { closed: true },
    );
    expect(poly.entities.filter((e) => e.kind === 'point')).toHaveLength(4);
    expect(poly.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
    expect((await solveFragment(poly)).dof).toBe(8);
  });

  it('rectangles: corner, center, 3-point', async () => {
    const corner = rectangleCornerTool([10, 8], [0, 0]);
    expect(corner.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
    expect(corner.constraints.map((c) => c.kind).sort()).toEqual([
      'horizontal',
      'horizontal',
      'vertical',
      'vertical',
    ]);
    expect((await solveFragment(corner)).dof).toBe(4);
    const center = rectangleCenterTool([5, 5], [8, 7]);
    const rc = await solveFragment(center);
    expect(rc.dof).toBe(4);
    const three = rectangle3PointTool([0, 0], [10, 5], [3, 12]);
    expect((await solveFragment(three)).dof).toBe(5);
    expect(rectangle3PointTool([0, 0], [10, 0], [5, 0])).toBeNull();
  });

  it('circles: center and 3-point', async () => {
    expect((await solveFragment(circleCenterTool([0, 0], [3, 4]))).dof).toBe(3);
    const c3 = circle3PointTool([0, 0], [10, 0], [5, 5]);
    const r = await solveFragment(c3);
    const circle = r.entities.find((e) => e.kind === 'circle');
    expect(circle?.kind === 'circle' && circle.radius).toBeCloseTo(5, 9);
    expect(circle3PointTool([0, 0], [1, 1], [2, 2])).toBeNull();
  });

  it('arcs: 3-point (either direction), center', async () => {
    for (const through of [
      [5, 5],
      [5, -5],
    ] as Vec2[]) {
      const f = arc3PointTool([0, 0], [10, 0], through);
      const r = await solveFragment(f);
      expect(r.dof).toBe(5);
      const index = indexEntities(r.entities);
      const arc = r.entities.find((e) => e.kind === 'arc');
      if (arc?.kind !== 'arc') throw new Error('arc');
      const g = arcGeom(index, arc);
      // The arc (CCW start → end) passes through the picked point.
      const mid = sampleEntity(index, arc)[Math.floor(sampleEntity(index, arc).length / 2)] as Vec2;
      expect(Math.sign(mid[1])).toBe(Math.sign(through[1]));
      expect(g.r).toBeCloseTo(5, 9);
    }
    const ac = await solveFragment(arcCenterTool([0, 0], [10, 0], [0, 3]));
    const arc = ac.entities.find((e) => e.kind === 'arc');
    if (arc?.kind !== 'arc') throw new Error('arc');
    expect(pt(ac.entities, arc.end)).toEqual([0, 10].map((v) => expect.closeTo(v, 9)));
    const cw = arcCenterTool([0, 0], [10, 0], [0, 3], { clockwise: true });
    const cwArc = cw?.entities.find((e) => e.kind === 'arc');
    if (cwArc?.kind !== 'arc' || !cw) throw new Error('arc');
    expect(pt(cw.entities, cwArc.start)[1]).toBeCloseTo(10, 9);
  });

  it('tangent arc continuing a line', async () => {
    const line = lineTool([0, 0], [10, 0]);
    const end = line.entities[1] as SketchEntity;
    const f = arcTangentTool(line.entities, end.id, [20, 10]);
    if (!f) throw new Error('null');
    const all = mergeFragment({ entities: line.entities, constraints: line.constraints }, f);
    const r = await solveFragment(all);
    const arc = r.entities.find((e) => e.kind === 'arc');
    if (arc?.kind !== 'arc') throw new Error('arc');
    expect(pt(r.entities, arc.center)).toEqual([expect.closeTo(10, 9), expect.closeTo(10, 9)]);
    expect(arc.start).toBe(end.id); // CCW from the shared point
    expect(f.constraints).toEqual([expect.objectContaining({ kind: 'tangent', b: arc.id })]);
    // Turning right gives a clockwise arc (stored CCW from the far end).
    const right = arcTangentTool(line.entities, end.id, [20, -10]);
    const ra = right?.entities.find((e) => e.kind === 'arc');
    expect(ra?.kind === 'arc' && ra.end).toBe(end.id);
    expect(arcTangentTool(line.entities, end.id, [20, 0])).toBeNull();
  });

  it('slot and polygon', async () => {
    const slot = await solveFragment(slotTool([0, 0], [20, 5], 4));
    expect(slot.dof).toBe(5);
    const hex = await solveFragment(polygonTool([0, 0], [10, 0], 6));
    expect(hex.dof).toBe(4);
    expect(hex.entities.filter((e) => e.kind === 'line')).toHaveLength(6);
    expect(polygonTool([0, 0], [10, 0], 2)).toBeNull();
  });

  it('construction toggle', () => {
    const f = lineTool([0, 0], [1, 0]);
    const lineId = (f.entities[2] as SketchEntity).id;
    const on = setConstruction(f.entities, [lineId]);
    expect(on.find((e) => e.id === lineId)?.construction).toBe(true);
    expect(setConstruction(on, [lineId])[2]?.construction).toBe(false);
    expect(setConstruction(on, [lineId], true)[2]?.construction).toBe(true);
    expect(
      lineTool([0, 0], [1, 0], { construction: true }).entities.every((e) => e.construction),
    ).toBe(true);
  });
});

describe('geometry sampling', () => {
  it('samples lines, circles and arcs within the chord tolerance', () => {
    const f = mergeFragment(
      circleCenterTool([0, 0], 10),
      arcCenterTool([20, 0], [25, 0], [20, 5]) as SketchFragment,
    );
    const all = mergeFragment(f, lineTool([0, 0], [3, 4]));
    const polys = sampleSketch(all.entities, { chordTolerance: 0.01 });
    const circle = all.entities.find((e) => e.kind === 'circle') as SketchEntity;
    const ring = polys.get(circle.id) ?? [];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i] as Vec2;
      const b = ring[i + 1] as Vec2;
      const mid = Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      expect(10 - mid).toBeLessThanOrEqual(0.0100001);
    }
    const arc = all.entities.find((e) => e.kind === 'arc') as SketchEntity;
    const ap = polys.get(arc.id) ?? [];
    expect(ap[0]).toEqual([25, 0]);
    expect((ap[ap.length - 1] as Vec2)[0]).toBeCloseTo(20, 9);
    expect((ap[ap.length - 1] as Vec2)[1]).toBeCloseTo(5, 9);
    const line = all.entities.find((e) => e.kind === 'line') as SketchEntity;
    expect(polys.get(line.id)).toEqual([
      [0, 0],
      [3, 4],
    ]);
    const bounds = sketchBounds(all.entities);
    expect(bounds?.min[0]).toBeCloseTo(-10, 2);
    expect(bounds?.max[0]).toBeCloseTo(25, 6);
  });
});
