import type { Id, SketchConflict, SuggestedFix } from '@wren-cad/contracts';
import { CircleAlert, Wand2, X } from 'lucide-react';
import { Button, cn, IconButton } from '../components/primitives';

export interface ConflictPanelProps {
  conflicts: readonly SketchConflict[];
  /**
   * Named constraint for an id: the explain label ("Horizontal (Line 3)", "Angle 30° (Line 1, Line
   * 2)"). A bare id is never shown: without a name the chip reads "Unnamed constraint".
   */
  constraintName?(id: Id): string | undefined;
  /** Named geometry for an entity id ("Line 3", "the origin"); entities are listed when given. */
  entityName?(id: Id): string | undefined;
  /** One-click fix. `conflictIndex` is the card the fix belongs to. */
  onFix(fix: SuggestedFix, conflictIndex: number): void;
  /** Hover / focus on a card: highlight these constraints in the sketch (null = clear). */
  onHighlight?(ids: readonly Id[] | null): void;
  /** Same moment, the geometry the set acts on (`SketchConflict.entities`); null = clear. */
  onHighlightEntities?(ids: readonly Id[] | null): void;
  onDismiss?(): void;
  className?: string;
}

/**
 * Over-constrained diagnostics (PLAN 2.1): the minimal conflicting set explained in plain language,
 * with suggested fixes as one-click buttons. The first fix of each conflict is the primary action
 * and is marked "Suggested" (ADR-046: usually removing the constraint added last). Constraints are
 * named, never numbered; hovering or focusing a card highlights its constraints and geometry.
 */
export default function ConflictPanel({
  conflicts,
  constraintName,
  entityName,
  onFix,
  onHighlight,
  onHighlightEntities,
  onDismiss,
  className,
}: ConflictPanelProps) {
  if (conflicts.length === 0) return null;
  const nameOf = (id: Id) => {
    const n = constraintName?.(id);
    return n && n !== id ? n : 'Unnamed constraint';
  };
  const highlight = (c: SketchConflict | null) => {
    onHighlight?.(c ? c.constraints : null);
    onHighlightEntities?.(c ? (c.entities ?? []) : null);
  };
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
            ? conflicts[0]?.kind === 'unsupported'
              ? 'This constraint is not supported yet'
              : 'This sketch is over-constrained'
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
            data-testid="conflict-card"
            data-kind={c.kind ?? 'overconstrained'}
            onMouseEnter={() => highlight(c)}
            onMouseLeave={() => highlight(null)}
            onFocus={() => highlight(c)}
            onBlur={() => highlight(null)}
            className="list-none rounded-control bg-danger-soft/60 p-2.5 shadow-[inset_0_0_0_1px_var(--color-danger)]/30"
          >
            <p className="text-ui leading-5 text-fg">{c.explanation}</p>
            <ul
              aria-label="Conflicting constraints"
              className="m-0 mt-1.5 flex list-none flex-wrap gap-1 p-0"
            >
              {c.constraints.map((id) => (
                <li
                  key={id}
                  data-constraint={id}
                  className="rounded-full bg-surface px-2 py-0.5 text-2xs font-medium text-fg-muted shadow-[inset_0_0_0_1px_var(--color-border)]"
                >
                  {nameOf(id)}
                </li>
              ))}
            </ul>
            {entityName && c.entities?.length ? (
              <p className="mt-1.5 text-2xs text-fg-muted" data-testid="conflict-entities">
                Acts on {c.entities.map((id) => entityName(id) ?? 'unnamed geometry').join(', ')}
              </p>
            ) : null}
            {c.fixes.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.fixes.map((f, j) => (
                  <div key={f.label} className="flex max-w-full flex-col items-start gap-0.5">
                    {j === 0 ? (
                      <span
                        data-testid="suggested-label"
                        className="text-2xs font-semibold tracking-wider text-fg-muted uppercase"
                      >
                        Suggested
                      </span>
                    ) : null}
                    <Button
                      variant={j === 0 ? 'primary' : 'secondary'}
                      icon={j === 0 ? <Wand2 className="size-3.5" /> : undefined}
                      onClick={() => onFix(f, i)}
                      data-suggested={j === 0 ? '' : undefined}
                      // Long fix labels ("Make D3 a reference dimension") wrap instead of clipping.
                      className="h-auto! min-h-8 max-w-full shrink! justify-start! py-1.5 text-left leading-4 whitespace-normal!"
                    >
                      <span className="min-w-0 break-words">{f.label}</span>
                    </Button>
                  </div>
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
