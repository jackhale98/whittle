/**
 * Sketch mirror: reflected copies tied by symmetric constraints, orientation of arcs, points on
 * the mirror line shared, and the "mirror move" (originals removed, constraints carried over).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, SketchEntity } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { SketchData } from '../src/edit/draft';
import { mirrorEntities } from '../src/edit/mirror';
import {
  arcOf,
  at,
  close,
  constraint,
  ent,
  ids,
  lineEnds,
  ok,
  solve,
  unchanged,
} from './edit-helpers';

const P = (id: string, x: number, y: number, construction = false): SketchEntity => ({
  id,
  kind: 'point',
  construction,
  x,
  y,
});
const L = (id: string, start: string, end: string, construction = false): SketchEntity => ({
  id,
  kind: 'line',
  construction,
  start,
  end,
});

describe('mirror', () => {
  it('about the vertical axis: a reflected copy tied by symmetric constraints', async () => {
    const s: SketchData = {
      entities: [P('a', 2, 0), P('b', 5, 3), L('l', 'a', 'b')],
      constraints: [],
    };
    const r = ok(mirrorEntities(s, ['l'], '@y', { id: ids() }));
    expect(r.description).toBe('Mirror Line 1 about the vertical axis');
    const copy = r.created.find((id) => ent(r.sketch, id).kind === 'line') as Id;
    expect(lineEnds(r.sketch, copy)).toEqual([
      [-2, 0],
      [-5, 3],
    ]);
    const sym = r.sketch.constraints.filter((c) => c.kind === 'symmetric');
    expect(sym).toHaveLength(2);
    expect(sym.every((c) => c.kind === 'symmetric' && c.about === '@y')).toBe(true);
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-12);
    // Editing the source moves the copy.
    const edited: SketchData = {
      ...r.sketch,
      constraints: [
        ...r.sketch.constraints,
        { id: 'dx', kind: 'hDistance', a: '@origin', b: 'a', value: '4 mm', driving: true },
      ],
    };
    const moved = await solve(edited, { dx: 4 });
    expect(moved.status).toBe('solved');
    expect(lineEnds(moved, copy)[0][0]).toBeCloseTo(-4, 9);
  });

  it('arcs reverse their turning; circles are tied by equal too', async () => {
    const s: SketchData = {
      entities: [
        P('c', 5, 0),
        P('s', 8, 0),
        P('e', 5, 3),
        { id: 'a', kind: 'arc', construction: false, center: 'c', start: 's', end: 'e' },
        P('k', 10, 10),
        { id: 'o', kind: 'circle', construction: false, center: 'k', radius: 2 },
      ],
      constraints: [],
    };
    const r = ok(mirrorEntities(s, ['a', 'o'], '@y', { id: ids() }));
    const arc = r.created.find((id) => ent(r.sketch, id).kind === 'arc') as Id;
    const g = arcOf(r.sketch, arc);
    close(g.c, [-5, 0]);
    close(g.start, [-5, 3]);
    close(g.end, [-8, 0]);
    const circle = r.created.find((id) => ent(r.sketch, id).kind === 'circle') as Id;
    expect(r.sketch.constraints).toContainEqual(
      expect.objectContaining({ kind: 'equal', a: 'o', b: circle }),
    );
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
    expect(res.redundant).toEqual([]);
    unchanged(r.sketch, res, 1e-12);
  });

  it('points on the mirror line are shared, so the copy connects', () => {
    const s: SketchData = {
      entities: [P('a', 0, 5), P('b', 5, 0), L('l', 'a', 'b')],
      constraints: [],
    };
    const r = ok(mirrorEntities(s, ['l'], '@y'));
    const copy = r.created.find((id) => ent(r.sketch, id).kind === 'line') as Id;
    expect(ent(r.sketch, copy)).toMatchObject({ start: 'a' });
    expect(r.sketch.constraints.filter((c) => c.kind === 'symmetric')).toHaveLength(1);
  });

  it('about a construction line', async () => {
    const s: SketchData = {
      entities: [
        P('m1', 0, 0, true),
        P('m2', 10, 10, true),
        L('m', 'm1', 'm2', true),
        P('q', 3, 1),
      ],
      constraints: [],
    };
    const r = ok(mirrorEntities(s, ['q'], 'm'));
    expect(r.description).toBe('Mirror Point 3 about Line 1');
    close(at(r.sketch, r.created[0] as Id), [1, 3], 12);
    expect((await solve(r.sketch)).status).toBe('solved');
  });

  it('mirror move: originals go, invariant constraints move to the copy, the rest are reported', async () => {
    const s: SketchData = {
      entities: [
        P('a', 2, 0),
        P('b', 6, 0),
        L('l', 'a', 'b'),
        P('c', 2, 0),
        P('d', 2, 4),
        L('k', 'c', 'd'),
      ],
      constraints: [
        { id: 'h', kind: 'horizontal', line: 'l' },
        { id: 'len', kind: 'length', line: 'l', value: '4 mm', driving: true },
        { id: 'co', kind: 'coincident', a: 'a', b: 'c' },
        { id: 'ang', kind: 'angle', a: 'l', b: 'k', value: '90 deg', driving: true },
        { id: 'fx', kind: 'fix', entity: 'a' },
      ],
    };
    const r = ok(mirrorEntities(s, ['l', 'k'], '@y', { keepOriginals: false, id: ids() }));
    expect(r.description).toBe('Mirror 2 entities about the vertical axis (originals removed)');
    expect(r.sketch.entities.some((e) => ['a', 'b', 'c', 'd', 'l', 'k'].includes(e.id))).toBe(
      false,
    );
    const lines = r.created.filter((id) => ent(r.sketch, id).kind === 'line');
    expect(constraint(r.sketch, 'h')).toMatchObject({ line: lines[0] });
    expect(constraint(r.sketch, 'len')).toMatchObject({ line: lines[0] });
    // CCW from l to k reads clockwise after the reflection: the copy swaps the lines.
    expect(constraint(r.sketch, 'ang')).toMatchObject({ a: lines[1], b: lines[0] });
    expect(r.removedConstraints).toEqual(['fx']);
    expect(r.notes).toEqual([
      "Removed ‘Fix (Point 1)’: it doesn't carry over to the mirrored copy",
    ]);
    expect(r.sketch.constraints.some((c) => c.kind === 'symmetric')).toBe(false);
    const res = await solve(r.sketch, { len: 4, ang: Math.PI / 2 });
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
  });

  it('refuses an unknown axis and an empty selection', () => {
    const s: SketchData = { entities: [P('a', 2, 0)], constraints: [] };
    expect(mirrorEntities(s, ['a'], 'a').ok).toBe(false);
    expect(mirrorEntities(s, [], '@x').ok).toBe(false);
  });
});
