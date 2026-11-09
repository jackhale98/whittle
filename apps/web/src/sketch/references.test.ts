import type { PickHit, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { rectangleCornerTool } from '@wren-cad/sketch';
import { describe, expect, it } from 'vitest';
import { applicableConstraints, constraintFrom } from '../app/sketch-session';
import { dimensionAt, dimensionFor, labelAnchor, makeDimension, measure } from './dimension';
import { click, type DrawState, move, type SketchData, startDraw } from './draw';
import {
  axisSpan,
  SKETCH_ORIGIN as O,
  ORIGIN_GLYPH_IDS,
  rankSketchHits,
  referenceOverlay,
  spanCovers,
  withReferences,
  SKETCH_X_AXIS as X,
  SKETCH_Y_AXIS as Y,
} from './references';

const ids = () => {
  let n = 0;
  return () => `e${++n}`;
};
// Corner (10, 5) to (50, 25): points e1..e4, lines e5 (bottom) e6 (right) e7 (top) e8 (left).
const rect = rectangleCornerTool([10, 5], [50, 25], { id: ids() });
const circle: SketchData = {
  entities: [
    { id: 'c0', kind: 'point', construction: false, x: 30, y: -12 },
    { id: 'c', kind: 'circle', construction: false, center: 'c0', radius: 4 },
    { id: 'a0', kind: 'point', construction: false, x: -20, y: 8 },
    { id: 'a1', kind: 'point', construction: false, x: -17, y: 8 },
    { id: 'a2', kind: 'point', construction: false, x: -20, y: 11 },
    { id: 'a', kind: 'arc', construction: false, center: 'a0', start: 'a1', end: 'a2' },
    { id: 's0', kind: 'point', construction: false, x: 0, y: 40 },
    { id: 's1', kind: 'point', construction: false, x: 10, y: 50 },
    { id: 's', kind: 'line', construction: false, start: 's0', end: 's1' },
  ],
  constraints: [],
};

describe('dimensions to the origin and axes', () => {
  it('origin ↔ point: horizontal, vertical or aligned by label placement', () => {
    // Origin (0, 0) and corner e1 (10, 5): below the span → horizontal, beside it → vertical.
    const h = dimensionAt(rect, [O, 'e1'], [5, -6]);
    expect(h).toEqual({ kind: 'hDistance', a: O, b: 'e1' });
    expect(h && measure(rect, h)).toBeCloseTo(10);
    const v = dimensionAt(rect, ['e1', O], [-6, 2.5]);
    expect(v).toEqual({ kind: 'vDistance', a: O, b: 'e1' });
    expect(v && measure(rect, v)).toBeCloseTo(5);
    const d = dimensionAt(rect, [O, 'e1'], [5, 2.5]);
    expect(d).toEqual({ kind: 'distance', a: O, b: 'e1' });
    expect(d && measure(rect, d)).toBeCloseTo(Math.hypot(10, 5));
    expect(dimensionAt(rect, [O, 'e1'], [5, -6], { aligned: true })?.kind).toBe('distance');
  });

  it('axis ↔ point: perpendicular distance (either pick order)', () => {
    const a = dimensionFor(rect, [X, 'e3']);
    expect(a).toEqual({ kind: 'distance', a: 'e3', b: X });
    expect(a && measure(rect, a)).toBeCloseTo(25);
    const b = dimensionFor(rect, ['e3', Y]);
    expect(b).toEqual({ kind: 'distance', a: 'e3', b: Y });
    expect(b && measure(rect, b)).toBeCloseTo(50);
    // Label placement does not turn it into an h/v distance.
    expect(dimensionAt(rect, [Y, 'e1'], [5, -10])).toEqual({ kind: 'distance', a: 'e1', b: Y });
  });

  it('axis ↔ line: distance when parallel, else angle (from the axis)', () => {
    const par = dimensionFor(rect, ['e7', X]);
    expect(par).toEqual({ kind: 'distance', a: X, b: 'e7' });
    expect(par && measure(rect, par)).toBeCloseTo(25);
    const parY = dimensionFor(rect, [Y, 'e6']);
    expect(parY && measure(rect, parY)).toBeCloseTo(50);
    const ang = dimensionFor(circle, ['s', X]);
    expect(ang).toEqual({ kind: 'angle', a: X, b: 's' });
    expect(ang && measure(circle, ang)).toBeCloseTo(Math.PI / 4);
    const angY = dimensionFor(circle, [Y, 's']);
    expect(angY && measure(circle, angY)).toBeCloseTo((7 * Math.PI) / 4);
  });

  it('axis or origin ↔ circle/arc: to the centre', () => {
    const c = dimensionFor(circle, ['c', Y]);
    expect(c).toEqual({ kind: 'distance', a: 'c0', b: Y });
    expect(c && measure(circle, c)).toBeCloseTo(30);
    const cx = dimensionFor(circle, [X, 'c']);
    expect(cx && measure(circle, cx)).toBeCloseTo(12);
    const arc = dimensionFor(circle, ['a', Y]);
    expect(arc).toEqual({ kind: 'distance', a: 'a0', b: Y });
    expect(arc && measure(circle, arc)).toBeCloseTo(20);
    // From the origin: centre point, so label placement picks h / v as for two points.
    const o = dimensionAt(circle, ['c', O], [15, 6]);
    expect(o).toEqual({ kind: 'hDistance', a: O, b: 'c0' });
    expect(o && measure(circle, o)).toBeCloseTo(30);
  });

  it('origin ↔ line is the point–line distance; references alone make nothing', () => {
    const d = dimensionFor(rect, ['e8', O]);
    expect(d).toEqual({ kind: 'distance', a: O, b: 'e8' });
    expect(d && measure(rect, d)).toBeCloseTo(10);
    expect(dimensionFor(rect, [X])).toBeNull();
    expect(dimensionFor(rect, [O])).toBeNull();
    expect(dimensionFor(rect, [X, Y])).toBeNull();
    expect(dimensionFor(rect, [O, X])).toBeNull();
  });

  it('labels anchor on reference geometry like on any entity', () => {
    const c = makeDimension({ kind: 'hDistance', a: O, b: 'e1' }, '10 mm');
    expect(labelAnchor(rect, c)).toEqual([5, 2.5]);
    expect(labelAnchor(rect, { ...c, label: [3, -4] })).toEqual([3, -4]);
    expect(withReferences(rect).entities).toHaveLength(rect.entities.length + 5);
  });
});

describe('picking priority', () => {
  const hit = (entity: string, kind: PickHit['kind'], distancePx: number): PickHit => ({
    bodyId: 'S',
    kind,
    index: 0,
    entity,
    point: [0, 0, 0],
    distancePx,
  });

  it('real points beat the origin when stacked, the origin beats the axes', () => {
    expect(
      rankSketchHits([
        hit(O, 'sketchPoint', 0),
        hit('p1', 'sketchPoint', 2),
        hit(X, 'sketchCurve', 0),
      ])?.entity,
    ).toBe('p1');
    expect(
      rankSketchHits([hit(X, 'sketchCurve', 0), hit(O, 'sketchPoint', 1), hit(Y, 'sketchCurve', 0)])
        ?.entity,
    ).toBe(O);
  });

  it('the user’s curves beat the origin and the axes at the same spot', () => {
    expect(rankSketchHits([hit(X, 'sketchCurve', 0), hit('l1', 'sketchCurve', 3)])?.entity).toBe(
      'l1',
    );
    expect(rankSketchHits([hit(O, 'sketchPoint', 0), hit('l1', 'sketchCurve', 4)])?.entity).toBe(
      'l1',
    );
    // Among the user's geometry: points first, then the nearest.
    expect(
      rankSketchHits([
        hit('l1', 'sketchCurve', 0),
        hit('l2', 'sketchCurve', 1),
        hit('p', 'sketchPoint', 5),
      ])?.entity,
    ).toBe('p');
    expect(rankSketchHits([hit('l1', 'sketchCurve', 3), hit('l2', 'sketchCurve', 1)])?.entity).toBe(
      'l2',
    );
  });

  it('the origin glyph’s arms pick the origin; the nearest axis wins', () => {
    const g = rankSketchHits([
      hit(ORIGIN_GLYPH_IDS[0], 'sketchCurve', 1),
      hit(X, 'sketchCurve', 0),
    ]);
    expect(g?.entity).toBe(O);
    expect(g?.kind).toBe('sketchPoint');
    expect(rankSketchHits([hit(X, 'sketchCurve', 4), hit(Y, 'sketchCurve', 1)])?.entity).toBe(Y);
    expect(rankSketchHits([])).toBeNull();
  });
});

describe('reference overlay', () => {
  const frame = { origin: [0, 0, 5] as const, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as never;

  it('draws the axes across the span, the origin glyph and a faded origin dot', () => {
    const o = referenceOverlay(frame, { min: [-30, -20], max: [60, 40] }, 2);
    expect(o.curves.map((c) => c.entity)).toEqual([X, Y, ...ORIGIN_GLYPH_IDS]);
    expect([...(o.curves[0]?.points ?? [])]).toEqual([-30, 0, 5, 60, 0, 5]);
    expect([...(o.curves[1]?.points ?? [])]).toEqual([0, -20, 5, 0, 40, 5]);
    expect(o.curves[0]?.construction).toBe(true);
    expect(o.curves[2]?.construction).toBe(false);
    expect(o.points).toEqual([{ entity: O, at: [0, 0, 5], construction: true }]);
  });

  it('the span follows the view and is redrawn when the view leaves it or shrinks', () => {
    const view = { min: [10, 10] as Vec2, max: [50, 30] as Vec2 };
    const span = axisSpan(view, 0);
    expect(span.min[0]).toBeCloseTo(5);
    expect(span.max[0]).toBeCloseTo(55);
    expect(spanCovers(span, view)).toBe(true);
    expect(spanCovers(span, { min: [40, 10], max: [80, 30] })).toBe(false); // panned
    expect(spanCovers(span, { min: [20, 15], max: [25, 18] })).toBe(false); // zoomed in
    expect(spanCovers(span, null)).toBe(true);
    expect(axisSpan(null, 50).max[0]).toBe(1000);
  });
});

describe('drawing snaps to the origin and axes', () => {
  function draw(
    tool: DrawState,
    clicks: Vec2[],
    sketch: SketchData = { entities: [], constraints: [] },
  ) {
    let s = tool;
    const data = { entities: [...sketch.entities], constraints: [...sketch.constraints] };
    for (const p of clicks) {
      s = move(s, data, p, 1);
      const r = click(s, data);
      s = r.state;
      if (r.edit) {
        data.entities.push(...r.edit.entities);
        data.constraints.push(...r.edit.constraints);
      }
    }
    return { state: s, data };
  }

  it('a corner at the origin gets a new point coincident with it (never the origin itself)', () => {
    const s = move(startDraw('rectangle'), { entities: [], constraints: [] }, [0.3, -0.2], 1);
    expect(s.cursor).toEqual([0, 0]);
    expect(s.glyphs).toContain('coincident');
    expect(s.hover?.pointId).toBeUndefined();
    const { data } = draw(startDraw('rectangle'), [
      [0.3, -0.2],
      [20, 10],
    ]);
    const c = data.constraints.find((k) => k.kind === 'coincident');
    expect(c && c.kind === 'coincident' && c.b).toBe(O);
    const p = data.entities.find((e) => c?.kind === 'coincident' && e.id === c.a);
    expect(p?.kind === 'point' && [p.x, p.y]).toEqual([0, 0]);
    for (const e of data.entities) expect(e.id.startsWith('@')).toBe(false);
    for (const e of data.entities as SketchEntity[])
      if (e.kind === 'line') expect([e.start, e.end]).not.toContain(O);
  });

  it('points snap onto the axes (point on) with a glyph', () => {
    const s = move(startDraw('circle'), { entities: [], constraints: [] }, [15, 0.6], 1);
    expect(s.cursor).toEqual([15, 0]);
    expect(s.glyphs).toEqual(['pointOn']);
    const { data } = draw(startDraw('circle'), [
      [15, 0.6],
      [18, 0.6],
    ]);
    expect(data.constraints).toContainEqual(expect.objectContaining({ kind: 'pointOn', on: X }));
  });

  it('a line along an axis gets no redundant horizontal/vertical', () => {
    const { data } = draw(startDraw('line'), [
      [0.2, 0.1], // the origin
      [30, 0.3], // on the horizontal axis (and horizontal)
      [30.2, 20], // vertical
    ]);
    const k = data.constraints.map((c) => c.kind).sort();
    expect(k).toEqual(['coincident', 'pointOn', 'vertical']);
    const { data: up } = draw(startDraw('line'), [
      [0.4, 10],
      [-0.3, 40],
    ]);
    expect(up.constraints.map((c) => c.kind).sort()).toEqual(['pointOn', 'pointOn']);
  });

  it('the user’s own point at the origin wins over the origin', () => {
    const own: SketchData = {
      entities: [{ id: 'p', kind: 'point', construction: false, x: 0, y: 0 }],
      constraints: [],
    };
    const s = move(startDraw('line'), own, [0.2, 0.2], 1);
    expect(s.hover?.pointId).toBe('p');
  });
});

describe('constraint tools with the origin and axes', () => {
  const ents = rect.entities;

  it('offers relations to the user’s geometry only', () => {
    expect(applicableConstraints(ents, ['e1', O])).toEqual([
      'coincident',
      'horizontalPoints',
      'verticalPoints',
    ]);
    expect(applicableConstraints(ents, ['e5', X])).toEqual(['parallel', 'perpendicular']);
    expect(applicableConstraints(ents, ['e1', Y])).toEqual(['pointOn']);
    expect(applicableConstraints(ents, [O, 'e5'])).toEqual(['midpoint', 'pointOn']);
    expect(applicableConstraints(ents, ['e1', 'e3', Y])).toEqual(['symmetric']);
    expect(applicableConstraints(ents, [X])).toEqual([]);
    expect(applicableConstraints(ents, [X, Y])).toEqual([]);
    expect(applicableConstraints(ents, [O, X])).toEqual([]);
  });

  it('builds them with the reserved ids', () => {
    expect(constraintFrom('coincident', ents, ['e1', O])).toMatchObject({
      kind: 'coincident',
      a: 'e1',
      b: O,
    });
    expect(constraintFrom('pointOn', ents, [X, 'e2'])).toMatchObject({
      kind: 'pointOn',
      point: 'e2',
      on: X,
    });
    expect(constraintFrom('symmetric', ents, ['e1', 'e2', Y])).toMatchObject({
      kind: 'symmetric',
      a: 'e1',
      b: 'e2',
      about: Y,
    });
    expect(constraintFrom('parallel', ents, ['e7', X])).toMatchObject({ a: 'e7', b: X });
  });
});
