import { useEffect, useMemo, useRef, useState } from 'react';
import { cn, Kbd } from '../components/primitives';
import {
  bindingParts,
  type KeymapCommand,
  type KeymapContext,
  type LayoutMap,
  type Platform,
  parseBinding,
  type ResolvedKeymap,
} from './keymap';

export type HeldModifier = 'mod' | 'alt';

export interface ModifierHoldOptions {
  /** Hold time before the overlay shows (ms). Default 600. */
  delay?: number;
  enabled?: boolean;
}

const MODIFIER_KEYS: Record<string, HeldModifier> = {
  ControlLeft: 'mod',
  ControlRight: 'mod',
  MetaLeft: 'mod',
  MetaRight: 'mod',
  AltLeft: 'alt',
  AltRight: 'alt',
};

/**
 * True after Ctrl / Cmd / Alt has been held alone for `delay` ms (ExposeHK, CHI 2013). Any other
 * key (the user is typing a chord), a pointer press or wheel (Ctrl-click multi-select), blur or
 * releasing the modifier hides it and restarts the clock. Listeners are passive and never cancel
 * events.
 */
export function useModifierHold({ delay = 600, enabled = true }: ModifierHoldOptions = {}): {
  visible: boolean;
  held: HeldModifier | null;
} {
  const [state, setState] = useState<{ visible: boolean; held: HeldModifier | null }>({
    visible: false,
    held: null,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const down = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    const stop = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const reset = () => {
      stop();
      down.current.clear();
      setState((s) => (s.visible || s.held ? { visible: false, held: null } : s));
    };
    const onDown = (e: KeyboardEvent) => {
      const mod = MODIFIER_KEYS[e.code];
      if (!mod) {
        reset(); // a chord, not a hold
        return;
      }
      if (e.repeat) return;
      down.current.add(e.code);
      stop();
      timer.current = setTimeout(() => setState({ visible: true, held: mod }), delay);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!MODIFIER_KEYS[e.code]) return;
      down.current.delete(e.code);
      if (down.current.size === 0) reset();
    };
    const onHide = () => reset();
    document.addEventListener('keydown', onDown, true);
    document.addEventListener('keyup', onUp, true);
    document.addEventListener('pointerdown', onHide, true);
    document.addEventListener('wheel', onHide, { capture: true, passive: true });
    window.addEventListener('blur', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      stop();
      document.removeEventListener('keydown', onDown, true);
      document.removeEventListener('keyup', onUp, true);
      document.removeEventListener('pointerdown', onHide, true);
      document.removeEventListener('wheel', onHide, true);
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [delay, enabled]);

  return state;
}

export interface ShortcutOverlayProps {
  commands: readonly KeymapCommand[];
  resolved: ResolvedKeymap;
  /** Contexts available now, e.g. `['sketch', 'global']` while sketching. */
  contexts: readonly KeymapContext[];
  /** Controlled visibility; use {@link useModifierHold} for the 600 ms rule. */
  visible: boolean;
  /** The modifier being held: its chords are listed first and emphasised. */
  held?: HeldModifier | null;
  platform?: Platform;
  layout?: LayoutMap | null;
  className?: string;
}

/**
 * Shortcuts available in the current context, shown while a modifier is held. Non-interactive and
 * non-modal (it must not take focus, or the held key would be lost); it announces itself politely.
 */
export function ShortcutOverlay({
  commands,
  resolved,
  contexts,
  visible,
  held,
  platform,
  layout,
  className,
}: ShortcutOverlayProps) {
  const groups = useMemo(() => {
    const out = new Map<string, { cmd: KeymapCommand; bindings: string[]; match: boolean }[]>();
    for (const cmd of commands) {
      if (!contexts.includes(cmd.context)) continue;
      const bindings = [...(resolved[cmd.id] ?? [])];
      if (bindings.length === 0) continue;
      const match =
        !!held &&
        bindings.some((b) => {
          const p = parseBinding(b);
          return held === 'mod' ? p?.mod : p?.alt;
        });
      const list = out.get(cmd.group) ?? [];
      list.push({ cmd, bindings, match });
      out.set(cmd.group, list);
    }
    for (const list of out.values()) list.sort((a, b) => Number(b.match) - Number(a.match));
    return [...out.entries()];
  }, [commands, resolved, contexts, held]);

  if (!visible) return null;
  return (
    <section
      aria-label="Keyboard shortcuts available now"
      data-testid="shortcut-overlay"
      data-held={held ?? undefined}
      className={cn(
        'w-panel pointer-events-none fixed bottom-6 left-1/2 z-[var(--z-popover)] max-h-[min(70vh,520px)] w-[min(92vw,720px)] -translate-x-1/2 overflow-hidden rounded-panel p-4 shadow-pop',
        className,
      )}
    >
      <div className="columns-1 gap-6 sm:columns-2 lg:columns-3">
        {groups.map(([group, rows]) => (
          <div key={group} className="mb-3 break-inside-avoid">
            <h2 className="mb-1 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
              {group}
            </h2>
            <ul className="m-0 list-none p-0">
              {rows.map(({ cmd, bindings, match }) => (
                <li
                  key={cmd.id}
                  data-match={match ? '' : undefined}
                  className={cn(
                    'flex items-center justify-between gap-3 py-0.5 text-ui',
                    match ? 'font-medium text-fg' : 'text-fg-muted',
                  )}
                >
                  <span className="min-w-0 truncate">{cmd.label}</span>
                  <span className="flex shrink-0 gap-1">
                    {bindings.slice(0, 2).map((b) => {
                      const p = parseBinding(b);
                      return (
                        <span key={b} className="flex gap-0.5">
                          {p
                            ? bindingParts(p, {
                                ...(platform ? { platform } : {}),
                                layout: layout ?? null,
                              }).map((part) => <Kbd key={part}>{part}</Kbd>)
                            : b}
                        </span>
                      );
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
