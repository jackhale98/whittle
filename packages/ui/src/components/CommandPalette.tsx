import * as RDialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { m } from 'motion/react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSpring } from '../motion';
import { cn, Kbd } from './primitives';

export interface PaletteCommand {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  /** Disabled commands are listed (so users can discover them) but cannot run. */
  disabled?: boolean;
  /** Short reason shown at the end of the row, e.g. "Coming in M1". */
  hint?: string;
  run?(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  commands: readonly PaletteCommand[];
}

/**
 * Command palette (⌘K / Ctrl+K). A dialog is fine here: it is a global launcher, not a modeling
 * step. Combobox + listbox semantics; Esc closes (Radix).
 */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const transition = useSpring('fast');
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const clamped = Math.min(active, Math.max(results.length - 1, 0));
  const activeCmd = results[clamped];

  function run(cmd: PaletteCommand | undefined) {
    if (!cmd || cmd.disabled) return;
    onOpenChange(false);
    cmd.run?.();
  }

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-fg/25 backdrop-blur-[2px]" />
        <div className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-start justify-center px-4 pt-[14vh]">
          <RDialog.Content
            asChild
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
          >
            <m.div
              initial={{ opacity: 0, scale: 0.97, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={transition}
              className="pointer-events-auto flex max-h-[60vh] w-full max-w-[560px] flex-col overflow-hidden rounded-panel bg-surface shadow-pop"
              data-testid="command-palette"
              aria-describedby={undefined}
            >
              <RDialog.Title className="sr-only">Command palette</RDialog.Title>
              <div className="flex items-center gap-3 border-b border-border px-4">
                <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setActive((clamped + 1) % Math.max(results.length, 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setActive((clamped - 1 + results.length) % Math.max(results.length, 1));
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      run(activeCmd);
                    }
                  }}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={activeCmd ? `${listId}-${activeCmd.id}` : undefined}
                  aria-autocomplete="list"
                  aria-label="Search commands"
                  placeholder="Search tools and commands…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle"
                />
                <Kbd>Esc</Kbd>
              </div>
              <div
                id={listId}
                role="listbox"
                aria-label="Commands"
                className="min-h-0 overflow-y-auto p-2"
              >
                {results.length === 0 ? (
                  <p className="px-3 py-8 text-center text-ui text-fg-subtle">
                    No matching commands
                  </p>
                ) : (
                  results.map((c, i) => (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled on the combobox input
                    <div
                      key={c.id}
                      id={`${listId}-${c.id}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === clamped}
                      aria-disabled={c.disabled || undefined}
                      onMouseMove={() => setActive(i)}
                      onClick={() => run(c)}
                      className={cn(
                        'flex h-11 items-center gap-3 rounded-control px-3 text-ui select-none',
                        i === clamped ? 'bg-accent-soft text-accent-text' : 'text-fg',
                        c.disabled && 'opacity-70',
                      )}
                    >
                      <span
                        className="flex size-5 shrink-0 items-center justify-center"
                        aria-hidden
                      >
                        {c.icon}
                      </span>
                      <span className="flex-1 truncate font-medium">{c.label}</span>
                      {c.hint ? <span className="text-2xs text-fg-muted">{c.hint}</span> : null}
                      {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : null}
                    </div>
                  ))
                )}
              </div>
            </m.div>
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
