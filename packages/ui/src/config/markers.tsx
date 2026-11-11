import { RotateCcw, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../components/primitives';
import { type EditScope, resolveEditScope } from './model';

/* Override markers, the edit-scope chip and the "Changed in all N" notice (M3.7, research P0 2 and 4). */

export interface OverrideMarkerProps {
  /** Whether the active configuration overrides this field. `false` renders nothing. */
  overridden: boolean;
  /** The active configuration's name, read out as "Overridden in <name>". */
  configurationName: string;
  /** The field's name, so the reset button's name is specific ("Reset Length to default"). */
  fieldLabel?: string;
  /** Removes the override ("Reset to default"). Without it the marker is only a badge. */
  onReset?(): void;
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * A small badge for an inspector, Params or table field that the active configuration overrides,
 * with a "Reset to default" button on it. Never colour alone: an icon and the word "Override".
 * Controlled: the app owns the override and clears it in `onReset` (one `setConfigurationOverrides`
 * edit with no value).
 */
export function OverrideMarker({
  overridden,
  configurationName,
  fieldLabel,
  onReset,
  size = 'md',
  className,
}: OverrideMarkerProps) {
  if (!overridden) return null;
  const touch = size === 'touch';
  return (
    <span
      data-testid="override-marker"
      className={cn(
        'inline-flex shrink-0 items-center overflow-hidden rounded-full bg-warning-soft text-warning-text',
        className,
      )}
    >
      <span
        title={`Overridden in ${configurationName}`}
        className="px-2 text-2xs leading-5 font-medium whitespace-nowrap"
      >
        Override
        <span className="sr-only">{` in ${configurationName}`}</span>
      </span>
      {onReset ? (
        <button
          type="button"
          aria-label={`Reset ${fieldLabel ? `${fieldLabel} ` : ''}to default`}
          title="Reset to default"
          onClick={onReset}
          className={cn(
            'flex items-center justify-center text-warning-text transition-colors duration-fast hover:bg-warning/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            touch ? 'size-11' : 'size-5',
          )}
        >
          <RotateCcw className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------------- edit scope */

export interface ScopeChipProps {
  /** The active configuration's name ("This configuration only" applies to it). */
  configurationName: string;
  /** Whether the active configuration is Default. The chip then renders nothing. */
  activeIsDefault: boolean;
  /** Current choice for the edit in progress. */
  scope: EditScope;
  onScopeChange(scope: EditScope): void;
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * The explicit "This configuration only" toggle next to an editable value, shown only while the
 * active configuration is not Default. It is one-shot by contract (trap T1): the chosen scope
 * applies to the one edit in progress and must be dropped when that edit commits, cancels or the
 * configuration changes. {@link useOneShotScope} implements that; use it, do not keep scope in
 * app state.
 */
export function ScopeChip({
  configurationName,
  activeIsDefault,
  scope,
  onScopeChange,
  size = 'md',
  className,
}: ScopeChipProps) {
  if (activeIsDefault) return null;
  const on = scope === 'configuration';
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid="scope-chip"
      title={`Applies to this edit only; the next edit goes back to all configurations. Active: ${configurationName}.`}
      onClick={() => onScopeChange(on ? 'all' : 'configuration')}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2.5 text-2xs font-medium whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-border)] transition-colors duration-fast focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        on
          ? 'bg-warning-soft text-warning-text shadow-[inset_0_0_0_1px_var(--color-warning)]'
          : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg',
        size === 'touch' ? 'min-h-11 px-3' : 'h-6',
        className,
      )}
    >
      This configuration only
    </button>
  );
}

export interface OneShotScope {
  /** The scope for the edit in progress. */
  scope: EditScope;
  setScope(scope: EditScope): void;
  /**
   * Call once when the edit commits. Returns the scope to apply and resets to `all`
   * (so the next edit never inherits a choice).
   */
  consume(): EditScope;
  /** Call when the edit is cancelled or the field loses focus without a commit. */
  reset(): void;
  /**
   * The scope to apply right now for a field, by Fusion's rule (does not consume): overridden or
   * chip on = this configuration, else all.
   */
  resolve(overridden: boolean): EditScope;
}

/**
 * The one-shot edit scope: `scope` returns to `all` after every `consume()` or `reset()`, and when
 * `resetKey` (the active configuration's id) changes. Holds no state beyond the edit in progress.
 */
export function useOneShotScope(activeIsDefault: boolean, resetKey?: unknown): OneShotScope {
  const [scope, setScopeState] = useState<EditScope>('all');
  const ref = useRef<EditScope>('all');
  const set = useCallback((s: EditScope) => {
    ref.current = s;
    setScopeState(s);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active configuration drops any pending choice
  useEffect(() => {
    set('all');
  }, [resetKey, activeIsDefault, set]);
  const reset = useCallback(() => set('all'), [set]);
  const consume = useCallback(() => {
    const s = ref.current;
    set('all');
    return s;
  }, [set]);
  const resolve = useCallback(
    (overridden: boolean) =>
      resolveEditScope({ activeIsDefault, overridden, chip: ref.current === 'configuration' }),
    [activeIsDefault],
  );
  return { scope, setScope: set, consume, reset, resolve };
}

/* ------------------------------------------------------------------------- notice */

export interface ChangedInAllNoticeProps {
  /** How many configurations the edit reached (those that inherit the value, Default included). */
  count: number;
  /** Undo the edit (the app's ordinary undo). */
  onUndo(): void;
  onDismiss(): void;
  /** Auto-dismiss after this many ms (paused while hovered or focused). 0 = stay. Default 8000. */
  autoDismissMs?: number;
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * Non-modal, undoable notice shown after editing an inherited value: "Changed in all N
 * configurations". A polite live region; it never takes focus.
 */
export function ChangedInAllNotice({
  count,
  onUndo,
  onDismiss,
  autoDismissMs = 8000,
  size = 'md',
  className,
}: ChangedInAllNoticeProps) {
  const [paused, setPaused] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `count` (a new edit) restarts the timer
  useEffect(() => {
    if (!autoDismissMs || paused) return;
    const t = setTimeout(() => dismiss.current(), autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs, paused, count]);
  const touch = size === 'touch';
  const btn = cn(
    'inline-flex items-center justify-center gap-1 rounded-control px-2 text-ui font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    touch ? 'min-h-11 min-w-11' : 'h-7',
  );
  return (
    <div
      role="status"
      data-testid="changed-in-all"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        'flex items-center gap-2 rounded-panel bg-surface px-3 py-1.5 text-ui text-fg shadow-pop',
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        Changed in all {count} {count === 1 ? 'configuration' : 'configurations'}
      </span>
      <button
        type="button"
        onClick={onUndo}
        className={cn(btn, 'text-accent-text hover:bg-accent-soft')}
      >
        <Undo2 className="size-3.5" aria-hidden />
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className={cn(btn, 'text-fg-muted hover:bg-surface-2')}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
