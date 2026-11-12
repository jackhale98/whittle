/**
 * Types for the reference-part suite (PLAN section 12A). A part is defined once, in TypeScript
 * (`../parts/*.ts`); `lib/spec.ts` turns it into the committed `<part>.spec.json`, `<part>.md` and
 * `<part>.svg`, and `lib/builder.ts` turns its steps into a `WrenDoc`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec3 } from '@wren-cad/contracts';
import type { Drawing } from './drawing';

export type Unit = 'mm' | 'deg' | '';

/** One named driving dimension. It becomes a document parameter of the same name. */
export interface DimSpec {
  value: number;
  unit: Unit;
  description: string;
}

export type Dims = Record<string, number>;

/** Typed accessor over the dimensions: `d('width')`. Unknown names throw (typos fail loudly). */
export type D = (name: string) => number;

export function dimGetter(dims: Dims): D {
  return (name) => {
    const v = dims[name];
    if (v === undefined) throw new Error(`unknown dimension ${name}`);
    return v;
  };
}

/** An expression over the driving dimensions, for example `"-length/2"`. */
export type Ex = string;

export type PickKind = 'face' | 'edge' | 'vertex' | 'region' | 'body' | 'plane' | 'axis' | 'point';

/**
 * A reference to model geometry, written so that it serves two readers:
 * - `name` is the persistent name (PLAN section 7.3) with `{stepId}` standing for the id of the step
 *   that made it. The document builder resolves it. Origin references (`origin:XY`) have no braces.
 * - `at` is a world point (mm, at the baseline dimensions) on the picked entity: where a UI script
 *   clicks (face: any point on it; edge: a point on it; region: a point inside it).
 * Regions may instead give `sketch`, `curves` and optional `inner` loops, and the name is derived.
 */
export interface Pick {
  pick: PickKind;
  name?: string;
  sketch?: string;
  curves?: string[];
  inner?: string[][];
  at?: Vec3;
}

/** The sketch operations a spec may use. All lengths are expressions over the dimensions. */
export type SketchOp =
  /** Axis-aligned rectangle; (x, y) is its lower-left corner. Lines `${id}1..4` = bottom, right, top, left. */
  | { op: 'rect'; id: string; x: Ex; y: Ex; w: Ex; h: Ex }
  /** Circle with centre (cx, cy) and diameter d. */
  | { op: 'circle'; id: string; cx: Ex; cy: Ex; d: Ex }
  /** Point; `dims` says which coordinates are dimensioned from the origin (default both). */
  | {
      op: 'point';
      id: string;
      x: Ex;
      y: Ex;
      dims?: 'xy' | 'x' | 'y' | 'none';
      construction?: boolean;
      /**
       * Keep the point level with the sketch origin (`horizontalPoints`) or above it
       * (`verticalPoints`), instead of dimensioning that coordinate (use with `dims: 'x'` / `'y'`).
       */
      align?: 'h' | 'v';
    }
  | { op: 'line'; id: string; a: string; b: string; construction?: boolean }
  /** Counter-clockwise from point `a` to point `b` around point `c`. */
  | { op: 'arc'; id: string; c: string; a: string; b: string; radius?: Ex }
  /** Closed polygon through the points; lines `${id}1..n`, points `${id}p1..n`, every vertex dimensioned. */
  | { op: 'polygon'; id: string; pts: [Ex, Ex][] }
  /** A model edge projected into the sketch (Convert Entities): a linked line `id`. */
  | { op: 'convert'; id: string; source: Pick; a: [number, number]; b: [number, number] }
  /**
   * Offset Entities on a rectangular chain of converted lines: lines `${id}1..4`. `bounds` is the
   * source rectangle [x0, y0, x1, y1] (for the initial positions only).
   */
  | {
      op: 'offsetRect';
      id: string;
      sources: string[];
      distance: Ex;
      bounds: [number, number, number, number];
    };

export type FeatureTag =
  | 'extrude'
  | 'cut'
  | 'revolve'
  | 'sphere'
  | 'fillet'
  | 'chamfer'
  | 'propagate'
  | 'noPropagate'
  | 'shell'
  | 'draft'
  | 'sweep'
  | 'sweepCut'
  | 'loft'
  | 'mirror'
  | 'linearPattern'
  | 'circularPattern'
  | 'skip'
  | 'holeCounterbore'
  | 'holeCountersink'
  | 'holeTapped'
  | 'plane'
  | 'axis'
  | 'point'
  | 'offset'
  | 'convert'
  | 'boolean'
  | 'pushPull';

/**
 * One step of the build intent. `tool` is the feature type (and the UI tool); every other key is
 * the feature's own field, with `Pick` in place of `EntityRef`. See `reference-parts/README.md`.
 */
export interface Step {
  tool: string;
  /** Local id: how later steps refer to this one (`{id}` in names, plain in `source.features`). */
  id: string;
  /** What a person would say to do this step. Shown in the .md and by UI scripts as a log line. */
  say: string;
  name?: string;
  /** Sketch steps. */
  on?: Pick;
  ops?: SketchOp[];
  [field: string]: unknown;
}

export interface Term {
  label: string;
  formula: string;
  value: number;
}

export interface Model {
  /** mm^3. */
  volume: number;
  /** mm^2, where it has a closed form. */
  area?: number;
  bbox: { min: Vec3; max: Vec3 };
  /** The volume as a signed sum, for the derivation in the .md. */
  terms: Term[];
}

export interface StageDef {
  name: string;
  /** New values of named dimensions (absolute, in the dimension's unit). */
  set: Record<string, number>;
}

export interface PartDef {
  id: string;
  no: number;
  title: string;
  level: 'CSWA-like' | 'CSWP-like';
  summary: string;
  /** Built-in library id, for example `whittle:aluminium-6061-t6`. */
  material: string;
  dims: Record<string, DimSpec>;
  tags: FeatureTag[];
  /** Notes on how the expected values were derived and how accurate they are. */
  method: string;
  /** Extra facts the derivation uses (standards table values and so on). */
  standards?: { ref: string; value: string }[];
  steps: (d: D) => Step[];
  model: (d: D) => Model;
  stages: StageDef[];
  /** Orthographic views with the driving dimensions. */
  draw: (d: D, dr: Drawing) => void;
}

// ---------------------------------------------------------------------------------------------
// The drawing section of the spec (PLAN section 12 M4 and 12A)
// ---------------------------------------------------------------------------------------------

/** Part axis, signed. */
export type WorldAxis = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';

export type StandardViewName = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

/**
 * One view of the spec drawing. The drawing is third-angle projection (the sheet's note says so),
 * so `side` is where the view sits relative to its parent in that method.
 *
 * - `base`: a view in its own right; `orientation` is the direction it is seen from.
 * - `projected`: the parent seen from one of its sides (`orientation` is the standard view it is).
 * - `section`: a cut through `parent` along `section.cut` (two points, or more for a stepped section, in the parent view's own
 *   drawn coordinates, part mm); the viewer looks to the `look` side of the line's direction.
 * - `detail`: an enlarged circle on the parent. No current spec drawing has one.
 */
export interface DrawingViewSpec {
  id: string;
  /** Label as captioned on the drawing. */
  caption: string;
  kind: 'base' | 'projected' | 'section' | 'detail';
  orientation: StandardViewName;
  parent?: string;
  side?: 'above' | 'below' | 'left' | 'right';
  /** In-plane rotation of the view in degrees, counter-clockwise; absent = none. */
  rotation?: number;
  /** What the view's drawn x and y coordinates are in the part (dimension geometry uses them). */
  axes: [WorldAxis, WorldAxis];
  section?: { letter: string; cut: [number, number][]; look: 'left' | 'right' };
  detail?: { letter: string; centre: [number, number]; radius: number; scale: string };
  /**
   * How the view draws (M4.1), as set in the view inspector: `hidden` shows the hidden lines;
   * `tangent` draws the tangent (smooth) edges, `thin` as thin lines, `visible` as visible ones.
   * Absent = the product defaults (no hidden lines, no tangent edges). The spec drawing needs the
   * ones its dimensions are measured to.
   */
  display?: { hidden?: boolean; tangent?: 'thin' | 'visible' };
}

/**
 * What kind of annotation a spec dimension is, and so what the certification suite requires the
 * recreated annotation to be: `linear` is a linear, aligned or ordinate dimension (a diameter or
 * a radius is not one, even when its value is the same), `diameter` a diameter, and so on.
 */
export type DrawingDimKind = 'linear' | 'diameter' | 'radius' | 'chamfer' | 'angle' | 'count';

/** Where on an entity a dimension is measured (the contract's `RefPoint`). */
export type DrawingRefPoint = 'self' | 'center' | 'axis' | 'start' | 'end' | 'mid' | 'min' | 'max';

/**
 * One reference of a dimension, as the document stores it (M4.1): the persistent name with
 * `{stepId}` standing for the id of the step that made the entity (see `Pick`), the entity kind,
 * and where on it the dimension is measured.
 */
export interface DrawingRefSpec {
  name: string;
  kind: 'face' | 'edge' | 'vertex';
  /** Absent = `self`. */
  at?: DrawingRefPoint;
  /**
   * Angles, the second ref only: the angle is measured from this planar face's normal (`at` is
   * `axis`), so a draft angle is refs [drafted face, neutral face] at ['self', 'axis'].
   */
  fromNormal?: boolean;
}

/** A tolerance as printed: `+plus / -minus` in the dimension's unit. None of the drawings has one yet. */
export interface DimTolerance {
  plus: number;
  minus: number;
}

/**
 * One dimension on the spec drawing. `name` is the driving dimension's name (the document
 * parameter). `value` is the number printed on the drawing (so a position left of the origin is
 * negative); Wren's dimensions are unsigned distances, so compare `Math.abs(value)`.
 */
export interface DrawingDimSpec {
  name: string;
  kind: DrawingDimKind;
  value: number;
  unit: Unit;
  tolerance?: DimTolerance;
  /** The view it appears in (`DrawingViewSpec.id`). */
  view: string;
  /**
   * Linear: measured along the view's horizontal or vertical (the annotation's `direction`), between
   * two points (view coordinates). Absent = no direction: the natural separation of the two
   * entities, for example the thickness of a drafted wall, normal to the walls (needs `refs`).
   * Angle: `from` is on the first entity and `to` on the second (so a driver can pick them).
   */
  axis?: 'h' | 'v';
  from?: [number, number];
  to?: [number, number];
  /**
   * The model entities the dimension measures, where the drawing tools cannot get them from the
   * points alone (M4.1): construction geometry, extremes, section faces, draft angles. Present on
   * every dimension that was a product gap. Kernel-client resolves them to the printed `value`
   * (`reference-spec-refs.golden.test.ts`).
   */
  refs?: DrawingRefSpec[];
  /** Diameter, radius, chamfer, angle and count: the feature's centre or anchor point (view coordinates). */
  at?: [number, number];
  /** Diameter, radius and chamfer: the circle's radius, to tell concentric circles apart. */
  radius?: number;
}

export interface DrawingSpec {
  /** The committed SVG next to the spec. */
  file: string;
  projection: 'third' | 'first';
  views: DrawingViewSpec[];
  dimensions: DrawingDimSpec[];
}
