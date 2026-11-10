import { Ban, Plus, RotateCcw, Search, TriangleAlert, X } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { fieldClass } from '../components/controls';
import { Button, cn, IconButton } from '../components/primitives';
import {
  type BindingConflicts,
  detectPlatform,
  eventToBinding,
  findConflicts,
  formatBindingId,
  formatBindingLabel,
  type KeymapCommand,
  type KeymapOverrides,
  type LayoutMap,
  type Platform,
  resolveKeymap,
} from './keymap';

export interface KeymapEditorProps {
  commands: readonly KeymapCommand[];
  /** The user's changes; empty = all defaults. Persist and apply it in the app. */
  overrides: KeymapOverrides;
  onChange(overrides: KeymapOverrides): void;
  platform?: Platform;
  /** From `readLayoutMap()`: labels follow the user's layout. */
  layout?: LayoutMap | null;
  size?: 'md' | 'touch';
  className?: string;
}

interface Pending {
  commandId: string;
  binding: string;
  conflicts: BindingConflicts;
}

/**
 * Keymap editor (PLAN 9.4). Lists commands by group; "Add shortcut" records the next key chord by
 * `KeyboardEvent.code`; a chord that another command already uses, or that the browser keeps
 * (Ctrl+W, Ctrl+T ...), is flagged before it is applied. Browser keys the page can never receive
 * cannot be assigned; others need an explicit "Use anyway". Not a dialog: it lives in the
 * settings panel.
 */
export function KeymapEditor({
  commands,
  overrides,
  onChange,
  platform: platformProp,
  layout,
  size = 'md',
  className,
}: KeymapEditorProps) {
  const platform = platformProp ?? detectPlatform();
  const resolved = useMemo(() => resolveKeymap(commands, overrides), [commands, overrides]);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const searchId = useId();
  const touch = size === 'touch';
  const label = (id: string) => formatBindingLabel(id, { platform, layout: layout ?? null });

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map<string, KeymapCommand[]>();
    for (const c of commands) {
      const keys = (resolved[c.id] ?? []).map((b) =>
        formatBindingLabel(b, { platform, layout: layout ?? null }),
      );
      const hay = `${c.label} ${c.group} ${keys.join(' ')}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const list = out.get(c.group) ?? [];
      list.push(c);
      out.set(c.group, list);
    }
    return [...out.entries()];
  }, [commands, resolved, q, platform, layout]);

  const modified = (id: string) => overrides[id] !== undefined;
  const set = (id: string, bindings: readonly string[]) =>
    onChange({ ...overrides, [id]: bindings });
  const reset = (id: string) => {
    const { [id]: _drop, ...rest } = overrides;
    onChange(rest);
  };

  function assign(p: Pending, reassign: boolean) {
    const next: Record<string, readonly string[]> = { ...overrides };
    if (reassign) {
      for (const other of p.conflicts.commands) {
        next[other.id] = (resolved[other.id] ?? []).filter((b) => b !== p.binding);
      }
    }
    const cur = resolved[p.commandId] ?? [];
    next[p.commandId] = cur.includes(p.binding) ? cur : [...cur, p.binding];
    onChange(next);
    setPending(null);
    setRecording(null);
  }

  function onRecordKey(e: KeyboardEvent<HTMLButtonElement>, commandId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      setPending(null);
      return;
    }
    const b = eventToBinding(e.nativeEvent, platform);
    if (!b) return; // a bare modifier: wait for the key
    const binding = formatBindingId(b);
    const conflicts = findConflicts(commands, resolved, commandId, binding, platform);
    const p: Pending = { commandId, binding, conflicts };
    if (!conflicts.reserved && conflicts.commands.length === 0) assign(p, false);
    else {
      setPending(p);
    }
  }

  const bar = useRef<HTMLDivElement>(null);
  const anyModified = commands.some((c) => modified(c.id));

  return (
    <div
      ref={bar}
      data-testid="keymap-editor"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            aria-label="Search commands and shortcuts"
            placeholder="Search commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn(fieldClass, 'pl-8', touch && 'h-11')}
          />
        </div>
        <Button
          variant="secondary"
          size={touch ? 'touch' : 'md'}
          icon={<RotateCcw className="size-3.5" aria-hidden />}
          disabled={!anyModified}
          onClick={() => onChange({})}
        >
          Reset all
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="text-ui text-fg-muted">No command matches "{query}".</p>
      ) : null}

      {groups.map(([group, rows]) => (
        <section key={group} aria-label={`${group} shortcuts`}>
          <h3 className="mb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
            {group}
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((c) => {
              const bindings = resolved[c.id] ?? [];
              const isRec = recording === c.id;
              const p = pending?.commandId === c.id ? pending : null;
              return (
                <li
                  key={c.id}
                  data-command={c.id}
                  data-modified={modified(c.id) ? '' : undefined}
                  className="flex flex-col gap-1.5 border-b border-border py-1.5 last:border-b-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-28 flex-1 text-ui">
                      {c.label}
                      {c.locked ? (
                        <span className="ml-1.5 text-2xs text-fg-subtle">(fixed)</span>
                      ) : null}
                    </span>
                    <ul
                      className="m-0 flex list-none flex-wrap items-center gap-1 p-0"
                      aria-label={`${c.label} bindings`}
                    >
                      {bindings.length === 0 ? (
                        <li className="text-xs text-fg-subtle">None</li>
                      ) : null}
                      {bindings.map((b) => {
                        const flags = findConflicts(commands, resolved, c.id, b, platform);
                        const reserved = flags.reserved;
                        const clash = flags.commands.length > 0;
                        const note = reserved
                          ? `${reserved.severity === 'blocked' ? 'Browser shortcut' : 'Also a browser shortcut'}: ${reserved.action}`
                          : clash
                            ? `Also used by ${flags.commands.map((x) => x.label).join(', ')}`
                            : '';
                        return (
                          <li
                            key={b}
                            data-binding={b}
                            data-flag={reserved?.severity ?? (clash ? 'command' : undefined)}
                            className={cn(
                              'flex h-7 items-center gap-1 rounded-full bg-surface-2 pr-0.5 pl-2.5 text-xs font-medium shadow-[inset_0_0_0_1px_var(--color-border)]',
                              (reserved || clash) &&
                                'bg-warning-soft text-warning-text shadow-[inset_0_0_0_1px_var(--color-warning)]',
                              c.locked && 'pr-2.5',
                            )}
                          >
                            <span className="tnum">{label(b)}</span>
                            {note ? <span className="sr-only">{`, ${note}`}</span> : null}
                            {reserved || clash ? (
                              <TriangleAlert className="size-3" aria-hidden />
                            ) : null}
                            {c.locked ? null : (
                              <IconButton
                                label={`Remove ${label(b)} from ${c.label}`}
                                className="size-6!"
                                icon={<X className="size-3" />}
                                onClick={() =>
                                  set(
                                    c.id,
                                    bindings.filter((x) => x !== b),
                                  )
                                }
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {c.locked ? null : (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size={touch ? 'touch' : 'md'}
                          icon={<Plus className="size-3.5" aria-hidden />}
                          aria-label={`Add shortcut for ${c.label}`}
                          onClick={() => {
                            setPending(null);
                            setRecording(c.id);
                          }}
                        >
                          Add
                        </Button>
                        {modified(c.id) ? (
                          <Button
                            variant="ghost"
                            size={touch ? 'touch' : 'md'}
                            icon={<RotateCcw className="size-3.5" aria-hidden />}
                            aria-label={`Reset ${c.label} to default`}
                            onClick={() => reset(c.id)}
                          >
                            Reset
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {isRec ? (
                    <button
                      type="button"
                      // biome-ignore lint/a11y/noAutofocus: the recorder must receive the next key
                      autoFocus
                      data-testid="key-recorder"
                      aria-label={`Press the new shortcut for ${c.label}, or Escape to cancel`}
                      onKeyDown={(e) => onRecordKey(e, c.id)}
                      onBlur={() => {
                        if (!pending) setRecording(null);
                      }}
                      className="h-9 rounded-control bg-accent-soft px-3 text-left text-ui text-accent-text shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none"
                    >
                      Press the new shortcut… (Esc cancels)
                    </button>
                  ) : null}

                  {p ? (
                    <ConflictNote
                      p={p}
                      commands={commands}
                      label={label}
                      onAssign={assign}
                      onCancel={() => {
                        setPending(null);
                        setRecording(null);
                      }}
                      touch={touch}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ConflictNote({
  p,
  commands,
  label,
  onAssign,
  onCancel,
  touch,
}: {
  p: Pending;
  commands: readonly KeymapCommand[];
  label(id: string): string;
  onAssign(p: Pending, reassign: boolean): void;
  onCancel(): void;
  touch: boolean;
}) {
  const blocked = p.conflicts.reserved?.severity === 'blocked';
  const r = p.conflicts.reserved;
  const names = p.conflicts.commands.map((c) => c.label);
  const lockedOther = p.conflicts.commands.some((c) => commands.find((x) => x.id === c.id)?.locked);
  return (
    <div
      role="alert"
      data-testid="keymap-conflict"
      data-severity={blocked ? 'blocked' : 'warning'}
      className={cn(
        'flex flex-col gap-1.5 rounded-control p-2.5 text-ui',
        blocked ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
      )}
    >
      <p className="flex items-start gap-1.5 font-medium">
        {blocked ? (
          <Ban className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <span>
          {r
            ? blocked
              ? `${label(p.binding)} is a browser shortcut (${r.action}). The browser takes it before Wren sees it, so it cannot be assigned.`
              : `${label(p.binding)} is also a browser shortcut (${r.action}). Wren overrides it while it has focus.`
            : null}
          {r && names.length ? ' ' : ''}
          {names.length ? `${label(p.binding)} is already used by ${names.join(', ')}.` : null}
        </span>
      </p>
      {r?.notes.length ? (
        <ul className="m-0 list-disc pl-8 text-xs">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {!blocked && names.length && !lockedOther ? (
          <Button variant="primary" size={touch ? 'touch' : 'md'} onClick={() => onAssign(p, true)}>
            Reassign here
          </Button>
        ) : null}
        {!blocked && !names.length ? (
          <Button
            variant="primary"
            size={touch ? 'touch' : 'md'}
            onClick={() => onAssign(p, false)}
          >
            Use anyway
          </Button>
        ) : null}
        <Button variant="secondary" size={touch ? 'touch' : 'md'} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
