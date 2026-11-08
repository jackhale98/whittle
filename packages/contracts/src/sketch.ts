/**
 * Sketch model and solver API (PLAN §2.1, M1). Lead-owned.
 *
 * Geometry is solver state: plain numbers in **millimetres / radians** in the sketch's local 2D
 * frame (u along the plane's X, v along its Y). Driving dimensions carry `Expr` values; the
 * document package evaluates them to numbers before solving. Points are first-class entities
 * referenced by id; lines/arcs/circles reference their points, so a polyline shares points and
 * an explicit `coincident` constraint joins points of different entities.
 */

import type { Expr, Id, Vec2 } from './document';

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

interface EntityBase {
  id: Id;
  /** Construction geometry is solved and constrainable but never forms profiles. */
  construction: boolean;
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

export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc | SketchEllipse;
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
    | { kind: 'tangent'; a: Id; b: Id }
    | { kind: 'equal'; a: Id; b: Id } // equal length or equal radius
    | { kind: 'midpoint'; point: Id; line: Id }
    | { kind: 'concentric'; a: Id; b: Id }
    | { kind: 'symmetric'; a: Id; b: Id; about: Id } // points a,b symmetric about a line
    | { kind: 'fix'; entity: Id }
  );

/**
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
  );

export type SketchConstraint = GeometricConstraint | DimensionConstraint;
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
  /** Minimal conflicting set. */
  constraints: Id[];
  /** Human explanation, e.g. "Line 2 can't be both horizontal and at 30° to Line 1". */
  explanation: string;
  fixes: SuggestedFix[];
}

export interface SketchSolveResult {
  status: 'solved' | 'conflicting' | 'failed';
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
  constraint: Omit<GeometricConstraint, 'id'>;
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
