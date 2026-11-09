/**
 * Types for the reference-part suite (PLAN section 12A). A part is defined once, in TypeScript
 * (`../parts/*.ts`); `lib/spec.ts` turns it into the committed `<part>.spec.json`, `<part>.md` and
 * `<part>.svg`, and `lib/builder.ts` turns its steps into a `WhittleDoc`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Vec3 } from '@whittle/contracts';
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
