/**
 * Dimension annotations (src/annotation.ts): extension lines, dimension lines and arrows for each
 * dimension kind, arrows flipping outside, leaders, angle arcs, and label dragging.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DimensionConstraint, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  type DimensionAnnotation,
  dimensionAnnotation,
  dragDimensionLabel,
} from '../src/annotation';
import { SketchBuilder } from './helpers';

const close = (a: Vec2, b: Vec2, tol = 1e-9) =>
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);

type DimDraft = DimensionConstraint extends infer C
  ? C extends DimensionConstraint
    ? Omit<C, 'id' | 'value' | 'driving' | 'label'>
    : never
  : never;

function dim(_b: SketchBuilder, c: DimDraft, label?: Vec2) {
  return {
    id: 'd',
    value: '0',
    driving: true,
    ...c,
    ...(label ? { label } : {}),
  } as DimensionConstraint;
}

function annotate(
  entities: SketchEntity[],
  c: DimensionConstraint,
  value = 0,
): DimensionAnnotation {
  const a = dimensionAnnotation(entities, c, value, {
    textWidth: 8,
    arrowLength: 2.5,
    gap: 1,
    overshoot: 1.5,
  });
  if (!a) throw new Error('no annotation');
  return a;
}

describe('linear dimensions', () => {
  it('aligned point–point distance: extension lines with gap and overshoot, arrows pointing out', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(40, 0);
    const a = annotate(b.entities, dim(b, { kind: 'distance', a: p, b: q }, [20, 10]));
    expect(a.kind).toBe('linear');
    expect(a.arrowsOutside).toBe(false);
    expect(a.extensions).toHaveLength(2);
    close(a.extensions[0]?.[0] as Vec2, [0, 1]);
    close(a.extensions[0]?.[1] as Vec2, [0, 11.5]);
    close(a.extensions[1]?.[0] as Vec2, [40, 1]);
    expect(a.lines).toHaveLength(1);
    close(a.lines[0]?.[0] as Vec2, [0, 10]);
    close(a.lines[0]?.[1] as Vec2, [40, 10]);
    close(a.arrows[0]?.tip as Vec2, [0, 10]);
    close(a.arrows[0]?.dir as Vec2, [-1, 0]);
    close(a.arrows[1]?.dir as Vec2, [1, 0]);
    close(a.text.at, [20, 10]);
    close(a.text.dir, [1, 0]);
  });

  it('arrows flip outside when the text does not fit between them', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(6, 0);
    const a = annotate(b.entities, dim(b, { kind: 'distance', a: p, b: q }, [3, 5]));
    expect(a.arrowsOutside).toBe(true);
    // Tips at the same ends, pointing in, with stubs outside.
    close(a.arrows[0]?.tip as Vec2, [0, 5]);
    close(a.arrows[0]?.dir as Vec2, [1, 0]);
    close(a.arrows[1]?.tip as Vec2, [6, 5]);
    close(a.arrows[1]?.dir as Vec2, [-1, 0]);
    expect(a.lines).toHaveLength(3);
    close(a.lines[1]?.[0] as Vec2, [-5, 5]);
    close(a.lines[2]?.[1] as Vec2, [11, 5]);
  });

  it('a label beyond the extension lines pulls the dimension line out to it', () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [30, 0]);
    const a = annotate(b.entities, dim(b, { kind: 'length', line: l.line }, [45, -6]));
    expect(a.arrowsOutside).toBe(true);
    const far = a.lines.map((s) => Math.max(s[0][0], s[1][0]));
    expect(Math.max(...far)).toBeGreaterThanOrEqual(45);
    close(a.lines[0]?.[0] as Vec2, [0, -6]);
  });

  it('horizontal and vertical distances are axis-parallel', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(30, 12);
    const h = annotate(b.entities, dim(b, { kind: 'hDistance', a: p, b: q }, [15, 20]));
    close(h.lines[0]?.[0] as Vec2, [0, 20]);
    close(h.lines[0]?.[1] as Vec2, [30, 20]);
    close(h.extensions[0]?.[0] as Vec2, [0, 1]);
    close(h.extensions[1]?.[0] as Vec2, [30, 13]);
    const v = annotate(b.entities, dim(b, { kind: 'vDistance', a: p, b: q }, [40, 6]));
    close(v.lines[0]?.[0] as Vec2, [40, 0]);
    close(v.lines[0]?.[1] as Vec2, [40, 12]);
    close(v.text.dir, [0, 1]);
  });

  it('point to line and line to line: across the line, extensions from the nearest geometry', () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [20, 0]);
    const p = b.point(10, 15);
    const a = annotate(b.entities, dim(b, { kind: 'distance', a: p, b: l.line }, [30, 7]));
    // Dimension line vertical at x = 30, from y = 15 (the point) to y = 0 (the line).
    const ends = [a.lines[0]?.[0], a.lines[0]?.[1]] as Vec2[];
    expect(ends.map((e) => e[0])).toEqual([30, 30]);
    expect(ends.map((e) => e[1]).sort((x, y) => x - y)).toEqual([0, 15]);
    // The line's extension starts at its nearest end (20, 0) + gap.
    expect(
      a.extensions.some((e) => Math.abs(e[0][0] - 21) < 1e-9 && Math.abs(e[0][1]) < 1e-9),
    ).toBe(true);
    const m = b.segment([0, 10], [20, 10]);
    const ll = annotate(b.entities, dim(b, { kind: 'distance', a: l.line, b: m.line }, [10, 5]));
    expect(ll.extensions).toHaveLength(0); // label between the lines' extents
    close(ll.lines[0]?.[0] as Vec2, [10, 0]);
    close(ll.lines[0]?.[1] as Vec2, [10, 10]);
  });

  it('to the origin and an axis', () => {
    const b = new SketchBuilder();
    const p = b.point(12, 9);
    const a = annotate(b.entities, dim(b, { kind: 'distance', a: p, b: '@x' }, [20, 4]));
    expect(a.lines[0]?.[0][1]).toBeCloseTo(9, 9);
    expect(a.lines[0]?.[1][1]).toBeCloseTo(0, 9);
    const o = annotate(b.entities, dim(b, { kind: 'hDistance', a: '@origin', b: p }, [6, -5]));
    close(o.lines[0]?.[0] as Vec2, [0, -5]);
  });

  it('line offsets measure across the pair', () => {
    const b = new SketchBuilder();
    const s = b.segment([0, 0], [20, 0]);
    const t = b.segment([0, -5], [20, -5]);
    const a = annotate(
      b.entities,
      dim(b, { kind: 'offset', sources: [s.line], targets: [t.line] }, [25, -2]),
    );
    expect(a.kind).toBe('linear');
    expect(a.lines[0]?.[0][0]).toBeCloseTo(25, 9);
    expect(Math.abs((a.lines[0]?.[0][1] as number) - (a.lines[0]?.[1][1] as number))).toBeCloseTo(
      5,
      9,
    );
    expect(a.arrowsOutside).toBe(true); // 5 mm can't hold 8 mm of text
  });
});

describe('radial dimensions', () => {
  it('radius: a leader along the line through the centre, arrow at the curve', () => {
    const b = new SketchBuilder();
    const c = b.circle(b.point(0, 0), 10);
    const out = annotate(b.entities, dim(b, { kind: 'radius', curve: c }, [20, 0]));
    expect(out.kind).toBe('radial');
    close(out.lines[0]?.[0] as Vec2, [20, 0]);
    close(out.lines[0]?.[1] as Vec2, [10, 0]);
    close(out.arrows[0]?.tip as Vec2, [10, 0]);
    close(out.arrows[0]?.dir as Vec2, [-1, 0]);
    const inside = annotate(b.entities, dim(b, { kind: 'radius', curve: c }, [0, 5]));
    close(inside.lines[0]?.[0] as Vec2, [0, 0]);
    close(inside.arrows[0]?.tip as Vec2, [0, 10]);
    close(inside.arrows[0]?.dir as Vec2, [0, 1]);
  });

  it('diameter: across the circle; arrows outside on a small circle', () => {
    const b = new SketchBuilder();
    const c = b.circle(b.point(0, 0), 10);
    const a = annotate(b.entities, dim(b, { kind: 'diameter', curve: c }, [3, 0]));
    expect(a.arrowsOutside).toBe(false);
    close(a.lines[0]?.[0] as Vec2, [-10, 0]);
    close(a.lines[0]?.[1] as Vec2, [10, 0]);
    const small = b.circle(b.point(50, 0), 3);
    const s = annotate(b.entities, dim(b, { kind: 'diameter', curve: small }, [51, 0]));
    expect(s.arrowsOutside).toBe(true);
    close(s.arrows[0]?.dir as Vec2, [-1, 0]);
  });

  it('an arc gets an extension arc when the leader leaves its sweep', () => {
    const b = new SketchBuilder();
    const a = b.arc(b.point(0, 0), b.point(10, 0), b.point(0, 10)); // 0° → 90°
    const ann = annotate(b.entities, dim(b, { kind: 'radius', curve: a }, [-15, 2]));
    expect(ann.arcs).toHaveLength(1);
    expect(ann.arcs[0]?.start).toBeCloseTo(Math.PI / 2, 9);
    expect(ann.arcs[0]?.sweep).toBeCloseTo(Math.atan2(2, -15) - Math.PI / 2, 9);
    const within = annotate(b.entities, dim(b, { kind: 'radius', curve: a }, [12, 12]));
    expect(within.arcs).toHaveLength(0);
  });

  it('an ellipse: the major radius along its major axis', () => {
    const b = new SketchBuilder();
    const e = b.ellipse(b.point(0, 0), 10, 4, Math.PI / 2);
    const ann = annotate(b.entities, dim(b, { kind: 'radius', curve: e }, [3, 15]));
    close(ann.arrows[0]?.tip as Vec2, [0, 10]);
    close(ann.text.at, [3, 15]);
  });
});

describe('angle dimensions', () => {
  it('an arc between the lines at the label radius', () => {
    const b = new SketchBuilder();
    const l1 = b.segment([0, 0], [30, 0]);
    const l2 = b.segment([0, 0], [30, 30]);
    const ann = annotate(
      b.entities,
      dim(b, { kind: 'angle', a: l1.line, b: l2.line }, [18, 8]),
      Math.PI / 4,
    );
    expect(ann.kind).toBe('angular');
    const arc = ann.arcs[0];
    expect(arc?.radius).toBeCloseTo(Math.hypot(18, 8), 9);
    expect(arc?.start).toBeCloseTo(0, 9);
    expect(arc?.sweep).toBeCloseTo(Math.PI / 4, 9);
    expect(ann.extensions).toHaveLength(0);
    expect(ann.arrowsOutside).toBe(false);
  });

  it('extension lines when the arc is beyond the lines; arrows outside on a small angle', () => {
    const b = new SketchBuilder();
    const l1 = b.segment([0, 0], [10, 0]);
    const l2 = b.segment([0, 0], [10, 1]);
    const v = Math.atan2(1, 10);
    const ann = annotate(
      b.entities,
      dim(b, { kind: 'angle', a: l1.line, b: l2.line }, [30, 1.5]),
      v,
    );
    expect(ann.extensions).toHaveLength(2);
    expect(ann.extensions[0]?.[0][0]).toBeCloseTo(11, 9); // from the line end + gap
    expect(ann.arrowsOutside).toBe(true);
    expect(ann.lines).toHaveLength(2);
  });

  it('a label in the vertical sector shows the same angle there; outside, an extension arc', () => {
    const b = new SketchBuilder();
    const l1 = b.segment([-20, 0], [20, 0]);
    const l2 = b.segment([-20, -20], [20, 20]);
    const v = Math.PI / 4;
    const opposite = annotate(
      b.entities,
      dim(b, { kind: 'angle', a: l1.line, b: l2.line }, [-12, -4]),
      v,
    );
    expect(opposite.arcs[0]?.start).toBeCloseTo(Math.PI, 9);
    expect(opposite.arcs).toHaveLength(1);
    const beside = annotate(
      b.entities,
      dim(b, { kind: 'angle', a: l1.line, b: l2.line }, [0, 12]),
      v,
    );
    expect(beside.arcs).toHaveLength(2);
  });
});

describe('labels', () => {
  it('without a label, a placement next to the geometry', () => {
    const b = new SketchBuilder();
    const l = b.segment([0, 0], [30, 0]);
    const a = annotate(b.entities, dim(b, { kind: 'length', line: l.line }));
    close(a.text.at, [15, 8]);
  });

  it('dragging an h/v distance keeps its text on the side it was dragged to', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const q = b.point(30, 12);
    const h = dim(b, { kind: 'hDistance', a: p, b: q });
    // Dragged into the points' vertical span: pushed out above (or below) them.
    expect(dragDimensionLabel(b.entities, h, [15, 9])).toEqual([15, 15]);
    expect(dragDimensionLabel(b.entities, h, [15, 3])).toEqual([15, -3]);
    expect(dragDimensionLabel(b.entities, h, [15, 40])).toEqual([15, 40]);
    const v = dim(b, { kind: 'vDistance', a: p, b: q });
    expect(dragDimensionLabel(b.entities, v, [20, 5])).toEqual([33, 5]);
    // Other kinds: the label goes where it is dragged.
    expect(
      dragDimensionLabel(b.entities, dim(b, { kind: 'distance', a: p, b: q }), [1, 2]),
    ).toEqual([1, 2]);
  });
});
