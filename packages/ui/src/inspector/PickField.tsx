import type { EntityRef, UnresolvedRef } from '@whittle/contracts';
import { Crosshair, Plus, RefreshCw, X } from 'lucide-react';
import { cn } from '../components/primitives';

export const defaultDescribeRef = (r: EntityRef): string =>
  `${r.kind[0]?.toUpperCase()}${r.kind.slice(1)} ${r.name}`;

export interface PickFieldProps {
  /** JSON pointer of the ref (or ref array) inside the feature, e.g. `/edges`. */
  path: string;
  refs: readonly EntityRef[];
  /** Several refs allowed; shows an "add" chip even when filled. */
  multi?: boolean;
  /** Noun used in prompts: "face or sketch region". */
  accepts: string;
  /** This field is the one currently being picked in the viewport. */
  picking: boolean;
  unresolved?: readonly UnresolvedRef[];
  describeRef?(ref: EntityRef): string;
  /** `path` is `/edges` to add, or `/edges/2` to replace that entry. */
  onPick?(path: string): void;
  onRemove?(index: number): void;
  label: string;
}

/**
 * Selected-geometry chips with a "pick" affordance. Unresolved references are never guessed:
 * they show an amber "needs attention" chip with a re-pick button (PLAN 7.3).
 */
export function PickField({
  path,
  refs,
  multi,
  accepts,
  picking,
  unresolved,
  describeRef = defaultDescribeRef,
  onPick,
  onRemove,
  label,
}: PickFieldProps) {
  const showAdd = multi || refs.length === 0;
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-wrap gap-1.5 p-0"
      data-testid={`pick-${path.slice(1).replace(/\//g, '-')}`}
    >
      {refs.map((r, i) => {
        const bad = unresolved?.find(
          (u) => u.path === `${path}/${i}` || (!multi && u.path === path),
        );
        const text = describeRef(r);
        return (
          <li key={`${r.kind}:${r.name}`} className="list-none">
            <span
              data-state={bad ? 'needs-attention' : 'ok'}
              className={cn(
                'inline-flex h-7 max-w-full items-center gap-1 rounded-full pr-1 pl-2.5 text-xs font-medium',
                bad
                  ? 'bg-warning-soft text-warning-text shadow-[inset_0_0_0_1px_var(--color-warning)]'
                  : 'bg-accent-soft text-accent-text',
              )}
            >
              <span className="max-w-[16ch] truncate" title={text}>
                {text}
              </span>
              {bad ? (
                <button
                  type="button"
                  onClick={() => onPick?.(`${path}${multi ? `/${i}` : ''}`)}
                  aria-label={`Re-pick ${text} (${bad.reason === 'ambiguous' ? 'ambiguous' : 'missing'})`}
                  className="inline-flex h-5 items-center gap-1 rounded-full bg-warning/20 px-1.5 text-2xs font-semibold hover:bg-warning/30"
                >
                  <RefreshCw className="size-3" aria-hidden />
                  Re-pick
                </button>
              ) : null}
              {!multi && !bad ? (
                <button
                  type="button"
                  aria-pressed={picking}
                  onClick={() => onPick?.(path)}
                  aria-label={`Change ${text}`}
                  className={cn(
                    'inline-flex h-5 items-center rounded-full px-1.5 text-2xs font-semibold hover:bg-black/10 dark:hover:bg-white/10',
                    picking && 'bg-accent text-accent-fg hover:bg-accent',
                  )}
                >
                  {picking ? `Select a ${accepts}` : 'Change'}
                </button>
              ) : null}
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${text}`}
                  className="flex size-5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </span>
          </li>
        );
      })}
      {showAdd ? (
        <li className="list-none">
          <button
            type="button"
            aria-pressed={picking}
            onClick={() => onPick?.(path)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-150',
              picking
                ? 'bg-accent text-accent-fg'
                : 'text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border-strong)] hover:bg-surface-2 hover:text-fg',
            )}
          >
            {picking ? (
              <Crosshair className="w-pulse size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {picking ? `Select a ${accepts}` : refs.length ? 'Add' : `Pick ${accepts}`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
