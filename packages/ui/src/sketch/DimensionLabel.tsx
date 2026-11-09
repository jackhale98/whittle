import type { EvalResult, Expr, SketchConstraintKind } from '@whittle/contracts';
import { useEffect, useRef, useState } from 'react';
import { ExpressionInput } from '../components/ExpressionInput';
import { cn } from '../components/primitives';
import { defaultFormatValue, type FormatValue } from '../format';
import { ConstraintGlyph } from './ConstraintGlyph';

type DimKind = Extract<
  SketchConstraintKind,
  'distance' | 'hDistance' | 'vDistance' | 'length' | 'radius' | 'diameter' | 'angle' | 'offset'
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
  /** Driving ↔ reference (shown while editing, or when the label is selected). */
  onToggleDriving?(): void;
  /** Radius ↔ diameter, for circles and arcs. */
  onToggleKind?(): void;
}

/** Small actions under a label: radius/diameter and driving/reference toggles. */
function LabelActions({
  kind,
  driving,
  onToggleDriving,
  onToggleKind,
  onDone,
}: {
  kind: DimKind;
  driving: boolean;
  onToggleDriving?: () => void;
  onToggleKind?: () => void;
  onDone?: () => void;
}) {
  if (!onToggleDriving && !onToggleKind) return null;
  const chip =
    'pointer-events-auto inline-flex h-6 items-center rounded-full bg-surface px-2 text-2xs font-semibold text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border-strong)] hover:text-fg';
  return (
    <div
      role="toolbar"
      aria-label="Dimension options"
      className="mt-1 flex justify-center gap-1"
      data-testid="dimension-actions"
      // Keep focus in the editor: these act on the dimension, they don't end the edit.
      onMouseDown={(e) => e.preventDefault()}
    >
      {onToggleKind && (kind === 'radius' || kind === 'diameter') ? (
        <button
          type="button"
          className={chip}
          data-testid="dimension-toggle-kind"
          aria-label={kind === 'radius' ? 'Show as diameter' : 'Show as radius'}
          onClick={() => onToggleKind()}
        >
          {kind === 'radius' ? 'R → Ø' : 'Ø → R'}
        </button>
      ) : null}
      {onToggleDriving ? (
        <button
          type="button"
          className={chip}
          data-testid="dimension-toggle-driving"
          aria-label={driving ? 'Make reference dimension' : 'Make driving dimension'}
          onClick={() => {
            onToggleDriving();
            onDone?.();
          }}
        >
          {driving ? '(Reference)' : 'Driving'}
        </button>
      ) : null}
    </div>
  );
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
  onToggleDriving,
  onToggleKind,
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
      // biome-ignore lint/a11y/noStaticElementInteractions: Enter bubbling from the input
      <div
        className="pointer-events-auto absolute z-[2] w-44"
        style={pos}
        data-testid="dimension-editor"
        onKeyDown={(e) => {
          // Enter on an unchanged value (keep the measured one) also closes the editor.
          const t = e.target as HTMLInputElement;
          if (e.key === 'Enter' && t.tagName === 'INPUT' && t.value.trim() === expr.trim()) {
            setEditing(false);
            onCancel?.();
            requestAnimationFrame(() => btn.current?.focus());
          }
        }}
      >
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
        <LabelActions
          kind={kind}
          driving={driving}
          {...(onToggleDriving ? { onToggleDriving } : {})}
          {...(onToggleKind ? { onToggleKind } : {})}
          onDone={() => setEditing(false)}
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

  const label = (
    <button
      ref={btn}
      type="button"
      style={pos}
      data-kind={kind}
      data-driving={driving}
      aria-label={`${kind === 'offset' ? (driving ? 'Offset dimension' : 'Reference offset') : driving ? 'Dimension' : 'Reference dimension'}: ${prefix[kind] ?? ''}${text}. ${driving ? 'Press Enter to edit.' : 'Measured, not editable.'}`}
      aria-pressed={selected}
      onClick={() => (driving ? setEditing(true) : onSelect?.())}
      className={cn(
        'tnum pointer-events-auto absolute z-[1] h-6 rounded-[8px] px-2 text-xs font-semibold whitespace-nowrap transition-colors duration-fast',
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
      {kind === 'offset' ? (
        <ConstraintGlyph
          kind="offset"
          size={14}
          tone="plain"
          className="mr-1 inline-block align-[-3px]"
        />
      ) : null}
      {prefix[kind]}
      {text}
      {driving ? null : ')'}
    </button>
  );
  if (!selected || (!onToggleDriving && !onToggleKind)) return label;
  return (
    <>
      {label}
      <div
        className="absolute z-[2]"
        style={{ left: x, top: y + 14, transform: 'translateX(-50%)' }}
      >
        <LabelActions
          kind={kind}
          driving={driving}
          {...(onToggleDriving ? { onToggleDriving } : {})}
          {...(onToggleKind ? { onToggleKind } : {})}
        />
      </div>
    </>
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
