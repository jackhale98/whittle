/**
 * RP01 Base plate (CSWA-like). Extrude, through-all and blind cuts, sketches on a face.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { face, origin, region, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';

const PI = Math.PI;

export const rp01: PartDef = {
  id: 'rp01-base-plate',
  no: 1,
  title: 'Base plate',
  level: 'CSWA-like',
  summary:
    'A rectangular aluminium plate with four mounting holes, a central bore and a shallow pocket.',
  material: 'whittle:aluminium-6061-t6',
  dims: {
    length: { value: 120, unit: 'mm', description: 'Plate length (X)' },
    width: { value: 80, unit: 'mm', description: 'Plate width (Y)' },
    thickness: { value: 12, unit: 'mm', description: 'Plate thickness (Z)' },
    hole_d: { value: 10, unit: 'mm', description: 'Diameter of the four mounting holes' },
    hole_x: { value: 45, unit: 'mm', description: 'Hole centres from the centre line, along X' },
    hole_y: { value: 25, unit: 'mm', description: 'Hole centres from the centre line, along Y' },
    bore_d: { value: 30, unit: 'mm', description: 'Central through bore diameter' },
    pocket_w: { value: 40, unit: 'mm', description: 'Pocket size along X' },
    pocket_h: { value: 14, unit: 'mm', description: 'Pocket size along Y' },
    pocket_y: {
      value: 20,
      unit: 'mm',
      description: 'Pocket near edge, measured from the centre line',
    },
    pocket_d: { value: 5, unit: 'mm', description: 'Pocket depth' },
  },
  tags: ['extrude', 'cut'],
  method:
    'Exact closed form: the plate is a box minus cylinders and one box pocket. The surface area is exact too. Accuracy is limited only by floating point (1e-12 relative).',
  steps: (d) => {
    const T = d('thickness');
    const hx = d('hole_x');
    const hy = d('hole_y');
    return [
      {
        tool: 'sketch',
        id: 'base_sk',
        say: 'Sketch on Top (the XY plane): a rectangle length x width centred on the origin.',
        on: origin('origin:XY'),
        ops: [{ op: 'rect', id: 'L', x: '-length/2', y: '-width/2', w: 'length', h: 'width' }],
      },
      {
        tool: 'extrude',
        id: 'base',
        say: 'Extrude the rectangle by thickness, as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [50, 30, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'thickness' },
        op: 'new',
      },
      {
        tool: 'sketch',
        id: 'holes_sk',
        say: 'Sketch on the top face: four circles of hole_d at (+-hole_x, +-hole_y) and a bore_d circle at the origin.',
        on: face('F{base}:end', [50, 30, T]),
        ops: [
          { op: 'circle', id: 'H1', cx: 'hole_x', cy: 'hole_y', d: 'hole_d' },
          { op: 'circle', id: 'H2', cx: '-hole_x', cy: 'hole_y', d: 'hole_d' },
          { op: 'circle', id: 'H3', cx: '-hole_x', cy: '-hole_y', d: 'hole_d' },
          { op: 'circle', id: 'H4', cx: 'hole_x', cy: '-hole_y', d: 'hole_d' },
          { op: 'circle', id: 'B', cx: '0', cy: '0', d: 'bore_d' },
        ],
      },
      {
        tool: 'extrude',
        id: 'holes',
        say: 'Cut-extrude the five circles through all, downwards.',
        profile: [
          region('holes_sk', ['H1'], [hx, hy, T]),
          region('holes_sk', ['H2'], [-hx, hy, T]),
          region('holes_sk', ['H3'], [-hx, -hy, T]),
          region('holes_sk', ['H4'], [hx, -hy, T]),
          region('holes_sk', ['B'], [0, 0, T]),
        ],
        direction: 'reverse',
        end: { kind: 'throughAll' },
        op: 'cut',
      },
      {
        tool: 'sketch',
        id: 'pocket_sk',
        say: 'Sketch on the top face: a pocket_w x pocket_h rectangle whose near edge is pocket_y from the centre line.',
        on: face('F{base}:end', [50, 30, T]),
        ops: [
          { op: 'rect', id: 'P', x: '-pocket_w/2', y: 'pocket_y', w: 'pocket_w', h: 'pocket_h' },
        ],
      },
      {
        tool: 'extrude',
        id: 'pocket',
        say: 'Cut-extrude the rectangle downwards by pocket_d.',
        profile: [
          region('pocket_sk', ['P1', 'P2', 'P3', 'P4'], [0, d('pocket_y') + d('pocket_h') / 2, T]),
        ],
        direction: 'reverse',
        end: { kind: 'blind', depth: 'pocket_d' },
        op: 'cut',
      },
    ];
  },
  model: (d) => {
    const L = d('length');
    const W = d('width');
    const T = d('thickness');
    const hd = d('hole_d');
    const bd = d('bore_d');
    const pw = d('pocket_w');
    const ph = d('pocket_h');
    const pd = d('pocket_d');
    const terms = [
      term('Blank', 'length x width x thickness', L * W * T),
      term('Four mounting holes', '-4 pi (hole_d/2)^2 thickness', -4 * PI * (hd / 2) ** 2 * T),
      term('Central bore', '-pi (bore_d/2)^2 thickness', -PI * (bd / 2) ** 2 * T),
      term('Pocket', '-pocket_w pocket_h pocket_d', -pw * ph * pd),
    ];
    const area =
      2 * (L * W - 4 * PI * (hd / 2) ** 2 - PI * (bd / 2) ** 2) +
      2 * (L + W) * T +
      4 * PI * hd * T +
      PI * bd * T +
      2 * (pw + ph) * pd;
    return {
      volume: sum(terms),
      area,
      bbox: { min: [-L / 2, -W / 2, 0], max: [L / 2, W / 2, T] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: length -> 140 mm', set: { length: 140 } },
    { name: 'Stage 3: hole_d -> 12 mm and thickness -> 16 mm', set: { hole_d: 12, thickness: 16 } },
    { name: 'Stage 4: bore_d -> 36 mm and pocket_d -> 8 mm', set: { bore_d: 36, pocket_d: 8 } },
  ],
  draw: (d, dr) => {
    const L = d('length');
    const W = d('width');
    const T = d('thickness');
    const hx = d('hole_x');
    const hy = d('hole_y');
    const hr = d('hole_d') / 2;
    const br = d('bore_d') / 2;
    const pw = d('pocket_w');
    const py = d('pocket_y');
    const ph = d('pocket_h');
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    const top = dr.view('Top', 150, 95, 1.55).caption(-L / 2, W / 2 + 8, 'Top');
    top.rect(-L / 2, -W / 2, L / 2, W / 2);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        top.circle(sx * hx, sy * hy, hr).centerCross(sx * hx, sy * hy, hr);
      }
    top.circle(0, 0, br).centerCross(0, 0, br);
    top.rect(-pw / 2, py, pw / 2, py + ph);
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('length'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 14, dim('width'));
    top.dimH(0, W / 2, hx, W / 2, 7, dim('hole_x'));
    top.dimV(-L / 2, 0, -L / 2, hy, -12, dim('hole_y'));
    top.leader(hx, -hy, hr, -50, 14, dim('hole_d'));
    top.leader(0, 0, br, -125, 14, dim('bore_d'));
    top.dimH(-pw / 2, py + ph, pw / 2, py + ph, 3, dim('pocket_w'));
    top.dimV(pw / 2, py, pw / 2, py + ph, 16, dim('pocket_h'));
    top.dimV(-pw / 2, 0, -pw / 2, py, -14, dim('pocket_y'));
    const front = dr.view('Front', 150, 225, 1.55).caption(-L / 2, T + 14, 'Front');
    front.rect(-L / 2, 0, L / 2, T);
    front.rect(-pw / 2, T - d('pocket_d'), pw / 2, T, 'hidden');
    front.dimV(L / 2, 0, L / 2, T, 12, dim('thickness'));
    front.dimV(-pw / 2, T - d('pocket_d'), -pw / 2, T, -16, dim('pocket_d'));
  },
};
