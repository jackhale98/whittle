/**
 * RP07 Duct adapter (CSWP-like). A loft from a sketch built with Convert Entities and Offset
 * Entities to a smaller rectangle on a reference plane, then a bore.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { edge, edgeName, face, origin, region, side, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';
import { FRONT, TOP_OF_FRONT } from '../lib/views';

const PI = Math.PI;

export const rp07: PartDef = {
  id: 'rp07-duct-adapter',
  no: 7,
  title: 'Duct adapter',
  level: 'CSWP-like',
  summary:
    'A PETG adapter: a rectangular flange block, a ruled loft from an inset copy of its top outline to a smaller rectangle higher up, and a round bore straight through.',
  material: 'whittle:petg',
  dims: {
    base_l: { value: 80, unit: 'mm', description: 'Flange block length (X)' },
    base_w: { value: 60, unit: 'mm', description: 'Flange block width (Y)' },
    base_t: { value: 10, unit: 'mm', description: 'Flange block thickness (Z)' },
    inset: {
      value: 15,
      unit: 'mm',
      description: 'Offset of the loft start inside the top outline',
    },
    loft_h: { value: 40, unit: 'mm', description: 'Loft height above the block' },
    top_l: { value: 30, unit: 'mm', description: 'Length of the loft end rectangle' },
    top_w: { value: 14, unit: 'mm', description: 'Width of the loft end rectangle' },
    bore_d: { value: 8, unit: 'mm', description: 'Through bore diameter' },
  },
  tags: ['extrude', 'cut', 'plane', 'loft', 'offset', 'convert'],
  method:
    'Exact. A ruled loft between two parallel rectangles with parallel edges is a prismatoid; the section sides vary linearly, so the area is quadratic in height and Simpson (h/6)(A1 + 4 Am + A2) is exact, with Am the area of the mid-section ((a1+a2)/2 x (b1+b2)/2). The bore lies wholly inside the solid (bore_d is at most top_w), so it removes pi r^2 x total height. Accuracy: floating point (1e-12 relative).',
  steps: (d) => {
    const L = d('base_l');
    const W = d('base_w');
    const T = d('base_t');
    const H = T + d('loft_h');
    const topEdge = (l: string, at: [number, number, number]) =>
      edge(edgeName('F{base}:end', side('base', 'base_sk', l)), at);
    return [
      {
        tool: 'sketch',
        id: 'base_sk',
        say: 'Sketch on Top (XY): a rectangle base_l x base_w centred on the origin.',
        on: origin('origin:XY'),
        ops: [{ op: 'rect', id: 'L', x: '-base_l/2', y: '-base_w/2', w: 'base_l', h: 'base_w' }],
      },
      {
        tool: 'extrude',
        id: 'base',
        say: 'Extrude by base_t as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [30, 20, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'base_t' },
        op: 'new',
      },
      {
        tool: 'sketch',
        id: 'sec_sk',
        say: 'Sketch on the top face. Convert Entities on the four top edges, then Offset Entities on that loop inwards by inset (the offset dimension is -inset: positive is outward for a counter-clockwise loop).',
        on: face('F{base}:end', [30, 20, T]),
        ops: [
          {
            op: 'convert',
            id: 'T1',
            source: topEdge('L1', [0, -W / 2, T]),
            a: [-L / 2, -W / 2],
            b: [L / 2, -W / 2],
          },
          {
            op: 'convert',
            id: 'T2',
            source: topEdge('L2', [L / 2, 0, T]),
            a: [L / 2, -W / 2],
            b: [L / 2, W / 2],
          },
          {
            op: 'convert',
            id: 'T3',
            source: topEdge('L3', [0, W / 2, T]),
            a: [L / 2, W / 2],
            b: [-L / 2, W / 2],
          },
          {
            op: 'convert',
            id: 'T4',
            source: topEdge('L4', [-L / 2, 0, T]),
            a: [-L / 2, W / 2],
            b: [-L / 2, -W / 2],
          },
          {
            op: 'offsetRect',
            id: 'O',
            sources: ['T1', 'T2', 'T3', 'T4'],
            distance: '-inset',
            bounds: [-L / 2, -W / 2, L / 2, W / 2],
          },
        ],
      },
      {
        tool: 'plane',
        id: 'top_pl',
        say: 'Reference plane: offset base_t + loft_h above the Top plane.',
        definition: { kind: 'offset', from: origin('origin:XY'), distance: 'base_t + loft_h' },
      },
      {
        tool: 'sketch',
        id: 'top_sk',
        say: 'Sketch on the new plane: a rectangle top_l x top_w centred on the origin.',
        on: { pick: 'plane', name: 'F{top_pl}:plane', at: [0, 0, H] },
        ops: [{ op: 'rect', id: 'L', x: '-top_l/2', y: '-top_w/2', w: 'top_l', h: 'top_w' }],
      },
      {
        tool: 'loft',
        id: 'lo',
        say: 'Loft (ruled, open) from the offset rectangle to the top rectangle, adding to the block.',
        sections: [
          region('sec_sk', ['O1', 'O2', 'O3', 'O4'], [0, 0, T]),
          region('top_sk', ['L1', 'L2', 'L3', 'L4'], [0, 0, H]),
        ],
        ruled: true,
        closed: false,
        op: 'add',
      },
      {
        tool: 'sketch',
        id: 'bore_sk',
        say: 'Sketch on the top plane again: a circle of bore_d at the origin.',
        on: { pick: 'plane', name: 'F{top_pl}:plane', at: [0, 0, H] },
        ops: [{ op: 'circle', id: 'C', cx: '0', cy: '0', d: 'bore_d' }],
      },
      {
        tool: 'extrude',
        id: 'bore',
        say: 'Cut-extrude the circle downwards through all.',
        profile: [region('bore_sk', ['C'], [0, 0, H])],
        direction: 'reverse',
        end: { kind: 'throughAll' },
        op: 'cut',
      },
    ];
  },
  model: (d) => {
    const L = d('base_l');
    const W = d('base_w');
    const T = d('base_t');
    const h = d('loft_h');
    const i = d('inset');
    const a1 = L - 2 * i;
    const b1 = W - 2 * i;
    const a2 = d('top_l');
    const b2 = d('top_w');
    const A1 = a1 * b1;
    const A2 = a2 * b2;
    const Am = ((a1 + a2) / 2) * ((b1 + b2) / 2);
    const terms = [
      term('Flange block', 'base_l x base_w x base_t', L * W * T),
      term(
        'Ruled loft (prismatoid)',
        '(h/6)(A1 + 4 Am + A2), A1 = (l - 2 inset)(w - 2 inset), A2 = top_l top_w, Am = mid-section',
        (h / 6) * (A1 + 4 * Am + A2),
      ),
      term('Bore', '-pi (bore_d/2)^2 (base_t + loft_h)', -PI * (d('bore_d') / 2) ** 2 * (T + h)),
    ];
    return {
      volume: sum(terms),
      bbox: { min: [-L / 2, -W / 2, 0], max: [L / 2, W / 2, T + h] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: inset -> 20 mm', set: { inset: 20 } },
    { name: 'Stage 3: loft_h -> 55 mm', set: { loft_h: 55 } },
    { name: 'Stage 4: top_l -> 24 mm and top_w -> 12 mm', set: { top_l: 24, top_w: 12 } },
  ],
  draw: (d, dr) => {
    const L = d('base_l');
    const W = d('base_w');
    const T = d('base_t');
    const h = d('loft_h');
    const i = d('inset');
    const dim = (name: string) => ({ name, value: d(name), unit: 'mm' as const });
    const top = dr.view(TOP_OF_FRONT, 110, 90, 1.6).caption(-L / 2, W / 2 + 8, 'Top');
    top.rect(-L / 2, -W / 2, L / 2, W / 2);
    // The loft's base outline, inset from the plate's. The loft narrows going up, so its sides face
    // up and this outline is visible from above (it was drawn dashed, which was a misreading).
    top.rect(-L / 2 + i, -W / 2 + i, L / 2 - i, W / 2 - i);
    top.rect(-d('top_l') / 2, -d('top_w') / 2, d('top_l') / 2, d('top_w') / 2);
    top.circle(0, 0, d('bore_d') / 2).centerCross(0, 0, d('bore_d') / 2);
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('base_l'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 14, dim('base_w'));
    // From the middle of the plate's left edge to the loft's base edge, on the same line (y = 0);
    // the dimension line is above the plate.
    top.dimH(-L / 2, 0, -L / 2 + i, 0, W / 2 + 8, dim('inset'));
    top.dimH(-d('top_l') / 2, d('top_w') / 2, d('top_l') / 2, d('top_w') / 2, 6, dim('top_l'));
    top.dimV(d('top_l') / 2, -d('top_w') / 2, d('top_l') / 2, d('top_w') / 2, 8, dim('top_w'));
    top.leader(0, 0, d('bore_d') / 2, -60, 12, dim('bore_d'));
    const front = dr.view(FRONT, 110, 250, 1.6).caption(-L / 2, T + h + 8, 'Front');
    front.rect(-L / 2, 0, L / 2, T);
    front.path(
      [
        [-L / 2 + i, T],
        [-d('top_l') / 2, T + h],
        [d('top_l') / 2, T + h],
        [L / 2 - i, T],
      ],
      false,
    );
    front.dimV(L / 2, 0, L / 2, T, 12, dim('base_t'));
    front.dimV(d('top_l') / 2, T, d('top_l') / 2, T + h, 30, dim('loft_h'));
  },
};
