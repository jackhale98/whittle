import type {
  ConfigTarget,
  ConfiguredValue,
  EvalResult,
  Expr,
  Id,
  Material,
} from '@wren-cad/contracts';
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn, IconButton } from '../components/primitives';
import type { FormatValue } from '../format';
import type { MaterialLibraryItem } from '../inspector/materials';
import { ConfigStatusLabel } from './ConfigStatusLabel';
import {
  type CellValue,
  CONFIG_GROUPS,
  type ConfigColumn,
  type ConfigGroupId,
  type ConfigStatus,
  configTargetKey,
  DEFAULT_CONFIGURATION_NAME,
  groupOf,
  sameCellValue,
} from './model';
import { TableCell } from './TableCell';
import { coerceCell, type PastePlan, parseTsv, planPaste } from './tsv';

/* The inline configuration table (M3.7, research P0 5). Lazy-load this module: it is the only
   place the table's code lives. `import('@wren-cad/ui/config-table')` (default export too). */

/** One configuration row. Default is passed separately as `defaultRow`. */
export interface ConfigTableRow {
  id: Id;
  name: string;
  status: ConfigStatus;
  statusMessage?: string;
  /** Read-only mass, already formatted ("1.24 kg"). */
  mass?: string;
  /** Only the cells this configuration overrides, by `configTargetKey`. A key present with `null` is an override. */
  overrides: Readonly<Record<string, CellValue>>;
  /** Text to show in an empty cell (e.g. the part number the configuration will get). */
  placeholders?: Readonly<Record<string, string>>;
}

export interface ConfigTableDefault {
  /** Default's value of every column, by `configTargetKey`. */
  values: Readonly<Record<string, CellValue>>;
  status?: ConfigStatus;
  statusMessage?: string;
  mass?: string;
  placeholders?: Readonly<Record<string, string>>;
}

/**
 * One cell edit. `configurationId: null` edits Default (the app maps it to the ordinary commands:
 * `updateParam`, `updateFeature`, `setSuppressed`, `setMaterial`, `setPartProperties`); otherwise it
 * maps to `setConfigurationOverrides`. `value` absent = "Reset to default" (clear the override).
 */
export interface ConfigTableEdit {
  configurationId: Id | null;
  target: ConfigTarget;
  value?: ConfiguredValue | Material | null;
}

export interface ConfigurationTableProps {
  /** The configurable fields, in display order (they are grouped by target kind). The app decides; the table computes nothing. */
  columns: readonly ConfigColumn[];
  rows: readonly ConfigTableRow[];
  defaultRow: ConfigTableDefault;
  /** The active configuration (`null` = Default): marked "Active". */
  activeId: Id | null;
  /** Cell edits and resets. One cell per call, except nothing batches here (see `onPaste`). */
  onEdit(edits: ConfigTableEdit[]): void;
  /**
   * A TSV paste, as one batch: names of configurations to create (in order) and every edit, rows
   * of new configurations addressed by name. Apply in one undo step. Cells that were not applied
   * are in `plan.ignored` (the table also lists them); the callback is skipped when nothing applies.
   */
  onPaste(plan: PastePlan): void;
  /** Double-click (or the arrow button, Alt+Enter) on a feature-field cell. */
  onJumpToField?(featureId: Id, path: string): void;
  /** "Make active" on a row. */
  onActivate?(id: Id | null): void;
  onRename?(id: Id, name: string): void;
  /** Remove a configuration (undoable in the app; no dialog here). */
  onRemove?(id: Id): void;
  /** Validates expressions (shared with `ExpressionInput`). */
  evaluate?(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  /** The library for `material` columns. */
  materials?: readonly MaterialLibraryItem[];
  /** Configurations as columns instead of rows. Controlled when `onTransposedChange` is given. */
  transposed?: boolean;
  onTransposedChange?(transposed: boolean): void;
  /** Collapsed column groups. Controlled when `onCollapsedGroupsChange` is given. */
  collapsedGroups?: readonly ConfigGroupId[];
  onCollapsedGroupsChange?(groups: readonly ConfigGroupId[]): void;
  /** Header of the read-only mass column. Default "Mass". */
  massLabel?: string;
  size?: 'md' | 'touch';
  /** CSS max-height of the scrolling grid. Default `70vh`. */
  maxHeight?: string;
  className?: string;
}

interface Line {
  id: Id | null;
  name: string;
  status?: ConfigStatus | undefined;
  statusMessage?: string | undefined;
  mass?: string | undefined;
  overrides: Readonly<Record<string, CellValue>>;
  placeholders?: Readonly<Record<string, string>> | undefined;
}

/** Rows beyond this number are windowed (non-transposed layout). */
const WINDOW_AFTER = 40;
const OVERSCAN = 6;

const th =
  'border-b border-l border-border bg-surface-2 px-2 text-left text-xs font-semibold text-fg-muted';

/**
 * Rows are configurations (Default first) and columns are values, or the reverse. Column groups
 * (Parameters, Suppression, Material, Properties) collapse. Cells edit inline with expressions;
 * cells that differ from Default are highlighted with a reset button; a status column and a
 * read-only mass column ride along. Pasting a TSV block creates or updates cells (unknown row names
 * create configurations). Grid keyboard: arrows move, Enter/F2 edit (toggle for booleans), Delete
 * resets, Alt+Enter jumps to the feature field. Controlled: the app owns every value.
 */
export default function ConfigurationTable(props: ConfigurationTableProps) {
  const { columns, rows, defaultRow, activeId, size = 'md', massLabel = 'Mass' } = props;
  const touch = size === 'touch';
  const L = useRef(props);
  L.current = props;

  const [tLocal, setTLocal] = useState(false);
  const transposed = props.onTransposedChange ? !!props.transposed : (props.transposed ?? tLocal);
  const setTransposed = (v: boolean) => {
    setTLocal(v);
    props.onTransposedChange?.(v);
  };
  const [gLocal, setGLocal] = useState<readonly ConfigGroupId[]>([]);
  const collapsed = props.onCollapsedGroupsChange ? (props.collapsedGroups ?? []) : gLocal;
  const toggleGroup = (g: ConfigGroupId) => {
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g];
    setGLocal(next);
    props.onCollapsedGroupsChange?.(next);
  };

  const lines = useMemo<Line[]>(
    () => [
      {
        id: null,
        name: DEFAULT_CONFIGURATION_NAME,
        status: defaultRow.status,
        statusMessage: defaultRow.statusMessage,
        mass: defaultRow.mass,
        overrides: {},
        placeholders: defaultRow.placeholders,
      },
      ...rows,
    ],
    [rows, defaultRow],
  );

  /** Columns in display order, grouped. */
  const groups = useMemo(
    () =>
      CONFIG_GROUPS.map((g) => ({
        ...g,
        cols: columns.filter((c) => groupOf(c.target) === g.id),
      })).filter((g) => g.cols.length > 0),
    [columns],
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.cols), [groups]);
  const visible = useMemo(
    () => groups.filter((g) => !collapsed.includes(g.id)).flatMap((g) => g.cols),
    [groups, collapsed],
  );
  const keys = useMemo(() => visible.map((c) => configTargetKey(c.target)), [visible]);

  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [note, setNote] = useState<{ text: string; ignored: string[] } | null>(null);
  const needFocus = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const rowH = touch ? 48 : 36;
  const windowed = !transposed && lines.length > WINDOW_AFTER;

  const R = lines.length - 1;
  const C = Math.max(0, visible.length - 1);
  const fr = Math.min(focus.r, R);
  const fc = Math.min(focus.c, C);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !windowed) return;
    const read = () => setScroll({ top: el.scrollTop, h: el.clientHeight || 600 });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      ro.disconnect();
    };
  }, [windowed]);

  const first = windowed ? Math.max(0, Math.floor(scroll.top / rowH) - OVERSCAN) : 0;
  const last = windowed
    ? Math.min(lines.length, Math.ceil((scroll.top + scroll.h) / rowH) + OVERSCAN)
    : lines.length;

  // Move DOM focus to the focused cell after a keyboard move or after an editor closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every focus / scroll change
  useEffect(() => {
    if (!needFocus.current || editing) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-cell="${fr}:${fc}"]`);
    if (el) {
      needFocus.current = false;
      el.focus({ preventScroll: false });
    } else if (windowed && scroller.current) {
      scroller.current.scrollTop = Math.max(0, fr * rowH - rowH * 2);
    }
  }, [fr, fc, scroll.top, editing, windowed, rowH]);

  /* ------------------------------------------------------------ handlers (stable identities) */
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const visRef = useRef(visible);
  visRef.current = visible;

  const lookup = useCallback((r: number, c: number) => {
    const line = linesRef.current[r];
    const col = visRef.current[c];
    return line && col ? { line, col, key: configTargetKey(col.target) } : undefined;
  }, []);
  const effective = useCallback((r: number, key: string): { v: CellValue; overridden: boolean } => {
    const line = linesRef.current[r];
    if (r > 0 && line && key in line.overrides) return { v: line.overrides[key], overridden: true };
    return { v: L.current.defaultRow.values[key], overridden: false };
  }, []);

  const onFocusCell = useCallback((r: number, c: number) => setFocus({ r, c }), []);
  const onBeginEdit = useCallback(
    (r: number, c: number) => {
      const t = lookup(r, c);
      if (t && t.col.kind !== 'bool') setEditing({ r, c });
    },
    [lookup],
  );
  const onEndEdit = useCallback((r: number, c: number, refocus: boolean) => {
    setEditing((e) => (e && e.r === r && e.c === c ? null : e));
    if (refocus) needFocus.current = true;
  }, []);
  const onReset = useCallback(
    (r: number, c: number) => {
      const t = lookup(r, c);
      if (!t || r === 0 || !effective(r, t.key).overridden) return;
      L.current.onEdit([{ configurationId: t.line.id, target: t.col.target }]);
    },
    [lookup, effective],
  );
  const onCommit = useCallback(
    (r: number, c: number, v: ConfiguredValue | Material | null) => {
      const t = lookup(r, c);
      if (!t) return;
      const { v: cur, overridden } = effective(r, t.key);
      const dflt = L.current.defaultRow.values[t.key];
      if (r > 0 && t.col.kind === 'text' && v === '') return onReset(r, c);
      if (r > 0 && !overridden && sameCellValue(v, dflt)) return;
      if ((r === 0 || overridden) && sameCellValue(v, cur)) return;
      L.current.onEdit([{ configurationId: t.line.id, target: t.col.target, value: v }]);
    },
    [lookup, effective, onReset],
  );
  const onJump = useCallback(
    (r: number, c: number) => {
      const t = lookup(r, c);
      if (t?.col.target.kind === 'field')
        L.current.onJumpToField?.(t.col.target.featureId, t.col.target.path);
    },
    [lookup],
  );

  function moveTo(r: number, c: number) {
    needFocus.current = true;
    setFocus({ r: Math.max(0, Math.min(R, r)), c: Math.max(0, Math.min(C, c)) });
  }

  function onGridKey(e: KeyboardEvent<HTMLElement>) {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!cell || e.target !== cell) return;
    const [r = 0, c = 0] = (cell.dataset.cell ?? '0:0').split(':').map(Number);
    const along = transposed ? { r: 1, c: 0 } : { r: 0, c: 1 }; // "right"
    const down = transposed ? { r: 0, c: 1 } : { r: 1, c: 0 };
    const key = e.key;
    let handled = true;
    if (key === 'ArrowRight') moveTo(r + along.r, c + along.c);
    else if (key === 'ArrowLeft') moveTo(r - along.r, c - along.c);
    else if (key === 'ArrowDown') moveTo(r + down.r, c + down.c);
    else if (key === 'ArrowUp') moveTo(r - down.r, c - down.c);
    else if (key === 'Home') e.ctrlKey ? moveTo(0, 0) : moveTo(along.r ? 0 : r, along.c ? 0 : c);
    else if (key === 'End') e.ctrlKey ? moveTo(R, C) : moveTo(along.r ? R : r, along.c ? C : c);
    else if (key === 'Enter' && e.altKey) onJump(r, c);
    else if (key === 'Enter' || key === 'F2') {
      const t = lookup(r, c);
      if (t?.col.kind === 'bool') {
        const { v } = effective(r, t.key);
        onCommit(r, c, v !== true);
      } else onBeginEdit(r, c);
    } else if (key === 'Delete' || key === 'Backspace') onReset(r, c);
    else handled = false;
    if (handled) e.preventDefault();
  }

  function onPaste(e: ClipboardEvent<HTMLElement>) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    e.preventDefault();
    const p = L.current;
    const validateExpr = (expr: string) => {
      const r = p.evaluate?.(expr);
      return r && !r.ok ? r.error.message : undefined;
    };
    const grid = parseTsv(text);
    // One plain value: it goes to the focused cell.
    if (grid.length === 1 && grid[0]?.length === 1) {
      const t = lookup(fr, fc);
      if (!t) return;
      const res = coerceCell(grid[0][0] ?? '', t.col, p.materials, validateExpr);
      if ('error' in res)
        setNote({ text: 'Nothing pasted.', ignored: [`${t.col.label}: ${res.error}`] });
      else {
        onCommit(fr, fc, res.value);
        setNote(null);
      }
      return;
    }
    const focused = visible[fc];
    const plan = planPaste({
      grid,
      columns: ordered,
      rows: p.rows,
      defaults: p.defaultRow.values,
      transposed,
      startColumn: focused ? Math.max(0, ordered.indexOf(focused)) : 0,
      ...(p.materials ? { materials: p.materials } : {}),
      validateExpr,
    });
    const cells = plan.edits.length;
    const made = plan.create.length;
    if (cells === 0 && made === 0) {
      setNote({
        text: 'Nothing pasted.',
        ignored: plan.ignored.map((i) => i.reason + (i.text ? `: ${i.text}` : '')),
      });
      return;
    }
    p.onPaste(plan);
    setNote({
      text: `Pasted ${cells} ${cells === 1 ? 'cell' : 'cells'}${made ? `, created ${made} ${made === 1 ? 'configuration' : 'configurations'}` : ''}${plan.ignored.length ? `; ${plan.ignored.length} not applied` : ''}.`,
      ignored: plan.ignored.map((i) => i.reason + (i.text ? `: ${i.text}` : '')),
    });
  }

  /* ------------------------------------------------------------ rendering */
  const renderCell = (r: number, c: number) => {
    const line = lines[r];
    const col = visible[c];
    const key = keys[c];
    if (!line || !col || !key) return null;
    const overridden = r > 0 && key in line.overrides;
    const v = overridden ? line.overrides[key] : defaultRow.values[key];
    const isEditing = editing?.r === r && editing.c === c;
    return (
      <TableCell
        key={key}
        column={col}
        value={v}
        overridden={overridden}
        inherited={r > 0 && !overridden}
        placeholder={line.placeholders?.[key]}
        rowName={line.name}
        r={r}
        c={c}
        focused={fr === r && fc === c}
        editing={isEditing}
        touch={touch}
        canJump={col.target.kind === 'field' && !!props.onJumpToField}
        materials={props.materials}
        evaluate={isEditing ? props.evaluate : undefined}
        formatValue={isEditing ? props.formatValue : undefined}
        onFocusCell={onFocusCell}
        onBeginEdit={onBeginEdit}
        onEndEdit={onEndEdit}
        onCommit={onCommit}
        onReset={onReset}
        onJump={onJump}
      />
    );
  };

  const actionBtn = cn(
    'flex shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
    touch ? 'size-11' : 'size-6',
  );

  /** A configuration's name with Active badge and actions (row header or column header). */
  const nameCell = (r: number): ReactNode => {
    const line = lines[r];
    if (!line) return null;
    const on = line.id === activeId;
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {renaming === line.id && line.id !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the inline rename opens on the user's request
            autoFocus
            aria-label={`Rename ${line.name}`}
            defaultValue={line.name}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                e.currentTarget.dataset.cancel = '1';
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (!e.currentTarget.dataset.cancel && v && v !== line.name && line.id)
                props.onRename?.(line.id, v);
              setRenaming(null);
            }}
            className={cn(
              'min-w-0 flex-1 rounded-[6px] bg-surface px-1.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none',
              touch ? 'h-11' : 'h-6',
            )}
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename; keyboard users use the Rename button
          <span
            title={line.name}
            onDoubleClick={() => line.id && props.onRename && setRenaming(line.id)}
            className="min-w-0 truncate text-ui font-medium text-fg"
          >
            {line.name}
          </span>
        )}
        {on ? (
          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-2xs leading-4 font-medium text-accent-text">
            Active
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {!on && props.onActivate ? (
            <button
              type="button"
              className={actionBtn}
              aria-label={`Make ${line.name} active`}
              title="Make active"
              onClick={() => props.onActivate?.(line.id)}
            >
              <Check className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {line.id !== null && props.onRemove ? (
            <button
              type="button"
              className={actionBtn}
              aria-label={`Remove ${line.name}`}
              title="Remove configuration"
              onClick={() => line.id && props.onRemove?.(line.id)}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  const groupToggle = (g: { id: ConfigGroupId; label: string; cols: readonly ConfigColumn[] }) => {
    const open = !collapsed.includes(g.id);
    return (
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${g.label}, ${g.cols.length} ${g.cols.length === 1 ? 'column' : 'columns'}`}
        data-testid={`group-${g.id}`}
        onClick={() => toggleGroup(g.id)}
        className={cn(
          'flex w-full items-center gap-1 text-left text-xs font-semibold text-fg-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          touch ? 'min-h-11' : 'min-h-7',
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="whitespace-nowrap">{g.label}</span>
        {open ? null : <span className="font-normal">({g.cols.length})</span>}
      </button>
    );
  };

  const statusCell = (line: Line) => (
    <td className="border-b border-l border-border px-2">
      {line.status ? (
        <ConfigStatusLabel status={line.status} message={line.statusMessage} />
      ) : (
        <span className="text-2xs text-fg-subtle">—</span>
      )}
      {line.statusMessage ? <span className="sr-only">{`: ${line.statusMessage}`}</span> : null}
    </td>
  );
  const massCell = (line: Line) => (
    <td className="tnum border-b border-l border-border px-2 text-ui text-fg-muted">
      {line.mass ?? '—'}
    </td>
  );

  let body: ReactNode;
  let head: ReactNode;
  if (!transposed) {
    head = (
      <thead className="sticky top-0 z-[1]">
        <tr>
          <th rowSpan={2} scope="col" className={cn(th, 'sticky left-0 z-[2] min-w-40')}>
            Configuration
          </th>
          <th rowSpan={2} scope="col" className={th}>
            Status
          </th>
          {groups.map((g) => {
            const open = !collapsed.includes(g.id);
            return (
              <th key={g.id} scope="colgroup" colSpan={open ? g.cols.length : 1} className={th}>
                {groupToggle(g)}
              </th>
            );
          })}
          <th rowSpan={2} scope="col" className={th}>
            {massLabel}
          </th>
        </tr>
        <tr>
          {groups.map((g) =>
            collapsed.includes(g.id) ? (
              <th key={g.id} scope="col" className={cn(th, 'font-normal')} aria-hidden />
            ) : (
              g.cols.map((c) => (
                <th key={configTargetKey(c.target)} scope="col" className={cn(th, 'min-w-32')}>
                  <span className="whitespace-nowrap">{c.label}</span>
                  {c.unit ? <span className="font-normal text-fg-subtle"> ({c.unit})</span> : null}
                </th>
              ))
            ),
          )}
        </tr>
      </thead>
    );
    const rowEls: ReactNode[] = [];
    for (let r = first; r < last; r += 1) {
      const line = lines[r];
      if (!line) continue;
      rowEls.push(
        <tr
          key={line.id ?? 'default'}
          aria-rowindex={r + 3}
          data-testid={`row-${line.id ?? 'default'}`}
          style={windowed ? { height: rowH } : undefined}
        >
          <th scope="row" className={cn(th, 'sticky left-0 z-[1] min-w-40 bg-surface font-normal')}>
            {nameCell(r)}
          </th>
          {statusCell(line)}
          {groups.map((g) =>
            collapsed.includes(g.id) ? (
              <td key={g.id} className="border-b border-l border-border bg-surface-2/50" />
            ) : (
              g.cols.map((col) => {
                const c = visible.indexOf(col);
                return renderCell(r, c);
              })
            ),
          )}
          {massCell(line)}
        </tr>,
      );
    }
    const span = 3 + visible.length + groups.filter((g) => collapsed.includes(g.id)).length;
    body = (
      <tbody>
        {windowed && first > 0 ? (
          <tr aria-hidden style={{ height: first * rowH }}>
            <td colSpan={span} />
          </tr>
        ) : null}
        {rowEls}
        {windowed && last < lines.length ? (
          <tr aria-hidden style={{ height: (lines.length - last) * rowH }}>
            <td colSpan={span} />
          </tr>
        ) : null}
      </tbody>
    );
  } else {
    head = (
      <thead className="sticky top-0 z-[1]">
        <tr>
          <th scope="col" className={cn(th, 'sticky left-0 z-[2] min-w-40')}>
            Value
          </th>
          {lines.map((line) => (
            <th key={line.id ?? 'default'} scope="col" className={cn(th, 'min-w-36 font-normal')}>
              {nameCell(lines.indexOf(line))}
            </th>
          ))}
        </tr>
      </thead>
    );
    const out: ReactNode[] = [
      <tr key="status">
        <th scope="row" className={cn(th, 'sticky left-0 z-[1] bg-surface')}>
          Status
        </th>
        {lines.map((line) => (
          <td key={line.id ?? 'default'} className="border-b border-l border-border px-2">
            {line.status ? (
              <ConfigStatusLabel status={line.status} message={line.statusMessage} />
            ) : (
              <span className="text-2xs text-fg-subtle">—</span>
            )}
          </td>
        ))}
      </tr>,
    ];
    for (const g of groups) {
      out.push(
        <tr key={`g-${g.id}`}>
          <th scope="rowgroup" colSpan={lines.length + 1} className={cn(th, 'border-l-0')}>
            {groupToggle(g)}
          </th>
        </tr>,
      );
      if (collapsed.includes(g.id)) continue;
      for (const col of g.cols) {
        const c = visible.indexOf(col);
        out.push(
          <tr key={configTargetKey(col.target)}>
            <th scope="row" className={cn(th, 'sticky left-0 z-[1] bg-surface font-normal')}>
              <span className="whitespace-nowrap text-ui text-fg">{col.label}</span>
              {col.unit ? <span className="text-fg-subtle"> ({col.unit})</span> : null}
            </th>
            {lines.map((_, r) => renderCell(r, c))}
          </tr>,
        );
      }
    }
    out.push(
      <tr key="mass">
        <th scope="row" className={cn(th, 'sticky left-0 z-[1] bg-surface')}>
          {massLabel}
        </th>
        {lines.map((line) => (
          <td
            key={line.id ?? 'default'}
            className="tnum border-b border-l border-border px-2 text-ui text-fg-muted"
          >
            {line.mass ?? '—'}
          </td>
        ))}
      </tr>,
    );
    body = <tbody>{out}</tbody>;
  }

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2', props.className)}
      data-testid="configuration-table"
    >
      <div className="flex flex-wrap items-center gap-2">
        <IconButton
          label={transposed ? 'Show configurations as rows' : 'Show configurations as columns'}
          icon={<ArrowLeftRight className="size-4" />}
          pressed={transposed}
          size={size}
          variant="secondary"
          data-testid="transpose"
          onClick={() => setTransposed(!transposed)}
        />
        <p className="min-w-0 flex-1 text-2xs text-fg-muted">
          Paste a block from a spreadsheet: configuration names in the first column, an optional
          header row of column names. Unknown names create configurations.
        </p>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: grid keyboard and paste handlers on the scroll region */}
      <div
        ref={scroller}
        role="presentation"
        onKeyDown={onGridKey}
        onPaste={onPaste}
        style={{ maxHeight: props.maxHeight ?? '70vh' }}
        className="min-w-0 overflow-auto rounded-panel bg-surface shadow-[inset_0_0_0_1px_var(--color-border)]"
      >
        <table
          aria-label="Configuration values"
          aria-rowcount={lines.length + 2}
          aria-colcount={visible.length + 3}
          className="w-max min-w-full border-separate border-spacing-0 text-ui"
        >
          {head}
          {body}
        </table>
      </div>
      <p
        aria-live="polite"
        role="status"
        data-testid="paste-note"
        className="text-2xs text-fg-muted"
      >
        {note ? note.text : ''}
      </p>
      {note && note.ignored.length > 0 ? (
        <ul className="list-disc pl-5 text-2xs text-warning-text">
          {note.ignored.slice(0, 5).map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a short static list of messages
            <li key={`i${i}`}>{t}</li>
          ))}
          {note.ignored.length > 5 ? <li>and {note.ignored.length - 5} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export { ConfigurationTable };
