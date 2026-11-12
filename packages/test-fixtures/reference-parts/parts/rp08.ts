/**
 * RP08 Cover plate (CSWP-like). Hole wizard: counterbore, countersink at a reference point,
 * and tapped holes in a linear pattern with a skipped instance.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { edgeName, face, frustumVolumeBeyond, origin, region, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';
import { frontSection, TOP } from '../lib/views';

const PI = Math.PI;

/** ISO 273 (medium series) clearance for M6, and ISO 261/262 coarse tap drill for M8. */
const CLEAR_M6 = 6.6;
const TAP_DRILL_M8 = 6.8;

export const rp08: PartDef = {
  id: 'rp08-cover-plate',
  no: 8,
  title: 'Cover plate',
  level: 'CSWP-like',
  summary:
    'A stainless plate with an M6 counterbored hole, an M6 countersunk hole placed on a reference point, and a row of blind M8 tapped holes patterned along X with one instance skipped.',
  material: 'whittle:stainless-steel-304',
  dims: {
    plate_l: { value: 100, unit: 'mm', description: 'Plate length (X)' },
    plate_w: { value: 70, unit: 'mm', description: 'Plate width (Y)' },
    plate_t: { value: 14, unit: 'mm', description: 'Plate thickness (Z)' },
    cb_x: { value: -30, unit: 'mm', description: 'Counterbored hole X' },
    cb_y: { value: 18, unit: 'mm', description: 'Counterbored hole Y' },
    cb_d: { value: 11, unit: 'mm', description: 'Counterbore diameter' },
    cb_h: { value: 6.5, unit: 'mm', description: 'Counterbore depth' },
    cs_x: { value: 30, unit: 'mm', description: 'Countersunk hole X (the reference point)' },
    cs_y: { value: 18, unit: 'mm', description: 'Countersunk hole Y (the reference point)' },
    cs_d: {
      value: 12.4,
      unit: 'mm',
      description: 'Countersink diameter at the face (90 degree cone)',
    },
    tap_x0: { value: -36, unit: 'mm', description: 'X of the first tapped hole' },
    tap_dx: { value: 24, unit: 'mm', description: 'Pattern spacing along X' },
    tap_n: {
      value: 3,
      unit: '',
      description:
        'Number of tapped holes: the pattern has tap_n + 1 positions, position 1 skipped (corrected from the pattern setting 4, see the README)',
    },
    tap_y: { value: -18, unit: 'mm', description: 'Y of the tapped row' },
    tap_depth: { value: 12, unit: 'mm', description: 'Tapped hole depth (drill depth)' },
  },
  tags: [
    'extrude',
    'point',
    'holeCounterbore',
    'holeCountersink',
    'holeTapped',
    'linearPattern',
    'skip',
  ],
  standards: [
    { ref: 'ISO 273 medium clearance, M6', value: `${CLEAR_M6} mm` },
    { ref: 'ISO 261/262 coarse tap drill, M8 (pitch 1.25)', value: `${TAP_DRILL_M8} mm` },
  ],
  method:
    'Exact. Every hole is a cylinder, a step or a cone frustum. The counterbore and countersink diameters and depths are the named dimensions above (so the model does not depend on a table row that might be edited); only the clearance diameter (M6, normal fit, 6.6 mm) and the tap drill (M8, 6.8 mm) come from the ISO tables. The tapped hole is its drill diameter, flat-bottomed, to tap_depth; the cosmetic thread adds no geometry. The pattern has tap_n + 1 positions; position 1 is skipped, so tap_n holes are drilled. Accuracy: floating point (1e-12 relative). If the kernel hole tables ever change these two values the golden fails by design.',
  steps: (d) => {
    const T = d('plate_t');
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
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [40, 25, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'plate_t' },
        op: 'new',
      },
      {
        tool: 'point',
        id: 'cs_pt',
        say: 'Reference point at (cs_x, cs_y) on the top face (coordinates).',
        definition: { kind: 'coordinates', x: 'cs_x', y: 'cs_y', z: 'plate_t' },
      },
      {
        tool: 'sketch',
        id: 'pts_sk',
        say: 'Sketch on the top face: a point for the counterbored hole and a point for the first tapped hole.',
        on: face('F{base}:end', [40, 25, T]),
        ops: [
          { op: 'point', id: 'CB', x: 'cb_x', y: 'cb_y' },
          { op: 'point', id: 'TP', x: 'tap_x0', y: 'tap_y' },
        ],
      },
      {
        tool: 'hole',
        id: 'h_cb',
        say: 'Hole wizard: ISO counterbore for M6 (normal fit) at the first point, through all; counterbore cb_d x cb_h.',
        points: [{ pick: 'vertex', name: 'S{pts_sk}:p(CB)', at: [d('cb_x'), d('cb_y'), T] }],
        face: face('F{base}:end', [40, 25, T]),
        standard: 'ISO',
        kind: 'counterbore',
        size: 'M6',
        fit: 'normal',
        end: { kind: 'throughAll' },
        counterbore: { diameter: 'cb_d', depth: 'cb_h' },
      },
      {
        tool: 'hole',
        id: 'h_cs',
        say: 'Hole wizard: ISO countersink for M6 (normal fit) on the reference point, through all; countersink cs_d, 90 degrees.',
        points: [{ pick: 'point', name: 'F{cs_pt}:point', at: [d('cs_x'), d('cs_y'), T] }],
        face: face('F{base}:end', [40, 25, T]),
        standard: 'ISO',
        kind: 'countersink',
        size: 'M6',
        fit: 'normal',
        end: { kind: 'throughAll' },
        countersink: { diameter: 'cs_d', angle: '90 deg' },
      },
      {
        tool: 'hole',
        id: 'h_tap',
        say: 'Hole wizard: tapped M8 (tap drill from the table) at the third point, blind to tap_depth, cosmetic thread over the full depth.',
        points: [{ pick: 'vertex', name: 'S{pts_sk}:p(TP)', at: [d('tap_x0'), d('tap_y'), T] }],
        face: face('F{base}:end', [40, 25, T]),
        standard: 'ISO',
        kind: 'tapped',
        size: 'M8',
        fit: 'normal',
        end: { kind: 'blind', depth: 'tap_depth' },
        thread: {},
      },
      {
        tool: 'linearPattern',
        id: 'pat',
        say: 'Linear pattern of the tapped hole along X: tap_n + 1 instances, spacing tap_dx, skip instance 1 (tap_n holes).',
        source: { kind: 'features', features: ['h_tap'] },
        direction: origin('origin:X'),
        reverse: false,
        count: 'tap_n + 1',
        spacing: 'tap_dx',
        skip: [1],
      },
    ];
  },
  model: (d) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const rc = CLEAR_M6 / 2;
    const cbR = d('cb_d') / 2;
    const csR = d('cs_d') / 2;
    const csDepth = csR - rc; // 90 degree cone: depth equals the radial step
    const nTap = Math.round(d('tap_n')); // tap_n + 1 positions, one skipped
    const terms = [
      term('Plate', 'plate_l x plate_w x plate_t', L * W * T),
      term('Counterbored hole: clearance bore', `-pi (${CLEAR_M6}/2)^2 plate_t`, -PI * rc * rc * T),
      term(
        'Counterbored hole: counterbore step',
        '-pi ((cb_d/2)^2 - (6.6/2)^2) cb_h',
        -PI * (cbR * cbR - rc * rc) * d('cb_h'),
      ),
      term('Countersunk hole: clearance bore', `-pi (${CLEAR_M6}/2)^2 plate_t`, -PI * rc * rc * T),
      term(
        'Countersunk hole: cone beyond the bore',
        '-(frustum(cs_d/2, 6.6/2, depth) - pi (6.6/2)^2 depth), depth = cs_d/2 - 6.6/2',
        -frustumVolumeBeyond(csR, rc, csDepth),
      ),
      term(
        'Tapped holes (tap_n + 1 positions minus the skipped one)',
        `-tap_n pi (${TAP_DRILL_M8}/2)^2 tap_depth`,
        -nTap * PI * (TAP_DRILL_M8 / 2) ** 2 * d('tap_depth'),
      ),
    ];
    return {
      volume: sum(terms),
      bbox: { min: [-L / 2, -W / 2, 0], max: [L / 2, W / 2, T] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: plate_t -> 18 mm', set: { plate_t: 18 } },
    { name: 'Stage 3: cb_h -> 8 mm and cs_d -> 13 mm', set: { cb_h: 8, cs_d: 13 } },
    {
      name: 'Stage 4: tap_n -> 4 (five positions, one skipped), tap_dx -> 16 mm, tap_x0 -> -32 mm',
      set: { tap_n: 4, tap_dx: 16, tap_x0: -32 },
    },
  ],
  draw: (d, dr) => {
    const L = d('plate_l');
    const W = d('plate_w');
    const T = d('plate_t');
    const dim = (name: string) => ({
      name,
      value: d(name),
      unit: name === 'tap_n' ? ('' as const) : ('mm' as const),
    });
    const top = dr.view(TOP, 150, 95, 1.55).caption(-L / 2, W / 2 + 8, 'Top');
    top.rect(-L / 2, -W / 2, L / 2, W / 2);
    top.circle(d('cb_x'), d('cb_y'), CLEAR_M6 / 2);
    top.circle(d('cb_x'), d('cb_y'), d('cb_d') / 2);
    top.circle(d('cs_x'), d('cs_y'), CLEAR_M6 / 2);
    top.circle(d('cs_x'), d('cs_y'), d('cs_d') / 2);
    const n = Math.round(d('tap_n')) + 1; // positions, the skipped one included
    for (let k = 0; k < n; k++) {
      const x = d('tap_x0') + k * d('tap_dx');
      top.circle(x, d('tap_y'), TAP_DRILL_M8 / 2, k === 1 ? 'hidden' : 'visible');
      top.centerCross(x, d('tap_y'), TAP_DRILL_M8 / 2);
    }
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('plate_l'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 14, dim('plate_w'));
    top.dimH(0, d('cb_y'), d('cb_x'), d('cb_y'), 16, dim('cb_x'));
    top.dimV(-L / 2, 0, -L / 2, d('cb_y'), -12, dim('cb_y'));
    top.leader(d('cb_x'), d('cb_y'), d('cb_d') / 2, 110, 14, dim('cb_d'));
    // Countersink position from the centre lines (the origin planes seen from above), to the rim of
    // the countersink on the top face, at its centre.
    top.line(0, -W / 2 - 3, 0, W / 2 + 3, 'center');
    top.line(-L / 2 - 3, 0, L / 2 + 3, 0, 'center');
    const csRim = edgeName('F{base}:end', 'F{h_cs}:hole(F{cs_pt}:point):csink');
    top.dimH(0, d('cs_y'), d('cs_x'), d('cs_y'), 8, dim('cs_x'), {
      refs: [
        { name: 'origin:Y', kind: 'edge' },
        { name: csRim, kind: 'edge', at: 'center' },
      ],
    });
    top.dimV(d('cs_x'), 0, d('cs_x'), d('cs_y'), L / 2 - d('cs_x') + 8, dim('cs_y'), {
      refs: [
        { name: 'origin:X', kind: 'edge' },
        { name: csRim, kind: 'edge', at: 'center' },
      ],
    });
    top.leader(d('cs_x'), d('cs_y'), d('cs_d') / 2, 70, 14, dim('cs_d'));
    top.dimH(0, d('tap_y'), d('tap_x0'), d('tap_y'), -10, dim('tap_x0'));
    // The spacing between two holes that exist (positions 2 and 3; position 1 is skipped), measured
    // centre to centre, its dimension line 12 mm below the row as before.
    top.dimH(
      d('tap_x0') + 2 * d('tap_dx'),
      d('tap_y'),
      d('tap_x0') + 3 * d('tap_dx'),
      d('tap_y'),
      -12,
      dim('tap_dx'),
    );
    top.dimV(-L / 2, 0, -L / 2, d('tap_y'), -12, dim('tap_y'));
    top.note(-L / 2, -W / 2 - 18, dim('tap_n'), 'count');
    const front = dr
      .view(
        // Through both hole rows: the cut steps from the counterbore and countersink row to the
        // tapped row, an offset section.
        frontSection(
          'Front (section)',
          [
            [-L / 2 - 5, d('cb_y')],
            [0, d('cb_y')],
            [0, d('tap_y')],
            [L / 2 + 5, d('tap_y')],
          ],
          'below',
        ),
        150,
        235,
        1.55,
      )
      .caption(-L / 2, T + 14, 'Section through the hole rows');
    front.rect(-L / 2, 0, L / 2, T);
    front.rect(d('cb_x') - d('cb_d') / 2, T - d('cb_h'), d('cb_x') + d('cb_d') / 2, T, 'hidden');
    front.dimV(L / 2, 0, L / 2, T, 12, dim('plate_t'));
    front.dimV(
      d('cb_x') - d('cb_d') / 2,
      T - d('cb_h'),
      d('cb_x') - d('cb_d') / 2,
      T,
      -12,
      dim('cb_h'),
    );
    // At the second tapped hole (position 2, x = tap_x0 + 2 tap_dx): the stepped cut passes through
    // the tapped row only from x = 0 on, so the first hole (at tap_x0) is not cut.
    const tx = d('tap_x0') + 2 * d('tap_dx');
    front.dimV(tx, T - d('tap_depth'), tx, T, -12, dim('tap_depth'), {
      refs: [
        { name: 'F{h_tap}:hole(S{pts_sk}:p(TP)):bottom', kind: 'face' },
        { name: 'F{base}:end', kind: 'face' },
      ],
    });
  },
};
