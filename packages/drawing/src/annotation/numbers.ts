/**
 * Number formatting from `DrawingStyle.numbers`: decimal mark, precision, trailing zeros, and
 * decimal or DMS angles. Lengths are mm in, mm out (M4 drawings are mm, ADR-090). Rounding is half
 * away from zero; `-0` never shows.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DrawingStyle } from '@wren-cad/contracts';
import { roundTo } from './geom';

export type NumberStyle = DrawingStyle['numbers'];

export interface FormatOptions {
  /** Decimals; absent = the style's precision for the quantity. */
  precision?: number;
  /** Always show the sign (`+0.1`); zero shows without one (ISO 129-1: `0`). */
  sign?: boolean;
}

function plain(value: number, precision: number, style: NumberStyle): string {
  const p = Math.max(0, Math.min(6, Math.round(precision)));
  const r = roundTo(value, p);
  let s = Math.abs(r).toFixed(p);
  if (style.trailingZeros === 'strip' && s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (style.decimal === ',') s = s.replace('.', ',');
  return r < 0 && Number(s.replace(',', '.')) !== 0 ? `-${s}` : s;
}

function signed(s: string, sign: boolean | undefined): string {
  if (!sign || s.startsWith('-')) return s;
  return Number(s.replace(',', '.')) === 0 ? s : `+${s}`;
}

/** A length in mm: `12.5`, `12,5`, `12.50`. */
export function formatLength(mm: number, style: NumberStyle, options: FormatOptions = {}): string {
  return signed(plain(mm, options.precision ?? style.lengthPrecision, style), options.sign);
}

/** An angle in radians, shown in degrees (`30°`) or degrees, minutes, seconds (`30°15'20"`). */
export function formatAngle(rad: number, style: NumberStyle, options: FormatOptions = {}): string {
  const deg = (rad * 180) / Math.PI;
  const precision = options.precision ?? style.anglePrecision;
  if (style.angleFormat === 'decimal')
    return `${signed(plain(deg, precision, style), options.sign)}°`;
  // DMS: precision 0 = degrees, 1–2 = minutes, ≥ 3 = seconds (decimals of seconds beyond 4).
  const neg = deg < 0;
  const totalSeconds = Math.abs(deg) * 3600;
  const secDecimals = Math.max(0, precision - 4);
  const unit = precision === 0 ? 3600 : precision <= 2 ? 60 : 1;
  const rounded =
    unit === 1 ? roundTo(totalSeconds, secDecimals) : Math.round(totalSeconds / unit) * unit;
  const d = Math.floor(rounded / 3600 + 1e-9);
  const m = Math.floor((rounded - d * 3600) / 60 + 1e-9);
  const s = rounded - d * 3600 - m * 60;
  let out = `${d}°`;
  if (unit <= 60) out += `${m}'`;
  if (unit === 1) out += `${plain(s, secDecimals, { ...style, trailingZeros: 'strip' })}"`;
  const zero = rounded === 0;
  return neg && !zero ? `-${out}` : options.sign && !zero ? `+${out}` : out;
}

/** The scale ratio as drawn: `1:2`, `2:1`, `1:1` (ISO 5455), from a unitless value. */
export function formatScale(ratio: number): string {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return '?';
  const near = (x: number) => Math.abs(x - Math.round(x)) < 1e-9 * Math.max(1, Math.abs(x));
  if (ratio >= 1 && near(ratio)) return `${Math.round(ratio)}:1`;
  if (ratio < 1 && near(1 / ratio)) return `1:${Math.round(1 / ratio)}`;
  if (ratio >= 1) return `${roundTo(ratio, 4)}:1`;
  return `1:${roundTo(1 / ratio, 4)}`;
}

/**
 * The inline scale field: `1:2` → `1/2`, `2:1` → `2`, `1/5` and `0.5` kept. Returns null for
 * anything else (the field shows the error inline).
 */
export function parseScaleInput(text: string): string | null {
  const t = text.trim();
  const ratio = /^(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (ratio) {
    const a = (ratio[1] ?? '').replace(',', '.');
    const b = (ratio[2] ?? '').replace(',', '.');
    if (Number(a) <= 0 || Number(b) <= 0) return null;
    return b === '1' ? a : `${a}/${b}`;
  }
  if (/^\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?$/.test(t)) return t.replace(/\s+/g, '');
  return null;
}
