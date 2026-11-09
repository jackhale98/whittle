/**
 * `reprojectLinkedSketch`: the regen engine's `ReprojectLinked` seam wired to packages/sketch's
 * `reprojectLinked` (ADR-036 item 7), with the built-in fallback for reference geometry.
 */

import type { SketchEntity } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { reprojectLinkedSketch } from '../../src/regen/linked-sketch';

const ref = { name: 'edge(F1:end|F1:side(S2:e(L1)))', kind: 'edge' as const };
const src = { ref };

/** A linked line a→b (points linked too, as Convert Entities makes them). */
function linkedLine(a: [number, number], b: [number, number]): SketchEntity[] {
  return [
    { id: 'pa', kind: 'point', x: a[0], y: a[1], construction: false, source: src },
    { id: 'pb', kind: 'point', x: b[0], y: b[1], construction: false, source: src },
    { id: 'l', kind: 'line', start: 'pa', end: 'pb', construction: false, source: src },
  ];
}

const pos = (es: readonly SketchEntity[], id: string) => {
  const e = es.find((x) => x.id === id);
  return e?.kind === 'point' ? [e.x, e.y] : null;
};

describe('reprojectLinkedSketch', () => {
  it('moves a linked line onto its re-projected edge, keeping ids', () => {
    const r = reprojectLinkedSketch(linkedLine([0, 0], [10, 0]), [
      { ref, entities: ['pa', 'pb', 'l'], curves: [{ kind: 'line', a: [0, 2], b: [12, 2] }] },
    ]);
    expect(r.lost).toEqual([]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['l', 'pa', 'pb']);
    expect(pos(r.entities, 'pa')).toEqual([0, 2]);
    expect(pos(r.entities, 'pb')).toEqual([12, 2]);
  });

  it('keeps the orientation that moves the ends least (ADR-034)', () => {
    const r = reprojectLinkedSketch(linkedLine([0, 0], [10, 0]), [
      { ref, entities: ['pa', 'pb', 'l'], curves: [{ kind: 'line', a: [11, 0], b: [1, 0] }] },
    ]);
    expect(pos(r.entities, 'pa')).toEqual([1, 0]);
    expect(pos(r.entities, 'pb')).toEqual([11, 0]);
  });

  it('reports a source that no longer projects as lost, never re-picks', () => {
    const r = reprojectLinkedSketch(linkedLine([0, 0], [10, 0]), [
      {
        ref,
        entities: ['pa', 'pb', 'l'],
        curves: [{ kind: 'line', a: [Number.NaN, 0], b: [1, 0] }],
      },
    ]);
    expect(r.lost.map((l) => l.entity).sort()).toEqual(['l', 'pa', 'pb']);
    expect(pos(r.entities, 'pa')).toEqual([0, 0]);
  });

  it('leaves reference geometry (an axis seen as an infinite line) to the fallback', () => {
    const axis = { name: 'origin:X', kind: 'edge' as const };
    const ents: SketchEntity[] = [
      { id: 'qa', kind: 'point', x: -5, y: 1, construction: false, source: { ref: axis } },
      { id: 'qb', kind: 'point', x: 5, y: 1, construction: false, source: { ref: axis } },
      { id: 'q', kind: 'line', start: 'qa', end: 'qb', construction: false, source: { ref: axis } },
    ];
    const r = reprojectLinkedSketch(ents, [
      {
        ref: axis,
        entities: ['qa', 'qb', 'q'],
        curves: [{ kind: 'line', a: [0, 0], b: [1, 0], infinite: true }],
      },
    ]);
    expect(r.lost).toEqual([]);
    // On the axis, keeping its own extent along it.
    expect(pos(r.entities, 'qa')?.[1]).toBeCloseTo(0, 12);
    expect(pos(r.entities, 'qb')?.[1]).toBeCloseTo(0, 12);
  });
});
