import * as RToolbar from '@radix-ui/react-toolbar';
import { Ellipsis } from 'lucide-react';
import { cn, Tooltip } from './primitives';
import { COMING_SOON, type ToolId, tools } from './tools';

export interface CommandBarProps {
  /** Highlights a tool. */
  activeTool?: ToolId | null;
  /** Tools that are wired up; every other tool stays disabled with a "Coming in M1" hint. */
  enabledTools?: readonly ToolId[];
  onTool?(tool: ToolId): void;
  /** "More" opens the command palette. */
  onMore?: () => void;
  /** `bar` = labelled bottom-centre bar (desktop); `rail` = icon-only vertical rail (tablet). */
  layout?: 'bar' | 'rail';
  className?: string;
}

const itemBase =
  'relative flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-control text-fg-muted transition-colors duration-150 select-none hover:bg-surface-2 hover:text-fg active:bg-surface-3 aria-disabled:opacity-60';

/**
 * Floating command bar (PLAN 9.1). Arrow keys move between tools (roving tabindex). Tools stay
 * focusable while disabled (`aria-disabled`) so their tooltip can explain "Coming in M1".
 */
export function CommandBar({
  activeTool = null,
  enabledTools,
  onTool,
  onMore,
  layout = 'bar',
  className,
}: CommandBarProps) {
  const rail = layout === 'rail';
  return (
    <RToolbar.Root
      aria-label="Modeling tools"
      orientation={rail ? 'vertical' : 'horizontal'}
      className={cn(
        'w-panel pointer-events-auto flex gap-0.5 p-1.5',
        rail ? 'flex-col rounded-[18px]' : 'items-stretch rounded-[18px]',
        className,
      )}
    >
      {tools.map(({ id, label, shortcut, Icon }) => {
        const active = activeTool === id;
        const enabled = !!enabledTools?.includes(id);
        return (
          <Tooltip
            key={id}
            content={enabled ? label : `${label} — ${COMING_SOON}`}
            shortcut={shortcut}
            side={rail ? 'right' : 'top'}
          >
            <RToolbar.Button
              aria-label={label}
              aria-disabled={enabled ? undefined : 'true'}
              aria-pressed={enabled ? active : undefined}
              data-tool={id}
              onClick={(e) => {
                if (enabled) onTool?.(id);
                else e.preventDefault();
              }}
              className={cn(
                itemBase,
                rail ? 'size-11' : 'h-[52px] w-[58px]',
                enabled && 'aria-disabled:opacity-100',
                active && 'bg-accent-soft text-accent-text',
              )}
            >
              <Icon className="size-[19px]" strokeWidth={1.75} aria-hidden />
              {rail ? null : <span className="text-2xs leading-none font-medium">{label}</span>}
            </RToolbar.Button>
          </Tooltip>
        );
      })}
      <RToolbar.Separator
        className={cn('shrink-0 bg-border', rail ? 'mx-1.5 my-1 h-px' : 'mx-1 my-2 w-px')}
      />
      <Tooltip content="More tools and commands" shortcut="⌘K" side={rail ? 'right' : 'top'}>
        <RToolbar.Button
          aria-label="More"
          onClick={onMore}
          className={cn(itemBase, rail ? 'size-11' : 'h-[52px] w-[58px]')}
        >
          <Ellipsis className="size-[19px]" strokeWidth={1.75} aria-hidden />
          {rail ? null : <span className="text-2xs leading-none font-medium">More</span>}
        </RToolbar.Button>
      </Tooltip>
    </RToolbar.Root>
  );
}
