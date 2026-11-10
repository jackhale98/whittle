import type { EvalResult, Expr, Id, Param } from '@wren-cad/contracts';
import {
  Box,
  ChevronRight,
  GripVertical,
  Link2,
  PencilRuler,
  Plus,
  Trash2,
  Variable,
} from 'lucide-react';
import { m } from 'motion/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn, IconButton } from '../components/primitives';
import type { MoveResult } from '../features/FeatureTree';
import { defaultFormatValue, type FormatValue } from '../format';
import { beginParamDrag, getParamDrag, subscribeParamDrag } from '../logic/paramDrag';
import { useSpring } from '../motion';
import { EmptyState } from '../shells/shared';

/** Something that uses a parameter: a feature's value, a sketch dimension, or another parameter. */
export interface ParamUse {
  /** Stable key within one parameter's list. */
  key: string;
  kind: 'feature' | 'dimension' | 'param';
  /** The feature, sketch or parameter that uses it ("Extrude 1"). */
  label: string;
  /** Which value ("depth", "diameter dimension"). */
  detail?: string;
  featureId?: Id;
  /** For a sketch dimension: the constraint. */
  constraintId?: Id;
  paramId?: Id;
}

export interface ParamsTableProps {
  params: readonly Param[];
  /** Evaluates an expression in the document scope (the host resolves other params). */
  evaluate(expr: Expr): EvalResult;
  formatValue?: FormatValue;
  onAdd?(): void;
  onUpdate?(id: Id, patch: { name?: string; expr?: Expr; description?: string }): void;
  onRemove?(id: Id): void;
  /** Reorder; may be refused like the feature tree's. */
  onMove?(id: Id, toIndex: number): MoveResult | Promise<MoveResult> | undefined;
  /** How many expressions reference each param, to warn before deleting it. */
  usage?: Readonly<Record<Id, number>>;
  /** What uses each param (ADR-080): "Used by N", expandable to the list. Supersedes `usage`. */
  usedBy?: Readonly<Record<Id, readonly ParamUse[]>>;
  /** Choose an entry of a "Used by" list: select the feature, open the sketch at the dimension. */
  onSelectUse?(use: ParamUse): void;
  /** "Make parameter" from a field's value: create `name = expr` (see `ParamLinks.make`). */
  onMake?(name: string, expr: Expr): string | undefined;
  /** The field has committed the new name: close the undo step. */
  onMakeDone?(): void;
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
  onHint(text: string): void;
  onFocusParam(id: Id): void;
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
  onHint,
  onFocusParam,
}: RowProps) {
  const { params, evaluate, formatValue, onUpdate, onRemove, onMove, usage, density } = props;
  const touch = density === 'touch';
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [describing, setDescribing] = useState(false);
  const spring = useSpring('reject');
  const fmt = formatValue ?? defaultFormatValue;
  const name = nameDraft ?? param.name;
  const nameError = nameDraft !== null ? validateName(nameDraft, param.id, params) : null;
  const result = param.expr.trim() ? evaluate(param.expr) : undefined;
  const uses = props.usedBy?.[param.id];
  const used = uses ? uses.length : (usage?.[param.id] ?? 0);
  const [showUses, setShowUses] = useState(false);
  const usesId = useId();
  const hintId = useId();

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
            <button
              type="button"
              data-testid="param-drag"
              data-param-handle={param.name}
              aria-label={`Use ${param.name}`}
              aria-describedby={hintId}
              title={`Drag ${param.name} onto a dimension or a field`}
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                e.preventDefault();
                beginParamDrag(e, param.name);
              }}
              onClick={() =>
                onHint(
                  `To use ${param.name}, type it in a value field or press Alt+Down in the field and choose it.`,
                )
              }
              className={cn(
                'flex shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-fg-subtle shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-surface-3 hover:text-accent-text active:cursor-grabbing',
                touch ? 'size-11' : 'size-7',
              )}
            >
              <Link2 className="size-4" aria-hidden />
            </button>
            <span id={hintId} className="sr-only">
              Drag onto a dimension or a value field to use it. With the keyboard, type the name in
              the field or press Alt and Down Arrow there.
            </span>
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
          {props.usedBy ? (
            <div>
              <button
                type="button"
                data-testid="param-used-by"
                aria-expanded={used > 0 ? showUses : undefined}
                aria-controls={used > 0 ? usesId : undefined}
                disabled={used === 0}
                onClick={() => setShowUses((v) => !v)}
                className={cn(
                  'flex items-center gap-1 rounded-[7px] px-1.5 text-2xs font-medium text-fg-muted enabled:hover:text-fg',
                  touch ? 'min-h-11' : 'h-6',
                )}
              >
                {used > 0 ? (
                  <ChevronRight
                    className={cn(
                      'size-3.5 transition-transform duration-fast',
                      showUses && 'rotate-90',
                    )}
                    aria-hidden
                  />
                ) : null}
                {used === 0 ? 'Not used yet' : `Used by ${used}`}
              </button>
              {showUses && uses && used > 0 ? (
                <ul id={usesId} aria-label={`Used by, ${param.name}`} className="m-0 list-none p-0">
                  {uses.map((u) => (
                    <li key={u.key}>
                      <button
                        type="button"
                        data-testid="param-use"
                        onClick={() =>
                          u.kind === 'param'
                            ? onFocusParam(u.paramId ?? '')
                            : props.onSelectUse?.(u)
                        }
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[7px] px-1.5 text-left text-ui hover:bg-surface-3',
                          touch ? 'min-h-11' : 'min-h-7',
                        )}
                      >
                        {u.kind === 'dimension' ? (
                          <PencilRuler className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                        ) : u.kind === 'param' ? (
                          <Variable className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                        ) : (
                          <Box className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate">{u.label}</span>
                        {u.detail ? (
                          <span className="shrink-0 text-2xs text-fg-muted">{u.detail}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {nameError ? (
            <p role="alert" className="px-1.5 text-2xs text-danger-text">
              {nameError}
            </p>
          ) : null}
          <ExpressionInput
            label={`Expression for ${param.name}`}
            value={param.expr}
            evaluate={evaluate}
            formatValue={formatValue}
            showValue={false}
            paramLinks="complete"
            size={touch ? 'touch' : 'md'}
            onCommit={(expr) => onUpdate?.(param.id, { expr })}
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

/** The chip that follows the pointer while a parameter is dragged onto a value (ADR-080). */
function ParamDragGhost() {
  const drag = useSyncExternalStore(subscribeParamDrag, getParamDrag, getParamDrag);
  if (!drag) return null;
  return createPortal(
    <div
      aria-hidden
      data-testid="param-drag-ghost"
      data-over={drag.over || undefined}
      style={{ position: 'fixed', left: drag.x + 12, top: drag.y + 12 }}
      className={cn(
        'pointer-events-none z-[var(--z-popover)] flex items-center gap-1 rounded-full px-2.5 py-1 text-ui font-semibold shadow-float',
        drag.over ? 'bg-accent text-accent-fg' : 'bg-surface text-fg',
      )}
    >
      <Link2 className="size-3.5" />
      {drag.name}
    </div>,
    document.body,
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
  const [hint, setHint] = useState('');
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

  function focusParam(id: Id) {
    list.current
      ?.querySelector<HTMLElement>(`[data-param-id="${id}"] input[aria-label^="Name of"]`)
      ?.focus();
  }

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
              onHint={setHint}
              onFocusParam={focusParam}
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
      <p
        aria-live="polite"
        data-testid="param-hint"
        className={cn('mx-3 mb-2 text-2xs leading-4 text-fg-muted', !hint && 'sr-only')}
      >
        {hint}
      </p>
      <ParamDragGhost />
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
