import { RotateCcw, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../components/primitives';

export interface TitleBlockRow {
  slot: string;
  caption: string;
  /** What the sheet shows. */
  text: string;
  /**
   * `bound`: read from the model and shown as is; `text`: typed here; `override`: typed text over
   * a bound value (badged); `empty`: nothing yet.
   */
  source: 'bound' | 'text' | 'override' | 'empty';
  /** For `override`: what the model would show. */
  bound?: string;
  warnings?: readonly string[];
}

export interface TitleBlockEditorProps {
  rows: readonly TitleBlockRow[];
  /** Text kept for slots this template has no cell for. */
  unused?: readonly { slot: string; text: string }[];
  /** Sets the text of a slot; `null` clears it (a bound slot goes back to its binding). */
  onEdit(slot: string, text: string | null): void;
  /** The slot to focus (from a click on the sheet). */
  focusSlot?: string | null;
  size?: 'md' | 'touch';
}

const BADGE: Record<TitleBlockRow['source'], string | null> = {
  bound: 'From the model',
  text: null,
  override: 'Overrides the model',
  empty: null,
};

function Row({
  r,
  onEdit,
  focus,
  size,
}: {
  r: TitleBlockRow;
  onEdit: TitleBlockEditorProps['onEdit'];
  focus: boolean;
  size: 'md' | 'touch';
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  useEffect(() => setDraft(null), []);
  const commit = () => {
    if (draft === null) return;
    // Typing back the bound text is no override: it clears the slot.
    if (r.source !== 'text' && r.source !== 'empty' && draft === (r.bound ?? r.text))
      onEdit(r.slot, null);
    else if (draft !== r.text) onEdit(r.slot, draft);
    setDraft(null);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') setDraft(null);
  };
  return (
    <div className="flex flex-col gap-1" data-slot={r.slot} data-source={r.source}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-fg-muted">
          {r.caption}
        </label>
        {BADGE[r.source] ? (
          <span
            data-testid={`slot-badge-${r.slot}`}
            className={cn(
              'rounded-full px-1.5 py-0.5 text-2xs',
              r.source === 'override'
                ? 'bg-warning-soft text-warning-text'
                : 'bg-surface-3 text-fg-muted',
            )}
          >
            {BADGE[r.source]}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <input
          id={id}
          ref={ref}
          value={draft ?? r.text}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={key}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            'min-w-0 flex-1 rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
            size === 'touch' ? 'h-11 text-sm' : 'h-8',
          )}
        />
        {r.source === 'override' ? (
          <button
            type="button"
            aria-label={`Use the model’s value for ${r.caption}`}
            title={`Model: ${r.bound ?? ''}`}
            onClick={() => onEdit(r.slot, null)}
            className="flex size-8 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-2"
          >
            <RotateCcw className="size-4" />
          </button>
        ) : null}
      </div>
      {r.source === 'override' ? (
        <p className="text-2xs text-fg-subtle">The model says: {r.bound || 'nothing'}</p>
      ) : null}
      {r.warnings?.map((w) => (
        <p key={w} className="flex items-center gap-1 text-2xs text-warning-text">
          <TriangleAlert className="size-3 shrink-0" aria-hidden /> {w}
        </p>
      ))}
    </div>
  );
}

/**
 * The title block's fields. A bound field (part number, material, mass, scale …) shows the
 * model's value and says so; typing over it is an override, badged, with the model's value kept
 * in view and one tap back. Unbound fields (owner, drawn by …) are plain text.
 */
export function TitleBlockEditor({
  rows,
  unused,
  onEdit,
  focusSlot,
  size = 'md',
}: TitleBlockEditorProps) {
  return (
    <div className="flex flex-col gap-3 px-4 pb-4" data-testid="title-block-editor">
      {rows.map((r) => (
        <Row key={r.slot} r={r} onEdit={onEdit} focus={focusSlot === r.slot} size={size} />
      ))}
      {unused && unused.length > 0 ? (
        <p className="text-2xs text-fg-subtle">
          Kept but not shown by this template:{' '}
          {unused.map((u) => `${u.slot} (${u.text})`).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

export interface InlineCellEditorProps {
  caption: string;
  value: string;
  bound?: string;
  overridden?: boolean;
  onCommit(text: string | null): void;
  onCancel(): void;
  /** Screen box of the cell. */
  box: { x: number; y: number; width: number; height: number };
}

/** The editor that opens over a title block cell on the sheet: one field, Enter commits, Esc leaves. */
export function InlineCellEditor({
  caption,
  value,
  bound,
  overridden,
  onCommit,
  onCancel,
  box,
}: InlineCellEditorProps) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const width = Math.max(220, box.width);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    // Unchanged leaves the slot alone; the model's own text clears an override.
    if (draft === value) onCancel();
    else onCommit(bound !== undefined && draft === bound ? null : draft);
  };
  return (
    <div
      data-viewer-ui
      data-testid="cell-editor"
      className="absolute z-10 flex flex-col gap-1 rounded-control bg-surface p-2 shadow-pop"
      style={{ left: Math.max(4, box.x), top: Math.max(4, box.y + box.height + 4), width }}
    >
      <label className="text-2xs font-medium text-fg-muted" htmlFor="cell-editor-input">
        {caption}
        {bound !== undefined ? ` (model: ${bound || 'nothing'})` : ''}
      </label>
      <input
        id="cell-editor-input"
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={finish}
        className="h-8 rounded-control bg-surface-2 px-2.5 text-ui outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
      />
      {overridden ? (
        <p className="text-2xs text-fg-subtle">Enter the model’s text to go back to it.</p>
      ) : null}
    </div>
  );
}
