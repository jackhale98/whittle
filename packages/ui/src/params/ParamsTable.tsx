import type { EvalResult, Expr, Id, Param } from '@wren-cad/contracts';
import { GripVertical, Plus, Trash2, Variable } from 'lucide-react';
import { m } from 'motion/react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { ExpressionInput } from '../components/ExpressionInput';
import { OverrideMarker, ScopeChip, useOneShotScope } from '../config/markers';
import type { EditScope } from '../config/model';
import { Button, cn, IconButton } from '../components/primitives';
import type { MoveResult } from '../features/FeatureTree';
import { defaultFormatValue, type FormatValue } from '../format';
import { useSpring } from '../motion';
import { EmptyState } from '../shells/shared';

/**
 * M3.7: what the Params tab needs to show the active configuration. A parameter's override applies
 * while this part regenerates (owner D1). Editing an inherited value edits Default (`scope: 'all'`),
 * an overridden value or one with the "This configuration only" chip on edits the configuration.
 */
export interface ParamsConfiguration {
  /** The active configuration's id; `null` = Default (nothing below is shown). */
  activeId: Id | null;
  activeName: string;
  /** The active configuration's overrides: paramId → expression. */
  overrides: Readonly<Record<Id, Expr>>;
  /** "Reset to default" on a marker. */
  onReset(id: Id): void;
}

export interface ParamsTableProps {
  params: readonly Param[];
  /** M3.7: the active configuration. Absent or Default: the plain table. */
  configuration?: ParamsConfiguration;
  /** Evaluates an expression in the document scope (the host resolves other params). */
  evaluate(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  onAdd?(): void;
  /** `scope` (M3.7) is given for an expression edit while a configuration is active. */
  onUpdate?(
    id: Id,
    patch: { name?: string; expr?: Expr; description?: string },
    scope?: EditScope,
  ): void;
  onRemove?(id: Id): void;
  /** Reorder; may be refused like the feature tree's. */
  onMove?(id: Id, toIndex: number): MoveResult | Promise<MoveResult> | undefined;
  /** How many expressions reference each param, to warn before deleting it. */
  usage?: Readonly<Record<Id, number>>;
  density?: 'compact' | 'touch';
  className?: string;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateName(name: string, id: Id, params: readonly Param[]): string | null {
  if (!name) return 'Give the parameter a name';
  if (!NAME_RE.test(name)) return 'Use letters, digits and _, starting with a letter';
  if (params.some((p) => p.id !== id && p.name === name)) return `“${name}” is already used`;
  return null;
}

interface RowProps {
  param: Param;
  index: number;
  count: number;
  props: ParamsTableProps;
  shaking: number;
  dragging: boolean;
  dy: number;
  onGrip(e: PointerEvent<HTMLElement>, id: Id, index: number): void;
  onGripMove(e: PointerEvent<HTMLElement>): void;
  onGripUp(): void;
  onKeyMove(id: Id, to: number): void;
}

function ParamRow({
  param,
  index,
  count,
  props,
  shaking,
  dragging,
  dy,
  onGrip,
  onGripMove,
  onGripUp,
  onKeyMove,
}: RowProps) {
  const { params, evaluate, formatValue, onUpdate, onRemove, onMove, usage, density } = props;
  const touch = density === 'touch';
  const cfg = props.configuration;
  const activeIsDefault = !cfg || cfg.activeId === null;
  const oneShot = useOneShotScope(activeIsDefault, cfg?.activeId);
  const overriddenExpr = cfg?.overrides[param.id];
  const overridden = !activeIsDefault && overriddenExpr !== undefined;
  const shown = overridden ? (overriddenExpr as Expr) : param.expr;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [describing, setDescribing] = useState(false);
  const spring = useSpring('reject');
  const fmt = formatValue ?? defaultFormatValue;
  const name = nameDraft ?? param.name;
  const nameError = nameDraft !== null ? validateName(nameDraft, param.id, params) : null;
  const result = shown.trim() ? evaluate(shown) : undefined;
  const used = usage?.[param.id] ?? 0;

  function commitName() {
    if (nameDraft === null) return;
    const err = validateName(nameDraft, param.id, params);
    if (!err && nameDraft !== param.name) onUpdate?.(param.id, { name: nameDraft });
    if (!err) setNameDraft(null);
  }

  function rowKey(e: KeyboardEvent<HTMLElement>) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onKeyMove(param.id, index + (e.key === 'ArrowUp' ? -1 : 1));
    }
  }

  return (
    <li
      data-param-id={param.id}
      aria-label={`Parameter ${param.name}`}
      style={dragging ? { transform: `translateY(${dy}px)`, zIndex: 2 } : undefined}
      onKeyDown={rowKey}
      className="group/row relative list-none"
    >
      <m.div
        key={shaking}
        initial={shaking ? { x: 9 } : false}
        animate={{ x: 0 }}
        transition={spring}
        className={cn(
          'flex gap-1.5 rounded-[10px] p-2 transition-colors duration-fast hover:bg-surface-2/70 focus-within:bg-surface-2/70',
          dragging && 'bg-surface shadow-float',
          shaking > 0 && 'bg-danger-soft',
        )}
      >
        {onMove ? (
          <span
            aria-hidden
            data-grip
            onPointerDown={(e) => onGrip(e, param.id, index)}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            className={cn(
              'flex shrink-0 cursor-grab touch-none items-start pt-2 text-fg-subtle active:cursor-grabbing',
              touch
                ? 'w-6 pt-3'
                : 'w-4 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
            )}
          >
            <GripVertical className="size-4" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <input
                aria-label={`Name of parameter ${param.name}`}
                aria-invalid={nameError ? true : undefined}
                value={name}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitName();
                  } else if (e.key === 'Escape' && nameDraft !== null) {
                    e.preventDefault();
                    e.stopPropagation();
                    setNameDraft(null);
                  }
                }}
                className={cn(
                  'w-full min-w-0 rounded-[7px] bg-transparent px-1.5 font-semibold text-fg outline-none transition-shadow duration-fast hover:shadow-[inset_0_0_0_1px_var(--color-border)] focus-visible:bg-surface focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                  touch ? 'h-11 text-sm' : 'h-7 text-ui',
                  nameError && 'shadow-[inset_0_0_0_1.5px_var(--color-danger)]',
                )}
              />
            </div>
            <span
              data-testid="param-value"
              className={cn(
                'tnum shrink-0 text-right text-ui font-medium',
                result?.ok ? 'text-fg' : 'text-fg-subtle',
              )}
            >
              {result?.ok ? fmt(result.value, result.dimension) : '—'}
            </span>
            {onRemove ? (
              <IconButton
                label={`Delete ${param.name}`}
                size={touch ? 'touch' : 'md'}
                icon={<Trash2 className="size-4" />}
                className={cn(
                  !touch &&
                    'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 group-focus-within/row:opacity-100',
                )}
                onClick={() => {
                  if (used > 0 && !confirmRemove) setConfirmRemove(true);
                  else onRemove(param.id);
                }}
              />
            ) : null}
          </div>
          {nameError ? (
            <p role="alert" className="px-1.5 text-2xs text-danger-text">
              {nameError}
            </p>
          ) : null}
          {cfg && !activeIsDefault ? (
            <div className="flex min-h-5 items-center gap-1.5 px-1.5">
              <OverrideMarker
                overridden={overridden}
                configurationName={cfg.activeName}
                fieldLabel={param.name}
                onReset={() => cfg.onReset(param.id)}
                size={touch ? 'touch' : 'md'}
              />
              <ScopeChip
                configurationName={cfg.activeName}
                activeIsDefault={false}
                scope={oneShot.scope}
                onScopeChange={oneShot.setScope}
                size={touch ? 'touch' : 'md'}
              />
            </div>
          ) : null}
          <ExpressionInput
            label={`Expression for ${param.name}`}
            value={shown}
            evaluate={evaluate}
            formatValue={formatValue}
            showValue={false}
            size={touch ? 'touch' : 'md'}
            onCommit={(expr) =>
              cfg && !activeIsDefault
                ? onUpdate?.(param.id, { expr }, oneShot.consume() === 'configuration' || overridden ? 'configuration' : 'all')
                : onUpdate?.(param.id, { expr })
            }
          />
          {param.description || describing ? (
            <input
              aria-label={`Description of ${param.name}`}
              placeholder="Add a description"
              defaultValue={param.description ?? ''}
              key={param.description ?? ''}
              // biome-ignore lint/a11y/noAutofocus: opened by an explicit "Add description" press
              autoFocus={describing && !param.description}
              onBlur={(e) => {
                setDescribing(false);
                if (e.target.value !== (param.description ?? ''))
                  onUpdate?.(param.id, { description: e.target.value });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className={cn(
                'w-full rounded-[7px] bg-transparent px-1.5 text-2xs text-fg-muted outline-none placeholder:text-fg-subtle focus-visible:bg-surface focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                touch ? 'h-11' : 'h-6',
              )}
            />
          ) : (
            <button
              type="button"
              onClick={() => setDescribing(true)}
              className={cn(
                'self-start rounded-[7px] px-1.5 text-2xs font-medium text-fg-subtle hover:text-fg',
                touch ? 'h-11 min-w-11' : 'h-5',
                !touch &&
                  'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 group-focus-within/row:opacity-100',
              )}
            >
              Add description
            </button>
          )}
          {confirmRemove ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-[8px] bg-warning-soft px-2 py-1.5 text-2xs text-warning-text"
            >
              <span className="flex-1">
                Used by {used} {used === 1 ? 'expression' : 'expressions'}; they will show errors.
              </span>
              <Button
                size={touch ? 'touch' : 'md'}
                variant="ghost"
                onClick={() => setConfirmRemove(false)}
              >
                Keep
              </Button>
              <Button
                size={touch ? 'touch' : 'md'}
                variant="secondary"
                onClick={() => onRemove?.(param.id)}
              >
                Delete anyway
              </Button>
            </div>
          ) : null}
        </div>
      </m.div>
      <span className="sr-only">
        {index + 1} of {count}
      </span>
    </li>
  );
}

/**
 * Global parameters (PLAN 2.2): name, expression, live value, description. Expressions validate
 * inline with span underlines; names are checked for syntax and uniqueness before `onUpdate`.
 */
export function ParamsTable(props: ParamsTableProps) {
  const { params, onAdd, onMove, density = 'compact', className } = props;
  const touch = density === 'touch';
  const list = useRef<HTMLUListElement>(null);
  const [shake, setShake] = useState<{ id: Id; key: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState<{
    id: Id;
    from: number;
    to: number;
    at: number;
    dy: number;
  } | null>(null);

  function requestMove(id: Id, to: number) {
    if (!onMove || to < 0 || to >= params.length) return;
    Promise.resolve(onMove(id, to)).then((r) => {
      if (r && !r.ok) {
        setShake((s) => ({ id, key: (s?.key ?? 0) + 1 }));
        setNotice(r.reason);
      } else setNotice('');
    });
  }
  const rowsEls = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[data-param-id]') ?? []);

  function gripDown(e: PointerEvent<HTMLElement>, id: Id, from: number) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, from, to: from, at: e.clientY, dy: 0 });
  }
  function gripMove(e: PointerEvent<HTMLElement>) {
    if (!drag) return;
    const dy = e.clientY - drag.at;
    let q = 0;
    rowsEls().forEach((el, j) => {
      if (j === drag.from) return;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < e.clientY) q++;
    });
    const to = Math.max(0, Math.min(params.length - 1, q));
    setDrag({ ...drag, dy, to });
  }
  function gripUp() {
    if (!drag) return;
    const { id, from, to, dy } = drag;
    setDrag(null);
    if (Math.abs(dy) > 4 && to !== from) requestMove(id, to);
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {params.length === 0 ? (
        <EmptyState icon={Variable} title="No parameters">
          <p>Name a dimension to reuse it. Values accept expressions like</p>
          <p className="tnum mt-1.5 font-medium text-fg">25mm + 1/8in</p>
        </EmptyState>
      ) : (
        <ul
          ref={list}
          aria-label="Parameters"
          className="m-0 list-none p-1.5"
          data-testid="params-list"
        >
          {params.map((p, i) => (
            <ParamRow
              key={p.id}
              param={p}
              index={i}
              count={params.length}
              props={props}
              shaking={shake?.id === p.id ? shake.key : 0}
              dragging={drag?.id === p.id && Math.abs(drag.dy) > 4}
              dy={drag?.dy ?? 0}
              onGrip={gripDown}
              onGripMove={gripMove}
              onGripUp={gripUp}
              onKeyMove={requestMove}
            />
          ))}
        </ul>
      )}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          'mx-3 mb-2 rounded-[8px] bg-danger-soft px-2.5 py-1.5 text-2xs leading-4 text-danger-text',
          !notice && 'sr-only',
        )}
      >
        {notice}
      </p>
      {onAdd ? (
        <div className="px-3 pt-1 pb-3">
          <Button
            variant="secondary"
            size={touch ? 'touch' : 'md'}
            icon={<Plus className="size-4" />}
            onClick={onAdd}
            className="w-full"
          >
            Add parameter
          </Button>
        </div>
      ) : null}
    </div>
  );
}
