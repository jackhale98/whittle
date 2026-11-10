import { FlipHorizontal2, LogOut, Scissors, SlidersHorizontal } from 'lucide-react';
import { cn } from './primitives';

export interface SectionChipProps {
  /** Leaves the section: the cut, this chip and the plane manipulator go. */
  onExit(): void;
  onFlip(): void;
  /** Opens (or closes) the section panel. */
  onEdit(): void;
  /** The panel is open: Edit shows as pressed. */
  editing?: boolean;
  /** The cut is flipped (Flip shows as pressed). */
  flipped?: boolean;
  /** `touch`: 44 px targets on phone and tablet. */
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * The persistent "you are in a section" chip (owner's Section view fixes): a floating pill over the
 * viewport for as long as the cut is on, whether or not the panel is open. Full labels, never
 * truncated; the row wraps instead on a narrow phone. Not modal; Esc also exits (handled by the
 * host).
 */
export function SectionChip({
  onExit,
  onFlip,
  onEdit,
  editing = false,
  flipped = false,
  size = 'md',
  className,
}: SectionChipProps) {
  const touch = size === 'touch';
  const btn = cn(
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-ui font-medium whitespace-nowrap transition-colors duration-fast select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    touch ? 'min-h-11 min-w-11' : 'h-9',
  );
  return (
    <fieldset
      aria-label="Section view"
      data-testid="section-chip"
      className={cn(
        'w-panel pointer-events-auto m-0 flex border-0 w-max max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-center gap-1 rounded-[1.75rem] p-1 pl-3.5',
        className,
      )}
    >
      <span className="flex items-center gap-1.5 pr-1.5 text-ui font-semibold text-fg">
        <Scissors className="size-4 shrink-0 text-accent-text" aria-hidden />
        Section
      </span>
      <button
        type="button"
        onClick={onFlip}
        aria-pressed={flipped}
        data-testid="section-chip-flip"
        className={cn(
          btn,
          flipped
            ? 'bg-accent-soft text-accent-text'
            : 'bg-surface-2 text-fg hover:bg-surface-3 active:bg-surface-3',
        )}
      >
        <FlipHorizontal2 className="size-4" aria-hidden />
        Flip
      </button>
      <button
        type="button"
        onClick={onEdit}
        aria-pressed={editing}
        data-testid="section-chip-edit"
        className={cn(
          btn,
          editing
            ? 'bg-accent-soft text-accent-text'
            : 'bg-surface-2 text-fg hover:bg-surface-3 active:bg-surface-3',
        )}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        Edit
      </button>
      <button
        type="button"
        onClick={onExit}
        data-testid="section-chip-exit"
        aria-keyshortcuts="Escape"
        title={touch ? undefined : 'Exit section (Esc)'}
        className={cn(btn, 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95')}
      >
        <LogOut className="size-4" aria-hidden />
        Exit section
      </button>
    </fieldset>
  );
}
