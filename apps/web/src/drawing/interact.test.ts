import type { Drawing, PlacementLayout, Vec2, ViewProjection } from '@wren-cad/contracts';
import { solveViews, type ViewSolution } from '@wren-cad/drawing';
import { describe, expect, it } from 'vitest';
import type { DrawingController } from './controller';
import { dragLayout, handlesOf } from './interact';
import { nextDatumLabel, planAngle, planDimension } from './ops-annot';
import type { Built } from './pipeline';
import type { EdgePick } from './state';

const ev = (e: string) =>
  e === '1' ? 1 : Number(e.split('/')[1]) ? 1 / Number(e.split('/')[1]) : 1;

/** A drawing with one front view of an 80 × 50 × 48 part at 1:1, centred at (100, 100). */
function fixture(placements: Drawing['placements'] = []): {
  c: DrawingController;
  view: Extract<ViewSolution, { ok: true }>;
} {
  const drawing = {
    id: 'D',
    name: 'd',
    subject: { kind: 'part', partId: 'P' },
    standard: { family: 'iso', gps: 'ISO 1101:2017', surfaceFinish: 'ISO 21920-1:2021' },
    projection: 'first',
    units: 'mm',
    style: {} as Drawing['style'],
    template: { id: 'iso-5457', version: 1 },
    sheets: [
      { id: 'S', name: 'Sheet 1', format: { size: 'A3', orientation: 'landscape' }, scale: '1' },
    ],
    views: [
      {
        id: 'V',
        sheetId: 'S',
        kind: 'base',
        orientation: { kind: 'named', name: 'front' },
        layout: { kind: 'free', position: [100, 100] },
      },
    ],
    placements,
    centerMarks: [],
    tables: [],
    notes: [],
  } as unknown as Drawing;
  const views = solveViews({
    drawing,
    bounds: { min: [0, 0, 0], max: [80, 50, 48] },
    evaluate: (e) => ev(e),
  });
  const view = views.get('V') as Extract<ViewSolution, { ok: true }>;
  const built = {
    drawing,
    part: { id: 'P', annotations: [] },
    build: { views, placed: [], attention: [], sheets: [] },
    projections: new Map<string, ViewProjection>(),
  } as unknown as Built;
  return { c: { built: () => built } as unknown as DrawingController, view };
}

const line = (
  name: string,
  a: Vec2,
  b: Vec2,
  at: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
): EdgePick => ({
  viewId: 'V',
  name,
  shape: 'line',
  at,
  geom: { a, b },
});
const circle = (name: string, centre: Vec2, radius = 3, full = true): EdgePick => ({
  viewId: 'V',
  name,
  shape: 'circle',
  at: centre,
  geom: { centre, radius, full },
});

describe('which dimension the picks mean', () => {
  it('one circle is a diameter, an arc a radius, Alt makes a radius of a circle', () => {
    const { c } = fixture();
    const d = planDimension(c, [circle('c', [10, 10])]);
    expect(d).toMatchObject({
      ok: true,
      annotation: { kind: 'diameter' },
      layout: { kind: 'radial' },
    });
    expect(planDimension(c, [circle('c', [10, 10], 3, false)])).toMatchObject({
      ok: true,
      annotation: { kind: 'radius' },
    });
    expect(planDimension(c, [circle('c', [10, 10])], true)).toMatchObject({
      ok: true,
      annotation: { kind: 'radius' },
    });
  });

  it('one straight edge picked twice is its length, between its ends', () => {
    const { c } = fixture();
    const d = planDimension(c, [line('e', [0, 0], [80, 0])]);
    expect(d).toMatchObject({
      ok: true,
      annotation: { kind: 'aligned', at: ['start', 'end'] },
      layout: { kind: 'offset' },
    });
  });

  it('two parallel vertical edges are a horizontal linear dimension, below the view when picked low', () => {
    const { c, view } = fixture();
    const o = [view.position[0], view.position[1]];
    const a = line('left', [-40, -24], [-40, 24], [(o[0] as number) - 40, (o[1] as number) - 10]);
    const b = line('right', [40, -24], [40, 24], [(o[0] as number) + 40, (o[1] as number) - 10]);
    const d = planDimension(c, [a, b]);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.annotation).toMatchObject({
      kind: 'linear',
      direction: [1, 0, 0],
      at: ['self', 'self'],
    });
    // Picked in the lower half of the view: the bottom side, nearest lane.
    expect(d.layout).toEqual({ kind: 'lane', side: 'bottom', lane: 0 });
  });

  it('two parallel horizontal edges are vertical, on the side they were picked, in the next free lane', () => {
    const { c, view } = fixture([
      {
        id: 'p1',
        viewId: 'V',
        annotationId: 'A',
        layout: { kind: 'lane', side: 'right', lane: 0 },
      },
    ]);
    const x = view.position[0] + 30;
    const a = line('low', [-40, -24], [40, -24], [x, view.position[1] - 24]);
    const b = line('high', [-40, 24], [40, 24], [x, view.position[1] + 24]);
    const d = planDimension(c, [a, b]);
    expect(d).toMatchObject({
      ok: true,
      annotation: { kind: 'linear', direction: [0, 0, 1] },
      layout: { kind: 'lane', side: 'right', lane: 1 },
    });
  });

  it('two edges that meet make an angle, with an arc placed clear of the vertex', () => {
    const { c } = fixture();
    const d = planDimension(c, [line('a', [0, 0], [40, 0]), line('b', [0, 0], [0, 40])]);
    expect(d).toMatchObject({
      ok: true,
      viewId: 'V',
      annotation: { kind: 'angle', at: ['self', 'self'] },
      layout: { kind: 'arc' },
    });
    const radius = d.ok && d.layout.kind === 'arc' ? d.layout.radius : 0;
    expect(radius).toBeGreaterThanOrEqual(8);
    expect(radius).toBeLessThanOrEqual(30);
  });

  it('the angle needs two different straight edges that are not parallel, and says why', () => {
    const { c } = fixture();
    const same = planAngle(c, [line('a', [0, 0], [40, 0]), line('a', [0, 0], [40, 0])]);
    expect(same).toEqual({ ok: false, message: expect.stringMatching(/two different edges/) });
    const par = planAngle(c, [line('a', [0, 0], [40, 0]), line('b', [0, 9], [40, 9.2])]);
    expect(par).toEqual({ ok: false, message: expect.stringMatching(/parallel/) });
    const curved = planAngle(c, [line('a', [0, 0], [40, 0]), circle('h', [10, 10])]);
    expect(curved).toEqual({ ok: false, message: expect.stringMatching(/straight edges/) });
  });

  it('a circle and an edge measure from the centre; two circles along the larger separation', () => {
    const { c } = fixture();
    const e = planDimension(c, [circle('h', [10, 10]), line('edge', [0, 0], [0, 40])]);
    expect(e).toMatchObject({ ok: true, annotation: { kind: 'linear', at: ['center', 'self'] } });
    const cc = planDimension(c, [circle('a', [10, 10]), circle('b', [60, 14])]);
    expect(cc).toMatchObject({
      ok: true,
      annotation: { kind: 'linear', direction: [1, 0, 0], at: ['center', 'center'] },
    });
    const cv = planDimension(c, [circle('a', [10, 10]), circle('b', [14, 70])]);
    expect(cv).toMatchObject({ ok: true, annotation: { direction: [0, 0, 1] } });
  });

  it('edges on different views, curves and a lone first pick are not dimensioned', () => {
    const { c } = fixture();
    expect(
      planDimension(c, [
        line('a', [0, 0], [40, 0]),
        { ...line('b', [0, 5], [40, 5]), viewId: 'W' },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      planDimension(c, [
        { viewId: 'V', name: 'x', shape: 'other', at: [0, 0] },
        line('b', [0, 5], [40, 5]),
      ]),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/curved/) });
    expect(planDimension(c, [])).toMatchObject({ ok: false });
  });
});

describe('datum letters', () => {
  it('take the next free one and never I, O or Q', () => {
    expect(nextDatumLabel([])).toBe('A');
    expect(nextDatumLabel(['A', 'B'])).toBe('C');
    expect(nextDatumLabel(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).toBe('J');
    expect(nextDatumLabel(['A', 'C'])).toBe('B');
  });
});

describe('dragging an annotation between lanes', () => {
  const outline = { min: [20, 20] as Vec2, max: [100, 70] as Vec2 };
  const ctx = { outline, firstLane: 10, laneSpacing: 7 };

  it('a lane follows the pointer by its distance from the view, and flips to the opposite side', () => {
    const start: PlacementLayout = { kind: 'lane', side: 'bottom', lane: 0 };
    // 10 mm below the view is lane 0, 17 mm lane 1, 31 mm lane 3.
    expect(dragLayout(start, [60, 10], [60, 10], ctx)).toEqual({
      kind: 'lane',
      side: 'bottom',
      lane: 0,
    });
    expect(dragLayout(start, [60, 10], [60, 3], ctx)).toEqual({
      kind: 'lane',
      side: 'bottom',
      lane: 1,
    });
    expect(dragLayout(start, [60, 10], [60, -11], ctx)).toEqual({
      kind: 'lane',
      side: 'bottom',
      lane: 3,
    });
    // Never closer than lane 0, even inside the view.
    expect(dragLayout(start, [60, 10], [60, 30], ctx)).toMatchObject({ lane: 0 });
    // Dragged to the other side of a horizontal dimension: top. Never to the other axis.
    expect(dragLayout(start, [60, 10], [60, 90], ctx)).toEqual({
      kind: 'lane',
      side: 'top',
      lane: 1,
    });
    expect(
      dragLayout({ kind: 'lane', side: 'left', lane: 0 }, [10, 40], [130, 40], ctx),
    ).toMatchObject({ side: 'right' });
  });

  it('an offset moves along the normal of its dimension line', () => {
    const start: PlacementLayout = { kind: 'offset', distance: 10 };
    const line: [Vec2, Vec2] = [
      [0, 0],
      [100, 0],
    ];
    // A horizontal line: the left normal is up.
    expect(dragLayout(start, [50, 0], [50, 6], { ...ctx, line })).toEqual({
      kind: 'offset',
      distance: 16,
    });
    expect(dragLayout(start, [50, 0], [80, -4], { ...ctx, line })).toEqual({
      kind: 'offset',
      distance: 6,
    });
    // Without its line there is nothing to measure against: it stays put.
    expect(dragLayout(start, [50, 0], [50, 6], ctx)).toBe(start);
  });

  it('a radial leader follows the angle and distance from its circle; a leader keeps its text offset', () => {
    const r = dragLayout({ kind: 'radial', angle: 45, distance: 6 }, [0, 0], [0, 20], {
      ...ctx,
      circle: { centre: [0, 0], r: 5 },
    });
    expect(r).toMatchObject({ kind: 'radial', distance: 15 });
    expect((r as { angle: number }).angle).toBeCloseTo(90, 9);
    const l = dragLayout(
      { kind: 'leader', attach: { kind: 'ref', index: 0 }, text: [10, 8] },
      [0, 0],
      [3, -2],
      ctx,
    );
    expect(l).toMatchObject({ kind: 'leader', text: [13, 6] });
  });
});

describe('the arrows around a selected view', () => {
  it('sit outside the outline on all four sides, a fixed number of pixels away', () => {
    const { view } = fixture();
    const mm = 0.5;
    const h = handlesOf(view, mm);
    expect(h.map((x) => x.dir)).toEqual([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]);
    const right = h[0] as { at: Vec2 };
    // The outline's right edge plus 14 px.
    expect(right.at[0]).toBeCloseTo(view.position[0] + 40 + 14 * mm, 6);
    expect(right.at[1]).toBeCloseTo(view.position[1], 6);
  });
});
