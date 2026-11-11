import type { EvalResult, Expr } from '@wren-cad/contracts';
import { Field } from '../components/controls';
import { ExpressionInput } from '../components/ExpressionInput';

/** A bare number is sheet millimetres (or degrees), whatever the document's default unit. */
export const sheetUnits = (text: string, unit: 'mm' | 'deg'): string =>
  /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(text) ? `${text.trim()}${unit}` : text;

export interface SheetValueFieldProps {
  label: string;
  /** The stored number: sheet mm, or degrees for `unit: 'deg'`. */
  value: number;
  unit?: 'mm' | 'deg';
  step?: number;
  evaluate(expr: Expr): EvalResult;
  /** Called once, on Enter or blur, with the evaluated number (never per keystroke). */
  onCommit(n: number): void;
  size?: 'md' | 'touch';
}

/**
 * An inline value on the sheet: takes expressions with units (`12`, `1.5in`, `10+2`), commits on
 * Enter or blur so one edit is one undo step, and stores the number (mm or degrees).
 */
export function SheetValueField({
  label,
  value,
  unit = 'mm',
  step = 1,
  evaluate,
  onCommit,
  size = 'md',
}: SheetValueFieldProps) {
  const norm = (t: string) => sheetUnits(t, unit);
  return (
    <Field label={label}>
      <ExpressionInput
        label={label}
        value={String(Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0)}
        evaluate={(t) => evaluate(norm(t))}
        unitHint={unit}
        step={step}
        onCommit={(t) => {
          const r = evaluate(norm(t));
          if (!r.ok) return;
          const n = unit === 'deg' ? (r.value * 180) / Math.PI : r.value;
          if (Number.isFinite(n)) onCommit(Math.round(n * 1e6) / 1e6);
        }}
        size={size}
        showValue={false}
      />
    </Field>
  );
}
