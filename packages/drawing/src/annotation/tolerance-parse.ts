/**
 * The inline tolerance field's parser (ADR-090 §2.4 grammar), shared with M5:
 *
 *   10 ±0.1          symmetric           10 +0.1/-0.05     bilateral (also `+0.1 -0.05`)
 *   10.1/9.95        limits (stored as deviations from the nominal at entry)
 *   [10]             basic               (10)              reference
 *   H7 | g6 | H7/g6  fit (symbol)        H7 (+0.021/0)     fit, symbol and deviations
 *   10.021/10 (H7)   fit, limits and symbol
 *
 * A leading size symbol (Ø, ⌀, R, SR, SØ) is accepted and ignored: the kind gives it. The nominal
 * is optional; when typed it is returned as `nominal` (the caller decides whether a stated value
 * replaces a measured one). Both `.` and `,` are decimal marks; `-`, `−` and `–` are minus. An
 * empty field clears the tolerance. Deviations are written as `Expr`s with units (`0.1 mm`,
 * `0.5 deg`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Expr, Tolerance } from '@wren-cad/contracts';
import { isHoleClass, isShaftClass } from './tolerance';

export type ToleranceParse =
  | { ok: true; nominal?: Expr; tolerance: Tolerance | null }
  | { ok: false; message: string };

export interface ToleranceParseOptions {
  quantity?: 'length' | 'angle';
  /**
   * The dimension's current value (mm or deg for angles), needed for the limits form when no
   * nominal is typed: limits are stored as deviations from it.
   */
  nominal?: number;
}

const NUM = String.raw`\d+(?:[.,]\d+)?|[.,]\d+`;
const SNUM = String.raw`[+\-−–]?\s*(?:${NUM})`;

function toNumber(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/[−–]/g, '-').replace(',', '.'));
}

function numText(n: number): string {
  // Shortest round-trip form, no exponent for drawing-sized values.
  const s = String(Number(n.toPrecision(12)));
  return s === '-0' ? '0' : s;
}

function fail(message: string): ToleranceParse {
  return { ok: false, message };
}

export function parseTolerance(input: string, options: ToleranceParseOptions = {}): ToleranceParse {
  const unit = options.quantity === 'angle' ? 'deg' : 'mm';
  const expr = (n: number): Expr => `${numText(n)} ${unit}`;
  let s = input.trim().replace(/\s+/g, ' ');
  if (s === '') return { ok: true, tolerance: null };

  // Basic and reference: the whole field bracketed.
  const boxed = /^\[\s*(.*?)\s*\]$/.exec(s);
  const paren = /^\(\s*([^()]*?)\s*\)$/.exec(s);
  if (boxed || paren) {
    const inner = stripSize((boxed ?? paren)?.[1] ?? '');
    const unitRe = options.quantity === 'angle' ? '(?:\\s*(?:°|deg))?' : '(?:\\s*mm)?';
    if (inner !== '' && !new RegExp(`^(?:${NUM})${unitRe}$`).test(inner))
      return fail(`“${inner}” is not a number`);
    const nominal = inner === '' ? undefined : expr(toNumber(inner.replace(/[^\d.,]/g, '')));
    return {
      ok: true,
      ...(nominal ? { nominal } : {}),
      tolerance: { kind: boxed ? 'basic' : 'reference' },
    };
  }

  s = stripSize(s);
  // Optional nominal at the start, followed by a space or a tolerance sign.
  let nominal: number | undefined;
  const lead = new RegExp(`^(${NUM})(?:\\s*(?:mm|°|deg))?(?=\\s|±|\\+|$)`).exec(s);
  const rest0 = lead ? s.slice(lead[0].length).trim() : s;
  // A bare "10.1/9.95" is limits, not "nominal 10.1 then /9.95": only take the lead when a space
  // or a sign follows it.
  if (lead && !/^\//.test(rest0)) {
    nominal = toNumber(lead[1] ?? '');
    s = rest0;
  }
  const withNominal = (t: Tolerance | null): ToleranceParse => ({
    ok: true,
    ...(nominal !== undefined ? { nominal: expr(nominal) } : {}),
    tolerance: t,
  });
  if (s === '') return nominal !== undefined ? withNominal(null) : fail('Nothing to read');

  // ±t  (also +-t, +/-t)
  const sym = new RegExp(`^(?:±|\\+\\s*/?\\s*-)\\s*(${NUM})$`).exec(s);
  if (sym) {
    const v = toNumber(sym[1] ?? '');
    if (v === 0) return fail('A ± tolerance must not be zero');
    return withNominal({ kind: 'symmetric', value: expr(v) });
  }

  // Fit: H7, g6, H7/g6, optionally "(+0.021/0)" after it.
  const fit =
    /^([A-Za-z]{1,2}(?:01|1[0-8]|[1-9]))(?:\s*\/\s*([A-Za-z]{1,2}(?:01|1[0-8]|[1-9])))?(?:\s*\((.*)\))?$/.exec(
      s,
    );
  if (fit) {
    const a = fit[1] ?? '';
    const b = fit[2];
    const devs = fit[3];
    const hole = isHoleClass(a) ? a : undefined;
    const shaft = b ? (isShaftClass(b) ? b : undefined) : isShaftClass(a) ? a : undefined;
    if (b && !hole) return fail(`“${a}” is not a hole class (capital letters: H7)`);
    if (b && !shaft) return fail(`“${b}” is not a shaft class (small letters: g6)`);
    if (!hole && !shaft) return fail(`“${a}” is not an ISO 286 tolerance class`);
    if (devs !== undefined && !new RegExp(`^${SNUM}\\s*/\\s*${SNUM}$`).test(devs.trim()))
      return fail('Write the deviations as (+0.021/0)');
    return withNominal({
      kind: 'fit',
      ...(hole ? { hole } : {}),
      ...(shaft ? { shaft } : {}),
      show: devs !== undefined ? 'symbolAndDeviations' : 'symbol',
    });
  }

  // Two numbers: bilateral (signed or zero) or limits (unsigned); optional "(H7)" after limits.
  const pair = new RegExp(
    `^(${SNUM})\\s*(?:/|\\s)\\s*(${SNUM})(?:\\s*\\(([A-Za-z]{1,2}(?:01|1[0-8]|[1-9]))\\))?$`,
  ).exec(s);
  if (pair) {
    const ta = (pair[1] ?? '').replace(/\s+/g, '');
    const tb = (pair[2] ?? '').replace(/\s+/g, '');
    const a = toNumber(ta);
    const b = toNumber(tb);
    const signedA = /^[+\-−–]/.test(ta) || a === 0;
    const signedB = /^[+\-−–]/.test(tb) || b === 0;
    const fitClass = pair[3];
    if (signedA && signedB && !fitClass) {
      if (a < b) return fail('The upper deviation comes first (+0.1/-0.05)');
      if (a === b) return fail('Upper and lower deviations are equal');
      return withNominal({ kind: 'bilateral', upper: expr(a), lower: expr(b) });
    }
    if (signedA || signedB)
      return fail('Mix of signed and unsigned values: write +0.1/-0.05 or 10.1/9.95');
    const upper = Math.max(a, b);
    const lower = Math.min(a, b);
    if (upper === lower) return fail('The two limits are equal');
    if (fitClass) {
      const hole = isHoleClass(fitClass) ? fitClass : undefined;
      const shaft = isShaftClass(fitClass) ? fitClass : undefined;
      return withNominal({
        kind: 'fit',
        ...(hole ? { hole } : {}),
        ...(shaft ? { shaft } : {}),
        show: 'limitsAndSymbol',
      });
    }
    const ref = nominal ?? options.nominal;
    if (ref === undefined)
      return fail('Limits need the nominal value: type it first (10 10.1/9.95)');
    return withNominal({
      kind: 'limits',
      upper: expr(roundDev(upper - ref)),
      lower: expr(roundDev(lower - ref)),
    });
  }
  return fail(`Can't read “${input.trim()}”: try ±0.1, +0.1/-0.05, H7 or H7/g6`);
}

function stripSize(s: string): string {
  return s.replace(/^(?:S?[Ø⌀]|S?R(?=\s*[\d.,]))\s*/, '');
}

/** Deviations from limits: rounded to 1e-9 so `10.1 − 10` is stored as `0.1`, not `0.0999…`. */
function roundDev(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}
