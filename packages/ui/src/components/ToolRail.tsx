import * as RToolbar from '@radix-ui/react-toolbar';
import { Ellipsis } from 'lucide-react';
import { m } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useSpring } from '../motion';
import { cn } from './primitives';
import { type ToolGroupId, type ToolId, toolGroups, toolHint, tools } from './tools';

export interface ToolRailProps {
  activeTool?: ToolId | null;
  /** Tools that are wired up; others stay visible but disabled with a per-tool hint. */
  enabledTools?: readonly ToolId[];
  onTool?(tool: ToolId): void;
  /** "More" opens the command palette. */
  onMore?(): void;
  /** Positioning of the rail (must be `relative` or `absolute`; the flyout anchors to it). */
  className?: string;
}

const byId = new Map(tools.map((t) => [t.id, t]));

const railBtn =
  'relative flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control text-fg-muted transition-colors duration-fast select-none active:bg-surface-3 aria-disabled:opacity-60';

/**
 * Slim left tool rail (PLAN 9.1 tablet) with four groups: Sketch / Solid / Modify / Inspect.
 * A group with several tools opens a flyout beside the rail (non-modal; Escape or an outside tap
 * closes it); a group with one tool is a direct button. The group icon shows the active tool.
 * Arrow keys move along the rail; every target is at least 44 px.
 */
export function ToolRail({
  activeTool = null,
  enabledTools,
  onTool,
  onMore,
  className,
}: ToolRailProps) {
  const [open, setOpen] = useState<ToolGroupId | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const spring = useSpring('fast');
  const enabled = (id: ToolId) => !!enabledTools?.includes(id);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', down, true);
    flyout.current?.querySelector<HTMLElement>('button:not([aria-disabled])')?.focus();
    return () => document.removeEventListener('pointerdown', down, true);
  }, [open]);

  function pick(id: ToolId, groupBtn?: HTMLElement | null) {
    if (!enabled(id)) return;
    onTool?.(id);
    if (open) {
      setOpen(null);
      groupBtn?.focus();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is delegated from the buttons inside
    <div
      ref={wrap}
      className={className ?? 'relative'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          const g = wrap.current?.querySelector<HTMLElement>(`[data-tool-group="${open}"]`);
          setOpen(null);
          g?.focus();
        }
      }}
    >
      <RToolbar.Root
        aria-label="Modeling tools"
        orientation="vertical"
        className="w-panel pointer-events-auto flex flex-col items-center gap-0.5 p-1.5"
      >
        {toolGroups.map((g) => {
          const single = g.tools.length === 1;
          const first = byId.get(g.tools[0] as ToolId);
          const current = g.tools.find((t) => t === activeTool);
          const active = current !== undefined;
          const shown = (current ? byId.get(current) : undefined) ?? first;
          const Icon = single ? (first?.Icon ?? g.Icon) : (shown?.Icon ?? g.Icon);
          const anyEnabled = g.tools.some(enabled);
          const name = single
            ? first && first.label !== g.label
              ? `${g.label}: ${first.label}`
              : g.label
            : `${g.label} tools`;
          return (
            <RToolbar.Button
              key={g.id}
              aria-label={name}
              aria-disabled={anyEnabled ? undefined : 'true'}
              aria-pressed={single && anyEnabled ? active : undefined}
              aria-expanded={single ? undefined : open === g.id}
              aria-haspopup={single ? undefined : 'true'}
              data-tool={single ? first?.id : undefined}
              data-tool-group={g.id}
              data-active={active || undefined}
              onClick={(e) => {
                if (single) {
                  if (first) pick(first.id);
                  return;
                }
                const btn = e.currentTarget;
                setTop(btn.offsetTop);
                setOpen((o) => (o === g.id ? null : g.id));
              }}
              className={cn(
                railBtn,
                !single && open === g.id && 'bg-surface-3 text-fg',
                active && 'bg-accent-soft text-accent-text',
              )}
            >
              <Icon className="size-[22px]" strokeWidth={1.7} aria-hidden />
              <span aria-hidden className="text-2xs leading-4 font-medium">
                {g.label}
              </span>
              {single ? null : (
                <span
                  aria-hidden
                  className="absolute right-1.5 bottom-1.5 size-0 border-t-[5px] border-l-[5px] border-t-transparent border-l-current opacity-50"
                  style={{ transform: 'rotate(90deg)' }}
                />
              )}
            </RToolbar.Button>
          );
        })}
        <RToolbar.Separator className="mx-1.5 my-1 h-px w-10 shrink-0 bg-border" />
        <RToolbar.Button aria-label="More" onClick={onMore} className={railBtn}>
          <Ellipsis className="size-[22px]" strokeWidth={1.7} aria-hidden />
          <span aria-hidden className="text-2xs leading-4 font-medium">
            More
          </span>
        </RToolbar.Button>
      </RToolbar.Root>

      {open ? (
        <m.div
          ref={flyout}
          role="group"
          aria-label={`${toolGroups.find((g) => g.id === open)?.label} tools`}
          data-testid="tool-flyout"
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={spring}
          style={{ top }}
          className="w-panel pointer-events-auto absolute left-[calc(100%+8px)] flex w-44 flex-col gap-0.5 p-1.5"
        >
          {toolGroups
            .find((g) => g.id === open)
            ?.tools.map((id) => {
              const t = byId.get(id);
              if (!t) return null;
              const on = enabled(id);
              const group = wrap.current?.querySelector<HTMLElement>(`[data-tool-group="${open}"]`);
              return (
                <button
                  key={id}
                  type="button"
                  data-tool={id}
                  aria-disabled={on ? undefined : 'true'}
                  aria-pressed={on ? activeTool === id : undefined}
                  title={on ? undefined : toolHint(id)}
                  onClick={() => pick(id, group)}
                  className={cn(
                    'flex h-12 items-center gap-3 rounded-control px-3 text-left text-sm font-medium text-fg transition-colors duration-fast select-none active:bg-surface-3 aria-disabled:text-fg-muted aria-disabled:opacity-60',
                    activeTool === id ? 'bg-accent-soft text-accent-text' : 'hover:bg-surface-2',
                  )}
                >
                  <t.Icon className="size-5 shrink-0" strokeWidth={1.7} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {t.shortcut ? (
                    <span aria-hidden className="text-2xs text-fg-subtle">
                      {t.shortcut}
                    </span>
                  ) : null}
                </button>
              );
            })}
        </m.div>
      ) : null}
    </div>
  );
}
