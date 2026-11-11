// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Semantic checks of annotations (M4, ADR-090): pure rule tables and `annotationIssues`.
 *
 * Validation refuses and explains; it never converts (an illegal symbol is never swapped for a
 * legal one). The tables are data so M5's STEP export reuses them.
 *
 * **Provisional (secondary sources).** The owner decided (D9) to build from public and secondary
 * sources first and re-verify against ISO 1101:2017, ISO 5459, ASME Y14.5-2018 and Y14.5-2009
 * once they are bought. Every rule here is marked in its comment; the tests carry the same flag.
 */

import type {
  Annotation,
  AnnotationIssue,
  Feature,
  GeometricCharacteristic,
  GeometricToleranceAnnotation,
  GpsStandard,
  Id,
  Part,
  WrenDoc,
  ZoneModifier,
} from '@wren-cad/contracts';
import { annotationRefsProblem } from './annotations';
import { exprFields } from './features';
import { fitDeviations } from './iso286';

export const RULES_PROVISIONAL = 'provisional (secondary sources)';

// ---------------------------------------------------------------------------------------------
// GD&T legality per standard
// ---------------------------------------------------------------------------------------------

/**
 * Characteristics a standard does not have, with the explanation to show. A characteristic that
 * is not listed is legal. Provisional (secondary sources).
 *
 *  - ISO 1101:2017 has all fifteen.
 *  - ASME Y14.5-2018 removed concentricity and symmetry (use position, profile or runout), and
 *    has no coaxiality (an ISO term).
 *  - ASME Y14.5-2009 still has concentricity and symmetry, and no coaxiality.
 */
export const CHARACTERISTIC_REFUSALS: Readonly<
  Record<GpsStandard, Readonly<Partial<Record<GeometricCharacteristic, string>>>>
> = {
  'ISO 1101:2017': {},
  'ASME Y14.5-2018': {
    concentricity: 'ASME Y14.5-2018 has no concentricity; use position or profile',
    symmetry: 'ASME Y14.5-2018 has no symmetry; use position or profile',
    coaxiality: 'ASME Y14.5-2018 has no coaxiality (an ISO term); use position or runout',
  },
  'ASME Y14.5-2009': {
    coaxiality: 'ASME Y14.5 has no coaxiality (an ISO term); use concentricity, position or runout',
  },
};

/** Zone modifiers a standard does not have. Provisional (secondary sources). */
export const MODIFIER_REFUSALS: Readonly<
  Record<GpsStandard, Readonly<Partial<Record<ZoneModifier, string>>>>
> = {
  'ISO 1101:2017': {},
  'ASME Y14.5-2018': {
    combinedZone:
      'CZ is an ISO 1101 modifier; ASME Y14.5 states a simultaneous requirement in a note',
    separateZones: 'SZ is an ISO 1101 modifier; ASME Y14.5 states a separate requirement in a note',
  },
  'ASME Y14.5-2009': {
    combinedZone:
      'CZ is an ISO 1101 modifier; ASME Y14.5 states a simultaneous requirement in a note',
    separateZones: 'SZ is an ISO 1101 modifier; ASME Y14.5 states a separate requirement in a note',
  },
};

/** Characteristics that control a surface or a profile, so MMC/LMC does not apply to them. */
export const NO_MATERIAL_CONDITION: ReadonlySet<GeometricCharacteristic> = new Set([
  'flatness',
  'circularity',
  'cylindricity',
  'lineProfile',
  'surfaceProfile',
  'circularRunout',
  'totalRunout',
]);

export type CharacteristicClass = 'form' | 'orientation' | 'location' | 'profile' | 'runout';

export const CHARACTERISTIC_CLASS: Readonly<Record<GeometricCharacteristic, CharacteristicClass>> =
  {
    straightness: 'form',
    flatness: 'form',
    circularity: 'form',
    cylindricity: 'form',
    lineProfile: 'profile',
    surfaceProfile: 'profile',
    parallelism: 'orientation',
    perpendicularity: 'orientation',
    angularity: 'orientation',
    position: 'location',
    concentricity: 'location',
    coaxiality: 'location',
    symmetry: 'location',
    circularRunout: 'runout',
    totalRunout: 'runout',
  };

/** Why `standard` cannot show this characteristic, or undefined when it can. */
export function characteristicRefusal(
  standard: GpsStandard,
  characteristic: GeometricCharacteristic,
): string | undefined {
  return CHARACTERISTIC_REFUSALS[standard][characteristic];
}

// ---------------------------------------------------------------------------------------------
// Datum letters
// ---------------------------------------------------------------------------------------------

/** Letters not used as datum letters (they read as 1, 0 and 0). Provisional (secondary sources). */
export const DATUM_LETTERS_EXCLUDED = 'IOQ';

/** One to three capital letters, none of I, O, Q. */
export const DATUM_LABEL_RE = /^[A-HJ-NP-Z]{1,3}$/;

/** Why a datum label is not valid, or undefined when it is. */
export function datumLabelProblem(label: string): string | undefined {
  if (label === '') return 'The datum letter is missing';
  if (!/^[A-Z]+$/.test(label)) return `Datum ‘${label}’ must be capital letters`;
  if (label.length > 3) return `Datum ‘${label}’ is too long (up to three letters)`;
  for (const ch of label) {
    if (DATUM_LETTERS_EXCLUDED.includes(ch)) {
      return `Datum letters never use ${DATUM_LETTERS_EXCLUDED.split('').join(', ')} (‘${label}’)`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// annotationIssues
// ---------------------------------------------------------------------------------------------

function sourceExists(part: Part, a: Annotation): boolean {
  if (!('source' in a) || a.source === undefined) return true;
  const s = a.source;
  const f: Feature | undefined = part.features.find((x) => x.id === s.featureId);
  if (!f) return false;
  switch (s.kind) {
    case 'feature':
      return true;
    case 'sketchDimension':
      return (
        f.type === 'sketch' && f.constraints.some((k) => k.id === s.constraintId && 'value' in k)
      );
    case 'featureField':
      return exprFields(f).some((x) => x.pointer === s.path);
  }
}

const POINT_ATS = new Set(['center', 'start', 'end', 'mid']);

/** A linear dimension between two points has no natural direction: the user has to choose. */
function linearNeedsDirection(a: Annotation): boolean {
  if (a.kind !== 'linear' || a.direction !== undefined) return false;
  const [r0, r1] = a.refs;
  if (!r0 || !r1) return false;
  const pointLike = (i: 0 | 1): boolean =>
    (a.refs[i] as { kind: string }).kind === 'vertex' || POINT_ATS.has(a.at?.[i] ?? 'self');
  return pointLike(0) && pointLike(1);
}

/**
 * Semantic problems of one annotation of a part, for the needs-attention panel. Pure.
 * `standard` is the standard of the displaying drawing (or the project default); an annotation's
 * own `standard` wins for legality, and a different one on the drawing is a `standardMismatch`.
 *
 * The drawing package adds the checks that need resolution or a view (`valueMismatch`,
 * `notMeasurableInView`, `placedTwice`, `configurationMissing`).
 */
export function annotationIssues(
  doc: WrenDoc,
  partId: Id,
  annotation: Annotation,
  standard?: GpsStandard,
): AnnotationIssue[] {
  const part = doc.parts.find((p) => p.id === partId);
  const issues: AnnotationIssue[] = [];
  const refs = annotationRefsProblem(annotation);
  if (refs !== undefined) issues.push({ kind: 'refsDoNotFit', message: refs });
  if (!part) return issues;

  if (
    'source' in annotation &&
    annotation.source !== undefined &&
    !sourceExists(part, annotation)
  ) {
    issues.push({ kind: 'sourceGone', source: annotation.source });
  }
  if (linearNeedsDirection(annotation)) issues.push({ kind: 'directionMissing' });
  if ('tolerance' in annotation && annotation.tolerance?.kind === 'fit') {
    if (
      annotation.kind === 'angle' ||
      annotation.kind === 'chamfer' ||
      annotation.kind === 'ordinate'
    ) {
      issues.push({
        kind: 'refsDoNotFit',
        message: `An ISO 286 fit applies to a size, not to a${annotation.kind === 'angle' ? 'n' : ''} ${annotation.kind} dimension`,
      });
    }
  }

  switch (annotation.kind) {
    case 'datumFeature': {
      const own = annotation.standard ?? standard;
      const problem = datumLabelProblem(annotation.label);
      if (problem !== undefined && own !== undefined) {
        issues.push({ kind: 'illegalForStandard', standard: own, message: problem });
      }
      if (annotation.label !== '') {
        const clash = (part.annotations ?? []).some(
          (o) =>
            o.kind === 'datumFeature' && o.id !== annotation.id && o.label === annotation.label,
        );
        if (clash) issues.push({ kind: 'duplicateDatumLabel', label: annotation.label });
      }
      break;
    }
    case 'geometricTolerance':
      issues.push(...frameIssues(part, annotation, standard));
      break;
    case 'holeCallout': {
      const featureId = annotation.source.featureId;
      const clash = (part.annotations ?? []).some(
        (o) =>
          o.kind === 'holeCallout' && o.id !== annotation.id && o.source.featureId === featureId,
      );
      if (clash) issues.push({ kind: 'duplicateCallout', featureId });
      break;
    }
    default:
      break;
  }

  if (
    annotation.kind !== 'surfaceFinish' &&
    'standard' in annotation &&
    annotation.standard !== undefined &&
    standard !== undefined &&
    annotation.standard !== standard
  ) {
    issues.push({ kind: 'standardMismatch', annotation: annotation.standard, drawing: standard });
  }
  return issues;
}

function frameIssues(
  part: Part,
  a: GeometricToleranceAnnotation,
  drawing: GpsStandard | undefined,
): AnnotationIssue[] {
  const out: AnnotationIssue[] = [];
  const std = a.standard ?? drawing;
  if (std !== undefined) {
    const refusal = characteristicRefusal(std, a.characteristic);
    if (refusal !== undefined)
      out.push({ kind: 'illegalForStandard', standard: std, message: refusal });
    for (const m of a.zone.modifiers ?? []) {
      const why = MODIFIER_REFUSALS[std][m];
      if (why !== undefined) out.push({ kind: 'illegalForStandard', standard: std, message: why });
    }
  }
  const material =
    a.zone.material !== undefined || (a.datums ?? []).some((d) => d.material !== undefined);
  if (material && NO_MATERIAL_CONDITION.has(a.characteristic)) {
    out.push({
      kind: 'refsDoNotFit',
      message: `A ${a.characteristic} frame controls a surface; MMC and LMC apply to features of size`,
    });
  }
  const klass = CHARACTERISTIC_CLASS[a.characteristic];
  const datumCount = (a.datums ?? []).length;
  if (klass === 'form' && datumCount > 0) {
    out.push({
      kind: 'refsDoNotFit',
      message: `A ${a.characteristic} frame takes no datum reference`,
    });
  }
  if ((klass === 'orientation' || klass === 'runout') && datumCount === 0) {
    out.push({
      kind: 'refsDoNotFit',
      message: `A ${a.characteristic} frame needs a datum reference`,
    });
  }
  if (a.appliesTo !== undefined) {
    const target = (part.annotations ?? []).find((o) => o.id === a.appliesTo);
    const isDimension =
      target !== undefined &&
      target.kind !== 'datumFeature' &&
      target.kind !== 'geometricTolerance' &&
      target.kind !== 'note' &&
      target.kind !== 'surfaceFinish';
    if (!isDimension) {
      out.push({
        kind: 'refsDoNotFit',
        message: 'The dimension this frame applies to no longer exists',
      });
    }
  }
  const datumLabels = new Map(
    (part.annotations ?? []).flatMap((o) =>
      o.kind === 'datumFeature' ? [[o.id, o.label] as const] : [],
    ),
  );
  for (const comp of a.datums ?? []) {
    for (const d of comp.datums) {
      if ('label' in d) out.push({ kind: 'datumUnbound', label: d.label });
      else if (!datumLabels.has(d.datum)) out.push({ kind: 'datumUnbound', label: d.datum });
    }
  }
  return out;
}

/**
 * ISO 286 deviations (mm, signed) of a fit tolerance for a nominal size, when they can be
 * computed. Re-exported for the formatter: `undefined` means "show the symbol only".
 */
export function fitToleranceDeviations(
  fitClass: string,
  nominalMm: number,
): { upper: number; lower: number } | undefined {
  const r = fitDeviations(fitClass, nominalMm);
  return r.ok ? { upper: r.upper, lower: r.lower } : undefined;
}
