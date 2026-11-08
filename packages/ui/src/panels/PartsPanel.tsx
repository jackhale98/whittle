import { Box, Eye, EyeOff } from 'lucide-react';
import { cn } from '../components/primitives';
import { EmptyState } from '../shells/shared';

export interface PartListItem {
  id: string;
  name: string;
  visible: boolean;
  /** CSS colour of the part's material swatch. */
  color?: string;
}

export interface PartsPanelProps {
  parts: readonly PartListItem[];
  selectedId?: string | null;
  onSelect?(id: string): void;
  onToggleVisible?(id: string, visible: boolean): void;
  className?: string;
}

/** Parts list (phone sheet): tap a part to focus it, the eye hides or shows it. */
export function PartsPanel({
  parts,
  selectedId,
  onSelect,
  onToggleVisible,
  className,
}: PartsPanelProps) {
  if (parts.length === 0) {
    return (
      <EmptyState icon={Box} title="No parts yet">
        Parts in this document will be listed here. Tap one to focus it.
      </EmptyState>
    );
  }
  return (
    <ul
      aria-label="Parts"
      data-testid="parts-list"
      className={cn('m-0 flex list-none flex-col gap-1 px-3 pb-4', className)}
    >
      {parts.map((p) => {
        const on = selectedId === p.id;
        return (
          <li
            key={p.id}
            data-part-id={p.id}
            className={cn(
              'flex min-h-14 items-center rounded-control transition-colors duration-fast',
              on ? 'bg-accent-soft' : 'bg-surface-2',
            )}
          >
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onSelect?.(p.id)}
              className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-control pl-3 text-left"
            >
              <span
                aria-hidden
                className="size-7 shrink-0 rounded-lg shadow-[inset_0_0_0_1px_rgb(15_23_42/0.14)]"
                style={{ background: p.color ?? 'var(--color-surface-3)' }}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-sm font-medium',
                  p.visible ? 'text-fg' : 'text-fg-muted line-through',
                )}
              >
                {p.name}
              </span>
            </button>
            <button
              type="button"
              aria-label={`${p.visible ? 'Hide' : 'Show'} ${p.name}`}
              aria-pressed={!p.visible}
              onClick={() => onToggleVisible?.(p.id, !p.visible)}
              className="flex size-14 shrink-0 items-center justify-center rounded-control text-fg-muted active:bg-surface-3"
            >
              {p.visible ? (
                <Eye className="size-5" aria-hidden />
              ) : (
                <EyeOff className="size-5" aria-hidden />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
