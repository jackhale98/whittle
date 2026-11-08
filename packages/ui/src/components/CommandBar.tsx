import * as RToolbar from '@radix-ui/react-toolbar';
import { Ellipsis } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { readJson, writeJson } from '../logic/persist';
import { cn, Tooltip } from './primitives';
import {
  type ToolGroupDef,
  type ToolGroupId,
  type ToolId,
  toolGroups,
  toolHint,
  tools,
} from './tools';

export interface CommandBarProps {
  /** Highlights a tool. */
  activeTool?: ToolId | null;
  /** Tools that are wired up; every other tool stays disabled with its own hint ("Coming in M3"). */
  enabledTools?: readonly ToolId[];
  onTool?(tool: ToolId): void;
  /** "More" opens the command palette. */
  onMore?: () => void;
  className?: string;
}

type LastTools = Partial<Record<ToolGroupId, ToolId>>;

const byId = new Map(tools.map((t) => [t.id, t]));

export const LAST_TOOLS_KEY = 'whittle.lastTools';

/** A long press (touch or pen) opens a flyout; so does an upward drag of this many pixels. */
const HOLD_MS = 420;
const DRAG_UP_PX = 14;

const item =
  'relative flex h-[52px] w-[58px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-control text-fg-muted transition-colors duration-fast select-none hover:bg-surface-2 hover:text-fg active:bg-surface-3 aria-disabled:opacity-60';

function readLast(): LastTools {
  const v = readJson<unknown>(LAST_TOOLS_KEY, {});
  return v && typeof v === 'object' ? (v as LastTools) : {};
}

/** The tool a category button shows: the active one, else the last used, else the first. */
function faceOf(g: ToolGroupDef, active: ToolId | null, last: LastTools): ToolId {
  const inGroup = (id: ToolId | null | undefined): id is ToolId => !!id && g.tools.includes(id);
  if (inGroup(active)) return active;
  const l = last[g.id];
  if (inGroup(l)) return l;
  return g.tools[0] as ToolId;
}

/**
 * Floating command bar (PLAN 9.1): category buttons that open flyouts, rendered from `toolGroups`
 * (the tablet rail uses the same definition). A category button shows its last-used tool (kept per
 * user in localStorage) and a small flyout indicator; single-tool groups are direct buttons, so the
 * bar keeps its width as tools are added.
 *
 * Mouse: click opens the flyout. Touch and pen: a long press or an upward drag opens it, and
 * releasing over a tool picks it. Keyboard: Left/Right roves across the categories (one tab stop),
 * ArrowUp/Enter/Space opens a flyout, Up/Down/Home/End move inside it, Enter picks, Escape closes
 * and returns to the category. Tools stay focusable while disabled (`aria-disabled`) so their hint
 * can be read. Keyboard shortcuts run tools directly (the app owns them).
 */
export function CommandBar({
  activeTool = null,
  enabledTools,
  onTool,
  onMore,
  className,
}: CommandBarProps) {
  const [open, setOpen] = useState<ToolGroupId | null>(null);
  const [left, setLeft] = useState(0);
  const [last, setLast] = useState(readLast);
  const wrap = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const hold = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    y: number;
  } | null>(null);
  const opened = useRef<'press' | 'drag' | null>(null);
  const enabled = (id: ToolId) => !!enabledTools?.includes(id);

  const remember = useCallback((id: ToolId) => {
    const g = toolGroups.find((x) => x.tools.includes(id));
    if (!g || g.tools.length < 2) return;
    setLast((prev) => {
      if (prev[g.id] === id) return prev;
      const next = { ...prev, [g.id]: id };
      writeJson(LAST_TOOLS_KEY, next);
      return next;
    });
  }, []);

  // Shortcuts and the palette change the active tool without the flyout: remember those too.
  useEffect(() => {
    if (activeTool) remember(activeTool);
  }, [activeTool, remember]);

  const groupButton = useCallback(
    (id: ToolGroupId) =>
      wrap.current?.querySelector<HTMLElement>(`[data-tool-group="${id}"]`) ?? null,
    [],
  );

  function close(refocus: boolean) {
    const o = open;
    setOpen(null);
    if (o && refocus) groupButton(o)?.focus();
  }

  // An outside press closes the flyout.
  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open]);

  function openGroup(g: ToolGroupDef, focus: boolean) {
    const btn = groupButton(g.id);
    const box = wrap.current?.getBoundingClientRect();
    if (btn && box) setLeft(btn.getBoundingClientRect().left - box.left);
    setOpen(g.id);
    if (focus) {
      // After the flyout mounts: the face tool if enabled, else the first enabled one.
      requestAnimationFrame(() => {
        const items = [...(flyout.current?.querySelectorAll<HTMLElement>('button') ?? [])];
        const face = faceOf(g, activeTool, last);
        (
          items.find((b) => b.dataset.tool === face && !b.hasAttribute('aria-disabled')) ??
          items.find((b) => !b.hasAttribute('aria-disabled')) ??
          items[0]
        )?.focus();
      });
    }
  }

  function pick(id: ToolId) {
    if (!enabled(id)) return;
    remember(id);
    onTool?.(id);
    close(true);
  }

  /* ----------------------------------------------------- touch: long press and drag up */
  const clearHold = useCallback(() => {
    if (hold.current?.timer) clearTimeout(hold.current.timer);
    hold.current = null;
  }, []);
  function pressDown(e: PointerEvent<HTMLElement>, g: ToolGroupDef) {
    if (e.pointerType === 'mouse') return;
    clearHold();
    opened.current = null;
    hold.current = {
      y: e.clientY,
      timer: setTimeout(() => {
        if (hold.current) hold.current.timer = null;
        opened.current = 'press';
        openGroup(g, false);
      }, HOLD_MS),
    };
  }
  function pressMove(e: PointerEvent<HTMLElement>, g: ToolGroupDef) {
    const h = hold.current;
    if (!h || opened.current === 'drag') return;
    if (h.y - e.clientY > DRAG_UP_PX) {
      clearHold();
      opened.current = 'drag';
      openGroup(g, false);
    }
  }
  // A drag up ends over a tool: releasing picks it, like a flyout menu.
  useEffect(() => {
    if (!open) return;
    const up = (e: globalThis.PointerEvent) => {
      clearHold();
      if (opened.current !== 'drag') return;
      opened.current = null;
      const el = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-flyout-item]');
      const id = el?.dataset.tool as ToolId | undefined;
      if (id && flyout.current?.contains(el ?? null)) pick(id);
    };
    document.addEventListener('pointerup', up);
    return () => document.removeEventListener('pointerup', up);
  });
  useEffect(() => clearHold, [clearHold]);

  /* ----------------------------------------------------- keyboard inside the flyout */
  function flyoutKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => {
      e.preventDefault();
      items[(j + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowUp') go(i <= 0 ? items.length - 1 : i - 1);
    else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') close(false);
  }

  const openDef = toolGroups.find((g) => g.id === open);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and focus-out are delegated from the buttons inside
    <div
      ref={wrap}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        // Focus left the bar and its flyout.
        if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node))
          setOpen(null);
      }}
    >
      <RToolbar.Root
        aria-label="Modeling tools"
        orientation="horizontal"
        className={cn(
          'w-panel pointer-events-auto flex items-stretch gap-0.5 rounded-panel p-1.5',
          className,
        )}
      >
        {toolGroups.map((g) => {
          const single = g.tools.length === 1;
          const faceId = single ? (g.tools[0] as ToolId) : faceOf(g, activeTool, last);
          const face = byId.get(faceId);
          if (!face) return null;
          const on = single ? enabled(faceId) : g.tools.some(enabled);
          const active = activeTool !== null && g.tools.includes(activeTool);
          const Icon = face.Icon;
          // The accessible name contains the visible label (WCAG 2.5.3) and names the category.
          const name = single ? face.label : `${face.label}, ${g.label} tools`;
          const tip = single
            ? on
              ? face.label
              : `${face.label} — ${toolHint(faceId)}`
            : `${g.label} tools`;
          return (
            <Tooltip
              key={g.id}
              content={tip}
              shortcut={single ? face.shortcut : undefined}
              side="top"
            >
              <RToolbar.Button
                aria-label={name}
                aria-disabled={single && !on ? 'true' : undefined}
                aria-pressed={single && on ? active : undefined}
                aria-expanded={single ? undefined : open === g.id}
                aria-haspopup={single ? undefined : 'true'}
                data-tool={single ? faceId : undefined}
                data-tool-group={g.id}
                data-active={active || undefined}
                onClick={(e) => {
                  if (single) {
                    if (on) pick(faceId);
                    else e.preventDefault();
                    return;
                  }
                  if (opened.current) {
                    opened.current = null; // the press that opened it also clicks: keep it open
                    return;
                  }
                  if (open === g.id) close(false);
                  else openGroup(g, false);
                }}
                onKeyDown={(e) => {
                  if (single) return;
                  if (e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (open === g.id) close(false);
                    else openGroup(g, true);
                  }
                }}
                onPointerDown={single ? undefined : (e) => pressDown(e, g)}
                onPointerMove={single ? undefined : (e) => pressMove(e, g)}
                onPointerUp={single ? undefined : clearHold}
                onPointerCancel={clearHold}
                className={cn(
                  item,
                  on && 'aria-disabled:opacity-100',
                  !single && open === g.id && 'bg-surface-3 text-fg',
                  active && 'bg-accent-soft text-accent-text',
                )}
              >
                <Icon className="size-[19px]" strokeWidth={1.75} aria-hidden />
                <span aria-hidden className="max-w-full truncate text-2xs leading-none font-medium">
                  {face.label}
                </span>
                {single ? null : (
                  <span
                    aria-hidden
                    data-testid="flyout-indicator"
                    className="absolute top-1.5 right-1.5 size-0 border-r-[4px] border-b-[4px] border-r-transparent border-b-current opacity-55"
                  />
                )}
              </RToolbar.Button>
            </Tooltip>
          );
        })}
        <RToolbar.Separator className="mx-1 my-2 w-px shrink-0 bg-border" />
        <Tooltip content="More tools and commands" shortcut="⌘K" side="top">
          <RToolbar.Button aria-label="More" onClick={onMore} className={item}>
            <Ellipsis className="size-[19px]" strokeWidth={1.75} aria-hidden />
            <span aria-hidden className="text-2xs leading-none font-medium">
              More…
            </span>
          </RToolbar.Button>
        </Tooltip>
      </RToolbar.Root>

      {openDef ? (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a fieldset
        <div
          ref={flyout}
          role="group"
          aria-label={`${openDef.label} tools`}
          data-testid="tool-flyout"
          onKeyDown={flyoutKey}
          style={{ left }}
          className="w-panel pointer-events-auto absolute bottom-[calc(100%+8px)] flex w-56 flex-col gap-0.5 p-1.5"
        >
          {openDef.tools.map((id) => {
            const t = byId.get(id);
            if (!t) return null;
            const on = enabled(id);
            return (
              <button
                key={id}
                type="button"
                data-tool={id}
                data-flyout-item
                aria-disabled={on ? undefined : 'true'}
                aria-pressed={on ? activeTool === id : undefined}
                onClick={() => pick(id)}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-control px-3 text-left text-sm font-medium text-fg transition-colors duration-fast select-none active:bg-surface-3 aria-disabled:text-fg-muted aria-disabled:opacity-70',
                  activeTool === id ? 'bg-accent-soft text-accent-text' : 'hover:bg-surface-2',
                )}
              >
                <t.Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {on ? (
                  t.shortcut ? (
                    <span aria-hidden className="text-2xs text-fg-subtle">
                      {t.shortcut}
                    </span>
                  ) : null
                ) : (
                  <span className="text-2xs text-fg-subtle">{toolHint(id)}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
