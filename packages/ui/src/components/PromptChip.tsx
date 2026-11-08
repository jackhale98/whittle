import { Crosshair, X } from 'lucide-react';
import { cn, Kbd } from './primitives';

export interface PromptChipProps {
  /** e.g. "Select a face or sketch region". */
  children: string;
  /** Number already picked, shown as a count badge. */
  count?: number;
  onCancel?(): void;
  /** `touch`: 44 px targets (ADR-012 item 6); the chip grows to hold the Esc button. */
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * Act-first-select-second prompt (PLAN 9.2): shown over the viewport after choosing a tool,
 * telling the user what to click. Announced politely; Esc cancels (handled by the host).
 */
export function PromptChip({ children, count, onCancel, size = 'md', className }: PromptChipProps) {
  const touch = size === 'touch';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="prompt-chip"
      className={cn(
        'w-panel pointer-events-auto inline-flex items-center gap-2 rounded-full pl-3.5 text-ui font-medium',
        touch ? 'h-12 pr-0.5' : 'h-10 pr-1.5',
        className,
      )}
    >
      <Crosshair className="w-pulse size-4 shrink-0 text-accent-text" aria-hidden />
      <span>{children}</span>
      {count ? (
        <span className="tnum rounded-full bg-accent px-1.5 text-2xs leading-5 font-semibold text-accent-fg">
          {count}
        </span>
      ) : null}
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Esc: cancel selection"
          className={cn(
            'ml-0.5 flex items-center justify-center gap-1 rounded-full text-2xs text-fg-muted hover:bg-surface-2 hover:text-fg',
            touch ? 'h-11 min-w-11 px-3' : 'h-7 px-2',
          )}
        >
          <Kbd>Esc</Kbd>
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        <span className="w-2" />
      )}
    </div>
  );
}
