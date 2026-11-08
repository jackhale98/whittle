/**
 * The M1 acceptance part (PLAN §12): an L-bracket with holes, fillets and a chamfer, every
 * dimension driven by a parameter. Shared by the bracket golden test, the export round trip and
 * the timing report.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRef, Feature } from '@whittle/contracts';
import {
  chamfer,
  edge,
  edgeName,
  extrude,
  fid,
  fillet,
  makeDoc,
  region,
  Sk,
  side,
} from './helpers';

export const B = {
  S1: fid('BS1'),
  E1: fid('BE1'),
  S2: fid('BS2'),
  E2: fid('BE2'),
  S3: fid('BS3'),
  E3: fid('BE3'),
  F1: fid('BF1'),
  F2: fid('BF2'),
  C1: fid('BC1'),
};

export const BRACKET_PARAMS = {
  width: '80 mm',
  depth: '50 mm',
  thickness: '8 mm',
  hole_d: '6 mm',
  hole_spacing: '40 mm',
  height: '40 mm',
  corner_r: '5 mm',
  bend_r: '3 mm',
  chamfer_d: '2 mm',
};

export interface BracketDims {
  width: number;
  depth: number;
  thickness: number;
  hole_d: number;
  hole_spacing: number;
  height: number;
  corner_r: number;
  bend_r: number;
  chamfer_d: number;
}

export const BRACKET_DIMS: BracketDims = {
  width: 80,
  depth: 50,
  thickness: 8,
  hole_d: 6,
  hole_spacing: 40,
  height: 40,
  corner_r: 5,
  bend_r: 3,
  chamfer_d: 2,
};

/** Independent analytic volume of the bracket. */
export function bracketVolume(d: BracketDims): number {
  const k = 1 - Math.PI / 4;
  return (
    d.width * d.depth * d.thickness - // base plate
    2 * Math.PI * (d.hole_d / 2) ** 2 * d.thickness - // two through holes
    2 * k * d.corner_r ** 2 * d.thickness + // two rounded outer vertical edges
    d.width * d.thickness * d.height + // upright
    k * d.bend_r ** 2 * d.width - // concave fillet in the bend adds material
    0.5 * d.chamfer_d ** 2 * d.width // chamfer on the upright's top front edge
  );
}

/** Top face of the base plate, as the user picked it (fingerprint at the original size). */
export const plateTop: EntityRef = {
  name: `F${B.E1}:end`,
  kind: 'face',
  fingerprint: { centroid: [40, 25, 8], normal: [0, 0, 1], area: 4000 },
};

export function bracketFeatures(): Feature[] {
  const { S1, E1, S2, E2, S3, E3, F1, F2, C1 } = B;
  // Base plate outline.
  const s1 = new Sk();
  const r1 = s1.rect('p', 'L', 0, 0, 80, 50, 'width', 'depth');
  s1.geo({ kind: 'fix', entity: r1.a });

  // Holes, sketched on the plate's top face.
  const s2 = new Sk();
  s2.point('o', 0, 0, true);
  s2.geo({ kind: 'fix', entity: 'o' });
  for (const [h, x, ex] of [
    ['H1', 20, 'width/2 - hole_spacing/2'],
    ['H2', 60, 'width/2 + hole_spacing/2'],
  ] as const) {
    s2.circle(h, x, 21, 3);
    s2.dim({ kind: 'diameter', curve: h }, 'hole_d');
    s2.dim({ kind: 'hDistance', a: 'o', b: `${h}c` }, ex);
    s2.dim({ kind: 'vDistance', a: 'o', b: `${h}c` }, '(depth - thickness)/2');
  }

  // Upright footprint along the back edge, sketched on the plate's top face.
  const s3 = new Sk();
  s3.point('o', 0, 0, true);
  s3.geo({ kind: 'fix', entity: 'o' });
  const r3 = s3.rect('q', 'M', 0, 42, 80, 50, 'width', 'thickness');
  s3.geo({ kind: 'verticalPoints', a: 'o', b: r3.a });
  s3.dim({ kind: 'vDistance', a: 'o', b: r3.a }, 'depth - thickness');

  return [
    s1.feature(S1),
    extrude(E1, [region(S1, 'L1,L2,L3,L4')], 'thickness'),
    s2.feature(S2, plateTop, 'Holes'),
    extrude(E2, [region(S2, 'H1'), region(S2, 'H2')], 'throughAll', 'cut', 'reverse'),
    s3.feature(S3, plateTop, 'Upright'),
    extrude(E3, [region(S3, 'M1,M2,M3,M4')], 'height', 'add'),
    fillet(
      F1,
      [
        edge(edgeName(side(E1, S1, 'L4'), side(E1, S1, 'L1'))),
        edge(edgeName(side(E1, S1, 'L1'), side(E1, S1, 'L2'))),
      ],
      'corner_r',
    ),
    fillet(F2, [edge(edgeName(`F${E1}:end`, side(E3, S3, 'M1')))], 'bend_r'),
    chamfer(C1, [edge(edgeName(`F${E3}:end`, side(E3, S3, 'M1')))], 'chamfer_d'),
  ];
}

export function bracketDoc() {
  return makeDoc(BRACKET_PARAMS, bracketFeatures());
}
