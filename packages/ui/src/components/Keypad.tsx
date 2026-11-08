import { Delete, Keyboard } from 'lucide-react';
import { FloatingLayer } from './floating';
import { cn } from './primitives';

export type KeypadKey =
  | { kind: 'insert'; text: string }
  | { kind: 'backspace' }
  | { kind: 'enter' }
  | { kind: 'close' }
  | { kind: 'osKeyboard' };

interface KeyDef {
  label: string;
  /** Accessible name when the glyph alone is ambiguous. */
  name?: string;
  key: KeypadKey;
  tone?: 'num' | 'op' | 'unit' | 'enter' | 'fn';
}

const ins = (text: string, label = text, name?: string, tone: KeyDef['tone'] = 'num'): KeyDef => ({
  label,
  name,
  key: { kind: 'insert', text },
  tone,
});

const KEYS: readonly KeyDef[] = [
  ins('7'),
  ins('8'),
  ins('9'),
  ins('/', '÷', 'divide', 'op'),
  { label: '⌫', name: 'Backspace', key: { kind: 'backspace' }, tone: 'fn' },
  ins('4'),
  ins('5'),
  ins('6'),
  ins('*', '×', 'multiply', 'op'),
  ins('mm', 'mm', 'mm (millimetres)', 'unit'),
  ins('1'),
  ins('2'),
  ins('3'),
  ins(' - ', '−', 'minus', 'op'),
  ins('in', 'in', 'in (inches)', 'unit'),
  ins('0'),
  ins('.', '.', 'decimal point'),
  ins(' + ', '+', 'plus', 'op'),
  ins('deg', 'deg', 'deg (degrees)', 'unit'),
  { label: '↵', name: 'Enter', key: { kind: 'enter' }, tone: 'enter' },
];

const tones: Record<NonNullable<KeyDef['tone']>, string> = {
  num: 'bg-surface-2 text-fg active:bg-surface-3 text-lg',
  op: 'bg-surface-3 text-fg active:bg-border text-lg',
  unit: 'bg-accent-soft text-accent-text active:brightness-95 text-sm',
  fn: 'bg-surface-3 text-fg-muted active:bg-border text-lg',
  enter: 'bg-accent text-accent-fg active:brightness-95 text-lg',
};

export interface KeypadProps {
  anchor: HTMLElement;
  onKey(key: KeypadKey): void;
}

/**
 * Inline numeric keypad (PLAN 9.1 tablet). Presses never take focus from the field they edit
 * (`pointerdown` default is prevented), so the caret and selection survive. Lazy-loaded.
 */
export default function Keypad({ anchor, onKey }: KeypadProps) {
  return (
    <FloatingLayer
      anchor={anchor}
      placement="bottom-start"
      role="group"
      label="Numeric keypad"
      onDismiss={() => onKey({ kind: 'close' })}
      focusOnOpen={false}
      restoreFocus={false}
      testId="keypad"
      className="w-[min(320px,calc(100vw-16px))] p-2"
    >
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-2xs font-medium tracking-wide text-fg-muted uppercase">Value</span>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Use the system keyboard"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onKey({ kind: 'osKeyboard' })}
          className="flex h-8 items-center gap-1.5 rounded-control px-2 text-2xs font-medium text-fg-muted active:bg-surface-2"
        >
          <Keyboard className="size-4" aria-hidden /> abc
        </button>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {KEYS.map((k) => (
          <button
            key={k.name ?? k.label}
            type="button"
            tabIndex={-1}
            aria-label={k.name ?? k.label}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onKey(k.key)}
            className={cn(
              'flex h-12 touch-manipulation items-center justify-center rounded-control font-medium tnum transition-colors duration-150 select-none',
              tones[k.tone ?? 'num'],
            )}
          >
            {k.key.kind === 'backspace' ? <Delete className="size-5" aria-hidden /> : k.label}
          </button>
        ))}
      </div>
    </FloatingLayer>
  );
}
