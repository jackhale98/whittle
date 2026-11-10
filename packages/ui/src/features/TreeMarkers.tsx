import { GripHorizontal } from 'lucide-react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { cn } from '../components/primitives';
import type { Slot } from './treeDrag';

/** The line that shows where a dragged row will land (and what it does to folders). */
export function DropIndicator({
  slot,
  indentPx,
  folder,
}: {
  slot: Pick<Slot, 'kind' | 'y'>;
  indentPx: number;
  folder: string;
}) {
  return (
    <div
      aria-hidden
      data-testid="drop-indicator"
      data-kind={slot.kind}
      className="pointer-events-none absolute right-2 left-2 z-[4] flex items-center transition-[top] duration-fast"
      style={{
        top: slot.y - 1,
        left: slot.kind === 'into' || slot.kind === 'stay' ? 8 + indentPx : 8,
      }}
    >
      <span
        className={cn(
          'h-0.5 flex-1 rounded-full',
          slot.kind === 'out' ? 'bg-warning' : 'bg-accent',
        )}
      />
      {slot.kind === 'into' || slot.kind === 'out' ? (
        <span
          className={cn(
            'ml-1 rounded-full px-1.5 text-2xs leading-4 font-medium whitespace-nowrap',
            slot.kind === 'out'
              ? 'bg-warning-soft text-warning-text'
              : 'bg-accent-soft text-accent-text',
          )}
        >
          {slot.kind === 'out' ? 'Out of' : 'Into'} {folder}
        </span>
      ) : null}
    </div>
  );
}

/** The rollback bar: a focusable splitter between the active and the rolled-back features. */
export function RollbackBar({
  count,
  rollback,
  valueText,
  y,
  dragging,
  touch,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onKeyDown,
}: {
  count: number;
  rollback: number;
  valueText: string;
  y: number;
  dragging: boolean;
  touch: boolean;
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerEnd(): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA splitter, not an <hr>
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Rollback bar"
      aria-valuemin={0}
      aria-valuemax={count}
      aria-valuenow={rollback}
      aria-valuetext={valueText}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      data-testid="rollback-bar"
      className={cn(
        'group/bar absolute right-0 left-0 z-[3] flex cursor-row-resize touch-none items-center outline-none',
        touch ? 'h-11' : 'h-3.5',
        !dragging && 'transition-[top] duration-fast',
      )}
      style={{ top: y - (touch ? 22 : 7) }}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none mx-2 flex-1 rounded-full transition-colors duration-fast',
          rollback < count ? 'h-[3px] bg-warning' : 'h-0.5 bg-accent/55 group-hover/bar:bg-accent',
          'group-focus-visible/bar:bg-accent group-focus-visible/bar:shadow-[0_0_0_3px_var(--color-accent-soft)]',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 h-3.5 w-1.5 rounded-full',
          rollback < count ? 'bg-warning' : 'bg-accent',
        )}
      />
      {touch ? (
        <span
          aria-hidden
          data-testid="rollback-grab"
          className={cn(
            'pointer-events-none absolute left-1/2 flex h-6 w-12 -translate-x-1/2 items-center justify-center rounded-full text-accent-fg shadow-float',
            rollback < count ? 'bg-warning' : 'bg-accent',
          )}
        >
          <GripHorizontal className="size-4" />
        </span>
      ) : null}
    </div>
  );
}
