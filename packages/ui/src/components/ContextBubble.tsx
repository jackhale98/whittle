import * as RToolbar from '@radix-ui/react-toolbar';
import { m } from 'motion/react';
import { type ReactNode, useRef } from 'react';
import type { Rect, Side } from '../logic/bubble';
import { useSpring } from '../motion';
import { cn } from './primitives';
import { useAnchored } from './useAnchored';

export interface BubbleAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect(): void;
}

export interface ContextBubbleProps {
  /**
   * Anchor point in px, relative to the bubble's positioned parent (the viewport stage). Update it
   * every frame while the camera moves; the bubble follows without animating. `null` hides it.
   */
  anchor: { x: number; y: number } | null;
  /** 3-4 actions (more are ignored: a bubble is a shortcut, not a menu). */
  actions: readonly BubbleAction[];
  /** Accessible name of the toolbar, e.g. "Face actions". */
  label?: string;
  preferred?: Side;
  /** Areas to stay clear of, in the same coordinates as `anchor` (rail, top bar). */
  obstacles?: readonly Rect[];
  /** Escape pressed while focus is inside. */
  onDismiss?(): void;
  className?: string;
}

const MAX_ACTIONS = 4;

/**
 * Context bubble (PLAN 9.1 tablet): 3-4 actions floating next to the selection. It prefers to sit
 * above the anchor, flips below / beside it at the edges, stays inside the safe area and never
 * covers the anchor. It does not take focus, so the selection stays live in the viewport.
 */
export function ContextBubble({
  anchor,
  actions,
  label = 'Selection actions',
  preferred = 'above',
  obstacles,
  onDismiss,
  className,
}: ContextBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const spring = useSpring('fast');
  const placement = useAnchored(ref, anchor, { preferred, obstacles });

  const list = actions.slice(0, MAX_ACTIONS);
  const hidden = !anchor || !placement;
  const tip = placement?.tip;
  const side = placement?.side ?? 'above';

  return (
    <div
      ref={ref}
      data-testid="context-bubble"
      data-side={hidden ? undefined : side}
      data-anchored={hidden ? undefined : ''}
      hidden={!anchor}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: placement
          ? `translate3d(${placement.left}px, ${placement.top}px, 0)`
          : undefined,
        visibility: hidden ? 'hidden' : 'visible',
      }}
      className={cn('pointer-events-auto z-[var(--z-panel)]', className)}
    >
      <m.div
        key={anchor ? 'on' : 'off'}
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={spring}
        style={{ transformOrigin: tip ? `${tip.x}px ${tip.y}px` : undefined }}
        className="relative"
      >
        <RToolbar.Root
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onDismiss?.();
            }
          }}
          className="w-panel flex gap-0.5 p-1"
        >
          {list.map((a) => (
            <RToolbar.Button
              key={a.id}
              disabled={a.disabled}
              onClick={a.onSelect}
              data-action={a.id}
              className={cn(
                'flex h-14 min-w-14 flex-col items-center justify-center gap-0.5 rounded-control px-2 text-2xs font-medium transition-colors duration-fast select-none active:bg-surface-3 disabled:opacity-45',
                a.tone === 'danger' ? 'text-danger-text' : 'text-fg hover:bg-surface-2',
              )}
            >
              {a.icon ? (
                <span className="flex size-6 items-center justify-center" aria-hidden>
                  {a.icon}
                </span>
              ) : null}
              <span className="leading-4">{a.label}</span>
            </RToolbar.Button>
          ))}
        </RToolbar.Root>
        {tip ? (
          <span
            aria-hidden
            data-testid="context-bubble-tip"
            className="pointer-events-none absolute size-3 rotate-45 rounded-[3px] bg-[var(--color-surface)] shadow-[0_0_0_1px_rgb(15_23_42/0.06)]"
            style={{ left: tip.x - 6, top: tip.y - 6, zIndex: -1 }}
          />
        ) : null}
      </m.div>
    </div>
  );
}
