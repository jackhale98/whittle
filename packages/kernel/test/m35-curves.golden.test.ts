/**
 * M3.5 golden tests: exact sketch curves (elliptic arcs and B-splines, PLAN M3.5 "Sketch curves",
 * ADR-046). Reference values are computed independently in the test: spline areas by Gauss–Legendre
 * integration of the shoelace integral ½∮(x dy − y dx) over a de Boor evaluation of the spline,
 * revolve volumes by Pappus (2π ∮ x²/2 dy), ellipses analytically.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, SketchEntity, Vec2 } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  ExactProjectedCurve,
  ExactProjectedEdge,
  ProjectedEdge,
  WhittleKernelModule,
} from '../src/index';
import {
  extrude,
  frameAt,
  indexOf,
  line,
  loadVariant,
  names,
  ok,
  profileRefs,
  pt,
  relClose,
  Session,
  sketch,
  sketchInputs,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
  XY,
} from './helpers';

const SK = '01JM35SKETCH00000000000001';
const S = `S${SK}`;
const EX = '01JM35EXTRUDE0000000000001';
const E = `F${EX}`;
const FI = '01JM35FILLET00000000000001';
const PI = Math.PI;
const DEPTH = 10;
/**
 * Ellipses are analytic, so mass properties use BRepGProp's default fixed-order rule (exact for
 * lines and circles, ~4e-9 relative on elliptic boundaries); splines use the adaptive path.
 */
const ELLIPSE_TOL = 2e-8;
/** The adaptive (knot-aware) mass properties: 1e-12 requested, better than 1e-9 achieved. */
const GPROP_TOL = 1e-9;

// ---------------------------------------------------------------------------------------------
// Independent B-spline evaluation (de Boor) and integration
// ---------------------------------------------------------------------------------------------

interface SplineDef {
  poles: Vec2[];
  degree: number;
  periodic: boolean;
  weights?: number[];
  /** Distinct knots + multiplicities; omitted = the contract default. */
  knots?: number[];
  multiplicities?: number[];
}

/** Flat knot vector, poles and weights of an unclamped/clamped evaluation-ready spline. */
function evaluable(s: SplineDef): { t: number[]; P: Vec2[]; W: number[]; lo: number; hi: number } {
  const n = s.poles.length;
  const p = s.degree;
  const W = s.weights ?? s.poles.map(() => 1);
  if (!s.periodic) {
    let knots = s.knots;
    let mults = s.multiplicities;
    if (knots === undefined || mults === undefined) {
      // Contract default: uniform clamped, interior knots i / (n − p).
      const spans = n - p;
      knots = Array.from({ length: spans + 1 }, (_, i) => i / spans);
      mults = knots.map((_, i) => (i === 0 || i === spans ? p + 1 : 1));
    }
    const t: number[] = [];
    knots.forEach((k, i) => {
      for (let m = 0; m < (mults?.[i] ?? 0); m++) t.push(k);
    });
    return { t, P: s.poles, W, lo: knots[0] ?? 0, hi: knots[knots.length - 1] ?? 1 };
  }
  // Uniform periodic (the contract default): knots j / n extended by p on each side, poles
  // wrapped. A cyclic shift of the poles only shifts the parameter, so the image is the same.
  const t = Array.from({ length: n + 2 * p + 1 }, (_, j) => (j - p) / n);
  const P = Array.from({ length: n + p }, (_, j) => s.poles[j % n] as Vec2);
  const Wp = Array.from({ length: n + p }, (_, j) => W[j % n] as number);
  return { t, P, W: Wp, lo: 0, hi: 1 };
}

/** de Boor in homogeneous coordinates: point at u. */
function deBoor(e: ReturnType<typeof evaluable>, p: number, u: number): Vec2 {
  const { t, P, W } = e;
  let k = p;
  while (k < P.length - 1 && u >= (t[k + 1] as number)) k++;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = W[i] as number;
    const q = P[i] as Vec2;
    d.push([q[0] * w, q[1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const a = (u - (t[i] as number)) / ((t[i + p - r + 1] as number) - (t[i] as number));
      const lo = d[j - 1] as [number, number, number];
      const hi = d[j] as [number, number, number];
      d[j] = [
        (1 - a) * lo[0] + a * hi[0],
        (1 - a) * lo[1] + a * hi[1],
        (1 - a) * lo[2] + a * hi[2],
      ];
    }
  }
  const h = d[p] as [number, number, number];
  return [h[0] / h[2], h[1] / h[2]];
}

// 10-point Gauss–Legendre nodes/weights on [−1, 1].
const GL_X = [
  0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845,
  0.9739065285171717,
];
const GL_W = [
  0.2955242247147529, 0.2692667193099963, 0.219086362515982, 0.1494513491505806, 0.0666713443086881,
];

/**
 * ∫ f(C(u), C'(u)) du over the spline, span by span (10-point Gauss on each knot span, with the
 * derivative by a 5-point central difference, error O(h⁴) ≈ 1e-16 relative at h = 1e-4).
 */
function integrate(s: SplineDef, f: (c: Vec2, d: Vec2) => number, sub = 8): number {
  const e = evaluable(s);
  const breaks = [...new Set(e.t.filter((x) => x >= e.lo && x <= e.hi))].sort((a, b) => a - b);
  const h = 1e-4 * (e.hi - e.lo);
  let sum = 0;
  for (let b = 0; b + 1 < breaks.length; b++) {
    const a0 = breaks[b] as number;
    const a1 = breaks[b + 1] as number;
    for (let q = 0; q < sub; q++) {
      const lo = a0 + ((a1 - a0) * q) / sub;
      const hi = a0 + ((a1 - a0) * (q + 1)) / sub;
      const mid = (lo + hi) / 2;
      const half = (hi - lo) / 2;
      for (let g = 0; g < 5; g++) {
        for (const sign of [-1, 1]) {
          const u = mid + sign * half * (GL_X[g] as number);
          // Stay inside the span for the difference stencil (the curve is C∞ inside a span).
          const at = (x: number) => deBoor(e, s.degree, Math.min(a1, Math.max(a0, x)));
          const c = at(u);
          const s2 = Math.min(h, (u - a0) / 2.01, (a1 - u) / 2.01);
          const pm2 = at(u - 2 * s2);
          const pm1 = at(u - s2);
          const pp1 = at(u + s2);
          const pp2 = at(u + 2 * s2);
          const d: Vec2 = [
            (pm2[0] - 8 * pm1[0] + 8 * pp1[0] - pp2[0]) / (12 * s2),
            (pm2[1] - 8 * pm1[1] + 8 * pp1[1] - pp2[1]) / (12 * s2),
          ];
          sum += half * (GL_W[g] as number) * f(c, d);
        }
      }
    }
  }
  return sum;
}

/** Signed shoelace contribution ½∫(x dy − y dx) of a spline. */
const splineShoelace = (s: SplineDef) => integrate(s, (c, d) => 0.5 * (c[0] * d[1] - c[1] * d[0]));
/** Signed shoelace contribution of a straight segment a → b. */
const segShoelace = (a: Vec2, b: Vec2) => 0.5 * (a[0] * b[1] - a[1] * b[0]);
/** Signed shoelace contribution of a parametric curve t0 → t1 (64 Gauss panels; smooth curves). */
function curveShoelace(f: (t: number) => Vec2, t0: number, t1: number, panels = 64): number {
  let sum = 0;
  const h = 1e-5 * Math.abs(t1 - t0);
  for (let q = 0; q < panels; q++) {
    const lo = t0 + ((t1 - t0) * q) / panels;
    const hi = t0 + ((t1 - t0) * (q + 1)) / panels;
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2;
    for (let g = 0; g < 5; g++) {
      for (const sign of [-1, 1]) {
        const t = mid + sign * half * (GL_X[g] as number);
        const c = f(t);
        const a = f(t - h);
        const b = f(t + h);
        const d: Vec2 = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)];
        sum += half * (GL_W[g] as number) * 0.5 * (c[0] * d[1] - c[1] * d[0]);
      }
    }
  }
  return sum;
}
/** Signed ∫ x²/2 dy (Pappus moment about the v axis) of a spline / a segment. */
const splineMoment = (s: SplineDef) => integrate(s, (c, d) => 0.5 * c[0] * c[0] * d[1]);
const segMoment = (a: Vec2, b: Vec2) =>
  ((b[1] - a[1]) * (a[0] * a[0] + a[0] * b[0] + b[0] * b[0])) / 6;

// ---------------------------------------------------------------------------------------------
// Sketch builders
// ---------------------------------------------------------------------------------------------

/** Pole points `${id}p<i>` (the first/last can be renamed to share points) and the spline. */
function spline(
  id: string,
  s: SplineDef,
  shared: { first?: string; last?: string } = {},
): SketchEntity[] {
  const ids = s.poles.map((_, i) =>
    i === 0 && shared.first !== undefined
      ? shared.first
      : i === s.poles.length - 1 && shared.last !== undefined
        ? shared.last
        : `${id}p${i}`,
  );
  const pts = s.poles
    .map((p, i) => ({ p, id: ids[i] as string }))
    .filter(({ id: pid }) => pid !== shared.first && pid !== shared.last)
    .map(({ p, id: pid }) => pt(pid, p[0], p[1]));
  const entity: SketchEntity = {
    id,
    kind: 'bspline',
    poles: ids,
    degree: s.degree,
    periodic: s.periodic,
    construction: false,
    ...(s.weights === undefined ? {} : { weights: s.weights }),
    ...(s.knots === undefined ? {} : { knots: s.knots }),
    ...(s.multiplicities === undefined ? {} : { multiplicities: s.multiplicities }),
  };
  return [...pts, entity];
}

function ellipticArc(
  id: string,
  c: Vec2,
  a: number,
  b: number,
  rotation: number,
  t0: number,
  t1: number,
): { entities: SketchEntity[]; start: Vec2; end: Vec2 } {
  const at = (t: number): Vec2 => {
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    return [
      c[0] + u * Math.cos(rotation) - v * Math.sin(rotation),
      c[1] + u * Math.sin(rotation) + v * Math.cos(rotation),
    ];
  };
  const start = at(t0);
  const end = at(t1);
  return {
    start,
    end,
    entities: [
      pt(`${id}c`, c[0], c[1]),
      pt(`${id}s`, start[0], start[1]),
      pt(`${id}e`, end[0], end[1]),
      {
        id,
        kind: 'ellipticArc',
        center: `${id}c`,
        start: `${id}s`,
        end: `${id}e`,
        majorRadius: a,
        minorRadius: b,
        rotation,
        construction: false,
      },
    ],
  };
}

/** Cubic spline profile: B1 from (0,0) over the top to (40,0), closed by L1 back along y = 0. */
const ARCH: SplineDef = {
  poles: [
    [0, 0],
    [5, 20],
    [20, 30],
    [35, 15],
    [40, 0],
  ],
  degree: 3,
  periodic: false,
};
const archEntities = (): SketchEntity[] => [
  pt('a', 0, 0),
  pt('b', 40, 0),
  ...spline('B1', ARCH, { first: 'a', last: 'b' }),
  line('L1', 'b', 'a'),
];
const ARCH_REGION = `${S}:region(B1,L1)`;

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('M3.5 sketch curves', variant), () => {
    let k: WhittleKernelModule;
    let s: Session;
    let baseline = 0;

    beforeAll(async () => {
      k = await loadVariant(variant);
      baseline = k.liveHandleCount();
    }, 60_000);

    afterEach(() => {
      s?.releaseAll();
      expect(k.liveHandleCount()).toBe(baseline);
    });

    afterAll(() => {
      if (k) expect(k.liveHandleCount()).toBe(baseline);
    });

    const session = () => {
      s = new Session(k);
      return s;
    };

    const sketchAndExtrude = (
      ss: Session,
      entities: SketchEntity[],
      region: string,
      depth = DEPTH,
      plane = XY,
    ) => {
      const sk = ss.exec(sketch(SK, entities), sketchInputs(plane));
      const ex = ss.exec(extrude(EX), {
        values: { '/end/depth': depth },
        refs: profileRefs(sk.shape, [indexOf(sk, region, 'face')]),
      });
      return { sk, ex };
    };

    /** Exact face area (measure: the reported, knot-aware value; fingerprints are matching keys). */
    const faceArea = (shape: number, index: number) =>
      ok<{ area?: number }>(k.measure(JSON.stringify({ a: { shape, kind: 'face', index } })))
        .area ?? 0;

    const project = (shape: number, edges: number[], plane = XY, exact = true) =>
      ok<ExactProjectedEdge[]>(k.projectEdges(JSON.stringify({ shape, edges, plane, exact })));
    const only = (p: ExactProjectedEdge[]): ExactProjectedCurve => {
      const c = p[0]?.curves;
      if (c === undefined || c.length !== 1 || c[0] === undefined)
        throw new Error(`expected one curve, got ${JSON.stringify(c)}`);
      return c[0];
    };

    // -----------------------------------------------------------------------------------------
    // Splines
    // -----------------------------------------------------------------------------------------

    describe('B-spline profiles', () => {
      it('a cubic spline closed by a line extrudes to the integrated area × depth', () => {
        const ss = session();
        const { sk, ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
        const area = Math.abs(splineShoelace(ARCH) + segShoelace([40, 0], [0, 0]));
        expect(area).toBeGreaterThan(500);
        const fpSk = ss.fingerprints(sk.shape);
        relClose(faceArea(sk.shape, indexOf(sk, ARCH_REGION, 'face')), area, 1e-6);
        expect(fpSk.edges[indexOf(sk, `${S}:e(B1)`, 'edge')]?.curve).toBe('bspline');
        expect(names(sk, 'edge').sort()).toEqual([`${S}:e(B1)`, `${S}:e(L1)`]);
        // The spline's end poles are the line's end points: one vertex each.
        expect(names(sk, 'vertex').sort()).toEqual(
          ['B1p1', 'B1p2', 'B1p3', 'a', 'b'].map((p) => `${S}:p(${p})`).sort(),
        );
        const mp = ss.mass(ex.shape);
        relClose(mp.volume, area * DEPTH, 1e-6);
        expect(mp.faceCount).toBe(4);
        expect(names(ex, 'face').sort()).toEqual(
          [`${E}:end`, `${E}:side(${S}:e(B1))`, `${E}:side(${S}:e(L1))`, `${E}:start`].sort(),
        );
        const fp = ss.fingerprints(ex.shape);
        expect(fp.faces[indexOf(ex, `${E}:side(${S}:e(B1))`, 'face')]?.surface).toBe('extrusion');
        const top = indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(B1)))`, 'edge');
        expect(fp.edges[top]?.curve).toBe('bspline');
      });

      it('regenerates byte-identically (naming and fingerprints)', () => {
        const ss = session();
        const run = () => {
          const { sk, ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
          return JSON.stringify([
            sk.naming,
            ss.fingerprints(sk.shape),
            ex.naming,
            ss.fingerprints(ex.shape),
          ]);
        };
        const first = run();
        expect(run()).toBe(first);
      });

      it('explicit knots equal to the default give the same solid; non-uniform knots differ', () => {
        const ss = session();
        const vol = (def: SplineDef) =>
          ss.mass(
            sketchAndExtrude(
              ss,
              [
                pt('a', 0, 0),
                pt('b', 40, 0),
                ...spline('B1', def, { first: 'a', last: 'b' }),
                line('L1', 'b', 'a'),
              ],
              ARCH_REGION,
            ).ex.shape,
          ).volume;
        const base = vol(ARCH);
        relClose(vol({ ...ARCH, knots: [0, 0.5, 1], multiplicities: [4, 1, 4] }), base, 1e-12);
        const skewed: SplineDef = { ...ARCH, knots: [0, 0.2, 1], multiplicities: [4, 1, 4] };
        const v = vol(skewed);
        relClose(v, Math.abs(splineShoelace(skewed)) * DEPTH, 1e-6);
        expect(Math.abs(v - base)).toBeGreaterThan(1);
        // ADR-048: an open spline may give a flat knot vector (n + p + 1 values) instead.
        relClose(vol({ ...ARCH, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1] }), base, 1e-12);
        // Knot values are only relative: [0, 0.5, 1] scaled to [0, 5, 10] is the same curve.
        relClose(vol({ ...ARCH, knots: [0, 5, 10], multiplicities: [4, 1, 4] }), base, 1e-12);
      });

      it('a G1 joint (spline tangent to the lines at shared poles) builds one region', () => {
        const ss = session();
        const bulge: SplineDef = {
          poles: [
            [20, 0],
            [30, 0],
            [40, 10],
            [30, 20],
            [20, 20],
          ],
          degree: 3,
          periodic: false,
        };
        const entities = [
          pt('p0', 0, 0),
          pt('p1', 20, 0),
          pt('p2', 20, 20),
          pt('p3', 0, 20),
          line('L1', 'p0', 'p1'),
          ...spline('B1', bulge, { first: 'p1', last: 'p2' }),
          line('L2', 'p2', 'p3'),
          line('L3', 'p3', 'p0'),
        ];
        const { sk, ex } = sketchAndExtrude(ss, entities, `${S}:region(B1,L1,L2,L3)`);
        // No split pieces at the tangent joints.
        expect(names(sk, 'edge').sort()).toEqual(
          ['B1', 'L1', 'L2', 'L3'].map((e) => `${S}:e(${e})`).sort(),
        );
        expect(sk.regions).toEqual([`${S}:region(B1,L1,L2,L3)`]);
        const area = Math.abs(
          segShoelace([0, 0], [20, 0]) +
            splineShoelace(bulge) +
            segShoelace([20, 20], [0, 20]) +
            segShoelace([0, 20], [0, 0]),
        );
        relClose(ss.mass(ex.shape).volume, area * DEPTH, 1e-6);
        expect(ss.mass(ex.shape).faceCount).toBe(6);
      });

      it('a closed periodic spline is a face on its own', () => {
        const ss = session();
        const hex: SplineDef = {
          poles: Array.from(
            { length: 6 },
            (_, i): Vec2 => [5 + 20 * Math.cos((i * PI) / 3), -3 + 20 * Math.sin((i * PI) / 3)],
          ),
          degree: 3,
          periodic: true,
        };
        const { sk, ex } = sketchAndExtrude(ss, spline('B1', hex), `${S}:region(B1)`);
        expect(sk.regions).toEqual([`${S}:region(B1)`]);
        const area = Math.abs(splineShoelace(hex));
        // A uniform cubic periodic spline on a hexagon: between the inscribed and circumscribed
        // discs of the control hexagon.
        expect(area).toBeGreaterThan(PI * 100);
        expect(area).toBeLessThan(PI * 400);
        relClose(faceArea(sk.shape, indexOf(sk, `${S}:region(B1)`, 'face')), area, 1e-6);
        const mp = ss.mass(ex.shape);
        relClose(mp.volume, area * DEPTH, 1e-6);
        expect(mp.faceCount).toBe(3);
        vecClose(mp.centroid, [5, -3, DEPTH / 2], 1e-6);
        expect(names(ex, 'face')).toContain(`${E}:side(${S}:e(B1))`);
        // ADR-048 parametrisation: the default periodic cubic starts (u = 0, the edge's vertex)
        // at (P0 + 4 P1 + P2) / 6, and its exact projection keeps the poles in order.
        const P = hex.poles;
        const start = [0, 1].map(
          (c) =>
            (((P[0] as Vec2)[c] as number) +
              4 * ((P[1] as Vec2)[c] as number) +
              ((P[2] as Vec2)[c] as number)) /
            6,
        );
        const fpSk = ss.fingerprints(sk.shape);
        const edgeVertex = fpSk.vertices.find(
          (v) => !P.some((q) => Math.hypot(v.point[0] - q[0], v.point[1] - q[1]) < 1e-9),
        );
        vecClose(edgeVertex?.point ?? [], [start[0] ?? 0, start[1] ?? 0, 0], 1e-9);
        const pc = only(project(sk.shape, [indexOf(sk, `${S}:e(B1)`, 'edge')]));
        expect(pc.kind).toBe('bspline');
        if (pc.kind === 'bspline') {
          pc.poles.forEach((q, i) => {
            vecClose([...q, 0], [...(P[i] as Vec2), 0], 1e-9);
          });
          expect(pc.knots).toEqual([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
        }
        // Explicit uniform periodic knots (any scale) are the default's curve.
        const explicit = sketchAndExtrude(
          ss,
          spline('B1', {
            ...hex,
            knots: [0, 1, 2, 3, 4, 5, 6],
            multiplicities: [1, 1, 1, 1, 1, 1, 1],
          }),
          `${S}:region(B1)`,
        );
        relClose(ss.mass(explicit.ex.shape).volume, mp.volume, 1e-12);
      });

      it('a clamped spline closed on its own end pole is a face too', () => {
        const ss = session();
        const loop: SplineDef = {
          poles: [
            [0, 0],
            [30, -10],
            [40, 20],
            [-10, 30],
            [0, 0],
          ],
          degree: 3,
          periodic: false,
        };
        const entities = [pt('o', 0, 0), ...spline('B1', loop, { first: 'o', last: 'o' })];
        const { ex } = sketchAndExtrude(ss, entities, `${S}:region(B1)`);
        relClose(ss.mass(ex.shape).volume, Math.abs(splineShoelace(loop)) * DEPTH, 1e-6);
      });

      it('a rational quadratic spline reproduces a quarter circle exactly', () => {
        const ss = session();
        const r = 15;
        const quarter: SplineDef = {
          poles: [
            [r, 0],
            [r, r],
            [0, r],
          ],
          weights: [1, Math.SQRT1_2, 1],
          degree: 2,
          periodic: false,
        };
        const withSpline = [
          pt('o', 0, 0),
          pt('a', r, 0),
          pt('b', 0, r),
          line('L1', 'o', 'a'),
          ...spline('B1', quarter, { first: 'a', last: 'b' }),
          line('L2', 'b', 'o'),
        ];
        const { sk, ex } = sketchAndExtrude(ss, withSpline, `${S}:region(B1,L1,L2)`);
        const fp = ss.fingerprints(sk.shape);
        expect(fp.edges[indexOf(sk, `${S}:e(B1)`, 'edge')]?.curve).toBe('bspline');
        relClose(fp.edges[indexOf(sk, `${S}:e(B1)`, 'edge')]?.length ?? 0, (PI * r) / 2, 1e-9);
        relClose(
          faceArea(sk.shape, indexOf(sk, `${S}:region(B1,L1,L2)`, 'face')),
          (PI * r * r) / 4,
          GPROP_TOL,
        );
        const vSpline = ss.mass(ex.shape).volume;
        // The same profile with an exact arc.
        const withArc = [
          pt('o', 0, 0),
          pt('a', r, 0),
          pt('b', 0, r),
          line('L1', 'o', 'a'),
          {
            id: 'A1',
            kind: 'arc',
            center: 'o',
            start: 'a',
            end: 'b',
            construction: false,
          } as SketchEntity,
          line('L2', 'b', 'o'),
        ];
        const arc = sketchAndExtrude(ss, withArc, `${S}:region(A1,L1,L2)`);
        relClose(vSpline, ss.mass(arc.ex.shape).volume, GPROP_TOL);
        relClose(vSpline, (PI * r * r * DEPTH) / 4, GPROP_TOL);
        // The spline stays on the circle: its nearest point to the centre is at r, and the
        // exact projection keeps the weights (see 'exact projection').
        const edge = indexOf(sk, `${S}:e(B1)`, 'edge');
        const d = ok<{ distance?: { value: number } }>(
          k.measure(
            JSON.stringify({
              a: { point: [0, 0, 0] },
              b: { shape: sk.shape, kind: 'edge', index: edge },
            }),
          ),
        );
        relClose(d.distance?.value ?? 0, r, 1e-9);
      });

      it('a full rational circle with explicit knots and multiplicities', () => {
        const ss = session();
        const r = 12;
        const w = Math.SQRT1_2;
        const circle9: SplineDef = {
          poles: [
            [r, 0],
            [r, r],
            [0, r],
            [-r, r],
            [-r, 0],
            [-r, -r],
            [0, -r],
            [r, -r],
            [r, 0],
          ],
          weights: [1, w, 1, w, 1, w, 1, w, 1],
          knots: [0, 0.25, 0.5, 0.75, 1],
          multiplicities: [3, 2, 2, 2, 3],
          degree: 2,
          periodic: false,
        };
        const entities = [pt('s', r, 0), ...spline('B1', circle9, { first: 's', last: 's' })];
        const { sk, ex } = sketchAndExtrude(ss, entities, `${S}:region(B1)`);
        relClose(
          ss.fingerprints(sk.shape).edges[indexOf(sk, `${S}:e(B1)`, 'edge')]?.length ?? 0,
          2 * PI * r,
          1e-9,
        );
        relClose(ss.mass(ex.shape).volume, PI * r * r * DEPTH, GPROP_TOL);
      });

      it('revolves a spline profile: volume by Pappus', () => {
        const ss = session();
        // Sketch on XZ (u → world X, v → world Z); revolve about world Z (the sketch's v axis).
        const xz = frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0]);
        const bow: SplineDef = {
          poles: [
            [5, 30],
            [20, 30],
            [30, 15],
            [15, 0],
            [5, 0],
          ],
          degree: 3,
          periodic: false,
        };
        const entities = [
          pt('t', 5, 30),
          pt('b', 5, 0),
          ...spline('B1', bow, { first: 't', last: 'b' }),
          line('L1', 'b', 't'),
        ];
        const sk = ss.exec(sketch(SK, entities), sketchInputs(xz));
        const revolve = (angle: number): [Feature, FeatureInputs] => [
          {
            id: EX,
            type: 'revolve',
            name: 'Revolve',
            suppressed: false,
            profile: [{ name: 'region', kind: 'region' }],
            axis: { name: 'origin:Z', kind: 'edge' },
            angle: String(angle),
            direction: 'normal',
            op: 'new',
          } as Feature,
          {
            values: { '/angle': angle },
            refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(B1,L1)`, 'face')]),
            frames: { axis: frameAt([0, 0, 0], [0, 0, 1], [1, 0, 0]) },
          },
        ];
        const moment = Math.abs(splineMoment(bow) + segMoment([5, 0], [5, 30]));
        const full = ss.exec(...revolve(2 * PI));
        const mFull = ss.mass(full.shape);
        relClose(mFull.volume, 2 * PI * moment, 1e-6);
        expect(mFull.faceCount).toBe(2);
        expect(names(full, 'face').sort()).toEqual(
          [`${E}:side(${S}:e(B1))`, `${E}:side(${S}:e(L1))`].sort(),
        );
        expect(
          ss.fingerprints(full.shape).faces[indexOf(full, `${E}:side(${S}:e(B1))`, 'face')]
            ?.surface,
        ).toBe('revolution');
        const quarter = ss.exec(...revolve(PI / 2));
        const mq = ss.mass(quarter.shape);
        relClose(mq.volume, (PI / 2) * moment, 1e-6);
        expect(mq.faceCount).toBe(4);
      });

      it('fillets the spline-to-line edge of the extruded solid', () => {
        const ss = session();
        const { ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
        const fp = ss.fingerprints(ex.shape);
        const joint = `edge(${E}:side(${S}:e(B1))|${E}:side(${S}:e(L1)))`;
        // Two vertical joints share the face pair; take the one at the origin.
        const candidates = ex.naming.filter((n) => n.kind === 'edge' && n.name.startsWith(joint));
        expect(candidates).toHaveLength(2);
        const atOrigin = candidates.find(
          (n) => Math.abs(fp.edges[n.index]?.centroid[0] ?? 1) < 1e-6,
        );
        expect(atOrigin).toBeDefined();
        const edgeName = atOrigin?.name ?? '';
        const before = ss.mass(ex.shape).volume;
        const fil = ss.exec(
          {
            id: FI,
            type: 'fillet',
            name: 'Fillet',
            suppressed: false,
            edges: [{ name: edgeName, kind: 'edge' }],
            radius: '2',
          },
          {
            values: { '/radius': 2 },
            target: ex.shape,
            refs: { '/edges/0': { shape: ex.shape, kind: 'edge', index: atOrigin?.index ?? -1 } },
          },
        );
        const m = ss.mass(fil.shape);
        expect(m.faceCount).toBe(5);
        expect(m.volume).toBeLessThan(before);
        // The corner (~76°) loses at most a 2 mm × 2 mm × depth sliver.
        expect(before - m.volume).toBeLessThan(4 * DEPTH);
        expect(before - m.volume).toBeGreaterThan(0);
        expect(names(fil, 'face')).toContain(`F${FI}:fillet(${edgeName})`);
        // The top edge along the spline fillets too.
        const top = indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(B1)))`, 'edge');
        const fil2 = ss.exec(
          {
            id: FI,
            type: 'fillet',
            name: 'Fillet',
            suppressed: false,
            edges: [{ name: `edge(${E}:end|${E}:side(${S}:e(B1)))`, kind: 'edge' }],
            radius: '1',
          },
          {
            values: { '/radius': 1 },
            target: ex.shape,
            refs: { '/edges/0': { shape: ex.shape, kind: 'edge', index: top } },
          },
        );
        expect(ss.mass(fil2.shape).faceCount).toBe(5);
        expect(ss.mass(fil2.shape).volume).toBeLessThan(before);
      });
    });

    // -----------------------------------------------------------------------------------------
    // Elliptic arcs
    // -----------------------------------------------------------------------------------------

    describe('elliptic arcs', () => {
      it('a half ellipse closed by its major axis: πab/2 × depth', () => {
        const ss = session();
        const a = 20;
        const b = 8;
        const arc = ellipticArc('A1', [5, 5], a, b, 0.3, 0, PI);
        const entities = [...arc.entities, line('L1', 'A1e', 'A1s')];
        const { sk, ex } = sketchAndExtrude(ss, entities, `${S}:region(A1,L1)`);
        const fp = ss.fingerprints(sk.shape);
        expect(fp.edges[indexOf(sk, `${S}:e(A1)`, 'edge')]?.curve).toBe('ellipse');
        relClose(
          faceArea(sk.shape, indexOf(sk, `${S}:region(A1,L1)`, 'face')),
          (PI * a * b) / 2,
          ELLIPSE_TOL,
        );
        const mp = ss.mass(ex.shape);
        relClose(mp.volume, ((PI * a * b) / 2) * DEPTH, ELLIPSE_TOL);
        expect(mp.faceCount).toBe(4);
        // Counter-clockwise from start (angle 0) to end (angle π): the arc bulges to +minor
        // (rotated by 0.3 rad), so the centroid sits 4b/(3π) along the minor axis.
        const d = (4 * b) / (3 * PI);
        vecClose(mp.centroid, [5 - d * Math.sin(0.3), 5 + d * Math.cos(0.3), DEPTH / 2], 1e-6);
        expect(names(ex, 'face')).toContain(`${E}:side(${S}:e(A1))`);
      });

      it('the other half (π → 2π) and minor > major (swapped axes) agree', () => {
        const ss = session();
        const lower = ellipticArc('A1', [0, 0], 20, 8, 0, PI, 2 * PI);
        const r1 = sketchAndExtrude(
          ss,
          [...lower.entities, line('L1', 'A1e', 'A1s')],
          `${S}:region(A1,L1)`,
        );
        const m1 = ss.mass(r1.ex.shape);
        relClose(m1.volume, 80 * PI * DEPTH, ELLIPSE_TOL);
        expect(m1.centroid[1]).toBeLessThan(0);
        // majorRadius 8 along rotation 0, minorRadius 20: a tall ellipse; the right half.
        const tall = ellipticArc('A1', [0, 0], 8, 20, 0, -PI / 2, PI / 2);
        const r2 = sketchAndExtrude(
          ss,
          [...tall.entities, line('L1', 'A1e', 'A1s')],
          `${S}:region(A1,L1)`,
        );
        const m2 = ss.mass(r2.ex.shape);
        relClose(m2.volume, 80 * PI * DEPTH, ELLIPSE_TOL);
        vecClose(m2.centroid, [(4 * 8) / (3 * PI), 0, DEPTH / 2], 1e-6);
      });

      it('a quarter elliptic arc with two radii lines', () => {
        const ss = session();
        const arc = ellipticArc('A1', [0, 0], 30, 10, -0.5, PI / 2, PI);
        const entities = [...arc.entities, line('L1', 'A1c', 'A1s'), line('L2', 'A1e', 'A1c')];
        const { ex } = sketchAndExtrude(ss, entities, `${S}:region(A1,L1,L2)`);
        relClose(ss.mass(ex.shape).volume, ((PI * 300) / 4) * DEPTH, ELLIPSE_TOL);
      });

      it('a profile bounded by a spline and an elliptic arc', () => {
        const ss = session();
        // Upper half: the arch spline from (0,0) to (40,0); lower: a half ellipse below y = 0.
        const lower = ellipticArc('A1', [20, 0], 20, 6, 0, PI, 2 * PI);
        const entities = [
          ...lower.entities.filter((e) => e.kind !== 'point' || e.id === 'A1c'),
          pt('A1s', 0, 0),
          pt('A1e', 40, 0),
          ...spline('B1', ARCH, { first: 'A1s', last: 'A1e' }),
        ];
        const { ex } = sketchAndExtrude(ss, entities, `${S}:region(A1,B1)`);
        const area = Math.abs(splineShoelace(ARCH)) + (PI * 20 * 6) / 2;
        relClose(ss.mass(ex.shape).volume, area * DEPTH, 1e-6);
      });

      it('one loop of a line, an arc, a spline and an elliptic arc', () => {
        const ss = session();
        // (0,0) → L1 → (30,0) → A1 (centre (30,10), CCW) → (40,10) → B1 → (0,30) → E1 (centre
        // (0,15), major 15 along +y, minor 6, bulging to −x) → (0,0).
        const ell = ellipticArc('E1', [0, 15], 15, 6, PI / 2, 0, PI);
        const bow: SplineDef = {
          poles: [
            [40, 10],
            [40, 25],
            [20, 35],
            [0, 30],
          ],
          degree: 3,
          periodic: false,
        };
        const entities: SketchEntity[] = [
          pt('P0', 0, 0),
          pt('P1', 30, 0),
          pt('P2', 40, 10),
          pt('P3', 0, 30),
          pt('Ac', 30, 10),
          pt('E1c', 0, 15),
          line('L1', 'P0', 'P1'),
          { id: 'A1', kind: 'arc', center: 'Ac', start: 'P1', end: 'P2', construction: false },
          ...spline('B1', bow, { first: 'P2', last: 'P3' }),
          ...ell.entities
            .filter((e) => e.kind !== 'point')
            .map((e) => ({ ...e, start: 'P3', end: 'P0' }) as SketchEntity),
        ];
        const { sk, ex } = sketchAndExtrude(ss, entities, `${S}:region(A1,B1,E1,L1)`);
        expect(sk.regions).toEqual([`${S}:region(A1,B1,E1,L1)`]);
        const arcPt = (t: number): Vec2 => [30 + 10 * Math.cos(t), 10 + 10 * Math.sin(t)];
        const ellPt = (t: number): Vec2 => [-6 * Math.sin(t), 15 + 15 * Math.cos(t)];
        const area =
          segShoelace([0, 0], [30, 0]) +
          curveShoelace(arcPt, -PI / 2, 0) +
          splineShoelace(bow) +
          curveShoelace(ellPt, 0, PI);
        expect(area).toBeGreaterThan(0); // counter-clockwise
        const m = ss.mass(ex.shape);
        relClose(m.volume, area * DEPTH, 1e-6);
        expect(m.faceCount).toBe(6);
        expect(
          names(ex, 'face')
            .filter((n) => n.includes(':side('))
            .sort(),
        ).toEqual(['A1', 'B1', 'E1', 'L1'].map((id) => `${E}:side(${S}:e(${id}))`).sort());
      });
    });

    // -----------------------------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------------------------

    describe('invalid curves are structured INVALID_INPUT errors naming the entity', () => {
      const failSpline = (
        patch: Partial<SplineDef> & Record<string, unknown>,
        poles = ARCH.poles,
      ) => {
        const ss = session();
        const def = { ...ARCH, poles, ...patch } as SplineDef;
        const ents = spline('B1', def).map((e) =>
          e.kind === 'bspline' ? ({ ...e, ...patch } as SketchEntity) : e,
        );
        return ss.fail(sketch(SK, ents), sketchInputs());
      };
      const expectBad = (e: ReturnType<typeof failSpline>, text: RegExp) => {
        expect(e.code).toBe('INVALID_INPUT');
        expect(e.message).toMatch(text);
        expect(e.entityRefs).toEqual([`${S}:e(B1)`]);
      };

      it('bad degree', () => {
        expectBad(failSpline({ degree: 0 }), /degree from 1 to 25/);
        expectBad(failSpline({ degree: 2.5 }), /degree/);
        expectBad(failSpline({ degree: 26 }), /degree/);
      });

      it('too few poles for the degree', () => {
        expectBad(
          failSpline({}, [
            [0, 0],
            [1, 1],
            [2, 0],
          ]),
          /at least degree \+ 1 = 4 control points \(has 3\)/,
        );
      });

      it('weights: non-positive or the wrong count', () => {
        expectBad(failSpline({ weights: [1, 0, 1, 1, 1] }), /weight/);
        expectBad(failSpline({ weights: [1, -2, 1, 1, 1] }), /weight/);
        expectBad(failSpline({ weights: [1, 1, 1] }), /one weight per control point \(5\)/);
      });

      it('knot vectors of the wrong length, unclamped, unordered or unpaired', () => {
        expectBad(
          failSpline({ knots: [0, 0.5, 1], multiplicities: [4, 2, 4] }),
          /wrong length: 5 control points of degree 3 need 9 knots counting multiplicity \(has 10\)/,
        );
        expectBad(failSpline({ knots: [0, 1], multiplicities: [4, 4] }), /wrong length/);
        expectBad(failSpline({ knots: [0, 0.5, 1], multiplicities: [3, 3, 3] }), /not clamped/);
        expectBad(
          failSpline({ knots: [0, 0.5, 0.5, 1], multiplicities: [4, 1, 1, 4] }),
          /increasing/,
        );
        expectBad(failSpline({ knots: [0, 0.5, 1] }), /knots and multiplicities together/);
        expectBad(failSpline({ knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1, 1] }), /not clamped/);
        expectBad(failSpline({ knots: [0, 0, 0, 0, 0.6, 0.5, 1, 1, 1] }), /non-decreasing/);
        expectBad(failSpline({ knots: [0, 0.5, 1], multiplicities: [4, 1] }), /same length/);
        expectBad(
          failSpline({ periodic: true, knots: [0, 0.5, 1], multiplicities: [1, 1, 1] }),
          /periodic spline with 5 control points/,
        );
      });

      it('degenerate splines and unknown poles', () => {
        expectBad(
          failSpline({}, [
            [1, 1],
            [1, 1],
            [1, 1],
            [1, 1],
          ]),
          /zero length/,
        );
        const ss = session();
        const e = ss.fail(
          sketch(SK, [
            pt('a', 0, 0),
            {
              id: 'B1',
              kind: 'bspline',
              poles: ['a', 'nope', 'a', 'a'],
              degree: 3,
              periodic: false,
              construction: false,
            },
          ]),
          sketchInputs(),
        );
        expect(e.code).toBe('INVALID_INPUT');
        expect(e.message).toMatch(/unknown point nope/);
      });

      it('elliptic arcs: off the ellipse, no sweep, bad radii', () => {
        const ss = session();
        const arc = ellipticArc('A1', [0, 0], 20, 8, 0, 0, PI);
        // 0.01 mm outside the ellipse at the end of the major axis (a sideways move there stays
        // within 2e-5 mm of the curve, which is inside the solver tolerance).
        const moved = arc.entities.map((e) =>
          e.id === 'A1e' && e.kind === 'point' ? { ...e, x: -20.01 } : e,
        );
        const off = ss.fail(sketch(SK, moved), sketchInputs());
        expect(off.code).toBe('INVALID_INPUT');
        expect(off.message).toMatch(/not on its ellipse/);
        expect(off.entityRefs).toEqual([`${S}:e(A1)`]);
        const same = ss.fail(
          sketch(SK, ellipticArc('A1', [0, 0], 20, 8, 0, 1, 1).entities),
          sketchInputs(),
        );
        expect(same.message).toMatch(/no sweep/);
        const flat = arc.entities.map((e) =>
          e.kind === 'ellipticArc' ? { ...e, minorRadius: 0 } : e,
        );
        expect(ss.fail(sketch(SK, flat), sketchInputs()).message).toMatch(/positive radii/);
      });
    });

    // -----------------------------------------------------------------------------------------
    // Exact projection (convert entities, `exact: true`)
    // -----------------------------------------------------------------------------------------

    describe('exact projection', () => {
      it('a spline edge projects to the same B-spline on a parallel plane', () => {
        const ss = session();
        const { ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
        const top = indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(B1)))`, 'edge');
        const c = only(project(ex.shape, [top], frameAt([0, 0, 50])));
        expect(c.kind).toBe('bspline');
        if (c.kind !== 'bspline') return;
        expect(c.degree).toBe(3);
        expect(c.periodic).toBe(false);
        expect(c.weights).toBeUndefined();
        expect(c.knots).toEqual([0, 0.5, 1]);
        expect(c.multiplicities).toEqual([4, 1, 4]);
        expect(c.poles).toHaveLength(5);
        c.poles.forEach((p, i) => {
          vecClose([...p, 0], [...(ARCH.poles[i] as Vec2), 0], 1e-9);
        });
        // Default (not exact): a polyline, as at M3.
        expect(only(project(ex.shape, [top], XY, false)).kind).toBe('polyline');
      });

      it('an oblique plane gets the projected poles (affine projection is exact)', () => {
        const ss = session();
        const { ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
        const top = indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(B1)))`, 'edge');
        const z: [number, number, number] = [0, -Math.sin(0.4), Math.cos(0.4)];
        const x: [number, number, number] = [1, 0, 0];
        const y: [number, number, number] = [0, Math.cos(0.4), Math.sin(0.4)];
        const c = only(project(ex.shape, [top], frameAt([0, 0, 0], z, x)));
        expect(c.kind).toBe('bspline');
        if (c.kind !== 'bspline') return;
        c.poles.forEach((p, i) => {
          const q = ARCH.poles[i] as Vec2;
          const w: [number, number, number] = [q[0], q[1], DEPTH];
          const dot = (v: number[]) =>
            (w[0] as number) * (v[0] as number) + w[1] * (v[1] as number) + w[2] * (v[2] as number);
          vecClose([...p, 0], [dot(x), dot(y), 0], 1e-9);
        });
      });

      it('a rational spline keeps its weights; a periodic one stays periodic', () => {
        const ss = session();
        const r = 15;
        const quarter = spline(
          'B1',
          {
            poles: [
              [r, 0],
              [r, r],
              [0, r],
            ],
            weights: [1, Math.SQRT1_2, 1],
            degree: 2,
            periodic: false,
          },
          { first: 'a', last: 'b' },
        );
        const sk = ss.exec(
          sketch(SK, [
            pt('o', 0, 0),
            pt('a', r, 0),
            pt('b', 0, r),
            line('L1', 'o', 'a'),
            ...quarter,
            line('L2', 'b', 'o'),
          ]),
          sketchInputs(),
        );
        const c = only(project(sk.shape, [indexOf(sk, `${S}:e(B1)`, 'edge')]));
        expect(c.kind).toBe('bspline');
        if (c.kind === 'bspline') {
          expect(c.weights?.map((w) => Math.round(w * 1e12) / 1e12)).toEqual([
            1,
            Math.round(Math.SQRT1_2 * 1e12) / 1e12,
            1,
          ]);
        }
        const hexPoles = Array.from(
          { length: 6 },
          (_, i): Vec2 => [20 * Math.cos((i * PI) / 3), 20 * Math.sin((i * PI) / 3)],
        );
        const ring = ss.exec(
          sketch(SK, spline('B1', { poles: hexPoles, degree: 3, periodic: true })),
          sketchInputs(),
        );
        const pc = only(project(ring.shape, [indexOf(ring, `${S}:e(B1)`, 'edge')]));
        expect(pc.kind).toBe('bspline');
        if (pc.kind === 'bspline') {
          expect(pc.periodic).toBe(true);
          expect(pc.poles).toHaveLength(6);
          expect(pc.multiplicities).toEqual([1, 1, 1, 1, 1, 1, 1]);
          // Same control polygon (OCCT may start the cycle elsewhere).
          const key = (p: readonly number[]) => p.map((v) => Math.round(v * 1e6) / 1e6).join();
          expect(pc.poles.map(key).sort()).toEqual(hexPoles.map(key).sort());
        }
      });

      it('elliptic arcs and ellipses stay conics; a circle seen obliquely is an ellipse', () => {
        const ss = session();
        const arc = ellipticArc('A1', [5, 5], 20, 8, 0.3, 0, PI);
        const sk = ss.exec(sketch(SK, [...arc.entities, line('L1', 'A1e', 'A1s')]), sketchInputs());
        const e = indexOf(sk, `${S}:e(A1)`, 'edge');
        const c = only(project(sk.shape, [e], frameAt([0, 0, -7])));
        expect(c.kind).toBe('ellipticArc');
        if (c.kind === 'ellipticArc') {
          vecClose([...c.c, 0], [5, 5, 0], 1e-9);
          relClose(c.majorRadius, 20, 1e-12);
          relClose(c.minorRadius, 8, 1e-12);
          relClose(c.rotation, 0.3, 1e-12);
          vecClose([...c.start, 0], [...arc.start, 0], 1e-9);
          vecClose([...c.end, 0], [...arc.end, 0], 1e-9);
        }
        // Seen from below (normal −z, x kept): mirrored, so start and end swap to stay CCW.
        const below = only(project(sk.shape, [e], frameAt([0, 0, 0], [0, 0, -1], [1, 0, 0])));
        expect(below.kind).toBe('ellipticArc');
        if (below.kind === 'ellipticArc') {
          vecClose([...below.start, 0], [arc.end[0], -arc.end[1], 0], 1e-9);
          vecClose([...below.end, 0], [arc.start[0], -arc.start[1], 0], 1e-9);
          relClose(below.rotation, -0.3, 1e-12);
        }
        // A full circle on a plane tilted by θ about x: major r, minor r cos θ.
        const theta = 0.6;
        const disc = ss.exec(
          sketch(SK, [
            pt('cc', 0, 0),
            { id: 'C1', kind: 'circle', center: 'cc', radius: 10, construction: false },
          ]),
          sketchInputs(),
        );
        const tilted = only(
          project(
            disc.shape,
            [indexOf(disc, `${S}:e(C1)`, 'edge')],
            frameAt([0, 0, 0], [0, -Math.sin(theta), Math.cos(theta)], [1, 0, 0]),
          ),
        );
        expect(tilted.kind).toBe('ellipse');
        if (tilted.kind === 'ellipse') {
          relClose(tilted.majorRadius, 10, 1e-12);
          relClose(tilted.minorRadius, 10 * Math.cos(theta), 1e-12);
          expect(Math.abs(tilted.rotation)).toBeLessThan(1e-12);
        }
        // Not exact (the M3 default): sampled.
        expect(
          only(
            ok<ProjectedEdge[]>(
              k.projectEdges(
                JSON.stringify({
                  shape: sk.shape,
                  edges: [e],
                  plane: XY,
                }),
              ),
            ),
          ).kind,
        ).toBe('polyline');
        expect(
          JSON.parse(
            k.projectEdges(JSON.stringify({ shape: sk.shape, edges: [e], plane: XY, exact: 1 })),
          ).error.code,
        ).toBe('INVALID_INPUT');
      });

      it('face outlines honour exact', () => {
        const ss = session();
        const { ex } = sketchAndExtrude(ss, archEntities(), ARCH_REGION);
        const top = indexOf(ex, `${E}:end`, 'face');
        const out = ok<{ outer: ExactProjectedEdge[]; inner: ExactProjectedEdge[][] }>(
          k.projectFaceOutline(
            JSON.stringify({ shape: ex.shape, face: top, plane: XY, exact: true }),
          ),
        );
        expect(out.outer.map((e) => e.curves[0]?.kind).sort()).toEqual(['bspline', 'line']);
      });
    });
  });
}
