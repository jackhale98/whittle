/**
 * RP06 Cable guide (CSWP-like). A swept groove cut along a bent path and a swept bent rod,
 * both on reference planes.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { edge, origin, region, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';
import { TOP } from '../lib/views';

const PI = Math.PI;

export const rp06: PartDef = {
  id: 'rp06-cable-guide',
  no: 6,
  title: 'Cable guide',
  level: 'CSWP-like',
  summary:
    'A nylon block with a round groove swept along a straight-arc-straight path across its top, and a bent rod swept up from the top face.',
  material: 'whittle:nylon-pa12',
  dims: {
    blk_l: { value: 100, unit: 'mm', description: 'Block length (X)' },
    blk_w: { value: 50, unit: 'mm', description: 'Block width (Y)' },
    blk_t: { value: 20, unit: 'mm', description: 'Block thickness (Z)' },
    ch_d: {
      value: 10,
      unit: 'mm',
      description: 'Groove diameter (its centre line lies on the top face)',
    },
    ch_in: {
      value: 10,
      unit: 'mm',
      description: 'Groove entry: offset of its first leg from the centre line, towards -Y',
    },
    ch_turn_x: { value: 20, unit: 'mm', description: 'X where the groove starts to bend' },
    ch_bend: { value: 10, unit: 'mm', description: 'Groove bend radius (a quarter turn to +Y)' },
    rod_d: { value: 8, unit: 'mm', description: 'Rod diameter' },
    rod_x: {
      value: 30,
      unit: 'mm',
      description: 'Rod plane: distance from the YZ plane towards -X',
    },
    rod_y: { value: 15, unit: 'mm', description: 'Rod foot position along Y' },
    rod_h: { value: 20, unit: 'mm', description: 'Length of the straight rising leg' },
    rod_bend: { value: 10, unit: 'mm', description: 'Rod bend radius (a quarter turn towards -Y)' },
    rod_tail: { value: 15, unit: 'mm', description: 'Length of the straight horizontal tail' },
  },
  tags: ['extrude', 'plane', 'sweep', 'sweepCut'],
  method:
    'Exact by Pappus. A circular profile swept along a path of length s has volume pi r^2 s. The groove profile is centred on the top face, so half of it is cut; the centroid of the removed half disc lies straight below the path, at the same bend radius, so the volume is (pi r^2 / 2) s_groove with no correction. The rod sits clear of the groove and above the block. Accuracy: floating point (1e-12 relative). The kernel result also depends on the sweep keeping the profile normal to the path (a planar path, so Frenet is exact).',
  steps: (d) => {
    const T = d('blk_t');
    const bt = d('ch_bend');
    return [
      {
        tool: 'sketch',
        id: 'base_sk',
        say: 'Sketch on Top (XY): a rectangle blk_l x blk_w centred on the origin.',
        on: origin('origin:XY'),
        ops: [{ op: 'rect', id: 'L', x: '-blk_l/2', y: '-blk_w/2', w: 'blk_l', h: 'blk_w' }],
      },
      {
        tool: 'extrude',
        id: 'base',
        say: 'Extrude by blk_t as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [30, 15, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'blk_t' },
        op: 'new',
      },
      {
        tool: 'plane',
        id: 'top_pl',
        say: 'Reference plane: offset blk_t above the Top plane (the block top).',
        definition: { kind: 'offset', from: origin('origin:XY'), distance: 'blk_t' },
      },
      {
        tool: 'sketch',
        id: 'ch_path',
        say: 'Sketch the groove path on the new plane: a line in from the -X end, a quarter arc of ch_bend, and a line out to the +Y side.',
        on: { pick: 'plane', name: 'F{top_pl}:plane', at: [0, 0, T] },
        ops: [
          { op: 'point', id: 'p0', x: '-blk_l/2', y: '-ch_in' },
          { op: 'point', id: 'p1', x: 'ch_turn_x', y: '-ch_in' },
          { op: 'point', id: 'pc', x: 'ch_turn_x', y: '-ch_in+ch_bend', dims: 'none' },
          { op: 'point', id: 'p2', x: 'ch_turn_x+ch_bend', y: '-ch_in+ch_bend' },
          { op: 'point', id: 'p3', x: 'ch_turn_x+ch_bend', y: 'blk_w/2' },
          { op: 'line', id: 'R1', a: 'p0', b: 'p1' },
          { op: 'arc', id: 'R2', c: 'pc', a: 'p1', b: 'p2', radius: 'ch_bend' },
          { op: 'line', id: 'R3', a: 'p2', b: 'p3' },
        ],
      },
      {
        tool: 'plane',
        id: 'ch_pl',
        say: 'Reference plane: offset blk_l/2 from the Right plane (YZ) towards -X, the plane of the groove start.',
        definition: { kind: 'offset', from: origin('origin:YZ'), distance: '-blk_l/2' },
      },
      {
        tool: 'sketch',
        id: 'ch_prof',
        say: 'Sketch on that plane: a circle of ch_d centred on the groove start, level with the block top.',
        on: { pick: 'plane', name: 'F{ch_pl}:plane', at: [-d('blk_l') / 2, 0, 0] },
        ops: [{ op: 'circle', id: 'C', cx: '-ch_in', cy: 'blk_t', d: 'ch_d' }],
      },
      {
        tool: 'sweep',
        id: 'groove',
        say: 'Sweep-cut the circle along the groove path (profile follows the path).',
        profile: [region('ch_prof', ['C'], [-d('blk_l') / 2, -d('ch_in'), T])],
        path: [
          edge('S{ch_path}:e(R1)', [-d('blk_l') / 2 + 10, -d('ch_in'), T]),
          edge('S{ch_path}:e(R2)', [
            d('ch_turn_x') + bt * Math.SQRT1_2,
            -d('ch_in') + bt * (1 - Math.SQRT1_2),
            T,
          ]),
          edge('S{ch_path}:e(R3)', [d('ch_turn_x') + bt, d('blk_w') / 4, T]),
        ],
        orientation: 'followPath',
        op: 'cut',
      },
      {
        tool: 'plane',
        id: 'rod_pl',
        say: 'Reference plane: offset rod_x from the Right plane (YZ) towards -X, the plane of the rod path.',
        definition: { kind: 'offset', from: origin('origin:YZ'), distance: '-rod_x' },
      },
      {
        tool: 'sketch',
        id: 'rod_path',
        say: 'Sketch the rod path on that plane: a line up from the block top, a quarter arc of rod_bend towards -Y, and a horizontal tail.',
        on: { pick: 'plane', name: 'F{rod_pl}:plane', at: [-d('rod_x'), 0, 0] },
        ops: [
          { op: 'point', id: 'q0', x: 'rod_y', y: 'blk_t' },
          { op: 'point', id: 'q1', x: 'rod_y', y: 'blk_t+rod_h' },
          { op: 'point', id: 'qc', x: 'rod_y-rod_bend', y: 'blk_t+rod_h', dims: 'none' },
          { op: 'point', id: 'q2', x: 'rod_y-rod_bend', y: 'blk_t+rod_h+rod_bend' },
          { op: 'point', id: 'q3', x: 'rod_y-rod_bend-rod_tail', y: 'blk_t+rod_h+rod_bend' },
          { op: 'line', id: 'S1', a: 'q0', b: 'q1' },
          { op: 'arc', id: 'S2', c: 'qc', a: 'q1', b: 'q2', radius: 'rod_bend' },
          { op: 'line', id: 'S3', a: 'q2', b: 'q3' },
        ],
      },
      {
        tool: 'sketch',
        id: 'rod_prof',
        say: 'Sketch on the block-top plane: a circle of rod_d at (-rod_x, rod_y).',
        on: { pick: 'plane', name: 'F{top_pl}:plane', at: [0, 0, T] },
        ops: [{ op: 'circle', id: 'C2', cx: '-rod_x', cy: 'rod_y', d: 'rod_d' }],
      },
      {
        tool: 'sweep',
        id: 'rod',
        say: 'Sweep the circle along the rod path, adding to the block.',
        profile: [region('rod_prof', ['C2'], [-d('rod_x'), d('rod_y'), T])],
        path: [
          edge('S{rod_path}:e(S1)', [-d('rod_x'), d('rod_y'), T + d('rod_h') / 2]),
          edge('S{rod_path}:e(S2)', [
            -d('rod_x'),
            d('rod_y') - d('rod_bend') * (1 - Math.SQRT1_2),
            T + d('rod_h') + d('rod_bend') * Math.SQRT1_2,
          ]),
          edge('S{rod_path}:e(S3)', [
            -d('rod_x'),
            d('rod_y') - d('rod_bend') - d('rod_tail') / 2,
            T + d('rod_h') + d('rod_bend'),
          ]),
        ],
        orientation: 'followPath',
        op: 'add',
      },
    ];
  },
  model: (d) => {
    const L = d('blk_l');
    const W = d('blk_w');
    const T = d('blk_t');
    const rc = d('ch_d') / 2;
    const rr = d('rod_d') / 2;
    const sg =
      d('ch_turn_x') + L / 2 + (PI / 2) * d('ch_bend') + (W / 2 - (d('ch_bend') - d('ch_in')));
    const sr = d('rod_h') + (PI / 2) * d('rod_bend') + d('rod_tail');
    const terms = [
      term('Block', 'blk_l x blk_w x blk_t', L * W * T),
      term(
        'Groove (half circle swept)',
        '-(pi rc^2 / 2) s_groove, s_groove = turn_x + l/2 + (pi/2) bend + (w/2 - (bend - in))',
        -((PI * rc * rc) / 2) * sg,
      ),
      term('Rod', 'pi rr^2 s_rod, s_rod = rod_h + (pi/2) rod_bend + rod_tail', PI * rr * rr * sr),
    ];
    return {
      volume: sum(terms),
      bbox: {
        min: [-L / 2, -W / 2, 0],
        max: [L / 2, W / 2, T + d('rod_h') + d('rod_bend') + rr],
      },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: ch_d -> 12 mm', set: { ch_d: 12 } },
    { name: 'Stage 3: rod_h -> 30 mm and rod_d -> 10 mm', set: { rod_h: 30, rod_d: 10 } },
    { name: 'Stage 4: blk_t -> 25 mm and ch_bend -> 12 mm', set: { blk_t: 25, ch_bend: 12 } },
  ],
  draw: (d, dr) => {
    const L = d('blk_l');
    const W = d('blk_w');
    const T = d('blk_t');
    const bt = d('ch_bend');
    const cin = d('ch_in');
    const tx = d('ch_turn_x');
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    const top = dr.view(TOP, 150, 90, 1.5).caption(-L / 2, W / 2 + 8, 'Top');
    top.rect(-L / 2, -W / 2, L / 2, W / 2);
    top.path(
      [
        [-L / 2, -cin],
        [tx, -cin],
      ],
      false,
      'hidden',
    );
    top.arc(tx, -cin + bt, bt, -90, 0, 'hidden');
    top.line(tx + bt, -cin + bt, tx + bt, W / 2, 'hidden');
    top.circle(-d('rod_x'), d('rod_y'), d('rod_d') / 2);
    top.line(
      -d('rod_x'),
      d('rod_y'),
      -d('rod_x'),
      d('rod_y') - d('rod_bend') - d('rod_tail'),
      'center',
    );
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('blk_l'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 12, dim('blk_w'));
    top.dimV(-L / 2, 0, -L / 2, -cin, -12, dim('ch_in'));
    top.dimH(-L / 2, W / 2, tx, W / 2, 6, dim('ch_turn_x'));
    top.leader(tx, -cin + bt, bt, 225, 14, dim('ch_bend'), 'radius');
    top.dimH(-d('rod_x'), -W / 2 + 4, 0, -W / 2 + 4, 0, dim('rod_x'));
    top.dimV(-d('rod_x'), 0, -d('rod_x'), d('rod_y'), -14, dim('rod_y'));
    top.leader(-d('rod_x'), d('rod_y'), d('rod_d') / 2, 90, 10, dim('rod_d'));
    top.leader(tx + bt, 0, d('ch_d') / 2, 0, 14, dim('ch_d'));
    // Side view along X: horizontal axis = Y, vertical = Z. The rod path is in this plane.
    const side = dr
      .view(
        {
          id: 'right',
          caption: 'Right',
          kind: 'base',
          orientation: 'right',
          side: 'right',
          axes: ['Y', 'Z'],
          // rod_h and rod_tail are measured to the ends of the straight legs, where the rod's
          // bend starts: tangent (smooth) edges, which the product does not draw unless asked.
          display: { tangent: 'thin' },
        },
        320,
        160,
        1.4,
      )
      .caption(-W / 2, 80, 'Right');
    side.rect(-W / 2, 0, W / 2, T);
    const ry = d('rod_y');
    const rh = d('rod_h');
    const rb = d('rod_bend');
    side.line(ry, T, ry, T + rh);
    side.arc(ry - rb, T + rh, rb, 0, 90);
    side.line(ry - rb, T + rh + rb, ry - rb - d('rod_tail'), T + rh + rb);
    // The tangent edges where the straight legs meet the bend: circles about the rod's path seen
    // edge-on, rod_d long, drawn thin.
    const rr = d('rod_d') / 2;
    side.line(ry - rr, T + rh, ry + rr, T + rh, 'tangent');
    side.line(ry - rb, T + rh + rb - rr, ry - rb, T + rh + rb + rr, 'tangent');
    side.dimV(-W / 2, 0, -W / 2, T, -12, dim('blk_t'));
    side.dimV(ry, T, ry, T + rh, 10, dim('rod_h'));
    side.leader(ry - rb, T + rh, rb, 45, 12, dim('rod_bend'), 'radius');
    side.dimH(ry - rb - d('rod_tail'), T + rh + rb, ry - rb, T + rh + rb, 8, dim('rod_tail'));
  },
};
