/**
 * Offset Entities: geometry against analytic expectations, solver round trips, DOF, driven values
 * and conflict explanations.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { SketchData } from '../src/edit/draft';
import { negate, offsetEntities } from '../src/edit/offset';
import { constraintLabel, describeFor, Namer } from '../src/explain';
import { arcCenterTool, circleCenterTool, rectangleCornerTool, slotTool } from '../src/tools';
import {
  arcOf,
  at,
  close,
  fixAll,
  ids,
  lineEnds,
  offsetOf,
  ok,
  polyline,
  sideDist,
  solve,
  sv,
  unchanged,
} from './edit-helpers';
import { core } from './helpers';

function must<T>(v: T | null): T {
  if (v === null) throw new Error('tool returned null');
  return v;
}

const curvesOf = (s: { entities: SketchEntity[] }) =>
  s.entities.filter((e) => e.kind !== 'point').map((e) => e.id);

describe('offset geometry', () => {
  it('a single line: parallel copy at d on the left or right, same direction', () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const left = ok(offsetEntities(s, ['l1'], { distance: 3, id: ids() }));
    const off = offsetOf(left.sketch);
    expect(off.sources).toEqual(['l1']);
    expect(off.value).toBe('-3 mm');
    expect(off.driving).toBe(true);
    const [a, b] = lineEnds(left.sketch, off.targets[0] as Id);
    close(a, [0, 3]);
    close(b, [10, 3]);
    expect(left.description).toBe('Offset Line 1 by 3 mm');
    const right = ok(offsetEntities(s, ['l1'], { distance: 3, side: 'right', id: ids() }));
    const [c, d] = lineEnds(right.sketch, offsetOf(right.sketch).targets[0] as Id);
    close(c, [0, -3]);
    close(d, [10, -3]);
  });

  it('the expression is stored as given on the right, negated on the left (contract sign)', () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const right = { distance: 4, expr: 'wall + 1 mm', side: 'right' as const, id: ids() };
    expect(offsetOf(ok(offsetEntities(s, ['l1'], right)).sketch).value).toBe('wall + 1 mm');
    const left = { distance: 4, expr: 'wall + 1 mm', side: 'left' as const, id: ids() };
    expect(offsetOf(ok(offsetEntities(s, ['l1'], left)).sketch).value).toBe('-(wall + 1 mm)');
    expect(negate('5 mm')).toBe('-5 mm');
    expect(negate('-5 mm')).toBe('5 mm');
    expect(negate('2*t')).toBe('-(2*t)');
  });

  it('concave corner: trimmed to the intersection; convex corner: an arc of radius d', () => {
    const s = polyline([
      [0, 0],
      [20, 0],
      [20, 10],
    ]);
    // The chain turns left, so its left side is concave.
    const left = ok(offsetEntities(s, s.lines, { distance: 2, id: ids() }));
    const offL = offsetOf(left.sketch);
    expect(offL.targets).toHaveLength(2);
    const [a1, b1] = lineEnds(left.sketch, offL.targets[0] as Id);
    const [a2, b2] = lineEnds(left.sketch, offL.targets[1] as Id);
    close(a1, [0, 2]);
    close(b1, [18, 2]);
    close(a2, [18, 2]);
    close(b2, [18, 10]);
    // The corner is one shared point.
    const t1 = left.sketch.entities.find((e) => e.id === offL.targets[0]);
    const t2 = left.sketch.entities.find((e) => e.id === offL.targets[1]);
    expect(t1?.kind === 'line' && t2?.kind === 'line' && t1.end === t2.start).toBe(true);

    const right = ok(offsetEntities(s, s.lines, { distance: 2, side: 'right', id: ids() }));
    const offR = offsetOf(right.sketch);
    expect(offR.sources).toEqual(['l1', 'l2', 'p2']);
    const arc = arcOf(right.sketch, offR.targets[2] as Id);
    close(arc.c, [20, 0]);
    expect(arc.r).toBeCloseTo(2, 9);
    close(arc.start, [20, -2]);
    close(arc.end, [22, 0]);
    const [c1, d1] = lineEnds(right.sketch, offR.targets[0] as Id);
    close(c1, [0, -2]);
    close(d1, [20, -2]);
  });

  it('sharp corners extend convex line–line joins instead', () => {
    const s = polyline([
      [0, 0],
      [20, 0],
      [20, 10],
    ]);
    const r = ok(
      offsetEntities(s, s.lines, { distance: 2, side: 'right', corners: 'sharp', id: ids() }),
    );
    const off = offsetOf(r.sketch);
    expect(off.targets).toHaveLength(2);
    close(lineEnds(r.sketch, off.targets[0] as Id)[1], [22, -2]);
    close(lineEnds(r.sketch, off.targets[1] as Id)[0], [22, -2]);
  });

  it('arcs become concentric with radius ∓ d; circles inside, outside or both', () => {
    const arc = must(arcCenterTool([0, 0], [10, 0], [0, 10], { id: ids('a') }));
    const arcId = curvesOf(arc)[0] as Id;
    // Left of a counter-clockwise arc is towards its centre.
    const inner = ok(offsetEntities(arc, [arcId], { distance: 3, id: ids() }));
    const t = arcOf(inner.sketch, offsetOf(inner.sketch).targets[0] as Id);
    close(t.c, [0, 0]);
    expect(t.r).toBeCloseTo(7, 9);
    close(t.start, [7, 0]);
    close(t.end, [0, 7]);
    const outer = ok(offsetEntities(arc, [arcId], { distance: 3, side: 'right', id: ids() }));
    expect(arcOf(outer.sketch, offsetOf(outer.sketch).targets[0] as Id).r).toBeCloseTo(13, 9);

    const circle = must(circleCenterTool([5, 5], 10, { id: ids('c') }));
    const cid = curvesOf(circle)[0] as Id;
    const radius = (s: { entities: SketchEntity[] }, id: Id) => {
      const e = s.entities.find((x) => x.id === id);
      return e?.kind === 'circle' ? e.radius : Number.NaN;
    };
    const ins = ok(offsetEntities(circle, [cid], { distance: 4, side: 'inside', id: ids() }));
    expect(radius(ins.sketch, offsetOf(ins.sketch).targets[0] as Id)).toBeCloseTo(6, 12);
    const out = ok(offsetEntities(circle, [cid], { distance: 4, side: 'outside', id: ids() }));
    expect(radius(out.sketch, offsetOf(out.sketch).targets[0] as Id)).toBeCloseTo(14, 12);
    const both = ok(offsetEntities(circle, [cid], { distance: 4, side: 'both', id: ids() }));
    const rs = offsetOf(both.sketch).targets.map((id) => radius(both.sketch, id));
    expect(rs.sort()).toEqual([14, 6]);
  });

  it('a closed rectangle: inside is a smaller rectangle, outside has rounded corners', () => {
    const rect = rectangleCornerTool([0, 0], [40, 20], { id: ids('r') });
    const curves = curvesOf(rect);
    const ins = ok(offsetEntities(rect, curves, { distance: 5, side: 'inside', id: ids() }));
    const offIn = offsetOf(ins.sketch);
    expect(offIn.targets).toHaveLength(4);
    const corners = offIn.targets.map((id) => lineEnds(ins.sketch, id)[0]);
    for (const c of corners) {
      expect(c[0] === 5 || Math.abs(c[0] - 35) < 1e-9 || Math.abs(c[0] - 5) < 1e-9).toBe(true);
      expect(Math.abs(c[1] - 5) < 1e-9 || Math.abs(c[1] - 15) < 1e-9).toBe(true);
    }
    const out = ok(offsetEntities(rect, curves, { distance: 5, side: 'outside', id: ids() }));
    const offOut = offsetOf(out.sketch);
    expect(offOut.targets).toHaveLength(8);
    const arcs = offOut.targets.filter(
      (id) => out.sketch.entities.find((e) => e.id === id)?.kind === 'arc',
    );
    expect(arcs).toHaveLength(4);
    for (const id of arcs) expect(arcOf(out.sketch, id).r).toBeCloseTo(5, 9);
    // Same result when the loop's side is given by a picked point.
    const toward = ok(
      offsetEntities(rect, curves, { distance: 5, side: { toward: [50, 10] }, id: ids() }),
    );
    expect(offsetOf(toward.sketch).targets).toHaveLength(8);
  });

  it('a slot keeps its tangent joints as shared points', () => {
    const slot = must(slotTool([0, 0], [30, 0], 5, { id: ids('s') }));
    const r = ok(offsetEntities(slot, curvesOf(slot), { distance: 2, side: 'outside', id: ids() }));
    const off = offsetOf(r.sketch);
    expect(off.targets).toHaveLength(4);
    for (const id of off.targets) {
      const e = r.sketch.entities.find((x) => x.id === id);
      if (e?.kind === 'arc') expect(arcOf(r.sketch, id).r).toBeCloseTo(7, 9);
      if (e?.kind === 'line') {
        const [a, b] = lineEnds(r.sketch, id);
        expect(Math.abs(a[1])).toBeCloseTo(7, 9);
        expect(Math.abs(b[1])).toBeCloseTo(7, 9);
      }
    }
  });

  it('both sides with caps: half circles or lines close the ends', () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const arcCap = ok(
      offsetEntities(s, ['l1'], { distance: 1, side: 'both', cap: 'arc', id: ids() }),
    );
    const off = offsetOf(arcCap.sketch);
    expect(off.sources).toEqual(['l1', 'l1', 'p1', 'p2']);
    const end = arcOf(arcCap.sketch, off.targets[3] as Id);
    close(end.c, [10, 0]);
    close(end.start, [10, -1]);
    close(end.end, [10, 1]);
    const start = arcOf(arcCap.sketch, off.targets[2] as Id);
    close(start.start, [0, 1]);
    close(start.end, [0, -1]);
    const lineCap = ok(
      offsetEntities(s, ['l1'], { distance: 1, side: 'both', cap: 'line', id: ids() }),
    );
    expect(
      lineCap.created.filter(
        (id) => lineCap.sketch.entities.find((e) => e.id === id)?.kind === 'line',
      ),
    ).toHaveLength(4);
    expect(lineCap.description).toBe('Offset Line 1 by 1 mm on both sides');
  });

  it('an arc whose radius would vanish is left out with a note, its neighbours joined', () => {
    // A V with a 1 mm round at the bottom; offsetting 1.5 mm inside drops the round.
    const r = 1;
    const u1: Vec2 = [-1 / Math.sqrt(5), 2 / Math.sqrt(5)];
    const half = Math.atan(0.5);
    const t = r / Math.tan(half);
    const c: Vec2 = [0, r / Math.sin(half)];
    const pt = (id: Id, p: Vec2): SketchEntity => ({
      id,
      kind: 'point',
      construction: false,
      x: p[0],
      y: p[1],
    });
    const s = {
      entities: [
        pt('p1', [-10, 20]),
        pt('t1', [t * u1[0], t * u1[1]]),
        pt('c', c),
        pt('t2', [-t * u1[0], t * u1[1]]),
        pt('p2', [10, 20]),
        { id: 'l1', kind: 'line', construction: false, start: 'p1', end: 't1' } as SketchEntity,
        {
          id: 'a1',
          kind: 'arc',
          construction: false,
          center: 'c',
          start: 't1',
          end: 't2',
        } as SketchEntity,
        { id: 'l2', kind: 'line', construction: false, start: 't2', end: 'p2' } as SketchEntity,
      ],
      constraints: [],
    };
    // Down the left, round the bottom counter-clockwise, up the right: left is inside the V.
    const kept = ok(offsetEntities(s, ['l1', 'a1', 'l2'], { distance: 0.5, id: ids() }));
    const off0 = offsetOf(kept.sketch);
    expect(arcOf(kept.sketch, off0.targets[1] as Id).r).toBeCloseTo(0.5, 9);
    const gone = ok(offsetEntities(s, ['l1', 'a1', 'l2'], { distance: 1.5, id: ids() }));
    expect(gone.notes).toEqual(['Arc 1 was left out: its offset radius would be -0.5 mm']);
    const off = offsetOf(gone.sketch);
    expect(off.sources).toEqual(['l1', 'l2']);
    // The two offset lines meet on the bisector, 1.5 / sin(half angle) above the V's apex.
    const apex: Vec2 = [0, 1.5 / Math.sin(half)];
    close(lineEnds(gone.sketch, off.targets[0] as Id)[1], apex, 9);
    close(lineEnds(gone.sketch, off.targets[1] as Id)[0], apex, 9);
  });

  it('a too-wide offset of a narrow U refuses instead of crossing itself', () => {
    const pt = (id: Id, x: number, y: number): SketchEntity => ({
      id,
      kind: 'point',
      construction: false,
      x,
      y,
    });
    const s = {
      entities: [
        pt('p1', -2, 20),
        pt('p2', -2, 0),
        pt('c', 0, 0),
        pt('p3', 2, 0),
        pt('p4', 2, 20),
        { id: 'l1', kind: 'line', construction: false, start: 'p1', end: 'p2' } as SketchEntity,
        {
          id: 'a1',
          kind: 'arc',
          construction: false,
          center: 'c',
          start: 'p2',
          end: 'p3',
        } as SketchEntity,
        { id: 'l2', kind: 'line', construction: false, start: 'p3', end: 'p4' } as SketchEntity,
      ],
      constraints: [],
    };
    const r = offsetEntities(s, ['l1', 'a1', 'l2'], { distance: 2.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2\.5 mm/);
  });

  it('refuses cleanly: branching, ellipses, inside on an open chain, zero distance', () => {
    const s = polyline([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const branch = {
      entities: [
        ...s.entities,
        { id: 'p9', kind: 'point', construction: false, x: 10, y: -10 } as SketchEntity,
        { id: 'l9', kind: 'line', construction: false, start: 'p2', end: 'p9' } as SketchEntity,
      ],
      constraints: [],
    };
    const br = offsetEntities(branch, ['l1', 'l2', 'l9'], { distance: 1 });
    expect(br.ok).toBe(false);
    if (!br.ok) expect(br.reason).toMatch(/branches at Point 2/);
    const inside = offsetEntities(s, s.lines, { distance: 1, side: 'inside' });
    expect(!inside.ok && inside.reason).toMatch(/closed loop/);
    const zero = offsetEntities(s, s.lines, { distance: 0 });
    expect(!zero.ok && zero.reason).toMatch(/greater than zero/);
    const ell = offsetEntities(
      {
        entities: [
          { id: 'c', kind: 'point', construction: false, x: 0, y: 0 },
          {
            id: 'e',
            kind: 'ellipse',
            construction: false,
            center: 'c',
            majorRadius: 5,
            minorRadius: 3,
            rotation: 0,
          },
        ],
        constraints: [],
      },
      ['e'],
      { distance: 1 },
    );
    expect(!ell.ok && ell.reason).toMatch(/Ellipses/);
    const rect = rectangleCornerTool([0, 0], [10, 4]);
    const tooBig = offsetEntities(rect, curvesOf(rect), { distance: 3, side: 'inside' });
    expect(tooBig.ok).toBe(false);
  });

  it('does not mutate its input', () => {
    const s = polyline([
      [0, 0],
      [10, 0],
      [10, 5],
    ]);
    const before = structuredClone(s);
    ok(offsetEntities(s, s.lines, { distance: 1, side: 'both', cap: 'arc' }));
    expect(s).toEqual(before);
  });
});

describe('offset in the solver', () => {
  it('solves without moving anything, keeps the DOF of the sources, fixed sources fix the offset', async () => {
    const rect = rectangleCornerTool([0, 0], [40, 20], { id: ids('r') });
    const base = await solve(rect);
    for (const side of ['inside', 'outside', 'both'] as const) {
      const r = ok(offsetEntities(rect, curvesOf(rect), { distance: 3, side, id: ids() }));
      const off = offsetOf(r.sketch);
      const res = await solve(r.sketch, { [off.id]: sv(off, 3) });
      expect(res.status, side).toBe('solved');
      expect(res.dof, side).toBe(base.dof);
      expect(res.redundant, side).toEqual([]);
      unchanged(r.sketch, res, 1e-9);
      const fixed = await solve(fixAll(r.sketch, curvesOf(rect)), { [off.id]: sv(off, 3) });
      expect(fixed.dof).toBe(0);
      for (const id of r.created) expect(fixed.entityDof[id], `${side} ${id}`).toBe('fixed');
    }
  });

  it('round trip: changing the driving distance moves the offset (lines parallel, arcs concentric)', async () => {
    const s = polyline([
      [0, 0],
      [20, 0],
      [20, 10],
      [35, 18],
    ]);
    const r = ok(offsetEntities(s, s.lines, { distance: 2, side: 'both', cap: 'arc', id: ids() }));
    const off = offsetOf(r.sketch);
    const fixed = fixAll(r.sketch, s.lines);
    for (const d of [0.5, 2, 3.25, 4]) {
      const res = await solve(fixed, { [off.id]: sv(off, d) });
      expect(res.status, `d=${d}`).toBe('solved');
      off.targets.forEach((t, i) => {
        const src = off.sources[i] as Id;
        const se = res.entities.find((e) => e.id === src);
        const te = res.entities.find((e) => e.id === t);
        if (se?.kind === 'line' && te?.kind === 'line') {
          const [a, b] = lineEnds(res, src);
          const [p, q] = lineEnds(res, t);
          expect(Math.abs(sideDist(p, a, b))).toBeCloseTo(d, 9);
          expect(Math.abs(sideDist(q, a, b))).toBeCloseTo(d, 9);
        } else if (se?.kind === 'point' && te?.kind === 'arc') {
          const g = arcOf(res, t);
          close(g.c, at(res, src), 9);
          expect(g.r).toBeCloseTo(d, 9);
        }
      });
    }
  });

  it('the offset follows its source when the source changes', async () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const r = ok(offsetEntities(s, ['l1'], { distance: 2, id: ids() }));
    const off = offsetOf(r.sketch);
    const moved = structuredClone(r.sketch);
    // Lengthen and tilt the source; fix it there.
    const p2 = moved.entities.find((e) => e.id === 'p2');
    if (p2?.kind === 'point') {
      p2.x = 20;
      p2.y = 5;
    }
    const res = await solve(fixAll(moved, ['l1']), { [off.id]: sv(off, 2) });
    expect(res.status).toBe('solved');
    const [a, b] = lineEnds(res, off.targets[0] as Id);
    // Square ends: the offset's ends sit on the source's normals through its ends.
    const n: Vec2 = [-5 / Math.hypot(20, 5), 20 / Math.hypot(20, 5)];
    close(a, [2 * n[0], 2 * n[1]], 8);
    close(b, [20 + 2 * n[0], 5 + 2 * n[1]], 8);
  });

  it('a slot offset round-trips through value changes with fixed sources', async () => {
    const slot = must(slotTool([0, 0], [30, 0], 5, { id: ids('s') }));
    const r = ok(offsetEntities(slot, curvesOf(slot), { distance: 2, side: 'both', id: ids() }));
    const off = offsetOf(r.sketch);
    const fixed = fixAll(r.sketch, curvesOf(slot));
    for (const d of [1, 3, 4.5]) {
      const res = await solve(fixed, { [off.id]: sv(off, d) });
      expect(res.status, `d=${d}`).toBe('solved');
      const radii = off.targets
        .filter((t) => res.entities.find((e) => e.id === t)?.kind === 'arc')
        .map((t) => arcOf(res, t).r)
        .sort((x, y) => x - y);
      expect(radii[0]).toBeCloseTo(5 - d, 8);
      expect(radii[radii.length - 1]).toBeCloseTo(5 + d, 8);
    }
  });

  it('a reference (driven) offset is measured, not solved', async () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const r = ok(offsetEntities(s, ['l1'], { distance: 2.5, id: ids() }));
    const off = offsetOf(r.sketch);
    const driven = {
      ...r.sketch,
      constraints: r.sketch.constraints.map((c) =>
        c.id === off.id ? { ...c, driving: false } : c,
      ),
    };
    const res = await solve(driven, {});
    expect(res.status).toBe('solved');
    expect(res.driven[off.id]).toBeCloseTo(-2.5, 12);
  });

  it('sign convention: positive = right of the source direction (outward of a CCW loop)', async () => {
    // A counter-clockwise loop of linked (fixed) lines, like a converted face outline.
    const rect = rectangleCornerTool([-40, -30], [40, 30], { id: ids('t') });
    const loop = curvesOf(rect);
    const linked = {
      entities: rect.entities.map((e) => ({
        ...e,
        source: { ref: { name: `E:${e.id}`, kind: 'edge' as const } },
      })),
      constraints: [],
    };
    const inside = ok(offsetEntities(linked, loop, { distance: 15, side: 'inside', id: ids() }));
    const off = offsetOf(inside.sketch);
    // Inside a CCW loop is left of every edge: the stored value is negative.
    expect(off.value).toBe('-15 mm');
    const outside = ok(offsetEntities(linked, loop, { distance: 15, side: 'outside', id: ids() }));
    expect(offsetOf(outside.sketch).value).toBe('15 mm');
    // Solving the inside offset with +15 moves it outside (to the right of each edge).
    const flipped = await solve(inside.sketch, { [off.id]: 15 });
    expect(flipped.status).toBe('solved');
    for (const t of off.targets) {
      const [a] = lineEnds(flipped, t);
      expect(Math.max(Math.abs(a[0]) - 40, Math.abs(a[1]) - 30)).toBeCloseTo(15, 8);
    }
    // And back to −15: inside again; the measured (reference) value keeps the sign.
    const back = await solve(
      {
        ...inside.sketch,
        constraints: inside.sketch.constraints.map((c) =>
          c.id === off.id ? { ...c, driving: false } : c,
        ),
      },
      {},
    );
    expect(back.driven[off.id]).toBeCloseTo(-15, 9);
  });

  it('one value drives sources that run different ways', async () => {
    // Two parallel lines drawn in opposite directions, offset towards each other's outside.
    const s: SketchData = {
      entities: [
        { id: 'a1', kind: 'point', construction: false, x: 0, y: 0 },
        { id: 'a2', kind: 'point', construction: false, x: 10, y: 0 },
        { id: 'b1', kind: 'point', construction: false, x: 10, y: 20 },
        { id: 'b2', kind: 'point', construction: false, x: 0, y: 20 },
        { id: 'la', kind: 'line', construction: false, start: 'a1', end: 'a2' },
        { id: 'lb', kind: 'line', construction: false, start: 'b1', end: 'b2' },
      ],
      constraints: [],
    };
    const r = ok(offsetEntities(s, ['la', 'lb'], { distance: 2, side: 'right', id: ids() }));
    const off = offsetOf(r.sketch);
    for (const d of [2, 3, -3]) {
      const res = await solve(fixAll(r.sketch, ['la', 'lb']), { [off.id]: sv(off, d) });
      expect(res.status).toBe('solved');
      const ya = lineEnds(res, off.targets[0] as Id)[0][1];
      const yb = lineEnds(res, off.targets[1] as Id)[0][1];
      // Right of la (+x) is −y; right of lb (−x) is +y: both outside, mirrored.
      expect(ya).toBeCloseTo(-d, 9);
      expect(yb).toBeCloseTo(20 + d, 9);
    }
  });

  it('a zero driving value is reported, not solved', async () => {
    const s = polyline([
      [0, 0],
      [10, 0],
    ]);
    const r = ok(offsetEntities(s, ['l1'], { distance: 2, id: ids() }));
    const off = offsetOf(r.sketch);
    const res = await solve(r.sketch, { [off.id]: 0 });
    expect(res.status).toBe('conflicting');
    expect(res.conflicts[0]?.explanation).toMatch(/can't be zero/);
  });
});

describe('offset explanations', () => {
  function offsetWithHorizontal() {
    // Line 1 fixed at 30°, its offset made horizontal: they can't both hold.
    const s = polyline([
      [0, 0],
      [Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10],
    ]);
    const r = ok(offsetEntities(s, ['l1'], { distance: 5, side: 'right', id: ids() }));
    const off = offsetOf(r.sketch);
    const target = off.targets[0] as Id;
    const constraints: SketchConstraint[] = [
      ...r.sketch.constraints,
      { id: 'fix', kind: 'fix', entity: 'l1' },
      { id: 'h', kind: 'horizontal', line: target },
    ];
    return { sketch: { entities: r.sketch.entities, constraints }, off, target };
  }

  it('"Line 2 can\'t be both horizontal and offset by 5 mm from Line 1"', async () => {
    const { sketch, off } = offsetWithHorizontal();
    const res = await solve(sketch, { [off.id]: sv(off, 5) });
    expect(res.status).toBe('conflicting');
    const c = res.conflicts[0];
    expect([...(c?.constraints ?? [])].sort()).toEqual([off.id, 'h'].sort());
    expect(c?.explanation).toBe(
      "Line 2 can't be both horizontal and offset by 5 mm from Line 1 while Line 1 is fixed",
    );
    const actions = c?.fixes.map((f) => f.action) ?? [];
    expect(actions).toContainEqual({ kind: 'makeReference', constraint: off.id });
    expect(actions).toContainEqual({ kind: 'removeConstraint', constraint: 'h' });
    expect(c?.fixes.map((f) => f.label)).toContain('Remove ‘Offset 5 mm (Line 2 from Line 1)’');
  });

  it('labels and descriptions for chains, sources and corner arcs', () => {
    const s = polyline([
      [0, 0],
      [20, 0],
      [20, 10],
    ]);
    const r = ok(offsetEntities(s, s.lines, { distance: 2, side: 'right', id: ids() }));
    const off = offsetOf(r.sketch);
    const namer = new Namer(r.sketch.entities);
    const values = { [off.id]: sv(off, 2) };
    expect(constraintLabel(off, namer, values)).toBe(
      'Offset 2 mm (3 entities from Line 1 and Line 2)',
    );
    expect(describeFor(off, off.targets[0] as Id, namer, values)).toBe(
      'offset by 2 mm from Line 1',
    );
    expect(describeFor(off, 'l1', namer, values)).toBe('kept 2 mm from its offset Line 3');
    expect(describeFor(off, off.targets[2] as Id, namer, values)).toBe(
      'offset by 2 mm around Point 2',
    );
  });
});

describe('offset performance', () => {
  it('dragging a source of a 200-entity offset: median solve within budget', async () => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 50; i++) pts.push([i * 4, i % 2 === 0 ? 0 : 3]);
    const s = polyline(pts);
    const r = ok(
      offsetEntities(s, s.lines, { distance: 0.5, side: 'left', corners: 'sharp', id: ids() }),
    );
    const off = offsetOf(r.sketch);
    // Anchor the chain's first point; the rest (and the offset) follow the drag.
    const sketch = fixAll(r.sketch, ['p1']);
    const count = sketch.entities.length;
    expect(count).toBeGreaterThanOrEqual(200);
    const solver = await core();
    const input = {
      entities: structuredClone(sketch.entities),
      constraints: structuredClone(sketch.constraints),
      values: { [off.id]: sv(off, 0.5) },
    };
    const t0 = performance.now();
    expect(solver.solve(input).status).toBe('solved');
    const solveMs = performance.now() - t0;
    const { session } = solver.beginDrag(input, 'p51', [200, 0]);
    const times: number[] = [];
    let last = 'solved';
    for (let i = 0; i < 40; i++) {
      const res = solver.drag(session, [200, 0.05 * i]);
      times.push(res.ms);
      last = res.status;
    }
    const end = solver.endDrag(session);
    expect(last).toBe('solved');
    expect(end.status).toBe('solved');
    times.sort((a, b) => a - b);
    const median = times[20] as number;
    console.info(
      `[sketch perf] offset chain, ${count} entities: full solve ${solveMs.toFixed(1)} ms; drag median ${median.toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(process.env.CI ? 12 : 4);
  });
});
