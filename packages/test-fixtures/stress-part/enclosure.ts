/**
 * The "stress part": an injection-moulded-style enclosure with 100+ features driven by a dozen
 * named parameters. Written with the reference-part step DSL so every reference is a real
 * persistent name that the regen engine resolves (no guessed topology: a name that does not
 * resolve makes the feature "needs attention", and the tests assert every feature is `ok`).
 *
 * Coordinates: the box is centred on the origin in XY, z = 0 at the bottom (the draft's neutral
 * plane), the open face is the top. Sketch planes: XY (x, y); XZ (x, z), extrudes toward -Y;
 * YZ (y, z), extrudes toward +X.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { stepFid } from '../reference-parts/lib/builder';
import { edge, edgeName, face, origin, region, side } from '../reference-parts/lib/geom';
import type { Pick, Step } from '../reference-parts/lib/types';

export const ENCLOSURE_DIMS = {
  length: { value: 120, unit: 'mm', description: 'Outer length at the bottom (X)' },
  width: { value: 80, unit: 'mm', description: 'Outer width at the bottom (Y)' },
  height: { value: 40, unit: 'mm', description: 'Height (Z)' },
  wall: { value: 2.5, unit: 'mm', description: 'Wall thickness' },
  draft_a: { value: 2, unit: 'deg', description: 'Draft angle of the four walls' },
  corner_r: { value: 6, unit: 'mm', description: 'Radius of the vertical corners' },
  edge_r: { value: 4, unit: 'mm', description: 'Radius of the bottom edge loop' },
  boss_d: { value: 8, unit: 'mm', description: 'Screw boss diameter' },
  boss_h: { value: 28, unit: 'mm', description: 'Screw boss height above the floor' },
  boss_in: { value: 11, unit: 'mm', description: 'Boss centre inset from the outer walls' },
  rib_t: { value: 1.5, unit: 'mm', description: 'Rib thickness' },
  rib_h: { value: 10, unit: 'mm', description: 'Rib height above the floor' },
  fillet_r: { value: 0.8, unit: 'mm', description: 'Small blend radius (rim, boss and rib roots)' },
  vent_w: { value: 2, unit: 'mm', description: 'Vent slot width' },
  vent_pitch: { value: 5, unit: 'mm', description: 'Vent slot pitch' },
  ear_t: { value: 3, unit: 'mm', description: 'Mounting ear thickness' },
} as const;

export type EnclosureDims = Record<keyof typeof ENCLOSURE_DIMS, number>;

export const baselineEnclosureDims = (): EnclosureDims =>
  Object.fromEntries(Object.entries(ENCLOSURE_DIMS).map(([k, v]) => [k, v.value])) as EnclosureDims;

const FLOOR = 'F{sh}:shell(F{base}:start)';
const RIM = 'F{sh}:rim(F{base}:end)';
const LS = ['L1', 'L2', 'L3', 'L4'];
const CORNERS = [
  ['L1', 'L2'],
  ['L2', 'L3'],
  ['L3', 'L4'],
  ['L4', 'L1'],
] as const;

/** Name of pattern instance `k` (0 = the original) of `name`, patterned by feature `pat`. */
const inst = (pat: string, k: number, name: string) =>
  k === 0 ? name : `F{${pat}}:inst${k}(${name})`;
/** Name of mirror copy of `name` made by feature `mir`. */
const mirrored = (mir: string, name: string) => `F{${mir}}:mirror(${name})`;

/**
 * Edge between two faces. The kernel sorts the two face names after the ids are substituted, while
 * `edgeName` would sort the `F{step}` placeholders, so the order is fixed up in `finalize`.
 */
const E = (a: string, b: string): Pick => edge(`edge(${a}|${b})`);

/** Step ids are `01JRP<no><index+1>`; `no` is an arbitrary part number unique to this part. */
export const ENCLOSURE_NO = 90;

function sortEdgeName(name: string, ids: Map<string, string>): string {
  const inner = name.slice('edge('.length, -1);
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) cut = i;
  }
  if (cut < 0) return name;
  const resolve = (x: string) =>
    x.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, id: string) => ids.get(id) ?? _m);
  return `edge(${[resolve(inner.slice(0, cut)), resolve(inner.slice(cut + 1))].sort().join('|')})`;
}

function finalize(steps: Step[]): Step[] {
  const ids = new Map(steps.map((s, i) => [s.id, stepFid(ENCLOSURE_NO, i)]));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if (o.pick === 'edge' && typeof o.name === 'string' && o.name.startsWith('edge(')) {
        return { ...o, name: sortEdgeName(o.name, ids) };
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(steps) as Step[];
}

export function enclosureSteps(_d: EnclosureDims, opts: { fillets?: boolean } = {}): Step[] {
  const withFillets = opts.fillets ?? true;
  const steps: Step[] = [];
  const add = (...s: Step[]) => steps.push(...s);

  const sketch = (id: string, name: string, on: Pick, ops: Step['ops']): Step => ({
    tool: 'sketch',
    id,
    name,
    say: name,
    on,
    ops,
  });
  const rectOp = (id: string, x: string, y: string, w: string, h: string) =>
    ({ op: 'rect', id, x, y, w, h }) as const;
  const prof = (sk: string, curves: string[]) => region(sk, curves, [0, 0, 0]);
  const R4 = ['R1', 'R2', 'R3', 'R4'];
  const extrudeStep = (
    id: string,
    name: string,
    sk: string,
    curves: string[],
    depth: string,
    op: 'add' | 'cut' | 'new',
    direction: 'normal' | 'reverse' | 'symmetric' = 'normal',
  ): Step => ({
    tool: 'extrude',
    id,
    name,
    say: name,
    profile: [prof(sk, curves)],
    direction,
    end: { kind: 'blind', depth },
    op,
  });
  const fillet = (id: string, name: string, edges: Pick[], radius: string): Step => ({
    tool: 'fillet',
    id,
    name,
    say: name,
    edges,
    radius,
  });
  const chamfer = (id: string, name: string, edges: Pick[], distance: string): Step => ({
    tool: 'chamfer',
    id,
    name,
    say: name,
    edges,
    mode: { kind: 'distance', distance },
  });
  const linear = (
    id: string,
    name: string,
    features: string[],
    dir: string,
    count: string,
    spacing: string,
    reverse = false,
    second?: { dir: string; count: string; spacing: string; reverse?: boolean },
  ): Step => ({
    tool: 'linearPattern',
    id,
    name,
    say: name,
    source: { kind: 'features', features },
    direction: origin(dir),
    reverse,
    count,
    spacing,
    ...(second === undefined
      ? {}
      : {
          second: {
            direction: origin(second.dir),
            reverse: second.reverse ?? false,
            count: second.count,
            spacing: second.spacing,
          },
        }),
  });
  const mirror = (id: string, name: string, features: string[], plane: string): Step => ({
    tool: 'mirror',
    id,
    name,
    say: name,
    source: { kind: 'features', features },
    plane: origin(plane),
  });

  // ---- A. moulded shell ------------------------------------------------------------------
  add(
    sketch('base_sk', 'Base outline', origin('origin:XY'), [
      { op: 'rect', id: 'L', x: '-length/2', y: '-width/2', w: 'length', h: 'width' },
    ]),
    {
      ...extrudeStep('base', 'Body', 'base_sk', LS, 'height', 'new'),
    },
    {
      tool: 'draft',
      id: 'dr',
      name: 'Wall draft',
      say: 'Draft the four walls about the bottom face.',
      faces: LS.map((l) => face(side('base', 'base_sk', l))),
      neutral: face('F{base}:start'),
      angle: 'draft_a',
      reverse: false,
    },
    fillet(
      'fc',
      'Corner radii',
      CORNERS.map(([a, b]) => E(side('base', 'base_sk', a), side('base', 'base_sk', b))),
      'corner_r',
    ),
  );
  const outerWalls = LS.map((l) => side('base', 'base_sk', l));
  const cornerFaces = CORNERS.map(
    ([a, b]) => `F{fc}:fillet(${edgeName(side('base', 'base_sk', a), side('base', 'base_sk', b))})`,
  );
  if (withFillets) {
    add(
      fillet(
        'fbot',
        'Bottom edge loop',
        [...outerWalls, ...cornerFaces].map((f) => E('F{base}:start', f)),
        'edge_r',
      ),
    );
  }
  add({
    tool: 'shell',
    id: 'sh',
    name: 'Shell',
    say: 'Hollow out, open top.',
    openFaces: [face('F{base}:end')],
    thickness: 'wall',
    direction: 'inward',
  });
  const innerWalls = [...outerWalls, ...cornerFaces].map((f) => `F{sh}:shell(${f})`);
  if (withFillets) {
    add(
      fillet(
        'frim',
        'Rim blends',
        [...outerWalls, ...cornerFaces, ...innerWalls].map((f) => E(f, RIM)),
        'fillet_r',
      ),
    );
  }

  // ---- B. screw bosses (2 x 2) with tapped holes ----------------------------------------
  add(
    sketch('boss_sk', 'Boss sketch', face(FLOOR), [
      { op: 'circle', id: 'C', cx: 'length/2 - boss_in', cy: 'width/2 - boss_in', d: 'boss_d' },
    ]),
    extrudeStep('boss', 'Screw boss', 'boss_sk', ['C'], 'boss_h', 'add'),
    sketch('boss_pt', 'Boss hole point', face('F{boss}:end'), [
      { op: 'point', id: 'P', x: 'length/2 - boss_in', y: 'width/2 - boss_in' },
    ]),
    {
      tool: 'hole',
      id: 'boss_hole',
      name: 'Boss tapped hole',
      say: 'Tapped M3 hole.',
      points: [{ pick: 'vertex', name: 'S{boss_pt}:p(P)' }],
      face: face('F{boss}:end'),
      standard: 'ISO',
      kind: 'tapped',
      size: 'M3',
      fit: 'normal',
      end: { kind: 'blind', depth: '10 mm' },
      thread: {},
    },
    linear(
      'boss_x',
      'Boss pattern',
      ['boss', 'boss_hole'],
      'origin:X',
      '2',
      'length - 2 * boss_in',
      true,
      { dir: 'origin:Y', count: '2', spacing: 'width - 2 * boss_in', reverse: true },
    ),
  );
  const bossSide = (k: number) => inst('boss_x', k, 'F{boss}:side(S{boss_sk}:e(C))');
  const bossTop = (k: number) => inst('boss_x', k, 'F{boss}:end');
  if (withFillets) {
    add(
      fillet(
        'boss_f',
        'Boss root fillets',
        [0, 1, 2, 3].map((k) => E(FLOOR, bossSide(k))),
        'fillet_r',
      ),
      chamfer(
        'boss_c',
        'Boss top chamfers',
        [0, 1, 2, 3].map((k) => E(bossTop(k), bossSide(k))),
        'fillet_r',
      ),
    );
  }

  // ---- C. bottom pockets (label, battery, feet) -----------------------------------------
  add(
    sketch('lab_sk', 'Label recess sketch', origin('origin:XY'), [
      rectOp('R', '-45', '-12', '40', '24'),
    ]),
    extrudeStep('lab', 'Label recess', 'lab_sk', ['R1', 'R2', 'R3', 'R4'], '0.6 mm', 'cut'),
    sketch('bat_sk', 'Battery recess sketch', origin('origin:XY'), [
      rectOp('R', '10', '-15', '40', '30'),
    ]),
    extrudeStep('bat', 'Battery recess', 'bat_sk', ['R1', 'R2', 'R3', 'R4'], '0.6 mm', 'cut'),
    sketch('foot_sk', 'Foot recess sketch', origin('origin:XY'), [
      { op: 'circle', id: 'C', cx: '-40', cy: '-28', d: '10' },
    ]),
    extrudeStep('foot', 'Foot recess', 'foot_sk', ['C'], '0.6 mm', 'cut'),
    linear('foot_p', 'Foot pattern', ['foot'], 'origin:X', '2', '80', false, {
      dir: 'origin:Y',
      count: '2',
      spacing: '56',
    }),
  );

  // ---- D. ribs --------------------------------------------------------------------------
  add(
    sketch('rib_sk', 'Rib sketch', face(FLOOR), [
      rectOp('R', '-30', '-24 - rib_t/2', '60', 'rib_t'),
    ]),
    extrudeStep('rib', 'Rib', 'rib_sk', R4, 'rib_h', 'add'),
    linear('rib_p', 'Rib pattern', ['rib'], 'origin:Y', '5', '12'),
  );
  const ribSides = R4.map((r) => `F{rib}:side(S{rib_sk}:e(${r}))`);
  if (withFillets) {
    const edges: Pick[] = [];
    for (let k = 0; k < 5; k++) for (const s of ribSides) edges.push(E(FLOOR, inst('rib_p', k, s)));
    add(fillet('rib_f', 'Rib root fillets', edges, 'fillet_r'));
  }
  add(
    sketch('rib2_sk', 'End rib sketch', face(FLOOR), [
      rectOp('R', '38 - rib_t/2', '-20', 'rib_t', '40'),
    ]),
    extrudeStep('rib2', 'End rib', 'rib2_sk', R4, 'rib_h', 'add'),
    mirror('rib2_m', 'End rib mirror', ['rib2'], 'origin:YZ'),
  );

  // ---- E. inner posts (PCB standoffs) ----------------------------------------------------
  add(
    sketch('post_sk', 'Post sketch', face(FLOOR), [
      { op: 'circle', id: 'C', cx: '44', cy: '8', d: '5' },
    ]),
    extrudeStep('post', 'PCB post', 'post_sk', ['C'], '8 mm', 'add'),
    sketch('post_pt', 'Post hole point', face('F{post}:end'), [
      { op: 'point', id: 'P', x: '44', y: '8' },
    ]),
    {
      tool: 'hole',
      id: 'post_hole',
      name: 'Post hole',
      say: 'Pilot hole.',
      points: [{ pick: 'vertex', name: 'S{post_pt}:p(P)' }],
      face: face('F{post}:end'),
      standard: 'ISO',
      kind: 'simple',
      size: 'M3',
      fit: 'normal',
      diameter: '2.5 mm',
      end: { kind: 'blind', depth: '6 mm' },
    },
    linear('post_p', 'Post pattern', ['post', 'post_hole'], 'origin:X', '2', '88', true, {
      dir: 'origin:Y',
      count: '2',
      spacing: '16',
      reverse: true,
    }),
  );
  if (withFillets) {
    add(
      fillet(
        'post_f',
        'Post root fillets',
        [0, 1, 2, 3].map((k) => E(FLOOR, inst('post_p', k, 'F{post}:side(S{post_sk}:e(C))'))),
        'fillet_r',
      ),
    );
  }

  // ---- F. wall cut-outs ------------------------------------------------------------------
  add(
    sketch('usb_sk', 'USB sketch', origin('origin:XZ'), [rectOp('R', '-20', '14', '12', '6')]),
    extrudeStep('usb', 'USB opening', 'usb_sk', R4, 'width/2 + 5', 'cut'),
    sketch('jack_sk', 'Jack sketch', origin('origin:YZ'), [
      { op: 'circle', id: 'C', cx: '0', cy: '20', d: '10' },
    ]),
    extrudeStep('jack', 'Power jack hole', 'jack_sk', ['C'], 'length/2 + 5', 'cut'),
    sketch('vent_sk', 'Vent slot sketch', origin('origin:XZ'), [
      rectOp('R', '-17.5', '24', 'vent_w', '10'),
    ]),
    extrudeStep('vent', 'Vent slot', 'vent_sk', R4, 'width/2 + 5', 'cut'),
    linear('vent_p', 'Vent slots', ['vent'], 'origin:X', '8', 'vent_pitch'),
    sketch('vent2_sk', 'Back vent sketch', origin('origin:XZ'), [
      rectOp('R', '-17.5', '24', 'vent_w', '10'),
    ]),
    extrudeStep('vent2', 'Back vent slot', 'vent2_sk', R4, 'width/2 + 5', 'cut', 'reverse'),
    linear('vent2_p', 'Back vent slots', ['vent2'], 'origin:X', '8', 'vent_pitch'),
    sketch('btn_sk', 'Button hole sketch', origin('origin:YZ'), [
      { op: 'circle', id: 'C', cx: '-15', cy: '26', d: '6' },
    ]),
    extrudeStep('btn', 'Button hole', 'btn_sk', ['C'], 'length/2 + 5', 'cut', 'reverse'),
    linear('btn_p', 'Button holes', ['btn'], 'origin:Y', '3', '15'),
    sketch('led_sk', 'LED sketch', origin('origin:YZ'), [
      { op: 'circle', id: 'C', cx: '0', cy: '34', d: '3' },
    ]),
    extrudeStep('led', 'LED hole', 'led_sk', ['C'], 'length/2 + 5', 'cut', 'reverse'),
  );

  // ---- F2. back-wall connectors (one sketch + cut each) ---------------------------------
  const conn: [string, string, string, string, string][] = [
    ['rj45', 'RJ45 port', '-38', '14', '16 x 13'],
    ['hdmi', 'HDMI port', '-12', '18', '15 x 6.5'],
    ['sd', 'SD slot', '8', '20', '12 x 2.5'],
  ];
  for (const [id, name, x, z, size] of conn) {
    const [w, h] = size.split(' x ') as [string, string];
    add(
      sketch(`${id}_sk`, `${name} sketch`, origin('origin:XZ'), [rectOp('R', x, z, w, h)]),
      extrudeStep(id, name, `${id}_sk`, R4, 'width/2 + 5', 'cut', 'reverse'),
    );
  }
  add(
    sketch('aud_sk', 'Audio jack sketch', origin('origin:XZ'), [
      { op: 'circle', id: 'C', cx: '26', cy: '22', d: '7' },
    ]),
    extrudeStep('aud', 'Audio jack hole', 'aud_sk', ['C'], 'width/2 + 5', 'cut', 'reverse'),
    sketch('rst_sk', 'Reset pinhole sketch', origin('origin:XZ'), [
      { op: 'circle', id: 'C', cx: '36', cy: '18', d: '2' },
    ]),
    extrudeStep('rst', 'Reset pinhole', 'rst_sk', ['C'], 'width/2 + 5', 'cut', 'reverse'),
    // End-wall vents (+X wall).
    sketch('vent3_sk', 'End vent sketch', origin('origin:YZ'), [
      rectOp('R', '-22', '28', 'vent_w', '8'),
    ]),
    extrudeStep('vent3', 'End vent slot', 'vent3_sk', R4, 'length/2 + 5', 'cut'),
    linear('vent3_p', 'End vent slots', ['vent3'], 'origin:Y', '5', 'vent_pitch'),
    // Snap-fit windows near the rim, front wall and mirrored to the back wall.
    sketch('snap_sk', 'Snap window sketch', origin('origin:XZ'), [
      rectOp('A', '25', '33', '6', '3.5'),
      rectOp('B', '-31', '33', '6', '3.5'),
    ]),
    {
      ...extrudeStep(
        'snap',
        'Snap windows',
        'snap_sk',
        ['A1', 'A2', 'A3', 'A4'],
        'width/2 + 5',
        'cut',
      ),
      profile: [
        prof('snap_sk', ['A1', 'A2', 'A3', 'A4']),
        prof('snap_sk', ['B1', 'B2', 'B3', 'B4']),
      ],
    },
    mirror('snap_m', 'Snap windows, back wall', ['snap'], 'origin:XZ'),
  );

  // ---- F3. edge breaks on the cut-outs ---------------------------------------------------
  if (withFillets) {
    const wall = (l: string) => side('base', 'base_sk', l);
    const inner = (l: string) => `F{sh}:shell(${wall(l)})`;
    const sideOf = (id: string, sk: string, curve: string) => `F{${id}}:side(S{${sk}}:e(${curve}))`;
    add(
      chamfer(
        'usb_c',
        'USB opening edge break',
        R4.flatMap((r) => [
          E(sideOf('usb', 'usb_sk', r), wall('L1')),
          E(sideOf('usb', 'usb_sk', r), inner('L1')),
        ]),
        '0.4 mm',
      ),
      chamfer(
        'jack_c',
        'Jack hole edge break',
        [
          E(sideOf('jack', 'jack_sk', 'C'), wall('L2')),
          E(sideOf('jack', 'jack_sk', 'C'), inner('L2')),
        ],
        '0.5 mm',
      ),
      chamfer(
        'btn_c',
        'Button holes edge break',
        [0, 1, 2].flatMap((k) => {
          const f = inst('btn_p', k, sideOf('btn', 'btn_sk', 'C'));
          return [E(f, wall('L4')), E(f, inner('L4'))];
        }),
        '0.4 mm',
      ),
      chamfer(
        'vent_c',
        'Vent slots edge break',
        [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) =>
          R4.map((r) => E(inst('vent_p', k, sideOf('vent', 'vent_sk', r)), wall('L1'))),
        ),
        '0.3 mm',
      ),
    );
  }

  // ---- F4. floor mounting holes (counterbored, patterned) ---------------------------------
  add(
    sketch('fh_sk', 'Floor hole point', face(FLOOR), [{ op: 'point', id: 'P', x: '0', y: '32' }]),
    {
      tool: 'hole',
      id: 'fh',
      name: 'Floor mounting hole',
      say: 'Counterbored M4 hole through the floor.',
      points: [{ pick: 'vertex', name: 'S{fh_sk}:p(P)' }],
      face: face(FLOOR),
      standard: 'ISO',
      kind: 'counterbore',
      size: 'M4',
      fit: 'normal',
      end: { kind: 'throughAll' },
      counterbore: { diameter: '8 mm', depth: '1.2 mm' },
    },
    linear('fh_p', 'Floor hole pattern', ['fh'], 'origin:Y', '2', '64', true),
  );

  // ---- E2. four individual PCB standoffs -----------------------------------------------
  const standoffs: [string, string, string][] = [
    ['so1', '-20', '30'],
    ['so2', '20', '30'],
    ['so3', '-20', '-30'],
    ['so4', '20', '-30'],
  ];
  for (const [id, x, y] of standoffs) {
    add(
      sketch(`${id}_sk`, `Standoff ${id.slice(2)} sketch`, face(FLOOR), [
        { op: 'circle', id: 'C', cx: x, cy: y, d: '5' },
      ]),
      extrudeStep(id, `Standoff ${id.slice(2)}`, `${id}_sk`, ['C'], '8 mm', 'add'),
      sketch(`${id}_pt`, `Standoff ${id.slice(2)} hole point`, face(`F{${id}}:end`), [
        { op: 'point', id: 'P', x, y },
      ]),
      {
        tool: 'hole',
        id: `${id}_h`,
        name: `Standoff ${id.slice(2)} hole`,
        say: 'Pilot hole.',
        points: [{ pick: 'vertex', name: `S{${id}_pt}:p(P)` }],
        face: face(`F{${id}}:end`),
        standard: 'ISO',
        kind: 'simple',
        size: 'M3',
        fit: 'normal',
        diameter: '2.5 mm',
        end: { kind: 'blind', depth: '6 mm' },
      },
    );
  }
  if (withFillets) {
    add(
      fillet(
        'so_f',
        'Standoff root fillets',
        standoffs.map(([id]) => E(FLOOR, `F{${id}}:side(S{${id}_sk}:e(C))`)),
        'fillet_r',
      ),
    );
  }

  // ---- G. mounting ears with counterbored holes ----------------------------------------
  add(
    sketch('ear_sk', 'End ear sketch', origin('origin:XY'), [
      rectOp('R', 'length/2 - 1', '-9', '13', '18'),
    ]),
    extrudeStep('ear', 'End ear', 'ear_sk', R4, 'ear_t', 'add'),
    sketch('ear_pt', 'End ear hole point', face('F{ear}:end'), [
      { op: 'point', id: 'P', x: 'length/2 + 7', y: '0' },
    ]),
    {
      tool: 'hole',
      id: 'ear_hole',
      name: 'End ear counterbore',
      say: 'Counterbored M4 clearance hole.',
      points: [{ pick: 'vertex', name: 'S{ear_pt}:p(P)' }],
      face: face('F{ear}:end'),
      standard: 'ISO',
      kind: 'counterbore',
      size: 'M4',
      fit: 'normal',
      end: { kind: 'throughAll' },
      counterbore: { diameter: '8 mm', depth: '1.2 mm' },
    },
    mirror('ear_m', 'End ears mirror', ['ear', 'ear_hole'], 'origin:YZ'),
    sketch('ear2_sk', 'Side ear sketch', origin('origin:XY'), [
      rectOp('R', '-9', 'width/2 - 1', '18', '13'),
    ]),
    extrudeStep('ear2', 'Side ear', 'ear2_sk', R4, 'ear_t', 'add'),
    sketch('ear2_pt', 'Side ear hole point', face('F{ear2}:end'), [
      { op: 'point', id: 'P', x: '0', y: 'width/2 + 7' },
    ]),
    {
      tool: 'hole',
      id: 'ear2_hole',
      name: 'Side ear counterbore',
      say: 'Counterbored M4 clearance hole.',
      points: [{ pick: 'vertex', name: 'S{ear2_pt}:p(P)' }],
      face: face('F{ear2}:end'),
      standard: 'ISO',
      kind: 'counterbore',
      size: 'M4',
      fit: 'normal',
      end: { kind: 'throughAll' },
      counterbore: { diameter: '8 mm', depth: '1.2 mm' },
    },
    mirror('ear2_m', 'Side ears mirror', ['ear2', 'ear2_hole'], 'origin:XZ'),
  );
  if (withFillets) {
    const v = (ear: string, sk: string, m: string | null, a: string, b: string) => {
      const f = (r: string) => {
        const n = `F{${ear}}:side(S{${sk}}:e(${r}))`;
        return m === null ? n : mirrored(m, n);
      };
      return E(f(a), f(b));
    };
    add(
      fillet(
        'ear_f',
        'Mounting ear corners',
        [
          v('ear', 'ear_sk', null, 'R1', 'R2'),
          v('ear', 'ear_sk', null, 'R2', 'R3'),
          v('ear', 'ear_sk', 'ear_m', 'R1', 'R2'),
          v('ear', 'ear_sk', 'ear_m', 'R2', 'R3'),
          v('ear2', 'ear2_sk', null, 'R2', 'R3'),
          v('ear2', 'ear2_sk', null, 'R3', 'R4'),
          v('ear2', 'ear2_sk', 'ear2_m', 'R2', 'R3'),
          v('ear2', 'ear2_sk', 'ear2_m', 'R3', 'R4'),
        ],
        '3 mm',
      ),
    );
  }

  return finalize(steps);
}

/** Reference helper exposed for tests that need the mirrored-name convention. */
export { mirrored };
