/**
 * Regen golden 2 (M1 acceptance, PLAN §7.3 item 5 / §12): the bracket. Build it, then change
 * three upstream dimensions (width, thickness, hole spacing) and check that every downstream
 * feature still resolves to the geometrically corresponding entities and the volume matches the
 * independent analytic expectation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BodyResult } from '@wren-cad/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { B, BRACKET_DIMS, type BracketDims, bracketDoc, bracketVolume } from './bracket';
import {
  type Api,
  built,
  describeFailures,
  edgeName,
  faceCentroid,
  facesStartingWith,
  fid,
  loadApi,
  relClose,
  side,
  skipNote,
  states,
  totalVolume,
  withParams,
} from './helpers';

const PART = fid('PART');

async function checkGeometry(api: Api, body: BodyResult, d: BracketDims) {
  const { E1, S1, E3, S3, F1, F2, C1 } = B;
  // Outer vertical fillets sit on the two front corners of the plate, at mid-thickness.
  const left = await faceCentroid(
    api,
    body,
    `F${F1}:fillet(${edgeName(side(E1, S1, 'L4'), side(E1, S1, 'L1'))})`,
  );
  const right = await faceCentroid(
    api,
    body,
    `F${F1}:fillet(${edgeName(side(E1, S1, 'L1'), side(E1, S1, 'L2'))})`,
  );
  expect(left, 'front-left fillet face').not.toBeNull();
  expect(right, 'front-right fillet face').not.toBeNull();
  const [lx, ly, lz] = left as number[];
  const [rx, ry, rz] = right as number[];
  expect(lx).toBeGreaterThan(0);
  expect(lx).toBeLessThan(d.corner_r);
  expect(ly).toBeLessThan(d.corner_r);
  expect(lz).toBeCloseTo(d.thickness / 2, 6);
  expect(rx).toBeGreaterThan(d.width - d.corner_r);
  expect(ry).toBeLessThan(d.corner_r);
  expect(rz).toBeCloseTo(d.thickness / 2, 6);
  // The bend fillet runs along the inside corner between the plate top and the upright.
  const bend = await faceCentroid(
    api,
    body,
    `F${F2}:fillet(${edgeName(`F${E1}:end`, side(E3, S3, 'M1'))})`,
  );
  expect(bend, 'bend fillet face').not.toBeNull();
  const [bx, by, bz] = bend as number[];
  expect(bx).toBeCloseTo(d.width / 2, 6);
  expect(by).toBeGreaterThan(d.depth - d.thickness - d.bend_r);
  expect(by).toBeLessThan(d.depth - d.thickness);
  expect(bz).toBeGreaterThan(d.thickness);
  expect(bz).toBeLessThan(d.thickness + d.bend_r);
  // The chamfer is on the top front edge of the upright.
  const ch = facesStartingWith(body, `F${C1}:chamfer(`);
  expect(ch).toHaveLength(1);
  const [cx, cy, cz] = (await faceCentroid(api, body, ch[0] as string)) as number[];
  expect(cx).toBeCloseTo(d.width / 2, 6);
  expect(cy).toBeCloseTo(d.depth - d.thickness + d.chamfer_d / 2, 6);
  expect(cz).toBeCloseTo(d.thickness + d.height - d.chamfer_d / 2, 6);
  // Two holes, at the hole spacing.
  const holes = body.mesh.faceNames.filter((n) => n.startsWith(`F${B.E2}:side(`));
  expect(holes).toHaveLength(2);
  const hc = await Promise.all(holes.map((n) => faceCentroid(api, body, n)));
  const xs = hc.map((c) => (c as number[])[0] as number).sort((a, b) => a - b);
  expect((xs[1] as number) - (xs[0] as number)).toBeCloseTo(d.hole_spacing, 6);
}

describe.skipIf(!built)(`regen golden: bracket, edit upstream${skipNote}`, () => {
  let api: Api;
  beforeAll(async () => {
    api = await loadApi();
  }, 60_000);
  afterAll(async () => {
    await api?.closePart(PART);
  });

  it('builds the bracket: every feature ok, analytic volume, corresponding geometry', async () => {
    const r = await api.regenerate({
      doc: bracketDoc(),
      partId: PART,
      quality: 'fine',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    expect(r.bodies).toHaveLength(1);
    const body = r.bodies[0] as BodyResult;
    relClose(totalVolume(r.bodies), bracketVolume(BRACKET_DIMS), 1e-7);
    await checkGeometry(api, body, BRACKET_DIMS);
    // Sketches on the plate's top face sit at z = thickness, with the deterministic frame.
    const upright = r.sketches.find((s) => s.featureId === B.S3);
    expect(upright?.frame.origin).toEqual([0, 0, 8]);
    expect(upright?.frame.x).toEqual([1, 0, 0]);
    expect(upright?.frame.z).toEqual([0, 0, 1]);
  });

  it('width, thickness and hole spacing change: all ok, refs follow, volume analytic', async () => {
    const doc = withParams(bracketDoc(), {
      width: '100 mm',
      thickness: '10 mm',
      hole_spacing: '60 mm',
    });
    const r = await api.regenerate({ doc, partId: PART, quality: 'fine', massProperties: true });
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    expect(r.features.every((f) => !f.cached)).toBe(true);
    const d: BracketDims = { ...BRACKET_DIMS, width: 100, thickness: 10, hole_spacing: 60 };
    relClose(totalVolume(r.bodies), bracketVolume(d), 1e-7);
    await checkGeometry(api, r.bodies[0] as BodyResult, d);
    expect(r.sketches.find((s) => s.featureId === B.S3)?.frame.origin).toEqual([0, 0, 10]);
  });

  it('the threaded kernel build regenerates the same bracket', async () => {
    const threaded = await loadApi(undefined, 'threaded');
    const doc = withParams(bracketDoc(), { width: '100 mm' });
    const r = await threaded.regenerate({
      doc,
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    relClose(totalVolume(r.bodies), bracketVolume({ ...BRACKET_DIMS, width: 100 }), 1e-7);
    // Engine-owned shapes cannot be released by callers.
    const shape = r.bodies[0]?.shape as number;
    await threaded.release(shape);
    expect((await threaded.massProperties(shape)).ok).toBe(true);
    await threaded.closePart(PART);
    expect(threaded.liveHandleCount()).toBe(0);
  });

  it('changing only the hole spacing recomputes the holes and what consumes them', async () => {
    const base = bracketDoc();
    await api.regenerate({ doc: base, partId: PART, quality: 'coarse', massProperties: true });
    const r = await api.regenerate({
      doc: withParams(base, { hole_spacing: '30 mm' }),
      partId: PART,
      quality: 'coarse',
      massProperties: true,
    });
    expect(states(r), describeFailures(r)).toEqual(Array(9).fill('ok'));
    // The upright sketch only depends on the top face's plane, which the holes don't move.
    expect(r.features.map((f) => f.cached)).toEqual([
      true, // plate sketch
      true, // plate
      false, // hole sketch (new dimension)
      false, // holes
      true, // upright sketch: same plane, same values
      false, // upright (input body changed)
      false,
      false,
      false,
    ]);
    relClose(totalVolume(r.bodies), bracketVolume({ ...BRACKET_DIMS, hole_spacing: 30 }), 1e-7);
  });
});
