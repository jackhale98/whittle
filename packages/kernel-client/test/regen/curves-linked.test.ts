/**
 * M3.5 curves through the regen engine without the kernel: other sketches' ellipses, elliptic
 * arcs and splines projected exactly onto a sketch (parallel planes; splines on any plane by
 * affine invariance), linked entities of those kinds following their source (and lost when it
 * no longer fits), and the new entity kinds reaching the kernel's sketch builder unchanged —
 * with the identity solver and with real planegcs.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  EntityRef,
  Feature,
  Frame,
  SketchBSpline,
  SketchEllipticArc,
  SketchEntity,
  SketchFeature,
  Vec2,
  Vec3,
} from '@wren-cad/contracts';
import { createSketchSolverCore } from '@wren-cad/sketch/core';
import { describe, expect, it } from 'vitest';
import { evalBSpline, prepareBSpline } from '../../src/regen/curves';
import { RegenEngine } from '../../src/regen/engine';
import { toWorld } from '../../src/regen/geometry';
import {
  type LinkedCurve,
  type LinkedSource,
  projectSketchEntity,
  reprojectLinkedFallback,
} from '../../src/regen/linked';
import { reprojectLinkedSketch } from '../../src/regen/linked-sketch';
import { FakeKernel, identitySolver } from './fake-kernel';
import { fid, makeDoc } from './helpers';

const xy: Frame = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] };
/** A plane 5 above XY facing down, x turned 30° (CCW seen from +Z): a mirrored, rotated view. */
const c30 = Math.cos(Math.PI / 6);
const s30 = Math.sin(Math.PI / 6);
const down: Frame = { origin: [2, 1, 5], z: [0, 0, -1], x: [c30, s30, 0] };
/** Tilted 40° about world X. */
const tilt: Frame = {
  origin: [0, 0, 1],
  z: [0, -Math.sin((40 * Math.PI) / 180), Math.cos((40 * Math.PI) / 180)],
  x: [1, 0, 0],
};

const pts = (o: Record<string, Vec2>) => new Map<string, Vec2>(Object.entries(o));
const near = (a: Vec2, b: Vec2, tol = 1e-12) => {
  expect(Math.abs(a[0] - b[0]), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(a[1] - b[1]), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
};

const ellipse: SketchEntity = {
  id: 'el',
  kind: 'ellipse',
  center: 'c',
  majorRadius: 6,
  minorRadius: 2,
  rotation: 0.3,
  construction: false,
};
const arc: SketchEllipticArc = {
  id: 'ea',
  kind: 'ellipticArc',
  center: 'c',
  start: 's',
  end: 'e',
  majorRadius: 6,
  minorRadius: 2,
  rotation: 0.3,
  construction: false,
};
const spline: SketchBSpline = {
  id: 'sp',
  kind: 'bspline',
  poles: ['p0', 'p1', 'p2', 'p3', 'p4'],
  degree: 3,
  periodic: false,
  weights: [1, 2, 0.5, 1, 1],
  construction: false,
};

/** A point on the ellipse (c, a, b, rot) at parametric angle t, in its sketch's frame. */
const onEllipse = (c: Vec2, t: number): Vec2 => {
  const u = 6 * Math.cos(t);
  const v = 2 * Math.sin(t);
  const cr = Math.cos(0.3);
  const sr = Math.sin(0.3);
  return [c[0] + u * cr - v * sr, c[1] + u * sr + v * cr];
};

describe('projecting other sketches’ M3.5 curves (exact)', () => {
  const C: Vec2 = [1, 2];
  const geo = pts({
    c: C,
    s: onEllipse(C, 0.2),
    e: onEllipse(C, 2.5),
    p0: [0, 0],
    p1: [2, 4],
    p2: [5, -1],
    p3: [8, 3],
    p4: [9, 0],
  });

  it('an ellipse on a parallel (mirrored, rotated) plane stays an ellipse with the same radii', () => {
    const c = projectSketchEntity(xy, down, ellipse, geo) as Extract<
      LinkedCurve,
      { kind: 'ellipse' }
    >;
    expect(c.kind).toBe('ellipse');
    expect([c.majorRadius, c.minorRadius]).toEqual([6, 2]);
    // Every point of the source ellipse, seen from XY, lies on the projected ellipse.
    for (let k = 0; k < 16; k++) {
      const w = toWorld(down, ...onEllipse(C, (k / 16) * 2 * Math.PI));
      const p: Vec2 = [w[0], w[1]];
      const cr = Math.cos(c.rotation);
      const sr = Math.sin(c.rotation);
      const u = (p[0] - c.c[0]) * cr + (p[1] - c.c[1]) * sr;
      const v = -(p[0] - c.c[0]) * sr + (p[1] - c.c[1]) * cr;
      expect(Math.abs((u / 6) ** 2 + (v / 2) ** 2 - 1)).toBeLessThan(1e-12);
    }
  });

  it('an elliptic arc seen from the other side swaps its ends to stay counter-clockwise', () => {
    const same = projectSketchEntity(xy, { ...down, z: [0, 0, 1], x: [1, 0, 0] }, arc, geo);
    const flip = projectSketchEntity(xy, down, arc, geo);
    const sw = (f: Frame, p: Vec2): Vec2 => {
      const w = toWorld(f, ...p);
      return [w[0], w[1]];
    };
    expect(same).toMatchObject({ kind: 'ellipticArc' });
    expect(flip).toMatchObject({ kind: 'ellipticArc' });
    const s1 = same as Extract<LinkedCurve, { kind: 'ellipticArc' }>;
    const f1 = flip as Extract<LinkedCurve, { kind: 'ellipticArc' }>;
    near(s1.start, sw({ ...down, z: [0, 0, 1], x: [1, 0, 0] }, geo.get('s') as Vec2));
    near(f1.start, sw(down, geo.get('e') as Vec2));
    near(f1.end, sw(down, geo.get('s') as Vec2));
  });

  it('an ellipse on a tilted plane is not exact here: the kernel’s approximation is used', () => {
    expect(projectSketchEntity(xy, tilt, ellipse, geo)).toMatchObject({
      error: expect.stringMatching(/not parallel/),
    });
  });

  it('a rational spline projects exactly onto a tilted plane (affine invariance)', () => {
    const c = projectSketchEntity(xy, tilt, spline, geo) as Extract<
      LinkedCurve,
      { kind: 'bspline' }
    >;
    expect(c.kind).toBe('bspline');
    expect(c.weights).toEqual(spline.weights);
    expect(c.degree).toBe(3);
    const src = prepareBSpline(
      spline,
      spline.poles.map((id) => geo.get(id) as Vec2),
    );
    const dst = prepareBSpline(c, c.poles);
    if (typeof src === 'string' || typeof dst === 'string') throw new Error('invalid');
    for (let k = 0; k <= 30; k++) {
      const t = k / 30;
      const w: Vec3 = toWorld(tilt, ...evalBSpline(src, t));
      // Orthographic projection onto XY drops z.
      near(evalBSpline(dst, t), [w[0], w[1]], 1e-12);
    }
  });

  it('a spline seen edge-on is refused (falls back to the kernel)', () => {
    const edgeOn: Frame = { origin: [0, 0, 0], z: [0, 1, 0], x: [1, 0, 0] };
    expect(projectSketchEntity(xy, edgeOn, spline, geo)).toMatchObject({
      error: expect.stringMatching(/edge-on/),
    });
  });
});

describe('linked M3.5 entities follow their source (engine fallback re-projection)', () => {
  const ref: EntityRef = { name: 'S01JX:e(sp)', kind: 'edge' };
  const linked = (e: SketchEntity): SketchEntity => ({ ...e, source: { ref } });
  const point = (id: string, x: number, y: number): SketchEntity => ({
    id,
    kind: 'point',
    x,
    y,
    construction: false,
    source: { ref },
  });

  it('ellipse, elliptic arc and spline entities move onto exact projections, same ids', () => {
    const entities: SketchEntity[] = [
      point('c', 0, 0),
      point('s', 1, 0),
      point('e', 0, 1),
      linked(arc),
      ...['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => point(id, 0, 0)),
      linked(spline),
    ];
    const arcCurve: LinkedCurve = {
      kind: 'ellipticArc',
      c: [5, 5],
      majorRadius: 4,
      minorRadius: 3,
      rotation: 1,
      start: [9, 5],
      end: [5, 8],
    };
    const splineCurve: LinkedCurve = {
      kind: 'bspline',
      poles: [
        [0, 0],
        [1, 1],
        [2, 0],
        [3, 1],
        [4, 0],
      ],
      degree: 2,
      periodic: false,
    };
    const sources: LinkedSource[] = [
      { ref, entities: ['c', 's', 'e', 'ea'], curves: [arcCurve] },
      {
        ref: { ...ref, name: 'S01JX:e(sp2)' },
        entities: ['p0', 'p1', 'p2', 'p3', 'p4', 'sp'],
        curves: [splineCurve],
      },
    ];
    // Through the production adapter: these kinds take the engine fallback.
    const r = reprojectLinkedSketch(entities, sources);
    expect(r.lost).toEqual([]);
    const byId = new Map(r.entities.map((e) => [e.id, e]));
    expect(byId.get('ea')).toMatchObject({ majorRadius: 4, minorRadius: 3, rotation: 1 });
    expect(byId.get('s')).toMatchObject({ x: 9, y: 5 });
    expect(byId.get('e')).toMatchObject({ x: 5, y: 8 });
    expect(byId.get('c')).toMatchObject({ x: 5, y: 5 });
    const sp = byId.get('sp') as SketchBSpline;
    expect(sp.degree).toBe(2);
    expect(sp.weights).toBeUndefined();
    expect(['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => byId.get(id))).toMatchObject([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 4, y: 0 },
    ]);
  });

  it('a spline whose source now has another number of poles is lost, never refitted', () => {
    const entities: SketchEntity[] = [
      ...['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => point(id, 0, 0)),
      linked(spline),
    ];
    const r = reprojectLinkedFallback(entities, [
      {
        ref,
        entities: ['p0', 'p1', 'p2', 'p3', 'p4', 'sp'],
        curves: [
          {
            kind: 'bspline',
            poles: [
              [0, 0],
              [1, 1],
              [2, 0],
              [3, 1],
            ],
            degree: 3,
            periodic: false,
          },
        ],
      },
    ]);
    expect(r.lost.map((l) => l.entity).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'sp']);
    expect(r.lost[0]?.reason).toMatch(/4 control points, not 5/);
  });

  it('a linked ellipse whose source became a polyline (approximate) is lost', () => {
    const entities: SketchEntity[] = [point('c', 0, 0), linked(ellipse)];
    const r = reprojectLinkedFallback(entities, [
      {
        ref,
        entities: ['c', 'el'],
        curves: [
          {
            kind: 'polyline',
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
        approximate: true,
      },
    ]);
    expect(r.lost.map((l) => l.entity)).toContain('el');
  });
});

// ---------------------------------------------------------------------------------------------
// Pass-through to the kernel sketch builder
// ---------------------------------------------------------------------------------------------

const PART = fid('CLPART');
const SK = fid('CLS');

function curveSketch(): SketchFeature {
  const entities: SketchEntity[] = [
    { id: 'c', kind: 'point', x: 0, y: 0, construction: false },
    { id: 's', kind: 'point', x: 10, y: 0, construction: false },
    { id: 'e', kind: 'point', x: 0, y: 4, construction: false },
    {
      id: 'ea',
      kind: 'ellipticArc',
      center: 'c',
      start: 's',
      end: 'e',
      majorRadius: 10,
      minorRadius: 4,
      rotation: 0,
      construction: false,
    },
    { id: 'q0', kind: 'point', x: 0, y: 4, construction: false },
    { id: 'q1', kind: 'point', x: -6, y: 8, construction: false },
    { id: 'q2', kind: 'point', x: -9, y: -3, construction: false },
    { id: 'q3', kind: 'point', x: 10, y: 0, construction: false },
    {
      id: 'sp',
      kind: 'bspline',
      poles: ['q0', 'q1', 'q2', 'q3'],
      degree: 3,
      periodic: false,
      weights: [1, 1.5, 0.75, 1],
      knots: [0, 1],
      multiplicities: [4, 4],
      construction: false,
    },
  ];
  return {
    id: SK,
    type: 'sketch',
    name: 'Curves',
    suppressed: false,
    on: { name: 'origin:XY', kind: 'face' },
    entities,
    constraints: [],
  };
}

describe('the new entity kinds reach the kernel sketch builder unchanged', () => {
  for (const [label, solver] of [
    ['identity solver', async () => identitySolver],
    ['planegcs', () => createSketchSolverCore()],
  ] as const) {
    it(`${label}: elliptic arc and weighted spline pass through as stored`, async () => {
      const kernel = new FakeKernel();
      const engine = new RegenEngine({ kernel: kernel.api(), sketchSolver: solver });
      const f = curveSketch();
      const doc = makeDoc({}, [f as Feature], PART);
      const r = await engine.regenerate({ doc, partId: PART, quality: 'coarse' });
      expect(r.features[0]?.state).toBe('ok');
      const call = kernel.callsFor(SK)[0];
      if (!call) throw new Error('the sketch never reached the kernel');
      const sent = (call.feature as SketchFeature).entities;
      for (const id of ['ea', 'sp']) {
        expect(sent.find((e) => e.id === id)).toEqual(f.entities.find((e) => e.id === id));
      }
      for (const id of ['c', 's', 'e', 'q0', 'q1', 'q2', 'q3']) {
        const a = sent.find((e) => e.id === id) as Extract<SketchEntity, { kind: 'point' }>;
        const b = f.entities.find((e) => e.id === id) as Extract<SketchEntity, { kind: 'point' }>;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
      }
      // The display curve is the exact spline (ends at its end poles), not the control polygon.
      const curve = r.sketches[0]?.curves.find((c) => c.entity === 'sp');
      const n = (curve?.points.length ?? 0) / 3;
      expect(n).toBeGreaterThan(4);
      expect(Array.from(curve?.points.slice(0, 3) ?? [])).toEqual([0, 4, 0]);
      expect(Array.from(curve?.points.slice(3 * (n - 1)) ?? [])).toEqual([10, 0, 0]);
    });
  }
});
