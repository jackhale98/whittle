/**
 * Unit tests (no kernel) for the M3 geometry helpers: reference-geometry frames, the probes that
 * recover circles / cylinder axes / sphere centres from exact closest-point measurements, sweep
 * path chaining, linked-entity projection and re-projection, and the resolver's rule for pattern
 * instances.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  Frame,
  Measurement,
  Result,
  ShapeFingerprints,
  SketchEntity,
  Vec3,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import type { MeasureSubject } from '../../src/kernel-api';
import { chainOrder } from '../../src/regen/chain';
import {
  anglePlane,
  canonicalDir,
  edgeCircle,
  edgeLine,
  faceAxis,
  type GeoQuery,
  isGeoError,
  lineFrame,
  lineLineIntersection,
  midPlane,
  planesIntersection,
  planeThroughPoints,
  rotateAbout,
  sphereCentre,
} from '../../src/regen/datums';
import { ORIGIN_PLANES } from '../../src/regen/geometry';
import {
  type LinkedCurve,
  projectCircle,
  projectPlaneTrace,
  projectSketchEntity,
  reprojectLinkedFallback,
} from '../../src/regen/linked';
import { isOtherCopy, resolveRef } from '../../src/regen/resolve';

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3) => mul(a, 1 / len(a));

const close = (a: Vec3 | undefined, b: Vec3, digits = 9) => {
  expect(a).toBeDefined();
  for (let i = 0; i < 3; i++) expect((a as Vec3)[i]).toBeCloseTo(b[i] as number, digits);
};

/** An orthonormal basis (u, v) of the plane normal to `n`. */
function basis(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, a));
  return [u, cross(n, u)];
}

/** Closest point on an arc (angles 0…sweep in basis u, v about centre c). */
function closestOnArc(p: Vec3, c: Vec3, n: Vec3, r: number, sweep: number): Vec3 {
  const [u, v] = basis(n);
  const d = sub(p, c);
  let a = Math.atan2(dot(d, v), dot(d, u));
  if (a < 0) a += 2 * Math.PI;
  if (a > sweep) a = a - sweep < 2 * Math.PI - a ? sweep : 0;
  return add(c, add(mul(u, r * Math.cos(a)), mul(v, r * Math.sin(a))));
}

/**
 * A synthetic shape 1: edge 0 a circle or arc, face 0 a cylinder (axis o + t·d, t ∈ [0, h],
 * angular sweep), face 1 a sphere, edge 1 a straight segment.
 */
function world(opts: {
  circle: { c: Vec3; n: Vec3; r: number; sweep: number };
  cyl: { o: Vec3; d: Vec3; r: number; h: number; sweep: number };
  sphere: { c: Vec3; r: number };
  segment: [Vec3, Vec3];
}): GeoQuery {
  const { circle, cyl, sphere, segment } = opts;
  const arcCentroid = () => {
    const [u, v] = basis(circle.n);
    const s = circle.sweep;
    if (Math.abs(s - 2 * Math.PI) < 1e-12) return circle.c;
    const k = (circle.r * 2 * Math.sin(s / 2)) / s;
    return add(circle.c, add(mul(u, k * Math.cos(s / 2)), mul(v, k * Math.sin(s / 2))));
  };
  const fp: ShapeFingerprints = {
    faces: [
      {
        centroid: add(cyl.o, mul(cyl.d, cyl.h / 2)),
        area: cyl.sweep * cyl.r * cyl.h,
        surface: 'cylinder',
      },
      { centroid: sphere.c, area: 4 * Math.PI * sphere.r ** 2, surface: 'sphere' },
    ],
    edges: [
      { centroid: arcCentroid(), length: circle.r * circle.sweep, curve: 'circle' },
      {
        centroid: mul(add(segment[0], segment[1]), 0.5),
        length: len(sub(segment[1], segment[0])),
        curve: 'line',
      },
    ],
    vertices: [],
  };
  const closest = (s: MeasureSubject, p: Vec3): Vec3 => {
    if ('point' in s) return s.point;
    if (s.kind === 'edge' && s.index === 0) {
      return closestOnArc(p, circle.c, circle.n, circle.r, circle.sweep);
    }
    if (s.kind === 'edge') {
      const [a, b] = segment;
      const ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
      return add(a, mul(ab, t));
    }
    if (s.kind === 'face' && s.index === 0) {
      const t = dot(sub(p, cyl.o), cyl.d);
      const tc = Math.max(0, Math.min(cyl.h, t));
      const axisPt = add(cyl.o, mul(cyl.d, t));
      return add(closestOnArc(p, axisPt, cyl.d, cyl.r, cyl.sweep), mul(cyl.d, tc - t));
    }
    return add(sphere.c, mul(unit(sub(p, sphere.c)), sphere.r));
  };
  return {
    fingerprints: async () => fp,
    measure: async (a, b): Promise<Result<Measurement>> => {
      if (!b) {
        if ('point' in a) return { ok: true, value: {} };
        if (a.kind === 'edge' && a.index === 0) return { ok: true, value: { radius: circle.r } };
        if (a.kind === 'face') {
          return { ok: true, value: { radius: a.index === 0 ? cyl.r : sphere.r } };
        }
        return { ok: true, value: {} };
      }
      const q = (b as { point: Vec3 }).point;
      const s = closest(a, q);
      return { ok: true, value: { distance: { value: len(sub(q, s)), a: s, b: q } } };
    },
  };
}

const tilt = unit([1, 1, 1]);
const base = {
  circle: { c: [3, -2, 7] as Vec3, n: tilt, r: 4, sweep: 2 * Math.PI },
  cyl: { o: [5, 0, 0] as Vec3, d: tilt, r: 2.5, h: 30, sweep: 2 * Math.PI },
  sphere: { c: [-4, 2, 9] as Vec3, r: 6 },
  segment: [
    [10, 0, 0],
    [0, 0, 5],
  ] as [Vec3, Vec3],
};

describe('geometry probes (exact closest points)', () => {
  it('circle edge: centre, canonical normal, radius; arcs too', async () => {
    const full = await edgeCircle(world(base), 1, 0);
    close(full?.centre, [3, -2, 7]);
    close(full?.normal, tilt);
    expect(full?.radius).toBe(4);
    expect(full?.full).toBe(true);
    const arc = await edgeCircle(
      world({ ...base, circle: { ...base.circle, n: mul(tilt, -1), sweep: Math.PI / 2 } }),
      1,
      0,
    );
    close(arc?.centre, [3, -2, 7]);
    close(arc?.normal, tilt); // canonical sense, whatever the edge's own
    expect(arc?.full).toBe(false);
  });

  it('cylinder axis from a full face and from a half face', async () => {
    for (const sweep of [2 * Math.PI, Math.PI]) {
      const a = await faceAxis(world({ ...base, cyl: { ...base.cyl, sweep } }), 1, 0);
      expect(a, `sweep ${sweep}`).not.toBeNull();
      close(a?.dir, tilt);
      // The axis passes through (5, 0, 0): its distance to the returned line is 0.
      const o = a?.origin as Vec3;
      const off = sub([5, 0, 0], o);
      expect(len(sub(off, mul(tilt, dot(off, tilt))))).toBeLessThan(1e-9);
      expect(a?.radius).toBe(2.5);
    }
  });

  it('sphere centre and straight edges (end points by geometric key)', async () => {
    close((await sphereCentre(world(base), 1, 1)) ?? undefined, [-4, 2, 9]);
    const l = await edgeLine(world(base), 1, 1);
    close(l?.a, [0, 0, 5]);
    close(l?.b, [10, 0, 0]);
  });
});

describe('reference geometry frames', () => {
  it('three points, angle, midplane, two-plane axes, line intersections', () => {
    const p = planeThroughPoints([0, 0, 5], [1, 0, 5], [0, 1, 5]);
    expect(isGeoError(p)).toBe(false);
    if (!isGeoError(p)) {
      close(p.z, [0, 0, 1]);
      close(p.origin, [0, 0, 5]);
    }
    expect(planeThroughPoints([0, 0, 0], [1, 1, 1], [2, 2, 2])).toEqual({
      error: 'The three points lie on one line',
    });
    const xy = ORIGIN_PLANES['origin:XY'] as Frame;
    expect(anglePlane(xy, { origin: [0, 0, 0], dir: [0, 0, 1] }, 1)).toEqual({
      error: 'The axis must be parallel to the reference plane',
    });
    const yz = ORIGIN_PLANES['origin:YZ'] as Frame;
    expect(midPlane(xy, yz)).toEqual({ error: 'The two planes are not parallel' });
    const line = planesIntersection(xy, yz);
    expect(isGeoError(line)).toBe(false);
    if (!isGeoError(line)) close(line.dir, [0, 1, 0]);
    expect(
      lineLineIntersection(
        { origin: [0, 0, 0], dir: [1, 0, 0] },
        { origin: [0, 0, 1], dir: [0, 1, 0] },
        1e-6,
      ),
    ).toEqual({ error: 'The two lines do not meet' });
    close(rotateAbout([0, 0, 1], [1, 0, 0], Math.PI / 2), [0, -1, 0]);
    close(canonicalDir([0, -2, 0]), [0, 1, 0]);
    const f = lineFrame({ origin: [5, 5, 3], dir: [0, 0, 1] });
    close(f.origin, [5, 5, 0]);
  });
});

describe('sweep path chaining', () => {
  const P = (x: number, y = 0): Vec3 => [x, y, 0];
  it('orders a scrambled open chain from its first edge when that is an end', () => {
    expect(
      chainOrder(
        [
          [P(0), P(1)],
          [P(2), P(3)],
          [P(1), P(2)],
        ],
        1e-6,
      ),
    ).toEqual({
      ok: true,
      order: [0, 2, 1],
    });
    // First edge in the middle: start at the end with the smaller key.
    expect(
      chainOrder(
        [
          [P(1), P(2)],
          [P(2), P(3)],
          [P(0), P(1)],
        ],
        1e-6,
      ),
    ).toEqual({
      ok: true,
      order: [2, 0, 1],
    });
  });

  it('closed loops, branches, gaps and closed curves', () => {
    const loop = chainOrder(
      [
        [P(0), P(1)],
        [P(1, 1), P(0, 1)],
        [P(1), P(1, 1)],
        [P(0, 1), P(0)],
      ],
      1e-6,
    );
    expect(loop).toEqual({ ok: true, order: [0, 2, 1, 3] });
    expect(
      chainOrder(
        [
          [P(0), P(1)],
          [P(1), P(2)],
          [P(1), P(1, 1)],
        ],
        1e-6,
      ),
    ).toMatchObject({
      ok: false,
      message: 'The sweep path branches; select one chain of edges',
    });
    expect(
      chainOrder(
        [
          [P(0), P(1)],
          [P(2), P(3)],
        ],
        1e-6,
      ),
    ).toMatchObject({ ok: false });
    expect(chainOrder([[P(0)], [P(1), P(2)]], 1e-6)).toMatchObject({ ok: false });
    expect(chainOrder([[]], 1e-6)).toEqual({ ok: true, order: [0] });
  });
});

describe('linked entities: projection and fallback re-projection', () => {
  const xy = ORIGIN_PLANES['origin:XY'] as Frame;

  it('planes parallel to the sketch and tilted circles are not projected (errors)', () => {
    expect(projectPlaneTrace(xy, { origin: [0, 0, 5], z: [0, 0, 1], x: [1, 0, 0] })).toMatchObject({
      error: expect.stringMatching(/parallel to the sketch/),
    });
    expect(projectCircle(xy, { centre: [0, 0, 0], normal: tilt, radius: 1 })).toMatchObject({
      error: expect.stringMatching(/not parallel/),
    });
  });

  it('an arc from another sketch keeps its CCW sense in this sketch', () => {
    // A sketch on a plane facing down (−Z): its CCW arcs are clockwise seen from +Z.
    const down: Frame = { origin: [0, 0, 3], z: [0, 0, -1], x: [1, 0, 0] };
    const pts = new Map<string, [number, number]>([
      ['c', [0, 0]],
      ['s', [1, 0]],
      ['e', [0, 1]],
    ]);
    const arc: SketchEntity = {
      id: 'a',
      kind: 'arc',
      center: 'c',
      start: 's',
      end: 'e',
      construction: false,
    };
    const c = projectSketchEntity(xy, down, arc, pts) as Extract<LinkedCurve, { kind: 'arc' }>;
    expect(c.kind).toBe('arc');
    // In world, (0,1) of the down frame is y = −1: the arc runs from (0,−1) CCW to (1,0).
    expect(c.start[0]).toBeCloseTo(0, 12);
    expect(c.start[1]).toBeCloseTo(-1, 12);
    expect(c.end[0]).toBeCloseTo(1, 12);
  });

  const pt = (id: string, x: number, y: number): SketchEntity => ({
    id,
    kind: 'point',
    x,
    y,
    construction: false,
  });
  const src: EntityRef = { name: 'F1:edge(x)', kind: 'edge' };

  it('moves circles, arcs, polyline chains and infinite lines; mismatches are lost', () => {
    const ents: SketchEntity[] = [
      pt('c', 0, 0),
      {
        id: 'k',
        kind: 'circle',
        center: 'c',
        radius: 1,
        construction: false,
        source: { ref: src },
      },
      pt('p0', 0, 0),
      pt('p1', 1, 0),
      pt('p2', 2, 0),
      {
        id: 'l1',
        kind: 'line',
        start: 'p0',
        end: 'p1',
        construction: false,
        source: { ref: { ...src, name: 'F1:face' } },
      },
      {
        id: 'l2',
        kind: 'line',
        start: 'p1',
        end: 'p2',
        construction: false,
        source: { ref: { ...src, name: 'F1:face' } },
      },
      pt('q0', 3, 7),
      pt('q1', 9, 8),
      {
        id: 'ax',
        kind: 'line',
        start: 'q0',
        end: 'q1',
        construction: true,
        source: { ref: { name: 'origin:X', kind: 'edge' } },
      },
    ];
    const r = reprojectLinkedFallback(ents, [
      { ref: src, entities: ['k'], curves: [{ kind: 'circle', c: [5, 5], r: 2 }] },
      {
        ref: { ...src, name: 'F1:face' },
        entities: ['l1', 'l2'],
        curves: [
          {
            kind: 'polyline',
            points: [
              [0, 1],
              [4, 1],
              [4, 5],
            ],
          },
        ],
      },
      {
        ref: { name: 'origin:X', kind: 'edge' },
        entities: ['ax'],
        curves: [{ kind: 'line', a: [0, 0], b: [1, 0], infinite: true }],
      },
    ]);
    expect(r.lost).toEqual([]);
    const by = Object.fromEntries(r.entities.map((e) => [e.id, e]));
    expect(by.c).toMatchObject({ x: 5, y: 5 });
    expect(by.k).toMatchObject({ radius: 2 });
    expect(by.p0).toMatchObject({ x: 0, y: 1 });
    expect(by.p1).toMatchObject({ x: 4, y: 1 });
    expect(by.p2).toMatchObject({ x: 4, y: 5 });
    expect(by.q0).toMatchObject({ x: 3, y: 0 });
    expect(by.q1).toMatchObject({ x: 9, y: 0 });
    // The input is not mutated.
    expect(ents[0]).toMatchObject({ x: 0, y: 0 });

    const lost = reprojectLinkedFallback(ents, [
      { ref: src, entities: ['k'], curves: [{ kind: 'line', a: [0, 0], b: [1, 0] }] },
    ]);
    expect(lost.lost).toEqual([
      { entity: 'k', reason: 'A linked circle cannot follow a source that is now a line' },
    ]);
  });
});

describe('pattern instances are never confused (resolver)', () => {
  it('isOtherCopy', () => {
    expect(isOtherCopy('F9:inst2(F3:hole(S1:p(a)):wall)', 'F9:inst1(F3:hole(S1:p(a)):wall)')).toBe(
      true,
    );
    expect(isOtherCopy('F3:hole(S1:p(a)):wall', 'F9:inst1(F3:hole(S1:p(a)):wall)')).toBe(true);
    expect(isOtherCopy('F3:end', 'F7:mirror(F3:end)')).toBe(true);
    expect(isOtherCopy('F9:inst2(F3:end)', 'F9:inst2(F3:end)')).toBe(false);
    expect(isOtherCopy('F3:end', 'F3:start')).toBe(false);
    expect(isOtherCopy('F9:inst2(F3:end)', 'F9:inst2(F4:end)')).toBe(false);
  });

  it('a ref to a removed instance is not taken over by another instance at its place', async () => {
    const fp: ShapeFingerprints = {
      faces: [{ centroid: [70, 10, 15], area: 50, surface: 'cylinder' }],
      edges: [],
      vertices: [],
    };
    const r = await resolveRef(
      {
        name: 'F9:inst2(F3:wall)',
        kind: 'face',
        fingerprint: { centroid: [70, 10, 15], area: 50 },
      },
      [{ shape: 1, kind: 'face', index: 0, name: 'F9:inst1(F3:wall)', owner: 'B1' }],
      { diag: 100, fingerprints: async () => fp },
    );
    expect(r).toEqual({ ok: false, reason: 'missing' });
    // Other names still resolve by fingerprint (healing an unrelated rename).
    const r2 = await resolveRef(
      { name: 'F9:old', kind: 'face', fingerprint: { centroid: [70, 10, 15], area: 50 } },
      [{ shape: 1, kind: 'face', index: 0, name: 'F9:inst1(F3:wall)', owner: 'B1' }],
      { diag: 100, fingerprints: async () => fp },
    );
    expect(r2).toMatchObject({ ok: true, target: { via: 'fingerprint' } });
  });
});
