import type { KeyboardEvent } from 'react';
import { UNIT_WORDS } from './paramName';

/**
 * Pure helpers behind parameter autocomplete and "link" display (ADR-080). No React, no DOM.
 *
 * An identifier in an expression is a parameter unless it comes straight after a number, where
 * it is a unit (`25mm`, `2 mm`). Autocomplete therefore never offers parameters in a unit slot.
 */

const ID_CHAR = /[\p{L}\p{N}_]/u;
const ID_START = /[\p{L}_]/u;

export interface ParamInfo {
  name: string;
  /** Evaluated value as shown to the user ("80 mm"); absent while it has an error. */
  value?: string;
  description?: string;
}

/** The identifier under the caret: its `[start, end)` range and the part left of the caret. */
export interface IdentifierAtCaret {
  start: number;
  end: number;
  /** Text from `start` to the caret: what the autocomplete matches against. */
  prefix: string;
}

/**
 * Finds the identifier around `caret`. Null when the caret is not on (or just after) an
 * identifier, or when the identifier is a unit (it follows a number) or a number itself.
 */
export function identifierAtCaret(text: string, caret: number): IdentifierAtCaret | null {
  let start = caret;
  while (start > 0 && ID_CHAR.test(text[start - 1] ?? '')) start--;
  let end = caret;
  while (end < text.length && ID_CHAR.test(text[end] ?? '')) end++;
  if (start === end) return null;
  if (!ID_START.test(text[start] ?? '')) return null; // starts with a digit: a number (`25mm`)
  // A unit sits straight after a number, with at most spaces between.
  let k = start - 1;
  while (k >= 0 && text[k] === ' ') k--;
  if (k >= 0 && /[\d.]/.test(text[k] ?? '')) return null;
  return { start, end, prefix: text.slice(start, caret) };
}

/** True when `name` starts with `prefix` (case-insensitive): only those may open the list. */
export const isPrefixMatch = (name: string, prefix: string): boolean =>
  name.toLowerCase().startsWith(prefix.toLowerCase());

/** Parameters matching `prefix`: prefix matches first, then substrings; case-insensitive. */
export function matchParams(params: readonly ParamInfo[], prefix: string, limit = 50): ParamInfo[] {
  const q = prefix.toLowerCase();
  if (!q) return params.slice(0, limit);
  const starts: ParamInfo[] = [];
  const inside: ParamInfo[] = [];
  for (const p of params) {
    const n = p.name.toLowerCase();
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) inside.push(p);
  }
  return [...starts, ...inside].slice(0, limit);
}

/** Replaces `[start, end)` with `name`; the caret lands just after the inserted name. */
export function insertParam(
  text: string,
  start: number,
  end: number,
  name: string,
): { text: string; caret: number } {
  return { text: text.slice(0, start) + name + text.slice(end), caret: start + name.length };
}

/** Names of the parameters an expression refers to (direct references, in order of first use). */
export function paramRefs(expr: string, names: ReadonlySet<string> | readonly string[]): string[] {
  const known = names instanceof Set ? names : new Set(names);
  const out: string[] = [];
  const re = /[\p{L}_][\p{L}\p{N}_]*/gu;
  for (const m of expr.matchAll(re)) {
    const at = m.index ?? 0;
    if (!known.has(m[0]) || out.includes(m[0])) continue;
    // The engine's rule: a name straight after a number is a unit only if it IS a unit; any
    // other name there is a parameter (`2 width` is 2 * width).
    // The exponent of a number (`1e3`, `1e-3`) is part of the number, not a name.
    if (
      at > 0 &&
      /[\d.]/.test(expr[at - 1] ?? '') &&
      /^[eE]\d*$/.test(m[0]) &&
      (/\d/.test(m[0]) || /^[+-]?\d/.test(expr.slice(at + m[0].length)))
    )
      continue;
    let k = at - 1;
    while (k >= 0 && expr[k] === ' ') k--;
    if (k >= 0 && /[\d.]/.test(expr[k] ?? '') && UNIT_WORDS.includes(m[0])) continue;
    const after = expr.slice(at + m[0].length).trimStart();
    if (after.startsWith('(')) continue; // a function call
    out.push(m[0]);
  }
  return out;
}

/** True when the whole expression is exactly one parameter name. */
export function isParamName(expr: string, names: ReadonlySet<string> | readonly string[]): boolean {
  const t = expr.trim();
  if (!t) return false;
  return names instanceof Set ? names.has(t) : (names as readonly string[]).includes(t);
}

/** The expression a new parameter gets from a field's text: bare numbers take the field's unit. */
export function paramExprFrom(text: string, unitHint?: string): string {
  const t = text.trim();
  if (unitHint && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
    return `${t} ${unitHint === '°' ? 'deg' : unitHint}`;
  }
  return t;
}

/** A readable default parameter name from a field label ("Extrude depth" -> `extrude_depth`). */
export function suggestParamName(label: string, taken: readonly string[]): string {
  const words = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  let base = words || 'param';
  if (!ID_START.test(base[0] ?? '')) base = `p_${base}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** How `ExpressionInput` and its lazily loaded `ParamAssist` talk (ADR-080). */
export interface AssistApi {
  /** A key in the field; true when the assist consumed it (list navigation, accept, Esc). */
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): boolean;
  /** The text changed; true when the assist took over (the `=` gesture). */
  onChange?(next: string, caret: number, prev: string): boolean;
  /** The text was edited (typing, nudging, accepting): reset the list. */
  onEdit?(): void;
  /** Focus left the field; true when it went into the list or the make form (keep the edit). */
  onBlur?(related: Node | null): boolean;
}

/** What the field needs of the assist to set its ARIA attributes. */
export interface AssistState {
  listOpen: boolean;
  listId: string;
  activeId?: string | undefined;
  /** The parameters the text refers to, comma separated, or null. */
  linked: string | null;
}

/** One row of the parameter list: a parameter, or the "make a parameter from this value" row. */
export type PickerEntry = { kind: 'param'; info: ParamInfo } | { kind: 'make'; text: string };

export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;
