/**
 * Regen of a sketch dimensioned to the origin and axes (ADR-017 item 1): the engine re-solves with
 * the same solver core as sketch mode, so the geometry is identical, and the extrude follows the
 * origin dimensions. Real kernel, real planegcs.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS, type Vec3 } from '@whittle/contracts';
import { evaluateFeatureValues, sketchSolveValues } from '@whittle/document';
import { createSketchSolverCore } from '@whittle/sketch/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  describeFailures,
  extrude,
  fid,
  loadApi,
  makeDoc,
  part,
  region,
  relClose,
  Sk,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const S1 = fid('SR');
const E1 = fid('ER');
const PARAMS = { ox: '10 mm', oy: '5 mm', w: '80 mm', h: '50 mm', hole_x: '30 mm' };

/**
 * A rectangle drawn off target, anchored only by origin dimensions (no `fix`), and a hole whose
 * centre is dimensioned to the vertical axis and lies on a construction line along the horizontal
 * axis direction (parallel to `@x`).
 */
function sketch() {
  const sk = new Sk();
  const { a } = sk.rect('p', 'L', 13, 2, 87, 61, 'w', 'h');
  sk.dim({ kind: 'hDistance', a: SKETCH_ORIGIN, b: a }, 'ox');
  sk.dim({ kind: 'vDistance', a: SKETCH_ORIGIN, b: a }, 'oy');
  sk.circle('C1', 33, 27, 3);
  sk.dim({ kind: 'diameter', curve: 'C1' }, '8 mm');
  sk.dim({ kind: 'distance', a: 'C1c', b: SKETCH_Y_AXIS }, 'hole_x');
  sk.dim({ kind: 'vDistance', a: SKETCH_ORIGIN, b: 'C1c' }, '30 mm');
  sk.point('m1', 20, 40, true);
  sk.point('m2', 70, 41, true);
  sk.line('M', 'm1', 'm2', true);
  sk.geo({ kind: 'parallel', a: 'M', b: SKETCH_X_AXIS });
  sk.geo({ kind: 'pointOn', point: 'C1c', on: 'M' });
  sk.geo({ kind: 'pointOn', point: 'm1', on: SKETCH_Y_AXIS });
  sk.dim({ kind: 'length', line: 'M' }, '60 mm');
  return sk.feature(S1);
}

const doc = (params: Record<string, string> = {}) =>
  withParams(
    makeDoc(PARAMS, [sketch(), extrude(E1, [region(S1, 'L1,L2,L3,L4|C1')], '10 mm')]),
    params,
  );

describe.skipIf(!built)(
  `regen golden: sketch dimensioned to the origin and axes${skipNote}`,
  () => {
    let api: Api;
    beforeAll(async () => {
      api = await loadApi();
    }, 60_000);
    afterAll(async () => {
      await api?.closePart(fid('PART'));
    });

    it('solves like sketch mode does: identical geometry, analytic volume', async () => {
      const d = doc();
      const r = await api.regenerate({
        doc: d,
        partId: fid('PART'),
        quality: 'coarse',
        massProperties: true,
      });
      expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
      relClose(totalVolume(r.bodies), (80 * 50 - Math.PI * 16) * 10, 1e-9);

      // The sketch-mode path: the same values, the same solver core, in this process.
      const f = part(d).features[0];
      if (f?.type !== 'sketch') throw new Error('no sketch');
      const { values } = sketchSolveValues(f, evaluateFeatureValues(f, d));
      const solver = await createSketchSolverCore();
      const solved = solver.solve({ entities: f.entities, constraints: f.constraints, values });
      expect(solved.status).toBe('solved');
      expect(solved.dof).toBe(0);
      const pts = new Map(r.sketches[0]?.points?.map((p) => [p.entity, p.at] as [string, Vec3]));
      // References are never sketch output.
      for (const id of [SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS])
        expect(pts.has(id)).toBe(false);
      for (const e of solved.entities) {
        if (e.kind !== 'point') continue;
        const at = pts.get(e.id);
        expect(at, e.id).toBeDefined();
        expect(at?.[0]).toBe(e.x);
        expect(at?.[1]).toBe(e.y);
      }
      const at = (id: string) => pts.get(id) as Vec3;
      expect(at('pa')[0]).toBeCloseTo(10, 10);
      expect(at('pa')[1]).toBeCloseTo(5, 10);
      expect(at('pc')[0]).toBeCloseTo(90, 10);
      expect(at('pc')[1]).toBeCloseTo(55, 10);
      expect(at('C1c')[0]).toBeCloseTo(30, 10);
      expect(at('C1c')[1]).toBeCloseTo(30, 10);
      expect(at('m1')[0]).toBeCloseTo(0, 10);
      solver.dispose();
    });

    it('changing an origin dimension moves the body', async () => {
      const base = await api.regenerate({
        doc: doc(),
        partId: fid('PART'),
        quality: 'coarse',
        massProperties: true,
      });
      const moved = await api.regenerate({
        doc: doc({ ox: '25 mm' }),
        partId: fid('PART'),
        quality: 'coarse',
        massProperties: true,
      });
      expect(states(moved), describeFailures(moved)).toEqual(['ok', 'ok']);
      const c0 = base.bodies[0]?.massProperties?.centroid as Vec3;
      const c1 = moved.bodies[0]?.massProperties?.centroid as Vec3;
      // The plate moves 15 mm in x; the hole stays 30 mm from the vertical axis, so the hole's
      // offset inside the plate changes and the centroid moves a little less than 15 mm.
      expect(c1[1]).toBeCloseTo(c0[1], 8);
      const holeArea = Math.PI * 16;
      const plateArea = 80 * 50;
      const expected = (plateArea * 15) / (plateArea - holeArea);
      expect(c1[0] - c0[0]).toBeCloseTo(expected, 6);
      relClose(totalVolume(moved.bodies), (80 * 50 - Math.PI * 16) * 10, 1e-9);
    });
  },
);
