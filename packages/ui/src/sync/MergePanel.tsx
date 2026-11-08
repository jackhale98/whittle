import type {
  EvalResult,
  Expr,
  MergeConflict,
  MergeConflictKind,
  MergeResolution,
  MergeResult,
} from '@whittle/contracts';
import { ArrowDown, Check, Eye, GitMerge, Pencil } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ExpressionInput } from '../components/ExpressionInput';
import { Button, cn } from '../components/primitives';
import { Badge, PanelShell, plural, rowBtn, type SyncDensity } from './shared';

export type MergeChoice = 'ours' | 'theirs' | 'base' | { value: unknown };

export interface MergePanelProps {
  result: MergeResult;
  /** The user's choices so far (controlled). A conflict without one still holds "ours". */
  resolutions: readonly MergeResolution[];
  onResolve(resolution: MergeResolution): void;
  /** Undo one choice. */
  onUnresolve?(conflictId: string): void;
  /** Preview a choice in the 3D viewport. Without it the preview buttons are hidden. */
  onPreview?(conflictId: string, choice: MergeChoice): void;
  onFinish(): void;
  onCancel?(): void;
  /** Evaluates typed expressions (enables the inline value field's live validation). */
  evaluate?(expr: Expr): EvalResult;
  /** Names of the two sides, e.g. "This device" and "Another device" or a branch name. */
  oursLabel?: string;
  theirsLabel?: string;
  /** Whether a conflict's leaf is an expression (default: by the last path segment). */
  isExpression?(conflict: MergeConflict): boolean;
  /** Human text of a value. Expressions are shown exactly as typed. */
  describeValue?(value: unknown, conflict: MergeConflict): string;
  finishing?: boolean;
  density?: SyncDensity;
  className?: string;
}

const EXPR_LEAVES = new Set([
  'expr',
  'distance',
  'depth',
  'radius',
  'diameter',
  'angle',
  'length',
  'width',
  'height',
  'offset',
  'value',
  'count',
]);

export function defaultIsExpression(c: MergeConflict): boolean {
  const leaf = c.path.split('/').filter(Boolean).pop() ?? '';
  return EXPR_LEAVES.has(leaf) && (typeof c.ours === 'string' || typeof c.theirs === 'string');
}

export function defaultDescribeValue(value: unknown): string {
  if (value === undefined) return 'Not there';
  if (value === null) return 'Empty';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value))
    return value.map((v) => defaultDescribeValue(v)).join(', ') || '(empty)';
  return JSON.stringify(value);
}

const KIND_TEXT: Record<MergeConflictKind, string> = {
  bothModified: 'Both changed this',
  modifiedDeleted: 'One side changed it, the other deleted it',
  bothAdded: 'Both added this with different content',
  order: 'Both reordered this list differently',
};

function choiceOf(r: MergeResolution | undefined): 'ours' | 'theirs' | 'base' | 'value' | null {
  if (!r) return null;
  return 'take' in r ? r.take : 'value';
}

/**
 * Merge conflicts, side by side (PLAN 8A.3). Each conflict shows base, mine and theirs in plain
 * values and takes one inline decision. "Finish merge" stays off until all are decided; the
 * auto-merged count says how much already merged without asking.
 */
export function MergePanel({
  result,
  resolutions,
  onResolve,
  onUnresolve,
  onPreview,
  onFinish,
  onCancel,
  evaluate,
  oursLabel = 'Mine',
  theirsLabel = 'Theirs',
  isExpression = defaultIsExpression,
  describeValue = defaultDescribeValue,
  finishing,
  density = 'compact',
  className,
}: MergePanelProps) {
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const conflicts = result.conflicts;
  const byId = new Map(resolutions.map((r) => [r.conflictId, r]));
  const resolved = conflicts.filter((c) => byId.has(c.id)).length;
  const left = conflicts.length - resolved;
  const hintId = useId();
  const cards = useRef(new Map<string, HTMLElement>());

  function nextUnresolved() {
    const c = conflicts.find((x) => !byId.has(x.id));
    const el = c ? cards.current.get(c.id) : undefined;
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  }

  return (
    <PanelShell title="Merge" density={density} testId="merge-panel" className={className}>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <div
          role="status"
          aria-live="polite"
          data-testid="merge-summary"
          className="flex flex-col gap-1 rounded-control bg-surface-2 p-3 text-ui"
        >
          <p>
            <span className="font-semibold">
              {conflicts.length === 0
                ? 'No conflicts'
                : `${resolved} of ${plural(conflicts.length, 'conflict')} decided`}
            </span>
          </p>
          <p className="text-xs text-fg-muted">
            <Check
              className="mr-1 inline size-3.5 align-text-bottom text-success-text"
              aria-hidden
            />
            {plural(result.autoMerged, 'change')} merged automatically
          </p>
        </div>

        {conflicts.length > 0 ? (
          <ol aria-label="Conflicts" className="m-0 flex list-none flex-col gap-3 p-0">
            {conflicts.map((c, i) => (
              <ConflictCard
                key={c.id}
                conflict={c}
                index={i}
                total={conflicts.length}
                resolution={byId.get(c.id)}
                oursLabel={oursLabel}
                theirsLabel={theirsLabel}
                expression={isExpression(c)}
                show={(v) => describeValue(v, c)}
                evaluate={evaluate}
                density={density}
                onPreview={onPreview}
                onResolve={onResolve}
                onUnresolve={onUnresolve}
                register={(el) => {
                  if (el) cards.current.set(c.id, el);
                  else cards.current.delete(c.id);
                }}
              />
            ))}
          </ol>
        ) : null}

        <div className="flex flex-col gap-2">
          {left > 0 ? (
            <p id={hintId} className="text-xs text-fg-muted">
              Decide {plural(left, 'more conflict')} to finish the merge.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              {onCancel ? (
                <Button variant="ghost" size={size} onClick={onCancel}>
                  Cancel merge
                </Button>
              ) : null}
              {left > 0 ? (
                <Button
                  size={size}
                  icon={<ArrowDown className="size-4" aria-hidden />}
                  onClick={nextUnresolved}
                >
                  Next unresolved
                </Button>
              ) : null}
            </div>
            <Button
              variant="primary"
              size={size}
              disabled={left > 0 || finishing}
              aria-describedby={left > 0 ? hintId : undefined}
              icon={<GitMerge className="size-4" aria-hidden />}
              onClick={onFinish}
            >
              {finishing ? 'Merging…' : 'Finish merge'}
            </Button>
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function ConflictCard({
  conflict: c,
  index,
  total,
  resolution,
  oursLabel,
  theirsLabel,
  expression,
  show,
  evaluate,
  density,
  onPreview,
  onResolve,
  onUnresolve,
  register,
}: {
  conflict: MergeConflict;
  index: number;
  total: number;
  resolution?: MergeResolution;
  oursLabel: string;
  theirsLabel: string;
  expression: boolean;
  show(v: unknown): string;
  evaluate?(expr: Expr): EvalResult;
  density: SyncDensity;
  onPreview?(id: string, choice: MergeChoice): void;
  onResolve(r: MergeResolution): void;
  onUnresolve?(id: string): void;
  register(el: HTMLElement | null): void;
}) {
  const touch = density === 'touch';
  const size = touch ? 'touch' : 'md';
  const choice = choiceOf(resolution);
  const [editing, setEditing] = useState(choice === 'value');
  const canEdit = expression || typeof c.ours === 'string' || typeof c.ours === 'number';
  const customValue = resolution && 'value' in resolution ? show(resolution.value) : show(c.ours);

  const sides: Array<{
    id: 'base' | 'ours' | 'theirs';
    label: string;
    value: unknown;
  }> = [
    { id: 'base', label: 'Before', value: c.base },
    { id: 'ours', label: oursLabel, value: c.ours },
    { id: 'theirs', label: theirsLabel, value: c.theirs },
  ];

  const decided =
    choice === 'ours'
      ? `Kept ${oursLabel.toLowerCase()}`
      : choice === 'theirs'
        ? `Took ${theirsLabel.toLowerCase()}`
        : choice === 'base'
          ? 'Kept the original'
          : choice === 'value'
            ? 'Entered a new value'
            : null;

  return (
    <li
      ref={register}
      tabIndex={-1}
      aria-label={`Conflict ${index + 1} of ${total}: ${c.subject.label}`}
      data-conflict-id={c.id}
      data-resolved={choice ? 'true' : 'false'}
      className={cn(
        '@container flex flex-col gap-2.5 rounded-control bg-surface p-3 shadow-card outline-none focus-visible:shadow-[0_0_0_2px_var(--color-accent)]',
        choice && 'bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{c.subject.label}</h3>
          <p className="text-2xs text-fg-muted">{KIND_TEXT[c.kind]}</p>
        </div>
        {decided ? (
          <Badge tone="success">
            <Check className="size-3" aria-hidden />
            {decided}
          </Badge>
        ) : (
          <Badge tone="warning">Needs a decision</Badge>
        )}
      </div>

      <dl className="m-0 grid grid-cols-1 gap-1.5 @sm:grid-cols-3">
        {sides.map((s) => (
          <div
            key={s.id}
            data-side={s.id}
            className={cn(
              'flex min-w-0 flex-col gap-0.5 rounded-lg bg-surface-2 p-2',
              choice === s.id && 'shadow-[inset_0_0_0_2px_var(--color-accent)]',
            )}
          >
            <dt className="text-2xs font-medium text-fg-muted">{s.label}</dt>
            <dd className="m-0 flex min-w-0 flex-col">
              <span
                className={cn(
                  'tnum text-ui break-words',
                  s.value === undefined && 'text-fg-subtle italic',
                  expression && s.value !== undefined && 'font-mono',
                )}
              >
                {show(s.value)}
              </span>
              {onPreview && s.id !== 'base' ? (
                <button
                  type="button"
                  aria-label={`Preview ${s.label.toLowerCase()} for ${c.subject.label}`}
                  onClick={() => onPreview(c.id, s.id)}
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 self-start rounded-control px-1.5 text-2xs font-medium text-accent-text hover:bg-accent-soft',
                    touch ? 'min-h-11' : 'min-h-6',
                  )}
                >
                  <Eye className="size-3.5" aria-hidden /> Preview
                </button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">{`Decide: ${c.subject.label}`}</legend>
        <Button
          size={size}
          variant={choice === 'ours' ? 'primary' : 'secondary'}
          aria-pressed={choice === 'ours'}
          onClick={() => {
            setEditing(false);
            onResolve({ conflictId: c.id, take: 'ours' });
          }}
        >
          Keep mine
        </Button>
        <Button
          size={size}
          variant={choice === 'theirs' ? 'primary' : 'secondary'}
          aria-pressed={choice === 'theirs'}
          onClick={() => {
            setEditing(false);
            onResolve({ conflictId: c.id, take: 'theirs' });
          }}
        >
          Take theirs
        </Button>
        {canEdit ? (
          <Button
            size={size}
            variant={choice === 'value' ? 'primary' : 'secondary'}
            aria-pressed={editing || choice === 'value'}
            aria-expanded={editing}
            icon={<Pencil className="size-4" aria-hidden />}
            onClick={() => setEditing((e) => !e)}
          >
            Edit value
          </Button>
        ) : null}
        {choice && onUnresolve ? (
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              onUnresolve(c.id);
            }}
            className={cn(rowBtn(density), 'text-fg-muted hover:bg-surface-3')}
          >
            Undo
          </button>
        ) : null}
      </fieldset>

      {editing && canEdit ? (
        <div className="flex flex-col gap-1">
          {expression ? (
            <ExpressionInput
              label={`New value for ${c.subject.label}`}
              value={customValue === 'Not there' ? '' : customValue}
              evaluate={evaluate}
              size={touch ? 'touch' : 'md'}
              keypad="never"
              largeText={touch}
              allowEmpty={false}
              onCommit={(v) => onResolve({ conflictId: c.id, value: v })}
              onPreview={onPreview ? (v) => onPreview(c.id, { value: v }) : undefined}
            />
          ) : (
            <PlainValue
              label={`New value for ${c.subject.label}`}
              initial={customValue}
              numeric={typeof c.ours === 'number'}
              density={density}
              onCommit={(v) => onResolve({ conflictId: c.id, value: v })}
            />
          )}
          <p className="text-2xs text-fg-subtle">Press Enter to use this value.</p>
        </div>
      ) : null}
    </li>
  );
}

function PlainValue({
  label,
  initial,
  numeric,
  density,
  onCommit,
}: {
  label: string;
  initial: string;
  numeric: boolean;
  density: SyncDensity;
  onCommit(v: unknown): void;
}) {
  const [text, setText] = useState(initial);
  const bad = numeric && text.trim() !== '' && Number.isNaN(Number(text));
  return (
    <input
      aria-label={label}
      aria-invalid={bad || undefined}
      value={text}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text.trim() && !bad) {
          e.preventDefault();
          onCommit(numeric ? Number(text) : text);
        }
      }}
      className={cn(
        'w-full min-w-0 rounded-control bg-surface-2 px-2.5 text-fg shadow-[inset_0_0_0_1px_var(--color-border-strong)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--color-danger)]',
        density === 'touch' ? 'h-11 text-base' : 'h-8 text-ui',
      )}
    />
  );
}
