/**
 * Expressions & units (PLAN §1 "Obvious", §6). Lead-owned. Implemented by packages/document
 * (pure TS, no `eval`, worker-safe so the regen engine can evaluate inside the kernel worker).
 *
 * Grammar (informal): numbers with optional units (`25mm`, `1/8in`, `30deg`, `2.7 g/cm^3`),
 * + - * / ^, parentheses, unary minus, parameter names, and functions
 * sin cos tan asin acos atan atan2 sqrt abs min max round floor ceil pi.
 * A bare number takes the document's default unit for the expected dimension.
 *
 * Canonical internal units: length mm, angle rad, mass kg (so density is kg/mm³).
 */

import type { Expr } from './document';

/** Exponents of the base dimensions [length, mass, angle]. */
export type DimensionVector = readonly [length: number, mass: number, angle: number];

export type NamedDimension = 'scalar' | 'length' | 'angle' | 'area' | 'volume' | 'mass' | 'density';

export const DIMENSIONS: Record<NamedDimension, DimensionVector> = {
  scalar: [0, 0, 0],
  length: [1, 0, 0],
  angle: [0, 0, 1],
  area: [2, 0, 0],
  volume: [3, 0, 0],
  mass: [0, 1, 0],
  density: [-3, 1, 0],
};

export interface ExprError {
  message: string;
  /** Character range in the expression, for inline highlighting. */
  span?: [number, number];
  /** Parameter names involved in a cycle, when the error is a dependency cycle. */
  cycle?: string[];
}

export type EvalResult =
  | { ok: true; value: number; dimension: DimensionVector; dependsOn: string[] }
  | { ok: false; error: ExprError };

export interface EvalScope {
  /** Parameter name → expression (global params; feature-local scopes later). */
  params: Record<string, Expr>;
  /** Defaults for bare numbers. */
  defaultLengthUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  defaultAngleUnit: 'deg' | 'rad';
}

export interface ExpressionEngine {
  /** Evaluates and checks the result against `expected` (e.g. a fillet radius must be a length). */
  evaluate(expr: Expr, expected: NamedDimension, scope: EvalScope): EvalResult;
  /** Formats a canonical value for display in `unit` with sensible precision. */
  format(value: number, expected: NamedDimension, unit?: string): string;
}
