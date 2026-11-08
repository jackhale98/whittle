import type { EvalResult, Expr, SketchConstraintKind } from '@whittle/contracts';
import { useEffect, useRef, useState } from 'react';
import { ExpressionInput } from '../components/ExpressionInput';
import { cn } from '../components/primitives';
import { defaultFormatValue, type FormatValue } from '../format';

type DimKind = Extract<
  SketchConstraintKind,
  'distance' | 'hDistance' | 'vDistance' | 'length' | 'radius' | 'diameter' | 'angle'
>;

export interface DimensionLabelProps {
  /** Label centre in px, relative to the (positioned) sketch overlay. */
  x: number;
  y: number;
  kind: DimKind;
  /** Driving: the expression. Driven: ignored for display (see `measured`). */
  expr: Expr;
  driving: boolean;
  /** Pre-formatted measured value for driven (reference) dimensions. */
  measured?: string;
  evaluate?(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  /** Open the editor immediately (a dimension that was just placed). */
  autoEdit?: boolean;
  selected?: boolean;
  /** Highlight as part of a conflict. */
  conflicting?: boolean;
  onCommit?(expr: Expr): void;
  onPreview?(expr: Expr): void;
  /** Esc / blur without change. */
  onCancel?(): void;
  /** Click on a driven dimension: offer to make it driving. */
  onSelect?(): void;
}

const prefix: Partial<Record<DimKind, string>> = { radius: 'R', diameter: 'Ø' };

/**
 * HTML label for a sketch dimension, positioned over the canvas by the host. Click / Enter edits
 * the expression inline (units and params allowed). Reference dimensions are shown in
 * parentheses, muted, and are not editable (their value is measured).
 */
export function DimensionLabel({
  x,
  y,
  kind,
  expr,
  driving,
  measured,
  evaluate,
  formatValue,
  autoEdit,
  selected,
  conflicting,
  onCommit,
  onPreview,
  onCancel,
  onSelect,
}: DimensionLabelProps) {
  const [editing, setEditing] = useState(!!autoEdit && driving);
  const btn = useRef<HTMLButtonElement>(null);
  const fmt = formatValue ?? defaultFormatValue;
  const result = evaluate?.(expr);
  const text = driving
    ? result?.ok
      ? fmt(result.value, result.dimension).replace(/ mm$/, '')
      : expr
    : (measured ?? '—');

  useEffect(() => {
    if (autoEdit && driving) setEditing(true);
  }, [autoEdit, driving]);

  const pos = { left: x, top: y, transform: 'translate(-50%, -50%)' } as const;

  if (editing) {
    return (
      <div className="absolute z-[2] w-44" style={pos} data-testid="dimension-editor">
        <ExpressionInput
          label={`${kind} dimension`}
          value={expr}
          evaluate={evaluate}
          formatValue={formatValue}
          unitHint={kind === 'angle' ? '°' : 'mm'}
          step={kind === 'angle' ? 5 : 1}
          autoFocus
          showValue={false}
          onPreview={onPreview}
          onCommit={(e) => {
            setEditing(false);
            onCommit?.(e);
            requestAnimationFrame(() => btn.current?.focus());
          }}
          onCancel={onCancel}
          className="[&_input]:text-center"
        />
        {/* Esc with nothing to revert, or a click away: close without committing. */}
        <EscapeCatcher
          onEscape={() => {
            setEditing(false);
            onCancel?.();
            requestAnimationFrame(() => btn.current?.focus());
          }}
        />
      </div>
    );
  }

  return (
    <button
      ref={btn}
      type="button"
      style={pos}
      data-kind={kind}
      data-driving={driving}
      aria-label={`${driving ? 'Dimension' : 'Reference dimension'}: ${prefix[kind] ?? ''}${text}. ${driving ? 'Press Enter to edit.' : 'Measured, not editable.'}`}
      aria-pressed={selected}
      onClick={() => (driving ? setEditing(true) : onSelect?.())}
      className={cn(
        'tnum absolute z-[1] h-6 rounded-[8px] px-2 text-xs font-semibold whitespace-nowrap transition-colors duration-150',
        conflicting
          ? 'bg-danger-soft text-danger-text shadow-[inset_0_0_0_1.5px_var(--color-danger)]'
          : driving
            ? cn(
                'bg-surface text-fg hover:shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
                selected
                  ? 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
                  : 'shadow-[inset_0_0_0_1px_var(--color-border-strong)]',
              )
            : 'bg-surface/70 font-medium text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border)]',
      )}
    >
      {driving ? null : '('}
      {prefix[kind]}
      {text}
      {driving ? null : ')'}
    </button>
  );
}

/** Closes the editor on Esc when the input has no pending edit (which it handles itself). */
function EscapeCatcher({ onEscape }: { onEscape(): void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [onEscape]);
  return null;
}
