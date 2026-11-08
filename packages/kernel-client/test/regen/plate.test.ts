/**
 * Regen golden 1: a parametric plate (sketch rectangle + 4 holes from params → extrude → fillet).
 * Real kernel, real planegcs. Volumes are analytic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature } from '@whittle/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  built,
  describeFailures,
  edge,
  edgeName,
  extrude,
  fid,
  fillet,
  loadApi,
  makeDoc,
  region,
  relClose,
  Sk,
  side,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const PI = Math.PI;
const S1 = fid('S1');
const E1 = fid('E1');
const FI = fid('FI');

/** Plate sketch: rectangle width × depth anchored at the origin, four holes inset from corners. */
export function plateSketch(id = S1) {
  const sk = new Sk();
  const { a, b, c, d } = sk.rect('p', 'L', 0, 0, 80, 50, 'width', 'depth');
  sk.geo({ kind: 'fix', entity: a });
  const holes: [string, string, number, number][] = [
    ['C1', a, 10, 10],
    ['C2', b, 70, 10],
    ['C3', c, 70, 40],
    ['C4', d, 10, 40],
  ];
  for (const [h, corner, x, y] of holes) {
    sk.circle(h, x, y, 3);
    sk.dim({ kind: 'diameter', curve: h }, 'hole_d');
    const sx = x < 40 ? 1 : -1;
    const sy = y < 25 ? 1 : -1;
    // Signed distances b − a from the corner to the centre.
    sk.dim({ kind: 'hDistance', a: corner, b: `${h}c` }, sx > 0 ? 'hole_inset' : '-hole_inset');
    sk.dim({ kind: 'vDistance', a: corner, b: `${h}c` }, sy > 0 ? 'hole_inset' : '-hole_inset');
  }
  return sk.feature(id);
}

export const PLATE_PARAMS = {
  width: '80 mm',
  depth: '50 mm',
  hole_d: '6 mm',
  hole_inset: '10 mm',
  thickness: '8 mm',
};

const plateRegion = region(S1, 'L1,L2,L3,L4|C1|C2|C3|C4');

function plateDoc(withFillet: boolean) {
  const features: Feature[] = [plateSketch(), extrude(E1, [plateRegion], 'thickness')];
  if (withFillet) {
    const verticals = [
      ['L1', 'L2'],
      ['L2', 'L3'],
      ['L3', 'L4'],
      ['L4', 'L1'],
    ].map(([x, y]) => edge(edgeName(side(E1, S1, x as string), side(E1, S1, y as string))));
    features.push(fillet(FI, verticals, '5 mm'));
  }
  return makeDoc(PLATE_PARAMS, features);
}

const plateVolume = (w: number, d: number, t: number, hd: number) =>
  w * d * t - 4 * PI * (hd / 2) ** 2 * t;

describe.skipIf(!built)(`regen golden: parametric plate${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(fid('PART'));
  });

  it('sketch + extrude: volume is analytic, regions and frame reported', async () => {
    const doc = plateDoc(false);
    const r = await api.regenerate({
      doc,
      partId: fid('PART'),
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    expect(r.bodies.map((b) => b.id)).toEqual([`B${E1}`]);
    relClose(totalVolume(r.bodies), plateVolume(80, 50, 8, 6), 1e-9);
    const sk = r.sketches[0];
    expect(sk?.featureId).toBe(S1);
    expect(sk?.regions.map((x) => x.name).sort()).toEqual(
      [
        plateRegion.name,
        `S${S1}:region(C1)`,
        `S${S1}:region(C2)`,
        `S${S1}:region(C3)`,
        `S${S1}:region(C4)`,
      ].sort(),
    );
    expect(sk?.curves.map((c) => c.entity).sort()).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'L1',
      'L2',
      'L3',
      'L4',
    ]);
    expect(sk?.frame.z).toEqual([0, 0, 1]);
    // Region fill meshes are real triangulations.
    expect(sk?.regions[0]?.mesh.indices.length).toBeGreaterThan(0);
  });

  it('params drive the sketch: width/hole changes re-solve and re-extrude', async () => {
    const doc = withParams(plateDoc(false), { width: '100 mm', hole_d: '8 mm', thickness: '5mm' });
    const r = await api.regenerate({
      doc,
      partId: fid('PART'),
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok']);
    relClose(totalVolume(r.bodies), plateVolume(100, 50, 5, 8), 1e-9);
    const bb = r.bodies[0]?.mesh.bbox;
    expect(bb?.max[0]).toBeCloseTo(100, 6);
    expect(bb?.max[2]).toBeCloseTo(5, 6);
  });

  it('fillet of the four vertical edges, r = 5', async () => {
    const r = await api.regenerate({
      doc: plateDoc(true),
      partId: fid('PART'),
      quality: 'fine',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(['ok', 'ok', 'ok']);
    relClose(totalVolume(r.bodies), plateVolume(80, 50, 8, 6) - 4 * (1 - PI / 4) * 25 * 8, 1e-9);
    const faces = r.bodies[0]?.mesh.faceNames ?? [];
    expect(faces.filter((n) => n.startsWith(`F${FI}:fillet(`))).toHaveLength(4);
  });
});
