import type { Id, SketchConflict, SuggestedFix } from '@whittle/contracts';
import { CircleAlert, Wand2, X } from 'lucide-react';
import { Button, cn, IconButton } from '../components/primitives';

export interface ConflictPanelProps {
  conflicts: readonly SketchConflict[];
  /** Friendly name for a constraint id ("Horizontal 3", "D2"); defaults to the id. */
  constraintName?(id: Id): string;
  /** One-click fix. `conflictIndex` is the card the fix belongs to. */
  onFix(fix: SuggestedFix, conflictIndex: number): void;
  /** Hover / focus on a card: highlight these constraints in the sketch (null = clear). */
  onHighlight?(ids: readonly Id[] | null): void;
  onDismiss?(): void;
  className?: string;
}

/**
 * Over-constrained diagnostics (PLAN 2.1): the minimal conflicting set explained in plain language,
 * with suggested fixes as one-click buttons. The first fix of each conflict is the primary action.
 */
export default function ConflictPanel({
  conflicts,
  constraintName = (id) => id,
  onFix,
  onHighlight,
  onDismiss,
  className,
}: ConflictPanelProps) {
  if (conflicts.length === 0) return null;
  return (
    <section
      aria-label="Sketch conflicts"
      data-testid="conflict-panel"
      className={cn(
        'w-panel pointer-events-auto flex w-[min(340px,100%)] flex-col overflow-hidden',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden />
        <h2 className="flex-1 text-ui font-semibold">
          {conflicts.length === 1
            ? 'This sketch is over-constrained'
            : `${conflicts.length} conflicts`}
        </h2>
        {onDismiss ? (
          <IconButton
            label="Dismiss conflicts"
            icon={<X className="size-4" />}
            onClick={onDismiss}
          />
        ) : null}
      </header>
      <ul className="m-0 flex max-h-[min(60vh,420px)] list-none flex-col gap-2 overflow-y-auto p-2.5">
        {conflicts.map((c, i) => (
          <li
            key={c.constraints.join('|') || c.explanation}
            onMouseEnter={() => onHighlight?.(c.constraints)}
            onMouseLeave={() => onHighlight?.(null)}
            onFocus={() => onHighlight?.(c.constraints)}
            onBlur={() => onHighlight?.(null)}
            className="list-none rounded-control bg-danger-soft/60 p-2.5 shadow-[inset_0_0_0_1px_var(--color-danger)]/30"
          >
            <p className="text-ui leading-5 text-fg">{c.explanation}</p>
            <p className="mt-1.5 flex flex-wrap gap-1">
              {c.constraints.map((id) => (
                <span
                  key={id}
                  className="rounded-full bg-surface px-2 py-0.5 text-2xs font-medium text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border)]"
                >
                  {constraintName(id)}
                </span>
              ))}
            </p>
            {c.fixes.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.fixes.map((f, j) => (
                  <Button
                    key={f.label}
                    variant={j === 0 ? 'primary' : 'secondary'}
                    icon={j === 0 ? <Wand2 className="size-3.5" /> : undefined}
                    onClick={() => onFix(f, i)}
                    className="h-8"
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-fg-muted">
                Remove one of these constraints to continue.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
