import { Plus, Variable } from 'lucide-react';
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { optionId, type PickerEntry } from '../logic/paramLinks';
import { validateNewParamName } from '../logic/paramName';
import { cn } from './primitives';

interface Pos {
  left: number;
  top: number;
  width: number;
  above: boolean;
}

/** Fixed-position popup that follows `anchor` (a field inside a scrolling panel or a sheet). */
function Popup({
  anchor,
  popup,
  minWidth = 220,
  testId,
  children,
}: {
  anchor: HTMLElement;
  popup: RefObject<HTMLDivElement | null>;
  minWidth?: number;
  testId: string;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  // Placed on open, then again only when the window resizes or something scrolls: no per-frame
  // layout reads.
  useLayoutEffect(() => {
    let last = '';
    const place = () => {
      const el = popup.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const width = Math.min(Math.max(a.width, minWidth), vw - 16);
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(a.left, vw - width - 8));
      const below = vh - a.bottom - 8;
      const above = below < h && a.top - 8 > below;
      const top = above ? Math.max(8, a.top - h - 4) : a.bottom + 4;
      const key = `${left}|${top}|${width}|${above}|${h}`;
      if (key !== last) {
        last = key;
        setPos({ left, top, width, above });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const ro = new ResizeObserver(place);
    if (popup.current) ro.observe(popup.current);
    ro.observe(anchor);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      ro.disconnect();
    };
  }, [anchor, popup, minWidth]);

  return createPortal(
    <div
      ref={popup}
      data-testid={testId}
      data-above={pos?.above || undefined}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: pos?.width ?? minWidth,
        // Not `visibility: hidden`: the make form focuses its input before the first placement.
        opacity: pos ? 1 : 0,
        boxShadow: 'var(--shadow-pop)',
      }}
      className="z-[var(--z-popover)] max-h-64 overflow-y-auto rounded-panel bg-surface p-1 text-fg shadow-[inset_0_0_0_1px_var(--color-border)]"
    >
      {children}
    </div>,
    document.body,
  );
}

export interface ParamListProps {
  anchor: HTMLElement;
  popup: RefObject<HTMLDivElement | null>;
  listId: string;
  entries: readonly PickerEntry[];
  active: number;
  onActive(i: number): void;
  onPick(entry: PickerEntry): void;
  size: 'md' | 'touch';
}

/** The ARIA listbox the field's combobox input controls (`aria-controls`). */
export function ParamList({
  anchor,
  popup,
  listId,
  entries,
  active,
  onActive,
  onPick,
  size,
}: ParamListProps) {
  const count = entries.filter((e) => e.kind === 'param').length;
  useEffect(() => {
    document.getElementById(optionId(listId, active))?.scrollIntoView?.({ block: 'nearest' });
  }, [listId, active]);
  return (
    <Popup anchor={anchor} popup={popup} testId="param-list-popup">
      <div
        id={listId}
        role="listbox"
        aria-label="Parameters"
        // The field keeps focus: pressing in the list must not blur it.
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
      >
        {entries.map((e, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keyboard (combobox)
          <div
            key={e.kind === 'param' ? e.info.name : 'make'}
            id={optionId(listId, i)}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            data-active={i === active || undefined}
            data-testid={e.kind === 'param' ? 'param-option' : 'param-make-option'}
            onMouseEnter={() => onActive(i)}
            onClick={() => onPick(e)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-control px-2 text-ui',
              size === 'touch' ? 'min-h-11' : 'min-h-8',
              i === active && 'bg-accent-soft text-accent-text',
              e.kind === 'make' && count > 0 && 'mt-1 border-t border-border pt-1',
            )}
          >
            {e.kind === 'param' ? (
              <>
                <Variable className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-semibold">{e.info.name}</span>
                <span className="tnum shrink-0 text-fg-muted">{e.info.value ?? '—'}</span>
              </>
            ) : (
              <>
                <Plus className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  Make parameter from <span className="tnum font-semibold">{e.text}</span>…
                </span>
              </>
            )}
          </div>
        ))}
        {count === 0 ? (
          <p className="px-2 py-1.5 text-2xs text-fg-muted">No parameters yet.</p>
        ) : null}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {count} {count === 1 ? 'parameter' : 'parameters'}
      </div>
    </Popup>
  );
}

export interface MakeParamProps {
  anchor: HTMLElement;
  popup: RefObject<HTMLDivElement | null>;
  /** Suggested name. */
  initial: string;
  /** The expression the parameter will get, shown so the user sees what is being named. */
  expr: string;
  existing: readonly string[];
  /** Creates the parameter; returns the host's error, or undefined on success. */
  onMake(name: string): string | undefined;
  onCancel(): void;
  size: 'md' | 'touch';
}

/** Inline name entry for "Make parameter" (no dialog): validates as you type. */
export function MakeParamForm({
  anchor,
  popup,
  initial,
  expr,
  existing,
  onMake,
  onCancel,
  size,
}: MakeParamProps) {
  const [name, setName] = useState(initial);
  const [hostError, setHostError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const error = validateNewParamName(name, existing);
  const shown = error ?? hostError;
  const [touched, setTouched] = useState(false);
  const hintId = useId();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function submit() {
    if (error) return;
    const msg = onMake(name);
    if (msg) setHostError(msg);
  }

  return (
    <Popup anchor={anchor} popup={popup} testId="param-make-popup">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset adds a border and legend we do not want */}
      <div role="group" aria-label="Make parameter" className="flex flex-col gap-1.5 p-1.5">
        <p className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
          Make parameter
        </p>
        <input
          ref={input}
          type="text"
          aria-label="Name of the new parameter"
          aria-invalid={shown && (touched || hostError) ? true : undefined}
          aria-describedby={hintId}
          value={name}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => {
            setTouched(true);
            setHostError(null);
            setName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Tab' && !e.shiftKey) {
              // Leaving the form by Tab cancels it explicitly: nothing is left half done.
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          className={cn(
            'w-full rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-accent)]',
            size === 'touch' ? 'h-11' : 'h-8',
            shown && (touched || hostError) && 'shadow-[inset_0_0_0_1.5px_var(--color-danger)]',
          )}
        />
        <p id={hintId} className="tnum truncate text-2xs text-fg-muted">
          = {expr}
        </p>
        {shown && (touched || hostError) ? (
          <p role="alert" className="text-2xs leading-4 text-danger-text">
            {shown}
          </p>
        ) : null}
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'rounded-control px-3 text-ui font-medium text-fg-muted hover:text-fg',
              size === 'touch' ? 'h-11' : 'h-8',
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!!error}
            onClick={submit}
            className={cn(
              'rounded-control bg-accent px-3 text-ui font-semibold text-accent-fg disabled:opacity-50',
              size === 'touch' ? 'h-11' : 'h-8',
            )}
          >
            Make parameter
          </button>
        </div>
      </div>
    </Popup>
  );
}
