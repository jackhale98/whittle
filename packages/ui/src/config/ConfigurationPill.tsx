import type { Id } from '@wren-cad/contracts';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Layers,
  Plus,
  TableProperties,
  TriangleAlert,
} from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Segmented } from '../components/controls';
import { FloatingLayer } from '../components/floating';
import { Button, cn } from '../components/primitives';
import { ConfigStatusLabel } from './ConfigStatusLabel';
import {
  CONFIG_STATUS_LABEL,
  type ConfigStatus,
  type ConfigurationSummary,
  DEFAULT_CONFIGURATION_NAME,
} from './model';

export { ConfigStatusLabel };

export interface NewConfigurationInput {
  name: string;
  /** `default`: no overrides. `active`: a copy of the active configuration's overrides (D3, preselected). */
  from: 'default' | 'active';
}

export interface ConfigurationPillProps {
  /** The part's configurations, Default excluded (it is implicit and always listed first). */
  configurations: readonly ConfigurationSummary[];
  /** The active configuration's id; `null` = Default. */
  activeId: Id | null;
  /** Build status of Default, when known. */
  defaultStatus?: ConfigStatus;
  defaultStatusMessage?: string;
  /** Switch (also `null` = Default). The app issues `setActiveConfiguration`. */
  onSwitch(id: Id | null): void;
  /** "New configuration…" submitted. Not offered on the `chip` variant or without this callback. */
  onCreate?(input: NewConfigurationInput): void;
  /** "Manage…": the app opens the configuration table. Not offered on the `chip` variant. */
  onManage?(): void;
  /**
   * `bar`: the top bar on desktop and tablet; the list also offers New configuration… and Manage….
   * `chip`: the compact phone chip; switching only.
   */
  variant?: 'bar' | 'chip';
  /** `touch`: 44 px targets. */
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * The active-configuration pill (M3.7, research P0 3): the active name, always visible, with a
 * tinted edge (`data-off-default`) whenever it is not Default. One tap opens a list to switch, each
 * with its status; the `bar` variant also offers "New configuration…" (inline name and a
 * Default / Active choice, Active preselected) and "Manage…". Controlled: the app owns the
 * configurations and the active id.
 */
export function ConfigurationPill({
  configurations,
  activeId,
  defaultStatus,
  defaultStatusMessage,
  onSwitch,
  onCreate,
  onManage,
  variant = 'bar',
  size = 'md',
  className,
}: ConfigurationPillProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState<'default' | 'active'>('active');
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nameId = useId();
  const errId = useId();
  const touch = size === 'touch';
  const chip = variant === 'chip';

  const active = configurations.find((c) => c.id === activeId);
  const activeName = active?.name ?? DEFAULT_CONFIGURATION_NAME;
  const offDefault = activeId !== null && active !== undefined;
  const activeStatus = active ? active.status : defaultStatus;

  const trimmed = name.trim();
  const taken = [DEFAULT_CONFIGURATION_NAME, ...configurations.map((c) => c.name)].some(
    (n) => n.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  const error = trimmed === '' ? '' : taken ? 'A configuration with this name exists' : '';
  const valid = trimmed !== '' && !taken;

  function close() {
    setOpen(false);
    setCreating(false);
    setName('');
    setFrom('active');
  }
  function submit() {
    if (!valid || !onCreate) return;
    onCreate({ name: trimmed, from });
    close();
  }
  function pick(id: Id | null) {
    if (id !== activeId) onSwitch(id);
    close();
  }
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const nodes = Array.from(list.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const cur = nodes.indexOf(document.activeElement as HTMLElement);
    let next = cur;
    if (e.key === 'ArrowDown') next = Math.min(nodes.length - 1, cur + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else next = nodes.length - 1;
    e.preventDefault();
    nodes[next]?.focus();
  }

  const rows: { id: Id | null; name: string; status?: ConfigStatus; message?: string }[] = [
    {
      id: null,
      name: DEFAULT_CONFIGURATION_NAME,
      ...(defaultStatus ? { status: defaultStatus } : {}),
      ...(defaultStatusMessage ? { message: defaultStatusMessage } : {}),
    },
    ...configurations.map((c) => ({
      id: c.id as Id | null,
      name: c.name,
      status: c.status,
      ...(c.statusMessage ? { message: c.statusMessage } : {}),
    })),
  ];
  const rowH = touch ? 'min-h-11' : 'min-h-8';

  return (
    <>
      <button
        ref={btn}
        type="button"
        data-testid="configuration-pill"
        data-off-default={offDefault ? '' : undefined}
        data-variant={variant}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Configuration: ${activeName}${activeStatus && activeStatus !== 'ok' ? `, ${CONFIG_STATUS_LABEL[activeStatus]}` : ''}. Switch configuration`}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full border-l-[5px] px-2.5 text-ui font-medium transition-colors duration-fast select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
          offDefault
            ? 'border-warning bg-warning-soft text-warning-text hover:brightness-95'
            : 'border-border-strong bg-surface-2 text-fg hover:bg-surface-3',
          touch ? 'min-h-11' : 'h-8',
          chip && 'px-2',
          className,
        )}
      >
        <Layers className="size-4 shrink-0" aria-hidden />
        <span
          className={cn('min-w-0 truncate', chip ? 'max-w-[9ch]' : 'max-w-40 in-data-[narrow]:max-w-[9ch]')}
          title={activeName}
        >
          {activeName}
        </span>
        {activeStatus === 'failed' || activeStatus === 'attention' ? (
          <span aria-hidden className="shrink-0">
            {activeStatus === 'failed' ? (
              <CircleAlert className="size-3.5 text-danger-text" />
            ) : (
              <TriangleAlert className="size-3.5 text-warning-text" />
            )}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && btn.current ? (
        <FloatingLayer
          anchor={btn.current}
          placement="bottom-start"
          onDismiss={close}
          label="Configurations"
          role="dialog"
          testId="configuration-list"
          className="w-72 max-w-[calc(100vw-16px)] p-1"
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow-key roving between the list's buttons */}
          <div ref={list} onKeyDown={onListKey}>
            <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
              <legend className="sr-only">Switch configuration</legend>
              {rows.map((r) => {
                const on = r.id === activeId;
                return (
                  <button
                    key={r.id ?? 'default'}
                    type="button"
                    aria-current={on ? 'true' : undefined}
                    data-autofocus={on ? '' : undefined}
                    data-testid={`config-row-${r.id ?? 'default'}`}
                    onClick={() => pick(r.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1 text-left text-ui outline-none transition-colors duration-fast hover:bg-surface-2 focus-visible:bg-surface-3',
                      rowH,
                      on && 'bg-accent-soft',
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-accent-text">
                      {on ? <Check className="size-4" aria-hidden /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {r.status ? <ConfigStatusLabel status={r.status} message={r.message} /> : null}
                    {r.message ? <span className="sr-only">{`: ${r.message}`}</span> : null}
                  </button>
                );
              })}
            </fieldset>
            {chip ? null : (
              <div className="mt-1 flex flex-col border-t border-border pt-1">
                {creating ? (
                  <form
                    className="flex flex-col gap-2 p-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submit();
                    }}
                  >
                    <label htmlFor={nameId} className="text-xs font-medium text-fg-muted">
                      New configuration name
                    </label>
                    <input
                      id={nameId}
                      // biome-ignore lint/a11y/noAutofocus: the inline form opens on the user's request
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? errId : undefined}
                      autoComplete="off"
                      className={cn(
                        'w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                        touch ? 'h-11' : 'h-8',
                      )}
                    />
                    {error ? (
                      <p id={errId} role="alert" className="text-2xs text-danger-text">
                        {error}
                      </p>
                    ) : null}
                    <Segmented
                      label="New from"
                      value={from}
                      onChange={setFrom}
                      size={size}
                      options={[
                        { value: 'default', label: 'From Default' },
                        { value: 'active', label: 'From Active' },
                      ]}
                    />
                    <div className="flex justify-end gap-2">
                      <Button size={size} variant="ghost" onClick={() => setCreating(false)}>
                        Cancel
                      </Button>
                      <Button
                        size={size}
                        variant="primary"
                        type="submit"
                        aria-disabled={!valid}
                        onClick={(e) => {
                          if (!valid) e.preventDefault();
                        }}
                      >
                        Create
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    {onCreate ? (
                      <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-ui outline-none hover:bg-surface-2 focus-visible:bg-surface-3',
                          rowH,
                        )}
                      >
                        <Plus className="size-4 shrink-0 text-fg-muted" aria-hidden />
                        New configuration…
                      </button>
                    ) : null}
                    {onManage ? (
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          onManage();
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-ui outline-none hover:bg-surface-2 focus-visible:bg-surface-3',
                          rowH,
                        )}
                      >
                        <TableProperties className="size-4 shrink-0 text-fg-muted" aria-hidden />
                        Manage…
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </FloatingLayer>
      ) : null}
    </>
  );
}
