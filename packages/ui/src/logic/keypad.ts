/**
 * Editing logic of the inline numeric keypad: pure `(text, selection, key) -> (text, caret)`.
 * The keypad drives an <input>; the component feeds the result back and restores the caret.
 */

export type KeypadKey =
  | { kind: 'insert'; text: string }
  | { kind: 'unit'; unit: string }
  | { kind: 'operator'; op: '+' | '-' | '*' | '/' }
  | { kind: 'param'; name: string }
  | { kind: 'backspace' }
  | { kind: 'clear' }
  | { kind: 'move'; dir: -1 | 1 }
  | { kind: 'enter' }
  | { kind: 'close' }
  | { kind: 'osKeyboard' };

export interface EditResult {
  text: string;
  caret: number;
}

const UNIT_TAIL = /(\d|\))\s*([a-zA-Z°]+)$/;
const SPACED_OP = /\s[+\-*/]\s$/;

/** Operators are written with surrounding spaces so `1 - 2` never reads as a signed literal. */
export function opText(op: '+' | '-' | '*' | '/'): string {
  return ` ${op} `;
}

/**
 * Applies an editing key. Returns null for keys that do not edit text (enter, close, ...).
 * The selection `[a, b)` is replaced by inserted text.
 */
export function applyKeypadKey(
  text: string,
  a: number,
  b: number,
  key: KeypadKey,
): EditResult | null {
  const lo = Math.max(0, Math.min(a, b, text.length));
  const hi = Math.max(0, Math.min(Math.max(a, b), text.length));
  const before = text.slice(0, lo);
  const after = text.slice(hi);

  switch (key.kind) {
    case 'insert':
      return { text: before + key.text + after, caret: lo + key.text.length };
    case 'unit': {
      // Replace a unit already typed after the number ("45deg" + "mm" -> "45mm"), else append.
      const m = lo === hi ? UNIT_TAIL.exec(before) : null;
      if (m?.[2]) {
        const head = before.slice(0, before.length - m[2].length);
        return { text: head + key.unit + after, caret: head.length + key.unit.length };
      }
      return { text: before + key.unit + after, caret: lo + key.unit.length };
    }
    case 'operator': {
      const ins = opText(key.op);
      // Another operator right after one swaps it instead of stacking.
      const m = lo === hi ? SPACED_OP.exec(before) : null;
      if (m) {
        const head = before.slice(0, before.length - m[0].length);
        return { text: head + ins + after, caret: head.length + ins.length };
      }
      return { text: before + ins + after, caret: lo + ins.length };
    }
    case 'param': {
      // After a number or name a parameter needs an operator between: make it a product.
      const needsOp = lo === hi && /[\w)]\s*$/.test(before);
      const ins = (needsOp ? ' * ' : '') + key.name;
      return { text: before + ins + after, caret: lo + ins.length };
    }
    case 'backspace': {
      if (lo !== hi) return { text: before + after, caret: lo };
      if (lo === 0) return { text, caret: 0 };
      // " + " is one keystroke to remove, as it was one keystroke to add.
      const spaced = SPACED_OP.exec(before);
      const n = spaced ? spaced[0].length : 1;
      return { text: before.slice(0, before.length - n) + after, caret: lo - n };
    }
    case 'clear':
      return { text: '', caret: 0 };
    case 'move': {
      const caret =
        lo !== hi ? (key.dir < 0 ? lo : hi) : Math.max(0, Math.min(text.length, lo + key.dir));
      return { text, caret };
    }
    default:
      return null;
  }
}

/** Unit keys the keypad offers, with their spoken names. */
export const KEYPAD_UNITS = [
  { unit: 'mm', name: 'mm (millimetres)' },
  { unit: 'in', name: 'in (inches)' },
  { unit: 'deg', name: 'deg (degrees)' },
] as const;
