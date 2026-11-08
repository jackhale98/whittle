import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { cn } from './primitives';

/* ------------------------------------------------------------------------- Segmented */

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<NoInfer<T>>[];
  onChange(value: NoInfer<T>): void;
  /** Accessible name of the group. */
  label: string;
  size?: 'md' | 'touch';
  className?: string;
  disabled?: boolean;
}

/**
 * Radio-group segmented control: one tab stop, arrows move and select (WAI-ARIA radio group).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className,
  disabled,
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % enabled.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onChange(target.value);
    requestAnimationFrame(() =>
      group.current?.querySelector<HTMLElement>(`[data-value="${target.value}"]`)?.focus(),
    );
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      className={cn(
        'flex min-w-0 gap-0.5 rounded-[10px] bg-surface-2 p-0.5',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: radio semantics on a button for styling
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.title}
            data-value={o.value}
            disabled={o.disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-[8px] px-2 text-xs font-medium whitespace-nowrap transition-colors duration-fast disabled:opacity-40',
              size === 'touch' ? 'h-11' : 'h-7',
              on
                ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(15_23_42/0.14)]'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------- Section / Field */

export function Section({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn('border-b border-border px-4 py-3 last:border-b-0', className)}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 id={id} className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          {title}
        </h3>
        {actions}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/** Label above, control below: reads well in the 296px inspector and on phones. */
export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <p className="text-2xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn('flex items-center gap-2.5 text-left text-ui', className)}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors duration-fast',
          checked ? 'bg-accent' : 'bg-border-strong/60',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-fast',
            checked && 'translate-x-4',
          )}
        />
      </span>
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------------- text field */

export const fieldClass =
  'h-8 w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none transition-shadow duration-fast placeholder:text-fg-subtle hover:shadow-[inset_0_0_0_1px_var(--color-border-strong)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]';
