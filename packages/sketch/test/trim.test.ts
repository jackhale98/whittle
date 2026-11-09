/**
 * Trim / extend: geometry, constraint rewiring (attachments, dropped constraints with notes) and
 * solver round trips.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SketchConstraint, SketchEntity } from '@whittle/contracts';
import { describe, expect, it } from 'vitest';
import type { SketchData } from '../src/edit/draft';
import { offsetEntities } from '../src/edit/offset';
import { extendEntity, trimEntity } from '../src/edit/trim';
import {
  arcOf,
  at,
  close,
  ent,
  ids,
  lineEnds,
  offsetOf,
  ok,
  solve,
  unchanged,
} from './edit-helpers';

const P = (id: string, x: number, y: number): SketchEntity => ({
  id,
  kind: 'point',
  construction: false,
  x,
  y,
});
const L = (id: string, start: string, end: string): SketchEntity => ({
  id,
  kind: 'line',
  construction: false,
  start,
  end,
});

/** A horizontal line h (0,0)→(30,0) crossed by verticals at x = 10 and x = 20. */
function crossed(constraints: SketchConstraint[] = []): SketchData {
  return {
    entities: [
      P('h1', 0, 0),
      P('h2', 30, 0),
      L('h', 'h1', 'h2'),
      P('a1', 10, -5),
      P('a2', 10, 5),
      L('va', 'a1', 'a2'),
      P('b1', 20, -5),
      P('b2', 20, 5),
      L('vb', 'b1', 'b2'),
    ],
    constraints,
  };
}

describe('trim', () => {
  it('the middle piece: split into two collinear lines attached to the cutters', async () => {
    const s = crossed([
      { id: 'hz', kind: 'horizontal', line: 'h' },
      { id: 'len', kind: 'length', line: 'h', value: '30 mm', driving: true },
    ]);
    const r = ok(trimEntity(s, 'h', [15, 0.2], { id: ids() }));
    expect(r.description).toBe('Trim Line 1');
    expect(lineEnds(r.sketch, 'h')).toEqual([
      [0, 0],
      [10, 0],
    ]);
    const piece = r.created.find((id) => ent(r.sketch, id).kind === 'line') as string;
    expect(lineEnds(r.sketch, piece)).toEqual([
      [20, 0],
      [30, 0],
    ]);
    // The far end point moved to the new piece (its constraints still mean the same point).
    expect(ent(r.sketch, piece)).toMatchObject({ end: 'h2' });
    const kinds = r.addedConstraints.map((id) => r.sketch.constraints.find((c) => c.id === id));
    expect(kinds).toContainEqual(expect.objectContaining({ kind: 'pointOn', on: 'va' }));
    expect(kinds).toContainEqual(expect.objectContaining({ kind: 'pointOn', on: 'vb' }));
    expect(kinds).toContainEqual(
      expect.objectContaining({ kind: 'pointOn', point: 'h2', on: 'h' }),
    );
    // The length no longer applies; the horizontal does.
    expect(r.removedConstraints).toEqual(['len']);
    expect(r.notes).toEqual(['Removed ‘Length (Line 1)’: Line 1 was trimmed']);
    expect(r.sketch.constraints.some((c) => c.id === 'hz')).toBe(true);
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
  });

  it('an end piece: the end moves to the cut; a point only it used goes, with its constraints', async () => {
    const s = crossed([
      { id: 'd0', kind: 'distance', a: '@origin', b: 'h1', value: '0 mm', driving: false },
    ]);
    const r = ok(trimEntity(s, 'h', [3, 0], { id: ids() }));
    expect(lineEnds(r.sketch, 'h')).toEqual([
      [10, 0],
      [30, 0],
    ]);
    expect(r.removed).toEqual(['h1']);
    expect(r.removedConstraints).toEqual(['d0']);
    expect(r.notes[0]).toMatch(
      /^Removed ‘Distance \(the origin, Point 1\)’: its end was trimmed away/,
    );
    expect((await solve(r.sketch)).status).toBe('solved');
  });

  it('a cut through another end point attaches with coincident', () => {
    // A T: the vertical's foot lies on h.
    const s: SketchData = {
      entities: [
        P('h1', 0, 0),
        P('h2', 30, 0),
        L('h', 'h1', 'h2'),
        P('t1', 12, 0),
        P('t2', 12, 9),
        L('t', 't1', 't2'),
      ],
      constraints: [],
    };
    const r = ok(trimEntity(s, 'h', [25, 0], { id: ids() }));
    expect(lineEnds(r.sketch, 'h')).toEqual([
      [0, 0],
      [12, 0],
    ]);
    const added = r.sketch.constraints.find((c) => c.id === r.addedConstraints[0]);
    expect(added).toMatchObject({ kind: 'coincident', b: 't1' });
  });

  it('nothing to trim to: the entity is deleted', () => {
    const s: SketchData = {
      entities: [P('a', 0, 0), P('b', 1, 0), L('l', 'a', 'b')],
      constraints: [{ id: 'hz', kind: 'horizontal', line: 'l' }],
    };
    const r = ok(trimEntity(s, 'l', [0.5, 0]));
    expect(r.description).toBe('Delete Line 1');
    expect(r.sketch.entities).toEqual([]);
    expect(r.removedConstraints).toEqual(['hz']);
  });

  it('a circle crossed twice becomes an arc with the same id; its radius dimension stays', async () => {
    const s: SketchData = {
      entities: [
        P('c', 0, 0),
        { id: 'k', kind: 'circle', construction: false, center: 'c', radius: 10 },
        P('a', -20, 0),
        P('b', 20, 0),
        L('l', 'a', 'b'),
      ],
      constraints: [{ id: 'r', kind: 'radius', curve: 'k', value: '10 mm', driving: true }],
    };
    // Pick the top half: the bottom half remains, counter-clockwise from (−10, 0) to (10, 0).
    const r = ok(trimEntity(s, 'k', [0, 10], { id: ids() }));
    expect(ent(r.sketch, 'k').kind).toBe('arc');
    const g = arcOf(r.sketch, 'k');
    close(g.start, [-10, 0]);
    close(g.end, [10, 0]);
    expect(r.sketch.constraints.some((c) => c.id === 'r')).toBe(true);
    const res = await solve(r.sketch, { r: 10 });
    expect(res.status).toBe('solved');
    unchanged(r.sketch, res, 1e-9);
    // Crossed once: refused.
    const once: SketchData = {
      ...s,
      entities: [...s.entities.slice(0, 2), P('a', 0, 0), P('b', 20, 0), L('l', 'a', 'b')],
    };
    const no = trimEntity(once, 'k', [0, 10]);
    expect(!no.ok && no.reason).toMatch(/only one curve/);
  });

  it('an arc trimmed at one end keeps its centre and radius', () => {
    const s: SketchData = {
      entities: [
        P('c', 0, 0),
        P('s', 10, 0),
        P('e', 0, 10),
        { id: 'a', kind: 'arc', construction: false, center: 'c', start: 's', end: 'e' },
        P('p', 0, 0),
        P('q', 20, 20),
        L('l', 'p', 'q'),
      ],
      constraints: [],
    };
    const r = ok(trimEntity(s, 'a', [0, 10], { id: ids() }));
    const g = arcOf(r.sketch, 'a');
    close(g.c, [0, 0]);
    close(g.start, [10, 0]);
    close(g.end, [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10]);
  });

  it('a trimmed offset target stops following its source (reported)', () => {
    const base = crossed();
    const off = ok(offsetEntities(base, ['h'], { distance: 1, id: ids('o') }));
    const target = offsetOf(off.sketch).targets[0] as string;
    const r = ok(trimEntity(off.sketch, target, [2, 1], { id: ids() }));
    expect(r.sketch.constraints.some((c) => c.kind === 'offset')).toBe(false);
    expect(r.notes.join(' ')).toMatch(/Offset .* was trimmed/);
  });

  it('linked geometry is refused', () => {
    const s = crossed();
    (s.entities[2] as SketchEntity).source = { ref: { name: 'F1:e1', kind: 'edge' } };
    const r = trimEntity(s, 'h', [15, 0]);
    expect(!r.ok && r.reason).toMatch(/linked to the model; unlink it to trim it/);
  });
});

describe('extend', () => {
  it('a line end to the next crossing; its length dimension goes, the end attaches', async () => {
    const s: SketchData = {
      entities: [
        P('h1', 0, 0),
        P('h2', 5, 0),
        L('h', 'h1', 'h2'),
        P('a1', 10, -5),
        P('a2', 10, 5),
        L('va', 'a1', 'a2'),
        P('b1', 20, -5),
        P('b2', 20, 5),
        L('vb', 'b1', 'b2'),
      ],
      constraints: [
        { id: 'len', kind: 'length', line: 'h', value: '5 mm', driving: true },
        { id: 'hz', kind: 'horizontal', line: 'h' },
      ],
    };
    const r = ok(extendEntity(s, 'h', [4, 0], { id: ids() }));
    expect(r.description).toBe('Extend Line 1');
    expect(lineEnds(r.sketch, 'h')).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(r.removedConstraints).toEqual(['len']);
    expect(r.sketch.constraints.find((c) => c.id === r.addedConstraints[0])).toMatchObject({
      kind: 'pointOn',
      point: 'h2',
      on: 'va',
    });
    const res = await solve(r.sketch);
    expect(res.status).toBe('solved');
    // The start extends backwards; nothing there.
    expect(extendEntity(s, 'h', [0.5, 0]).ok).toBe(false);
  });

  it('an arc end grows counter-clockwise to a line', () => {
    const s: SketchData = {
      entities: [
        P('c', 0, 0),
        P('s', 10, 0),
        P('e', Math.SQRT1_2 * 10, Math.SQRT1_2 * 10),
        { id: 'a', kind: 'arc', construction: false, center: 'c', start: 's', end: 'e' },
        P('p', -20, 5),
        P('q', 20, 5),
        L('l', 'p', 'q'),
      ],
      constraints: [],
    };
    // y = 5 crosses the circle at 30° (behind the end) and 150° (ahead of it).
    const r = ok(extendEntity(s, 'a', [7, 7]));
    close(at(r.sketch, 'e'), [-Math.sqrt(75), 5]);
  });

  it('a connected end is refused', () => {
    const s: SketchData = {
      entities: [
        P('a', 0, 0),
        P('b', 5, 0),
        P('c', 5, 5),
        L('l1', 'a', 'b'),
        L('l2', 'b', 'c'),
        P('x1', 10, -5),
        P('x2', 10, 5),
        L('x', 'x1', 'x2'),
      ],
      constraints: [],
    };
    const r = extendEntity(s, 'l1', [4.9, 0]);
    expect(!r.ok && r.reason).toMatch(/connected to Line 2/);
  });
});
