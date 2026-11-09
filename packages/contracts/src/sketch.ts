/**
 * Sketch model and solver API (PLAN §2.1, M1). Lead-owned.
 *
 * Geometry is solver state: plain numbers in **millimetres / radians** in the sketch's local 2D
 * frame (u along the plane's X, v along its Y). Driving dimensions carry `Expr` values; the
 * document package evaluates them to numbers before solving. Points are first-class entities
 * referenced by id; lines/arcs/circles reference their points, so a polyline shares points and
 * an explicit `coincident` constraint joins points of different entities.
 */

import type { EntityRef, Expr, Id, Vec2 } from './document';

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

interface EntityBase {
  id: Id;
  /** Construction geometry is solved and constrainable but never forms profiles. */
  construction: boolean;
  /**
   * M3 Convert Entities: a **linked** entity whose geometry is the projection of model geometry
   * onto the sketch plane, recomputed by the regen engine every time (points, lines, arcs and
   * circles; other curves project as an approximating chain of lines marked `approximate`). Linked
   * entities are fixed (no DOF) and can be dimensioned and constrained to. If `ref` no longer
   * resolves, the sketch is "needs attention" (never re-picked silently). Removing `source`
   * unlinks the entity into ordinary geometry.
   */
  source?: { ref: EntityRef; approximate?: boolean };
}

export interface SketchPoint extends EntityBase {
  kind: 'point';
  x: number;
  y: number;
}

export interface SketchLine extends EntityBase {
  kind: 'line';
  start: Id;
  end: Id;
}

export interface SketchCircle extends EntityBase {
  kind: 'circle';
  center: Id;
  radius: number;
}

/** Counter-clockwise from `start` to `end` around `center` (both on the circle). */
export interface SketchArc extends EntityBase {
  kind: 'arc';
  center: Id;
  start: Id;
  end: Id;
}

/** P1. Axis-aligned before rotation; `rotation` in radians. */
export interface SketchEllipse extends EntityBase {
  kind: 'ellipse';
  center: Id;
  majorRadius: number;
  minorRadius: number;
  rotation: number;
}

/**
 * M3.5. Counter-clockwise from `start` to `end` on the ellipse given by `center`, the radii and
 * `rotation` (major axis direction, radians). `start` and `end` lie on the ellipse (the solver keeps
 * them there).
 */
export interface SketchEllipticArc extends EntityBase {
  kind: 'ellipticArc';
  center: Id;
  start: Id;
  end: Id;
  majorRadius: number;
  minorRadius: number;
  rotation: number;
}

/**
 * M3.5. A B-spline curve by its control points (`poles`, point entities, so they can be dragged,
 * dimensioned and constrained). Non-periodic splines are clamped: they start at the first pole and
 * end at the last, so a line or arc can share an end point with them. `knots`/`multiplicities`
 * omitted = uniform clamped (or uniform periodic) knots for `degree`. `weights` omitted = all 1
 * (non-rational). A spline drawn **through points** stores the poles that interpolate them, plus the
 * through points as point entities held on the curve by `pointOn` constraints, so moving a through
 * point reshapes the curve (ADR-046).
 */
export interface SketchBSpline extends EntityBase {
  kind: 'bspline';
  poles: Id[];
  degree: number;
  periodic: boolean;
  weights?: number[];
  knots?: number[];
  multiplicities?: number[];
}

export type SketchEntity =
  | SketchPoint
  | SketchLine
  | SketchCircle
  | SketchArc
  | SketchEllipse
  | SketchEllipticArc
  | SketchBSpline;
export type SketchEntityKind = SketchEntity['kind'];

// ---------------------------------------------------------------------------------------------
// Constraints & dimensions
// ---------------------------------------------------------------------------------------------

interface ConstraintBase {
  id: Id;
}

/** Geometric constraints (no value). Ids refer to entities; points are entities too. */
export type GeometricConstraint = ConstraintBase &
  (
    | { kind: 'coincident'; a: Id; b: Id } // point–point
    | { kind: 'pointOn'; point: Id; on: Id } // point on line/circle/arc/ellipse
    | { kind: 'horizontal'; line: Id }
    | { kind: 'vertical'; line: Id }
    | { kind: 'horizontalPoints'; a: Id; b: Id }
    | { kind: 'verticalPoints'; a: Id; b: Id }
    | { kind: 'parallel'; a: Id; b: Id }
    | { kind: 'perpendicular'; a: Id; b: Id }
    /**
     * Tangent curves. Lines, circles, arcs, ellipses, elliptic arcs and splines (M3.5). When the two
     * curves share an end point the tangency is at that point (G1 continuity); otherwise anywhere.
     */
    | { kind: 'tangent'; a: Id; b: Id }
    /**
     * M3.5. Curvature-continuous (G2) join at the shared end point of `a` and `b`, at least one of
     * them a spline. Where the solver cannot express it the solve reports an `unsupported`
     * conflict naming this constraint; it is never silently dropped.
     */
    | { kind: 'curvature'; a: Id; b: Id }
    | { kind: 'equal'; a: Id; b: Id } // equal length or equal radius
    | { kind: 'midpoint'; point: Id; line: Id }
    | { kind: 'concentric'; a: Id; b: Id }
    | { kind: 'symmetric'; a: Id; b: Id; about: Id } // points a,b symmetric about a line
    | { kind: 'fix'; entity: Id }
  );

/**
 * Conventions (normative): angles are CCW from `a` to `b`, reference values reported in [0, 2π);
 * `hDistance`/`vDistance` are signed b − a (with `a === b` = a line: end − start); distances to
 * circles/arcs measure to the curve; `diameter` solves as radius = value / 2.
 *
 * Dimensions. `driving: true` constrains the solver with `value`; `driving: false` is a reference
 * (driven) dimension whose value is **measured** after solving (planegcs non-driving constraints
 * are unreliable — PLAN §3). `label` positions the text in sketch space for display.
 */
export type DimensionConstraint = ConstraintBase & {
  value: Expr;
  driving: boolean;
  label?: Vec2;
} & (
    | { kind: 'distance'; a: Id; b: Id } // point–point, point–line, line–line (parallel)
    | { kind: 'hDistance'; a: Id; b: Id }
    | { kind: 'vDistance'; a: Id; b: Id }
    | { kind: 'length'; line: Id }
    | { kind: 'radius'; curve: Id }
    | { kind: 'diameter'; curve: Id }
    | { kind: 'angle'; a: Id; b: Id } // between two lines, measured CCW from a to b
    /**
     * M3 Offset Entities: `targets[i]` stays offset from `sources[i]` by `value` (lines parallel at
     * that distance, arcs/circles concentric with radius ± value; positive = to the right of the
     * source's direction, i.e. outward for a CCW loop, inward for a CW one; read on the first
     * source/target pair, the other pairs keep their side relative to it). Corners of a target
     * chain stay joined by the
     * chain's own coincident constraints. One dimension drives the whole offset.
     */
    | { kind: 'offset'; sources: Id[]; targets: Id[] }
  );

export type SketchConstraint = GeometricConstraint | DimensionConstraint;

/** A geometric constraint without its id (distributes over the union, unlike `Omit`). */
export type GeometricConstraintDraft = GeometricConstraint extends infer C
  ? C extends GeometricConstraint
    ? Omit<C, 'id'>
    : never
  : never;

/**
 * Placeholder ids inside inference drafts: `'@cursor'` = the point being placed, `'@drawing'` =
 * the entity being drawn. The UI replaces them with real ids on commit (`bindCandidate`).
 */
export const INFERENCE_CURSOR = '@cursor';
export const INFERENCE_DRAWING = '@drawing';

/**
 * Sketch reference geometry (ADR-017). Every sketch implicitly has a fixed origin point and its two
 * axes: the part origin projected onto the sketch plane (sketch-local (0, 0)) and the lines through
 * it along u (`@x`) and v (`@y`). Constraints and dimensions may reference these ids like entities
 * (e.g. a `distance` from `@origin` to a point, a point `pointOn` `@y`). They are never stored in
 * `entities`, never form profiles, carry no degrees of freedom, and the solver adds them as fixed.
 */
export const SKETCH_ORIGIN = '@origin';
export const SKETCH_X_AXIS = '@x';
export const SKETCH_Y_AXIS = '@y';
export const SKETCH_REFERENCES = [SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS] as const;
export type SketchReferenceId = (typeof SKETCH_REFERENCES)[number];
export type SketchConstraintKind = SketchConstraint['kind'];

export function isDimension(c: SketchConstraint): c is DimensionConstraint {
  return 'value' in c;
}

// ---------------------------------------------------------------------------------------------
// Solver API (sketch worker, Comlink)
// ---------------------------------------------------------------------------------------------

/** Solver input: a sketch plus resolved driving values (mm / rad) keyed by constraint id. */
export interface SketchSolveInput {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  values: Record<Id, number>;
}

export type DofState = 'free' | 'partial' | 'fixed';

export interface SuggestedFix {
  /** Short imperative label, e.g. "Remove ‘Horizontal 3’" or "Make ‘D2’ a reference dimension". */
  label: string;
  action:
    | { kind: 'removeConstraint'; constraint: Id }
    | { kind: 'makeReference'; constraint: Id }
    | { kind: 'setValue'; constraint: Id; value: number };
}

export interface SketchConflict {
  /** `unsupported`: a combination the solver can't express (e.g. tangent to an ellipse). */
  kind?: 'overconstrained' | 'unsupported';
  /** Minimal conflicting set. */
  constraints: Id[];
  /**
   * M3.5. Entities the conflicting constraints act on, for highlighting on the canvas (the UI shows
   * the set, never bare constraint numbers). `fixes[0]` is the suggestion: removing the most
   * recently added constraint of the set (the order of `constraints` in the sketch), unless a
   * better-explained fix exists.
   */
  entities?: Id[];
  /** Fixed entities that make the set conflict (removing a fix is offered as a fix). */
  fixed?: Id[];
  /** Human explanation, e.g. "Line 2 can't be both horizontal and at 30° to Line 1". */
  explanation: string;
  fixes: SuggestedFix[];
}

export interface SketchSolveResult {
  status: 'solved' | 'conflicting' | 'failed';
  /** Why the solve `failed` (malformed input etc.), human-readable. */
  error?: string;
  /** Updated entities (same ids/order as the input), positions solved. */
  entities: SketchEntity[];
  /** Remaining degrees of freedom of the whole sketch. */
  dof: number;
  /** Per-entity DOF state for colouring (PLAN §9.5: under = blue, fixed = black/white). */
  entityDof: Record<Id, DofState>;
  /** Over-constrained diagnostics (empty when solved). */
  conflicts: SketchConflict[];
  /** Redundant (consistent but unnecessary) constraints. */
  redundant: Id[];
  /** Measured values for reference (driven) dimensions, mm / rad. */
  driven: Record<Id, number>;
  /** Solver wall time, ms (budget ≤ 4 ms for 200 entities during drag). */
  ms: number;
}

/** Inference while drawing: candidate constraints shown as glyphs and applied on commit. */
export interface InferenceCandidate {
  constraint: GeometricConstraintDraft;
  /** Snap position the cursor was moved to (mm). */
  snapped: Vec2;
  /** 0–1; the UI shows the best one or two. */
  score: number;
}

export interface SketchSolverApi {
  solve(input: SketchSolveInput): Promise<SketchSolveResult>;
  /** Starts a drag of a point/entity with a temporary (weak) constraint toward the cursor. */
  beginDrag(input: SketchSolveInput, entity: Id, grab: Vec2): Promise<{ session: number }>;
  drag(session: number, to: Vec2): Promise<SketchSolveResult>;
  endDrag(session: number): Promise<SketchSolveResult>;
  /** Constraint inference for a cursor position while drawing `drawing` (may be null). */
  infer(
    input: SketchSolveInput,
    cursor: Vec2,
    drawing: { kind: SketchEntityKind; from?: Vec2 } | null,
    tolerance: number,
  ): Promise<InferenceCandidate[]>;
}

// ---------------------------------------------------------------------------------------------
// M2: Pencil primitive recognition (PLAN §12 M2, implemented in packages/sketch)
// ---------------------------------------------------------------------------------------------

/** One pointer sample of a stroke, already in sketch-local mm. `t` ms; pressure 0–1 when known. */
export interface StrokeSample {
  x: number;
  y: number;
  t: number;
  pressure?: number;
}

/**
 * What a freehand stroke was recognised as. Geometry is cleaned up (snapped to horizontal /
 * vertical / right angles / closure within tolerance, exactly) and `StrokeRecognition.implied`
 * names the constraint kinds that clean-up implies; `strokeFragment` in packages/sketch turns it
 * into entities + constraints like any drawing tool. Rectangle corners are counter-clockwise.
 * `scribble` = an erase gesture over existing geometry (the app deletes what it crosses).
 */
export type RecognizedShape =
  | { kind: 'line'; from: Vec2; to: Vec2 }
  | { kind: 'polyline'; points: Vec2[]; closed: boolean }
  | { kind: 'rectangle'; corners: [Vec2, Vec2, Vec2, Vec2] }
  | { kind: 'circle'; center: Vec2; radius: number }
  /** CCW from start to end around center. */
  | { kind: 'arc'; center: Vec2; radius: number; start: Vec2; end: Vec2 }
  /** M3.5. A closed oval stroke; `rotation` is the major axis direction, radians. */
  | { kind: 'ellipse'; center: Vec2; majorRadius: number; minorRadius: number; rotation: number }
  /**
   * M3.5. A smooth open or closed stroke that is no line, arc or polyline: a spline through these
   * fit points (few, evenly spaced along the stroke, ends included).
   */
  | { kind: 'spline'; points: Vec2[]; closed: boolean }
  | { kind: 'scribble'; points: Vec2[] };

export interface StrokeRecognition {
  shape: RecognizedShape;
  /** 0–1; below ~0.5 the app keeps the stroke as a polyline. */
  confidence: number;
  /**
   * Clean-up that was applied, as geometric constraint kinds (e.g. ['horizontal', 'perpendicular']).
   * `'coincident'` means the stroke's ends were joined (a shared point, no extra constraint).
   */
  implied: GeometricConstraint['kind'][];
}

/** Pure function (no Wasm), safe on the main thread for same-frame feedback. */
export type RecognizeStroke = (
  samples: readonly StrokeSample[],
  options: {
    /** Snap/closure tolerance, mm (≈ 2 × the pen pick radius at the current zoom). */
    tolerance: number;
    /** Angle snap tolerance, rad (default ≈ 6°). */
    angleTolerance?: number;
  },
) => StrokeRecognition | null;
