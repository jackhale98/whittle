import { ArrowLeft, ArrowRight, Delete, Keyboard } from 'lucide-react';
import { m } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type KeypadPlacement, placeKeypad } from '../logic/bubble';
import { readSafeInsets } from '../logic/dom';
import { KEYPAD_UNITS, type KeypadKey } from '../logic/keypad';
import { useSpring } from '../motion';
import { cn } from './primitives';

export type { KeypadKey };

type Tone = 'num' | 'op' | 'unit' | 'enter' | 'fn' | 'param';

interface KeyDef {
  label: string;
  /** Accessible name when the glyph alone is ambiguous. */
  name?: string;
  key: KeypadKey;
  tone?: Tone;
}

const num = (d: string): KeyDef => ({ label: d, key: { kind: 'insert', text: d } });
const op = (o: '+' | '-' | '*' | '/', label: string, name: string): KeyDef => ({
  label,
  name,
  key: { kind: 'operator', op: o },
  tone: 'op',
});
const paren = (p: '(' | ')', name: string): KeyDef => ({
  label: p,
  name,
  key: { kind: 'insert', text: p },
  tone: 'op',
});

const EXPR_ROW: readonly KeyDef[] = [
  paren('(', 'open parenthesis'),
  paren(')', 'close parenthesis'),
  op('+', '+', 'plus'),
  op('-', '−', 'minus'),
  op('*', '×', 'multiply'),
  op('/', '÷', 'divide'),
];

const unit = (i: number): KeyDef => {
  const u = KEYPAD_UNITS[i];
  return {
    label: u?.unit ?? '',
    name: u?.name,
    key: { kind: 'unit', unit: u?.unit ?? '' },
    tone: 'unit',
  };
};

const GRID: readonly KeyDef[] = [
  num('7'),
  num('8'),
  num('9'),
  unit(0),
  { label: '⌫', name: 'Backspace', key: { kind: 'backspace' }, tone: 'fn' },
  num('4'),
  num('5'),
  num('6'),
  unit(1),
  { label: '←', name: 'Move cursor left', key: { kind: 'move', dir: -1 }, tone: 'fn' },
  num('1'),
  num('2'),
  num('3'),
  unit(2),
  { label: '→', name: 'Move cursor right', key: { kind: 'move', dir: 1 }, tone: 'fn' },
  num('0'),
  { label: '.', name: 'decimal point', key: { kind: 'insert', text: '.' } },
  { label: 'AC', name: 'AC (clear)', key: { kind: 'clear' }, tone: 'fn' },
];
const ENTER: KeyDef = { label: '↵', name: 'Enter', key: { kind: 'enter' }, tone: 'enter' };

const tones: Record<Tone, string> = {
  num: 'bg-surface-2 text-fg active:bg-surface-3 text-lg',
  op: 'bg-surface-3 text-fg active:bg-border text-lg',
  unit: 'bg-accent-soft text-accent-text active:brightness-95 text-sm',
  fn: 'bg-surface-3 text-fg-muted active:bg-border text-base',
  enter: 'bg-accent text-accent-fg active:brightness-95 text-lg',
  param: 'bg-accent-soft text-accent-text active:brightness-95 text-ui',
};

export interface KeypadProps {
  /** The field's box. The keypad is placed below / above it and never covers it. */
  anchor: HTMLElement;
  onKey(key: KeypadKey): void;
  /** Parameter names offered as one-tap keys. */
  params?: readonly string[];
}

function KeyButton({
  def,
  onKey,
  className,
  size = 'h-12',
}: {
  def: KeyDef;
  onKey(k: KeypadKey): void;
  className?: string;
  size?: string;
}) {
  const k = def.key;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={def.name ?? def.label}
      // Presses must not move focus: the caret and selection of the field survive.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onKey(k)}
      className={cn(
        'tnum flex touch-manipulation items-center justify-center rounded-control font-medium transition-colors duration-fast select-none',
        size,
        tones[def.tone ?? 'num'],
        className,
      )}
    >
      {k.kind === 'backspace' ? (
        <Delete className="size-5" aria-hidden />
      ) : k.kind === 'move' ? (
        k.dir < 0 ? (
          <ArrowLeft className="size-5" aria-hidden />
        ) : (
          <ArrowRight className="size-5" aria-hidden />
        )
      ) : (
        def.label
      )}
    </button>
  );
}

/**
 * Inline numeric keypad (PLAN 9.1 tablet). Units (mm, in, deg), an expression row (( ) + − × ÷)
 * and one-tap parameter names. Presses never take focus from the field they edit. It is placed
 * below the field, above it when there is no room, and shrinks to a compact layout rather than
 * covering the field. Lazy-loaded.
 */
export default function Keypad({ anchor, onKey, params = [] }: KeypadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    placement: KeypadPlacement;
    covers: boolean;
  } | null>(null);
  const spring = useSpring('fast');
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const hasParams = params.length > 0 && !compact;

  // Place against the field; keep following it (the sheet it lives in may be moving).
  useLayoutEffect(() => {
    let raf = 0;
    let last = '';
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const insets = readSafeInsets();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const key = `${a.left}|${a.top}|${a.width}|${a.height}|${el.offsetWidth}|${el.offsetHeight}|${vw}|${vh}|${compact}`;
      if (key === last) return;
      last = key;
      const r = placeKeypad(
        { left: a.left, top: a.top, width: a.width, height: a.height },
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: vw, h: vh },
        insets,
      );
      if (r.placement === 'dock' && !compact) {
        setCompact(true);
        return;
      }
      setPos({ left: r.left, top: r.top, placement: r.placement, covers: r.coversField });
    };
    const loop = () => {
      place();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [anchor, compact]);

  // An outside press closes the keypad (the field keeps its text).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onKeyRef.current({ kind: 'close' });
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor]);

  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend semantics we do not want
    <div
      ref={ref}
      role="group"
      aria-label="Numeric keypad"
      data-testid="keypad"
      data-placement={pos?.placement}
      data-covers={pos?.covers || undefined}
      data-compact={compact || undefined}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-[var(--z-popover)] w-[min(344px,calc(100vw-16px))]"
    >
      <m.div
        initial={{ opacity: 0, y: pos?.placement === 'above' ? 8 : -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="w-panel p-1.5"
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        {compact ? null : (
          <div className="mb-1 flex items-center justify-between pr-0.5 pl-2">
            <span className="text-2xs font-semibold tracking-wider text-fg-muted uppercase">
              Value
            </span>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Use the system keyboard"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onKey({ kind: 'osKeyboard' })}
              className="flex h-11 items-center gap-1.5 rounded-control px-3 text-xs font-medium text-fg-muted active:bg-surface-2"
            >
              <Keyboard className="size-4" aria-hidden /> Keyboard
            </button>
          </div>
        )}
        <div className={cn('grid gap-1', compact ? 'grid-cols-7' : 'grid-cols-6')}>
          {EXPR_ROW.map((d) => (
            <KeyButton key={d.name} def={d} onKey={onKey} size="h-11" />
          ))}
          {compact ? (
            // The header is dropped to save height; the keyboard toggle stays reachable.
            <button
              type="button"
              tabIndex={-1}
              aria-label="Use the system keyboard"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onKey({ kind: 'osKeyboard' })}
              className="flex h-11 items-center justify-center rounded-control bg-surface-2 text-fg-muted active:bg-surface-3"
            >
              <Keyboard className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
        {hasParams ? (
          <fieldset
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs a tab stop (axe)
            tabIndex={0}
            className="m-0 mt-1 flex min-w-0 gap-1 overflow-x-auto border-0 p-0 pb-0.5"
          >
            <legend className="sr-only">Parameters</legend>
            {params.map((p) => (
              <KeyButton
                key={p}
                def={{
                  label: p,
                  name: `parameter ${p}`,
                  key: { kind: 'param', name: p },
                  tone: 'param',
                }}
                onKey={onKey}
                size="h-11 min-w-14 shrink-0 px-3"
              />
            ))}
          </fieldset>
        ) : null}
        <div className="mt-1 grid grid-cols-5 gap-1">
          {GRID.map((d) => (
            <KeyButton
              key={d.name ?? d.label}
              def={d}
              onKey={onKey}
              size={compact ? 'h-11' : 'h-12'}
            />
          ))}
          <KeyButton
            def={ENTER}
            onKey={onKey}
            size={compact ? 'h-11' : 'h-12'}
            className="col-span-2"
          />
        </div>
      </m.div>
    </div>,
    document.body,
  );
}
