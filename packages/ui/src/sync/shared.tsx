import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
} from 'react';
import { cn } from '../components/primitives';

/** Control density: `touch` = 44 px targets and 16 px input text (no iOS focus-zoom). */
export type SyncDensity = 'compact' | 'touch';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", else a short date. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  const d = Math.max(0, now - t);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 14 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Compact variant: "5m", "3h", "2d". */
export function relativeTimeShort(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.max(0, now - t);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const inputClass = (density: SyncDensity) =>
  cn(
    'w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-fg shadow-[inset_0_0_0_1px_var(--color-border-strong)] outline-none transition-shadow duration-fast placeholder:text-fg-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--color-danger)]',
    // 16 px on touch: iOS Safari zooms into smaller inputs.
    density === 'touch' ? 'h-11 text-base' : 'h-8 text-ui',
  );

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> {
  label: string;
  density?: SyncDensity;
  hint?: ReactNode;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

/** Labelled text input with an optional hint and an inline error (aria-describedby). */
export function TextField({
  label,
  density = 'compact',
  hint,
  error,
  inputRef,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const uid = useId();
  const inputId = id ?? `${uid}-in`;
  const hintId = `${uid}-hint`;
  const errId = `${uid}-err`;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(hint ? hintId : null, error ? errId : null) || undefined}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={inputClass(density)}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-2xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-2xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Small pill. `tone` picks the semantic soft fill; text is never colour-only. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-2xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-surface-3 text-fg-muted',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'success' && 'bg-success-soft text-success-text',
        tone === 'warning' && 'bg-warning-soft text-warning-text',
        tone === 'danger' && 'bg-danger-soft text-danger-text',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Panel chrome shared by the sync panels: a region labelled by its heading. */
export function PanelShell({
  title,
  actions,
  density,
  className,
  testId,
  children,
  onKeyDown,
}: {
  title: string;
  actions?: ReactNode;
  density: SyncDensity;
  className?: string;
  testId?: string;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      data-density={density}
      onKeyDown={onKeyDown}
      className={cn('flex min-w-0 flex-col text-fg', className)}
    >
      <header className="flex min-h-10 items-center justify-between gap-2 px-4 pt-3 pb-1">
        <h2 id={id} className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          {title}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export const rowBtn = (density: SyncDensity) =>
  cn(
    'inline-flex items-center justify-center gap-1.5 rounded-control px-3 font-medium whitespace-nowrap transition-colors duration-fast select-none disabled:opacity-45',
    density === 'touch' ? 'min-h-11 text-sm' : 'min-h-8 text-ui',
  );
