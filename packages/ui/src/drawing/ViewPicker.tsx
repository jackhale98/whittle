import { cn } from '../components/primitives';

export type BaseViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

const NAMES: readonly { id: BaseViewName; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'top', label: 'Top' },
  { id: 'right', label: 'Right' },
  { id: 'back', label: 'Back' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'left', label: 'Left' },
];

/** A cube with the face being looked at filled: the pictogram of a standard view. */
export function ViewGlyph({ name, className }: { name: BaseViewName | 'iso'; className?: string }) {
  // The cube in a fixed oblique projection; the highlighted polygon is the face seen.
  const front = '6,14 22,14 22,30 6,30';
  const top = '6,14 12,8 28,8 22,14';
  const right = '22,14 28,8 28,24 22,30';
  const hot: Record<string, string> = {
    front,
    top,
    right,
    back: '12,8 28,8 28,24 12,24',
    bottom: '6,30 22,30 28,24 12,24',
    left: '6,14 12,8 12,24 6,30',
  };
  return (
    <svg viewBox="0 0 34 36" className={cn('size-8', className)} aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
        <polygon points={front} />
        <polygon points={top} />
        <polygon points={right} />
      </g>
      {name === 'iso' ? (
        <g fill="currentColor" fillOpacity="0.18">
          <polygon points={front} />
          <polygon points={top} />
          <polygon points={right} />
        </g>
      ) : (
        <polygon points={hot[name]} fill="var(--color-accent)" fillOpacity="0.45" />
      )}
    </svg>
  );
}

export interface ViewPickerProps {
  /** A standard view chosen: a new base view. */
  onPick(name: BaseViewName): void;
  /** Disabled with a reason (e.g. nothing to draw yet). */
  disabledReason?: string;
  size?: 'md' | 'touch';
}

/** The base view picker: the six standard orientations as one-tap pictograms. */
export function ViewPicker({ onPick, disabledReason, size = 'md' }: ViewPickerProps) {
  return (
    <fieldset
      className="m-0 min-w-0 border-0 p-0"
      aria-label="Add a base view"
      data-testid="view-picker"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {NAMES.map((n) => (
          <button
            key={n.id}
            type="button"
            data-view={n.id}
            disabled={disabledReason !== undefined}
            title={disabledReason}
            onClick={() => onPick(n.id)}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 rounded-control bg-surface-2 text-fg transition-colors duration-fast hover:bg-surface-3 active:bg-surface-3 disabled:opacity-45',
              size === 'touch' ? 'min-h-16' : 'min-h-14',
            )}
          >
            <ViewGlyph name={n.id} />
            <span className="text-2xs font-medium">{n.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
