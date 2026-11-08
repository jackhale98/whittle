import type { DimensionVector, EvalResult, ExprError } from '@whittle/contracts';

export type EvalOk = Extract<EvalResult, { ok: true }>;

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** Number with at most 4 decimals, no trailing zeros, true minus sign. */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const s =
    Math.abs(n) >= 1e9 || (n !== 0 && Math.abs(n) < 1e-4) ? n.toExponential(3) : nf.format(n);
  return s.replace('-', '−');
}

const eq = (a: DimensionVector, b: readonly [number, number, number]) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * Display text for a canonical value (mm, rad, kg) — the fallback when the host passes no
 * `formatValue`. Hosts with unit preferences (inches, …) supply their own.
 */
export function defaultFormatValue(value: number, dimension: DimensionVector): string {
  if (eq(dimension, [0, 0, 0])) return fmtNumber(value);
  if (eq(dimension, [1, 0, 0])) return `${fmtNumber(value)} mm`;
  if (eq(dimension, [0, 0, 1])) return `${fmtNumber((value * 180) / Math.PI)}°`;
  if (eq(dimension, [2, 0, 0])) return `${fmtNumber(value)} mm²`;
  if (eq(dimension, [3, 0, 0])) return `${fmtNumber(value)} mm³`;
  if (eq(dimension, [0, 1, 0])) return `${fmtNumber(value)} kg`;
  if (eq(dimension, [-3, 1, 0])) return formatDensity(value);
  return fmtNumber(value);
}

/** Density (kg/mm³) as `2.70 g/cm³`: two decimals, superscript exponent. */
export function formatDensity(kgPerMm3: number): string {
  if (!Number.isFinite(kgPerMm3)) return '—';
  return `${(kgPerMm3 * 1e6).toFixed(2).replace('-', '−')} g/cm³`;
}

/** Display form of an expression's units: `2.70 g/cm^3` → `2.70 g/cm³` (text stays editable as typed). */
export function prettyUnits(expr: string): string {
  return expr.replace(/\^([0-9])/g, (_, d: string) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)] ?? `^${d}`);
}

export type FormatValue = (value: number, dimension: DimensionVector) => string;

/** True when `text` is just a number with an optional unit (so an "= value" readout is redundant). */
export function isPlainLiteral(text: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*[a-zA-Z°µ]*(\/[a-zA-Z]+(\^\d)?)?\s*$/.test(text);
}

/** Splits `text` around an error span, clamping to the string. */
export function splitSpan(text: string, error?: ExprError): [string, string, string] {
  const span = error?.span;
  if (!span) return [text, '', ''];
  const a = Math.max(0, Math.min(span[0], text.length));
  const b = Math.max(a, Math.min(span[1], text.length));
  // A zero-width span (e.g. "unexpected end") still gets one visible character.
  const end = b === a ? Math.min(a + 1, text.length) : b;
  const start = b === a && end === a ? Math.max(0, a - 1) : a;
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

const NUDGE =
  /^(\s*)([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(\s*)([a-zA-Z°µ][a-zA-Z0-9°µ/^]*)?(\s*)$/;

/**
 * Adds `delta` to the number in `text`, keeping its unit and spacing (`"10mm"` → `"11mm"`).
 * Non-literal expressions get `+ delta<unit>` appended when a unit is known; otherwise they are
 * left alone (returns `null`).
 */
export function nudgeExpression(text: string, delta: number, unit?: string): string | null {
  const m = NUDGE.exec(text);
  if (m) {
    const [, lead = '', num = '0', gap = '', u = '', trail = ''] = m;
    const next = Number.parseFloat((Number.parseFloat(num) + delta).toPrecision(12));
    return `${lead}${next}${gap}${u}${trail}`;
  }
  if (!text.trim() || !unit) return null;
  const sign = delta < 0 ? '-' : '+';
  return `${text.trim()} ${sign} ${Number.parseFloat(Math.abs(delta).toPrecision(12))}${unit}`;
}
