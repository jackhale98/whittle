/**
 * RP03 Ball knob (CSWA-like). A sphere from a revolved semicircle, a stem, a flat cut from a
 * reference plane, and a chamfer.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  capVolume,
  chamferArea,
  chamferCentroid,
  edge,
  edgeName,
  origin,
  region,
  sum,
  term,
} from '../lib/geom';
import type { PartDef } from '../lib/types';
import { FRONT } from '../lib/views';

const PI = Math.PI;
const deg = (r: number): number => (r * 180) / PI;

export const rp03: PartDef = {
  id: 'rp03-ball-knob',
  no: 3,
  title: 'Ball knob',
  level: 'CSWA-like',
  summary:
    'A brass ball with a stem below it and a flat on top. The ball is a revolved semicircle; the flat is cut from a reference plane.',
  material: 'whittle:brass-c360',
  dims: {
    ball_d: { value: 50, unit: 'mm', description: 'Ball diameter' },
    stem_d: { value: 16, unit: 'mm', description: 'Stem diameter' },
    stem_l: { value: 40, unit: 'mm', description: 'Stem length below the ball centre' },
    flat_h: {
      value: 18,
      unit: 'mm',
      description: 'Height of the flat above the ball centre (reference plane offset)',
    },
    chamfer_c: { value: 1.5, unit: 'mm', description: 'Chamfer on the stem end' },
  },
  tags: ['revolve', 'sphere', 'extrude', 'cut', 'plane', 'chamfer'],
  method:
    'Exact closed forms: sphere 4/3 pi R^3; spherical cap pi h^2 (3R - h)/3; the part of the stem outside the ball is the cylinder minus its intersection with the ball, 2 pi/3 (R^3 - (R^2 - a^2)^(3/2)); the chamfer by Pappus. The surface area is a sum of a sphere zone, a flat disc, a cylinder, a cone and an end disc. Accuracy: floating point (1e-12 relative).',
  steps: (d) => {
    const R = d('ball_d') / 2;
    return [
      {
        tool: 'sketch',
        id: 'ball_sk',
        say: 'Sketch on Front (XZ): a semicircle centred on the origin, to the right of the Z axis, closed by a line along the axis.',
        on: origin('origin:XZ'),
        ops: [
          { op: 'point', id: 'pa', x: '0', y: '-ball_d/2' },
          { op: 'point', id: 'pb', x: '0', y: 'ball_d/2', dims: 'x' },
          { op: 'arc', id: 'A1', c: 'o', a: 'pa', b: 'pb' },
          { op: 'line', id: 'L1', a: 'pb', b: 'pa' },
        ],
      },
      {
        tool: 'revolve',
        id: 'ball',
        say: 'Revolve the half disc 360 degrees about the Z axis: a sphere.',
        profile: [region('ball_sk', ['A1', 'L1'], [R / 2, 0, 0])],
        axis: origin('origin:Z'),
        angle: '360 deg',
        direction: 'normal',
        op: 'new',
      },
      {
        tool: 'sketch',
        id: 'stem_sk',
        say: 'Sketch on Top (XY): a circle of stem_d at the origin.',
        on: origin('origin:XY'),
        ops: [{ op: 'circle', id: 'C', cx: '0', cy: '0', d: 'stem_d' }],
      },
      {
        tool: 'extrude',
        id: 'stem',
        say: 'Extrude the circle downwards by stem_l, adding to the ball.',
        profile: [region('stem_sk', ['C'], [0, 0, 0])],
        direction: 'reverse',
        end: { kind: 'blind', depth: 'stem_l' },
        op: 'add',
      },
      {
        tool: 'plane',
        id: 'flat_pl',
        say: 'Reference plane: offset flat_h above the Top plane.',
        definition: { kind: 'offset', from: origin('origin:XY'), distance: 'flat_h' },
      },
      {
        tool: 'sketch',
        id: 'flat_sk',
        say: 'Sketch on the new plane: a square, ball_d + 10 on a side, centred on the origin.',
        on: { pick: 'plane', name: 'F{flat_pl}:plane', at: [0, 0, d('flat_h')] },
        ops: [
          {
            op: 'rect',
            id: 'R',
            x: '-(ball_d+10)/2',
            y: '-(ball_d+10)/2',
            w: 'ball_d+10',
            h: 'ball_d+10',
          },
        ],
      },
      {
        tool: 'extrude',
        id: 'flat',
        say: 'Cut-extrude the square upwards through all: this removes the top of the ball.',
        profile: [region('flat_sk', ['R1', 'R2', 'R3', 'R4'], [R + 2, 0, d('flat_h')])],
        direction: 'normal',
        end: { kind: 'throughAll' },
        op: 'cut',
      },
      {
        tool: 'chamfer',
        id: 'cham',
        say: 'Chamfer the circular edge at the end of the stem by chamfer_c.',
        edges: [
          edge(edgeName('F{stem}:end', 'F{stem}:side(S{stem_sk}:e(C))'), [
            d('stem_d') / 2,
            0,
            -d('stem_l'),
          ]),
        ],
        mode: { kind: 'distance', distance: 'chamfer_c' },
        propagate: true,
      },
    ];
  },
  model: (d) => {
    const R = d('ball_d') / 2;
    const a = d('stem_d') / 2;
    const L = d('stem_l');
    const h = d('flat_h');
    const c = d('chamfer_c');
    const hc = R - h;
    const z0 = Math.sqrt(R * R - a * a);
    const terms = [
      term('Sphere', '4/3 pi R^3, R = ball_d/2', (4 / 3) * PI * R ** 3),
      term(
        'Flat: spherical cap removed',
        '-pi hc^2 (3R - hc)/3, hc = R - flat_h',
        -capVolume(R, hc),
      ),
      term(
        'Stem outside the ball',
        'pi a^2 stem_l - 2 pi/3 (R^3 - (R^2 - a^2)^(3/2)), a = stem_d/2',
        PI * a * a * L - ((2 * PI) / 3) * (R ** 3 - (R * R - a * a) ** 1.5),
      ),
      term(
        'Chamfer',
        '-(c^2/2) x 2 pi (a - c/3)',
        -chamferArea(c) * 2 * PI * (a - chamferCentroid(c)),
      ),
    ];
    const rho = Math.sqrt(R * R - h * h);
    const area =
      4 * PI * R * R -
      2 * PI * R * hc - // the cap
      2 * PI * R * (R - z0) + // the polar cap inside the stem
      PI * rho * rho + // the flat
      2 * PI * a * (L - z0 - c) + // stem side
      PI * (a + (a - c)) * c * Math.SQRT2 + // chamfer cone
      PI * (a - c) ** 2; // stem end disc
    return {
      volume: sum(terms),
      area,
      bbox: { min: [-R, -R, -L], max: [R, R, h] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: ball_d -> 60 mm', set: { ball_d: 60 } },
    { name: 'Stage 3: stem_d -> 20 mm and stem_l -> 55 mm', set: { stem_d: 20, stem_l: 55 } },
    { name: 'Stage 4: flat_h -> 10 mm', set: { flat_h: 10 } },
  ],
  draw: (d, dr) => {
    const R = d('ball_d') / 2;
    const a = d('stem_d') / 2;
    const L = d('stem_l');
    const h = d('flat_h');
    const c = d('chamfer_c');
    const z0 = Math.sqrt(R * R - a * a);
    const rho = Math.sqrt(R * R - h * h);
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    const v = dr.view(FRONT, 110, 120, 3.2).caption(-R, h + 20, 'Front');
    const aTop = deg(Math.atan2(h, rho));
    const aStemL = deg(Math.atan2(-z0, -a)) + 360;
    const aStemR = deg(Math.atan2(-z0, a)) + 360;
    v.arc(0, 0, R, 180 - aTop, aStemL);
    v.arc(0, 0, R, aStemR, 360 + aTop);
    v.line(-rho, h, rho, h);
    v.path([
      [-a, -z0],
      [-a, -L + c],
      [-a + c, -L],
      [a - c, -L],
      [a, -L + c],
      [a, -z0],
    ]);
    v.line(0, h + 8, 0, -L - 8, 'center');
    v.dimV(R + 6, 0, R + 6, h, 14, dim('flat_h'));
    v.dimH(-R, 0, R, 0, -R - 4, dim('ball_d'));
    v.dimH(-a, -L, a, -L, -8, dim('stem_d'));
    v.dimV(R + 6, -L, R + 6, 0, 12, dim('stem_l'));
    v.leader(a - c, -L, c, -45, 14, dim('chamfer_c'), 'chamfer');
  },
};
