/**
 * M4 `subShapeGeometry` golden tests (whittle_kernel.h): exact plane, cylinder, sphere, line,
 * circle and vertex geometry in one call, for the annotation resolver. Golden numbers are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SubShapeGeometry, WhittleKernelModule } from '../src/index';
import {
  boxFeature,
  boxValues,
  err,
  frameAt,
  indexOf,
  loadVariant,
  ok,
  type RawFeatureResult,
  relClose,
  Session,
  suiteTitle,
  VARIANTS,
  variantBuilt,
  vecClose,
} from './helpers';

const BOX = '01JBOX0000000000000000GEO1';
const CYL = '01JCYL0000000000000000GEO2';
const SPH = '01JSPH0000000000000000GEO3';
const HOLE = '01JHOLE000000000000000GEO4';
const PI = Math.PI;

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('subShapeGeometry', variant), () => {
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

    const geo = (
      r: RawFeatureResult,
      kind: 'face' | 'edge' | 'vertex',
      name: string,
    ): SubShapeGeometry => {
      expect(typeof k.subShapeGeometry).toBe('function');
      return ok<SubShapeGeometry>(
        k.subShapeGeometry?.(r.shape, kind, indexOf(r, name, kind)) ?? '',
      );
    };

    const primitive = (id: string, shape: 'cylinder' | 'sphere', extra: object): Feature =>
      ({
        id,
        type: 'primitive',
        name: 'P',
        suppressed: false,
        op: 'new',
        shape,
        ...extra,
      }) as Feature;

    it('box: plane faces with outward normals, line edges, vertices', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(10, 20, 30));
      const top = geo(box, 'face', `F${BOX}:face.zmax`);
      expect(top).toMatchObject({ kind: 'face', surface: 'plane' });
      if (top.kind !== 'face' || top.surface !== 'plane') return;
      vecClose(top.normal, [0, 0, 1], 1e-12);
      relClose(top.origin[2], 30, 1e-12);
      const left = geo(box, 'face', `F${BOX}:face.xmin`);
      if (left.kind === 'face' && left.surface === 'plane')
        vecClose(left.normal, [-1, 0, 0], 1e-12);
      const edge = geo(box, 'edge', `F${BOX}:edge(face.xmin|face.ymin)`);
      expect(edge).toMatchObject({ kind: 'edge', curve: 'line' });
      if (edge.kind !== 'edge' || edge.curve !== 'line') return;
      relClose(edge.length, 30, 1e-12);
      expect(Math.abs(edge.direction[2])).toBeCloseTo(1, 12);
      vecClose([edge.start[0], edge.start[1]], [0, 0], 1e-12);
      const v = geo(box, 'vertex', `F${BOX}:vertex(max,max,max)`);
      expect(v.kind).toBe('vertex');
      if (v.kind === 'vertex') vecClose(v.point, [10, 20, 30], 1e-12);
    });

    it('cylinder: axis, radius, axial extent, convex side; circle edges', () => {
      const ss = session();
      const cyl = ss.exec(primitive(CYL, 'cylinder', { radius: '3', height: '7' }), {
        values: { '/radius': 3, '/height': 7 },
      });
      const side = geo(cyl, 'face', `F${CYL}:face.side`);
      expect(side).toMatchObject({ kind: 'face', surface: 'cylinder', concave: false });
      if (side.kind !== 'face' || side.surface !== 'cylinder') return;
      relClose(side.radius, 3, 1e-12);
      expect(Math.abs(side.axis[2])).toBeCloseTo(1, 12);
      vecClose([side.origin[0], side.origin[1]], [0, 0], 1e-12);
      // The axial extent, measured from the origin along the axis, covers z ∈ [0, 7].
      const zs = side.extent.map((t) => side.origin[2] + t * side.axis[2]).sort((a, b) => a - b);
      vecClose([zs[0] ?? Number.NaN, zs[1] ?? Number.NaN], [0, 7], 1e-9);
      const rim = geo(cyl, 'edge', `F${CYL}:edge(face.side|face.zmax)`);
      expect(rim).toMatchObject({ kind: 'edge', curve: 'circle', full: true });
      if (rim.kind !== 'edge' || rim.curve !== 'circle') return;
      relClose(rim.radius, 3, 1e-12);
      vecClose(rim.center, [0, 0, 7], 1e-12);
      expect(Math.abs(rim.normal[2])).toBeCloseTo(1, 12);
      relClose(rim.endAngle - rim.startAngle, 2 * PI, 1e-12);
    });

    it('a hole wall is concave; a sphere is convex', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(10, 10, 10));
      const holed = ss.exec(
        {
          ...primitive(HOLE, 'cylinder', { radius: '2', height: '10', frame: frameAt([5, 5, 0]) }),
          op: 'cut',
        } as Feature,
        { values: { '/radius': 2, '/height': 10 }, target: box.shape },
      );
      const wall = geo(holed, 'face', `F${HOLE}:face.side`);
      expect(wall).toMatchObject({ kind: 'face', surface: 'cylinder', concave: true });
      if (wall.kind === 'face' && wall.surface === 'cylinder') {
        relClose(wall.radius, 2, 1e-12);
        vecClose([wall.origin[0], wall.origin[1]], [5, 5], 1e-12);
      }
      const sph = ss.exec(primitive(SPH, 'sphere', { radius: '2' }), { values: { '/radius': 2 } });
      const faceName = sph.naming.find((n) => n.kind === 'face')?.name ?? '';
      const ball = geo(sph, 'face', faceName);
      expect(ball).toMatchObject({ kind: 'face', surface: 'sphere', concave: false });
      if (ball.kind === 'face' && ball.surface === 'sphere') {
        relClose(ball.radius, 2, 1e-12);
        vecClose(ball.center, [0, 0, 0], 1e-12);
      }
    });

    it('bad kinds, indices and handles are structured errors', () => {
      const ss = session();
      const box = ss.exec(boxFeature(BOX), boxValues(1, 1, 1));
      expect(err(k.subShapeGeometry?.(box.shape, 'face', 6) ?? '').code).toBe('INVALID_INPUT');
      expect(err(k.subShapeGeometry?.(box.shape, 'face', -1) ?? '').code).toBe('INVALID_INPUT');
      expect(err(k.subShapeGeometry?.(box.shape, 'solid' as 'face', 0) ?? '').code).toBe(
        'INVALID_INPUT',
      );
      expect(err(k.subShapeGeometry?.(424242, 'edge', 0) ?? '').code).toBe('INVALID_HANDLE');
    });
  });
}
