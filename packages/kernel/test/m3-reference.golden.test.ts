/**
 * M3 golden tests: reference geometry (axis, point and the M3 plane definitions), the
 * "convert entities" projection API (projectEdges / projectFaceOutline) and fillet/chamfer
 * `propagate: false`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, FeatureInputs, Frame, KernelError, Result } from '@whittle/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  ProjectedCurve,
  ProjectedEdge,
  ProjectedOutline,
  WhittleKernelModule,
} from '../src/index';
import {
  boxFeature,
  boxValues,
  circle,
  extrude,
  frameAt,
  indexOf,
  line,
  loadVariant,
  names,
  ok,
  profileRefs,
  pt,
  type RawFeatureResult,
  rect,
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

const PI = Math.PI;
const REL = 1e-6;
const BOX = '01JM3BOX000000000000000001';
const B = `F${BOX}`;
const REF = '01JM3REF000000000000000001';
const SK = '01JM3SK0000000000000000001';
const S = `S${SK}`;
const EX = '01JM3EXTRUDE00000000000001';
const E = `F${EX}`;
const FI = '01JM3FILLET000000000000001';
const LO = '01JM3LOFT00000000000000001';

const XZ: Frame = frameAt([0, 0, 0], [0, -1, 0], [1, 0, 0]); // local (x, y) = world (x, z)
const BELOW: Frame = frameAt([0, 0, 0], [0, 0, -1], [1, 0, 0]); // local y = world −y

function refFeature(
  type: 'axis' | 'point' | 'plane',
  definition: Record<string, unknown>,
  flip?: boolean,
): Feature {
  return {
    id: REF,
    type,
    name: type,
    suppressed: false,
    definition,
    ...(flip === undefined ? {} : { flip }),
  } as Feature;
}

const slotEntities = [
  pt('a', -10, -3),
  pt('b', 10, -3),
  pt('c', 10, 3),
  pt('d', -10, 3),
  pt('cr', 10, 0),
  pt('cl', -10, 0),
  line('bot', 'a', 'b'),
  { id: 'ar', kind: 'arc' as const, center: 'cr', start: 'b', end: 'c', construction: false },
  line('top', 'c', 'd'),
  { id: 'al', kind: 'arc' as const, center: 'cl', start: 'd', end: 'a', construction: false },
];
const SLOT = `${S}:region(al,ar,bot,top)`;

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(
    suiteTitle('M3 reference geometry and projection', variant),
    () => {
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
      const cylinder = (ss: Session, r = 5, h = 10) =>
        ss.exec(
          {
            id: BOX,
            type: 'primitive',
            name: 'Cylinder',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: String(r),
            height: String(h),
          },
          { values: { '/radius': r, '/height': h } },
        );
      const slot = (ss: Session, depth = 5) => {
        const sk = ss.exec(sketch(SK, slotEntities), sketchInputs());
        const ex = ss.exec(extrude(EX), {
          values: { '/end/depth': depth },
          refs: profileRefs(sk.shape, [indexOf(sk, SLOT, 'face')]),
        });
        return { sk, ex };
      };
      const frameOf = (r: RawFeatureResult): Frame => {
        if (r.frame === undefined) throw new Error('result has no frame');
        return r.frame;
      };

      // -------------------------------------------------------------------------------------
      // Reference geometry
      // -------------------------------------------------------------------------------------

      describe('axis, point and plane definitions', () => {
        it('axis of a cylinder face, from two planes, along an edge, two points, point + normal', () => {
          const ss = session();
          const cyl = cylinder(ss);
          const ax = ss.exec(
            refFeature('axis', {
              kind: 'cylinder',
              face: { name: `${B}:face.side`, kind: 'face' },
            }),
            {
              values: {},
              refs: {
                '/definition/face': {
                  shape: cyl.shape,
                  kind: 'face',
                  index: indexOf(cyl, `${B}:face.side`, 'face'),
                },
              },
            },
          );
          expect(ax.naming).toEqual([{ name: `F${REF}:axis`, kind: 'edge', index: 0 }]);
          vecClose(frameOf(ax).origin, [0, 0, 0]);
          vecClose(frameOf(ax).z, [0, 0, 1]);
          relClose(ss.fingerprints(ax.shape).edges[0]?.length ?? 0, 10, REL);
          const planes = ss.exec(
            refFeature('axis', {
              kind: 'twoPlanes',
              a: { name: 'origin:XY', kind: 'face' },
              b: { name: 'origin:XZ', kind: 'face' },
            }),
            { values: {}, frames: { '/definition/a': XY, '/definition/b': XZ } },
          );
          vecClose(frameOf(planes).z, [1, 0, 0]);
          vecClose(frameOf(planes).origin, [0, 0, 0]);
          const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
          const e = indexOf(box, `${B}:edge(face.xmin|face.ymin)`, 'edge');
          const along = ss.exec(
            refFeature('axis', { kind: 'edge', edge: { name: 'e', kind: 'edge' } }),
            {
              values: {},
              refs: { '/definition/edge': { shape: box.shape, kind: 'edge', index: e } },
            },
          );
          // The axis runs along the edge from one end to the other (either way round).
          const o = frameOf(along).origin;
          const z = frameOf(along).z;
          vecClose(z.map(Math.abs), [0, 0, 1]);
          vecClose(o, [0, 0, z[2] > 0 ? 0 : 30]);
          relClose(ss.fingerprints(along.shape).edges[0]?.length ?? 0, 30, REL);
          const two = ss.exec(
            refFeature('axis', {
              kind: 'twoPoints',
              a: { name: 'origin:O', kind: 'vertex' },
              b: { name: 'p', kind: 'vertex' },
            }),
            { values: {}, frames: { '/definition/a': XY, '/definition/b': frameAt([3, 4, 0]) } },
          );
          vecClose(frameOf(two).z, [0.6, 0.8, 0]);
          relClose(ss.fingerprints(two.shape).edges[0]?.length ?? 0, 5, REL);
          const pn = ss.exec(
            refFeature('axis', {
              kind: 'pointNormal',
              point: { name: 'p', kind: 'vertex' },
              plane: { name: 'f', kind: 'face' },
            }),
            {
              values: {},
              frames: { '/definition/point': frameAt([1, 2, 3]) },
              refs: {
                '/definition/plane': {
                  shape: box.shape,
                  kind: 'face',
                  index: indexOf(box, `${B}:face.xmax`, 'face'),
                },
              },
            },
          );
          vecClose(frameOf(pn).origin, [1, 2, 3]);
          vecClose(frameOf(pn).z, [1, 0, 0]);
        });

        it('points: coordinates, centre, along an edge, intersection', () => {
          const ss = session();
          const c = ss.exec(refFeature('point', { kind: 'coordinates', x: '1', y: '2', z: '3' }), {
            values: { '/definition/x': 1, '/definition/y': 2, '/definition/z': 3 },
          });
          expect(c.naming).toEqual([{ name: `F${REF}:point`, kind: 'vertex', index: 0 }]);
          vecClose(frameOf(c).origin, [1, 2, 3]);
          const cyl = cylinder(ss);
          const top = indexOf(cyl, `${B}:edge(face.side|face.zmax)`, 'edge');
          const ctr = ss.exec(
            refFeature('point', { kind: 'center', of: { name: 'e', kind: 'edge' } }),
            {
              values: {},
              refs: { '/definition/of': { shape: cyl.shape, kind: 'edge', index: top } },
            },
          );
          vecClose(frameOf(ctr).origin, [0, 0, 10]);
          const sk = ss.exec(sketch(SK, rect(0, 0, 40, 30)), sketchInputs());
          const l1 = {
            shape: sk.shape,
            kind: 'edge' as const,
            index: indexOf(sk, `${S}:e(L1)`, 'edge'),
          };
          const along = ss.exec(
            refFeature('point', {
              kind: 'alongEdge',
              edge: { name: 'e', kind: 'edge' },
              t: '0.25',
            }),
            {
              values: { '/definition/t': 0.25 },
              refs: { '/definition/edge': l1 },
            },
          );
          vecClose(frameOf(along).origin, [10, 0, 0]);
          const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
          const vertical = indexOf(box, `${B}:edge(face.xmin|face.ymin)`, 'edge');
          const hit = ss.exec(
            refFeature('point', {
              kind: 'intersection',
              a: { name: 'e', kind: 'edge' },
              b: { name: 'origin:XY', kind: 'face' },
            }),
            {
              values: {},
              refs: { '/definition/a': { shape: box.shape, kind: 'edge', index: vertical } },
              frames: { '/definition/b': frameAt([0, 0, 4]) },
            },
          );
          vecClose(frameOf(hit).origin, [0, 0, 4]);
          const miss = ss.fail(
            refFeature('point', {
              kind: 'intersection',
              a: { name: 'e', kind: 'edge' },
              b: { name: 'p', kind: 'face' },
            }),
            {
              values: {},
              refs: { '/definition/a': { shape: box.shape, kind: 'edge', index: vertical } },
              frames: { '/definition/b': frameAt([0, 0, 40]) },
            },
          );
          expect(miss.code).toBe('INVALID_INPUT');
          const planes = ss.fail(
            refFeature('point', {
              kind: 'intersection',
              a: { name: 'a', kind: 'face' },
              b: { name: 'b', kind: 'face' },
            }),
            { values: {}, frames: { '/definition/a': XY, '/definition/b': XZ } },
          );
          expect(planes.code).toBe('INVALID_INPUT');
        });

        it('planes: three points, angle, normal to curve, midplane, through point, flip', () => {
          const ss = session();
          const pts: FeatureInputs = {
            values: {},
            frames: {
              '/definition/points/0': frameAt([0, 0, 1]),
              '/definition/points/1': frameAt([1, 0, 1]),
              '/definition/points/2': frameAt([0, 1, 1]),
            },
          };
          const three = ss.exec(refFeature('plane', { kind: 'threePoints', points: [] }), pts);
          vecClose(frameOf(three).z, [0, 0, 1]);
          vecClose(frameOf(three).origin, [0, 0, 1]);
          expect(names(three, 'face')).toEqual([`F${REF}:plane`]);
          const flipped = ss.exec(
            refFeature('plane', { kind: 'threePoints', points: [] }, true),
            pts,
          );
          vecClose(frameOf(flipped).z, [0, 0, -1]);
          const angled = ss.exec(
            refFeature('plane', {
              kind: 'angle',
              from: { name: 'origin:XY', kind: 'face' },
              axis: { name: 'origin:X', kind: 'edge' },
              angle: '90deg',
            }),
            {
              values: { '/definition/angle': PI / 2 },
              frames: {
                '/definition/from': XY,
                '/definition/axis': frameAt([0, 0, 0], [1, 0, 0], [0, 1, 0]),
              },
            },
          );
          vecClose(frameOf(angled).z, [0, -1, 0]);
          const sk = ss.exec(sketch(SK, rect(0, 0, 40, 30)), sketchInputs());
          const normal = ss.exec(
            refFeature('plane', {
              kind: 'normalToCurve',
              curve: { name: 'e', kind: 'edge' },
              at: { t: '0.5' },
            }),
            {
              values: { '/definition/at/t': 0.5 },
              refs: {
                '/definition/curve': {
                  shape: sk.shape,
                  kind: 'edge',
                  index: indexOf(sk, `${S}:e(L1)`, 'edge'),
                },
              },
            },
          );
          vecClose(frameOf(normal).origin, [20, 0, 0]);
          vecClose(frameOf(normal).z, [1, 0, 0]);
          const atVertex = ss.exec(
            refFeature('plane', {
              kind: 'normalToCurve',
              curve: { name: 'e', kind: 'edge' },
              at: { name: 'v', kind: 'vertex' },
            }),
            {
              values: {},
              refs: {
                '/definition/curve': {
                  shape: sk.shape,
                  kind: 'edge',
                  index: indexOf(sk, `${S}:e(L2)`, 'edge'),
                },
                '/definition/at': {
                  shape: sk.shape,
                  kind: 'vertex',
                  index: indexOf(sk, `${S}:p(p3)`, 'vertex'),
                },
              },
            },
          );
          vecClose(frameOf(atVertex).origin, [40, 30, 0]);
          vecClose(frameOf(atVertex).z, [0, 1, 0]);
          const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
          const mid = ss.exec(
            refFeature('plane', {
              kind: 'midplane',
              a: { name: 'a', kind: 'face' },
              b: { name: 'b', kind: 'face' },
            }),
            {
              values: {},
              refs: {
                '/definition/a': {
                  shape: box.shape,
                  kind: 'face',
                  index: indexOf(box, `${B}:face.xmin`, 'face'),
                },
                '/definition/b': {
                  shape: box.shape,
                  kind: 'face',
                  index: indexOf(box, `${B}:face.xmax`, 'face'),
                },
              },
            },
          );
          vecClose(frameOf(mid).origin, [5, 10, 15]);
          vecClose(frameOf(mid).z, [-1, 0, 0]);
          const through = ss.exec(
            refFeature('plane', {
              kind: 'throughPoint',
              from: { name: 'origin:XY', kind: 'face' },
              point: { name: 'p', kind: 'vertex' },
            }),
            {
              values: {},
              frames: { '/definition/from': XY, '/definition/point': frameAt([3, 4, 7]) },
            },
          );
          vecClose(frameOf(through).origin, [3, 4, 7]);
          vecClose(frameOf(through).z, [0, 0, 1]);
          const errors = [
            ss.fail(refFeature('plane', { kind: 'threePoints', points: [] }), {
              values: {},
              frames: {
                '/definition/points/0': frameAt([0, 0, 0]),
                '/definition/points/1': frameAt([1, 0, 0]),
                '/definition/points/2': frameAt([2, 0, 0]),
              },
            }),
            ss.fail(refFeature('axis', { kind: 'twoPlanes', a: {}, b: {} }), {
              values: {},
              frames: { '/definition/a': XY, '/definition/b': frameAt([0, 0, 5]) },
            }),
            ss.fail(refFeature('plane', { kind: 'midplane', a: {}, b: {} }), {
              values: {},
              frames: { '/definition/a': XY, '/definition/b': XZ },
            }),
          ];
          expect(errors.map((e) => e.code)).toEqual([
            'INVALID_INPUT',
            'INVALID_INPUT',
            'INVALID_INPUT',
          ]);
        });
      });

      // -------------------------------------------------------------------------------------
      // Projection ("convert entities")
      // -------------------------------------------------------------------------------------

      describe('projectEdges / projectFaceOutline', () => {
        const project = (shape: number, edges: number[], plane: Frame) =>
          ok<ProjectedEdge[]>(k.projectEdges(JSON.stringify({ shape, edges, plane })));
        const only = (p: ProjectedEdge[] | undefined, i = 0): ProjectedCurve => {
          const c = p?.[i]?.curves;
          if (c === undefined || c.length !== 1 || c[0] === undefined)
            throw new Error(`expected one curve, got ${JSON.stringify(c)}`);
          return c[0];
        };

        it('lines stay lines; edges along the normal are dropped', () => {
          const ss = session();
          const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
          const all = Array.from({ length: 12 }, (_, i) => i);
          const p = project(box.shape, all, XY);
          expect(p.map((e) => e.edge)).toEqual(all);
          expect(p.filter((e) => e.curves.length === 0).length).toBe(4);
          const top = indexOf(box, `${B}:edge(face.ymin|face.zmax)`, 'edge');
          const c = only(project(box.shape, [top], XY));
          expect(c.kind).toBe('line');
          if (c.kind === 'line') {
            expect([c.a, c.b].map((v) => v.join()).sort()).toEqual(['0,0', '10,0']);
          }
          const vertical = indexOf(box, `${B}:edge(face.xmin|face.ymin)`, 'edge');
          expect(project(box.shape, [vertical], XY)[0]?.curves).toEqual([]);
        });

        it('circles seen face-on stay circles; seen obliquely they are polylines on the ellipse', () => {
          const ss = session();
          const cyl = cylinder(ss);
          const top = indexOf(cyl, `${B}:edge(face.side|face.zmax)`, 'edge');
          for (const plane of [XY, BELOW]) {
            const c = only(project(cyl.shape, [top], plane));
            expect(c).toEqual({ kind: 'circle', c: [0, 0], r: 5 });
          }
          const seam = indexOf(cyl, `${B}:edge(face.side|face.side)`, 'edge');
          expect(project(cyl.shape, [seam], XY)[0]?.curves).toEqual([]);
          const a = PI / 6;
          const tilted = frameAt([0, 0, 10], [0, -Math.sin(a), Math.cos(a)], [1, 0, 0]);
          const e = only(project(cyl.shape, [top], tilted));
          expect(e.kind).toBe('polyline');
          if (e.kind === 'polyline') {
            expect(e.points.length).toBeGreaterThan(16);
            for (const [x, y] of e.points) {
              expect(Math.abs((x / 5) ** 2 + (y / (5 * Math.cos(a))) ** 2 - 1)).toBeLessThan(1e-6);
            }
          }
          // Edge-on, the circle is a segment.
          const side = only(project(cyl.shape, [top], XZ));
          expect(side.kind).toBe('line');
          if (side.kind === 'line') {
            expect(
              [side.a, side.b].map((v) => v.map((x) => Math.round(x * 1e9) / 1e9).join()).sort(),
            ).toEqual(['-5,10', '5,10']);
          }
        });

        it('arcs come back counter-clockwise in plane coordinates, from either side', () => {
          const ss = session();
          const { ex } = slot(ss);
          const arc = indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(ar)))`, 'edge');
          for (const plane of [XY, BELOW]) {
            const c = only(project(ex.shape, [arc], plane));
            expect(c.kind).toBe('arc');
            if (c.kind === 'arc') {
              vecClose([...c.c, 0], [10, 0, 0]);
              relClose(c.r, 3, REL);
              vecClose([...c.start, 0], [10, -3, 0]);
              vecClose([...c.end, 0], [10, 3, 0]);
            }
          }
        });

        it('a B-spline edge is a polyline; collinear projections collapse to a line', () => {
          const ss = session();
          const disc = (id: string, r: number, z: number) => {
            const d = ss.exec(sketch(id, circle('c', 0, 0, r)), sketchInputs(frameAt([0, 0, z])));
            return {
              shape: d.shape,
              kind: 'face' as const,
              index: indexOf(d, `S${id}:region(c)`, 'face'),
            };
          };
          const loft = ss.exec(
            {
              id: LO,
              type: 'loft',
              name: 'Loft',
              suppressed: false,
              sections: [],
              ruled: false,
              closed: false,
              op: 'new',
            } as Feature,
            {
              values: {},
              refs: {
                '/sections/0': disc('01JM3SKA000000000000000001', 10, 0),
                '/sections/1': disc('01JM3SKB000000000000000001', 5, 10),
                '/sections/2': disc('01JM3SKC000000000000000001', 10, 20),
              },
            },
          );
          const fp = ss.fingerprints(loft.shape);
          // The seam (meridian) is the B-spline edge off the axis; the section circles sit on it.
          const seam = fp.edges.findIndex(
            (e) => e.curve === 'bspline' && Math.abs(e.centroid[0]) > 1,
          );
          expect(seam).toBeGreaterThanOrEqual(0);
          const c = only(project(loft.shape, [seam], XZ));
          expect(c.kind).toBe('polyline');
          if (c.kind === 'polyline') {
            const ends = [c.points[0], c.points[c.points.length - 1]].map((v) =>
              (v ?? []).map((x) => Math.round(x * 1e6) / 1e6).join(),
            );
            expect(ends.sort()).toEqual(['10,0', '10,20']);
            const middle = c.points.reduce((best, p) =>
              Math.abs(p[1] - 10) < Math.abs(best[1] - 10) ? p : best,
            );
            expect(Math.abs(middle[0] - 5)).toBeLessThan(0.01);
          }
          const down = only(project(loft.shape, [seam], XY));
          expect(down.kind).toBe('line');
        });

        it('face outline: outer loop in wire order, inner loops; errors are structured', () => {
          const ss = session();
          const sk = ss.exec(
            sketch(SK, [...rect(0, 0, 40, 30), ...circle('h', 20, 15, 5)]),
            sketchInputs(),
          );
          const ex = ss.exec(extrude(EX), {
            values: { '/end/depth': 10 },
            refs: profileRefs(sk.shape, [indexOf(sk, `${S}:region(L1,L2,L3,L4|h)`, 'face')]),
          });
          const top = indexOf(ex, `${E}:end`, 'face');
          const outline = ok<ProjectedOutline>(
            k.projectFaceOutline(JSON.stringify({ shape: ex.shape, face: top, plane: XY })),
          );
          expect(outline.outer.length).toBe(4);
          expect(outline.outer.every((e) => e.curves[0]?.kind === 'line')).toBe(true);
          // Consecutive edges share end points (wire order).
          const ends = outline.outer.map((e) => {
            const c = e.curves[0];
            return c?.kind === 'line' ? [c.a.join(), c.b.join()] : [];
          });
          for (let i = 0; i < 4; i++) {
            const next = ends[(i + 1) % 4] ?? [];
            expect((ends[i] ?? []).some((p) => next.includes(p))).toBe(true);
          }
          expect(outline.inner.length).toBe(1);
          expect(outline.inner[0]?.[0]?.curves).toEqual([{ kind: 'circle', c: [20, 15], r: 5 }]);
          const parse = (json: string) => JSON.parse(json) as Result<unknown>;
          const codes = [
            parse(k.projectEdges(JSON.stringify({ shape: ex.shape, edges: [999], plane: XY }))),
            parse(k.projectEdges(JSON.stringify({ shape: 987654, edges: [0], plane: XY }))),
            parse(k.projectFaceOutline(JSON.stringify({ shape: ex.shape, face: 0 }))),
            parse(k.projectEdges('nope')),
          ].map((r) => (r.ok ? 'ok' : (r.error as KernelError).code));
          expect(codes).toEqual([
            'UNRESOLVED_REFERENCE',
            'INVALID_HANDLE',
            'INVALID_INPUT',
            'INVALID_INPUT',
          ]);
        });
      });

      // -------------------------------------------------------------------------------------
      // Fillet / chamfer propagate
      // -------------------------------------------------------------------------------------

      describe('fillet and chamfer propagate', () => {
        const botTop = `edge(${E}:end|${E}:side(${S}:e(bot)))`;
        const blend = (type: 'fillet' | 'chamfer', propagate?: boolean): Feature =>
          ({
            id: FI,
            type,
            name: type,
            suppressed: false,
            edges: [{ name: botTop, kind: 'edge' }],
            ...(type === 'fillet'
              ? { radius: '1' }
              : { mode: { kind: 'distance', distance: '1' } }),
            ...(propagate === undefined ? {} : { propagate }),
          }) as Feature;
        const inputs = (ex: RawFeatureResult, edgeName = botTop): FeatureInputs => ({
          values: { '/radius': 1, '/mode/distance': 1 },
          target: ex.shape,
          refs: {
            '/edges/0': { shape: ex.shape, kind: 'edge', index: indexOf(ex, edgeName, 'edge') },
          },
        });

        it('propagate (default): one straight edge of a slot fillets the whole tangent loop', () => {
          const ss = session();
          const { ex } = slot(ss);
          const r = ss.exec(blend('fillet'), inputs(ex));
          const k0 = (10 - 3 * PI) / (3 * (4 - PI)); // spandrel centroid offset / r
          const removed = (1 - PI / 4) * (2 * 20 + 2 * PI * (3 - k0));
          relClose(ss.mass(r.shape).volume, (120 + 9 * PI) * 5 - removed, REL);
          const fillets = names(r, 'face').filter((n) => n.startsWith(`F${FI}:fillet(`));
          expect(fillets.length).toBe(4);
          expect(ss.exec(blend('fillet', true), inputs(ex)).naming).toEqual(r.naming);
        });

        it('propagate: false refuses to stop at tangent edges (OCCT cannot), naming them', () => {
          const ss = session();
          const { ex } = slot(ss);
          for (const type of ['fillet', 'chamfer'] as const) {
            const e = ss.fail(blend(type, false), inputs(ex));
            expect(e.code).toBe('UNSUPPORTED_FEATURE');
            expect(e.message).toMatch(/tangent/);
            expect(e.entityRefs?.[0]).toBe(botTop);
            expect(new Set(e.entityRefs)).toEqual(
              new Set([
                botTop,
                `edge(${E}:end|${E}:side(${S}:e(ar)))`,
                `edge(${E}:end|${E}:side(${S}:e(top)))`,
                `edge(${E}:end|${E}:side(${S}:e(al)))`,
              ]),
            );
          }
          // Selecting the whole chain is the same as propagating.
          const all = ss.exec(blend('fillet', false), {
            ...inputs(ex),
            refs: Object.fromEntries(
              ['bot', 'ar', 'top', 'al'].map((id, i) => [
                `/edges/${i}`,
                {
                  shape: ex.shape,
                  kind: 'edge' as const,
                  index: indexOf(ex, `edge(${E}:end|${E}:side(${S}:e(${id})))`, 'edge'),
                },
              ]),
            ),
          });
          relClose(
            ss.mass(all.shape).volume,
            ss.mass(ss.exec(blend('fillet'), inputs(ex)).shape).volume,
            1e-12,
          );
        });

        it('propagate: false on an edge without tangent neighbours is a normal fillet', () => {
          const ss = session();
          const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
          const edgeName = `${B}:edge(face.xmin|face.ymin)`;
          const ref = {
            '/edges/0': {
              shape: box.shape,
              kind: 'edge' as const,
              index: indexOf(box, edgeName, 'edge'),
            },
          };
          const off = ss.exec(
            { ...blend('fillet', false), edges: [{ name: edgeName, kind: 'edge' }] } as Feature,
            {
              values: { '/radius': 2 },
              target: box.shape,
              refs: ref,
            },
          );
          relClose(ss.mass(off.shape).volume, 6000 - (1 - PI / 4) * 4 * 30, REL);
        });
      });
    },
  );
}
