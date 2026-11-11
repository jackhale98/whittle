/**
 * RP02 Stepped shaft (CSWA-like). Revolve, a concave fillet and an end chamfer.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  chamferArea,
  chamferCentroid,
  coneArea,
  edge,
  edgeName,
  gapArea,
  gapCentroid,
  origin,
  quarterArcArea,
  region,
  side,
  sum,
  term,
} from '../lib/geom';
import type { PartDef } from '../lib/types';
import { FRONT } from '../lib/views';

const PI = Math.PI;

export const rp02: PartDef = {
  id: 'rp02-stepped-shaft',
  no: 2,
  title: 'Stepped shaft',
  level: 'CSWA-like',
  summary:
    'A three-diameter steel shaft turned from one profile, with a shoulder fillet and an end chamfer.',
  material: 'whittle:structural-steel',
  dims: {
    d1: { value: 40, unit: 'mm', description: 'Diameter of the large (flange) section' },
    l1: { value: 15, unit: 'mm', description: 'Length of the large section' },
    d2: { value: 30, unit: 'mm', description: 'Diameter of the middle section' },
    l2: { value: 40, unit: 'mm', description: 'Length of the middle section' },
    d3: { value: 20, unit: 'mm', description: 'Diameter of the end section' },
    l3: { value: 30, unit: 'mm', description: 'Length of the end section' },
    fillet_r: {
      value: 3,
      unit: 'mm',
      description: 'Fillet radius in the corner between d1 shoulder and d2',
    },
    chamfer_c: {
      value: 2,
      unit: 'mm',
      description: 'Equal-distance chamfer on the outer edge of the end face',
    },
  },
  tags: ['revolve', 'fillet', 'chamfer', 'propagate'],
  method:
    'Exact. The blank is three cylinders. The fillet and the chamfer are corner pieces of a revolved profile, so Pappus gives their volumes: area of the cross-section times 2 pi times the radius of its centroid. The fillet gap area is (1 - pi/4) r^2 with its centroid 0.2234 r from both walls; the chamfer triangle has area c^2/2 and centroid c/3 from both legs. The surface area uses Pappus on each profile segment. Accuracy: floating point (1e-12 relative).',
  steps: (d) => {
    const R2 = d('d2') / 2;
    const l1 = d('l1');
    const H = d('l1') + d('l2') + d('l3');
    return [
      {
        tool: 'sketch',
        id: 'prof_sk',
        say: 'Sketch on Front (the XZ plane): the half profile of the shaft, from the axis out and back, closed along the axis.',
        on: origin('origin:XZ'),
        ops: [
          {
            op: 'polygon',
            id: 'L',
            pts: [
              ['0', '0'],
              ['d1/2', '0'],
              ['d1/2', 'l1'],
              ['d2/2', 'l1'],
              ['d2/2', 'l1+l2'],
              ['d3/2', 'l1+l2'],
              ['d3/2', 'l1+l2+l3'],
              ['0', 'l1+l2+l3'],
            ],
          },
        ],
      },
      {
        tool: 'revolve',
        id: 'shaft',
        say: 'Revolve the profile 360 degrees about the Z axis.',
        profile: [region('prof_sk', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'], [5, 0, 5])],
        axis: origin('origin:Z'),
        angle: '360 deg',
        direction: 'normal',
        op: 'new',
      },
      {
        tool: 'fillet',
        id: 'fil',
        say: 'Fillet the circular corner where the d1 shoulder meets the d2 cylinder, radius fillet_r.',
        edges: [
          edge(edgeName(side('shaft', 'prof_sk', 'L3'), side('shaft', 'prof_sk', 'L4')), [
            R2,
            0,
            l1,
          ]),
        ],
        radius: 'fillet_r',
        propagate: true,
      },
      {
        tool: 'chamfer',
        id: 'cham',
        say: 'Chamfer the outer edge of the end face by chamfer_c.',
        edges: [
          edge(edgeName(side('shaft', 'prof_sk', 'L6'), side('shaft', 'prof_sk', 'L7')), [
            d('d3') / 2,
            0,
            H,
          ]),
        ],
        mode: { kind: 'distance', distance: 'chamfer_c' },
        propagate: true,
      },
    ];
  },
  model: (d) => {
    const [R1, R2, R3] = [d('d1') / 2, d('d2') / 2, d('d3') / 2];
    const [l1, l2, l3] = [d('l1'), d('l2'), d('l3')];
    const r = d('fillet_r');
    const c = d('chamfer_c');
    const H = l1 + l2 + l3;
    const terms = [
      term('Large section', 'pi (d1/2)^2 l1', PI * R1 * R1 * l1),
      term('Middle section', 'pi (d2/2)^2 l2', PI * R2 * R2 * l2),
      term('End section', 'pi (d3/2)^2 l3', PI * R3 * R3 * l3),
      term(
        'Fillet (adds material)',
        '(1 - pi/4) r^2 x 2 pi (d2/2 + 0.2234 r)',
        gapArea(r) * 2 * PI * (R2 + gapCentroid(r)),
      ),
      term(
        'Chamfer (removes material)',
        '-(c^2/2) x 2 pi (d3/2 - c/3)',
        -chamferArea(c) * 2 * PI * (R3 - chamferCentroid(c)),
      ),
    ];
    // Lateral and flat areas of the finished profile, segment by segment.
    const area =
      PI * R1 * R1 + // bottom disc
      coneArea(R1, 0, R1, l1) + // large cylinder
      PI * (R1 * R1 - (R2 + r) ** 2) + // flat shoulder from R2 + r out to R1
      // the fillet surface: a quarter arc whose centroid is 2r/pi towards the corner
      // from the arc's centre, which sits at radius R2 + r
      quarterArcArea(r, R2 + r - (2 * r) / PI) +
      coneArea(R2, l1 + r, R2, l1 + l2) +
      PI * (R2 * R2 - R3 * R3) +
      coneArea(R3, l1 + l2, R3, H - c) +
      coneArea(R3, H - c, R3 - c, H) +
      PI * (R3 - c) ** 2;
    return {
      volume: sum(terms),
      area,
      bbox: { min: [-R1, -R1, 0], max: [R1, R1, H] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: d2 -> 32 mm', set: { d2: 32 } },
    { name: 'Stage 3: l2 -> 55 mm and fillet_r -> 4 mm', set: { l2: 55, fillet_r: 4 } },
    { name: 'Stage 4: d3 -> 24 mm and chamfer_c -> 3 mm', set: { d3: 24, chamfer_c: 3 } },
  ],
  draw: (d, dr) => {
    const [R1, R2, R3] = [d('d1') / 2, d('d2') / 2, d('d3') / 2];
    const [l1, l2, l3] = [d('l1'), d('l2'), d('l3')];
    const c = d('chamfer_c');
    const H = l1 + l2 + l3;
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    // View coordinates: x along the shaft axis (Z), y radial.
    const v = dr
      .view(
        {
          ...FRONT,
          // The shaft is drawn lying down: the front view turned a quarter turn clockwise.
          rotation: -90,
          axes: ['Z', '-X'],
        },
        62,
        120,
        3.4,
      )
      .caption(0, R1 + 22, 'Front');
    const outline: [number, number][] = [
      [0, 0],
      [0, R1],
      [l1, R1],
      [l1, R2],
      [l1 + l2, R2],
      [l1 + l2, R3],
      [H - c, R3],
      [H, R3 - c],
      [H, 0],
    ];
    v.path(outline);
    v.path(outline.map(([x, y]) => [x, -y] as [number, number]));
    v.line(-6, 0, H + 6, 0, 'center');
    v.dimH(0, -R1, l1, -R1, -8, dim('l1'));
    v.dimH(l1, -R2, l1 + l2, -R2, -8, dim('l2'));
    v.dimH(l1 + l2, -R3, H, -R3, -8, dim('l3'));
    v.dimV(0, -R1, 0, R1, -9, dim('d1'));
    v.dimV(l1 + l2 / 2, -R2, l1 + l2 / 2, R2, 0, dim('d2'));
    v.dimV(H, -R3, H, R3, 9, dim('d3'));
    v.leader(
      l1 + d('fillet_r'),
      R2 + d('fillet_r'),
      d('fillet_r'),
      135,
      14,
      dim('fillet_r'),
      'radius',
    );
    v.leader(H - c, R3, c, 90, 12, dim('chamfer_c'), 'chamfer');
  },
};
