import type { Expr, Tolerance } from '@wren-cad/contracts';
import { parseTolerance, type ToleranceParse } from '@wren-cad/drawing/annotation';
import { useEffect, useId, useState } from 'react';
import { cn } from '../components/primitives';

/** `0.1 mm` → `0.1`: the unit is implied by the dimension. */
const bare = (e: Expr): string => e.replace(/\s*(mm|deg|°)$/, '');

/** A tolerance as the field writes it (re-parseable where the form allows it). */
export function toleranceText(t: Tolerance | undefined): string {
  if (!t) return '';
  switch (t.kind) {
    case 'symmetric':
      return `±${bare(t.value)}`;
    case 'bilateral': {
      const sign = (e: string) => (/^[+\-−–]/.test(e) ? e : `+${e}`);
      return `${sign(bare(t.upper))}/${sign(bare(t.lower))}`;
    }
    case 'limits':
      return `limits ${bare(t.upper)}/${bare(t.lower)}`;
    case 'basic':
      return '[ ]';
    case 'reference':
      return '( )';
    case 'fit': {
      const sym = [t.hole, t.shaft].filter(Boolean).join('/');
      return t.show === 'symbolAndDeviations' ? `${sym} (+/−)` : sym;
    }
  }
}

export interface ToleranceFieldProps {
  /** The stored tolerance. */
  value: Tolerance | undefined;
  /** The stored nominal text, when the dimension states one. */
  nominal?: Expr | undefined;
  quantity?: 'length' | 'angle';
  /** The dimension's current value (mm or deg), for the limits form. */
  measured?: number;
  /** Fits are length-only and meaningless on an angle. */
  disabled?: boolean;
  onCommit(result: { nominal?: Expr; tolerance: Tolerance | null }): void;
  size?: 'md' | 'touch';
  label?: string;
}

const EXAMPLES = '±0.1   +0.2/−0.1   H7   H7/g6   [10]   (10)';

/**
 * The inline tolerance field: type it as it is written on a drawing. It reads with
 * `parseTolerance` (symmetric, bilateral, limits, fits, basic, reference), previews what it
 * understood or says what it could not read, commits on Enter or blur and reverts on Escape. An
 * empty field clears the tolerance.
 */
export function ToleranceField({
  value,
  quantity = 'length',
  measured,
  disabled,
  onCommit,
  size = 'md',
  label = 'Tolerance',
}: ToleranceFieldProps) {
  const stored = toleranceText(value);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  useEffect(() => setDraft(null), []);
  const text = draft ?? stored;
  const parsed: ToleranceParse | null =
    draft === null
      ? null
      : parseTolerance(draft, {
          quantity,
          ...(measured !== undefined ? { nominal: measured } : {}),
        });

  const commit = () => {
    if (draft === null) return;
    const r = parseTolerance(draft, {
      quantity,
      ...(measured !== undefined ? { nominal: measured } : {}),
    });
    if (!r.ok) return;
    onCommit({ ...(r.nominal ? { nominal: r.nominal } : {}), tolerance: r.tolerance });
    setDraft(null);
  };

  return (
    <div className="flex flex-col gap-1" data-testid="tolerance-field">
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        value={text}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder="none"
        aria-invalid={parsed?.ok === false || undefined}
        aria-describedby={`${id}-msg`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') setDraft(null);
        }}
        className={cn(
          'tnum rounded-control bg-surface-2 px-2.5 text-ui text-fg outline-none placeholder:text-fg-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] disabled:opacity-50',
          size === 'touch' ? 'h-11 text-sm' : 'h-8',
          parsed?.ok === false && 'shadow-[inset_0_0_0_2px_var(--color-danger)]',
        )}
      />
      <p
        id={`${id}-msg`}
        role={parsed?.ok === false ? 'alert' : undefined}
        className={cn('text-2xs', parsed?.ok === false ? 'text-danger-text' : 'text-fg-subtle')}
      >
        {parsed === null
          ? `Type it as written: ${EXAMPLES}`
          : parsed.ok
            ? parsed.nominal
              ? `Reads as: nominal ${parsed.nominal}, ${parsed.tolerance ? toleranceText(parsed.tolerance) : 'no tolerance'}. Enter to apply.`
              : parsed.tolerance
                ? `Reads as ${toleranceText(parsed.tolerance)}. Enter to apply.`
                : 'Empty clears the tolerance. Enter to apply.'
            : parsed.message}
      </p>
    </div>
  );
}
