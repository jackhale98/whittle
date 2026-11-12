// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Annotation,
  DatumFeatureAnnotation,
  GeometricToleranceAnnotation,
  HoleCalloutAnnotation,
  WrenDoc,
} from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_CONFIGURABLE_OPTIONS,
  ANNOTATION_KINDS,
  annotationExprFields,
  validateDoc,
} from '../src';
import {
  annotationIssues,
  annotationProblems,
  annotationRefsProblem,
  characteristicRefusal,
  datumLabelProblem,
  fitDeviations,
  GEOMETRIC_CHARACTERISTICS,
  itMicrometres,
  parseFitClass,
  rangeMean,
} from '../src/drawing';
import { id, ref, sampleAnnotations, sampleDoc } from './fixtures';

const at = (n: number): Annotation => sampleAnnotations().find((a) => a.id === id(n)) as Annotation;
const part = (doc: WrenDoc) => doc.parts[0] as WrenDoc['parts'][number];
const PROVISIONAL = 'provisional (secondary sources)';

describe('annotationExprFields', () => {
  it('lists the Expr fields of every kind with their dimension', () => {
    expect(annotationExprFields(at(900))).toEqual([
      { pointer: '/tolerance/upper', expected: 'length' },
      { pointer: '/tolerance/lower', expected: 'length' },
    ]);
    expect(annotationExprFields(at(901))).toEqual([
      { pointer: '/nominal', expected: 'angle' },
      { pointer: '/tolerance/value', expected: 'angle' },
    ]);
    expect(annotationExprFields(at(902)).map((f) => f.pointer)).toEqual(['/nominal']);
    expect(annotationExprFields(at(905)).map((f) => f.pointer)).toEqual(['/zone/value']);
    expect(annotationExprFields(at(907)).map((f) => f.pointer)).toEqual([
      '/requirements/0/value',
      '/allowance',
    ]);
    expect(annotationExprFields(at(903))).toEqual([]);
    expect(annotationExprFields(at(906))).toEqual([]);
  });

  it('lists zone extras only when present, and survives malformed input', () => {
    const frame = {
      ...(at(905) as GeometricToleranceAnnotation),
      zone: {
        value: '0.1mm',
        projected: '5mm',
        unequal: '0.02mm',
        perUnit: { value: '0.05mm', length: '100mm', width: '50mm' },
      },
    };
    expect(annotationExprFields(frame).map((f) => f.pointer)).toEqual([
      '/zone/value',
      '/zone/projected',
      '/zone/unequal',
      '/zone/perUnit/value',
      '/zone/perUnit/length',
      '/zone/perUnit/width',
    ]);
    expect(() =>
      annotationExprFields({ kind: 'surfaceFinish' } as unknown as Annotation),
    ).not.toThrow();
  });

  it('knows every kind', () => {
    expect(ANNOTATION_KINDS).toHaveLength(12);
    expect(ANNOTATION_KINDS).toContain('holeCallout');
  });

  it('exposes the fit classes as configurable options', () => {
    const [hole, shaft] = ANNOTATION_CONFIGURABLE_OPTIONS;
    expect(hole?.pointer).toBe('/tolerance/hole');
    expect(hole?.accepts('H8')).toBe(true);
    expect(hole?.accepts('h8')).toBe(false);
    expect(shaft?.accepts('g6')).toBe(true);
    expect(shaft?.accepts('G6')).toBe(false);
    expect(shaft?.accepts(5)).toBe(false);
  });
});

describe('structural validation', () => {
  it('accepts the fixture', () => {
    for (const a of sampleAnnotations()) expect(annotationProblems(a), a.id).toEqual([]);
  });

  const bad = (mutate: (a: Record<string, unknown>) => void, n = 900): string[] => {
    const a = structuredClone(at(n)) as unknown as Record<string, unknown>;
    mutate(a);
    return annotationProblems(a);
  };

  it('rejects broken dimensions', () => {
    expect(bad((a) => (a.nominal = '5mm')).join()).toMatch(/both a source and a nominal/);
    expect(bad((a) => (a.direction = [2, 0, 0])).join()).toMatch(/unit vector/);
    expect(bad((a) => (a.kind = 'teleport')).join()).toMatch(/kind must be one of/);
    expect(bad((a) => ((a.tolerance as Record<string, unknown>).upper = 5)).join()).toMatch(
      /tolerance\/upper must be an expression string/,
    );
    expect(bad((a) => (a.refs = [{ name: '', kind: 'face' }])).join()).toMatch(/entity reference/);
    expect(bad((a) => (a.at = ['self', 'self', 'self'])).join()).toMatch(/more entries than refs/);
    expect(
      bad((a) => (a.source = { kind: 'featureField', featureId: 'x', path: 'nope' })).join(),
    ).toMatch(/JSON pointer/);
  });

  it('an ordinate dimension needs a direction', () => {
    const o = {
      id: id(950),
      kind: 'ordinate',
      origin: { kind: 'model' },
      refs: [ref('a'), ref('b')],
    };
    expect(annotationProblems(o).join()).toMatch(/direction is required/);
    expect(annotationProblems({ ...o, direction: [0, 1, 0] })).toEqual([]);
  });

  it('checks fits, frames, surface finish and hole callouts', () => {
    expect(
      bad((a) => (a.tolerance = { kind: 'fit', hole: 'h7', show: 'symbol' }), 902).join(),
    ).toMatch(/hole must be an ISO 286 hole class/);
    expect(bad((a) => (a.tolerance = { kind: 'fit', show: 'symbol' }), 902).join()).toMatch(
      /needs a hole or a shaft/,
    );
    expect(bad((a) => (a.characteristic = 'wobble'), 905).join()).toMatch(/characteristic/);
    expect(bad((a) => (a.datums = [{}, {}, {}, {}]), 905).join()).toMatch(/more than three/);
    expect(bad((a) => (a.datums = [{ datums: [] }]), 905).join()).toMatch(/at least one datum/);
    expect(bad((a) => (a.datums = [{ datums: [{ x: 1 }] }]), 905).join()).toMatch(
      /\{ datum: id \} or \{ label \}/,
    );
    expect(bad((a) => (a.process = 'sometimes'), 907).join()).toMatch(/process/);
    const hole = {
      id: id(951),
      kind: 'holeCallout',
      origin: { kind: 'model' },
      refs: [],
      source: { kind: 'sketchDimension', featureId: 'x', constraintId: 'y' },
    };
    expect(annotationProblems(hole).join()).toMatch(/must be ‘feature’/);
  });

  it('validateDoc reports annotation problems with their path and id clashes', () => {
    const doc = structuredClone(sampleDoc()) as unknown as {
      parts: { annotations: Record<string, unknown>[] }[];
    };
    const list = (doc.parts[0] as { annotations: Record<string, unknown>[] }).annotations;
    (list[0] as Record<string, unknown>).nominal = '1mm';
    (list[1] as Record<string, unknown>).id = (list[2] as Record<string, unknown>).id;
    const errs = validateDoc(doc).join('\n');
    expect(errs).toMatch(/parts\[0\]\.annotations\[0\] has both a source and a nominal/);
    expect(errs).toMatch(/duplicate id/);
  });

  it('validateDoc checks configuration annotation overrides', () => {
    const doc = structuredClone(sampleDoc()) as unknown as {
      parts: { configurations?: unknown[] }[];
    };
    (doc.parts[0] as { configurations?: unknown[] }).configurations = [
      {
        id: id(700),
        name: 'X',
        annotations: { [id(900)]: { suppressed: 'yes', fields: { nope: 1 } } },
      },
    ];
    const errs = validateDoc(doc).join('\n');
    expect(errs).toMatch(/suppressed must be a boolean/);
    expect(errs).toMatch(/must be a JSON pointer/);
  });
});

describe('refs arity per kind', () => {
  it('fits the proposal table', () => {
    expect(annotationRefsProblem(at(900))).toBeUndefined();
    const two = { ...at(902), refs: [ref('a'), ref('b')] } as Annotation;
    expect(annotationRefsProblem(two)).toMatch(/needs one reference, not 2/);
    expect(annotationRefsProblem({ ...at(900), refs: [ref('a')] } as Annotation)).toMatch(
      /needs 2 references, not 1/,
    );
    expect(annotationRefsProblem({ ...at(906), refs: [] } as Annotation)).toMatch(/at least one/);
    // a frame bound by appliesTo may have no refs; without it, it may not
    expect(annotationRefsProblem(at(905))).toBeUndefined();
    const free = { ...(at(905) as GeometricToleranceAnnotation) };
    delete free.appliesTo;
    expect(annotationRefsProblem(free)).toMatch(/toleranced feature/);
    // a datum on a feature of size (appliesTo, ADR-094) may have no refs either; a plain one needs one
    const fos = { ...(at(903) as DatumFeatureAnnotation), refs: [], appliesTo: id(902) };
    expect(annotationRefsProblem(fos)).toBeUndefined();
    expect(
      annotationRefsProblem({ ...fos, appliesTo: undefined } as unknown as Annotation),
    ).toMatch(/a size dimension it applies to/);
    expect(
      annotationRefsProblem({ kind: 'holeCallout', refs: [] } as unknown as Annotation),
    ).toBeUndefined();
  });
});

describe(`GD&T legality per standard (${PROVISIONAL})`, () => {
  it('ASME Y14.5-2018 has no concentricity, symmetry or coaxiality', () => {
    expect(characteristicRefusal('ASME Y14.5-2018', 'concentricity')).toBe(
      'ASME Y14.5-2018 has no concentricity; use position or profile',
    );
    expect(characteristicRefusal('ASME Y14.5-2018', 'symmetry')).toMatch(/no symmetry/);
    expect(characteristicRefusal('ASME Y14.5-2018', 'coaxiality')).toMatch(/ISO term/);
  });

  it('ISO 1101 has all fifteen; ASME 2009 keeps concentricity and symmetry', () => {
    for (const c of GEOMETRIC_CHARACTERISTICS) {
      expect(characteristicRefusal('ISO 1101:2017', c), c).toBeUndefined();
    }
    expect(GEOMETRIC_CHARACTERISTICS).toHaveLength(15);
    expect(characteristicRefusal('ASME Y14.5-2009', 'concentricity')).toBeUndefined();
    expect(characteristicRefusal('ASME Y14.5-2009', 'symmetry')).toBeUndefined();
    expect(characteristicRefusal('ASME Y14.5-2009', 'coaxiality')).toBeDefined();
  });

  const frame = (over: Partial<GeometricToleranceAnnotation>): GeometricToleranceAnnotation => ({
    ...(at(905) as GeometricToleranceAnnotation),
    ...over,
  });

  it('annotationIssues refuses and explains; it never converts', () => {
    const doc = sampleDoc();
    const f = frame({ characteristic: 'concentricity', standard: undefined });
    delete f.standard;
    const issues = annotationIssues(doc, part(doc).id, f, 'ASME Y14.5-2018');
    expect(issues).toContainEqual({
      kind: 'illegalForStandard',
      standard: 'ASME Y14.5-2018',
      message: 'ASME Y14.5-2018 has no concentricity; use position or profile',
    });
    expect(f.characteristic).toBe('concentricity');
    // no standard stated anywhere: nothing to check against
    expect(
      annotationIssues(doc, part(doc).id, f).filter((i) => i.kind === 'illegalForStandard'),
    ).toEqual([]);
    // the annotation's own standard wins for legality
    const own = frame({ characteristic: 'symmetry', standard: 'ASME Y14.5-2018' });
    expect(annotationIssues(doc, part(doc).id, own, 'ISO 1101:2017').map((i) => i.kind)).toEqual(
      expect.arrayContaining(['illegalForStandard', 'standardMismatch']),
    );
  });

  it('flags ISO-only modifiers on ASME, material conditions on surfaces, and datum counts', () => {
    const doc = sampleDoc();
    const iso = frame({
      zone: { value: '0.1mm', modifiers: ['combinedZone'] },
      standard: undefined,
    });
    const issues = annotationIssues(doc, part(doc).id, iso, 'ASME Y14.5-2018');
    expect(issues.some((i) => i.kind === 'illegalForStandard' && /CZ/.test(i.message))).toBe(true);
    const flat = frame({
      characteristic: 'flatness',
      zone: { value: '0.1mm', material: 'mmc' },
      datums: [],
    });
    expect(
      annotationIssues(doc, part(doc).id, flat).some(
        (i) => i.kind === 'refsDoNotFit' && /MMC/.test(i.message),
      ),
    ).toBe(true);
    const formWithDatum = frame({ characteristic: 'flatness', zone: { value: '0.1mm' } });
    expect(
      annotationIssues(doc, part(doc).id, formWithDatum).some((i) =>
        /takes no datum/.test((i as { message?: string }).message ?? ''),
      ),
    ).toBe(true);
    const orientation = frame({ characteristic: 'perpendicularity', datums: [] });
    expect(
      annotationIssues(doc, part(doc).id, orientation).some((i) =>
        /needs a datum/.test((i as { message?: string }).message ?? ''),
      ),
    ).toBe(true);
  });

  it('reports unbound datum labels and datums that are gone', () => {
    const doc = sampleDoc();
    const f = frame({ datums: [{ datums: [{ label: 'C' }] }, { datums: [{ datum: id(999) }] }] });
    const issues = annotationIssues(doc, part(doc).id, f);
    expect(issues).toContainEqual({ kind: 'datumUnbound', label: 'C' });
    expect(issues).toContainEqual({ kind: 'datumUnbound', label: id(999) });
    expect(annotationIssues(doc, part(doc).id, at(905))).toEqual([]);
  });

  it('reports a dimension the frame applies to that is gone', () => {
    const doc = sampleDoc();
    const f = frame({ appliesTo: id(999) });
    expect(
      annotationIssues(doc, part(doc).id, f).some((i) =>
        /no longer exists/.test((i as { message?: string }).message ?? ''),
      ),
    ).toBe(true);
  });
});

describe('a datum on a feature of size (appliesTo, ADR-094)', () => {
  const datum = (appliesTo: string): DatumFeatureAnnotation => ({
    ...(at(903) as DatumFeatureAnnotation),
    id: id(950),
    label: 'D',
    refs: [],
    appliesTo,
  });
  const messages = (a: Annotation) => {
    const doc = sampleDoc();
    return annotationIssues(doc, part(doc).id, a).map((i) => (i as { message?: string }).message);
  };
  it('a diameter is a size: no issue; the document validates', () => {
    expect(messages(datum(id(902)))).toEqual([]);
    const doc = sampleDoc();
    part(doc).annotations = [...(part(doc).annotations ?? []), datum(id(902))].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    );
    expect(validateDoc(doc)).toEqual([]);
  });
  it('a missing dimension needs attention; an angle is not a feature of size', () => {
    expect(messages(datum(id(999)))).toContainEqual(
      'The dimension this datum applies to no longer exists',
    );
    expect(messages(datum(id(901))).join(' ')).toMatch(/feature of size.*not an angle dimension/);
    // A linear dimension between two faces is a width: a size.
    expect(messages(datum(id(900)))).toEqual([]);
  });
  it('an empty appliesTo is malformed', () => {
    const doc = sampleDoc();
    part(doc).annotations = [...(part(doc).annotations ?? []), datum('')].sort((x, y) =>
      x.id < y.id ? -1 : 1,
    );
    expect(validateDoc(doc).join(' ')).toMatch(/appliesTo/);
  });
});

describe(`datum letters (${PROVISIONAL})`, () => {
  it('rejects I, O and Q, empty and over-long labels', () => {
    for (const l of ['I', 'O', 'Q', 'AI', 'BOB'])
      expect(datumLabelProblem(l), l).toMatch(/never use/);
    expect(datumLabelProblem('')).toMatch(/missing/);
    expect(datumLabelProblem('a')).toMatch(/capital/);
    expect(datumLabelProblem('ABCD')).toMatch(/too long/);
    for (const l of ['A', 'B', 'H', 'J', 'N', 'P', 'Z', 'AA', 'XYZ']) {
      expect(datumLabelProblem(l), l).toBeUndefined();
    }
  });

  it('is checked on datum features, and letters are unique per part', () => {
    const doc = structuredClone(sampleDoc());
    const p = part(doc);
    const a = at(903);
    const bad = { ...a, label: 'O' } as Annotation;
    expect(annotationIssues(doc, p.id, bad, 'ISO 1101:2017')).toContainEqual(
      expect.objectContaining({ kind: 'illegalForStandard' }),
    );
    const twin = { ...(at(904) as Annotation), label: 'A' } as Annotation;
    p.annotations = (p.annotations ?? []).map((x) => (x.id === twin.id ? twin : x));
    expect(annotationIssues(doc, p.id, a)).toContainEqual({
      kind: 'duplicateDatumLabel',
      label: 'A',
    });
    expect(annotationIssues(doc, p.id, twin)).toContainEqual({
      kind: 'duplicateDatumLabel',
      label: 'A',
    });
    expect(annotationIssues(sampleDoc(), p.id, a)).toEqual([]);
  });
});

describe('hole callouts and sources', () => {
  const callout = (n: number, featureId: string): HoleCalloutAnnotation => ({
    id: id(n),
    kind: 'holeCallout',
    origin: { kind: 'model' },
    refs: [],
    source: { kind: 'feature', featureId },
  });

  it('flags a second callout for the same feature in both', () => {
    const doc = structuredClone(sampleDoc());
    const p = part(doc);
    const a = callout(960, id(12));
    const b = callout(961, id(12));
    p.annotations = [...(p.annotations ?? []), a, b];
    expect(annotationIssues(doc, p.id, a)).toContainEqual({
      kind: 'duplicateCallout',
      featureId: id(12),
    });
    expect(annotationIssues(doc, p.id, b)).toContainEqual({
      kind: 'duplicateCallout',
      featureId: id(12),
    });
    expect(annotationIssues(sampleDoc(), p.id, a)).toEqual([]);
  });

  it('reports a source that is gone, never a stale value', () => {
    const doc = sampleDoc();
    const p = part(doc);
    const gone = {
      ...(at(900) as Annotation),
      source: { kind: 'featureField', featureId: id(12), path: '/nope' },
    } as Annotation;
    expect(annotationIssues(doc, p.id, gone)).toContainEqual({
      kind: 'sourceGone',
      source: (gone as { source: unknown }).source,
    });
    const noFeature = callout(962, id(998));
    expect(annotationIssues(doc, p.id, noFeature)).toContainEqual({
      kind: 'sourceGone',
      source: noFeature.source,
    });
    expect(annotationIssues(doc, p.id, at(900))).toEqual([]);
  });

  it('a linear dimension between two points asks for a direction', () => {
    const doc = sampleDoc();
    const pts = {
      ...(at(900) as Annotation),
      source: undefined,
      refs: [ref('a', 'vertex'), ref('b', 'vertex')],
    } as Annotation;
    delete (pts as { source?: unknown }).source;
    delete (pts as { direction?: unknown }).direction;
    expect(annotationIssues(doc, part(doc).id, pts)).toContainEqual({ kind: 'directionMissing' });
  });

  it('min and max points need a linear or ordinate dimension with a direction (M4.1)', () => {
    const doc = sampleDoc();
    const base = at(900) as Annotation;
    const across = {
      ...base,
      refs: [ref('c', 'edge'), ref('c', 'edge')],
      at: ['min', 'max'],
    } as Annotation;
    const fits = (a: Annotation) =>
      annotationIssues(doc, part(doc).id, a).some((i) => i.kind === 'refsDoNotFit');
    if ((across as { direction?: unknown }).direction === undefined)
      (across as { direction?: unknown }).direction = [1, 0, 0];
    expect(fits(across)).toBe(false);
    const noDirection = { ...across } as Annotation;
    delete (noDirection as { direction?: unknown }).direction;
    expect(fits(noDirection)).toBe(true);
    expect(fits({ ...(at(901) as Annotation), at: ['min', 'self'] } as Annotation)).toBe(true);
  });

  it('a fit on an angle is refused with an explanation', () => {
    const doc = sampleDoc();
    const a = {
      ...(at(901) as Annotation),
      tolerance: { kind: 'fit', hole: 'H7', show: 'symbol' },
    } as Annotation;
    expect(annotationIssues(doc, part(doc).id, a).some((i) => i.kind === 'refsDoNotFit')).toBe(
      true,
    );
  });
});

describe(`ISO 286 fits (${PROVISIONAL}; formulas, not copied tables)`, () => {
  const um = (c: string, d: number) => {
    const r = fitDeviations(c, d);
    if (!r.ok) throw new Error(r.reason);
    return [Math.round(r.upper * 1000), Math.round(r.lower * 1000)];
  };

  it('parses classes by pattern', () => {
    expect(parseFitClass('H7')).toEqual({ side: 'hole', letter: 'h', grade: 7 });
    expect(parseFitClass('g6')).toEqual({ side: 'shaft', letter: 'g', grade: 6 });
    expect(parseFitClass('JS12')).toEqual({ side: 'hole', letter: 'js', grade: 12 });
    expect(parseFitClass('H01')).toEqual({ side: 'hole', letter: 'h', grade: 0 });
    for (const bad of ['H0', 'H19', 'h', '7', 'H 7', 'Hg7', 'QQ7', 'h07', '']) {
      expect(parseFitClass(bad), bad).toBeUndefined();
    }
  });

  it('size ranges use the geometric mean of the step limits', () => {
    expect(rangeMean(20)).toBeCloseTo(Math.sqrt(18 * 30), 12);
    expect(rangeMean(30)).toBeCloseTo(Math.sqrt(18 * 30), 12);
    expect(rangeMean(30.01)).toBeCloseTo(Math.sqrt(30 * 50), 12);
    expect(rangeMean(1)).toBeCloseTo(Math.sqrt(3), 12);
    expect(rangeMean(0)).toBeUndefined();
    expect(rangeMean(501)).toBeUndefined();
  });

  it('IT grades follow the i = 0.45 cbrt(D) + 0.001 D multipliers', () => {
    const D = rangeMean(20) as number;
    expect([5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((g) => itMicrometres(g, D))).toEqual([
      9, 13, 21, 33, 52, 84, 130, 210, 330, 520,
    ]);
    expect(itMicrometres(0, D)).toBeLessThan(itMicrometres(1, D));
    expect(itMicrometres(2, D)).toBeLessThan(itMicrometres(3, D));
    expect(itMicrometres(4, D)).toBeLessThan(itMicrometres(5, D));
  });

  it('matches published values for Ø20 holes and shafts', () => {
    expect(um('H7', 20)).toEqual([21, 0]);
    expect(um('H8', 20)).toEqual([33, 0]);
    expect(um('H9', 20)).toEqual([52, 0]);
    expect(um('H11', 20)).toEqual([130, 0]);
    expect(um('G7', 20)).toEqual([28, 7]);
    expect(um('F8', 20)).toEqual([53, 20]);
    expect(um('E9', 20)).toEqual([92, 40]);
    expect(um('K7', 20)).toEqual([6, -15]);
    expect(um('M7', 20)).toEqual([0, -21]);
    expect(um('N7', 20)).toEqual([-7, -28]);
    expect(um('g6', 20)).toEqual([-7, -20]);
    expect(um('f7', 20)).toEqual([-20, -41]);
    expect(um('e8', 20)).toEqual([-40, -73]);
    expect(um('h6', 20)).toEqual([0, -13]);
    expect(um('h9', 20)).toEqual([0, -52]);
    expect(um('k6', 20)).toEqual([15, 2]);
    expect(um('m6', 20)).toEqual([21, 8]);
    expect(um('n6', 20)).toEqual([28, 15]);
    expect(um('a11', 20)).toEqual([-300, -430]);
  });

  it('matches published values for H7 at other sizes', () => {
    expect(um('H7', 50)).toEqual([25, 0]);
    expect(um('H7', 100)).toEqual([35, 0]);
    expect(um('H7', 4)).toEqual([12, 0]);
  });

  it('known provisional differences stay within one rounding step of the printed table', () => {
    // Printed ISO 286-2: Ø20 d9 = −65/−117 and Ø10 H7 = +15/0. The formulas give −64/−116 and +14/0.
    expect(um('d9', 20)).toEqual([-64, -116]);
    expect(um('H7', 10)).toEqual([14, 0]);
  });

  it('JS is symmetric', () => {
    const r = fitDeviations('JS7', 20);
    expect(r.ok && r.upper).toBeCloseTo(-(r.ok ? r.lower : 0), 12);
  });

  it('is explicit about what it cannot compute', () => {
    for (const c of ['p6', 'r6', 'j6', 'c11', 's6']) {
      const r = fitDeviations(c, 20);
      expect(r.ok, c).toBe(false);
    }
    expect(fitDeviations('s6', 80).ok).toBe(true);
    expect(fitDeviations('H7', 600)).toMatchObject({ ok: false });
    expect(fitDeviations('hello', 20)).toMatchObject({ ok: false });
  });

  it('every successful result is flagged provisional and has upper above lower', () => {
    for (const c of ['H7', 'g6', 'K7', 'za8', 'u6', 'JS9', 'D10']) {
      const r = fitDeviations(c, 60);
      if (r.ok) {
        expect(r.provisional).toBe(true);
        expect(r.upper).toBeGreaterThan(r.lower);
      }
    }
  });
});
