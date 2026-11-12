/**
 * RP04 Clamp block (CSWA/CSWP-like). Corner fillets, a propagating top fillet, a non-propagating
 * bottom chamfer, a second body combined by boolean, and push/pull.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  chamferArea,
  chamferCentroid,
  edge,
  edgeName,
  face,
  gapArea,
  gapCentroid,
  origin,
  region,
  side,
  sum,
  term,
} from '../lib/geom';
import type { PartDef, Pick } from '../lib/types';
import { FRONT, TOP_OF_FRONT } from '../lib/views';

const PI = Math.PI;

/** The four vertical corner edges of the plate (lines L1 bottom, L2 right, L3 top, L4 left). */
const CORNERS: [string, string][] = [
  ['L1', 'L2'],
  ['L2', 'L3'],
  ['L3', 'L4'],
  ['L4', 'L1'],
];

const fcName = (a: string, b: string): string =>
  `F{fc}:fillet(${edgeName(side('base', 'base_sk', a), side('base', 'base_sk', b))})`;

export const rp04: PartDef = {
  id: 'rp04-clamp-block',
  no: 4,
  title: 'Clamp block',
  level: 'CSWA-like',
  summary:
    'A rounded base plate with a softened top edge and a chamfered underside, and a round boss added as a second body, combined, then pulled taller.',
  material: 'whittle:aluminium-7075-t6',
  dims: {
    plate_l: { value: 100, unit: 'mm', description: 'Plate length (X)' },
    plate_w: { value: 60, unit: 'mm', description: 'Plate width (Y)' },
    plate_t: { value: 16, unit: 'mm', description: 'Plate thickness (Z)' },
    corner_r: { value: 8, unit: 'mm', description: 'Radius of the four vertical corners' },
    top_r: { value: 3, unit: 'mm', description: 'Fillet on the whole top edge loop' },
    bot_c: { value: 2, unit: 'mm', description: 'Chamfer on the whole bottom edge loop' },
    boss_d: { value: 30, unit: 'mm', description: 'Boss diameter' },
    boss_h: {
      value: 26,
      unit: 'mm',
      description:
        'Boss height above the plate, as built (extruded boss_h - boss_up, then pulled up by boss_up; corrected from 20, see the README)',
    },
    boss_up: { value: 6, unit: 'mm', description: 'Push/pull distance added to the boss top' },
    boss_c: { value: 2, unit: 'mm', description: 'Chamfer on the boss top edge' },
  },
  tags: [
    'extrude',
    'fillet',
    'chamfer',
    'propagate',
    'noPropagate',
    'boolean',
    'pushPull',
    'plane',
  ],
  method:
    'Exact. Every blend runs along a loop of straight edges and quarter arcs, so Pappus gives its volume: the corner area of the cross-section times the length of the path of its centroid. Along a convex arc of radius Rc the centroid of a fillet gap lies 0.2234 r inside the wall, of a chamfer triangle c/3 inside. The top fillet is a single pick with propagation on; the bottom chamfer picks all eight edges with propagation off, and both are the same kind of loop. Accuracy: floating point (1e-12 relative).',
  steps: (d) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const Rc = d('corner_r');
    const H = T + d('boss_h');
    const k = Rc * (1 - Math.SQRT1_2);
    // Mid-points of the bottom-loop arcs, one per corner, in the same order as CORNERS.
    const arcAt: [number, number, number][] = [
      [L / 2 - k, -W / 2 + k, 0],
      [L / 2 - k, W / 2 - k, 0],
      [-L / 2 + k, W / 2 - k, 0],
      [-L / 2 + k, -W / 2 + k, 0],
    ];
    const cornerAt: [number, number, number][] = [
      [L / 2, -W / 2, T / 2],
      [L / 2, W / 2, T / 2],
      [-L / 2, W / 2, T / 2],
      [-L / 2, -W / 2, T / 2],
    ];
    const straightAt: [number, number, number][] = [
      [0, -W / 2, 0],
      [L / 2, 0, 0],
      [0, W / 2, 0],
      [-L / 2, 0, 0],
    ];
    const bottomEdges: Pick[] = [
      ...['L1', 'L2', 'L3', 'L4'].map((l, i) =>
        edge(edgeName('F{base}:start', side('base', 'base_sk', l)), straightAt[i]),
      ),
      ...CORNERS.map(([a, b], i) => edge(edgeName('F{base}:start', fcName(a, b)), arcAt[i])),
    ];
    return [
      {
        tool: 'sketch',
        id: 'base_sk',
        say: 'Sketch on Top: a rectangle plate_l x plate_w centred on the origin.',
        on: origin('origin:XY'),
        ops: [
          { op: 'rect', id: 'L', x: '-plate_l/2', y: '-plate_w/2', w: 'plate_l', h: 'plate_w' },
        ],
      },
      {
        tool: 'extrude',
        id: 'base',
        say: 'Extrude by plate_t as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [20, 10, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'plate_t' },
        op: 'new',
      },
      {
        tool: 'fillet',
        id: 'fc',
        say: 'Fillet the four vertical corner edges, radius corner_r.',
        edges: CORNERS.map(([a, b], i) =>
          edge(edgeName(side('base', 'base_sk', a), side('base', 'base_sk', b)), cornerAt[i]),
        ),
        radius: 'corner_r',
        propagate: true,
      },
      {
        tool: 'fillet',
        id: 'ft',
        say: 'Fillet ONE top edge with "propagate along tangent edges" on, radius top_r: the whole rounded top loop follows.',
        edges: [edge(edgeName('F{base}:end', side('base', 'base_sk', 'L1')), [0, -W / 2, T])],
        radius: 'top_r',
        propagate: true,
      },
      {
        tool: 'chamfer',
        id: 'cb',
        say: 'Chamfer the bottom loop by bot_c with "propagate" OFF: pick all eight edges (four straight, four corner arcs) one by one.',
        edges: bottomEdges,
        mode: { kind: 'distance', distance: 'bot_c' },
        propagate: false,
      },
      {
        tool: 'sketch',
        id: 'boss_sk',
        say: 'Sketch on the top face: a circle of boss_d at the origin.',
        on: face('F{base}:end', [20, 10, T]),
        ops: [{ op: 'circle', id: 'C', cx: '0', cy: '0', d: 'boss_d' }],
      },
      {
        tool: 'extrude',
        id: 'boss',
        say: 'Extrude the circle upwards by boss_h - boss_up as a NEW body (a second body touching the plate).',
        profile: [region('boss_sk', ['C'], [0, 0, T])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'boss_h - boss_up' },
        op: 'new',
      },
      {
        tool: 'boolean',
        id: 'join',
        say: 'Combine: add the boss body to the plate body.',
        op: 'add',
        target: { pick: 'body', name: 'B{base}' },
        tools: [{ pick: 'body', name: 'B{boss}' }],
        keepTools: false,
      },
      {
        tool: 'pushPull',
        id: 'pull',
        say: 'Push/pull the boss top face outwards by boss_up.',
        faces: [face('F{join}:face(F{boss}:end)', [0, 0, H - d('boss_up')])],
        distance: 'boss_up',
      },
      {
        tool: 'chamfer',
        id: 'cboss',
        say: 'Chamfer the boss top edge by boss_c (propagate off: it is a single circular edge).',
        edges: [
          edge(
            edgeName('F{join}:face(F{boss}:end)', 'F{join}:face(F{boss}:side(S{boss_sk}:e(C)))'),
            [d('boss_d') / 2, 0, H],
          ),
        ],
        mode: { kind: 'distance', distance: 'boss_c' },
        propagate: false,
      },
      {
        tool: 'plane',
        id: 'boss_lvl',
        say: 'Reference plane: offset plate_t + boss_h - boss_up above the Top plane, the level the boss top was first extruded to before the push/pull. It follows the parameters, so boss_up can be dimensioned from it.',
        definition: {
          kind: 'offset',
          from: origin('origin:XY'),
          distance: 'plate_t + boss_h - boss_up',
        },
      },
    ];
  },
  model: (d) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const Rc = d('corner_r');
    const r = d('top_r');
    const c = d('bot_c');
    const a = d('boss_d') / 2;
    const hb = d('boss_h');
    const cb = d('boss_c');
    const straight = 2 * (L - 2 * Rc) + 2 * (W - 2 * Rc);
    const arcs = 4 * (PI / 2);
    const terms = [
      term('Plate', 'plate_l x plate_w x plate_t', L * W * T),
      term('Four corner fillets', '-4 (1 - pi/4) corner_r^2 plate_t', -4 * gapArea(Rc) * T),
      term(
        'Top edge loop fillet',
        '-(1 - pi/4) r^2 [straight + 4 (pi/2)(Rc - 0.2234 r)]',
        -gapArea(r) * (straight + arcs * (Rc - gapCentroid(r))),
      ),
      term(
        'Bottom edge loop chamfer',
        '-(c^2/2) [straight + 4 (pi/2)(Rc - c/3)]',
        -chamferArea(c) * (straight + arcs * (Rc - chamferCentroid(c))),
      ),
      term('Boss after push/pull', 'pi (boss_d/2)^2 boss_h', PI * a * a * hb),
      term(
        'Boss top chamfer',
        '-(cb^2/2) x 2 pi (a - cb/3)',
        -chamferArea(cb) * 2 * PI * (a - chamferCentroid(cb)),
      ),
    ];
    return {
      volume: sum(terms),
      bbox: { min: [-L / 2, -W / 2, 0], max: [L / 2, W / 2, T + hb] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: plate_l -> 120 mm', set: { plate_l: 120 } },
    {
      name: 'Stage 3: boss_d -> 36 mm, boss_up -> 10 mm with the boss as first extruded unchanged (boss_h -> 30)',
      set: { boss_d: 36, boss_h: 30, boss_up: 10 },
    },
    { name: 'Stage 4: corner_r -> 12 mm and top_r -> 4 mm', set: { corner_r: 12, top_r: 4 } },
  ],
  draw: (d, dr) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const Rc = d('corner_r');
    const a = d('boss_d') / 2;
    const hb = d('boss_h');
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    const top = dr.view(TOP_OF_FRONT, 140, 90, 1.6).caption(-L / 2, W / 2 + 8, 'Top');
    top.path(
      [
        [-L / 2 + Rc, -W / 2],
        [L / 2 - Rc, -W / 2],
      ],
      false,
    );
    top.line(L / 2, -W / 2 + Rc, L / 2, W / 2 - Rc);
    top.line(L / 2 - Rc, W / 2, -L / 2 + Rc, W / 2);
    top.line(-L / 2, W / 2 - Rc, -L / 2, -W / 2 + Rc);
    top.arc(L / 2 - Rc, -W / 2 + Rc, Rc, -90, 0);
    top.arc(L / 2 - Rc, W / 2 - Rc, Rc, 0, 90);
    top.arc(-L / 2 + Rc, W / 2 - Rc, Rc, 90, 180);
    top.arc(-L / 2 + Rc, -W / 2 + Rc, Rc, 180, 270);
    top.circle(0, 0, a).centerCross(0, 0, a);
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('plate_l'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 14, dim('plate_w'));
    top.leader(0, 0, a, 120, 20, dim('boss_d'));
    top.leader(L / 2 - Rc, W / 2 - Rc, Rc, 45, 14, dim('corner_r'), 'radius');
    const front = dr.view(FRONT, 140, 215, 1.6).caption(-L / 2, T + hb + 8, 'Front');
    front.rect(-L / 2, 0, L / 2, T);
    front.rect(-a, T, a, T + hb);
    front.dimV(L / 2, 0, L / 2, T, 12, dim('plate_t'));
    // The boss as built: from the plate top to the boss top (its flat, inside the top chamfer).
    front.dimV(a, T, a - d('boss_c'), T + hb, 10, dim('boss_h'));
    // The push/pull distance: from the reference plane `boss_lvl` (where the boss top was first
    // extruded, drawn edge-on as a centre line) up to the boss top. The points are on the flat of
    // the top, inside its chamfer.
    const lvl = T + hb - d('boss_up');
    front.line(-a - 8, lvl, a + 8, lvl, 'center');
    front.dimV(-(a - d('boss_c')), lvl, -(a - d('boss_c')), T + hb, -10, dim('boss_up'), {
      refs: [
        { name: 'F{boss_lvl}:plane', kind: 'face' },
        { name: 'F{join}:face(F{boss}:end)', kind: 'face' },
      ],
    });
    // The fillet is seen edge-on: its arc is centred top_r in from the corner.
    front.leader(L / 2, T, d('top_r'), 45, 16, dim('top_r'), 'radius', [
      L / 2 - d('top_r'),
      T - d('top_r'),
    ]);
    front.leader(-L / 2, 0, d('bot_c'), 225, 16, dim('bot_c'), 'chamfer');
    front.leader(a, T + hb, d('boss_c'), 45, 14, dim('boss_c'), 'chamfer');
  },
};
