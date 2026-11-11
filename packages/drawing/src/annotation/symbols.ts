/**
 * The vector symbol library (owner D5): every GD&T characteristic and zone modifier, the hole
 * symbols ⌴ ⌵ ↧, datum triangles, surface texture symbols, the projection-method symbols and the
 * all-around circle, drawn as paths whatever the font has. DXF needs them exploded anyway, and
 * M5's presentation PMI reuses them.
 *
 * Coordinates are in units of the text height h (ISO 3098 cap height): baseline y = 0, cap
 * height y = 1, the symbol starting at x = 0 and advancing by `advance`. Shapes follow the
 * ISO 1101 / ASME Y14.5 / ISO 21920-1 / ISO 5456-2 drawings in proportion. Provisional
 * (secondary sources, owner D9): re-check against the standards once bought.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { GeometricCharacteristic, Vec2 } from '@wren-cad/contracts';
import type { Primitive } from './display';
import { TAU } from './geom';

export type ModifierSymbol =
  | 'mmc'
  | 'lmc'
  | 'projected'
  | 'freeState'
  | 'tangentPlane'
  | 'unequal'
  | 'statistical'
  | 'envelope'
  | 'rfs';

export type SymbolId =
  | GeometricCharacteristic
  | ModifierSymbol
  | 'counterbore'
  | 'countersink'
  | 'depth'
  | 'square'
  | 'datumTriangle'
  | 'datumTriangleOpen'
  | 'allAround'
  | 'surfaceBasic'
  | 'surfaceRemovalRequired'
  | 'surfaceRemovalProhibited'
  | 'layPerpendicular'
  | 'projectionFirst'
  | 'projectionThird';

export interface SymbolGlyph {
  /** Advance (h units). */
  advance: number;
  prims: Primitive[];
}

const line = (a: Vec2, b: Vec2): Primitive => ({ kind: 'line', a, b });
const poly = (points: Vec2[], closed = false): Primitive => ({ kind: 'polyline', points, closed });
const circle = (center: Vec2, radius: number): Primitive => ({
  kind: 'arc',
  center,
  radius,
  start: 0,
  end: TAU,
});
const arc = (center: Vec2, radius: number, start: number, end: number): Primitive => ({
  kind: 'arc',
  center,
  radius,
  start,
  end,
});
const fill = (points: Vec2[]): Primitive => ({ kind: 'fill', loops: [points] });

/** Map points of a glyph drawn in a unit box into [x0, x0 + w] × [y0, y0 + h]. */
function box(points: Vec2[], x0: number, y0: number, w: number, h: number): Vec2[] {
  return points.map(([x, y]) => [x0 + x * w, y0 + y * h]);
}

/**
 * Single-stroke capitals for the circled modifiers (unit box, baseline 0, cap 1). Only the
 * letters the library needs.
 */
const STROKE_LETTERS: Record<string, Vec2[][]> = {
  M: [
    [
      [0, 0],
      [0, 1],
      [0.5, 0.35],
      [1, 1],
      [1, 0],
    ],
  ],
  L: [
    [
      [0, 1],
      [0, 0],
      [0.85, 0],
    ],
  ],
  P: [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.85, 0.9],
      [0.95, 0.75],
      [0.85, 0.6],
      [0.6, 0.5],
      [0, 0.5],
    ],
  ],
  F: [
    [
      [0.9, 1],
      [0, 1],
      [0, 0],
    ],
    [
      [0, 0.52],
      [0.7, 0.52],
    ],
  ],
  T: [
    [
      [0, 1],
      [1, 1],
    ],
    [
      [0.5, 1],
      [0.5, 0],
    ],
  ],
  U: [
    [
      [0, 1],
      [0, 0.3],
      [0.1, 0.09],
      [0.3, 0],
      [0.7, 0],
      [0.9, 0.09],
      [1, 0.3],
      [1, 1],
    ],
  ],
  E: [
    [
      [0.9, 1],
      [0, 1],
      [0, 0],
      [0.9, 0],
    ],
    [
      [0, 0.52],
      [0.7, 0.52],
    ],
  ],
  S: [
    [
      [0.95, 0.85],
      [0.75, 1],
      [0.25, 1],
      [0.05, 0.85],
      [0.05, 0.62],
      [0.25, 0.52],
      [0.75, 0.48],
      [0.95, 0.38],
      [0.95, 0.15],
      [0.75, 0],
      [0.25, 0],
      [0.05, 0.15],
    ],
  ],
};

/** A circled single-stroke letter: circle Ø 1.2h, letter 0.6h tall. */
function circled(letter: string): SymbolGlyph {
  const r = 0.62;
  const c: Vec2 = [r, 0.5];
  const lh = 0.6;
  const lw = letter === 'M' ? 0.55 : 0.45;
  const strokes = (STROKE_LETTERS[letter] ?? []).map((s) =>
    poly(box(s, c[0] - lw / 2, c[1] - lh / 2, lw, lh)),
  );
  return { advance: 2 * r + 0.1, prims: [circle(c, r), ...strokes] };
}

function arrow45(tail: Vec2, tip: Vec2): Primitive[] {
  const dx = tip[0] - tail[0];
  const dy = tip[1] - tail[1];
  const l = Math.hypot(dx, dy);
  const u: Vec2 = [dx / l, dy / l];
  const n: Vec2 = [-u[1], u[0]];
  const hl = 0.34;
  const hw = 0.11;
  const base: Vec2 = [tip[0] - u[0] * hl, tip[1] - u[1] * hl];
  return [
    line(tail, base),
    fill([
      tip,
      [base[0] + n[0] * hw, base[1] + n[1] * hw],
      [base[0] - n[0] * hw, base[1] - n[1] * hw],
    ]),
  ];
}

function cylindricity(): Primitive[] {
  const c: Vec2 = [0.55, 0.5];
  const r = 0.36;
  const u: Vec2 = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
  const n: Vec2 = [-u[1], u[0]];
  const seg = (sign: number): Primitive => {
    const o: Vec2 = [c[0] + n[0] * r * sign, c[1] + n[1] * r * sign];
    const t = 0.58;
    return line([o[0] - u[0] * t, o[1] - u[1] * t], [o[0] + u[0] * t, o[1] + u[1] * t]);
  };
  return [circle(c, r), seg(1), seg(-1)];
}

/** Surface texture symbol geometry (ISO 21920-1): apex at the origin, legs at 60°. */
export const SURFACE_SYMBOL = {
  /** Short leg height H1 = 1.4 h; long leg H2 = 3 h (provisional). */
  short: 1.4,
  long: 3,
  /** x of a leg's end at height y. */
  legX: (y: number) => y / Math.tan(Math.PI / 3),
} as const;

function surface(kind: 'basic' | 'removal' | 'noRemoval'): SymbolGlyph {
  const { short, long, legX } = SURFACE_SYMBOL;
  const prims: Primitive[] = [
    poly([
      [-legX(short), short],
      [0, 0],
      [legX(long), long],
    ]),
  ];
  if (kind === 'removal') prims.push(line([-legX(short), short], [legX(short), short]));
  if (kind === 'noRemoval') {
    // Circle inscribed in the V, touching both legs, its top at the short leg's height.
    const r = short / 3;
    prims.push(circle([0, 2 * r], r));
  }
  return { advance: legX(long) + legX(short), prims };
}

/** Projection-method symbol (ISO 5456-2): truncated cone, end view and side view. */
function projection(method: 'first' | 'third'): SymbolGlyph {
  const R = 1;
  const r = 0.5;
  const len = 2;
  const gap = 0.6;
  const circlesAt = method === 'first' ? R : len + gap + R;
  const trapX0 = method === 'first' ? 2 * R + gap : 0;
  // The same cone (large end left) in both: first angle puts the end view (seen from the right,
  // small end) left of the side view, so the large end faces the circles; third angle puts it
  // right, so the small end does.
  const trap: Vec2[] = [
    [trapX0, 0],
    [trapX0 + len, R - r],
    [trapX0 + len, R + r],
    [trapX0, 2 * R],
  ];
  return {
    advance: 2 * R + gap + len,
    prims: [circle([circlesAt, R], R), circle([circlesAt, R], r), poly(trap, true)],
  };
}

const LIB: Record<SymbolId, () => SymbolGlyph> = {
  straightness: () => ({ advance: 1, prims: [line([0, 0.5], [1, 0.5])] }),
  flatness: () => ({
    advance: 1.1,
    prims: [
      poly(
        [
          [0, 0.2],
          [0.75, 0.2],
          [1.05, 0.8],
          [0.3, 0.8],
        ],
        true,
      ),
    ],
  }),
  circularity: () => ({ advance: 1, prims: [circle([0.5, 0.5], 0.48)] }),
  cylindricity: () => ({ advance: 1.1, prims: cylindricity() }),
  lineProfile: () => ({ advance: 1.1, prims: [arc([0.55, 0.15], 0.55, 0, Math.PI)] }),
  surfaceProfile: () => ({
    advance: 1.1,
    prims: [arc([0.55, 0.15], 0.55, 0, Math.PI), line([0, 0.15], [1.1, 0.15])],
  }),
  parallelism: () => ({
    advance: 1,
    prims: [line([0.05, 0], [0.5, 0.9]), line([0.45, 0], [0.9, 0.9])],
  }),
  perpendicularity: () => ({
    advance: 1,
    prims: [line([0.5, 0], [0.5, 1]), line([0, 0], [1, 0])],
  }),
  angularity: () => ({
    advance: 1,
    prims: [
      poly([
        [0.95, 0.55],
        [0, 0],
        [1, 0],
      ]),
    ],
  }),
  position: () => ({
    advance: 1,
    prims: [circle([0.5, 0.5], 0.33), line([0, 0.5], [1, 0.5]), line([0.5, 0], [0.5, 1])],
  }),
  concentricity: () => ({
    advance: 1,
    prims: [circle([0.5, 0.5], 0.48), circle([0.5, 0.5], 0.24)],
  }),
  coaxiality: () => ({
    advance: 1,
    prims: [circle([0.5, 0.5], 0.48), circle([0.5, 0.5], 0.24)],
  }),
  symmetry: () => ({
    advance: 1,
    prims: [line([0, 0.5], [1, 0.5]), line([0.2, 0.2], [0.8, 0.2]), line([0.2, 0.8], [0.8, 0.8])],
  }),
  circularRunout: () => ({ advance: 1, prims: arrow45([0.1, 0.05], [0.9, 0.95]) }),
  totalRunout: () => ({
    advance: 1.2,
    prims: [
      ...arrow45([0, 0.05], [0.65, 0.95]),
      ...arrow45([0.5, 0.05], [1.15, 0.95]),
      line([0, 0.05], [0.5, 0.05]),
    ],
  }),
  mmc: () => circled('M'),
  lmc: () => circled('L'),
  projected: () => circled('P'),
  freeState: () => circled('F'),
  tangentPlane: () => circled('T'),
  unequal: () => circled('U'),
  envelope: () => circled('E'),
  rfs: () => circled('S'),
  statistical: () => {
    // ASME: "ST" in a hexagon.
    const w = 1.6;
    const hex = poly(
      [
        [0, 0.5],
        [0.3, -0.05],
        [w - 0.3, -0.05],
        [w, 0.5],
        [w - 0.3, 1.05],
        [0.3, 1.05],
      ],
      true,
    );
    const s = (STROKE_LETTERS.S ?? []).map((p) => poly(box(p, 0.3, 0.2, 0.42, 0.6)));
    const t = (STROKE_LETTERS.T ?? []).map((p) => poly(box(p, 0.85, 0.2, 0.45, 0.6)));
    return { advance: w + 0.1, prims: [hex, ...s, ...t] };
  },
  counterbore: () => ({
    advance: 1.1,
    prims: [
      poly([
        [0.05, 0.95],
        [0.05, 0.1],
        [0.95, 0.1],
        [0.95, 0.95],
      ]),
    ],
  }),
  countersink: () => ({
    advance: 1.1,
    prims: [
      poly([
        [0.05, 0.95],
        [0.5, 0.1],
        [0.95, 0.95],
      ]),
    ],
  }),
  depth: () => ({
    advance: 0.9,
    prims: [
      line([0.4, 1], [0.4, 0.05]),
      poly([
        [0.15, 0.4],
        [0.4, 0.05],
        [0.65, 0.4],
      ]),
      line([0, 0.05], [0.8, 0.05]),
    ],
  }),
  square: () => ({
    advance: 1,
    prims: [
      poly(
        [
          [0.05, 0.05],
          [0.9, 0.05],
          [0.9, 0.9],
          [0.05, 0.9],
        ],
        true,
      ),
    ],
  }),
  // Datum triangles: base centred on the origin along +x, apex up (rotate to the leader).
  datumTriangle: () => ({
    advance: 1,
    prims: [
      fill([
        [-0.5, 0],
        [0.5, 0],
        [0, 0.866],
      ]),
    ],
  }),
  datumTriangleOpen: () => ({
    advance: 1,
    prims: [
      poly(
        [
          [-0.5, 0],
          [0.5, 0],
          [0, 0.866],
        ],
        true,
      ),
    ],
  }),
  allAround: () => ({ advance: 0.6, prims: [circle([0, 0], 0.3)] }),
  surfaceBasic: () => surface('basic'),
  surfaceRemovalRequired: () => surface('removal'),
  surfaceRemovalProhibited: () => surface('noRemoval'),
  layPerpendicular: () => ({
    advance: 1,
    prims: [line([0.5, 0], [0.5, 1]), line([0, 0], [1, 0])],
  }),
  projectionFirst: () => projection('first'),
  projectionThird: () => projection('third'),
};

export const SYMBOL_IDS = Object.keys(LIB) as SymbolId[];

/** The symbol in h units (see the module comment). */
export function symbolGlyph(id: SymbolId): SymbolGlyph {
  return LIB[id]();
}

/** The symbol scaled to text height `h` with its origin at `at` (and `angle` radians CCW). */
export function placeSymbol(id: SymbolId, at: Vec2, h: number, angle = 0): Primitive[] {
  const g = LIB[id]();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const pt = ([x, y]: Vec2): Vec2 => [at[0] + (x * c - y * s) * h, at[1] + (x * s + y * c) * h];
  return g.prims.map((p): Primitive => {
    switch (p.kind) {
      case 'line':
        return { kind: 'line', a: pt(p.a), b: pt(p.b) };
      case 'polyline':
        return { ...p, points: p.points.map(pt) };
      case 'arc':
        return {
          kind: 'arc',
          center: pt(p.center),
          radius: p.radius * h,
          start: p.start + angle,
          end: p.end + angle,
        };
      case 'fill':
        return { kind: 'fill', loops: p.loops.map((l) => l.map(pt)) };
      default:
        return p;
    }
  });
}

/** The characteristic symbol per GD&T characteristic (one-to-one; identity mapping kept explicit). */
export function characteristicSymbol(c: GeometricCharacteristic): SymbolId {
  return c;
}
