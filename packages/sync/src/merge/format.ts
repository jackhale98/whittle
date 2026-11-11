// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Short value text for one-line diffs ("2 mm → 3 mm", "blind 10 mm → through all"). Expressions
 * are shown as typed, except that a plain number with or without a unit is spaced the way the
 * inspector shows it (`2mm` → `2 mm`, `30deg` → `30°`; a bare `40` in a length field gets the
 * document's length unit). Values that have no sensible one-line text (references, lists)
 * return `null` and the caller says "changed".
 */

import type { Annotation, Feature, NamedDimension, WrenDoc } from '@wren-cad/contracts';
import { annotationExprFields, exprFields } from '@wren-cad/document';
import { isEntityRef, isObj } from './tree';

export type Units = WrenDoc['units'];

const SIMPLE =
  /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(um|mm|cm|m|in|ft|deg|rad|°|")?\s*$/i;

/** A plain number with an optional unit (`6mm`, `30 deg`), or `null` for anything else. */
export function simpleNumber(expr: string): { n: string; unit?: string } | null {
  const m = SIMPLE.exec(expr);
  if (!m) return null;
  return m[2] === undefined ? { n: m[1] as string } : { n: m[1] as string, unit: m[2] };
}

export function prettyExpr(expr: string, units?: Units, dim?: NamedDimension): string {
  const m = SIMPLE.exec(expr);
  if (!m) return expr.trim();
  const n = m[1] as string;
  let unit = m[2]?.toLowerCase();
  if (unit === undefined && units && dim === 'length') unit = units.length;
  if (unit === undefined && units && dim === 'angle') unit = units.angle;
  if (unit === undefined) return n;
  if (unit === 'deg' || unit === '°') return `${n}°`;
  if (unit === '"') return `${n} in`;
  return `${n} ${unit}`;
}

const words = (camel: string): string => camel.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** One-line text for a value, or `null` when it has none. */
export function formatValue(v: unknown, units?: Units, dim?: NamedDimension): string | null {
  if (typeof v === 'string') return prettyExpr(v, units, dim);
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (isObj(v) && !isEntityRef(v) && typeof v.kind === 'string') {
    const exprs = Object.entries(v)
      .filter(([k, x]) => k !== 'kind' && typeof x === 'string')
      .map(([, x]) => prettyExpr(x as string, units));
    return [words(v.kind), exprs.join(', ')].filter(Boolean).join(' ');
  }
  return null;
}

/** Expected dimension of each `Expr` pointer of a feature (`/radius` → length). */
export function featureDims(feature: Feature): Map<string, NamedDimension> {
  const m = new Map<string, NamedDimension>();
  try {
    for (const f of exprFields(feature)) m.set(f.pointer, f.expected);
  } catch {
    // A malformed feature: values are shown without units.
  }
  return m;
}

/** Expected dimension of each `Expr` pointer of an annotation (`/tolerance/upper` → length). */
export function annotationDims(annotation: Annotation): Map<string, NamedDimension> {
  const m = new Map<string, NamedDimension>();
  try {
    for (const f of annotationExprFields(annotation)) m.set(f.pointer, f.expected);
  } catch {
    // Malformed: values are shown without units.
  }
  return m;
}

/** "Line 1, Line 2 and 3 more". */
export function listText(names: readonly string[], max = 3): string {
  if (names.length <= max) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
