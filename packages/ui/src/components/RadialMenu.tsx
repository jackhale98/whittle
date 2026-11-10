import { RotateCw } from 'lucide-react';
import { m } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  clampCenter,
  layoutSlots,
  RADIAL_SLOTS,
  type RadialSlot,
  slotDirection,
  slotFromDigitCode,
  slotFromVector,
  stepSlot,
} from '../logic/radial';
import { useSpring } from '../motion';
import { cn } from './primitives';

export type { RadialSlot } from '../logic/radial';

/** Id passed to `onSelect` when the fixed "Repeat" slot is chosen. */
export const RADIAL_REPEAT_ID = 'repeat';

export interface RadialItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** Pin to a slot (muscle memory); otherwise items fill clockwise from north-east. */
  slot?: RadialSlot;
}

export interface RadialMenuProps {
  /** Screen point (client px) the menu opens at: the cursor, or the long-press point. */
  at: { x: number; y: number };
  /** Chosen by the app from the selection type. With the Repeat slot at most 8 in total. */
  items: readonly RadialItem[];
  /** The fixed Repeat slot. `label` is the last command ("Extrude"); null/omitted = no slot. */
  repeat?: { label: string; disabled?: boolean } | null;
  /** Where the Repeat slot sits (default north). */
  repeatSlot?: RadialSlot;
  /**
   * What opened it. Every source draws at once by default. `mouse` and `pen` also accept a flick
   * for `flickWindow` ms after opening (none for `keyboard` and `touch`).
   */
  source?: 'mouse' | 'pen' | 'touch' | 'keyboard';
  /**
   * The opening pointer is still down (touch long-press): drag to an item and lift to select. The
   * menu stays open when lifted without a direction.
   */
  held?: boolean;
  /** Id of that pointer; any pointer's release counts when omitted. */
  pointerId?: number;
  /** `KeyboardEvent.code` of a held opening key; releasing it selects by pointer direction. */
  holdCode?: string;
  /** Delay before drawing, ms (default 0: draw at once; ADR-076). Flicks still work meanwhile. */
  drawDelay?: number;
  /** How long after opening a mouse or pen flick selects, ms (default 250). 0 disables flicks. */
  flickWindow?: number;
  /** Pointer travel that counts as a flick, px (default 40). */
  flickDistance?: number;
  onSelect(id: string): void;
  onCancel(): void;
  label?: string;
  testId?: string;
}

const INNER = 24;

/** One-shot capture listener that eats the click that follows a press the menu has consumed. */
function swallowNextClick() {
  const eat = (e: Event) => {
    // A click on one of our own items is legitimate: its press began after the menu existed.
    if (e.target instanceof Element && e.target.closest('[data-radial-item]')) return;
    e.stopPropagation();
    e.preventDefault();
    off();
  };
  const off = () => {
    document.removeEventListener('click', eat, true);
    document.removeEventListener('auxclick', eat, true);
    clearTimeout(t);
  };
  const t = setTimeout(off, 500);
  document.addEventListener('click', eat, true);
  document.addEventListener('auxclick', eat, true);
}

/**
 * Radial context menu (PLAN 9.4, ADR-046). At most eight items by direction with a fixed Repeat
 * slot. Fully controlled: the app decides the contents and receives `onSelect` / `onCancel`.
 *
 * - Flick: within `flickWindow` of opening (mouse, pen), moving `flickDistance` toward an item
 *   selects it, whether or not it has drawn yet.
 * - Held (touch long-press, held key): drag to an item and lift.
 * - It never acts on a click that began before it opened, and the click that cancels it is eaten.
 * - Keyboard: arrows move, Enter selects, digits 1-8 pick a slot clockwise from north.
 */
export function RadialMenu({
  at,
  items,
  repeat,
  repeatSlot = 'n',
  source = 'mouse',
  held = false,
  pointerId,
  holdCode,
  drawDelay = 0,
  flickWindow = 250,
  flickDistance = 40,
  onSelect,
  onCancel,
  label = 'Commands',
  testId = 'radial-menu',
}: RadialMenuProps) {
  const touch = source === 'touch';
  // Wide pills show whole labels; a phone-width viewport gets narrow ones (the full label stays in
  // the accessible name). The ring is sized so neighbouring pills never touch.
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const compact = vw < 480;
  const pillW = compact ? 88 : 128;
  const ring = touch ? 140 : compact ? 124 : 136;
  const pillH = touch ? 40 : 34;
  const flicks = (source === 'mouse' || source === 'pen') && flickWindow > 0;
  const instant = !flicks || drawDelay <= 0;
  const [drawn, setDrawn] = useState(instant);
  const [hover, setHover] = useState<RadialSlot | null>(null);
  const spring = useSpring('fast');
  const root = useRef<HTMLDivElement>(null);

  // Slot -> item (the Repeat pseudo item included).
  const slots = useMemo(() => {
    const { placed } = layoutSlots(items, repeat ? [repeatSlot] : []);
    const all: Partial<Record<RadialSlot, RadialItem & { name?: string }>> = { ...placed };
    if (repeat) {
      all[repeatSlot] = {
        id: RADIAL_REPEAT_ID,
        // Shown short (icon + the command); announced in full.
        label: repeat.label,
        name: `Repeat ${repeat.label}`,
        icon: <RotateCw className="size-4" />,
        disabled: repeat.disabled ?? false,
      };
    }
    return all;
  }, [items, repeat, repeatSlot]);
  const enabledSlots = useMemo(
    () => new Set(RADIAL_SLOTS.filter((s) => slots[s] && !slots[s]?.disabled)),
    [slots],
  );

  const hw = ring + pillW / 2;
  const hh = ring + pillH / 2;
  const center = useMemo(
    () => clampCenter(at, { x: hw, y: hh }, { width: vw, height: vh }),
    [at, hw, hh, vw, vh],
  );

  // Everything else lives in refs so the document listeners attach once.
  const live = useRef({ slots, enabledSlots, onSelect, onCancel, center, at, drawn, held });
  live.current = { slots, enabledSlots, onSelect, onCancel, center, at, drawn, held };
  const finished = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const holdingPointer = useRef(held);
  holdingPointer.current = held ? holdingPointer.current : false;

  const finish = useCallback((slot: RadialSlot | null, how: 'select' | 'cancel') => {
    if (finished.current) return;
    const L = live.current;
    if (how === 'select') {
      const item = slot ? L.slots[slot] : undefined;
      if (!item || item.disabled) return;
      finished.current = true;
      L.onSelect(item.id);
    } else {
      finished.current = true;
      L.onCancel();
    }
  }, []);

  const draw = useCallback(() => setDrawn(true), []);

  // An optional visible delay (off by default): experts can flick before this fires.
  useEffect(() => {
    if (instant) return;
    const t = setTimeout(draw, drawDelay);
    return () => clearTimeout(t);
  }, [instant, drawDelay, draw]);

  // The flick window. Once the menu is visible a flick is measured from the visible centre, so a
  // menu pushed in from a screen edge (pointer away from its centre) takes no flicks once drawn.
  const flickOpen = useRef(flicks);
  useEffect(() => {
    if (!flicks) return;
    const t = setTimeout(
      () => {
        flickOpen.current = false;
      },
      Math.max(flickWindow, instant ? 0 : drawDelay),
    );
    return () => clearTimeout(t);
  }, [flicks, flickWindow, instant, drawDelay]);

  // Focus moves are requested by state and applied after the render that drew the items.
  const [focusReq, setFocusReq] = useState<{ slot: RadialSlot; n: number } | null>(null);
  const focusSlot = useCallback((slot: RadialSlot | null) => {
    if (slot) setFocusReq((r) => ({ slot, n: (r?.n ?? 0) + 1 }));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` re-applies a request made before the items existed
  useEffect(() => {
    if (!focusReq) return;
    setHover(focusReq.slot);
    root.current
      ?.querySelector<HTMLElement>(`[data-slot="${focusReq.slot}"]`)
      ?.focus({ preventScroll: true });
  }, [focusReq, drawn]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const inMenu = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('[data-radial-item]') && !!root.current?.contains(t);

    const slotFor = (p: { x: number; y: number }) => {
      const L = live.current;
      const o = L.drawn ? L.center : L.at;
      const s = slotFromVector(p.x - o.x, p.y - o.y, L.drawn ? INNER : flickDistance);
      return s && L.enabledSlots.has(s) ? s : null;
    };
    const flickSlot = (p: { x: number; y: number }) => {
      const L = live.current;
      if (L.drawn && Math.hypot(L.center.x - L.at.x, L.center.y - L.at.y) > 1) return null;
      const s = slotFromVector(p.x - L.at.x, p.y - L.at.y, flickDistance);
      return s && L.enabledSlots.has(s) ? s : null;
    };

    function move(e: PointerEvent) {
      last.current = { x: e.clientX, y: e.clientY };
      const L = live.current;
      if (!L.drawn || flickOpen.current) {
        // Flick: a quick movement toward an item selects it, drawn or not.
        if (!holdingPointer.current && !holdCode && flickOpen.current) {
          const s = flickSlot(last.current);
          if (s) finish(s, 'select');
        }
        if (!L.drawn) return;
      }
      if (holdingPointer.current || holdCode) setHover(slotFor(last.current));
    }

    function down(e: PointerEvent) {
      if (finished.current) return;
      if (inMenu(e.target)) return; // an item press: its click selects
      // A press outside (or on the empty ring) cancels, and its click must not reach what is
      // behind the menu.
      swallowNextClick();
      finish(null, 'cancel');
    }

    function up(e: PointerEvent) {
      if (!holdingPointer.current) return; // never act on a press that began before we opened
      if (pointerId !== undefined && e.pointerId !== pointerId) return;
      holdingPointer.current = false;
      last.current = { x: e.clientX, y: e.clientY };
      swallowNextClick();
      const s = slotFor(last.current);
      if (s) finish(s, 'select');
      else draw(); // lifted without a direction: stay open so the user can tap an item
    }

    function key(e: KeyboardEvent) {
      if (finished.current) return;
      const L = live.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null, 'cancel');
        return;
      }
      if (e.key === 'Tab') {
        finish(null, 'cancel');
        return;
      }
      const digit = slotFromDigitCode(e.code);
      if (digit) {
        e.preventDefault();
        e.stopPropagation();
        if (L.enabledSlots.has(digit)) finish(digit, 'select');
        return;
      }
      const arrows = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'];
      if (!arrows.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      draw();
      const cur = (document.activeElement as HTMLElement | null)?.dataset?.slot as
        | RadialSlot
        | undefined;
      const focused =
        cur && RADIAL_SLOTS.includes(cur) && root.current?.contains(document.activeElement)
          ? cur
          : null;
      let next: RadialSlot | null;
      if (e.key === 'Home') next = stepSlot(L.enabledSlots, null, 1);
      else if (e.key === 'End') next = stepSlot(L.enabledSlots, null, -1);
      else if (!focused) {
        // Nothing focused yet: an arrow points straight at its slot (up = north ...).
        const direct: RadialSlot =
          e.key === 'ArrowUp'
            ? 'n'
            : e.key === 'ArrowRight'
              ? 'e'
              : e.key === 'ArrowDown'
                ? 's'
                : 'w';
        next = L.enabledSlots.has(direct)
          ? direct
          : stepSlot(
              L.enabledSlots,
              direct,
              e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1,
            );
      } else {
        next = stepSlot(
          L.enabledSlots,
          focused,
          e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1,
        );
      }
      focusSlot(next);
    }

    function keyUp(e: KeyboardEvent) {
      if (!holdCode || e.code !== holdCode || finished.current) return;
      const p = last.current;
      const s = p ? slotFor(p) : null;
      if (s) finish(s, 'select');
      else finish(null, 'cancel'); // spring-loaded: let go without choosing = nothing
    }

    function ctx(e: Event) {
      e.preventDefault(); // no native menu on top of ours
    }
    function abort() {
      finish(null, 'cancel');
    }

    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', abort, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('keyup', keyUp, true);
    document.addEventListener('contextmenu', ctx, true);
    window.addEventListener('blur', abort);
    window.addEventListener('resize', abort);
    return () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', abort, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('keyup', keyUp, true);
      document.removeEventListener('contextmenu', ctx, true);
      window.removeEventListener('blur', abort);
      window.removeEventListener('resize', abort);
      const a = document.activeElement;
      if ((!a || a === document.body || root.current?.contains(a)) && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [finish, draw, focusSlot, flickDistance, holdCode, pointerId]);

  // Keyboard-opened menus take focus on the first enabled slot once drawn.
  useEffect(() => {
    if (drawn && source === 'keyboard') {
      focusSlot(stepSlot(enabledSlots, null, 1));
    }
  }, [drawn, source, enabledSlots, focusSlot]);

  if (!drawn) return null;

  const digitOf = (s: RadialSlot) => RADIAL_SLOTS.indexOf(s) + 1;
  return createPortal(
    <div
      ref={root}
      role="menu"
      aria-label={label}
      data-testid={testId}
      data-source={source}
      data-center-x={center.x}
      data-center-y={center.y}
      // The box spans the whole ring; only the items take pointer events.
      style={{
        position: 'fixed',
        left: center.x - hw,
        top: center.y - hh,
        width: hw * 2,
        height: hh * 2,
        pointerEvents: 'none',
      }}
      className="z-[var(--z-popover)] select-none"
    >
      <span
        aria-hidden
        style={{ left: hw, top: hh }}
        className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-subtle/60"
      />
      {RADIAL_SLOTS.map((slot) => {
        const item = slots[slot];
        if (!item) return null;
        const d = slotDirection(slot);
        const active = hover === slot;
        return (
          <m.div
            key={slot}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={spring}
            style={{
              position: 'absolute',
              left: hw + d.x * ring,
              top: hh + d.y * ring,
              pointerEvents: 'auto',
              translateX: '-50%',
              translateY: '-50%',
            }}
          >
            <button
              type="button"
              role="menuitem"
              data-radial-item=""
              data-slot={slot}
              data-item={item.id}
              data-active={active ? '' : undefined}
              aria-disabled={item.disabled || undefined}
              aria-keyshortcuts={String(digitOf(slot))}
              aria-label={item.name ?? item.label}
              title={item.name ?? item.label}
              tabIndex={-1}
              onMouseEnter={() => setHover(slot)}
              onMouseLeave={() => setHover((h) => (h === slot ? null : h))}
              onFocus={() => setHover(slot)}
              onClick={() => {
                if (item.disabled) return;
                finish(slot, 'select');
              }}
              style={{ width: pillW, height: pillH }}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-full px-2.5 text-ui font-medium shadow-pop outline-none transition-colors duration-fast',
                'focus-visible:outline-2 focus-visible:outline-accent aria-disabled:opacity-45',
                active ? 'bg-accent text-accent-fg' : 'bg-surface text-fg hover:bg-surface-2',
                item.danger && !active && 'text-danger-text',
              )}
            >
              {item.icon ? (
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
              ) : null}
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          </m.div>
        );
      })}
    </div>,
    document.body,
  );
}
