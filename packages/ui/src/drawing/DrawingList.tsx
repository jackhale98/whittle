import { Copy, FilePlus, FileText, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, cn, IconButton } from '../components/primitives';

export interface DrawingListItem {
  id: string;
  name: string;
  /** `ISO · first angle · 2 sheets`. */
  summary: string;
  /** Needs-attention count when known. */
  attention?: number;
}

export interface DrawingListProps {
  drawings: readonly DrawingListItem[];
  onOpen(id: string): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  onDuplicate?(id: string): void;
  onNew(): void;
  /** Phone: review only, no new drawings or deletes. */
  reviewOnly?: boolean;
  size?: 'md' | 'touch';
  /** Why a new drawing is not possible (no part yet). */
  newDisabled?: string;
}

/**
 * The document's drawings: open, rename, delete (with an inline confirmation, never a dialog)
 * and make a new one. Rename is inline in the row.
 */
export function DrawingList({
  drawings,
  onOpen,
  onRename,
  onDelete,
  onDuplicate,
  onNew,
  reviewOnly,
  size = 'md',
  newDisabled,
}: DrawingListProps) {
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const touch = size === 'touch';
  return (
    <section aria-label="Drawings" data-testid="drawing-list" className="flex flex-col gap-2">
      {drawings.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No drawings yet.
          {reviewOnly
            ? ''
            : ' A drawing shows this part on a sheet, with dimensions that follow the model.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {drawings.map((d) => (
            <li
              key={d.id}
              data-drawing={d.id}
              className="flex items-center gap-1 rounded-control bg-surface-2 pr-1"
            >
              {renaming?.id === d.id ? (
                <input
                  // biome-ignore lint/a11y/noAutofocus: opened by an explicit Rename press
                  autoFocus
                  aria-label="New drawing name"
                  value={renaming.text}
                  onChange={(e) => setRenaming({ id: d.id, text: e.target.value })}
                  onBlur={() => {
                    if (renaming.text.trim() && renaming.text.trim() !== d.name)
                      onRename(d.id, renaming.text.trim());
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="m-1 h-8 min-w-0 flex-1 rounded-control bg-surface px-2 text-ui font-semibold outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(d.id)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2.5 rounded-control px-2.5 text-left',
                    touch ? 'min-h-14' : 'min-h-11',
                  )}
                  data-testid="drawing-open"
                >
                  <FileText className="size-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui font-medium">{d.name}</span>
                    <span className="truncate text-2xs text-fg-muted">{d.summary}</span>
                  </span>
                  {d.attention ? (
                    <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-2xs font-medium text-danger-text">
                      {d.attention} to fix
                    </span>
                  ) : null}
                </button>
              )}
              {!reviewOnly && renaming?.id !== d.id ? (
                confirm === d.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="secondary"
                      size={touch ? 'touch' : 'md'}
                      onClick={() => {
                        setConfirm(null);
                        onDelete(d.id);
                      }}
                      data-testid="drawing-delete-confirm"
                    >
                      Delete
                    </Button>
                    <Button
                      variant="ghost"
                      size={touch ? 'touch' : 'md'}
                      onClick={() => setConfirm(null)}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center">
                    <IconButton
                      label={`Rename ${d.name}`}
                      icon={<Pencil className="size-4" />}
                      size={touch ? 'touch' : 'md'}
                      onClick={() => setRenaming({ id: d.id, text: d.name })}
                    />
                    {onDuplicate ? (
                      <IconButton
                        label={`Duplicate ${d.name}`}
                        icon={<Copy className="size-4" />}
                        size={touch ? 'touch' : 'md'}
                        onClick={() => onDuplicate(d.id)}
                      />
                    ) : null}
                    <IconButton
                      label={`Delete ${d.name}`}
                      icon={<Trash2 className="size-4" />}
                      size={touch ? 'touch' : 'md'}
                      onClick={() => setConfirm(d.id)}
                      data-testid="drawing-delete"
                    />
                  </span>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!reviewOnly ? (
        <Button
          variant="secondary"
          size={touch ? 'touch' : 'md'}
          icon={<FilePlus className="size-4" />}
          onClick={onNew}
          disabled={newDisabled !== undefined}
          title={newDisabled}
          data-testid="drawing-new"
        >
          New drawing
        </Button>
      ) : null}
    </section>
  );
}
