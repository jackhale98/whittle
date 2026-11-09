/**
 * RP05 Moulded housing (CSWP-like). A drafted box, shelled open at the top.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { face, origin, region, side, sum, term } from '../lib/geom';
import type { PartDef } from '../lib/types';

const DEG = Math.PI / 180;

/** Integral of (p - 2 t z)(q - 2 t z) dz from z0 to z1. Exact: the integrand is quadratic. */
function slab(p: number, q: number, t: number, z0: number, z1: number): number {
  const F = (z: number) => p * q * z - (p + q) * t * z * z + (4 / 3) * t * t * z ** 3;
  return F(z1) - F(z0);
}

export const rp05: PartDef = {
  id: 'rp05-moulded-housing',
  no: 5,
  title: 'Moulded housing',
  level: 'CSWP-like',
  summary:
    'An ABS housing: a box whose four walls lean inward by a draft angle, then hollowed to a uniform wall with the top face removed.',
  material: 'whittle:abs',
  dims: {
    base_l: { value: 90, unit: 'mm', description: 'Length at the bottom (X)' },
    base_w: { value: 60, unit: 'mm', description: 'Width at the bottom (Y)' },
    height: { value: 40, unit: 'mm', description: 'Height (Z)' },
    draft_a: { value: 3, unit: 'deg', description: 'Draft angle of the four walls' },
    wall: {
      value: 3,
      unit: 'mm',
      description: 'Wall thickness, measured normal to the walls and floor',
    },
  },
  tags: ['extrude', 'draft', 'shell'],
  method:
    'Exact by integration. The cross-section at height z is a rectangle (l - 2 z tan a) x (w - 2 z tan a); its area is quadratic in z, so the antiderivative is exact. The cavity is the same family inset horizontally by wall/cos(a) on every side (the wall is thick normal to the drafted face) and starting at z = wall (the floor is horizontal). Volume = outer integral minus cavity integral. Accuracy: floating point (1e-12 relative). Assumed draft direction: neutral plane = the bottom face, walls lean inward going up (the top is smaller).',
  steps: (d) => {
    const L = d('base_l');
    const W = d('base_w');
    const H = d('height');
    const sideFace = (l: string, at: [number, number, number]) =>
      face(side('base', 'base_sk', l), at);
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
        say: 'Extrude by height as a new body.',
        profile: [region('base_sk', ['L1', 'L2', 'L3', 'L4'], [20, 10, 0])],
        direction: 'normal',
        end: { kind: 'blind', depth: 'height' },
        op: 'new',
      },
      {
        tool: 'draft',
        id: 'dr',
        say: 'Draft the four side faces by draft_a, neutral plane = the bottom face, so the walls lean inward going up.',
        faces: [
          sideFace('L1', [0, -W / 2, H / 2]),
          sideFace('L2', [L / 2, 0, H / 2]),
          sideFace('L3', [0, W / 2, H / 2]),
          sideFace('L4', [-L / 2, 0, H / 2]),
        ],
        neutral: face('F{base}:start', [10, 10, 0]),
        angle: 'draft_a',
        reverse: false,
      },
      {
        tool: 'shell',
        id: 'sh',
        say: 'Shell inward by wall, removing the top face.',
        openFaces: [face('F{base}:end', [10, 10, H])],
        thickness: 'wall',
        direction: 'inward',
      },
    ];
  },
  model: (d) => {
    const L = d('base_l');
    const W = d('base_w');
    const H = d('height');
    const tw = d('wall');
    const a = d('draft_a') * DEG;
    const t = Math.tan(a);
    const s = tw / Math.cos(a);
    const outer = slab(L, W, t, 0, H);
    const cavity = slab(L - 2 * s, W - 2 * s, t, tw, H);
    const terms = [
      term('Drafted box', 'integral 0..H of (l - 2 z tan a)(w - 2 z tan a) dz', outer),
      term(
        'Cavity',
        '-integral wall..H of (l - 2 s - 2 z tan a)(w - 2 s - 2 z tan a) dz, s = wall/cos a',
        -cavity,
      ),
    ];
    return {
      volume: sum(terms),
      bbox: { min: [-L / 2, -W / 2, 0], max: [L / 2, W / 2, H] },
      terms,
    };
  },
  stages: [
    { name: 'Stage 2: wall -> 4 mm', set: { wall: 4 } },
    { name: 'Stage 3: draft_a -> 5 deg', set: { draft_a: 5 } },
    { name: 'Stage 4: height -> 50 mm and base_l -> 100 mm', set: { height: 50, base_l: 100 } },
  ],
  draw: (d, dr) => {
    const L = d('base_l');
    const W = d('base_w');
    const H = d('height');
    const t = Math.tan(d('draft_a') * DEG);
    const tw = d('wall');
    const s = tw / Math.cos(d('draft_a') * DEG);
    const dim = (name: string, unit: 'mm' | 'deg' = 'mm') => ({ name, value: d(name), unit });
    const top = dr.view('Top', 118, 85, 1.6).caption(-L / 2, W / 2 + 8, 'Top');
    top.rect(-L / 2, -W / 2, L / 2, W / 2);
    top.rect(-L / 2 + H * t, -W / 2 + H * t, L / 2 - H * t, W / 2 - H * t, 'hidden');
    top.dimH(-L / 2, -W / 2, L / 2, -W / 2, -9, dim('base_l'));
    top.dimV(L / 2, -W / 2, L / 2, W / 2, 14, dim('base_w'));
    const front = dr
      .view('Front (section)', 118, 235, 1.6)
      .caption(-L / 2, H + 12, 'Section through the centre');
    const lo = L / 2;
    const hi = L / 2 - H * t;
    front.path(
      [
        [-lo, 0],
        [lo, 0],
        [hi, H],
        [-hi, H],
      ],
      true,
    );
    front.line(-lo + s + tw * t, tw, lo - s - tw * t, tw);
    front.line(lo - s - tw * t, tw, hi - s, H);
    front.line(-lo + s + tw * t, tw, -(hi - s), H);
    front.dimV(lo, 0, lo, H, 14, dim('height'));
    front.dimH(-lo, 0, -lo + tw, 0, -8, dim('wall'));
    front.note(hi + 2, H - 6, dim('draft_a', 'deg'));
  },
};
