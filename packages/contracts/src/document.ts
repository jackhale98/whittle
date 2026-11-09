/**
 * Wren document schema (PLAN §6). Lead-owned.
 *
 * Invariants:
 *  - Plain-JSON serialisable (no classes, Maps, Dates, typed arrays, undefined-vs-missing games),
 *    so it maps onto Yjs/Automerge later without a rewrite.
 *  - Every addressable object carries a stable ULID `id`.
 *  - Numeric inputs are stored as expression strings (`Expr`), never as resolved numbers.
 *  - No derived geometry lives here; meshes/BREPs are caches (PLAN §8A.1).
 */

import type { SketchConstraint, SketchEntity } from './sketch';

/** ULID (26-char Crockford base32). */
export type Id = string;

/** Expression with optional units, e.g. `"width/2 + 3mm"`, `"25mm + 1/8in"`, `"30deg"`. */
export type Expr = string;

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type AngleUnit = 'deg' | 'rad';

export const SCHEMA_VERSION = 1 as const;

export interface WrenDoc {
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
  /** Stable document id (ULID), assigned at creation; survives renames (library identity). */
  id?: Id;
  name: string;
  /** ISO-8601 timestamps. */
  created: string;
  modified: string;
  /** Writer identification, e.g. `"wren/0.1.0"`. */
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
  | PlaneFeature
  | ImportFeature
  // M3
  | ShellFeature
  | DraftFeature
  | SweepFeature
  | LoftFeature
  | MirrorFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | HoleFeature
  | ThreadFeature
  | AxisFeature
  | PointFeature;

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
 * Placement frame: origin plus Z (normal) and X directions. Right-handed; Y = Z × X.
 * Numbers are **millimetres** — the canonical internal length unit for all stored geometry,
 * whatever `WrenDoc.units` says (units only affect display and unit-less expression input).
 * User-editable offsets belong in feature Exprs.
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
  scope?: BodyScope;
} & (
    | { shape: 'box'; dx: Expr; dy: Expr; dz: Expr }
    | { shape: 'cylinder'; radius: Expr; height: Expr }
    | { shape: 'sphere'; radius: Expr }
  );

/**
 * A 2D sketch on a plane or planar face. Geometry and constraints are defined in `sketch.ts`.
 * The kernel turns the solved sketch into wires and regions (names: see `naming.ts`).
 */
export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  /** Plane or planar face the sketch lies on (`origin:XY` etc. or a face/plane-feature ref). */
  on: EntityRef;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/**
 * Which existing bodies a solid feature with op add/cut/intersect acts on. Default (`undefined`) =
 * every body the new tool solid touches (Onshape-style "merge scope: all").
 */
export type BodyScope = { kind: 'all' } | { kind: 'bodies'; bodies: EntityRef[] };

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
  scope?: BodyScope;
  draft?: Expr;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  profile: EntityRef[];
  axis: EntityRef;
  angle: Expr;
  direction: 'normal' | 'reverse' | 'symmetric';
  op: BodyOp;
  scope?: BodyScope;
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  edges: EntityRef[];
  radius: Expr;
  /** M3: extend along tangent-continuous edges (OCCT's behaviour). Default true. */
  propagate?: boolean;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  edges: EntityRef[];
  mode:
    | { kind: 'distance'; distance: Expr }
    /** `face`: the face the distance is measured on (default: the adjacent face sorting first). */
    | { kind: 'distanceAngle'; distance: Expr; angle: Expr; face?: EntityRef };
  /** M3: extend along tangent-continuous edges. Default true. */
  propagate?: boolean;
}

export interface BooleanFeature extends FeatureBase {
  type: 'boolean';
  op: 'add' | 'cut' | 'intersect';
  target: EntityRef;
  tools: EntityRef[];
  keepTools: boolean;
}

/** Direct face push/pull recorded parametrically (M2). */
/**
 * Direct editing (PLAN §9.2, M2): moves faces of one body along their normal. Positive `distance`
 * moves outward (adds material), negative inward (removes). M2 supports planar faces; others fail
 * with an `UNSUPPORTED_FEATURE` error naming the face. Recorded as a feature, so it is parametric.
 */
export interface PushPullFeature extends FeatureBase {
  type: 'pushPull';
  faces: EntityRef[];
  distance: Expr;
}

/**
 * A body imported from a file (STEP/IGES/BREP solids, or STL/OBJ/3MF/GLB meshes as reference
 * bodies). The file's bytes live in the project folder at `source.path` (an attachment, e.g.
 * `imports/<featureId>.step`), never inline in the JSON, so documents stay diffable. `sha256`
 * (hex) identifies the bytes for caching and integrity.
 *
 * Imported faces have no construction history; the regen engine names them
 * `F<id>:face#k` ordered by the deterministic geometric key in naming.ts, and downstream references
 * to them rely on fingerprints when the file is replaced.
 */
export interface ImportFeature extends FeatureBase {
  type: 'import';
  source: {
    path: string;
    format: 'step' | 'iges' | 'brep' | 'stl' | 'obj' | '3mf' | 'glb';
    sha256: string;
    /** Original file name, for display. */
    fileName: string;
  };
  /** Placement of the imported geometry (mm); default identity. */
  frame?: Frame;
  op: BodyOp;
  scope?: BodyScope;
}

export interface PlaneFeature extends FeatureBase {
  type: 'plane';
  definition:
    | { kind: 'offset'; from: EntityRef; distance: Expr }
    | { kind: 'frame'; frame: Frame }
    // M3 reference planes. `from` planes may be origin planes, plane features or planar faces.
    | { kind: 'threePoints'; points: [EntityRef, EntityRef, EntityRef] }
    /** Through a line (edge or axis), rotated `angle` from `from`. */
    | { kind: 'angle'; from: EntityRef; axis: EntityRef; angle: Expr }
    /** Normal to a curve at a point on it (`at`: a vertex, or a 0–1 parameter along the edge). */
    | { kind: 'normalToCurve'; curve: EntityRef; at: EntityRef | { t: Expr } }
    /** Midway between two parallel planes/faces. */
    | { kind: 'midplane'; a: EntityRef; b: EntityRef }
    /** Parallel to `from`, through a point. */
    | { kind: 'throughPoint'; from: EntityRef; point: EntityRef };
  /** Flip the plane normal (and so the sketch's orientation on it). */
  flip?: boolean;
}

// ---- M3: reference geometry ----------------------------------------------------------------

/** A construction axis, usable wherever an axis or direction is picked (revolve, patterns…). */
export interface AxisFeature extends FeatureBase {
  type: 'axis';
  definition:
    | { kind: 'twoPoints'; a: EntityRef; b: EntityRef }
    /** Along a straight edge. */
    | { kind: 'edge'; edge: EntityRef }
    /** The axis of a cylindrical/conical face or circular edge. */
    | { kind: 'cylinder'; face: EntityRef }
    | { kind: 'twoPlanes'; a: EntityRef; b: EntityRef }
    /** Through a point, normal to a plane. */
    | { kind: 'pointNormal'; point: EntityRef; plane: EntityRef };
}

/** A construction point (sketch references, measure, axes and planes). */
export interface PointFeature extends FeatureBase {
  type: 'point';
  definition:
    | { kind: 'coordinates'; x: Expr; y: Expr; z: Expr }
    | { kind: 'vertex'; vertex: EntityRef }
    /** Centre of a circular edge / spherical face. */
    | { kind: 'center'; of: EntityRef }
    | { kind: 'alongEdge'; edge: EntityRef; t: Expr }
    | { kind: 'intersection'; a: EntityRef; b: EntityRef };
}

// ---- M3: modelling features ----------------------------------------------------------------

/** Hollow a body: remove `openFaces`, offset the rest by `thickness` (inward by default). */
export interface ShellFeature extends FeatureBase {
  type: 'shell';
  /** Faces to remove (on one body). Empty = a closed hollow solid. */
  openFaces: EntityRef[];
  /** The body, when `openFaces` is empty. */
  body?: EntityRef;
  thickness: Expr;
  direction: 'inward' | 'outward';
}

/** Taper faces by `angle` about a neutral plane, along its normal (flip with `reverse`). */
export interface DraftFeature extends FeatureBase {
  type: 'draft';
  faces: EntityRef[];
  neutral: EntityRef;
  angle: Expr;
  reverse: boolean;
}

/** Sweep closed profile regions along a path (a chain of sketch curves or model edges). */
export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  profile: EntityRef[];
  path: EntityRef[];
  /** `followPath`: the profile turns with the path (Frenet); `fixed`: it keeps its orientation. */
  orientation: 'followPath' | 'fixed';
  op: BodyOp;
  scope?: BodyScope;
}

/** Loft through ordered sections (each a closed region, or a point for the first/last). */
export interface LoftFeature extends FeatureBase {
  type: 'loft';
  sections: EntityRef[];
  /** Optional guide curves (M3: best-effort; OCCT ThruSections ignores them). */
  guides?: EntityRef[];
  /** Straight (ruled) faces between sections instead of smooth ones. */
  ruled: boolean;
  /** Join the last section back to the first. */
  closed: boolean;
  op: BodyOp;
  scope?: BodyScope;
}

/**
 * What a mirror or pattern copies. `features`: the listed features' **tool shapes** are copied
 * and applied with each feature's own op (a pattern of holes cuts every copy); `bodies`: whole
 * bodies are copied (and merged when `merge`).
 */
export type CopySource =
  | { kind: 'features'; features: Id[] }
  | { kind: 'bodies'; bodies: EntityRef[]; merge: boolean };

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  source: CopySource;
  /** A plane feature, origin plane or planar face. */
  plane: EntityRef;
}

export interface LinearPatternFeature extends FeatureBase {
  type: 'linearPattern';
  source: CopySource;
  /** Edge, axis or plane (its normal) giving the direction; `reverse` flips it. */
  direction: EntityRef;
  reverse: boolean;
  count: Expr;
  spacing: Expr;
  second?: { direction: EntityRef; reverse: boolean; count: Expr; spacing: Expr };
  /** Instance indices (0 = the original) to leave out, row-major with `second`. */
  skip?: number[];
}

export interface CircularPatternFeature extends FeatureBase {
  type: 'circularPattern';
  source: CopySource;
  axis: EntityRef;
  count: Expr;
  /** Total angle spanned. With `equalSpacing` the instances fill it (360° = a full ring). */
  angle: Expr;
  equalSpacing: boolean;
  skip?: number[];
}

/**
 * Hole wizard. Holes are placed at sketch points on a planar face (one hole per point), drilled
 * along the face's inward normal. Sizes come from the standards tables (contracts/standards.ts);
 * explicit diameters override them.
 */
export interface HoleFeature extends FeatureBase {
  type: 'hole';
  /** Sketch points (`S…:p(id)`) or vertices; their sketch must lie on the hole's face. */
  points: EntityRef[];
  face: EntityRef;
  standard: 'ISO' | 'ANSI';
  kind: 'simple' | 'counterbore' | 'countersink' | 'tapped';
  /** Table size key, e.g. "M6", "#10", "1/4". */
  size: string;
  fit: 'close' | 'normal' | 'loose';
  /** Override of the table diameter (drill diameter for tapped holes). */
  diameter?: Expr;
  end:
    | { kind: 'blind'; depth: Expr }
    | { kind: 'throughAll' }
    | { kind: 'upTo'; target: EntityRef };
  /** Drill-point cone at a blind end (118° default); omitted = flat bottom. */
  tipAngle?: Expr;
  counterbore?: { diameter?: Expr; depth?: Expr };
  countersink?: { diameter?: Expr; angle?: Expr };
  /** Tapped holes: a cosmetic thread (no helical geometry) over `depth` (default: full). */
  thread?: { depth?: Expr };
}

/** A cosmetic thread on a cylindrical face: an annotation (drawings, PMI), no geometry change. */
export interface ThreadFeature extends FeatureBase {
  type: 'thread';
  face: EntityRef;
  standard: 'ISO' | 'ANSI';
  size: string;
  length?: Expr;
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
