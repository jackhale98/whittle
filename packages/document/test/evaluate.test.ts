// SPDX-License-Identifier: GPL-3.0-or-later
import type { Annotation, Feature, SketchFeature } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ExpressionEngineImpl,
  entityRefs,
  evaluateAnnotationValues,
  evaluateFeatureValues,
  evaluateParams,
  expressionEngine,
  exprFields,
  FEATURE_TYPES,
  nameTouchesFeature,
  scopeOf,
  sketchSolveValues,
} from '../src';
import {
  booleanCut,
  box,
  chamferAngle,
  chamferDist,
  cylinder,
  extrude,
  fillet,
  id,
  planeFrame,
  planeOffset,
  pushPull,
  revolve,
  sampleDoc,
  sketch,
  sphere,
} from './fixtures';

const doc = sampleDoc(); // width = 40mm, depth = width/2 + 0.25in = 26.35 mm
const IN = 25.4;
const DEG = Math.PI / 180;

const run = (f: Feature) => evaluateFeatureValues(f, doc, expressionEngine);

describe('evaluateFeatureValues', () => {
  it('primitive box / cylinder / sphere', () => {
    expect(run(box(1))).toEqual({ values: { '/dx': 40, '/dy': 30, '/dz': 20 }, errors: {} });
    const c = run(cylinder(2));
    expect(c.values['/radius']).toBe(5);
    expect(c.values['/height']).toBeCloseTo(IN, 10);
    expect(run(sphere(3)).values['/radius']).toBeCloseTo((40 / 2 + 0.25 * IN) / 4, 10);
  });

  it('sketch: driving dimensions only, with the right dimension per kind', () => {
    const r = run(sketch(11));
    expect(r.errors).toEqual({});
    expect(Object.keys(r.values).sort()).toEqual([
      '/constraints/1/value',
      '/constraints/2/value',
      '/constraints/4/value',
      '/constraints/5/value',
    ]);
    expect(r.values['/constraints/1/value']).toBe(40);
    expect(r.values['/constraints/2/value']).toBe(30);
    expect(r.values['/constraints/4/value']).toBe(10); // bare number = mm
    expect(r.values['/constraints/5/value']).toBeCloseTo(Math.PI / 2, 12);
  });

  it('sketchSolveValues re-keys by constraint id', () => {
    const sk = sketch(11);
    const { values, errors } = sketchSolveValues(sk, run(sk));
    expect(errors).toEqual({});
    expect(values[id(1121)]).toBe(40);
    expect(values[id(1125)]).toBeCloseTo(Math.PI / 2, 12);
    expect(values[id(1123)]).toBeUndefined(); // driven
  });

  it('sketch dimension errors are keyed by pointer and constraint id', () => {
    const sk: SketchFeature = sketch(11);
    const c = sk.constraints[1];
    if (!c || !('value' in c)) throw new Error('fixture');
    c.value = 'widht';
    const r = run(sk);
    expect(r.errors['/constraints/1/value']?.message).toMatch(/did you mean ‘width’/);
    expect(sketchSolveValues(sk, r).errors[id(1121)]).toBeDefined();
  });

  it('extrude: blind depth (length) and draft (angle); upTo / throughAll need none', () => {
    const e = run(extrude(12, 11));
    expect(e.values['/end/depth']).toBeCloseTo(40 / 2 + 0.25 * IN, 10);
    expect(e.values['/draft']).toBeCloseTo(2 * DEG, 12);
    const up = run(
      extrude(12, 11, {
        end: { kind: 'upTo', target: { name: 'origin:XY', kind: 'face' } },
        draft: undefined,
      }),
    );
    expect(up.values).toEqual({});
    expect(run(extrude(12, 11, { end: { kind: 'throughAll' } })).values['/draft']).toBeDefined();
  });

  it('revolve: angle', () => {
    expect(run(revolve(24, 23)).values['/angle']).toBeCloseTo(Math.PI, 12);
  });

  it('fillet: radius with mixed units', () => {
    expect(run(fillet(14, 12)).values['/radius']).toBeCloseTo(2 + IN / 16, 10);
  });

  it('chamfer: distance, and distance + angle', () => {
    expect(run(chamferDist(15, 12))).toEqual({ values: { '/mode/distance': 1 }, errors: {} });
    const r = run(chamferAngle(16, 12));
    expect(r.values['/mode/distance']).toBe(1);
    expect(r.values['/mode/angle']).toBeCloseTo(45 * DEG, 12);
  });

  it('boolean has no expressions; push/pull distance; plane offset / frame', () => {
    expect(run(booleanCut(19, 12, 13))).toEqual({ values: {}, errors: {} });
    expect(run(pushPull(20, 12)).values['/distance']).toBe(-2);
    expect(run(planeOffset(21)).values['/definition/distance']).toBeCloseTo(
      (40 / 2 + 0.25 * IN) / 2,
      10,
    );
    expect(run(planeFrame(22))).toEqual({ values: {}, errors: {} });
  });

  it('annotation expression fields: nominal, tolerance, zone, surface finish', () => {
    const d = sampleDoc();
    const anns = d.parts[0]?.annotations ?? [];
    const at = (n: number) => anns.find((a) => a.id === id(n)) as Annotation;
    const lin = evaluateAnnotationValues(at(900), d);
    expect(lin.errors).toEqual({});
    expect(lin.values).toEqual({
      '/tolerance/upper': expect.closeTo(0.1, 12),
      '/tolerance/lower': expect.closeTo(-0.1, 12),
    });
    const ang = evaluateAnnotationValues(at(901), d);
    expect(ang.values['/nominal']).toBeCloseTo(30 * DEG, 12);
    expect(ang.values['/tolerance/value']).toBeCloseTo(DEG, 12);
    expect(evaluateAnnotationValues(at(902), d).values['/nominal']).toBe(10);
    expect(evaluateAnnotationValues(at(905), d).values['/zone/value']).toBeCloseTo(0.1, 12);
    const sf = evaluateAnnotationValues(at(907), d);
    expect(sf.values['/requirements/0/value']).toBeCloseTo(0.0016, 12);
    expect(sf.values['/allowance']).toBeCloseTo(0.2, 12);
    // a length where an angle is expected is an error, like for features
    const bad = { ...(at(901) as object), nominal: '5mm' } as Annotation;
    expect(Object.keys(evaluateAnnotationValues(bad, d).errors)).toEqual(['/nominal']);
  });

  it('covers every feature type in the document fixture', () => {
    const part = doc.parts[0];
    const types = new Set(part?.features.map((f) => f.type));
    for (const t of FEATURE_TYPES) expect(types.has(t), t).toBe(true);
    for (const f of part?.features ?? []) {
      const r = run(f);
      expect(r.errors, f.name).toEqual({});
      for (const field of exprFields(f)) {
        if (field.driven) continue;
        expect(r.values[field.pointer], `${f.name}${field.pointer}`).toBeTypeOf('number');
      }
    }
  });

  it('reports dimension errors per field without losing the good ones', () => {
    const f = box(1, { dx: '30deg', dy: '5 +', dz: '7mm' });
    const r = run(f);
    expect(r.values).toEqual({ '/dz': 7 });
    expect(r.errors['/dx']?.message).toBe('Expected a length, but this is an angle');
    expect(r.errors['/dy']?.message).toMatch(/ends early/);
    expect(run(box(1, { dx: '' })).errors['/dx']?.message).toBe('Empty expression');
  });

  it('is robust to malformed features', () => {
    const bad = { ...box(1), dx: 5 as unknown as string };
    expect(run(bad).errors['/dx']?.message).toBe('Expected an expression');
  });

  it('works with any ExpressionEngine implementation (contract only)', () => {
    const wrapped = {
      evaluateAny: (...a: Parameters<ExpressionEngineImpl['evaluateAny']>) =>
        expressionEngine.evaluateAny(...a),
      evaluate: (...a: Parameters<ExpressionEngineImpl['evaluate']>) =>
        expressionEngine.evaluate(...a),
      format: (...a: Parameters<ExpressionEngineImpl['format']>) => expressionEngine.format(...a),
    };
    expect(evaluateFeatureValues(box(1), doc, wrapped).values['/dx']).toBe(40);
  });

  it('honours document default units for bare numbers', () => {
    const inch = { ...doc, units: { length: 'in', angle: 'rad' } as const };
    const r = evaluateFeatureValues(box(1, { dx: '2', dy: '1/2', dz: '1mm' }), inch);
    expect(r.values['/dx']).toBeCloseTo(2 * IN, 10);
    expect(r.values['/dy']).toBeCloseTo(0.5 * IN, 10);
    expect(r.values['/dz']).toBe(1);
    expect(evaluateFeatureValues(revolve(1, 2), { ...inch }).values['/angle']).toBeCloseTo(
      Math.PI,
      12,
    );
    const bare = revolve(1, 2);
    bare.angle = '2';
    expect(evaluateFeatureValues(bare, inch).values['/angle']).toBe(2);
  });
});

describe('introspection', () => {
  it('lists refs for every feature type (including PMI refs and scopes)', () => {
    const part = doc.parts[0];
    for (const f of part?.features ?? []) {
      const refs = entityRefs(f);
      const frame = f.type === 'plane' && f.definition.kind === 'frame';
      if (!frame && f.type !== 'primitive' && f.type !== 'import') {
        expect(refs.length, f.name).toBeGreaterThan(0);
      }
    }
    const scoped = extrude(5, 4, {
      scope: { kind: 'bodies', bodies: [{ name: 'Babc', kind: 'body' }] },
    });
    expect(entityRefs(scoped).map((r) => r.name)).toContain('Babc');
    expect(entityRefs(box(1))).toEqual([]);
  });

  it('nameTouchesFeature matches F/S/B tags precisely', () => {
    expect(nameTouchesFeature('F123:side(S9:e1)', '123')).toBe(true);
    expect(nameTouchesFeature('F123:side(S9:e1)', '9')).toBe(true);
    expect(nameTouchesFeature('F123:side(S9:e1)', '12')).toBe(false);
    expect(nameTouchesFeature('B123', '123')).toBe(true);
    expect(nameTouchesFeature('B1234', '123')).toBe(false);
    expect(nameTouchesFeature('origin:XY', 'XY')).toBe(false);
  });
});

describe('evaluateParams / scopeOf', () => {
  it('evaluates all parameters, reporting errors per name', () => {
    const d = {
      ...doc,
      params: [
        ...doc.params,
        { id: id(60), name: 'bad', expr: 'wdth' },
        { id: id(61), name: 'loop', expr: 'loop' },
      ],
    };
    const r = evaluateParams(d);
    expect(r.width).toMatchObject({ ok: true, value: 40 });
    expect(r.depth).toMatchObject({ ok: true, dependsOn: ['width'] });
    expect(r.bad?.ok).toBe(false);
    expect(r.loop?.ok === false && r.loop.error.cycle).toEqual(['loop']);
  });

  it('scopeOf takes the first of duplicate names and carries default units', () => {
    const s = scopeOf({
      params: [
        { id: '1', name: 'a', expr: '1' },
        { id: '2', name: 'a', expr: '2' },
      ],
      units: { length: 'in', angle: 'rad' },
    });
    expect(s.params.a).toBe('1');
    expect(s.defaultLengthUnit).toBe('in');
    expect(s.defaultAngleUnit).toBe('rad');
  });
});
