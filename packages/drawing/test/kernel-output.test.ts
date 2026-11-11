import type { Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { DisplayList } from '../src/annotation';
import { flattenArc, flattenBSpline, flattenEllipse } from '../src/annotation';
import { renderDxf } from '../src/dxf';
import { chainLoop } from '../src/sheet';
import { renderSvg } from '../src/svg';
import { bracketBuild } from './fixtures';

/** What the real drawing kernel's output requires of the package (ADR-092 amendment). */

const style = { lineGroup: 'iso-0.5' as const };
const list = (items: DisplayList['items']): DisplayList => ({ width: 100, height: 100, items });
const src = { kind: 'view' as const, viewId: 'V' };

describe('hatching from section faces', () => {
  it('never gives a hatch the kernel’s synthetic face id as an edge name', () => {
    const items = bracketBuild().sheets[0]?.list.items ?? [];
    const hatch = items.filter((i) => i.role === 'hatch');
    expect(hatch.length).toBeGreaterThan(5);
    for (const h of hatch) {
      expect(h.source?.kind).toBe('view');
      expect(h.source && 'edge' in h.source).toBe(false);
    }
  });

  it('chains a loop whose arc keeps its counter-clockwise form against the wire direction', () => {
    // A half disc: the wire walks the line (0,0) -> (10,0), then the lower arc back to (0,0) in the
    // clockwise sense, but the kernel lists the arc counter-clockwise, from (0,0) to (10,0).
    const base: Vec2[] = [
      [0, 0],
      [10, 0],
    ];
    const arcCcw: Vec2[] = flattenArc([5, 0], 5, Math.PI, 2 * Math.PI, 0.01);
    const side: Vec2[] = [
      [0, 0],
      [0, 3],
    ];
    const loop = chainLoop([base, arcCcw, side]);
    // After the 10 mm base line every step is short: the arc was walked from (10,0) back to (0,0).
    for (let i = 2; i < loop.length; i++) {
      const a = loop[i - 1] as Vec2;
      const b = loop[i] as Vec2;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(3);
    }
    expect(loop.at(-1)).toEqual([0, 3]);
    expect(chainLoop([])).toEqual([]);
  });
});

describe('curves as the kernel reports them', () => {
  it('reads an ellipse’s start and end as parameters, not angles', () => {
    // a = 4, b = 2: the parameter π/2 is the minor vertex.
    const pts = flattenEllipse([1, 1], [4, 0], 0.5, 0, Math.PI / 2, 0.01);
    expect(pts[0]).toEqual([5, 1]);
    const last = pts.at(-1) as Vec2;
    expect(last[0]).toBeCloseTo(1, 9);
    expect(last[1]).toBeCloseTo(3, 9);
    // A tilted major axis: the parameter is still measured from the major axis.
    const t = flattenEllipse([0, 0], [0, 4], 0.5, 0, Math.PI / 2, 0.01);
    expect(t[0]?.[0]).toBeCloseTo(0, 9);
    expect(t[0]?.[1]).toBeCloseTo(4, 9);
    expect(t.at(-1)?.[0]).toBeCloseTo(-2, 9);
  });

  it('flattens a clamped B-spline given as one flat knot vector, end to end', () => {
    const poles: Vec2[] = [
      [0, 0],
      [1, 2],
      [3, 2],
      [4, 0],
    ];
    const pts = flattenBSpline(3, poles, [0, 0, 0, 0, 1, 1, 1, 1], 0.01);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)?.[0]).toBeCloseTo(4, 6);
    expect(pts.at(-1)?.[1]).toBeCloseTo(0, 6);
    // Interior knots in the same flat vector (two spans).
    const two = flattenBSpline(
      2,
      [
        [0, 0],
        [1, 1],
        [2, 0],
        [3, 1],
        [4, 0],
      ],
      [0, 0, 0, 0.5, 0.5, 1, 1, 1],
      0.01,
    );
    expect(two.at(-1)?.[0]).toBeCloseTo(4, 6);
  });

  it('draws an arc that ends past 2π as the same arc in every renderer', () => {
    // 5.5 rad to 7.2 rad (= 0.917 rad): a 97° arc across the 0° direction.
    const items: DisplayList['items'] = [
      {
        kind: 'arc',
        center: [50, 50],
        radius: 10,
        start: 5.5,
        end: 7.2,
        role: 'visible',
        source: src,
      },
    ];
    const svg = renderSvg(list(items), style);
    expect(svg).toContain('A10 10 0 0 1'); // a short sweep, counter-clockwise
    for (const profile of ['r12', 'r2000'] as const) {
      const dxf = renderDxf(list(items), style, { profile });
      // DXF angles are degrees in [0, 360): 5.5 rad = 315.1°, 7.2 rad = 52.5°.
      expect(dxf).toMatch(/\n\s*50\n315\.1\d*\n\s*51\n52\.5\d*\n/);
    }
  });
});
