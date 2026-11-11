/**
 * The shared annotation core (PLAN §12 M4, ADR-081, ADR-090). Lead-owned.
 *
 * Annotations are part-level semantic objects (dimensions, GD&T, datums, notes, surface finish,
 * hole callouts) that measure the finished part. Drawings (M4) place them in views; M5 shows them
 * in 3D and exports them as STEP AP242 PMI. Model geometry: part mm and radians.
 */

import type { ConfiguredValue, EntityRef, Expr, Id, Vec3 } from './document';
import type { JsonPointer } from './store';

/**
 * Standard an annotation's GD&T semantics are validated against. Stamped by the authoring tool
 * from the drawing (or, in M5, the project default); absent on an annotation = "not stated", and
 * it is then checked against each displaying drawing's standard. Never converted silently: a
 * symbol that is illegal under the standard is refused or flagged with an explanation
 * (ASME Y14.5-2018 has no concentricity or symmetry).
 */
export type GpsStandard = 'ISO 1101:2017' | 'ASME Y14.5-2018' | 'ASME Y14.5-2009';

/** Surface texture standard (default ISO 21920-1; ISO 1302 is legacy, kept for old drawings). */
export type SurfaceFinishStandard = 'ISO 21920-1:2021' | 'ISO 1302:2002' | 'ASME Y14.36-2018';

/** Where an annotation was authored. Every kind is a full part annotation; this is provenance. */
export type AnnotationOrigin =
  /** In the part: promoted from a driving dimension, or (M5) on an annotation plane in 3D. */
  | { kind: 'model' }
  /** Drawn on a view of this drawing (the drawing's dimension tool). */
  | { kind: 'drawing'; drawingId: Id }
  /** M5: read from a STEP AP242 file (project-relative path of the imported file). */
  | { kind: 'import'; file: string };

/**
 * Binding to the model data that drives the value (owner D6, recommended: read-only in drawings).
 * The value shown is the source's evaluated value in the view's configuration. A source that no
 * longer exists (feature, constraint or field gone) makes the annotation needs attention; the old
 * value is never shown.
 */
export type AnnotationSource =
  /** A driving or reference dimension of a sketch (`DimensionConstraint`). */
  | { kind: 'sketchDimension'; featureId: Id; constraintId: Id }
  /** An `Expr` field of a feature, by JSON pointer: `/end/depth`, `/radius`, `/mode/distance`. */
  | { kind: 'featureField'; featureId: Id; path: JsonPointer }
  /** A whole feature: chamfer callouts (distance × angle), hole and thread callouts. */
  | { kind: 'feature'; featureId: Id };

/**
 * Which point of a referenced entity an annotation measures from (parallel to `refs`).
 * `self`: the entity itself (a face, an edge's line). `center`: circle, arc or sphere centre.
 * `axis`: a cylindrical or conical face's axis. `start` / `end` / `mid`: of an edge.
 */
export type RefPoint = 'self' | 'center' | 'axis' | 'start' | 'end' | 'mid';

/** Fields every annotation has. */
export interface AnnotationBase {
  id: Id;
  kind: string;
  origin: AnnotationOrigin;
  /**
   * Model geometry the annotation is attached to, by persistent name (PLAN §7.3). Arity and role
   * per kind are in the .md table ("refs per kind"). Resolved against the part's final state in the
   * view's configuration. Unresolved = needs attention: never re-attached to a guessed entity, and
   * the old value is never displayed (trap T1). Reattach replaces the list (every kind, trap T2).
   * May be empty only where the kind says so (a hole callout bound by `source`, a frame bound by
   * `appliesTo`).
   */
  refs: EntityRef[];
  /** Point qualifiers parallel to `refs`; absent or shorter = `'self'` for the rest. */
  at?: RefPoint[];
  /** Suppressed annotations are not shown or exported. Per configuration via `AnnotationOverride`. */
  suppressed?: boolean;
  /**
   * M5 reserve: the v3 `PmiAnnotation.placement` (3D annotation plane and text position), carried
   * over verbatim by the migration so nothing is lost. M5 replaces it with annotation planes.
   */
  modelPlacement?: { plane: [number, number, number, number, number, number]; textPos: Vec3 };
}

/**
 * Tolerance on a dimension's value. Deviations are signed `Expr`s relative to the nominal (so they
 * follow a configuration's nominal). `limits` stores deviations too and is displayed as the two
 * limits. `basic` and `reference` are display forms without a tolerance.
 */
export type Tolerance =
  /** `10 ±0.1`. */
  | { kind: 'symmetric'; value: Expr }
  /** `10 +0.1/−0.05`; `upper` ≥ `lower`. */
  | { kind: 'bilateral'; upper: Expr; lower: Expr }
  /** Shown as `10.1 / 9.95`. */
  | { kind: 'limits'; upper: Expr; lower: Expr }
  /** Theoretically exact (boxed). */
  | { kind: 'basic' }
  /** Reference dimension, shown in parentheses. */
  | { kind: 'reference' }
  /**
   * ISO 286 fit: `Ø20 H7`, `Ø20 g6`, `Ø20 H7/g6`. `hole` matches /^[A-Z]{1,2}(01|[1-9]|1[0-8])$/,
   * `shaft` the lower-case form; at least one is present. `show`: the symbol only, the symbol with
   * the deviations from the ISO 286-2 table, or the limits with the symbol in parentheses.
   */
  | {
      kind: 'fit';
      hole?: string;
      shaft?: string;
      show: 'symbol' | 'symbolAndDeviations' | 'limitsAndSymbol';
    };

/** Text around a dimension's value. The value itself is never replaceable by text (T1). */
export interface DimensionText {
  /** E.g. `4×`. A hole callout's count is automatic (`HoleCalloutAnnotation.show.count`). */
  prefix?: string;
  suffix?: string;
  /** Lines under the value: `TYP`, `THRU`. */
  below?: string;
  /** Decimals; absent = the drawing style's precision. Propagates to every placement. */
  precision?: number;
  /**
   * Prefix `N×` with the number of instances (pattern and mirror copies included) of the feature
   * that made `refs[0]`, from `AnnotationResolution.count`; never typed by hand (M4 gate).
   */
  count?: boolean;
}

/**
 * The value shown by a dimension: `source` (live from the model) or `nominal` (a stated value) or,
 * with neither, the value **measured** from the resolved refs. `source` and `nominal` are mutually
 * exclusive. A sourced or stated value that disagrees with the measured geometry is flagged
 * ("value differs from the model"), never shown as if it were fine.
 */
interface DimensionBase extends AnnotationBase {
  source?: AnnotationSource;
  nominal?: Expr;
  tolerance?: Tolerance;
  text?: DimensionText;
}

/**
 * Distance between two entities projected on `direction` (unit vector, part coordinates; set by
 * the drawing tool from the view's horizontal or vertical, by promotion from a sketch's u/v).
 * Absent: the natural separation of parallel planes or lines (or a plane and a point); two points
 * without a direction are an `aligned` dimension, and a linear one is flagged "choose a direction".
 * refs: [a, b].
 */
export interface LinearDimension extends DimensionBase {
  kind: 'linear';
  direction?: Vec3;
}

/** True (minimum) distance between two points, drawn parallel to the line joining them. refs: [a, b]. */
export interface AlignedDimension extends DimensionBase {
  kind: 'aligned';
}

/**
 * Ordinate: coordinate of `refs[1]` measured from the origin `refs[0]` along `direction`. Ordinates
 * with the same origin name and direction form one group in a view (one `0` label, shared lane).
 */
export interface OrdinateDimension extends DimensionBase {
  kind: 'ordinate';
  direction: Vec3;
}

/** refs: [circular edge | cylindrical, conical or spherical face]. A sphere shows SR / SØ. */
export interface RadiusDimension extends DimensionBase {
  kind: 'radius';
}

export interface DiameterDimension extends DimensionBase {
  kind: 'diameter';
}

/**
 * Angle between two straight edges, planar faces or axes. refs: [a, b]. `measure`: the angle
 * between them as oriented (≤ 180°, default) or its supplement.
 */
export interface AngleDimension extends DimensionBase {
  kind: 'angle';
  measure?: 'between' | 'supplement';
}

/**
 * Chamfer callout. refs: [the chamfer face] (or [edge] on a chamfer the model doesn't own).
 * Usually `source: { kind: 'feature' }` of a `ChamferFeature`. `form`: `2 × 45°` or `2 × 2`.
 */
export interface ChamferDimension extends DimensionBase {
  kind: 'chamfer';
  form: 'distanceAngle' | 'twoDistances';
}

/** Datum feature symbol. refs: [face | edge | axis via `at: ['axis']`]. Letters unique per part (checked). */
export interface DatumFeatureAnnotation extends AnnotationBase {
  kind: 'datumFeature';
  /** `A`, `B`… (ISO and ASME exclude I, O, Q; checked against the standard). */
  label: string;
  standard?: GpsStandard;
}

export type GeometricCharacteristic =
  | 'straightness'
  | 'flatness'
  | 'circularity'
  | 'cylindricity'
  | 'lineProfile'
  | 'surfaceProfile'
  | 'parallelism'
  | 'perpendicularity'
  | 'angularity'
  | 'position'
  /** ISO only (removed in ASME Y14.5-2018). */
  | 'concentricity'
  /** ISO: coaxiality of axes (same symbol as concentricity). */
  | 'coaxiality'
  /** ISO only (removed in ASME Y14.5-2018). */
  | 'symmetry'
  | 'circularRunout'
  | 'totalRunout';

export type MaterialCondition = 'mmc' | 'lmc';

/** Zone modifiers that take no value. Legality per standard is a validation rule, not a type. */
export type ZoneModifier =
  | 'freeState'
  | 'tangentPlane'
  | 'statistical'
  /** ISO 1101 CZ. */
  | 'combinedZone'
  /** ISO 1101 SZ. */
  | 'separateZones';

export interface ToleranceZone {
  /** Zone size (length). */
  value: Expr;
  /** `diameter` = Ø zone, `sphericalDiameter` = SØ; absent = width between two planes/lines. */
  shape?: 'diameter' | 'sphericalDiameter';
  material?: MaterialCondition;
  modifiers?: ZoneModifier[];
  /** Projected tolerance zone Ⓟ with its height. */
  projected?: Expr;
  /** Unequally disposed (ASME Ⓤ / ISO UZ) offset. */
  unequal?: Expr;
  /** Refinement per unit: `0.05 / 100` (length) or `/ 100 × 100` (area: `width` set). */
  perUnit?: { value: Expr; length: Expr; width?: Expr };
}

/**
 * A datum in a frame: bound to a datum feature annotation by id (renaming the letter updates every
 * frame), or an unbound letter (M5 import, or a migrated v3 frame whose letter no datum defines),
 * which is needs attention until bound.
 */
export type DatumRef = { datum: Id } | { label: string };

/** One compartment of the datum section; several refs = a common datum (`A–B`). */
export interface DatumCompartment {
  datums: DatumRef[];
  material?: MaterialCondition;
}

/** Feature control frame (one row; composite and stacked frames: see the .md open questions). */
export interface GeometricToleranceAnnotation extends AnnotationBase {
  kind: 'geometricTolerance';
  standard?: GpsStandard;
  characteristic: GeometricCharacteristic;
  zone: ToleranceZone;
  /** Primary, secondary, tertiary. At most three. */
  datums?: DatumCompartment[];
  /** All-around / all-over (profile). */
  allAround?: boolean;
  /**
   * The size dimension whose feature of size this frame controls (a position frame under `Ø6`):
   * its refs are used and `refs` may be empty. A missing dimension id is needs attention.
   */
  appliesTo?: Id;
  /** Text above and below the frame (`2×`, `UNITS`). */
  text?: { above?: string; below?: string };
}

/** A note attached to model geometry by a leader. Free sheet text is a `SheetNote` (§C). refs: ≥ 1. */
export interface NoteAnnotation extends AnnotationBase {
  kind: 'note';
  /** Plain text; `{slot}` tokens resolve like title-block slots (`{material}`). */
  text: string;
}

export type SurfaceLay =
  | 'parallel'
  | 'perpendicular'
  | 'crossed'
  | 'multiDirectional'
  | 'circular'
  | 'radial'
  | 'particulate';

/** One surface texture requirement, e.g. `Ra 1.6 µm` (upper limit, `max` rule under ISO 21920). */
export interface SurfaceRequirement {
  /** Parameter symbol as written by the standard: `Ra`, `Rz`, `Rmr(c)`, `Wt` … */
  parameter: string;
  /** Limit type; absent = upper. */
  limit?: 'upper' | 'lower';
  /** Length expression; the inline field writes µm (`1.6 µm`). */
  value: Expr;
  /** Acceptance rule; absent = the standard's default (ISO 21920-1: max; ISO 1302: 16 %). */
  acceptance?: 'max' | '16%';
  /** Filter / evaluation length text as written (`0.8`, `λs 2.5 µm`). */
  filter?: string;
}

/** Surface texture symbol (ISO 21920-1 by default). refs: [face]. */
export interface SurfaceFinishAnnotation extends AnnotationBase {
  kind: 'surfaceFinish';
  standard?: SurfaceFinishStandard;
  process: 'any' | 'removalRequired' | 'removalProhibited';
  allAround?: boolean;
  /** Empty = the bare symbol. */
  requirements: SurfaceRequirement[];
  /** Manufacturing method text (`ground`). */
  method?: string;
  lay?: SurfaceLay;
  /** Machining allowance (length). */
  allowance?: Expr;
}

/**
 * Hole (or cosmetic thread) callout generated from `HoleFeature` / `ThreadFeature` data: size,
 * fit, counterbore, countersink, depth, thread, and the instance count (pattern copies included,
 * from the regen). One callout per feature and part (checked), placed in any number of views, so a
 * format edit (precision, tolerance) propagates to every placement and to the hole table.
 * refs: the hole faces the leaders may attach to (one per instance the user picked; may be empty,
 * then a placement attaches to the first instance the regen reports).
 */
export interface HoleCalloutAnnotation extends AnnotationBase {
  kind: 'holeCallout';
  source: { kind: 'feature'; featureId: Id };
  /** Which lines to show; absent = all that apply. */
  show?: {
    count?: boolean;
    depth?: boolean;
    thread?: boolean;
    counterbore?: boolean;
    countersink?: boolean;
  };
  /** Tolerance on the hole diameter (a fit here overrides the hole's own `fit` class display). */
  tolerance?: Tolerance;
  text?: DimensionText;
}

export type DimensionAnnotation =
  | LinearDimension
  | AlignedDimension
  | OrdinateDimension
  | RadiusDimension
  | DiameterDimension
  | AngleDimension
  | ChamferDimension;

/** A part-level semantic annotation (replaces v3 `PmiAnnotation`). */
export type Annotation =
  | DimensionAnnotation
  | DatumFeatureAnnotation
  | GeometricToleranceAnnotation
  | NoteAnnotation
  | SurfaceFinishAnnotation
  | HoleCalloutAnnotation;

export type AnnotationKind = Annotation['kind'];

/**
 * Configuration overrides of one annotation (keyed by annotation id in `Configuration.annotations`,
 * never by list position: closes the M3.7 gate finding). `fields`: JSON pointer **inside the
 * annotation** → value; allowed are its `Expr` fields (`/nominal`, `/tolerance/value`,
 * `/tolerance/upper`, `/tolerance/lower`, `/zone/value` …) and the option fields the document
 * package lists in `ANNOTATION_CONFIGURABLE_OPTIONS` (`/tolerance/hole`, `/tolerance/shaft`).
 */
export interface AnnotationOverride {
  suppressed?: boolean;
  fields?: Record<JsonPointer, ConfiguredValue>;
}

/**
 * Semantic checks (pure, packages/document `annotationIssues(doc, partId, annotation, standard)`),
 * combined by the drawing package with `AnnotationResolution` into the needs-attention panel.
 */
export type AnnotationIssue =
  | { kind: 'valueMismatch'; shown: number; measured: number }
  | { kind: 'illegalForStandard'; standard: GpsStandard; message: string }
  | { kind: 'standardMismatch'; annotation: GpsStandard; drawing: GpsStandard }
  | { kind: 'datumUnbound'; label: string }
  | { kind: 'duplicateDatumLabel'; label: string }
  | { kind: 'duplicateCallout'; featureId: Id }
  | { kind: 'refsDoNotFit'; message: string }
  | { kind: 'directionMissing' }
  | { kind: 'sourceGone'; source: AnnotationSource }
  | { kind: 'configurationMissing'; configurationId: Id }
  /** Placement-level (drawing package): seen end-on in this view, or placed twice in the drawing. */
  | { kind: 'notMeasurableInView'; viewId: Id }
  | { kind: 'placedTwice'; placementIds: Id[] };
