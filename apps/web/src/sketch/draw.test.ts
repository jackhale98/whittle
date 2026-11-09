import type { SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  cancel,
  click,
  type DrawState,
  move,
  preview,
  type SketchData,
  startDraw,
  withPending,
} from './draw';

function run(state: DrawState, sketch: SketchData, clicks: Vec2[], tol = 1) {
  let s = state;
  const data = { entities: [...sketch.entities], constraints: [...sketch.constraints] };
  for (const p of clicks) {
    s = move(s, data, p, tol);
    const r = click(s, data);
    s = r.state;
    if (r.edit) {
      data.entities.push(...r.edit.entities);
      data.constraints.push(...r.edit.constraints);
    }
  }
  return { state: s, data };
}

const kinds = (cs: readonly SketchConstraint[]) => cs.map((c) => c.kind).sort();
const lines = (es: readonly SketchEntity[]) => es.filter((e) => e.kind === 'line');

describe('sketch drawing', () => {
  it('fast clicks: a rectangle still closes on its start point while every edit is unsolved', () => {
    // The document never catches up during the gesture (a busy solver): drawing must infer
    // against the document plus the pending clicks, or the closing click adds a free point.
    const doc: SketchData = { entities: [], constraints: [] };
    const pending: SketchData[] = [];
    let s = startDraw('line');
    // Away from the origin and axes (they would add their own snaps, see below).
    for (const p of [
      [100, 100],
      [140, 100.4],
      [140.3, 130],
      [100.2, 130.2],
      [100.3, 100.2],
    ] as Vec2[]) {
      const base = withPending(doc, pending);
      s = move(s, base, p, 1);
      const r = click(s, base);
      s = r.state;
      if (r.edit) pending.push({ entities: r.edit.entities, constraints: r.edit.constraints });
    }
    const all = withPending(doc, pending);
    expect(all.entities.filter((e) => e.kind === 'point')).toHaveLength(4);
    expect(kinds(all.constraints)).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
    // Without the pending edits the closing click would not have found the start point.
    const stale = move(startDraw('line'), doc, [100.3, 100.2], 1);
    expect(stale.hover?.pointId).toBeUndefined();
  });

  it('withPending: document entities win over their pending copies', () => {
    const solved: SketchEntity = { id: 'p', kind: 'point', construction: false, x: 1, y: 2 };
    const raw: SketchEntity = { ...solved, x: 1.01 } as SketchEntity;
    const merged = withPending({ entities: [solved], constraints: [] }, [
      { entities: [raw], constraints: [] },
    ]);
    expect(merged.entities).toEqual([solved]);
  });

  it('line tool: a closed rectangle chains shared points with H/V inferred and closes on the start', () => {
    const { state, data } = run(startDraw('line'), { entities: [], constraints: [] }, [
      [100, 100],
      [140, 100.4], // within 3° of horizontal → snapped
      [140.3, 130], // vertical
      [100.2, 130.2], // horizontal
      [100.3, 100.2], // back onto the start point → closes, vertical
    ]);
    expect(lines(data.entities)).toHaveLength(4);
    expect(data.entities.filter((e) => e.kind === 'point')).toHaveLength(4);
    expect(kinds(data.constraints)).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
    const l = lines(data.entities);
    // Every corner is shared by two lines; the last line ends at the first line's start.
    expect(l[3]?.kind === 'line' && l[0]?.kind === 'line' && l[3].end === l[0].start).toBe(true);
    // Snapped positions.
    const p2 = data.entities.find((e) => e.kind === 'point' && e.x === 140);
    expect(p2 && p2.kind === 'point' ? p2.y : null).toBe(100);
    expect(state.chainFrom).toBeNull(); // closing ended the chain
  });

  it('rubber band preview follows the cursor; Esc drops the chain, then leaves the tool', () => {
    let s = startDraw('line');
    const empty = { entities: [], constraints: [] };
    s = move(s, empty, [0, 0], 1);
    s = click(s, empty).state;
    s = move(s, empty, [10, 5], 1);
    const p = preview(s, empty);
    expect(p?.entities.filter((e) => e.kind === 'line')).toHaveLength(1);
    expect(p?.entities.every((e) => e.id.startsWith('preview:'))).toBe(true);
    const c = cancel(s);
    expect(c?.anchors).toHaveLength(0);
    expect(c && cancel(c)).toBeNull();
  });

  it('rectangle and circle tools build fragments; a coincident snap becomes a constraint', () => {
    const rect = run(startDraw('rectangle'), { entities: [], constraints: [] }, [
      [0, 0],
      [20, 10],
    ]);
    expect(lines(rect.data.entities)).toHaveLength(4);
    const circle = run(startDraw('circle'), rect.data, [
      [20.2, 10.1], // snaps onto the rectangle corner
      [25, 10],
    ]);
    expect(circle.data.entities.filter((e) => e.kind === 'circle')).toHaveLength(1);
    expect(circle.data.constraints.some((c) => c.kind === 'coincident')).toBe(true);
  });

  it('three-point arc and slot need three clicks; degenerate shapes are refused', () => {
    const arc = run(startDraw('arc'), { entities: [], constraints: [] }, [
      [0, 0],
      [10, 0],
      [5, 4],
    ]);
    expect(arc.data.entities.filter((e) => e.kind === 'arc')).toHaveLength(1);
    const flat = run(startDraw('rectangle'), { entities: [], constraints: [] }, [
      [0, 0],
      [0, 0],
    ]);
    expect(flat.data.entities).toHaveLength(0);
    const slot = run(startDraw('slot'), { entities: [], constraints: [] }, [
      [0, 0],
      [20, 0],
      [10, 4],
    ]);
    expect(slot.data.entities.filter((e) => e.kind === 'arc')).toHaveLength(2);
  });

  it('point tool: one click per point; snaps to the axes; an existing point is not doubled', () => {
    const free = run(startDraw('point'), { entities: [], constraints: [] }, [[12, 7]]);
    expect(free.data.entities).toEqual([
      expect.objectContaining({ kind: 'point', x: 12, y: 7, construction: false }),
    ]);
    expect(free.data.constraints).toEqual([]);
    const onAxis = run(startDraw('point'), { entities: [], constraints: [] }, [[0, 20]], 0.5);
    expect(kinds(onAxis.data.constraints)).toEqual(['pointOn']);
    const again = run(startDraw('point'), free.data, [[12, 7]]);
    expect(again.data.entities).toHaveLength(1);
  });
});
