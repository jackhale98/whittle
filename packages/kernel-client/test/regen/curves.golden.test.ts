/**
 * Regen golden (M3.5) for profiles bounded by B-splines and elliptic arcs on the real kernel:
 * extruded volumes against a numerically integrated reference (Green's theorem on the exact
 * curves, ≤ 1e-6 relative), rational splines against the exact quarter disc, and a moved pole
 * updating the solid. The kernel builds exact spline and elliptic edges in the M3.5 kernel
 * workstream; until its build is here these goldens are skipped by a feature probe and the
 * last test checks that today's kernel refuses such a sketch with a clear error.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  Feature,
  SketchBSpline,
  SketchEntity,
  SketchFeature,
  Vec2,
  WrenDoc,
} from '@wren-cad/contracts';
import { fromFiles, toFiles } from '@wren-cad/document';
import { beforeAll, describe, expect, it } from 'vitest';
import { ellipsePoint, evalBSpline, prepareBSpline } from '../../src/regen/curves';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  relClose,
  states,
  totalVolume,
} from './helpers';

const PART = fid('CGPART');
const SK = fid('CGS');
const EX = fid('CGE');

const P = (id: string, x: number, y: number): SketchEntity => ({
  id,
  kind: 'point',
  x,
  y,
  construction: false,
});

/** Shoelace area of a dense closed polyline (error O(1/N²): far below 1e-6 here). */
function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Vec2;
    const q = pts[(i + 1) % pts.length] as Vec2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

const N = 1 << 17;

function splinePoints(s: SketchBSpline, at: Record<string, Vec2>): Vec2[] {
  const b = prepareBSpline(
    s,
    s.poles.map((id) => at[id] as Vec2),
  );
  if (typeof b === 'string') throw new Error(b);
  return Array.from({ length: N }, (_, i) => evalBSpline(b, b.t0 + ((b.t1 - b.t0) * i) / N));
}

/** Elliptic arc (10 × 4, CCW from (10, 0) to (0, 4)) closed by a weighted cubic back to (10, 0). */
function arcAndSpline(q1: Vec2 = [-6, 8]): { sketch: SketchFeature; area: number } {
  const at: Record<string, Vec2> = {
    c: [0, 0],
    s: [10, 0],
    e: [0, 4],
    q0: [0, 4],
    q1,
    q2: [-9, -3],
    q3: [10, 0],
  };
  const spline: SketchBSpline = {
    id: 'sp',
    kind: 'bspline',
    poles: ['e', 'q1', 'q2', 's'],
    degree: 3,
    periodic: false,
    weights: [1, 1.5, 0.75, 1],
    construction: false,
  };
  const entities: SketchEntity[] = [
    P('c', 0, 0),
    P('s', 10, 0),
    P('e', 0, 4),
    P('q1', q1[0], q1[1]),
    P('q2', -9, -3),
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
    spline,
  ];
  const g = { c: [0, 0] as Vec2, a: 10, b: 4, rotation: 0 };
  const arcPts = Array.from({ length: N }, (_, i) => ellipsePoint(g, ((Math.PI / 2) * i) / N));
  const area = shoelace([...arcPts, ...splinePoints(spline, at)]);
  return { sketch: sketchOf(entities), area };
}

function sketchOf(entities: SketchEntity[]): SketchFeature {
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

/** Does the loaded kernel build B-spline and elliptic-arc sketch edges? */
async function buildsCurves(api: Api): Promise<boolean> {
  const { sketch } = arcAndSpline();
  const r = await api.execFeature(sketch, {
    values: {},
    frames: { plane: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } },
  });
  if (r.ok) {
    await api.release(r.value.shape);
    return true;
  }
  return !(
    r.error.code === 'UNSUPPORTED_FEATURE' && /kind '(bspline|ellipticArc)'/.test(r.error.message)
  );
}

const SKIP =
  'SKIPPED: this kernel build has no exact B-spline / elliptic-arc sketch edges yet (M3.5 kernel)';

let api: Api | null = null;
let supported = false;
beforeAll(async () => {
  if (!built) return;
  api = await loadApi();
  supported = await buildsCurves(api);
}, 60_000);

const regen = (doc: WrenDoc) =>
  (api as Api).regenerate({ doc, partId: PART, quality: 'coarse', massProperties: true });

const extruded = (sketch: SketchFeature, region: string, depth = '5'): Feature[] => [
  sketch,
  extrude(EX, [{ name: `S${SK}:region(${region})`, kind: 'region' }], depth),
];

describe.skipIf(!built)('regen golden (M3.5): spline and elliptic-arc profiles', () => {
  it('elliptic arc + rational spline: volume = 5 × integrated area (1e-6)', async (t) => {
    if (!supported) t.skip(SKIP);
    const { sketch, area } = arcAndSpline();
    const r = await regen(makeDoc({}, extruded(sketch, 'ea,sp'), PART));
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    relClose(totalVolume(r.bodies), 5 * area, 1e-6);
  });

  it('save → load → regen is byte-identical: files, names and meshes', async (t) => {
    if (!supported) t.skip(SKIP);
    const { sketch } = arcAndSpline();
    // Explicit OCCT-form knots and a minor-axis radius ride along as data (they must round-trip).
    const withKnots: SketchFeature = {
      ...sketch,
      entities: sketch.entities.map((e) =>
        e.kind === 'bspline' ? { ...e, knots: [0, 1], multiplicities: [4, 4] } : e,
      ),
    };
    const doc = makeDoc({}, extruded(withKnots, 'ea,sp'), PART);
    const files = toFiles(doc);
    const loaded = fromFiles(files);
    const again = toFiles(loaded);
    expect([...again.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [k, v] of files) {
      expect(Buffer.from(again.get(k) as Uint8Array).equals(Buffer.from(v)), k).toBe(true);
    }
    const a = await regen(doc);
    await (api as Api).closePart(PART); // cold regen of the reloaded document: no cache reuse
    const b = await regen(loaded);
    expect(states(b), describeFailures(b)).toEqual(['ok', 'ok']);
    expect(b.bodies.map((x) => x.id)).toEqual(a.bodies.map((x) => x.id));
    for (const [i, body] of a.bodies.entries()) {
      const other = b.bodies[i];
      expect(other?.mesh.faceNames).toEqual(body.mesh.faceNames);
      expect(other?.mesh.edgeNames).toEqual(body.mesh.edgeNames);
      for (const key of ['positions', 'indices', 'faceRanges', 'edgePositions'] as const) {
        const x = Buffer.from(
          body.mesh[key].buffer,
          body.mesh[key].byteOffset,
          body.mesh[key].byteLength,
        );
        const m = other?.mesh[key];
        expect(m && Buffer.from(m.buffer, m.byteOffset, m.byteLength).equals(x), key).toBe(true);
      }
    }
    relClose(totalVolume(b.bodies), totalVolume(a.bodies), 1e-12);
  });

  it('moving a pole updates the solid', async (t) => {
    if (!supported) t.skip(SKIP);
    const before = arcAndSpline();
    const after = arcAndSpline([-12, 12]);
    expect(Math.abs(after.area - before.area)).toBeGreaterThan(1);
    const doc = makeDoc({}, extruded(before.sketch, 'ea,sp'), PART);
    await regen(doc);
    const moved = structuredClone(doc);
    (moved.parts[0] as WrenDoc['parts'][number]).features[0] = after.sketch;
    const r = await regen(moved);
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    relClose(totalVolume(r.bodies), 5 * after.area, 1e-6);
  });

  it('a closed (periodic) spline alone is a region', async (t) => {
    if (!supported) t.skip(SKIP);
    const at: Record<string, Vec2> = {
      a: [0, 0],
      b: [20, -2],
      c: [24, 12],
      d: [8, 18],
      e: [-4, 9],
    };
    const spline: SketchBSpline = {
      id: 'loop',
      kind: 'bspline',
      poles: ['a', 'b', 'c', 'd', 'e'],
      degree: 3,
      periodic: true,
      construction: false,
    };
    const entities = [...Object.entries(at).map(([id, [x, y]]) => P(id, x, y)), spline];
    const r = await regen(makeDoc({}, extruded(sketchOf(entities), 'loop', '3'), PART));
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    relClose(totalVolume(r.bodies), 3 * shoelace(splinePoints(spline, at)), 1e-6);
  });

  it('a rational quadratic quarter circle + two lines = the quarter disc', async (t) => {
    if (!supported) t.skip(SKIP);
    const entities: SketchEntity[] = [
      P('o', 0, 0),
      P('a', 7, 0),
      P('m', 7, 7),
      P('b', 0, 7),
      { id: 'l1', kind: 'line', start: 'o', end: 'a', construction: false },
      {
        id: 'q',
        kind: 'bspline',
        poles: ['a', 'm', 'b'],
        degree: 2,
        periodic: false,
        weights: [1, Math.SQRT1_2, 1],
        construction: false,
      },
      { id: 'l2', kind: 'line', start: 'b', end: 'o', construction: false },
    ];
    const r = await regen(makeDoc({}, extruded(sketchOf(entities), 'l1,l2,q', '2'), PART));
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    relClose(totalVolume(r.bodies), (2 * (Math.PI * 49)) / 4, 1e-9);
  });

  it('today’s kernel refuses the new kinds with a clear sketch error', async (t) => {
    if (supported) t.skip('the kernel builds them');
    const { sketch } = arcAndSpline();
    const r = await regen(makeDoc({}, extruded(sketch, 'ea,sp'), PART));
    expect(states(r)).toEqual(['error', 'blocked']);
    expect(r.features[0]?.error?.code).toBe('UNSUPPORTED_FEATURE');
    expect(r.features[1]?.cause).toEqual({ featureId: SK, kind: 'failed' });
  });
});
