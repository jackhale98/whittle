/**
 * Region detection (src/regions.ts): bounded faces of the curve arrangement, holes, exact areas
 * and loop orientation, with splines and elliptic arcs (golden areas against a dense polygon).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Id, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { interpolate } from '../src/bspline';
import { indexEntities } from '../src/geometry';
import { loopPolygon, type SketchRegion, sketchRegions } from '../src/regions';
import { SketchBuilder } from './helpers';

/** Shoelace area of a dense outline: the numerical reference. */
function polygonArea(b: SketchBuilder, loop: SketchRegion['outer']): number {
  const poly = loopPolygon(indexEntities(b.entities), loop, 6000);
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    s += p[0] * q[1] - p[1] * q[0];
  }
  return s / 2;
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function rect(b: SketchBuilder, x0: number, y0: number, x1: number, y1: number) {
  const p = [b.point(x0, y0), b.point(x1, y0), b.point(x1, y1), b.point(x0, y1)];
  return p.map((q, i) => b.line(q, p[(i + 1) % 4] as Id));
}

describe('sketchRegions', () => {
  it('a rectangle is one counter-clockwise region with its area, whichever way it was drawn', () => {
    const b = new SketchBuilder();
    const p = [b.point(0, 0), b.point(0, 20), b.point(30, 20), b.point(30, 0)]; // clockwise
    p.forEach((q, i) => {
      b.line(q, p[(i + 1) % 4] as Id);
    });
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(1);
    expect(r[0]?.area).toBeCloseTo(600, 9);
    expect(r[0]?.outer.area).toBeGreaterThan(0);
    expect(r[0]?.outer.edges).toHaveLength(4);
  });

  it('a circle inside a rectangle: the rectangle with a hole, and the disc', () => {
    const b = new SketchBuilder();
    rect(b, 0, 0, 40, 30);
    const c = b.circle(b.point(20, 15), 5);
    const r = sketchRegions(b.entities).sort((x, y) => x.area - y.area);
    expect(r).toHaveLength(2);
    expect(r[0]?.area).toBeCloseTo(Math.PI * 25, 9);
    expect(r[0]?.outer.edges[0]?.entity).toBe(c);
    expect(r[1]?.holes).toHaveLength(1);
    expect(r[1]?.holes[0]?.area).toBeLessThan(0);
    expect(r[1]?.area).toBeCloseTo(1200 - Math.PI * 25, 9);
  });

  it('an ellipse: π a b; a line across it splits it in two', () => {
    const b = new SketchBuilder();
    b.ellipse(b.point(0, 0), 10, 4, 0.4);
    expect(sketchRegions(b.entities)[0]?.area).toBeCloseTo(Math.PI * 40, 9);
    b.segment([-20, 1], [20, 2]);
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(2);
    expect((r[0]?.area ?? 0) + (r[1]?.area ?? 0)).toBeCloseTo(Math.PI * 40, 9);
  });

  it('golden: a spline through 5 points closed with a line (≤ 1e-6 of the dense reference)', () => {
    const b = new SketchBuilder();
    const pts: Vec2[] = [
      [0, 0],
      [10, 12],
      [25, 15],
      [38, 8],
      [45, 0],
    ];
    const it3 = interpolate(pts, 3, false);
    if (!it3) throw new Error('no spline');
    const ids = it3.poles.map((p) => b.point(p[0], p[1]));
    b.bspline(ids, { knots: it3.knots, multiplicities: it3.multiplicities });
    b.line(ids[ids.length - 1] as Id, ids[0] as Id);
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(1);
    const region = r[0] as SketchRegion;
    expect(
      region.outer.edges.map((e) => b.entities.find((x) => x.id === e.entity)?.kind).sort(),
    ).toEqual(['bspline', 'line']);
    expect(rel(region.area, polygonArea(b, region.outer))).toBeLessThan(1e-6);
  });

  it('golden: a profile bounded by a spline and an elliptic arc', () => {
    const b = new SketchBuilder();
    // Upper half of an ellipse from (10, 0) to (−10, 0) (CCW), closed by a spline below.
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const t = b.point(-10, 0);
    b.ellipticArc(c, 10, 6, 0, s, t);
    const mid = [b.point(-5, -6), b.point(5, -6)];
    b.bspline([t, mid[0] as Id, mid[1] as Id, s]);
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(1);
    const region = r[0] as SketchRegion;
    expect(region.outer.area).toBeGreaterThan(0);
    expect(rel(region.area, polygonArea(b, region.outer))).toBeLessThan(1e-6);
    // Half the ellipse (30π) plus the Bézier's area below the chord:
    // ∫ 18 t(1 − t) · 15 (1 + 2t − 2t²) dt over [0, 1] = 63.
    expect(region.area).toBeCloseTo(30 * Math.PI + 63, 9);
  });

  it('a closed spline drawn clockwise is still a positive region; construction and dangling curves bound nothing', () => {
    const b = new SketchBuilder();
    const it3 = interpolate(
      [
        [0, 0],
        [0, 20],
        [25, 22],
        [28, 3],
      ],
      3,
      true,
    );
    if (!it3) throw new Error('no spline');
    b.bspline(
      it3.poles.map((p) => b.point(p[0], p[1])),
      { periodic: true, knots: it3.knots, multiplicities: it3.multiplicities, degree: it3.degree },
    );
    b.segment([40, 0], [50, 10]); // dangling
    const k = b.circle(b.point(60, 0), 3);
    const ce = b.entities.find((e) => e.id === k);
    if (ce) ce.construction = true;
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(1);
    expect(r[0]?.area).toBeGreaterThan(0);
    expect(rel(r[0]?.area as number, polygonArea(b, (r[0] as SketchRegion).outer))).toBeLessThan(
      1e-6,
    );
  });

  it('a line ending on a spline (T-junction) splits the region', () => {
    const b = new SketchBuilder();
    const p = [b.point(0, 0), b.point(10, 15), b.point(20, 15), b.point(30, 0)];
    b.bspline(p);
    b.line(p[3] as Id, p[0] as Id);
    // From the chord's midpoint straight up to the spline's top (the Bézier's midpoint).
    const foot = b.point(15, 0);
    const top = b.point(15, 11.25);
    b.line(foot, top);
    const r = sketchRegions(b.entities);
    expect(r).toHaveLength(2);
    expect(r[0]?.area).toBeCloseTo(r[1]?.area as number, 9);
    // x = 30t, y = 45t(1 − t): ∫ y dx = 30 · 45 / 6 = 225.
    expect((r[0]?.area as number) + (r[1]?.area as number)).toBeCloseTo(225, 9);
  });
});
