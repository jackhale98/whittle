import { Ruler } from 'lucide-react';
import { Button, cn } from '../components/primitives';
import { EmptyState } from './EmptyState';

export interface ImportRow {
  key: string;
  /** What it is: `Width`, `Ø6 hole`, a datum. */
  title: string;
  /** Where it comes from or where it goes. */
  detail: string;
  /** `promote`: a driving dimension of the model, made into an annotation by placing it. */
  kind: 'existing' | 'promote';
  /** Why it cannot be placed (no suitable view, needs attention, suppressed). */
  reason?: string;
  /** The view it will go on. */
  viewName?: string;
}

export interface ImportPanelProps {
  rows: readonly ImportRow[];
  checked: ReadonlySet<string>;
  onToggle(key: string, on: boolean): void;
  onAll(on: boolean): void;
  alreadyPlaced: number;
  /** Driving values import cannot promote yet. */
  notPromotable: readonly string[];
  onPlace(): void;
  onCancel(): void;
  size?: 'md' | 'touch';
}

/**
 * "Import model annotations": the model's dimensions and annotations, each on the view that shows
 * it true-length. Promoted driving dimensions start unchecked (they carry no tolerance); nothing
 * is placed twice, and anything without a suitable view says why. One tap places the checked
 * ones as one undo step.
 */
export function ImportPanel({
  rows,
  checked,
  onToggle,
  onAll,
  alreadyPlaced,
  notPromotable,
  onPlace,
  onCancel,
  size = 'md',
}: ImportPanelProps) {
  const placeable = rows.filter((r) => r.reason === undefined);
  const n = placeable.filter((r) => checked.has(r.key)).length;
  const touch = size === 'touch';
  if (rows.length === 0) {
    return (
      <EmptyState icon={Ruler} title="Nothing to import">
        {alreadyPlaced > 0
          ? `The ${alreadyPlaced} annotation${alreadyPlaced === 1 ? '' : 's'} of this part ${alreadyPlaced === 1 ? 'is' : 'are'} already on this drawing.`
          : 'The model has no dimensions or annotations yet. Use the Dimension tool to add one.'}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-4" data-testid="import-panel">
      <p className="text-xs text-fg-muted">
        Each goes on the view that shows it true-length. Nothing is placed twice
        {alreadyPlaced > 0 ? ` (${alreadyPlaced} already on this drawing)` : ''}.
      </p>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-xs text-accent-text underline"
          onClick={() => onAll(n < placeable.length)}
        >
          {n < placeable.length ? 'Check all' : 'Uncheck all'}
        </button>
        <span className="tnum text-xs text-fg-muted" aria-live="polite">
          {n} of {placeable.length} checked
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Annotations to place">
        {rows.map((r) => {
          const off = r.reason !== undefined;
          return (
            <li key={r.key}>
              <label
                className={cn(
                  'flex items-start gap-2.5 rounded-control bg-surface-2 px-2.5 py-2',
                  touch && 'min-h-14',
                  off && 'opacity-70',
                )}
              >
                <input
                  type="checkbox"
                  data-import={r.key}
                  disabled={off}
                  checked={!off && checked.has(r.key)}
                  onChange={(e) => onToggle(r.key, e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui font-medium">{r.title}</span>
                  <span className="truncate text-2xs text-fg-muted">
                    {off ? r.reason : `${r.detail}${r.viewName ? ` → ${r.viewName}` : ''}`}
                  </span>
                </span>
                {r.kind === 'promote' && !off ? (
                  <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-2xs text-fg-muted">
                    from the model
                  </span>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      {notPromotable.length > 0 ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">
            {notPromotable.length} driving value{notPromotable.length === 1 ? '' : 's'} cannot be
            imported yet
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {notPromotable.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="mt-1">Use the Dimension tool to add them by hand.</p>
        </details>
      ) : null}
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size={touch ? 'touch' : 'md'}
          disabled={n === 0}
          onClick={onPlace}
          data-testid="import-place"
          className="flex-1"
        >
          Place {n} annotation{n === 1 ? '' : 's'}
        </Button>
        <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
