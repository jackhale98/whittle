/**
 * Geometric-compare fixture pairs (PLAN §12 M2.5 acceptance: "the geometric diff marks the correct
 * added and removed regions on 5 fixture pairs"). Each pair is (A = before, B = after) with the
 * analytic volumes and bounding boxes of the regions B adds and removes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Feature, Vec3, WrenDoc } from '@wren-cad/contracts';
import { edge, edgeName, extrude, fid, fillet, makeDoc, region, Sk, side } from './helpers';

const PI = Math.PI;

const S1 = fid('CS1');
const E1 = fid('CE1');
const S2 = fid('CS2');
const E2 = fid('CE2');
const FI = fid('CFI');

/** A box w × d × h as sketch rectangle (corner at the origin) + extrude; `h` is an expression. */
function boxFeatures(w: number, d: number, h: string, sketch = S1, ext = E1, x0 = 0): Feature[] {
  const sk = new Sk();
  const r = sk.rect('p', 'L', x0, 0, x0 + w, d, `${w} mm`, `${d} mm`);
  sk.geo({ kind: 'fix', entity: r.a });
  return [sk.feature(sketch), extrude(ext, [region(sketch, 'L1,L2,L3,L4')], h)];
}

/** A through hole of radius `r` at (x, y) cut from the existing body. */
function holeFeatures(x: number, y: number, r: number): Feature[] {
  const sk = new Sk();
  sk.circle('C', x, y, r);
  sk.geo({ kind: 'fix', entity: 'Cc' });
  sk.dim({ kind: 'radius', curve: 'C' }, `${r} mm`);
  return [sk.feature(S2), extrude(E2, [region(S2, 'C')], 'throughAll', 'cut')];
}

export interface Region {
  volume: number;
  /** Exact bounding box of the region, or null when it is empty. */
  bbox: { min: Vec3; max: Vec3 } | null;
  /** B-rep face count of the region, when it is meaningful. */
  faces?: number;
}

export interface FixturePair {
  name: string;
  a: WrenDoc;
  b: WrenDoc;
  added: Region;
  removed: Region;
  /** Volumes of each side (union of its solids). */
  volumeA: number;
  volumeB: number;
}

const EMPTY: Region = { volume: 0, bbox: null };

/** 1. Box 40 × 30 × 10 → 15 tall: adds a 40 × 30 × 5 slab on top, removes nothing. */
export function tallerBox(): FixturePair {
  const params = { h: '10 mm' };
  const a = makeDoc(params, boxFeatures(40, 30, 'h'));
  const b = makeDoc({ h: '15 mm' }, boxFeatures(40, 30, 'h'));
  return {
    name: 'box → taller box',
    a,
    b,
    added: { volume: 40 * 30 * 5, bbox: { min: [0, 0, 10], max: [40, 30, 15] }, faces: 6 },
    removed: EMPTY,
    volumeA: 40 * 30 * 10,
    volumeB: 40 * 30 * 15,
  };
}

/** 2. Plate 80 × 50 × 8 → the same plate with an r 5 through hole at (40, 25): removes a cylinder. */
export function plateWithHole(): FixturePair {
  const plate = 80 * 50 * 8;
  const cyl = PI * 25 * 8;
  return {
    name: 'plate → plate with a hole',
    a: makeDoc({}, boxFeatures(80, 50, '8 mm')),
    b: makeDoc({}, [...boxFeatures(80, 50, '8 mm'), ...holeFeatures(40, 25, 5)]),
    added: EMPTY,
    removed: { volume: cyl, bbox: { min: [35, 20, 0], max: [45, 30, 8] }, faces: 3 },
    volumeA: plate,
    volumeB: plate - cyl,
  };
}

/** 3. The r 5 hole moves from x = 20 to x = 60: fills the old hole, removes the new one. */
export function movedHole(): FixturePair {
  const plate = 80 * 50 * 8;
  const cyl = PI * 25 * 8;
  return {
    name: 'a hole moved',
    a: makeDoc({}, [...boxFeatures(80, 50, '8 mm'), ...holeFeatures(20, 25, 5)]),
    b: makeDoc({}, [...boxFeatures(80, 50, '8 mm'), ...holeFeatures(60, 25, 5)]),
    added: { volume: cyl, bbox: { min: [15, 20, 0], max: [25, 30, 8] }, faces: 3 },
    removed: { volume: cyl, bbox: { min: [55, 20, 0], max: [65, 30, 8] }, faces: 3 },
    volumeA: plate - cyl,
    volumeB: plate - cyl,
  };
}

/**
 * 4. Box 40 × 30 × 10 with a fillet on the vertical edge at (40, 0), radius 2 → 3. The larger
 * fillet removes the sliver between the two fillet surfaces: (1 − π/4)(3² − 2²) × 10 mm³.
 */
export function filletRadius(): FixturePair {
  const corner = edge(edgeName(side(E1, S1, 'L1'), side(E1, S1, 'L2')));
  const doc = (r: string) =>
    makeDoc({ r }, [...boxFeatures(40, 30, '10 mm'), fillet(FI, [corner], 'r')]);
  const box = 40 * 30 * 10;
  const lost = (r: number) => (1 - PI / 4) * r * r * 10;
  return {
    name: 'a fillet radius change',
    a: doc('2 mm'),
    b: doc('3 mm'),
    added: EMPTY,
    // Faces: the two fillet cylinders, two planar strips, the top and bottom caps.
    removed: { volume: lost(3) - lost(2), bbox: { min: [37, 0, 0], max: [40, 3, 10] }, faces: 6 },
    volumeA: box - lost(2),
    volumeB: box - lost(3),
  };
}

/** 5. Identical versions (the same document in both slots): an empty diff. */
export function identical(): FixturePair {
  const doc = makeDoc({ h: '10 mm' }, boxFeatures(40, 30, 'h'));
  return {
    name: 'identical versions',
    a: doc,
    b: structuredClone(doc),
    added: EMPTY,
    removed: EMPTY,
    volumeA: 40 * 30 * 10,
    volumeB: 40 * 30 * 10,
  };
}

/** Same geometry, different definition (depth `10 mm` vs `5 mm * 2`): booleans run, diff empty. */
export function sameGeometryRewritten(): FixturePair {
  return {
    name: 'same geometry, rewritten expression',
    a: makeDoc({}, boxFeatures(40, 30, '10 mm')),
    b: makeDoc({}, boxFeatures(40, 30, '5 mm * 2')),
    added: EMPTY,
    removed: EMPTY,
    volumeA: 40 * 30 * 10,
    volumeB: 40 * 30 * 10,
  };
}

/**
 * Multi-body: A has two overlapping bodies (x 0–20 and 10–30, 20 deep, 10 tall), B only the first.
 * Each side is unioned before cutting, so A's volume is 6000 (not 8000) and B removes x 20–30.
 */
export function overlappingBodies(): FixturePair {
  const first = (x0: number) => boxFeatures(20, 20, '10 mm', S1, E1, x0);
  const second = boxFeatures(20, 20, '10 mm', S2, E2, 10);
  return {
    name: 'overlapping bodies → one body',
    a: makeDoc({}, [...first(0), ...second]),
    b: makeDoc({}, first(0)),
    added: EMPTY,
    removed: { volume: 10 * 20 * 10, bbox: { min: [20, 0, 0], max: [30, 20, 10] }, faces: 6 },
    volumeA: 30 * 20 * 10,
    volumeB: 20 * 20 * 10,
  };
}

/** A side with no bodies yet (only a sketch) → a box: everything is added. */
export function fromNothing(): FixturePair {
  const box = boxFeatures(40, 30, '10 mm');
  return {
    name: 'no body → box',
    a: makeDoc({}, [box[0] as Feature]),
    b: makeDoc({}, box),
    added: { volume: 40 * 30 * 10, bbox: { min: [0, 0, 0], max: [40, 30, 10] }, faces: 6 },
    removed: EMPTY,
    volumeA: 0,
    volumeB: 40 * 30 * 10,
  };
}

/** The five acceptance pairs, in PLAN order. */
export const ACCEPTANCE_PAIRS = [tallerBox, plateWithHole, movedHole, filletRadius, identical];
