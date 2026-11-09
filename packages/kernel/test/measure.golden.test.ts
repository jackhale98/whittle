/**
 * M2 measure golden tests (contracts `Measurement`, ADR-009 §4): exact B-rep distances, angles,
 * lengths, areas, radii and positions. Golden numbers are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Measurement } from '@wren-cad/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MeasureQuery, MeasureSubject, WhittleKernelModule } from '../src/index';
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

const BOX = '01JBOX00000000000000000001';
const B2 = '01JBOX00000000000000000002';
const CYL = '01JCYLINDER000000000000001';
const PI = Math.PI;

for (const { variant } of VARIANTS) {
  describe.skipIf(!variantBuilt(variant))(suiteTitle('measure', variant), () => {
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

    const measure = (a: MeasureSubject, b?: MeasureSubject): Measurement => {
      const q: MeasureQuery = b === undefined ? { a } : { a, b };
      return ok<Measurement>(k.measure(JSON.stringify(q)));
    };

    const sub = (
      r: RawFeatureResult,
      kind: 'face' | 'edge' | 'vertex',
      name: string,
    ): MeasureSubject => ({ shape: r.shape, kind, index: indexOf(r, name, kind) });

    const box = (ss: Session) => ss.exec(boxFeature(BOX), boxValues(40, 30, 10));
    const f = (role: string) => `F${BOX}:face.${role}`;
    const e = (a: string, b: string) => `F${BOX}:edge(face.${a}|face.${b})`;

    describe('one target: intrinsic values', () => {
      it('face area, edge length, vertex and point positions on a box', () => {
        const ss = session();
        const b = box(ss);
        const top = measure(sub(b, 'face', f('zmax')));
        expect(Object.keys(top)).toEqual(['area']);
        relClose(top.area ?? 0, 1200, 1e-12);
        relClose(measure(sub(b, 'face', f('xmin'))).area ?? 0, 300, 1e-12);
        const vertical = measure(sub(b, 'edge', e('xmin', 'ymin')));
        relClose(vertical.length ?? 0, 10, 1e-12);
        expect(vertical.radius).toBeUndefined();
        relClose(measure(sub(b, 'edge', e('ymin', 'zmax'))).length ?? 0, 40, 1e-12);
        const corner = measure(sub(b, 'vertex', `F${BOX}:vertex(max,max,max)`));
        vecClose(corner.position ?? [], [40, 30, 10], 1e-12);
        expect(measure({ point: [1, 2, 3] })).toEqual({ position: [1, 2, 3] });
        relClose(measure({ shape: b.shape, kind: 'body', index: 0 }).area ?? 0, 2 * 1900, 1e-12);
      });

      it('radius of cylindrical faces and circular edges', () => {
        const ss = session();
        const cyl = ss.exec(
          {
            id: CYL,
            type: 'primitive',
            name: 'Cylinder',
            suppressed: false,
            op: 'new',
            shape: 'cylinder',
            radius: '3',
            height: '7',
            frame: frameAt([10, 0, 0]),
          },
          { values: { '/radius': 3, '/height': 7 } },
        );
        const side = measure(sub(cyl, 'face', `F${CYL}:face.side`));
        relClose(side.radius ?? 0, 3, 1e-12);
        relClose(side.area ?? 0, 2 * PI * 3 * 7, 1e-9);
        const rim = measure(sub(cyl, 'edge', `F${CYL}:edge(face.side|face.zmax)`));
        relClose(rim.radius ?? 0, 3, 1e-12);
        relClose(rim.length ?? 0, 6 * PI, 1e-9);
        const cap = measure(sub(cyl, 'face', `F${CYL}:face.zmax`));
        relClose(cap.area ?? 0, 9 * PI, 1e-9);
        expect(cap.radius).toBeUndefined();
        // Distance from the axis to the side wall is the radius.
        const d = measure({ point: [10, 0, 3.5] }, sub(cyl, 'face', `F${CYL}:face.side`));
        relClose(d.distance?.value ?? 0, 3, 1e-9);
        expect(d.angle).toBeUndefined();
      });
    });

    describe('two targets: distance and angle', () => {
      it('opposite, adjacent and identical faces', () => {
        const ss = session();
        const b = box(ss);
        const opposite = measure(sub(b, 'face', f('zmax')), sub(b, 'face', f('zmin')));
        relClose(opposite.distance?.value ?? 0, 10, 1e-12);
        expect(opposite.distance?.a[2]).toBeCloseTo(10, 12);
        expect(opposite.distance?.b[2]).toBeCloseTo(0, 12);
        relClose(opposite.angle ?? 0, PI, 1e-12);
        const adjacent = measure(sub(b, 'face', f('zmax')), sub(b, 'face', f('xmax')));
        expect(adjacent.distance?.value).toBeCloseTo(0, 12);
        relClose(adjacent.angle ?? 0, PI / 2, 1e-12);
        const same = measure(sub(b, 'face', f('ymin')), sub(b, 'face', f('ymin')));
        expect(same.distance?.value).toBeCloseTo(0, 12);
        expect(same.angle).toBeCloseTo(0, 12);
        // Intrinsic fields belong to one-target queries only.
        expect(opposite.area).toBeUndefined();
      });

      it('faces of two bodies: gap and closest points', () => {
        const ss = session();
        const a = box(ss);
        const other = ss.exec(boxFeature(B2, frameAt([50, 0, 0])), boxValues(5, 5, 5));
        const m = measure(sub(a, 'face', f('xmax')), {
          shape: other.shape,
          kind: 'face',
          index: indexOf(other, `F${B2}:face.xmin`, 'face'),
        });
        relClose(m.distance?.value ?? 0, 10, 1e-12);
        expect(m.distance?.a[0]).toBeCloseTo(40, 12);
        expect(m.distance?.b[0]).toBeCloseTo(50, 12);
        relClose(m.angle ?? 0, PI, 1e-12);
        const bodies = measure(
          { shape: a.shape, kind: 'body', index: 0 },
          { shape: other.shape, kind: 'body', index: 0 },
        );
        relClose(bodies.distance?.value ?? 0, 10, 1e-12);
      });

      it('edges: corner angle, parallel lines, edge against a face', () => {
        const ss = session();
        const b = box(ss);
        const front = sub(b, 'edge', e('ymin', 'zmin'));
        const side = sub(b, 'edge', e('xmin', 'zmin'));
        const corner = measure(front, side);
        relClose(corner.angle ?? 0, PI / 2, 1e-12);
        expect(corner.distance?.value).toBeCloseTo(0, 12);
        vecClose(corner.distance?.a ?? [], [0, 0, 0], 1e-9);
        const parallel = measure(front, sub(b, 'edge', e('ymax', 'zmin')));
        expect(parallel.angle).toBeCloseTo(0, 12);
        relClose(parallel.distance?.value ?? 0, 30, 1e-12);
        const skew = measure(front, sub(b, 'edge', e('xmax', 'zmax')));
        relClose(skew.angle ?? 0, PI / 2, 1e-12);
        relClose(skew.distance?.value ?? 0, 10, 1e-12);
        const vertical = sub(b, 'edge', e('xmin', 'ymin'));
        const toTop = measure(vertical, sub(b, 'face', f('zmax')));
        relClose(toTop.angle ?? 0, PI / 2, 1e-12);
        const inPlane = measure(sub(b, 'face', f('zmax')), sub(b, 'edge', e('ymin', 'zmax')));
        expect(inPlane.angle).toBeCloseTo(0, 12);
      });

      it('points and vertices', () => {
        const ss = session();
        const b = box(ss);
        const above = measure({ point: [20, 15, 25] }, sub(b, 'face', f('zmax')));
        relClose(above.distance?.value ?? 0, 15, 1e-12);
        vecClose(above.distance?.a ?? [], [20, 15, 25], 1e-12);
        vecClose(above.distance?.b ?? [], [20, 15, 10], 1e-9);
        expect(above.angle).toBeUndefined();
        const diagonal = measure(
          sub(b, 'vertex', `F${BOX}:vertex(min,min,min)`),
          sub(b, 'vertex', `F${BOX}:vertex(max,max,max)`),
        );
        relClose(diagonal.distance?.value ?? 0, Math.sqrt(40 * 40 + 30 * 30 + 10 * 10), 1e-12);
        const pts = measure({ point: [0, 0, 0] }, { point: [3, 4, 0] });
        relClose(pts.distance?.value ?? 0, 5, 1e-12);
        // A point inside the solid is at distance 0 from the body.
        const inside = measure({ point: [20, 15, 5] }, { shape: b.shape, kind: 'body', index: 0 });
        expect(inside.distance?.value).toBeCloseTo(0, 12);
      });
    });

    it('errors are structured and leak nothing', () => {
      const ss = session();
      const b = box(ss);
      expect(err(k.measure('{')).code).toBe('INVALID_INPUT');
      expect(err(k.measure('{}')).code).toBe('INVALID_INPUT');
      expect(err(k.measure('[]')).code).toBe('INVALID_INPUT');
      expect(
        err(k.measure(JSON.stringify({ a: { shape: 424242, kind: 'face', index: 0 } }))).code,
      ).toBe('INVALID_HANDLE');
      expect(
        err(k.measure(JSON.stringify({ a: { shape: b.shape, kind: 'face', index: 6 } }))).code,
      ).toBe('UNRESOLVED_REFERENCE');
      expect(
        err(k.measure(JSON.stringify({ a: { shape: b.shape, kind: 'solid', index: 0 } }))).code,
      ).toBe('INVALID_INPUT');
      expect(err(k.measure(JSON.stringify({ a: { point: [0, 'x', 0] } }))).code).toBe(
        'INVALID_INPUT',
      );
    });
  });
}
