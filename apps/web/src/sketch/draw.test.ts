import type { SketchConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  cancel,
  click,
  type DrawState,
  finishShape,
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
    // The fourth corner snapped level with the start (a committed vertical alignment), so the
    // closing edge's vertical would be redundant: it is neither shown nor added (M3.8).
    expect(kinds(all.constraints)).toEqual([
      'horizontal',
      'horizontal',
      'vertical',
      'verticalPoints',
    ]);
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
      [100.3, 100.2], // back onto the start point → closes (already aligned)
    ]);
    expect(lines(data.entities)).toHaveLength(4);
    expect(data.entities.filter((e) => e.kind === 'point')).toHaveLength(4);
    // The fourth corner's vertical alignment with the start is committed, so closing adds no
    // redundant vertical (M3.8: shown == committed).
    expect(kinds(data.constraints)).toEqual([
      'horizontal',
      'horizontal',
      'vertical',
      'verticalPoints',
    ]);
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

describe('curve tools (M3.5)', () => {
  const empty: SketchData = { entities: [], constraints: [] };
  const far = (p: Vec2): Vec2 => [p[0] + 100, p[1] + 100]; // clear of the origin and the axes

  it('ellipse: centre, axis end, minor point', () => {
    const { data } = run(startDraw('ellipse'), empty, [
      [100, 100],
      [130, 100],
      [130, 112],
    ]);
    const e = data.entities.find((x) => x.kind === 'ellipse');
    expect(e).toMatchObject({ kind: 'ellipse', majorRadius: 30, minorRadius: 12 });
  });

  it('ellipse preview: a guide line after two points, the ellipse itself with a third', () => {
    let s = startDraw('ellipse');
    s = move(s, empty, far([0, 0]), 1);
    s = click(s, empty).state;
    s = move(s, empty, far([30, 0]), 1);
    const two = preview(s, empty);
    expect(two?.entities.some((e) => e.kind === 'line')).toBe(true);
    s = click(s, empty).state;
    s = move(s, empty, far([30, 10]), 1);
    const three = preview(s, empty);
    expect(three?.entities.find((e) => e.kind === 'ellipse')).toMatchObject({ majorRadius: 30 });
    expect(three?.entities.every((e) => e.id.startsWith('preview:'))).toBe(true);
  });

  it('elliptic arc: five clicks; the ellipse is previewed (dashed) before the arc', () => {
    let s = startDraw('ellipticArc');
    const pts: Vec2[] = [far([0, 0]), far([25, 0]), far([25, 12]), far([25, 0]), far([0, 12])];
    for (const p of pts.slice(0, 3)) {
      s = move(s, empty, p, 1);
      s = click(s, empty).state;
    }
    s = move(s, empty, far([10, 5]), 1);
    const pre = preview(s, empty);
    expect(pre?.entities.find((e) => e.kind === 'ellipse')?.construction).toBe(true);
    const { data } = run(startDraw('ellipticArc'), empty, pts);
    expect(data.entities.some((e) => e.kind === 'ellipticArc')).toBe(true);
  });

  it('through-point spline: taps, then Enter ends it open; a repeated tap adds no point', () => {
    const pts: Vec2[] = [
      [100, 100],
      [110, 114],
      [120, 106],
      [130, 115],
    ];
    const { state, data } = run(startDraw('splineThrough'), empty, pts);
    expect(state.anchors).toHaveLength(4);
    expect(data.entities).toHaveLength(0); // nothing made yet
    const again = click(move(state, data, pts[3] as Vec2, 1), data);
    expect(again.state.anchors).toHaveLength(4);
    const done = finishShape(state);
    const spline = done?.edit?.entities.find((e) => e.kind === 'bspline');
    expect(spline).toMatchObject({ kind: 'bspline', periodic: false });
    expect(spline?.kind === 'bspline' && spline.through).toHaveLength(2); // the inner ones
    expect(done?.state.anchors).toHaveLength(0);
    // Nothing to end for a line, and one point is not a curve.
    expect(finishShape(startDraw('line'))).toBeNull();
    const one = run(startDraw('splineControl'), empty, [[100, 100]]).state;
    expect(finishShape(one)?.edit).toBeNull();
  });

  it('tapping the first point closes a spline into a periodic one', () => {
    const { state, data } = run(startDraw('splineControl'), empty, [
      [100, 100],
      [120, 100],
      [120, 120],
      [100, 120],
    ]);
    const s = move(state, data, [100.2, 100.2], 1);
    // The preview shows the closed curve before the tap.
    expect(preview(s, data)?.entities.find((e) => e.kind === 'bspline')).toMatchObject({
      periodic: true,
    });
    const r = click(s, data);
    expect(r.edit?.entities.find((e) => e.kind === 'bspline')).toMatchObject({ periodic: true });
    expect(r.state.anchors).toHaveLength(0);
  });
});
