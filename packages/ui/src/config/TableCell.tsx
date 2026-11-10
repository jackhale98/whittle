import type { ConfiguredValue, EvalResult, Expr, Material } from '@wren-cad/contracts';
import { RotateCcw, SquareArrowOutUpRight } from 'lucide-react';
import { type FocusEvent, memo, type ReactNode, useRef } from 'react';
import { ExpressionInput } from '../components/ExpressionInput';
import { cn } from '../components/primitives';
import type { FormatValue } from '../format';
import { type MaterialLibraryItem, toMaterial } from '../inspector/materials';
import { type CellValue, type ConfigColumn, cellText, sameCellValue } from './model';

export interface TableCellProps {
  column: ConfigColumn;
  /** The value the cell shows: the override, else Default's. */
  value: CellValue;
  overridden: boolean;
  /** A configuration row whose value is inherited from Default. */
  inherited: boolean;
  /** Shown when there is no value (e.g. the part number a configuration will get). */
  placeholder?: string | undefined;
  rowName: string;
  r: number;
  c: number;
  /** The roving tab stop. */
  focused: boolean;
  editing: boolean;
  touch: boolean;
  canJump: boolean;
  materials?: readonly MaterialLibraryItem[] | undefined;
  evaluate?: ((expr: Expr) => EvalResult) | undefined;
  formatValue?: FormatValue | undefined;
  onFocusCell(r: number, c: number): void;
  onBeginEdit(r: number, c: number): void;
  onEndEdit(r: number, c: number, refocus: boolean): void;
  onCommit(r: number, c: number, value: ConfiguredValue | Material | null): void;
  onReset(r: number, c: number): void;
  onJump(r: number, c: number): void;
}

const none = '__none__';

/**
 * One cell of the configuration table. Read-only by default (one cheap button, so 50 × 30 cells
 * stay responsive); Enter, F2, a double-click or a tap opens the editor: `ExpressionInput` for
 * expressions with units, an input for text, a native select for options and materials; a boolean
 * toggles in place. Memoised: it only re-renders when its own state changes.
 */
export const TableCell = memo(function TableCell(p: TableCellProps) {
  const { column, value, overridden, inherited, rowName, r, c, touch } = p;
  const label = `${rowName}, ${column.label}`;
  const text = cellText(value, column);
  const h = touch ? 'min-h-11' : 'min-h-8';
  const wrap = useRef<HTMLDivElement>(null);

  // Leaving the editor ends the edit, unless an expression is invalid: it stays on screen with
  // its error rather than being discarded.
  function onBlurEditor(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget && wrap.current?.contains(e.relatedTarget as Node)) return;
    const el = e.target as HTMLInputElement;
    if (column.kind === 'expr' && el.tagName === 'INPUT' && p.evaluate) {
      const v = el.value;
      if (v !== String(value ?? '') && !(p.evaluate(v).ok && v.trim())) return;
    }
    p.onEndEdit(r, c, false);
  }

  let body: ReactNode;
  if (p.editing && column.kind === 'expr') {
    body = (
      <ExpressionInput
        autoFocus
        label={label}
        value={typeof value === 'string' ? value : value == null ? '' : String(value)}
        keypad="never"
        size={touch ? 'touch' : 'md'}
        {...(p.evaluate ? { evaluate: p.evaluate } : {})}
        {...(p.formatValue ? { formatValue: p.formatValue } : {})}
        {...(column.unit ? { unitHint: column.unit } : {})}
        onCommit={(expr) => {
          p.onCommit(r, c, expr);
          p.onEndEdit(r, c, true);
        }}
      />
    );
  } else if (p.editing && column.kind === 'text') {
    body = (
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on the user's request
        autoFocus
        aria-label={label}
        defaultValue={typeof value === 'string' ? value : ''}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.dataset.done = '1';
            p.onCommit(r, c, e.currentTarget.value.trim());
            p.onEndEdit(r, c, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.dataset.done = '1';
            p.onEndEdit(r, c, true);
          }
        }}
        onBlur={(e) => {
          if (e.currentTarget.dataset.done) return;
          if (e.currentTarget.value.trim() !== (typeof value === 'string' ? value : ''))
            p.onCommit(r, c, e.currentTarget.value.trim());
        }}
        className={cn(
          'w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none',
          touch ? 'h-11' : 'h-8',
        )}
      />
    );
  } else if (p.editing && (column.kind === 'option' || column.kind === 'material')) {
    const isMat = column.kind === 'material';
    const current = isMat
      ? value === null || value === undefined
        ? none
        : ((value as Material).libraryId ?? (value as Material).name)
      : String(value ?? '');
    const choices: { value: string; label: string }[] = isMat
      ? [
          { value: none, label: 'None' },
          ...(p.materials ?? []).map((m) => ({ value: m.libraryId, label: m.name })),
        ]
      : (column.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value }));
    if (!choices.some((o) => o.value === current))
      choices.push({ value: current, label: text || current });
    body = (
      <select
        // biome-ignore lint/a11y/noAutofocus: the editor opens on the user's request
        autoFocus
        aria-label={label}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          if (isMat) {
            const lib = p.materials?.find((m) => m.libraryId === v);
            p.onCommit(r, c, v === none ? null : lib ? toMaterial(lib) : (value as Material));
          } else p.onCommit(r, c, v);
          p.onEndEdit(r, c, true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            p.onEndEdit(r, c, true);
          }
        }}
        className={cn(
          'w-full min-w-0 rounded-control bg-surface-2 px-2 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none',
          touch ? 'h-11' : 'h-8',
        )}
      >
        {choices.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    const isBool = column.kind === 'bool';
    body = (
      <button
        type="button"
        data-cell={`${r}:${c}`}
        tabIndex={p.focused ? 0 : -1}
        aria-label={`${label}: ${text || p.placeholder || 'empty'}${overridden ? ', overridden' : ''}`}
        {...(isBool ? { role: 'switch', 'aria-checked': value === true } : {})}
        onFocus={() => p.onFocusCell(r, c)}
        onClick={() => (isBool ? p.onCommit(r, c, value !== true) : touch && p.onBeginEdit(r, c))}
        onDoubleClick={() => {
          if (isBool) return;
          if (p.canJump) p.onJump(r, c);
          else p.onBeginEdit(r, c);
        }}
        className={cn(
          'tnum flex w-full min-w-0 items-center rounded-[6px] px-2 text-left text-ui outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          h,
          inherited && 'text-fg-muted',
          !text && 'text-fg-subtle italic',
        )}
      >
        <span className="min-w-0 truncate" title={text}>
          {text || p.placeholder || '—'}
        </span>
      </button>
    );
  }

  const editing = p.editing;
  return (
    <td
      data-overridden={overridden ? '' : undefined}
      data-testid={`cell-${r}-${c}`}
      className={cn(
        'border-b border-l border-border p-0 align-middle',
        overridden && 'bg-warning-soft',
      )}
    >
      <div
        ref={wrap}
        className="flex min-w-0 items-center"
        {...(editing ? { onBlur: onBlurEditor } : {})}
      >
        <div className="min-w-0 flex-1">{body}</div>
        {!editing && p.canJump ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Go to ${column.label} in the feature`}
            title="Go to the field (double-click, Alt+Enter)"
            onClick={() => p.onJump(r, c)}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-[6px] text-fg-subtle hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
              touch ? 'size-11' : 'size-6',
            )}
          >
            <SquareArrowOutUpRight className="size-3.5" aria-hidden />
          </button>
        ) : null}
        {!editing && overridden ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Reset ${label} to default`}
            title="Reset to default (Delete)"
            onClick={() => p.onReset(r, c)}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-[6px] text-warning-text hover:bg-warning/25 focus-visible:outline-2 focus-visible:outline-accent',
              touch ? 'size-11' : 'size-6',
            )}
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </td>
  );
}, sameProps);

function sameProps(a: TableCellProps, b: TableCellProps): boolean {
  return (
    a.column === b.column &&
    sameCellValue(a.value, b.value) &&
    a.overridden === b.overridden &&
    a.inherited === b.inherited &&
    a.placeholder === b.placeholder &&
    a.rowName === b.rowName &&
    a.r === b.r &&
    a.c === b.c &&
    a.focused === b.focused &&
    a.editing === b.editing &&
    a.touch === b.touch &&
    a.canJump === b.canJump &&
    (!a.editing || (a.evaluate === b.evaluate && a.materials === b.materials)) &&
    (a.column.kind !== 'material' || a.materials === b.materials) &&
    a.onFocusCell === b.onFocusCell &&
    a.onBeginEdit === b.onBeginEdit &&
    a.onEndEdit === b.onEndEdit &&
    a.onCommit === b.onCommit &&
    a.onReset === b.onReset &&
    a.onJump === b.onJump
  );
}
