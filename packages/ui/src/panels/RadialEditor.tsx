import { RotateCcw, RotateCw, Search, Trash2 } from 'lucide-react';
import { type DragEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { Field, fieldClass, Section, Switch } from '../components/controls';
import { Button, cn } from '../components/primitives';
import { RADIAL_FILL_ORDER, type RadialSlot, slotDirection } from '../logic/radial';

export interface RadialEditorContext {
  id: string;
  label: string;
  /** One line of help: when this ring opens. */
  hint?: string;
}

export interface RadialEditorCommand {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
}

export interface RadialEditorProps {
  contexts: readonly RadialEditorContext[];
  /** The ring for a context, in `RADIAL_FILL_ORDER` (seven entries, null = empty). */
  ringOf(context: string): readonly (string | null)[];
  /** What may be placed on that context's ring (the command registry, for that mode). */
  commandsOf(context: string): readonly RadialEditorCommand[];
  /** Contexts whose ring differs from the default. */
  modified: readonly string[];
  onRingChange(context: string, ring: readonly (string | null)[]): void;
  onResetContext(context: string): void;
  onResetAll(): void;
  /** Flick window in ms (0 = flicks off). */
  flickWindow: number;
  onFlickWindow(ms: number): void;
  drawAfterDelay: boolean;
  onDrawAfterDelay(on: boolean): void;
  /** A status line to show, e.g. "Removed 2 commands that no longer exist". */
  notice?: string | null;
  onDismissNotice?(): void;
  onExport?(): void;
  onImport?(file: File): void;
  defaultContext?: string;
  size?: 'md' | 'touch';
  className?: string;
}

export const FLICK_MAX = 400;

const SLOT_NAMES: Record<RadialSlot, string> = {
  n: 'north',
  ne: 'north-east',
  e: 'east',
  se: 'south-east',
  s: 'south',
  sw: 'south-west',
  w: 'west',
  nw: 'north-west',
};

/**
 * Put `id` (or nothing) in slot `index` of a ring. A command sits on a ring once: placing one
 * that is already there moves it, and the command it lands on takes its old place (a swap).
 */
export function assignToSlot(
  ring: readonly (string | null)[],
  index: number,
  id: string | null,
): (string | null)[] {
  const next = [...ring];
  const prev = next[index] ?? null;
  if (id !== null) {
    const from = next.indexOf(id);
    if (from >= 0) next[from] = prev;
  }
  next[index] = id;
  return next;
}

const clampFlick = (v: number) => Math.min(FLICK_MAX, Math.max(0, Math.round(v) || 0));

// The ring is drawn as an ellipse so seven pills fit a phone-width panel without touching.
const RX = 108;
const RY = 156;
const PILL_W = 88;

/**
 * Radial menu editor (PLAN M3.8, ADR-085). Shows the ring of one context; assign a command by
 * dragging it from the list onto a slot, or (keyboard, touch) by choosing the slot and then the
 * command. A slot can be cleared. Not a dialog: it lives in the settings panel. Controlled; the
 * app persists the rings, validates ids against the command registry and applies them.
 */
export function RadialEditor({
  contexts,
  ringOf,
  commandsOf,
  modified,
  onRingChange,
  onResetContext,
  onResetAll,
  flickWindow,
  onFlickWindow,
  drawAfterDelay,
  onDrawAfterDelay,
  notice,
  onDismissNotice,
  onExport,
  onImport,
  defaultContext,
  size = 'md',
  className,
}: RadialEditorProps) {
  const touch = size === 'touch';
  const first = contexts[0]?.id ?? '';
  const [ctx, setCtx] = useState(defaultContext ?? first);
  const [active, setActive] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [over, setOver] = useState<number | null>(null);
  const ctxId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const ring = ringOf(ctx);
  const commands = commandsOf(ctx);
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands]);
  const labelOf = (id: string | null) => (id ? (byId.get(id)?.label ?? id) : 'Empty');
  const info = contexts.find((c) => c.id === ctx);
  const isModified = modified.includes(ctx);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map<string, RadialEditorCommand[]>();
    for (const c of commands) {
      if (q && !`${c.label} ${c.group}`.toLowerCase().includes(q)) continue;
      const l = out.get(c.group) ?? [];
      l.push(c);
      out.set(c.group, l);
    }
    return [...out.entries()];
  }, [commands, q]);

  const slotAt = (i: number): RadialSlot => RADIAL_FILL_ORDER[i] as RadialSlot;
  const where = (i: number) => `slot ${i + 1}, ${SLOT_NAMES[slotAt(i)]}`;

  function place(index: number, id: string | null, focusSlot: boolean) {
    onRingChange(ctx, assignToSlot(ring, index, id));
    setStatus(
      id
        ? `${labelOf(id)} placed in ${where(index)}.`
        : `${labelOf(ring[index] ?? null)} removed from ${where(index)}.`,
    );
    if (focusSlot) queueMicrotask(() => slotRefs.current[index]?.focus());
  }

  function choose(index: number) {
    setActive(index);
    setQuery('');
    setStatus(`${where(index)} chosen. Search and pick a command.`);
    queueMicrotask(() => searchRef.current?.focus());
  }

  const dropOn = (e: DragEvent, index: number) => {
    e.preventDefault();
    setOver(null);
    const cmd = e.dataTransfer.getData('application/x-wren-radial-command');
    const from = e.dataTransfer.getData('application/x-wren-radial-slot');
    if (cmd) place(index, cmd, false);
    else if (from !== '') {
      const f = Number(from);
      const a = ring[f] ?? null;
      if (a && f !== index) place(index, a, false);
    }
  };

  const dragOver = (e: DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes('application/x-wren-radial-command')) {
      if (!e.dataTransfer.types.includes('application/x-wren-radial-slot')) return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(index);
  };

  const pillH = touch ? 44 : 36;
  const boxW = RX * 2 + PILL_W;
  const boxH = RY * 2 + pillH;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: bubbling Escape from the controls inside
    <div
      data-testid="radial-editor"
      className={cn('flex min-w-0 flex-col', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && active !== null) {
          // First Escape leaves the slot choice; the panel's own Escape closes settings.
          e.stopPropagation();
          const i = active;
          setActive(null);
          queueMicrotask(() => slotRefs.current[i]?.focus());
        }
      }}
    >
      <Section title="Quick access wheel">
        <p className="text-xs text-fg-muted">
          Choose what the right-click wheel offers in each situation. Items that do not apply to the
          current selection stay in place, dimmed, so the directions keep working from memory.
        </p>
        <Field label="Context" hint={info?.hint}>
          <select
            id={ctxId}
            aria-label="Wheel context"
            data-testid="radial-context"
            value={ctx}
            onChange={(e) => {
              setCtx(e.target.value);
              setActive(null);
              setQuery('');
              setStatus('');
            }}
            className={cn(fieldClass, touch && 'h-11')}
          >
            {contexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {modified.includes(c.id) ? ' (changed)' : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* biome-ignore lint/a11y/useSemanticElements: absolutely positioned ring; a fieldset cannot be laid out so */}
        <div
          role="group"
          aria-label={`${info?.label ?? ''} ring`}
          data-testid="radial-ring"
          className="relative mx-auto max-w-full"
          style={{ width: boxW, height: boxH }}
        >
          <div
            className="absolute flex items-center justify-center gap-1 rounded-full bg-surface-2 text-2xs text-fg-subtle shadow-[inset_0_0_0_1px_var(--color-border)]"
            style={{
              left: boxW / 2 - PILL_W / 2,
              top: boxH / 2 - RY - pillH / 2,
              width: PILL_W,
              height: pillH,
            }}
            data-testid="radial-repeat"
            role="img"
            aria-label="North: Repeat last command (fixed)"
          >
            <RotateCw className="size-3.5" aria-hidden />
            <span aria-hidden>Repeat</span>
          </div>
          {ring.map((id, i) => {
            const slot = slotAt(i);
            const d = slotDirection(slot);
            const on = active === i;
            const cmd = id ? byId.get(id) : undefined;
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: slots are positions
                key={i}
                ref={(el) => {
                  slotRefs.current[i] = el;
                }}
                type="button"
                data-slot-index={i}
                data-slot={slot}
                data-command={id ?? ''}
                data-over={over === i ? '' : undefined}
                aria-pressed={on}
                aria-label={`${where(i)}: ${labelOf(id)}. ${on ? 'Choosing a command.' : 'Choose a command.'}`}
                draggable={!!id}
                onDragStart={(e) => {
                  if (!id) return;
                  e.dataTransfer.setData('application/x-wren-radial-slot', String(i));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => dragOver(e, i)}
                onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDrop={(e) => dropOn(e, i)}
                onClick={() => choose(i)}
                onKeyDown={(e) => {
                  if ((e.key === 'Delete' || e.key === 'Backspace') && id) {
                    e.preventDefault();
                    place(i, null, true);
                  }
                }}
                style={{
                  position: 'absolute',
                  left: boxW / 2 + d.x * RX - PILL_W / 2,
                  top: boxH / 2 + d.y * RY - pillH / 2,
                  width: PILL_W,
                  height: pillH,
                }}
                className={cn(
                  'flex items-center justify-center gap-1 rounded-full px-2 text-xs font-medium outline-none transition-colors duration-fast',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                  id
                    ? 'bg-surface text-fg shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                    : 'border border-dashed border-border-strong text-fg-muted',
                  on && 'bg-accent-soft shadow-[inset_0_0_0_2px_var(--color-accent)]',
                  over === i && 'bg-accent-soft',
                )}
              >
                {cmd?.icon ? (
                  <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                    {cmd.icon}
                  </span>
                ) : null}
                <span aria-hidden className="min-w-0 truncate">
                  {id ? labelOf(id) : i + 1}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size={touch ? 'touch' : 'md'}
            icon={<Trash2 className="size-3.5" aria-hidden />}
            disabled={active === null || !ring[active]}
            onClick={() => active !== null && place(active, null, true)}
          >
            Clear slot
          </Button>
          <Button
            variant="secondary"
            size={touch ? 'touch' : 'md'}
            icon={<RotateCcw className="size-3.5" aria-hidden />}
            disabled={!isModified}
            onClick={() => {
              onResetContext(ctx);
              setStatus(`${info?.label ?? 'This'} ring reset to its default.`);
            }}
          >
            Reset this ring
          </Button>
          <Button
            variant="secondary"
            size={touch ? 'touch' : 'md'}
            disabled={modified.length === 0}
            onClick={() => {
              onResetAll();
              setStatus('All rings reset to their defaults.');
            }}
          >
            Reset all
          </Button>
        </div>
        <p role="status" aria-live="polite" data-testid="radial-status" className="sr-only">
          {status}
        </p>
        {notice ? (
          <p
            role="status"
            data-testid="radial-notice"
            className="flex items-start gap-2 rounded-control bg-warning-soft p-2 text-xs text-warning-text"
          >
            <span className="min-w-0 flex-1">{notice}</span>
            {onDismissNotice ? (
              <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={onDismissNotice}>
                Dismiss
              </Button>
            ) : null}
          </p>
        ) : null}
      </Section>

      <Section title={active === null ? 'Commands' : `Commands for ${where(active)}`}>
        <p className="text-xs text-fg-muted">
          {active === null
            ? 'Drag a command onto a slot, or choose a slot first and then a command.'
            : `Choose a command for ${where(active)}, or drag one onto any slot.`}
        </p>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search commands"
            placeholder="Search commands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn(fieldClass, 'pl-8', touch && 'h-11')}
          />
        </div>
        {groups.length === 0 ? (
          <p className="text-ui text-fg-muted">No command matches "{query}".</p>
        ) : null}
        {groups.map(([group, rows]) => (
          <section key={group} aria-label={group}>
            <h4 className="mb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
              {group}
            </h4>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {rows.map((c) => {
                const at = ring.indexOf(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-command-id={c.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-wren-radial-command', c.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      aria-label={
                        active === null
                          ? `${c.label}${at >= 0 ? `, in ${where(at)}` : ''}. Choose a slot first.`
                          : `${c.label}, place in ${where(active)}${at >= 0 ? `, moves it from ${where(at)}` : ''}`
                      }
                      aria-disabled={active === null || undefined}
                      onClick={() => {
                        if (active !== null) place(active, c.id, true);
                        else setStatus('Choose a slot first, or drag this command onto one.');
                      }}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-medium shadow-[inset_0_0_0_1px_var(--color-border)] outline-none transition-colors duration-fast hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent',
                        touch ? 'h-11' : 'h-8',
                        at >= 0 && 'text-fg-muted',
                        active === null && 'cursor-grab',
                      )}
                    >
                      {c.icon ? (
                        <span aria-hidden className="flex size-4 items-center justify-center">
                          {c.icon}
                        </span>
                      ) : null}
                      {c.label}
                      {at >= 0 ? (
                        <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </Section>

      <Section title="Flicks">
        <Field
          label="Flick window (ms)"
          hint="After the wheel opens, a quick mouse or pen move toward an item picks it, drawn or not. 0 turns flicks off."
        >
          <input
            type="number"
            aria-label="Flick window in milliseconds"
            data-testid="flick-window"
            min={0}
            max={FLICK_MAX}
            step={10}
            value={flickWindow}
            onChange={(e) => onFlickWindow(clampFlick(Number(e.target.value)))}
            className={cn(fieldClass, 'tnum w-28', touch && 'h-11')}
          />
        </Field>
        <Switch
          label="Draw after a delay"
          checked={drawAfterDelay}
          onChange={onDrawAfterDelay}
          className={touch ? 'min-h-11' : ''}
        />
        <p className="text-2xs text-fg-subtle">
          Off: the wheel draws at once. On: mouse and pen wheels wait for the flick window before
          drawing, so a blind flick never shows it. Keyboard and touch always draw at once.
        </p>
      </Section>

      {onExport || onImport ? (
        <Section title="Back up">
          <div className="flex flex-wrap gap-2">
            {onExport ? (
              <Button variant="secondary" size={touch ? 'touch' : 'md'} onClick={onExport}>
                Export wheel settings
              </Button>
            ) : null}
            {onImport ? (
              <>
                <Button
                  variant="secondary"
                  size={touch ? 'touch' : 'md'}
                  onClick={() => fileRef.current?.click()}
                >
                  Import wheel settings
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  aria-label="Wheel settings file"
                  data-testid="radial-import"
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImport(f);
                    e.target.value = '';
                  }}
                />
              </>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
