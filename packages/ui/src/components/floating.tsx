import { m } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSpring } from '../motion';
import { cn, Kbd } from './primitives';

/** Where a floating layer attaches: an element (trigger) or a viewport point (context menu). */
export type FloatingAnchor = HTMLElement | { x: number; y: number };
export type FloatingPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'right-start';

export interface FloatingLayerProps {
  anchor: FloatingAnchor;
  placement?: FloatingPlacement;
  onDismiss(): void;
  children: ReactNode;
  className?: string;
  /** Accessible name. */
  label?: string;
  role?: 'dialog' | 'menu' | 'listbox' | 'group';
  offset?: number;
  /** Move focus into the layer on open (default true). */
  focusOnOpen?: boolean;
  /** Return focus to where it was when the layer closes (default true). */
  restoreFocus?: boolean;
  testId?: string;
}

const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function anchorRect(a: FloatingAnchor): Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> {
  if (a instanceof HTMLElement) return a.getBoundingClientRect();
  return { left: a.x, right: a.x, top: a.y, bottom: a.y };
}

/**
 * Non-modal popover: portalled, positioned against an anchor with viewport flipping/clamping,
 * dismissed by Escape or an outside press. No focus trap, no scroll lock (PLAN 9.2: nothing in
 * modeling is modal).
 */
export function FloatingLayer({
  anchor,
  placement = 'bottom-start',
  onDismiss,
  children,
  className,
  label,
  role = 'dialog',
  offset = 6,
  focusOnOpen = true,
  restoreFocus = true,
  testId,
}: FloatingLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const spring = useSpring('fast');

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchorRect(anchor);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pad = 8;
    let left: number;
    let top: number;
    if (placement === 'right-start') {
      left = r.right + offset;
      top = r.top;
      if (left + w > vw - pad) left = r.left - w - offset;
    } else {
      left = placement === 'bottom-end' ? r.right - w : r.left;
      top = placement === 'top-start' ? r.top - h - offset : r.bottom + offset;
      if (placement === 'top-start' ? top < pad : top + h > vh - pad) {
        const flipped = placement === 'top-start' ? r.bottom + offset : r.top - h - offset;
        if (flipped >= pad && flipped + h <= vh - pad) top = flipped;
      }
    }
    left = Math.max(pad, Math.min(left, vw - w - pad));
    top = Math.max(pad, Math.min(top, vh - h - pad));
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, placement, offset]);

  useLayoutEffect(() => {
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  // Focus once the layer has been positioned (it is `visibility: hidden` until then, and hidden
  // elements cannot take focus).
  const focused = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!pos || !focusOnOpen || !el || focused.current) return;
    focused.current = true;
    const target =
      el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? (el.firstElementChild as HTMLElement | null) ?? el).focus({ preventScroll: true });
  }, [pos, focusOnOpen]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    function down(e: PointerEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      dismiss.current();
    }
    function key(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      dismiss.current();
    }
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      const active = document.activeElement;
      const stolen = active && active !== document.body && !el?.contains(active);
      if (restoreFocus && !stolen && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [anchor, restoreFocus]);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-[var(--z-popover)]"
      data-testid={testId}
    >
      <m.div
        role={role}
        aria-label={label}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={spring}
        className={cn(
          'rounded-panel bg-surface text-fg shadow-pop outline-none select-none',
          className,
        )}
      >
        {children}
      </m.div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------------- Menu */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a check mark (toggle style menus). */
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect(): void;
}

export interface MenuProps {
  anchor: FloatingAnchor;
  items: readonly MenuItem[];
  onDismiss(): void;
  label: string;
  placement?: FloatingPlacement;
  /** `touch` makes rows 44px tall. */
  size?: 'md' | 'touch';
}

/** A roving-focus action menu. Arrow keys / Home / End move, Enter or Space selects. */
export function Menu({ anchor, items, onDismiss, label, placement, size = 'md' }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const firstEnabled = items.findIndex((x) => !x.disabled);

  function move(delta: number | 'first' | 'last') {
    const nodes = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    if (!nodes.length) return;
    const cur = nodes.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = nodes.length - 1;
    else next = (cur + delta + nodes.length) % nodes.length;
    nodes[next]?.focus();
  }

  return (
    <FloatingLayer
      anchor={anchor}
      placement={placement}
      onDismiss={onDismiss}
      label={label}
      role="menu"
      className="min-w-48 p-1"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: roving-focus keyboard handler for the menu */}
      <div
        ref={listRef}
        role="presentation"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') move(1);
          else if (e.key === 'ArrowUp') move(-1);
          else if (e.key === 'Home') move('first');
          else if (e.key === 'End') move('last');
          else if (e.key === 'Tab') onDismiss();
          else return;
          e.preventDefault();
        }}
      >
        {items.map((item, i) => (
          <div key={item.id} role="none">
            {item.separatorBefore && i > 0 ? (
              <hr className="m-0 my-1 h-px border-0 bg-border" />
            ) : null}
            <button
              type="button"
              {...(item.checked === undefined
                ? { role: 'menuitem' }
                : { role: 'menuitemcheckbox', 'aria-checked': item.checked })}
              aria-disabled={item.disabled || undefined}
              data-autofocus={i === firstEnabled ? '' : undefined}
              tabIndex={-1}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                onDismiss();
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-ui outline-none transition-colors duration-fast',
                size === 'touch' ? 'h-11' : 'h-8',
                'hover:bg-surface-2 focus-visible:bg-surface-3 aria-disabled:opacity-45',
                item.danger ? 'text-danger-text' : 'text-fg',
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted">
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
              {item.checked ? <span aria-hidden>✓</span> : null}
            </button>
          </div>
        ))}
      </div>
    </FloatingLayer>
  );
}
