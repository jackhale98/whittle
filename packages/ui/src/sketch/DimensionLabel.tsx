import type { EvalResult, Expr, SketchConstraintKind } from '@wren-cad/contracts';
import { Trash2 } from 'lucide-react';
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
  /**
   * Select the dimension. When given, a click selects and a click on the selected label (or a
   * double-click, or Enter) edits, as in other CAD sketchers; without it a click edits at once.
   */
  onSelect?(): void;
  /** Delete the dimension: Delete / Backspace on the label, or the Delete chip when selected. */
  onDelete?(): void;
  /** Driving ↔ reference (shown while editing, or when the label is selected). */
  onToggleDriving?(): void;
  /** Radius ↔ diameter, for circles and arcs. */
  onToggleKind?(): void;
  /**
   * Drag the label (mouse, touch, pen) past a small slop: called with the new centre in the same
   * px space as `x`, `y`. It only moves the label position, never the value. A tap still edits.
   */
  onMove?(x: number, y: number): void;
  /** The drag ended (commit the position as one undo step). */
  onMoveEnd?(x: number, y: number): void;
}

/** Pointer travel (px) before a press on a label becomes a drag instead of a tap. */
const DRAG_SLOP = 4;

/** Small actions under a label: radius/diameter and driving/reference toggles. */
function LabelActions({
  kind,
  driving,
  onToggleDriving,
  onToggleKind,
  onDelete,
  onDone,
}: {
  kind: DimKind;
  driving: boolean;
  onToggleDriving?: () => void;
  onToggleKind?: () => void;
  onDelete?: () => void;
  onDone?: () => void;
}) {
  if (!onToggleDriving && !onToggleKind && !onDelete) return null;
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
      {onDelete ? (
        <button
          type="button"
          className={cn(chip, 'hover:text-danger-text')}
          data-testid="dimension-delete"
          aria-label="Delete dimension"
          onClick={() => {
            onDone?.();
            onDelete();
          }}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

const prefix: Partial<Record<DimKind, string>> = { radius: 'R', diameter: 'Ø' };

/**
 * HTML label for a sketch dimension, positioned over the canvas by the host. Click selects; a
 * second click, double-click or Enter edits the expression inline (units and params allowed);
 * Delete removes it. Reference dimensions are shown in
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
  onDelete,
  onToggleDriving,
  onToggleKind,
  onMove,
  onMoveEnd,
}: DimensionLabelProps) {
  const [editing, setEditing] = useState(!!autoEdit && driving);
  const btn = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    id: number;
    px: number;
    py: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const justDragged = useRef(false);
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
          {...(onDelete ? { onDelete } : {})}
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
      data-draggable={onMove ? '' : undefined}
      onPointerDown={(e) => {
        if (!onMove || (e.pointerType === 'mouse' && e.button !== 0)) return;
        drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x, y, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        d.moved = true;
        onMove?.(d.x + dx, d.y + dy);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.id !== e.pointerId || !d.moved) return;
        justDragged.current = true;
        onMoveEnd?.(d.x + e.clientX - d.px, d.y + e.clientY - d.py);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClick={() => {
        if (justDragged.current) {
          justDragged.current = false; // the click that ends a drag is not a tap
          return;
        }
        // Click selects; a click on the selected label edits (no selection model: click edits).
        if (driving && (selected || !onSelect)) setEditing(true);
        else onSelect?.();
      }}
      onDoubleClick={() => {
        if (driving) setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && driving) {
          e.preventDefault();
          setEditing(true);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
          e.preventDefault();
          onDelete();
        }
      }}
      className={cn(
        'tnum pointer-events-auto absolute z-[1] h-6 touch-none rounded-[8px] px-2 text-xs font-semibold whitespace-nowrap transition-colors duration-fast',
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
  if (!selected || (!onToggleDriving && !onToggleKind && !onDelete)) return label;
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
          {...(onDelete ? { onDelete } : {})}
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
