/**
 * Convert Entities: linked projections, fixed for the solver, re-projected in place on regen,
 * lost sources reported (never re-matched), re-pick and unlink.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, Id, SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  convertEntities,
  fitPolyline,
  type ProjectedEdge,
  relinkEntities,
  reprojectLinked,
  unlinkEntities,
} from '../src/edit/convert';
import type { SketchData } from '../src/edit/draft';
import { arcOf, at, close, ent, ids, lineEnds, ok, solve } from './edit-helpers';

const ref = (name: string): EntityRef => ({ name, kind: 'edge' });
const empty: SketchData = { entities: [], constraints: [] };
const curves = (s: SketchData) => s.entities.filter((e) => e.kind !== 'point');

describe('convert', () => {
  it('lines, circles and arcs become linked entities (points linked too)', () => {
    const edges: ProjectedEdge[] = [
      { ref: ref('F1:e1'), curve: { kind: 'line', a: [0, 0], b: [10, 0] } },
      { ref: ref('F1:e2'), curve: { kind: 'circle', c: [5, 5], r: 2 } },
      { ref: ref('F1:e3'), curve: { kind: 'arc', c: [0, 0], r: 10, start: 0, end: Math.PI / 2 } },
      { ref: ref('F1:e4'), curve: { kind: 'arc', c: [0, 0], r: 5, start: [0, 5], end: [-5, 0] } },
    ];
    const r = ok(convertEntities(empty, edges, { id: ids() }));
    expect(r.description).toBe('Convert 4 edges');
    expect(r.sketch.entities.every((e) => e.source !== undefined)).toBe(true);
    const [line, circle, arc, arc2] = curves(r.sketch);
    expect(line?.source).toEqual({ ref: ref('F1:e1') });
    expect(lineEnds(r.sketch, line?.id as Id)).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(circle?.kind === 'circle' && circle.radius).toBe(2);
    const a = arcOf(r.sketch, arc?.id as Id);
    close(a.start, [10, 0]);
    close(a.end, [0, 10]);
    const b = arcOf(r.sketch, arc2?.id as Id);
    close(b.start, [0, 5]);
    close(b.end, [-5, 0]);
    // Construction on request (dimension references, ADR-017).
    const c = ok(convertEntities(empty, [edges[0] as ProjectedEdge], { construction: true }));
    expect(c.sketch.entities.every((e) => e.construction)).toBe(true);
  });

  it('an edge seen end-on is a linked point; converting twice is a no-op', () => {
    const r = ok(
      convertEntities(empty, [{ ref: ref('v'), curve: { kind: 'line', a: [3, 4], b: [3, 4] } }]),
    );
    expect(r.sketch.entities).toHaveLength(1);
    expect(r.sketch.entities[0]?.kind).toBe('point');
    const again = convertEntities(r.sketch, [
      { ref: ref('v'), curve: { kind: 'line', a: [3, 4], b: [3, 4] } },
    ]);
    expect(again.ok).toBe(false);
  });

  it('a polyline becomes lines and arcs where the points lie on a circle, all approximate', () => {
    const pts: Vec2[] = [];
    // A straight run, then a quarter circle of radius 10 sampled at 9°, then straight again.
    pts.push([-20, -10], [-10, -10]);
    for (let i = 0; i <= 10; i++) {
      const t = -Math.PI / 2 + (i * Math.PI) / 20;
      pts.push([Math.cos(t) * 10 - 10 + 10, Math.sin(t) * 10]);
    }
    pts.push([10, 10]);
    const r = ok(
      convertEntities(empty, [{ ref: ref('spline'), curve: { kind: 'polyline', points: pts } }], {
        id: ids(),
      }),
    );
    const kinds = curves(r.sketch).map((e) => e.kind);
    expect(kinds).toContain('arc');
    expect(kinds.filter((k) => k === 'line').length).toBeLessThanOrEqual(3);
    expect(r.sketch.entities.every((e) => e.source?.approximate === true)).toBe(true);
    const arc = curves(r.sketch).find((e) => e.kind === 'arc') as SketchEntity;
    const g = arcOf(r.sketch, arc.id);
    close(g.c, [0, 0], 6);
    expect(g.r).toBeCloseTo(10, 6);
    // The chain is connected: consecutive curves share points.
    const used = new Map<Id, number>();
    for (const e of curves(r.sketch)) {
      if (e.kind === 'line' || e.kind === 'arc')
        for (const p of [e.start, e.end]) used.set(p, (used.get(p) ?? 0) + 1);
    }
    expect([...used.values()].filter((n) => n === 1)).toHaveLength(2);
  });

  it('fitPolyline: collinear points merge into one line', () => {
    expect(
      fitPolyline(
        [
          [0, 0],
          [1, 0],
          [2, 0],
          [3, 0],
        ],
        0.01,
      ),
    ).toEqual([{ kind: 'line', i: 0, j: 3 }]);
  });

  it('linked entities are fixed for the solver and can be constrained to', async () => {
    const r = ok(
      convertEntities(empty, [{ ref: ref('e1'), curve: { kind: 'line', a: [0, 0], b: [10, 0] } }], {
        id: ids('m'),
      }),
    );
    const sketch: SketchData = {
      entities: [
        ...r.sketch.entities,
        { id: 'q1', kind: 'point', construction: false, x: 2, y: 3 },
        { id: 'q2', kind: 'point', construction: false, x: 8, y: 4 },
        { id: 'l', kind: 'line', construction: false, start: 'q1', end: 'q2' },
      ],
      constraints: [
        { id: 'par', kind: 'parallel', a: 'l', b: 'm3' },
        { id: 'd', kind: 'distance', a: 'l', b: 'm3', value: '5 mm', driving: true },
      ],
    };
    const res = await solve(sketch, { d: 5 });
    expect(res.status).toBe('solved');
    expect(res.entityDof.m3).toBe('fixed');
    expect(res.entityDof.m1).toBe('fixed');
    expect(res.entityDof.l).toBe('partial');
    // The linked line did not move; the user's line did.
    expect(at(res, 'm1')).toEqual([0, 0]);
    expect(at(res, 'm2')).toEqual([10, 0]);
    expect(at(res, 'q1')[1]).toBeCloseTo(5, 9);
  });

  it('a conflict with linked geometry says so', async () => {
    const r = ok(
      convertEntities(empty, [{ ref: ref('e1'), curve: { kind: 'line', a: [0, 0], b: [10, 3] } }], {
        id: ids('m'),
      }),
    );
    const sketch: SketchData = {
      entities: r.sketch.entities,
      constraints: [{ id: 'h', kind: 'horizontal', line: 'm3' }],
    };
    const res = await solve(sketch);
    expect(res.status).toBe('conflicting');
    expect(res.conflicts[0]?.explanation).toBe(
      "Line 1 can't be horizontal while Line 1 is linked to the model",
    );
    expect(res.conflicts[0]?.fixed).toEqual(['m3']);
  });
});

describe('re-projection', () => {
  function linkedSketch() {
    const r = ok(
      convertEntities(
        empty,
        [
          { ref: ref('e1'), curve: { kind: 'line', a: [0, 0], b: [10, 0] } },
          { ref: ref('e2'), curve: { kind: 'circle', c: [20, 0], r: 3 } },
        ],
        { id: ids('m') },
      ),
    );
    // A user line dimensioned to the linked line, and a radius reference on the circle.
    const constraints: SketchConstraint[] = [
      { id: 'par', kind: 'parallel', a: 'u', b: 'm3' },
      { id: 'dist', kind: 'distance', a: 'u', b: 'm3', value: '4 mm', driving: true },
      { id: 'rad', kind: 'radius', curve: 'm5', value: '3 mm', driving: false },
    ];
    return {
      entities: [
        ...r.sketch.entities,
        { id: 'u1', kind: 'point', construction: false, x: 0, y: 4 } as SketchEntity,
        { id: 'u2', kind: 'point', construction: false, x: 10, y: 4 } as SketchEntity,
        { id: 'u', kind: 'line', construction: false, start: 'u1', end: 'u2' } as SketchEntity,
      ],
      constraints,
    };
  }

  it('updates in place: same ids, constraints survive, the sketch follows', async () => {
    const s = linkedSketch();
    const r = reprojectLinked(s, [
      { ref: ref('e1'), curve: { kind: 'line', a: [0, 2], b: [12, 8] } },
      { ref: ref('e2'), curve: { kind: 'circle', c: [25, 1], r: 4 } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.lost).toEqual([]);
    expect(r.sketch.entities.map((e) => e.id)).toEqual(s.entities.map((e) => e.id));
    expect(r.sketch.constraints).toEqual(s.constraints);
    expect(lineEnds(r.sketch, 'm3')).toEqual([
      [0, 2],
      [12, 8],
    ]);
    expect(ent(r.sketch, 'm5')).toMatchObject({ kind: 'circle', radius: 4 });
    expect(r.changed).toContain('m3');
    const res = await solve(r.sketch, { dist: 4 });
    expect(res.status).toBe('solved');
    expect(res.driven.rad).toBeCloseTo(4, 12);
    // The user's line followed: parallel at 4 mm.
    const [a, b] = lineEnds(res, 'u');
    const dir: Vec2 = [12, 6];
    const n = Math.hypot(12, 6);
    const side = (p: Vec2) => (dir[0] * (p[1] - 2) - dir[1] * p[0]) / n;
    expect(Math.abs(side(a))).toBeCloseTo(4, 8);
    expect(Math.abs(side(b))).toBeCloseTo(4, 8);
  });

  it('keeps the line orientation that moves its ends least', () => {
    const s = linkedSketch();
    const r = reprojectLinked(s, [
      { ref: ref('e1'), curve: { kind: 'line', a: [10, 0.5], b: [0, 0.5] } },
      { ref: ref('e2'), curve: { kind: 'circle', c: [20, 0], r: 3 } },
    ]);
    expect(lineEnds(r.sketch, 'm3')).toEqual([
      [0, 0.5],
      [10, 0.5],
    ]);
  });

  it('a missing source is lost: reported, left untouched, never re-matched', () => {
    const s = linkedSketch();
    const r = reprojectLinked(s, [
      // e1 is gone; another straight edge exists right where it was.
      { ref: ref('e9'), curve: { kind: 'line', a: [0, 0], b: [10, 0] } },
      { ref: ref('e2'), curve: { kind: 'circle', c: [20, 0], r: 3 } },
    ]);
    expect(r.lost).toEqual([{ ref: ref('e1'), entities: ['m1', 'm2', 'm3'] }]);
    expect(lineEnds(r.sketch, 'm3')).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(ent(r.sketch, 'm3').source?.ref.name).toBe('e1');
    expect(r.sketch.entities.some((e) => e.source?.ref.name === 'e9')).toBe(false);
  });

  it('re-pick links the lost entities to a new edge, keeping their ids', () => {
    const s = linkedSketch();
    const r = ok(
      relinkEntities(s, 'e1', { ref: ref('e9'), curve: { kind: 'line', a: [1, 1], b: [9, 1] } }),
    );
    expect(ent(r.sketch, 'm3').source?.ref.name).toBe('e9');
    expect(ent(r.sketch, 'm1').source?.ref.name).toBe('e9');
    expect(lineEnds(r.sketch, 'm3')).toEqual([
      [1, 1],
      [9, 1],
    ]);
    expect(r.sketch.constraints).toEqual(s.constraints);
    expect(
      relinkEntities(s, 'nope', { ref: ref('x'), curve: { kind: 'line', a: [0, 0], b: [1, 0] } })
        .ok,
    ).toBe(false);
  });

  it('an edge that changed kind keeps the entity id', () => {
    const s = linkedSketch();
    const r = reprojectLinked(s, [
      {
        ref: ref('e1'),
        curve: { kind: 'arc', c: [5, -5], r: Math.hypot(5, 5), start: [10, 0], end: [0, 0] },
      },
      { ref: ref('e2'), curve: { kind: 'circle', c: [20, 0], r: 3 } },
    ]);
    const e = ent(r.sketch, 'm3');
    expect(e.kind).toBe('arc');
    expect(e.source?.ref.name).toBe('e1');
    expect(r.notes.join(' ')).toMatch(/now follows an arc/);
    const g = arcOf(r.sketch, 'm3');
    close(g.start, [10, 0]);
    close(g.end, [0, 0]);
  });

  it('approximate chains keep their entities through re-projection', () => {
    const pts = (k: number): Vec2[] =>
      Array.from({ length: 21 }, (_, i) => [i, k * Math.sin((i / 20) * Math.PI) * 3] as Vec2);
    const r = ok(
      convertEntities(empty, [{ ref: ref('s'), curve: { kind: 'polyline', points: pts(1) } }], {
        id: ids(),
      }),
    );
    const before = r.sketch.entities.map((e) => `${e.id}:${e.kind}`);
    const again = reprojectLinked(r.sketch, [
      { ref: ref('s'), curve: { kind: 'polyline', points: pts(1.5) } },
    ]);
    expect(again.sketch.entities.map((e) => `${e.id}:${e.kind}`)).toEqual(before);
    expect(again.lost).toEqual([]);
    // The chain still spans the fresh polyline, end to end.
    const ends = again.sketch.entities
      .filter((e) => e.kind === 'point')
      .map((e) => at(again.sketch, e.id));
    expect(ends.some((p) => Math.hypot(p[0], p[1]) < 1e-9)).toBe(true);
    expect(ends.some((p) => Math.hypot(p[0] - 20, p[1]) < 1e-9)).toBe(true);
  });

  it('unlink leaves ordinary geometry that the solver can move', async () => {
    const s = linkedSketch();
    const r = ok(unlinkEntities(s, ['m3']));
    expect(r.description).toBe('Unlink Line 1');
    for (const id of ['m1', 'm2', 'm3']) expect(ent(r.sketch, id).source).toBeUndefined();
    expect(ent(r.sketch, 'm5').source).toBeDefined();
    const res = await solve(r.sketch, { dist: 4 });
    expect(res.status).toBe('solved');
    expect(res.entityDof.m3).not.toBe('fixed');
    expect(unlinkEntities(s, ['u']).ok).toBe(false);
  });
});

describe('convert with join (edges converted together make a loop)', () => {
  const square: ProjectedEdge[] = [
    { ref: ref('E1'), curve: { kind: 'line', a: [-40, -30], b: [40, -30] } },
    { ref: ref('E2'), curve: { kind: 'line', a: [40, -30], b: [40, 30] } },
    { ref: ref('E3'), curve: { kind: 'line', a: [40, 30], b: [-40, 30] } },
    { ref: ref('E4'), curve: { kind: 'line', a: [-40, 30], b: [-40, -30] } },
  ];
  const points = (s: SketchData) => s.entities.filter((e) => e.kind === 'point');

  it('shares the corner points, in one call or one edge at a time', () => {
    expect(points(ok(convertEntities(empty, square, { join: true })).sketch)).toHaveLength(4);
    let s: SketchData = empty;
    for (const e of square) s = ok(convertEntities(s, [e], { join: true })).sketch;
    expect(points(s)).toHaveLength(4);
    // Without join every edge keeps its own end points.
    expect(points(ok(convertEntities(empty, square)).sketch)).toHaveLength(8);
  });

  it('the joined loop offsets inside as one chain and re-projects', async () => {
    const r = ok(convertEntities(empty, square, { join: true }));
    const { offsetEntities } = await import('../src/edit/offset');
    const lines = curves(r.sketch).map((e) => e.id);
    const off = ok(offsetEntities(r.sketch, lines, { distance: 5, side: 'inside' }));
    const kind = (id: Id) => off.sketch.entities.find((e) => e.id === id)?.kind;
    expect(off.created.filter((id) => kind(id) === 'line')).toHaveLength(4);
    const wider = (p: Vec2): Vec2 => [p[0] * 1.5, p[1]];
    const moved = square.map((e) =>
      e.curve.kind === 'line'
        ? { ...e, curve: { kind: 'line' as const, a: wider(e.curve.a), b: wider(e.curve.b) } }
        : e,
    );
    const rp = reprojectLinked(r.sketch, moved);
    expect(rp.lost).toEqual([]);
    expect(
      points(rp.sketch).every((p) => p.kind === 'point' && Math.abs(Math.abs(p.x) - 60) < 1e-9),
    ).toBe(true);
  });
});
