/**
 * RP10 Comb plate (CSWP-like). A slot pattern with a skipped instance, and a mounting ear with
 * a hole that is mirrored across the YZ plane.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { origin, region, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';

const PI = Math.PI;
const SKIP = [3];

export const rp10: PartDef = {
  id: 'rp10-comb-plate',
  no: 10,
  title: 'Comb plate',
  level: 'CSWP-like',
  summary:
    'An acetal plate with a row of through slots (one instance of the linear pattern skipped) and a drilled mounting ear on each end; the second ear is a mirror of the first.',
  material: 'whittle:acetal-pom',
  dims: {
    plate_l: { value: 120, unit: 'mm', description: 'Plate length (X)' },
    plate_w: { value: 40, unit: 'mm', description: 'Plate width (Y)' },
    plate_t: { value: 8, unit: 'mm', description: 'Thickness of plate and ears (Z)' },
    slot_l: { value: 6, unit: 'mm', description: 'Slot size along X' },
    slot_w: { value: 24, unit: 'mm', description: 'Slot size along Y' },
    slot_x0: { value: -45, unit: 'mm', description: 'X of the first slot centre' },
    slot_pitch: { value: 18, unit: 'mm', description: 'Slot pattern spacing' },
    slot_n: {
      value: 6,
      unit: '',
      description: 'Slot pattern count (including the original and the skipped one)',
    },
    ear_l: { value: 20, unit: 'mm', description: 'Ear length beyond the plate end' },
    ear_w: { value: 24, unit: 'mm', description: 'Ear width (Y)' },
    ear_hole_d: { value: 8, unit: 'mm', description: 'Ear hole diameter' },
  },
  tags: ['extrude', 'cut', 'linearPattern', 'skip', 'mirror'],
  method:
    'Exact. Plate, ears and slots are boxes and the ear holes are cylinders. The slot pattern has slot_n instances; instance 3 is skipped, so slot_n - 1 slots are cut. The mirror copies the ear and its hole, so there are two of each. Accuracy: floating point (1e-12 relative). The surface area is the top and bottom faces plus the side walls (outer outline with the ears attached, slot walls, ear hole walls).',
  steps: (d) => {
    const L = d('plate_l');
    const ex = L / 2 + d('ear_l') / 2;
    return [
      {
        tool: 'sketch',
        id: 'base_sk',
        say: 'Sketch on Top (XY): a rectangle plate_l x plate_w centred on the origin.',
        on: origin('origin:XY'),
        ops: [
          { op: 'rect', id: 'L', x: '-plate_l/2', y: '-plate_w/2', w: 'plate_l', h: 'plate_w' },
        ],
      },
      {
        tool: 'extrude',
        id: 'base',
        say: 'Extrude by plate_t as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [50, 10, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'plate_t' },
        op: 'new',
      },
      {
        tool: 'sketch',
        id: 'slot_sk',
        say: 'Sketch on Top: one slot, slot_l x slot_w, centred on y = 0 with its centre at slot_x0.',
        on: origin('origin:XY'),
        ops: [
          {
            op: 'rect',
            id: 'S',
            x: 'slot_x0 - slot_l/2',
            y: '-slot_w/2',
            w: 'slot_l',
            h: 'slot_w',
          },
        ],
      },
      {
        tool: 'extrude',
        id: 'slot',
        say: 'Cut-extrude the slot through all (both ways from the sketch plane).',
        profile: [region('slot_sk', ['S1', 'S2', 'S3', 'S4'], [d('slot_x0'), 0, 0])],
        direction: 'symmetric',
        end: { kind: 'throughAll' },
        op: 'cut',
      },
      {
        tool: 'linearPattern',
        id: 'slots',
        say: 'Linear pattern of the slot along X: slot_n instances, spacing slot_pitch, skip instance 3.',
        source: { kind: 'features', features: ['slot'] },
        direction: origin('origin:X'),
        reverse: false,
        count: 'slot_n',
        spacing: 'slot_pitch',
        skip: SKIP,
      },
      {
        tool: 'sketch',
        id: 'ear_sk',
        say: 'Sketch on Top: the +X ear, a rectangle ear_l x ear_w against the plate end.',
        on: origin('origin:XY'),
        ops: [{ op: 'rect', id: 'E', x: 'plate_l/2', y: '-ear_w/2', w: 'ear_l', h: 'ear_w' }],
      },
      {
        tool: 'extrude',
        id: 'ear',
        say: 'Extrude the ear by plate_t, adding to the plate.',
        profile: [region('ear_sk', ['E1', 'E2', 'E3', 'E4'], [ex, 0, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'plate_t' },
        op: 'add',
      },
      {
        tool: 'sketch',
        id: 'eh_sk',
        say: 'Sketch on Top: a circle of ear_hole_d at the centre of the ear.',
        on: origin('origin:XY'),
        ops: [{ op: 'circle', id: 'C', cx: 'plate_l/2 + ear_l/2', cy: '0', d: 'ear_hole_d' }],
      },
      {
        tool: 'extrude',
        id: 'eh',
        say: 'Cut-extrude the circle through all (both ways).',
        profile: [region('eh_sk', ['C'], [ex, 0, 0])],
        direction: 'symmetric',
        end: { kind: 'throughAll' },
        op: 'cut',
      },
      {
        tool: 'mirror',
        id: 'mir',
        say: 'Mirror the ear and its hole about the Right plane (YZ).',
        source: { kind: 'features', features: ['ear', 'eh'] },
        plane: origin('origin:YZ'),
      },
    ];
  },
  model: (d) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const sl = d('slot_l');
    const sw = d('slot_w');
    const el = d('ear_l');
    const ew = d('ear_w');
    const hd = d('ear_hole_d');
    const nSlots = Math.round(d('slot_n')) - SKIP.length;
    const terms = [
      term('Plate', 'plate_l x plate_w x plate_t', L * W * T),
      term(
        'Slots (instances minus the skipped one)',
        '-(slot_n - 1) slot_l slot_w plate_t',
        -nSlots * sl * sw * T,
      ),
      term('Two ears', '2 ear_l ear_w plate_t', 2 * el * ew * T),
      term('Two ear holes', '-2 pi (ear_hole_d/2)^2 plate_t', -2 * PI * (hd / 2) ** 2 * T),
    ];
    const faces = L * W - nSlots * sl * sw + 2 * el * ew - 2 * PI * (hd / 2) ** 2;
    const area = 2 * faces + T * (2 * (L + W) + 4 * el + nSlots * 2 * (sl + sw) + 2 * PI * hd);
    return {
      volume: sum(terms),
      area,
      bbox: { min: [-L / 2 - el, -W / 2, 0], max: [L / 2 + el, W / 2, T] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: slot_n -> 7 and slot_pitch -> 15 mm', set: { slot_n: 7, slot_pitch: 15 } },
    { name: 'Stage 3: ear_l -> 26 mm and ear_hole_d -> 10 mm', set: { ear_l: 26, ear_hole_d: 10 } },
    { name: 'Stage 4: plate_t -> 10 mm and slot_w -> 20 mm', set: { plate_t: 10, slot_w: 20 } },
  ],
  draw: (d, dr) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const el = d('ear_l');
    const ew = d('ear_w');
    const dim = (name: string) => ({
      name,
      value: d(name),
      unit: name === 'slot_n' ? ('' as const) : ('mm' as const),
    });
    const top = dr.view('Top', 140, 95, 1.3).caption(-L / 2 - el, W / 2 + 8, 'Top');
    top.path(
      [
        [-L / 2, -W / 2],
        [L / 2, -W / 2],
        [L / 2, -ew / 2],
        [L / 2 + el, -ew / 2],
        [L / 2 + el, ew / 2],
        [L / 2, ew / 2],
        [L / 2, W / 2],
        [-L / 2, W / 2],
        [-L / 2, ew / 2],
        [-L / 2 - el, ew / 2],
        [-L / 2 - el, -ew / 2],
        [-L / 2, -ew / 2],
      ],
      true,
    );
    const n = Math.round(d('slot_n'));
    for (let k = 0; k < n; k++) {
      const x = d('slot_x0') + k * d('slot_pitch');
      top.rect(
        x - d('slot_l') / 2,
        -d('slot_w') / 2,
        x + d('slot_l') / 2,
        d('slot_w') / 2,
        SKIP.includes(k) ? 'hidden' : 'visible',
      );
    }
    for (const s of [-1, 1]) top.circle(s * (L / 2 + el / 2), 0, d('ear_hole_d') / 2);
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('plate_l'));
    top.dimV(-L / 2, -W / 2, -L / 2, W / 2, -8, dim('plate_w'));
    top.dimH(L / 2, ew / 2, L / 2 + el, ew / 2, 6, dim('ear_l'));
    top.dimV(L / 2 + el, -ew / 2, L / 2 + el, ew / 2, 8, dim('ear_w'));
    top.leader(L / 2 + el / 2, 0, d('ear_hole_d') / 2, -60, 16, dim('ear_hole_d'));
    top.dimH(-L / 2, W / 2, d('slot_x0'), W / 2, 7, dim('slot_x0'));
    top.dimH(
      d('slot_x0'),
      -W / 2 + 4,
      d('slot_x0') + d('slot_pitch'),
      -W / 2 + 4,
      -4,
      dim('slot_pitch'),
    );
    top.dimH(
      d('slot_x0') - d('slot_l') / 2,
      d('slot_w') / 2,
      d('slot_x0') + d('slot_l') / 2,
      d('slot_w') / 2,
      4,
      dim('slot_l'),
    );
    top.dimV(
      d('slot_x0') + d('slot_l') / 2,
      -d('slot_w') / 2,
      d('slot_x0') + d('slot_l') / 2,
      d('slot_w') / 2,
      6,
      dim('slot_w'),
    );
    top.note(-L / 2 - el, -W / 2 - 20, dim('slot_n'));
    const front = dr.view('Front', 140, 220, 1.3).caption(-L / 2 - el, T + 12, 'Front');
    front.rect(-L / 2 - el, 0, L / 2 + el, T);
    front.dimV(L / 2 + el, 0, L / 2 + el, T, 12, dim('plate_t'));
  },
};
