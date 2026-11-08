/**
 * Whittle document schema (PLAN §6). Lead-owned.
 *
 * Invariants:
 *  - Plain-JSON serialisable (no classes, Maps, Dates, typed arrays, undefined-vs-missing games),
 *    so it maps onto Yjs/Automerge later without a rewrite.
 *  - Every addressable object carries a stable ULID `id`.
 *  - Numeric inputs are stored as expression strings (`Expr`), never as resolved numbers.
 *  - No derived geometry lives here; meshes/BREPs are caches (PLAN §8A.1).
 */

/** ULID (26-char Crockford base32). */
export type Id = string;

/** Expression with optional units, e.g. `"width/2 + 3mm"`, `"25mm + 1/8in"`, `"30deg"`. */
export type Expr = string;

export type Vec3 = [number, number, number];

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type AngleUnit = 'deg' | 'rad';

export const SCHEMA_VERSION = 1 as const;

export interface WhittleDoc {
  schemaVersion: number;
  units: { length: LengthUnit; angle: AngleUnit };
  /** Global variables. */
  params: Param[];
  parts: Part[];
  /** M6. */
  assemblies: Assembly[];
  /** M4. */
  drawings: Drawing[];
  meta: DocMeta;
}

export interface DocMeta {
  name: string;
  /** ISO-8601 timestamps. */
  created: string;
  modified: string;
  /** Writer identification, e.g. `"whittle/0.1.0"`. */
  app: string;
  partNumber?: string;
}

export interface Param {
  id: Id;
  name: string;
  expr: Expr;
  description?: string;
}

export interface Part {
  id: Id;
  name: string;
  features: Feature[];
  /** Features with index >= rollbackIndex are not evaluated. `features.length` = fully rolled forward. */
  rollbackIndex: number;
  /** Physical material. Absent = no mass properties beyond volume (UI shows "Assign material"). */
  material?: Material;
  /** CSS hex colour, e.g. `"#9aa4b2"`. Overrides the material's appearance colour. */
  color?: string;
}

/**
 * A part's physical material (PLAN §2.2). Stored inline (not by reference only) so documents stay
 * self-contained and diff/merge cleanly; `libraryId` records where it came from so the UI can
 * offer "reset to library values".
 */
export interface Material {
  /** Built-in or user library id, e.g. `"whittle:aluminium-6061-t6"`. Absent for ad-hoc materials. */
  libraryId?: string;
  /** Display name, e.g. `"Aluminium 6061-T6"`. */
  name: string;
  /** Density expression with units, e.g. `"2.70 g/cm^3"`, `"2700 kg/m^3"`, `"0.0975 lb/in^3"`. */
  density: Expr;
  /** Optional appearance hint (CSS hex) used when the part has no explicit `color`. */
  appearance?: string;
  /** Optional extra properties for later use (FEA etc.), as expressions with units. */
  properties?: {
    youngsModulus?: Expr;
    poissonsRatio?: Expr;
    yieldStrength?: Expr;
  };
}

/** Placeholder until M6; kept so documents are forward compatible. */
export interface Assembly {
  id: Id;
  name: string;
}

/** Placeholder until M4; kept so documents are forward compatible. */
export interface Drawing {
  id: Id;
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------

export type Feature =
  | PrimitiveFeature
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature
  | BooleanFeature
  | PushPullFeature
  | PlaneFeature;

export type FeatureType = Feature['type'];

export interface FeatureBase {
  id: Id;
  type: string;
  name: string;
  suppressed: boolean;
  annotations?: PmiAnnotation[];
}

/** Body operation shared by solid-producing features. */
export type BodyOp = 'new' | 'add' | 'cut' | 'intersect';

/**
 * Axis-aligned placement frame: origin plus Z (normal) and X directions. Right-handed; Y = Z × X.
 * Values are numbers in document length units (placements are resolved geometry, not inputs;
 * user-editable offsets belong in feature Exprs).
 */
export interface Frame {
  origin: Vec3;
  z: Vec3;
  x: Vec3;
}

/**
 * Solid primitive (box/cylinder/sphere). Used by M0 ("façade makes a box") and kept for quick
 * blocking-out. The box spans [0,dx]×[0,dy]×[0,dz] in `frame` (default: world).
 */
export type PrimitiveFeature = FeatureBase & {
  type: 'primitive';
  frame?: Frame;
  op: BodyOp;
} & (
    | { shape: 'box'; dx: Expr; dy: Expr; dz: Expr }
    | { shape: 'cylinder'; radius: Expr; height: Expr }
    | { shape: 'sphere'; radius: Expr }
  );

/** Sketch geometry and constraints are defined by packages/sketch contracts in M1. */
export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  /** Plane or planar face the sketch lies on. */
  on: EntityRef;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/** M1: refined by sketch-engineer via a contract proposal. */
export interface SketchEntity {
  id: Id;
  kind: 'point' | 'line' | 'circle' | 'arc' | 'ellipse' | 'bspline';
  construction: boolean;
  /** Kind-specific parameters (solver state), plain numbers in sketch-local coordinates. */
  data: Record<string, number | Id>;
}

/** M1: refined by sketch-engineer via a contract proposal. */
export interface SketchConstraint {
  id: Id;
  kind: string;
  refs: Id[];
  /** Driving dimension value; absent for geometric constraints. */
  value?: Expr;
  /** Driven (reference) dimensions are measured, never fed to the solver as driving. */
  driving?: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  /** Sketch regions. */
  profile: EntityRef[];
  direction: 'normal' | 'reverse' | 'symmetric';
  end:
    | { kind: 'blind'; depth: Expr }
    | { kind: 'upTo'; target: EntityRef }
    | { kind: 'throughAll' };
  op: BodyOp;
  draft?: Expr;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  profile: EntityRef[];
  axis: EntityRef;
  angle: Expr;
  direction: 'normal' | 'reverse' | 'symmetric';
  op: BodyOp;
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  edges: EntityRef[];
  radius: Expr;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  edges: EntityRef[];
  mode:
    | { kind: 'distance'; distance: Expr }
    | { kind: 'distanceAngle'; distance: Expr; angle: Expr };
}

export interface BooleanFeature extends FeatureBase {
  type: 'boolean';
  op: 'add' | 'cut' | 'intersect';
  target: EntityRef;
  tools: EntityRef[];
  keepTools: boolean;
}

/** Direct face push/pull recorded parametrically (M2). */
export interface PushPullFeature extends FeatureBase {
  type: 'pushPull';
  faces: EntityRef[];
  distance: Expr;
}

export interface PlaneFeature extends FeatureBase {
  type: 'plane';
  definition: { kind: 'offset'; from: EntityRef; distance: Expr } | { kind: 'frame'; frame: Frame };
}

// ---------------------------------------------------------------------------------------------
// Persistent references (PLAN §7.3)
// ---------------------------------------------------------------------------------------------

export type EntityKind = 'face' | 'edge' | 'vertex' | 'region' | 'body';

export interface Fingerprint {
  centroid: Vec3;
  normal?: Vec3;
  area?: number;
  length?: number;
}

/** Persistent reference to topology. */
export interface EntityRef {
  /** Persistent name, e.g. `"F3:side(S1:e7)"`. See `naming.ts`. */
  name: string;
  kind: EntityKind;
  fingerprint?: Fingerprint;
}

// ---------------------------------------------------------------------------------------------
// PMI (PLAN §12 M5)
// ---------------------------------------------------------------------------------------------

/** Model-based definition: becomes STEP AP242 semantic PMI and can be imported into drawings. */
export interface PmiAnnotation {
  id: Id;
  kind: 'linear' | 'diameter' | 'radius' | 'angle' | 'datum' | 'geomTolerance';
  refs: EntityRef[];
  /** Usually bound to a feature/sketch dimension. */
  value?: Expr;
  tolerance?: {
    kind: 'symmetric' | 'bilateral' | 'limits' | 'fit';
    upper?: Expr;
    lower?: Expr;
    fit?: string;
  };
  gdt?: { characteristic: string; zone: Expr; modifiers?: string[]; datums?: string[] };
  placement?: {
    plane: [number, number, number, number, number, number];
    textPos: Vec3;
  };
}
