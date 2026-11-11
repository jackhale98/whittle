/**
 * Dimension value and tolerance text (ISO 129-1 / ASME Y14.5 forms; provisional, secondary
 * sources, owner D9): `±0.1`, stacked `+0.1/-0.05`, limits, basic (boxed), reference
 * (parenthesised) and ISO 286 fits. Fit deviations come from an injected lookup: the ISO 286-2
 * data lives in packages/document. Pure and worker-safe.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DimensionText, Expr, Tolerance } from '@wren-cad/contracts';
import { formatAngle, formatLength, type NumberStyle } from './numbers';
import type { SymbolId } from './symbols';

/** A deviation pair from ISO 286-2 (mm): ES/EI for holes, es/ei for shafts. */
export interface FitDeviation {
  upper: number;
  lower: number;
}

/**
 * Looks up the deviations of a tolerance class (`H7`, `g6`) for a nominal size (mm). Returns
 * undefined when the class or size is outside the table; the text then shows the symbol only and
 * reports `fitDeviationsUnknown`.
 */
export type FitDeviationLookup = (fitClass: string, nominal: number) => FitDeviation | undefined;

const HOLE_CLASS = /^[A-Z]{1,2}(01|[1-9]|1[0-8])$/;
const SHAFT_CLASS = /^[a-z]{1,2}(01|[1-9]|1[0-8])$/;

export function isHoleClass(s: string): boolean {
  return HOLE_CLASS.test(s);
}
export function isShaftClass(s: string): boolean {
  return SHAFT_CLASS.test(s);
}

/** A tolerance with its `Expr`s evaluated (lengths mm, angles rad). */
export type ToleranceValue =
  | { kind: 'symmetric'; value: number }
  | { kind: 'bilateral'; upper: number; lower: number }
  | { kind: 'limits'; upper: number; lower: number }
  | { kind: 'basic' }
  | { kind: 'reference' }
  | Extract<Tolerance, { kind: 'fit' }>;

/** Evaluates a tolerance's expressions; `null` when one of them fails (the field shows why). */
export function evaluateTolerance(
  tol: Tolerance,
  evaluate: (expr: Expr) => number | undefined,
): ToleranceValue | null {
  switch (tol.kind) {
    case 'symmetric': {
      const value = evaluate(tol.value);
      return value === undefined ? null : { kind: 'symmetric', value };
    }
    case 'bilateral':
    case 'limits': {
      const upper = evaluate(tol.upper);
      const lower = evaluate(tol.lower);
      return upper === undefined || lower === undefined ? null : { kind: tol.kind, upper, lower };
    }
    default:
      return tol;
  }
}

/** A piece of a text line: text in the drawing font, or a vector symbol (never a font glyph). */
export type TextRun = { kind: 'text'; text: string } | { kind: 'symbol'; id: SymbolId };

export type ToleranceBlock =
  /** Same line, same height: `±0.1`, `H7`, `H7/g6`. */
  | { kind: 'inline'; text: string }
  /**
   * Two lines, smaller (`TOLERANCE_TEXT_SCALE`): deviations or limits. `parens` wraps the stack
   * (fit deviations after the symbol); `before` / `after` sit on the main line (`H7 (…)`, `(H7)`).
   */
  | {
      kind: 'stack';
      upper: string;
      lower: string;
      parens?: boolean;
      before?: string;
      after?: string;
    };

/** Everything a dimension label shows, before layout. */
export interface DimensionLabel {
  /** Prefix (`4×`), the size symbol (Ø, R, SØ, SR), and the value. Limits replace the value. */
  main: TextRun[];
  tolerance?: ToleranceBlock;
  /** `box`: basic (theoretically exact); `parens`: reference. */
  frame?: 'box' | 'parens';
  suffix?: string;
  /** Lines under the value (`TYP`). */
  below?: string[];
  /** Non-fatal formatting problems (e.g. `fitDeviationsUnknown`). */
  warnings: string[];
}

/** Stacked tolerance text height relative to the dimension text (provisional, ISO 129-1). */
export const TOLERANCE_TEXT_SCALE = 0.7;

export type SizeSymbol = 'diameter' | 'radius' | 'sphericalDiameter' | 'sphericalRadius';

export interface DimensionLabelInput {
  /** Value to show (mm or rad). Absent = needs attention: the label shows `?` (trap T1). */
  value?: number;
  quantity: 'length' | 'angle';
  size?: SizeSymbol;
  tolerance?: ToleranceValue;
  text?: DimensionText;
  numbers: NumberStyle;
  fitDeviations?: FitDeviationLookup;
  /**
   * Resolved instance count (`AnnotationResolution.count`) for `text.count`: `N×` before the value
   * when it is more than 1. Absent with `text.count` set: no prefix (never a guessed count).
   */
  count?: number;
}

const SIZE_RUNS: Record<SizeSymbol, TextRun[]> = {
  diameter: [{ kind: 'text', text: 'Ø' }],
  radius: [{ kind: 'text', text: 'R' }],
  sphericalDiameter: [{ kind: 'text', text: 'SØ' }],
  sphericalRadius: [{ kind: 'text', text: 'SR' }],
};

/** Formats a dimension's value, symbol, tolerance and text into a label model. */
export function dimensionLabel(input: DimensionLabelInput): DimensionLabel {
  const { numbers, quantity, value } = input;
  const precision = input.text?.precision;
  const fmt = (x: number, sign = false) =>
    quantity === 'angle'
      ? formatAngle(x, numbers, { precision, sign })
      : formatLength(x, numbers, { precision, sign });
  const main: TextRun[] = [];
  if (input.text?.count && input.count !== undefined && input.count > 1)
    main.push({ kind: 'text', text: `${input.count}× ` });
  if (input.text?.prefix) main.push({ kind: 'text', text: input.text.prefix });
  if (input.size) main.push(...SIZE_RUNS[input.size]);
  const warnings: string[] = [];
  const label: DimensionLabel = { main, warnings };
  if (input.text?.suffix) label.suffix = input.text.suffix;
  if (input.text?.below) label.below = input.text.below.split('\n');

  if (value === undefined) {
    main.push({ kind: 'text', text: '?' });
    return label;
  }
  const tol = input.tolerance;
  const valueText = fmt(value);
  if (!tol) {
    main.push({ kind: 'text', text: valueText });
    return label;
  }
  switch (tol.kind) {
    case 'symmetric':
      main.push({ kind: 'text', text: valueText });
      label.tolerance = { kind: 'inline', text: `±${fmt(Math.abs(tol.value))}` };
      break;
    case 'bilateral':
      main.push({ kind: 'text', text: valueText });
      label.tolerance = { kind: 'stack', upper: fmt(tol.upper, true), lower: fmt(tol.lower, true) };
      break;
    case 'limits':
      label.tolerance = {
        kind: 'stack',
        upper: fmt(value + tol.upper),
        lower: fmt(value + tol.lower),
      };
      break;
    case 'basic':
      main.push({ kind: 'text', text: valueText });
      label.frame = 'box';
      break;
    case 'reference':
      main.push({ kind: 'text', text: valueText });
      label.frame = 'parens';
      break;
    case 'fit':
      fitLabel(label, value, valueText, tol, fmt, input.fitDeviations);
      break;
  }
  return label;
}

function fitLabel(
  label: DimensionLabel,
  value: number,
  valueText: string,
  tol: Extract<ToleranceValue, { kind: 'fit' }>,
  fmt: (x: number, sign?: boolean) => string,
  lookup: FitDeviationLookup | undefined,
): void {
  const symbol = [tol.hole, tol.shaft].filter(Boolean).join('/');
  const classes = [tol.hole, tol.shaft].filter((c): c is string => !!c);
  const invalid = classes.filter((c) => !isHoleClass(c) && !isShaftClass(c));
  if (invalid.length > 0 || classes.length === 0) label.warnings.push('fitClassInvalid');
  const devs = classes.map((c) => lookup?.(c, value));
  const known = devs.every((d): d is FitDeviation => d !== undefined) && devs.length > 0;
  if (tol.show !== 'symbol' && !known) label.warnings.push('fitDeviationsUnknown');
  const zeroOr = (x: number) => (Math.abs(x) < 5e-7 ? '0' : fmt(x, true));

  if (tol.show === 'symbol' || !known) {
    label.main.push({ kind: 'text', text: valueText });
    label.tolerance = { kind: 'inline', text: symbol };
    return;
  }
  const dev = devs as FitDeviation[];
  const first = dev[0] as FitDeviation;
  if (tol.show === 'symbolAndDeviations') {
    label.main.push({ kind: 'text', text: valueText });
    if (dev.length === 1) {
      label.tolerance = {
        kind: 'stack',
        before: symbol,
        upper: zeroOr(first.upper),
        lower: zeroOr(first.lower),
        parens: true,
      };
    } else {
      // A pair shows hole over shaft; deviations stay with the symbols (`H7/g6` then each pair).
      const second = dev[1] as FitDeviation;
      label.tolerance = {
        kind: 'inline',
        text: `${symbol} (${zeroOr(first.upper)}/${zeroOr(first.lower)} ; ${zeroOr(second.upper)}/${zeroOr(second.lower)})`,
      };
    }
    return;
  }
  // limitsAndSymbol: a single class shows its limits; a pair shows the hole's (the feature's own).
  label.tolerance = {
    kind: 'stack',
    upper: fmt(value + first.upper),
    lower: fmt(value + first.lower),
    after: `(${symbol})`,
  };
}

/** Flattens a label to one string (search, accessibility, DXF fallbacks, tests). */
export function labelText(label: DimensionLabel): string {
  const runs = label.main.map((r) => (r.kind === 'text' ? r.text : `{${r.id}}`)).join('');
  let tol = '';
  const t = label.tolerance;
  if (t?.kind === 'inline') tol = ` ${t.text}`;
  else if (t) {
    const stack = `${t.upper}/${t.lower}`;
    tol = `${t.before ? ` ${t.before}` : ''} ${t.parens ? `(${stack})` : stack}${t.after ? ` ${t.after}` : ''}`;
    if (!runs.match(/\d/)) tol = tol.trimStart();
  }
  let out = `${runs}${tol}`;
  if (label.frame === 'box') out = `[${out}]`;
  if (label.frame === 'parens') out = `(${out})`;
  if (label.suffix) out += ` ${label.suffix}`;
  return out;
}
