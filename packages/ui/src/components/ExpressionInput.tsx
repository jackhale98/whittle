import type { EvalResult, Expr } from '@wren-cad/contracts';
import { Calculator } from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultFormatValue,
  type EvalOk,
  type FormatValue,
  isPlainLiteral,
  nudgeExpression,
  splitSpan,
} from '../format';
import { applyKeypadKey, type KeypadKey } from '../logic/keypad';
import { ParamNamesContext } from './paramNames';
import { cn } from './primitives';

const Keypad = lazy(() => import('./Keypad'));

/** True on devices whose primary pointer is a finger / pencil. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
  );
  useEffect(() => {
    const mq = globalThis.matchMedia?.('(pointer: coarse)');
    if (!mq) return;
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

export interface ExpressionInputProps {
  /** Committed expression. */
  value: Expr;
  /** Enter, blur with a valid changed value, or a keypad Enter. */
  onCommit(expr: Expr): void;
  /** Fires while typing/nudging a *valid* expression so the viewport can preview it. */
  onPreview?(expr: Expr): void;
  /** Fires when Esc reverts an edit (so a preview can be dropped). */
  onCancel?(): void;
  /** Evaluates an expression against the document scope. Without it no validation happens. */
  evaluate?(expr: Expr): EvalResult;
  /** Formats the evaluated value for the "= 12.5 mm" readout. */
  formatValue?: FormatValue;
  /** Unit suffix shown for plain numbers, and used by ↑/↓ on non-literal expressions. */
  unitHint?: string;
  /** ↑/↓ step in the current unit (Shift ×10, Alt ×0.1). Default 1. */
  step?: number;
  /** Inline numeric keypad: `auto` = on touch devices. */
  keypad?: 'auto' | 'always' | 'never';
  /** Parameter names offered as one-tap keys on the keypad's expression row. */
  paramNames?: readonly string[];
  /** Accessible name (required: the field has no visible label of its own). */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Allow committing an empty string (clears an optional value). */
  allowEmpty?: boolean;
  /** Show the evaluated "= value" readout for non-literal expressions (default true). */
  showValue?: boolean;
  size?: 'md' | 'touch';
  align?: 'left' | 'right';
  className?: string;
  testId?: string;
  /** 16 px text (stops iOS Safari zooming into the field on focus). Default off: 13 px. */
  largeText?: boolean;
}

type Evaluated = { text: string; result: EvalResult | undefined };

/**
 * The inline value field used everywhere (PLAN 1 "Obvious", 9.2). Accepts expressions with units,
 * validates live, underlines the offending span, and nudges with the arrow keys.
 *
 * Enter commits (and re-selects), Esc reverts, blur commits a valid edit. An invalid edit is kept
 * on screen with its error rather than silently discarded.
 */
export function ExpressionInput({
  value,
  onCommit,
  onPreview,
  onCancel,
  evaluate,
  formatValue,
  unitHint,
  step = 1,
  keypad = 'auto',
  paramNames,
  label,
  placeholder,
  disabled,
  autoFocus,
  allowEmpty,
  showValue = true,
  size = 'md',
  align = 'left',
  className,
  testId,
  largeText,
}: ExpressionInputProps) {
  const ctxNames = useContext(ParamNamesContext);
  const names = paramNames ?? ctxNames;
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [keypadOn, setKeypadOn] = useState(false);
  const [osKeyboard, setOsKeyboard] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** A preview was sent since the last commit or cancel. */
  const previewed = useRef(false);
  const mirror = useRef<HTMLSpanElement>(null);
  const errorId = useId();
  const coarse = useCoarsePointer();
  const wantsKeypad = !disabled && (keypad === 'always' || (keypad === 'auto' && coarse));

  const text = draft ?? value;
  const ev = useMemo<Evaluated>(() => {
    if (!evaluate) return { text, result: undefined };
    if (!text.trim()) {
      return {
        text,
        result: allowEmpty ? undefined : { ok: false, error: { message: 'Enter a value' } },
      };
    }
    return { text, result: evaluate(text) };
  }, [evaluate, text, allowEmpty]);
  const result = ev.result;
  const error = result && !result.ok ? result.error : undefined;
  const ok: EvalOk | undefined = result?.ok ? result : undefined;

  const fmt = formatValue ?? defaultFormatValue;
  const readout =
    showValue && ok && !isPlainLiteral(text) ? fmt(ok.value, ok.dimension) : undefined;

  const syncMirror = useCallback(() => {
    if (mirror.current && input.current) {
      mirror.current.style.transform = `translateX(${-input.current.scrollLeft}px)`;
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync whenever the text changes
  useEffect(syncMirror, [text, syncMirror]);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const closeKeypad = useCallback(() => setKeypadOn(false), []);

  function commit(raw: string): boolean {
    if (!raw.trim() && !allowEmpty) return false;
    if (evaluate && raw.trim()) {
      const r = evaluate(raw);
      if (!r.ok) return false;
    }
    setDraft(null);
    // A value that was already previewed is committed too: the host closes its undo group (and,
    // with configurations, ends the one-shot scope) when the edit ends, not when it first changed.
    if (raw !== value || previewed.current) onCommit(raw);
    previewed.current = false;
    return true;
  }

  function edit(next: string) {
    setDraft(next);
    if (!onPreview) return;
    if (!evaluate || (next.trim() && evaluate(next).ok)) {
      previewed.current = true;
      onPreview(next);
    }
  }

  function revert() {
    const was = draft !== null;
    previewed.current = false;
    setDraft(null);
    if (was) onCancel?.();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commit(text)) {
        if (keypadOn) {
          closeKeypad();
          input.current?.blur();
        } else input.current?.select();
      }
    } else if (e.key === 'Escape') {
      if (draft !== null) {
        e.preventDefault();
        e.stopPropagation();
        revert();
        input.current?.select();
      } else if (keypadOn) {
        e.preventDefault();
        e.stopPropagation();
        closeKeypad();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * mult;
      const next = nudgeExpression(text, delta, unitHint);
      if (next !== null) edit(next);
    }
  }

  function onKeypad(k: KeypadKey) {
    const el = input.current;
    if (k.kind === 'close') return closeKeypad();
    if (k.kind === 'osKeyboard') {
      setOsKeyboard(true);
      closeKeypad();
      el?.focus();
      return;
    }
    if (k.kind === 'enter') {
      if (commit(text)) {
        closeKeypad();
        el?.blur();
      }
      return;
    }
    const a = el?.selectionStart ?? text.length;
    const b = el?.selectionEnd ?? text.length;
    const r = applyKeypadKey(text, a, b, k);
    if (!r) return;
    if (r.text !== text) edit(r.text);
    requestAnimationFrame(() => el?.setSelectionRange(r.caret, r.caret));
  }

  const [pre, mid, post] = splitSpan(text, error);
  const invalid = !!error && (draft !== null || !focused);
  const tall = size === 'touch';

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div
        ref={setBox}
        data-invalid={invalid || undefined}
        data-testid={testId}
        className={cn(
          'group/expr flex min-w-0 items-center gap-1.5 rounded-control bg-surface-2 px-2.5 transition-shadow duration-fast',
          tall ? 'h-11' : 'h-8',
          disabled && 'bg-surface-3',
          invalid
            ? 'shadow-[inset_0_0_0_1.5px_var(--color-danger)]'
            : 'shadow-[inset_0_0_0_1px_var(--color-border)] focus-within:shadow-[inset_0_0_0_2px_var(--color-accent)] hover:shadow-[inset_0_0_0_1px_var(--color-border-strong)] focus-within:hover:shadow-[inset_0_0_0_2px_var(--color-accent)]',
        )}
      >
        <div className="relative min-w-0 flex-1 self-stretch">
          {/* Mirror: same metrics as the input, invisible text, wavy underline under the error span. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden"
          >
            <span
              ref={mirror}
              data-field-mirror
              className={cn(
                'tnum whitespace-pre text-transparent',
                largeText ? 'text-base' : 'text-ui',
              )}
            >
              {pre}
              {mid ? (
                <span className="underline decoration-danger decoration-wavy underline-offset-4">
                  {mid}
                </span>
              ) : null}
              {post}
            </span>
          </div>
          <input
            ref={input}
            type="text"
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            inputMode={keypadOn ? 'none' : osKeyboard ? 'text' : undefined}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            onChange={(e: ChangeEvent<HTMLInputElement>) => edit(e.target.value)}
            onScroll={syncMirror}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              setFocused(true);
              e.currentTarget.select();
              if (wantsKeypad && !osKeyboard) setKeypadOn(true);
            }}
            onBlur={() => {
              setFocused(false);
              setOsKeyboard(false);
              closeKeypad();
              if (draft !== null) {
                if (draft === value) setDraft(null);
                else commit(draft);
              }
            }}
            className={cn(
              largeText ? 'text-base' : 'text-ui',
              'tnum relative h-full w-full min-w-0 bg-transparent text-fg outline-none placeholder:text-fg-subtle disabled:text-fg-muted',
              align === 'right' && 'text-right',
            )}
          />
        </div>
        {wantsKeypad && osKeyboard && focused ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Use the numeric keypad"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setOsKeyboard(false);
              setKeypadOn(true);
              input.current?.focus();
            }}
            className="-mr-2 flex h-full min-w-11 shrink-0 items-center justify-center rounded-control text-fg-muted active:bg-surface-3"
          >
            <Calculator className="size-4" aria-hidden />
          </button>
        ) : null}
        {readout ? (
          <span
            data-testid="expr-readout"
            className="tnum shrink-0 text-ui text-fg-muted"
            title="Evaluated value"
          >
            = {readout}
          </span>
        ) : unitHint ? (
          <span className="shrink-0 text-ui text-fg-subtle select-none" aria-hidden>
            {unitHint}
          </span>
        ) : null}
      </div>
      {invalid && error ? (
        <p id={errorId} role="alert" className="text-2xs leading-4 text-danger-text">
          {error.message}
        </p>
      ) : null}
      {keypadOn && box ? (
        <Suspense fallback={null}>
          <Keypad anchor={box} onKey={onKeypad} params={names} />
        </Suspense>
      ) : null}
    </div>
  );
}
