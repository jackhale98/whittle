// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Document-level evaluation helpers: the bridge between stored `Expr` strings and the numbers the
 * regen engine / sketch solver consume (millimetres and radians).
 */

import type {
  Annotation,
  EvalResult,
  EvalScope,
  ExprError,
  ExpressionEngine,
  Feature,
  Id,
  NamedDimension,
  SketchFeature,
  WrenDoc,
} from '@wren-cad/contracts';
import { annotationExprFields } from './annotation-fields';
import { type AnyResult, ExpressionEngineImpl, expressionEngine } from './expressions';
import { type ExprField, exprFields } from './features';
import { getAt } from './patch';

/** Evaluation scope of a document: its global parameters and default units. */
export function scopeOf(doc: Pick<WrenDoc, 'params' | 'units'>): EvalScope {
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const p of doc.params) if (!(p.name in params)) params[p.name] = p.expr;
  return { params, defaultLengthUnit: doc.units.length, defaultAngleUnit: doc.units.angle };
}

export interface FeatureValues {
  /** Resolved numbers (mm / rad) keyed by JSON pointer into the feature: `FeatureInputs.values`. */
  values: Record<string, number>;
  /** Failing fields keyed by the same pointers. */
  errors: Record<string, ExprError>;
}

type Evaluator = (expr: string, expected: NamedDimension) => EvalResult;

function evaluatorFor(engine: ExpressionEngine, scope: EvalScope): Evaluator {
  // The concrete engine can share parameter results across all fields of a feature.
  if (engine instanceof ExpressionEngineImpl) {
    const session = engine.bind(scope);
    return (e, d) => session.evaluate(e, d);
  }
  return (e, d) => engine.evaluate(e, d, scope);
}

/**
 * Evaluates every `Expr` field of `feature` (see the dimension table in `features.ts`).
 * Driven (reference) sketch dimensions are skipped: their value is measured by the solver.
 */
export function evaluateFeatureValues(
  feature: Feature,
  doc: Pick<WrenDoc, 'params' | 'units'>,
  engine: ExpressionEngine = expressionEngine,
): FeatureValues {
  const evaluate = evaluatorFor(engine, scopeOf(doc));
  const out: FeatureValues = { values: {}, errors: {} };
  for (const field of exprFields(feature)) {
    if (field.driven) continue;
    evaluateField(feature, field, evaluate, out);
  }
  return out;
}

/**
 * Evaluates every `Expr` field of a part annotation (`annotationExprFields`): nominal, tolerance
 * deviations, zone and surface-finish values. Results are mm / rad keyed by the pointer inside the
 * annotation. Pass the document with a configuration applied (`resolveConfiguration`) to evaluate
 * in that configuration.
 */
export function evaluateAnnotationValues(
  annotation: Annotation,
  doc: Pick<WrenDoc, 'params' | 'units'>,
  engine: ExpressionEngine = expressionEngine,
): FeatureValues {
  const evaluate = evaluatorFor(engine, scopeOf(doc));
  const out: FeatureValues = { values: {}, errors: {} };
  for (const field of annotationExprFields(annotation)) {
    evaluateField(annotation, field, evaluate, out);
  }
  return out;
}

function evaluateField(
  feature: Feature | Annotation,
  field: ExprField,
  evaluate: Evaluator,
  out: FeatureValues,
) {
  let raw: unknown;
  try {
    raw = getAt(feature, field.pointer);
  } catch {
    out.errors[field.pointer] = { message: 'Missing value' };
    return;
  }
  if (typeof raw !== 'string') {
    out.errors[field.pointer] = { message: 'Expected an expression' };
    return;
  }
  const r = evaluate(raw, field.expected);
  if (r.ok) out.values[field.pointer] = r.value;
  else out.errors[field.pointer] = r.error;
}

/**
 * Values for `SketchSolveInput.values`: driving dimension constraints keyed by constraint id
 * (mm / rad), taken from the pointer-keyed result of `evaluateFeatureValues`.
 */
export function sketchSolveValues(
  sketch: SketchFeature,
  evaluated: FeatureValues,
): { values: Record<Id, number>; errors: Record<Id, ExprError> } {
  const values: Record<Id, number> = {};
  const errors: Record<Id, ExprError> = {};
  sketch.constraints.forEach((c, i) => {
    if (!('value' in c) || !c.driving) return;
    const p = `/constraints/${i}/value`;
    const v = evaluated.values[p];
    if (v !== undefined) values[c.id] = v;
    const e = evaluated.errors[p];
    if (e) errors[c.id] = e;
  });
  return { values, errors };
}

/** Evaluates all global parameters (no expected dimension). Keyed by parameter name. */
export function evaluateParams(
  doc: Pick<WrenDoc, 'params' | 'units'>,
  engine: ExpressionEngineImpl = expressionEngine,
): Record<string, AnyResult> {
  const scope = scopeOf(doc);
  const session = engine.bind(scope);
  const out: Record<string, AnyResult> = {};
  for (const name of Object.keys(scope.params)) {
    out[name] = session.evaluateAny(scope.params[name] as string);
  }
  return out;
}
