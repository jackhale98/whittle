// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Part-level annotations (M4, ADR-081, ADR-090): which fields are `Expr`s, which fields a
 * configuration may override, structural validation and small helpers shared by the command
 * compilers and the migration.
 *
 * Expected-dimension table (mirrored in docs/FILE_FORMAT.md §5.4):
 *
 *   dimensions (linear, aligned, ordinate, radius, diameter, angle, chamfer)
 *                         /nominal                                   angle for `angle`, else length
 *                         /tolerance/value                           (symmetric)  same
 *                         /tolerance/upper, /tolerance/lower         (bilateral, limits)  same
 *   holeCallout           /tolerance/value | /upper | /lower         length
 *   geometricTolerance    /zone/value, /zone/projected, /zone/unequal,
 *                         /zone/perUnit/value, /zone/perUnit/length, /zone/perUnit/width   length
 *   surfaceFinish         /requirements/N/value, /allowance          length
 *
 * Fields that the kind requires are listed even when missing, so validation reports them.
 */

import type {
  Annotation,
  AnnotationKind,
  ConfiguredValue,
  EntityRef,
  GeometricCharacteristic,
  GpsStandard,
  Id,
  NamedDimension,
  Part,
  RefPoint,
  SurfaceFinishStandard,
  ZoneModifier,
} from '@wren-cad/contracts';
import { Checker, isObj, type Obj } from './check';
import type { ExprField } from './features';
import { isHoleFitClass, isShaftFitClass } from './iso286';

export const ANNOTATION_KINDS = [
  'linear',
  'aligned',
  'ordinate',
  'radius',
  'diameter',
  'angle',
  'chamfer',
  'datumFeature',
  'geometricTolerance',
  'note',
  'surfaceFinish',
  'holeCallout',
] as const satisfies readonly AnnotationKind[];

type MissingKinds = Exclude<AnnotationKind, (typeof ANNOTATION_KINDS)[number]>;
export const _allAnnotationKindsListed: [MissingKinds] extends [never] ? true : never = true;

/** The kinds that are dimensions (carry `source`, `nominal`, `tolerance`, `text`). */
export const DIMENSION_KINDS = [
  'linear',
  'aligned',
  'ordinate',
  'radius',
  'diameter',
  'angle',
  'chamfer',
] as const satisfies readonly AnnotationKind[];

export const isDimensionKind = (k: unknown): boolean =>
  (DIMENSION_KINDS as readonly unknown[]).includes(k);

export const GEOMETRIC_CHARACTERISTICS = [
  'straightness',
  'flatness',
  'circularity',
  'cylindricity',
  'lineProfile',
  'surfaceProfile',
  'parallelism',
  'perpendicularity',
  'angularity',
  'position',
  'concentricity',
  'coaxiality',
  'symmetry',
  'circularRunout',
  'totalRunout',
] as const satisfies readonly GeometricCharacteristic[];

export const GPS_STANDARDS = [
  'ISO 1101:2017',
  'ASME Y14.5-2018',
  'ASME Y14.5-2009',
] as const satisfies readonly GpsStandard[];

export const SURFACE_FINISH_STANDARDS = [
  'ISO 21920-1:2021',
  'ISO 1302:2002',
  'ASME Y14.36-2018',
] as const satisfies readonly SurfaceFinishStandard[];

export const REF_POINTS = [
  'self',
  'center',
  'axis',
  'start',
  'end',
  'mid',
] as const satisfies readonly RefPoint[];

export const ZONE_MODIFIERS = [
  'freeState',
  'tangentPlane',
  'statistical',
  'combinedZone',
  'separateZones',
] as const satisfies readonly ZoneModifier[];

const ENTITY_KINDS = ['face', 'edge', 'vertex', 'region', 'body'] as const;
const TOLERANCE_KINDS = ['symmetric', 'bilateral', 'limits', 'basic', 'reference', 'fit'] as const;
const SURFACE_LAYS = [
  'parallel',
  'perpendicular',
  'crossed',
  'multiDirectional',
  'circular',
  'radial',
  'particulate',
] as const;

/** The GD&T family of an ISO standard or an ASME one. */
export const gpsFamily = (s: GpsStandard): 'iso' | 'asme' =>
  s === 'ISO 1101:2017' ? 'iso' : 'asme';

// ---------------------------------------------------------------------------------------------
// Expression fields
// ---------------------------------------------------------------------------------------------

const rec = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined);

/**
 * Every `Expr` field of an annotation with the dimension it must have (JSON pointers *inside* the
 * annotation). Safe on malformed input: it reports what the declared kind requires and skips
 * optional fields that are absent.
 */
export function annotationExprFields(a: Annotation): ExprField[] {
  const out: ExprField[] = [];
  const o = a as unknown as Obj;
  const has = (v: unknown): boolean => v !== undefined;
  const tolerance = (dim: NamedDimension): void => {
    const t = rec(o.tolerance);
    switch (t?.kind) {
      case 'symmetric':
        out.push({ pointer: '/tolerance/value', expected: dim });
        break;
      case 'bilateral':
      case 'limits':
        out.push({ pointer: '/tolerance/upper', expected: dim });
        out.push({ pointer: '/tolerance/lower', expected: dim });
        break;
    }
  };
  switch (o.kind) {
    case 'linear':
    case 'aligned':
    case 'ordinate':
    case 'radius':
    case 'diameter':
    case 'angle':
    case 'chamfer': {
      const dim: NamedDimension = o.kind === 'angle' ? 'angle' : 'length';
      if (has(o.nominal)) out.push({ pointer: '/nominal', expected: dim });
      tolerance(dim);
      break;
    }
    case 'holeCallout':
      tolerance('length');
      break;
    case 'geometricTolerance': {
      out.push({ pointer: '/zone/value', expected: 'length' });
      const z = rec(o.zone);
      if (has(z?.projected)) out.push({ pointer: '/zone/projected', expected: 'length' });
      if (has(z?.unequal)) out.push({ pointer: '/zone/unequal', expected: 'length' });
      const p = rec(z?.perUnit);
      if (p) {
        out.push({ pointer: '/zone/perUnit/value', expected: 'length' });
        out.push({ pointer: '/zone/perUnit/length', expected: 'length' });
        if (has(p.width)) out.push({ pointer: '/zone/perUnit/width', expected: 'length' });
      }
      break;
    }
    case 'surfaceFinish': {
      if (Array.isArray(o.requirements)) {
        o.requirements.forEach((_, i) => {
          out.push({ pointer: `/requirements/${i}/value`, expected: 'length' });
        });
      }
      if (has(o.allowance)) out.push({ pointer: '/allowance', expected: 'length' });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Configurable fields
// ---------------------------------------------------------------------------------------------

/** An option (non-`Expr`) field of an annotation a configuration may override. */
export interface AnnotationConfigurableOption {
  /** JSON pointer inside the annotation. */
  pointer: string;
  label: string;
  /** Which values are allowed (the set of fit classes is too large to list). */
  accepts(value: ConfiguredValue): boolean;
  /** What the accepted values look like, for messages. */
  expects: string;
}

/**
 * Option fields a configuration may override, in addition to every annotation `Expr` field
 * (ADR-090): the ISO 286 classes of a fit tolerance (`H7` → `H8` in the loose configuration).
 */
export const ANNOTATION_CONFIGURABLE_OPTIONS: readonly AnnotationConfigurableOption[] = [
  {
    pointer: '/tolerance/hole',
    label: 'Hole fit class',
    accepts: isHoleFitClass,
    expects: 'an ISO 286 hole class like H7',
  },
  {
    pointer: '/tolerance/shaft',
    label: 'Shaft fit class',
    accepts: isShaftFitClass,
    expects: 'an ISO 286 shaft class like g6',
  },
];

export function annotationOptionAt(pointer: string): AnnotationConfigurableOption | undefined {
  return ANNOTATION_CONFIGURABLE_OPTIONS.find((o) => o.pointer === pointer);
}

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

/**
 * What the kind requires of `refs` (arity per kind, the table in the proposal §2.2), or undefined
 * when the list fits. A frame with `appliesTo` may have no refs.
 */
export function annotationRefsProblem(a: Annotation): string | undefined {
  const n = a.refs.length;
  const exactly = (k: number, what: string): string | undefined =>
    n === k
      ? undefined
      : `${what} needs ${k === 1 ? 'one reference' : `${k} references`}, not ${n}`;
  switch (a.kind) {
    case 'linear':
    case 'aligned':
    case 'ordinate':
    case 'angle':
      return exactly(2, `A ${a.kind} dimension`);
    case 'radius':
    case 'diameter':
    case 'chamfer':
      return exactly(1, `A ${a.kind} dimension`);
    case 'datumFeature':
      return exactly(1, 'A datum feature');
    case 'surfaceFinish':
      return exactly(1, 'A surface finish symbol');
    case 'geometricTolerance':
      if (n === 1 || (n === 0 && a.appliesTo !== undefined)) return undefined;
      return n === 0
        ? 'A tolerance frame needs a toleranced feature, or a dimension it applies to'
        : `A tolerance frame needs one reference, not ${n}`;
    case 'note':
      return n >= 1 ? undefined : 'A note needs at least one leader target';
    case 'holeCallout':
      return undefined;
  }
}

const isEntityRefShape = (r: unknown): r is EntityRef =>
  isObj(r) &&
  typeof r.name === 'string' &&
  r.name !== '' &&
  (ENTITY_KINDS as readonly unknown[]).includes(r.kind);

// ---------------------------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------------------------

/**
 * Structural checks of one annotation (types, enums, required fields). Semantic checks (arity,
 * letters, legality per standard) are `annotationIssues`; they never fail a load.
 */
export function checkAnnotation(c: Checker, a: unknown, at: string): void {
  if (!c.obj(a, at)) return;
  c.id(a.id, `${at}.id`);
  if (!c.oneOf(a.kind, `${at}.kind`, ANNOTATION_KINDS)) return;
  checkOrigin(c, a.origin, `${at}.origin`);
  checkRefs(c, a, at);
  if (a.suppressed !== undefined) c.bool(a.suppressed, `${at}.suppressed`);
  if (a.modelPlacement !== undefined && c.obj(a.modelPlacement, `${at}.modelPlacement`)) {
    const p = a.modelPlacement.plane;
    if (
      !Array.isArray(p) ||
      p.length !== 6 ||
      !p.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      c.err(`${at}.modelPlacement.plane must be six finite numbers`);
    }
    c.vec3(a.modelPlacement.textPos, `${at}.modelPlacement.textPos`);
  }
  try {
    for (const f of annotationExprFields(a as unknown as Annotation)) {
      const v = f.pointer
        .split('/')
        .slice(1)
        .reduce<unknown>(
          (cur, k) => (isObj(cur) || Array.isArray(cur) ? (cur as Obj)[k] : undefined),
          a,
        );
      if (typeof v !== 'string') c.err(`${at}${f.pointer} must be an expression string`);
    }
  } catch {
    c.err(`${at} is malformed`);
    return;
  }
  const standard = (): void => {
    if (a.standard !== undefined) c.oneOf(a.standard, `${at}.standard`, GPS_STANDARDS);
  };
  if (isDimensionKind(a.kind)) checkDimension(c, a, at);
  switch (a.kind) {
    case 'datumFeature':
      c.str(a.label, `${at}.label`);
      standard();
      break;
    case 'geometricTolerance':
      standard();
      checkFrame(c, a, at);
      break;
    case 'note':
      c.str(a.text, `${at}.text`);
      break;
    case 'surfaceFinish':
      checkSurfaceFinish(c, a, at);
      break;
    case 'holeCallout':
      checkHoleCallout(c, a, at);
      break;
  }
}

function checkOrigin(c: Checker, o: unknown, at: string): void {
  if (!c.obj(o, at)) return;
  if (!c.oneOf(o.kind, `${at}.kind`, ['model', 'drawing', 'import'] as const)) return;
  if (o.kind === 'drawing') c.nonEmpty(o.drawingId, `${at}.drawingId`);
  if (o.kind === 'import') c.str(o.file, `${at}.file`);
}

function checkRefs(c: Checker, a: Obj, at: string): void {
  if (!c.arr(a.refs, `${at}.refs`)) return;
  a.refs.forEach((r, i) => {
    if (!isEntityRefShape(r)) c.err(`${at}.refs[${i}] must be an entity reference`);
  });
  if (a.at === undefined) return;
  if (!c.arr(a.at, `${at}.at`)) return;
  if (a.at.length > a.refs.length) c.err(`${at}.at has more entries than refs`);
  a.at.forEach((p, i) => {
    c.oneOf(p, `${at}.at[${i}]`, REF_POINTS);
  });
}

function checkDimension(c: Checker, a: Obj, at: string): void {
  if (a.source !== undefined && a.nominal !== undefined) {
    c.err(`${at} has both a source and a nominal value`);
  }
  if (a.source !== undefined) checkSource(c, a.source, `${at}.source`);
  if (a.kind === 'ordinate') {
    if (a.direction === undefined) c.err(`${at}.direction is required for an ordinate dimension`);
  }
  if (a.direction !== undefined) checkDirection(c, a.direction, `${at}.direction`);
  if (a.kind === 'chamfer')
    c.oneOf(a.form, `${at}.form`, ['distanceAngle', 'twoDistances'] as const);
  if (a.kind === 'angle' && a.measure !== undefined) {
    c.oneOf(a.measure, `${at}.measure`, ['between', 'supplement'] as const);
  }
  if (a.tolerance !== undefined) checkTolerance(c, a.tolerance, `${at}.tolerance`);
  if (a.text !== undefined) checkText(c, a.text, `${at}.text`);
}

function checkDirection(c: Checker, d: unknown, at: string): void {
  if (!c.vec3(d, at)) return;
  const [x, y, z] = d as [number, number, number];
  if (Math.abs(Math.hypot(x, y, z) - 1) > 1e-9) c.err(`${at} must be a unit vector`);
}

function checkSource(c: Checker, s: unknown, at: string): void {
  if (!c.obj(s, at)) return;
  if (!c.oneOf(s.kind, `${at}.kind`, ['sketchDimension', 'featureField', 'feature'] as const))
    return;
  c.nonEmpty(s.featureId, `${at}.featureId`);
  if (s.kind === 'sketchDimension') c.nonEmpty(s.constraintId, `${at}.constraintId`);
  if (s.kind === 'featureField') c.pointer(s.path, `${at}.path`);
}

function checkTolerance(c: Checker, t: unknown, at: string): void {
  if (!c.obj(t, at)) return;
  if (!c.oneOf(t.kind, `${at}.kind`, TOLERANCE_KINDS)) return;
  if (t.kind !== 'fit') return;
  if (t.hole === undefined && t.shaft === undefined) c.err(`${at} needs a hole or a shaft class`);
  if (t.hole !== undefined && !isHoleFitClass(t.hole)) {
    c.err(`${at}.hole must be an ISO 286 hole class like H7`);
  }
  if (t.shaft !== undefined && !isShaftFitClass(t.shaft)) {
    c.err(`${at}.shaft must be an ISO 286 shaft class like g6`);
  }
  c.oneOf(t.show, `${at}.show`, ['symbol', 'symbolAndDeviations', 'limitsAndSymbol'] as const);
}

function checkText(c: Checker, t: unknown, at: string): void {
  if (!c.obj(t, at)) return;
  for (const k of ['prefix', 'suffix', 'below'] as const) {
    if (t[k] !== undefined) c.str(t[k], `${at}.${k}`);
  }
  if (t.precision !== undefined)
    c.num(t.precision, `${at}.precision`, { int: true, min: 0, max: 6 });
}

function checkFrame(c: Checker, a: Obj, at: string): void {
  c.oneOf(a.characteristic, `${at}.characteristic`, GEOMETRIC_CHARACTERISTICS);
  if (c.obj(a.zone, `${at}.zone`)) {
    const z = a.zone;
    if (z.shape !== undefined) {
      c.oneOf(z.shape, `${at}.zone.shape`, ['diameter', 'sphericalDiameter'] as const);
    }
    if (z.material !== undefined)
      c.oneOf(z.material, `${at}.zone.material`, ['mmc', 'lmc'] as const);
    if (z.modifiers !== undefined && c.arr(z.modifiers, `${at}.zone.modifiers`)) {
      z.modifiers.forEach((m, i) => {
        c.oneOf(m, `${at}.zone.modifiers[${i}]`, ZONE_MODIFIERS);
      });
    }
    if (z.perUnit !== undefined) c.obj(z.perUnit, `${at}.zone.perUnit`);
  }
  if (a.datums !== undefined && c.arr(a.datums, `${at}.datums`)) {
    if (a.datums.length > 3) c.err(`${at}.datums has more than three compartments`);
    a.datums.forEach((k, i) => {
      const ka = `${at}.datums[${i}]`;
      if (!c.obj(k, ka)) return;
      if (k.material !== undefined) c.oneOf(k.material, `${ka}.material`, ['mmc', 'lmc'] as const);
      if (!c.arr(k.datums, `${ka}.datums`)) return;
      if (k.datums.length === 0) c.err(`${ka}.datums needs at least one datum`);
      k.datums.forEach((r, j) => {
        const ra = `${ka}.datums[${j}]`;
        if (!c.obj(r, ra)) return;
        if (typeof r.datum === 'string' && r.datum !== '') return;
        if (typeof r.label === 'string') return;
        c.err(`${ra} must be { datum: id } or { label }`);
      });
    });
  }
  if (a.allAround !== undefined) c.bool(a.allAround, `${at}.allAround`);
  if (a.appliesTo !== undefined) c.nonEmpty(a.appliesTo, `${at}.appliesTo`);
  if (a.text !== undefined && c.obj(a.text, `${at}.text`)) {
    for (const k of ['above', 'below'] as const) {
      if (a.text[k] !== undefined) c.str(a.text[k], `${at}.text.${k}`);
    }
  }
}

function checkSurfaceFinish(c: Checker, a: Obj, at: string): void {
  if (a.standard !== undefined) c.oneOf(a.standard, `${at}.standard`, SURFACE_FINISH_STANDARDS);
  c.oneOf(a.process, `${at}.process`, ['any', 'removalRequired', 'removalProhibited'] as const);
  if (a.allAround !== undefined) c.bool(a.allAround, `${at}.allAround`);
  if (a.lay !== undefined) c.oneOf(a.lay, `${at}.lay`, SURFACE_LAYS);
  if (a.method !== undefined) c.str(a.method, `${at}.method`);
  if (!c.arr(a.requirements, `${at}.requirements`)) return;
  a.requirements.forEach((r, i) => {
    const ra = `${at}.requirements[${i}]`;
    if (!c.obj(r, ra)) return;
    c.nonEmpty(r.parameter, `${ra}.parameter`);
    if (r.limit !== undefined) c.oneOf(r.limit, `${ra}.limit`, ['upper', 'lower'] as const);
    if (r.acceptance !== undefined)
      c.oneOf(r.acceptance, `${ra}.acceptance`, ['max', '16%'] as const);
    if (r.filter !== undefined) c.str(r.filter, `${ra}.filter`);
  });
}

function checkHoleCallout(c: Checker, a: Obj, at: string): void {
  if (c.obj(a.source, `${at}.source`)) {
    if (a.source.kind !== 'feature') c.err(`${at}.source.kind must be ‘feature’`);
    c.nonEmpty(a.source.featureId, `${at}.source.featureId`);
  }
  if (a.show !== undefined && c.obj(a.show, `${at}.show`)) {
    for (const k of ['count', 'depth', 'thread', 'counterbore', 'countersink'] as const) {
      if (a.show[k] !== undefined) c.bool(a.show[k], `${at}.show.${k}`);
    }
  }
  if (a.tolerance !== undefined) checkTolerance(c, a.tolerance, `${at}.tolerance`);
  if (a.text !== undefined) checkText(c, a.text, `${at}.text`);
}

/** Structural problems of one annotation (empty = fine). Ids are only checked for being non-empty. */
export function annotationProblems(a: unknown, at = 'annotation'): string[] {
  const c = new Checker();
  checkAnnotation(c, a, at);
  return c.errs;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A short human name for undo labels and messages: `Ø diameter dimension`, `datum A`. */
export function describeAnnotation(a: Annotation): string {
  switch (a.kind) {
    case 'datumFeature':
      return a.label === '' ? 'datum' : `datum ${a.label}`;
    case 'geometricTolerance':
      return `${a.characteristic} frame`;
    case 'surfaceFinish':
      return 'surface finish';
    case 'holeCallout':
      return 'hole callout';
    case 'note':
      return 'note';
    default:
      return `${a.kind} dimension`;
  }
}

export const findAnnotation = (part: Part, id: Id): Annotation | undefined =>
  part.annotations?.find((a) => a.id === id);
