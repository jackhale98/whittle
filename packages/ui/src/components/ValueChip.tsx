import type { EvalResult, Expr } from '@wren-cad/contracts';
import { m } from 'motion/react';
import { useRef, useState } from 'react';
import type { FormatValue } from '../format';
import { useSpring } from '../motion';
import { ExpressionInput } from './ExpressionInput';
import { cn } from './primitives';
import { useAnchored } from './useAnchored';

export interface ValueChipProps {
  /** Screen point (px, relative to the viewport stage) the chip follows, e.g. the drag handle. */
  point: { x: number; y: number } | null;
  /** Current value as an expression (`"12.5mm"`). */
  value: Expr;
  /** Text shown on the chip; defaults to `value`. */
  display?: string;
  /** What is being adjusted, e.g. "Distance". Used in the accessible name. */
  label?: string;
  /** True while the finger / pointer is still dragging: the chip only follows and is not tappable. */
  dragging: boolean;
  /** An exact value was typed (or the keypad's Enter was pressed). */
  onCommit(expr: Expr): void;
  /** Typing was abandoned (Escape, or focus left without a change). */
  onCancel?(): void;
  onPreview?(expr: Expr): void;
  evaluate?(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  unitHint?: string;
  step?: number;
  className?: string;
}

/**
 * Push/pull value label (PLAN 9.2 "Inline values"). While dragging it floats beside the handle
 * and never covers it. Tap it to type an exact value: expressions and mixed units are accepted and
 * the inline keypad opens on touch.
 */
export function ValueChip({
  point,
  value,
  display,
  label = 'Value',
  dragging,
  onCommit,
  onCancel,
  onPreview,
  evaluate,
  formatValue,
  unitHint,
  step,
  className,
}: ValueChipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const done = useRef(false);
  const spring = useSpring('fast');
  // Freeze the anchor while typing so the chip does not slide away from under the keypad.
  const frozen = useRef(point);
  if (!editing) frozen.current = point;
  const placement = useAnchored(ref, editing ? frozen.current : point, {
    preferred: 'right',
    gap: 6,
    anchorRadius: 22,
  });
  const text = display ?? value;
  const show = !!point && !!placement;

  function stop(cancel: boolean) {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (cancel) onCancel?.();
  }

  return (
    <div
      ref={ref}
      data-testid="value-chip"
      data-dragging={dragging || undefined}
      data-editing={editing || undefined}
      hidden={!point}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: placement
          ? `translate3d(${placement.left}px, ${placement.top}px, 0)`
          : undefined,
        visibility: show ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-[var(--z-panel)]',
        dragging ? 'pointer-events-none' : 'pointer-events-auto',
        className,
      )}
    >
      <m.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={spring}
      >
        {editing ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: focusout/Escape delegation for the field inside
          <div
            className="w-panel w-[min(240px,calc(100vw-24px))] p-1.5"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) stop(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                stop(true);
              }
            }}
          >
            <ExpressionInput
              autoFocus
              size="touch"
              label={label}
              value={value}
              evaluate={evaluate}
              formatValue={formatValue}
              unitHint={unitHint}
              step={step}
              keypad="auto"
              onPreview={onPreview}
              onCancel={onCancel}
              onCommit={(expr) => {
                onCommit(expr);
                stop(false);
              }}
              testId="value-chip-input"
            />
          </div>
        ) : dragging ? (
          <div
            aria-hidden
            className="w-panel tnum flex h-9 items-center rounded-full px-3.5 text-sm font-semibold text-fg"
          >
            {text}
          </div>
        ) : (
          <button
            type="button"
            aria-label={`${label} ${text}. Tap to type an exact value`}
            onClick={() => {
              done.current = false;
              setEditing(true);
            }}
            className="w-panel tnum flex h-11 min-w-11 items-center rounded-full px-4 text-sm font-semibold text-accent-text transition-colors duration-fast active:bg-surface-2"
          >
            {text}
          </button>
        )}
      </m.div>
    </div>
  );
}
