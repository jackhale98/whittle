import { CheckCircle2, Info, Link2Off, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, cn } from '../components/primitives';
import { EmptyState } from './EmptyState';

export interface AttentionRow {
  key: string;
  severity: 'attention' | 'warning' | 'info';
  /** Plain language: what is wrong and what it means. Never a stale value. */
  message: string;
  /** The grid zone on the sheet (`C4`). */
  zone?: string;
  sheet?: string;
  /** The annotation or view it is about, for the title. */
  title?: string;
  /** Whether "Reattach…" applies. */
  reattachable?: boolean;
}

export interface AttentionPanelProps {
  rows: readonly AttentionRow[];
  /** Selects the thing on the sheet. */
  onSelect(key: string): void;
  onReattach(key: string): void;
  selectedKey?: string | null;
  size?: 'md' | 'touch';
}

const ICON = {
  attention: TriangleAlert,
  warning: TriangleAlert,
  info: Info,
} as const;

const TONE = {
  attention: 'text-danger-text',
  warning: 'text-warning-text',
  info: 'text-fg-muted',
} as const;

const SEVERITY = { attention: 'Needs attention', warning: 'Check', info: 'Note' } as const;

/**
 * The drawing's needs-attention list: every dimension, frame or view that no longer resolves,
 * with where it is on the sheet and why. Search filters it; "Reattach…" lets the user pick the
 * geometry again (never a guess). An attention item never shows a value.
 */
export function AttentionPanel({
  rows,
  onSelect,
  onReattach,
  selectedKey,
  size = 'md',
}: AttentionPanelProps) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s
      ? rows.filter((r) =>
          [r.message, r.zone ?? '', r.title ?? ''].some((t) => t.toLowerCase().includes(s)),
        )
      : rows;
  }, [rows, q]);
  const touch = size === 'touch';
  const n = rows.filter((r) => r.severity === 'attention').length;
  if (rows.length === 0) {
    return (
      <EmptyState icon={CheckCircle2} title="Everything resolves">
        Every dimension and view on this drawing is attached to geometry.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-4" data-testid="attention-panel">
      <p className="text-xs text-fg-muted" aria-live="polite" data-testid="attention-count">
        {n === 0
          ? 'Nothing needs attention.'
          : `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention.`}
      </p>
      {rows.length > 4 ? (
        <label className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2.5 size-4 text-fg-subtle"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Search the list"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={cn(
              'w-full rounded-control bg-surface-2 pr-2.5 pl-8 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
              touch ? 'h-11' : 'h-8',
            )}
          />
        </label>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Needs attention">
        {shown.map((r) => {
          const Icon = ICON[r.severity];
          const on = selectedKey === r.key;
          return (
            <li
              key={r.key}
              data-severity={r.severity}
              data-attention-key={r.key}
              className={cn(
                'flex flex-col gap-1.5 rounded-control p-2.5',
                r.severity === 'attention'
                  ? 'bg-danger-soft'
                  : r.severity === 'warning'
                    ? 'bg-warning-soft'
                    : 'bg-surface-2',
                on && 'shadow-[inset_0_0_0_2px_var(--color-accent)]',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(r.key)}
                className={cn('flex items-start gap-2 text-left', touch && 'min-h-11')}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[r.severity])} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('text-xs font-semibold', TONE[r.severity])}>
                    {SEVERITY[r.severity]}
                    {r.title ? `: ${r.title}` : ''}
                  </span>
                  <span className="text-ui text-fg">{r.message}</span>
                  {r.zone || r.sheet ? (
                    <span className="tnum text-2xs text-fg-muted">
                      {[r.sheet, r.zone ? `zone ${r.zone}` : undefined].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </span>
              </button>
              {r.reattachable ? (
                <Button
                  variant="secondary"
                  size={touch ? 'touch' : 'md'}
                  icon={<Link2Off className="size-4" />}
                  onClick={() => onReattach(r.key)}
                  data-reattach={r.key}
                  className="self-start"
                >
                  Reattach…
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <p className="text-xs text-fg-muted">No matches.</p> : null}
    </div>
  );
}
