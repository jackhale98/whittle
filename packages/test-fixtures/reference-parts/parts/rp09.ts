/**
 * RP09 Flanged hub (CSWP-like). A revolved hub, a reference axis from its bore, and a circular
 * pattern of bolt holes with two skipped instances.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { face, origin, region, side, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';

const PI = Math.PI;
const SKIP = [2, 5];

export const rp09: PartDef = {
  id: 'rp09-flanged-hub',
  no: 9,
  title: 'Flanged hub',
  level: 'CSWP-like',
  summary:
    'A cast-iron flanged hub revolved from one profile, with a ring of bolt holes made by a circular pattern about a reference axis taken from the bore, two instances left out.',
  material: 'whittle:cast-iron',
  dims: {
    flange_d: { value: 120, unit: 'mm', description: 'Flange outside diameter' },
    flange_t: { value: 12, unit: 'mm', description: 'Flange thickness' },
    hub_d: { value: 56, unit: 'mm', description: 'Hub outside diameter' },
    hub_h: { value: 30, unit: 'mm', description: 'Hub height above the flange' },
    bore_d: { value: 32, unit: 'mm', description: 'Through bore diameter' },
    bolt_d: {
      value: 9,
      unit: 'mm',
      description: 'Bolt hole diameter (ISO 273 M8 normal clearance)',
    },
    pcd: { value: 90, unit: 'mm', description: 'Bolt circle diameter' },
    bolt_n: {
      value: 8,
      unit: '',
      description: 'Pattern count (including the original and the skipped ones)',
    },
  },
  tags: ['revolve', 'axis', 'circularPattern', 'skip'],
  method:
    'Exact. The solid of revolution is two stacked annular cylinders; each bolt hole is a cylinder through the flange only (the bolt circle lies outside the hub). The pattern has bolt_n instances equally spaced over 360 degrees; instances 2 and 5 are skipped, so bolt_n - 2 holes are cut. The surface area adds the cylinders and annuli and replaces, for each hole, two annular patches by the hole wall. Accuracy: floating point (1e-12 relative).',
  steps: (d) => {
    const t = d('flange_t');
    const R = d('flange_d') / 2;
    return [
      {
        tool: 'sketch',
        id: 'prof_sk',
        say: 'Sketch on Front (XZ): the half section of the hub, bore edge to flange rim to hub top, as a closed polygon.',
        on: origin('origin:XZ'),
        ops: [
          {
            op: 'polygon',
            id: 'L',
            pts: [
              ['bore_d/2', '0'],
              ['flange_d/2', '0'],
              ['flange_d/2', 'flange_t'],
              ['hub_d/2', 'flange_t'],
              ['hub_d/2', 'flange_t + hub_h'],
              ['bore_d/2', 'flange_t + hub_h'],
            ],
          },
        ],
      },
      {
        tool: 'revolve',
        id: 'hub',
        say: 'Revolve the profile 360 degrees about the Z axis.',
        profile: [
          region(
            'prof_sk',
            ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'],
            [(R + d('bore_d') / 2) / 2, 0, t / 2],
          ),
        ],
        axis: origin('origin:Z'),
        angle: '360 deg',
        direction: 'normal',
        op: 'new',
      },
      {
        tool: 'axis',
        id: 'ax',
        say: 'Reference axis: through the axis of the bore (pick the bore face).',
        definition: {
          kind: 'cylinder',
          face: face(side('hub', 'prof_sk', 'L6'), [d('bore_d') / 2, 0, t + d('hub_h') / 2]),
        },
      },
      {
        tool: 'sketch',
        id: 'bolt_sk',
        say: 'Sketch on the flange top face: one point on the bolt circle at (pcd/2, 0).',
        on: face(side('hub', 'prof_sk', 'L3'), [(R + d('hub_d') / 2) / 2, 0, t]),
        ops: [{ op: 'point', id: 'P', x: 'pcd/2', y: '0' }],
      },
      {
        tool: 'hole',
        id: 'bolt',
        say: 'Hole wizard: simple ISO M8 clearance hole (normal fit), through all.',
        points: [{ pick: 'vertex', name: 'S{bolt_sk}:p(P)', at: [d('pcd') / 2, 0, t] }],
        face: face(side('hub', 'prof_sk', 'L3'), [(R + d('hub_d') / 2) / 2, 0, t]),
        standard: 'ISO',
        kind: 'simple',
        size: 'M8',
        fit: 'normal',
        end: { kind: 'throughAll' },
      },
      {
        tool: 'circularPattern',
        id: 'ring',
        say: 'Circular pattern of the hole about the reference axis: bolt_n instances over 360 degrees, equal spacing, skip instances 2 and 5.',
        source: { kind: 'features', features: ['bolt'] },
        axis: { pick: 'axis', name: 'F{ax}:axis', at: [0, 0, 0] },
        count: 'bolt_n',
        angle: '360 deg',
        equalSpacing: true,
        skip: SKIP,
      },
    ];
  },
  model: (d) => {
    const R = d('flange_d') / 2;
    const rh = d('hub_d') / 2;
    const rb = d('bore_d') / 2;
    const t = d('flange_t');
    const hh = d('hub_h');
    const rbolt = d('bolt_d') / 2;
    const nHoles = Math.round(d('bolt_n')) - SKIP.length;
    const terms = [
      term('Flange disc', 'pi (flange_d/2)^2 flange_t', PI * R * R * t),
      term('Hub cylinder', 'pi (hub_d/2)^2 hub_h', PI * rh * rh * hh),
      term('Bore', '-pi (bore_d/2)^2 (flange_t + hub_h)', -PI * rb * rb * (t + hh)),
      term(
        'Bolt holes (instances minus the skipped ones)',
        '-(bolt_n - 2) pi (bolt_d/2)^2 flange_t',
        -nHoles * PI * rbolt * rbolt * t,
      ),
    ];
    const H = t + hh;
    const area =
      PI * (R * R - rb * rb) + // bottom
      2 * PI * R * t + // rim
      PI * (R * R - rh * rh) + // flange top
      2 * PI * rh * hh + // hub side
      PI * (rh * rh - rb * rb) + // hub top
      2 * PI * rb * H + // bore wall
      nHoles * (2 * PI * rbolt * t - 2 * PI * rbolt * rbolt); // holes: wall minus the two removed discs
    return {
      volume: sum(terms),
      area,
      bbox: { min: [-R, -R, 0], max: [R, R, H] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: bolt_n -> 10 (instances 2 and 5 still skipped)', set: { bolt_n: 10 } },
    { name: 'Stage 3: pcd -> 100 mm', set: { pcd: 100 } },
    { name: 'Stage 4: hub_h -> 45 mm and bore_d -> 36 mm', set: { hub_h: 45, bore_d: 36 } },
  ],
  draw: (d, dr) => {
    const R = d('flange_d') / 2;
    const rh = d('hub_d') / 2;
    const rb = d('bore_d') / 2;
    const t = d('flange_t');
    const hh = d('hub_h');
    const dim = (name: string) => ({
      name,
      value: d(name),
      unit: name === 'bolt_n' ? ('' as const) : ('mm' as const),
    });
    const top = dr.view('Top', 110, 135, 1.4).caption(-R, R + 10, 'Top');
    top.circle(0, 0, R).circle(0, 0, rh).circle(0, 0, rb);
    top.circle(0, 0, d('pcd') / 2, 'center');
    const n = Math.round(d('bolt_n'));
    for (let k = 0; k < n; k++) {
      const a = (2 * PI * k) / n;
      const x = (d('pcd') / 2) * Math.cos(a);
      const y = (d('pcd') / 2) * Math.sin(a);
      top.circle(x, y, d('bolt_d') / 2, SKIP.includes(k) ? 'hidden' : 'visible');
    }
    top.dimH(-R, -R, R, -R, -8, dim('flange_d'));
    top.leader(0, 0, rh, 235, 22, dim('hub_d'));
    top.leader(0, 0, rb, 200, 26, dim('bore_d'));
    top.leader(d('pcd') / 2, 0, d('bolt_d') / 2, 15, 18, dim('bolt_d'));
    top.leader(0, 0, d('pcd') / 2, 120, 36, dim('pcd'));
    top.note(R + 5, -R, dim('bolt_n'));
    const front = dr
      .view('Front (section)', 320, 200, 1.5)
      .caption(-R, t + hh + 12, 'Section through the axis');
    front.path(
      [
        [rb, 0],
        [R, 0],
        [R, t],
        [rh, t],
        [rh, t + hh],
        [rb, t + hh],
      ],
      true,
    );
    front.path(
      [
        [-rb, 0],
        [-R, 0],
        [-R, t],
        [-rh, t],
        [-rh, t + hh],
        [-rb, t + hh],
      ],
      true,
    );
    front.line(0, -6, 0, t + hh + 6, 'center');
    front.dimV(-R, 0, -R, t, -8, dim('flange_t'));
    front.dimV(rh, t, rh, t + hh, 14, dim('hub_h'));
  },
};
