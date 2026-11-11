/**
 * Validation of a new parameter's name for "Make parameter" (ADR-080). It mirrors the document's
 * rules (`validateParamName`) and adds the units: a parameter named `mm` or `in` would be read as
 * a unit after a number, which is confusing, so it is refused up front.
 */

/** Built-in function and constant names (document `FUNCTIONS` / `CONSTANTS`). */
export const RESERVED_WORDS: readonly string[] = [
  'pi',
  'π',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sqrt',
  'abs',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
];

/** Unit names (document `UNITS`). */
export const UNIT_WORDS: readonly string[] = [
  'um',
  'µm',
  'mm',
  'cm',
  'm',
  'in',
  'ft',
  'deg',
  '°',
  'rad',
  'g',
  'kg',
  'lb',
  's',
  'N',
  'Pa',
  'kPa',
  'MPa',
  'GPa',
];

const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** `null` when `name` can be a new parameter, otherwise the reason (user-facing). */
export function validateNewParamName(name: string, existing: readonly string[]): string | null {
  if (!name) return 'Give the parameter a name';
  if (!NAME.test(name)) return 'Use letters, digits and _, starting with a letter';
  if (RESERVED_WORDS.includes(name)) return `“${name}” is a built-in function or constant`;
  if (UNIT_WORDS.includes(name)) return `“${name}” is a unit; pick another name`;
  if (existing.includes(name)) return `“${name}” is already used`;
  return null;
}
