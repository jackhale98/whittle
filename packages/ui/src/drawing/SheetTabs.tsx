import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Button, cn, IconButton } from '../components/primitives';

export interface SheetTab {
  id: string;
  name: string;
}

export interface SheetTabsProps {
  sheets: readonly SheetTab[];
  current: string | null;
  onSelect(id: string): void;
  /**
   * Editing (desktop and tablet): add, rename inline, delete with an inline confirmation, and
   * reorder by drag or with the move buttons. Absent: switching only (the phone reviews).
   */
  edit?: {
    onAdd(): void;
    onRename(id: string, name: string): void;
    onDelete(id: string): void;
    onMove(id: string, toIndex: number): void;
    /** What deleting the sheet takes with it, for the confirmation (`3 views and a table`). */
    contents?(id: string): string;
  };
  /** A view is being dragged over this tab: dropping it there moves it to that sheet. */
  dropTarget?: string | null;
  size?: 'md' | 'touch';
  className?: string;
}

/**
 * Sheet tabs along the bottom edge of the sheet (ADR-094): each tab shows the sheet's number and
 * name. Nothing here is modal: a rename is typed in the tab, a delete is confirmed in the strip.
 * Every drag (reorder) has an inline alternative (the move buttons, WCAG 2.5.7).
 */
export function SheetTabs({
  sheets,
  current,
  onSelect,
  edit,
  dropTarget,
  size = 'md',
  className,
}: SheetTabsProps) {
  const touch = size === 'touch';
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const press = useRef<{ id: string; x: number; pointer: number; moved: boolean } | null>(null);
  const index = sheets.findIndex((s) => s.id === current);
  const cur = index >= 0 ? sheets[index] : undefined;

  // The current tab stays in sight when the strip scrolls (many sheets, a narrow screen).
  useEffect(() => {
    if (!current) return;
    const tabs = list.current?.querySelectorAll<HTMLElement>('[data-sheet-tab]') ?? [];
    const el = [...tabs].find((t) => t.dataset.sheetTab === current);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  // A sheet that went away (undo, a peer's edit) takes its pending rename or confirmation along.
  useEffect(() => {
    if (renaming && !sheets.some((s) => s.id === renaming.id)) setRenaming(null);
    if (confirm && !sheets.some((s) => s.id === confirm)) setConfirm(null);
  }, [sheets, renaming, confirm]);

  const commitRename = () => {
    if (!renaming || !edit) return;
    const name = renaming.text.trim();
    const was = sheets.find((s) => s.id === renaming.id)?.name;
    setRenaming(null);
    if (name !== '' && name !== was) edit.onRename(renaming.id, name);
  };

  // Reorder by drag: the insertion index from the pointer against the tabs' middles.
  const slotAt = (x: number): number => {
    const tabs = [...(list.current?.querySelectorAll<HTMLElement>('[data-sheet-tab]') ?? [])];
    let k = 0;
    for (const t of tabs) {
      const r = t.getBoundingClientRect();
      if (x > r.left + r.width / 2) k++;
    }
    return k;
  };
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (!edit || renaming || e.button !== 0) return;
    press.current = { id, x: e.clientX, pointer: e.pointerId, moved: false };
  };
  const onMoveP = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    if (!p.moved && Math.abs(e.clientX - p.x) > 6) {
      p.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic pointer cannot be captured; the drag still works over the strip.
      }
    }
    if (p.moved) {
      const from = sheets.findIndex((s) => s.id === p.id);
      const slot = slotAt(e.clientX);
      // The slot counts the dragged tab itself when it lies left of the pointer.
      setDrag({ id: p.id, to: slot > from ? slot - 1 : slot });
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || p.pointer !== e.pointerId || !p.moved) return;
    e.preventDefault();
    const d = drag;
    setDrag(null);
    const from = sheets.findIndex((s) => s.id === p.id);
    if (d && edit && d.to !== from)
      edit.onMove(p.id, Math.max(0, Math.min(sheets.length - 1, d.to)));
  };

  const control = touch ? 'h-11' : 'h-8';
  return (
    <nav
      aria-label="Sheets"
      data-testid="sheet-tabs"
      data-dragging={drag ? drag.id : undefined}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-1 border-t border-border bg-surface px-2',
        touch ? 'h-14' : 'h-11',
        className,
      )}
    >
      <ol
        ref={list}
        className="m-0 flex min-w-0 list-none items-center gap-0.5 overflow-x-auto p-0"
      >
        {sheets.map((s, i) => {
          const active = s.id === current;
          const number = i + 1;
          const isDrop = dropTarget === s.id && !active;
          const before =
            drag &&
            drag.id !== s.id &&
            drag.to === i &&
            i < sheets.findIndex((x) => x.id === drag.id);
          const after =
            drag &&
            drag.id !== s.id &&
            drag.to === i &&
            i > sheets.findIndex((x) => x.id === drag.id);
          return (
            <li key={s.id} className="relative flex shrink-0 items-center">
              {before ? (
                <span
                  aria-hidden
                  className="absolute -left-0.5 inset-y-1 w-0.5 rounded bg-accent"
                />
              ) : null}
              {renaming?.id === s.id ? (
                <input
                  // biome-ignore lint/a11y/noAutofocus: an inline rename starts typing at once
                  autoFocus
                  aria-label={`Name of sheet ${number}`}
                  data-testid="sheet-rename"
                  value={renaming.text}
                  onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                  onBlur={commitRename}
                  className={cn(
                    'w-36 rounded-control bg-surface-2 px-2 text-ui outline-none shadow-[inset_0_0_0_2px_var(--color-accent)]',
                    control,
                  )}
                />
              ) : (
                <button
                  type="button"
                  data-sheet-tab={s.id}
                  data-testid="sheet-tab"
                  // Starts with what it shows (WCAG 2.5.3), then where it is in the drawing.
                  aria-label={`${number} ${s.name}, sheet ${number} of ${sheets.length}`}
                  data-drop={isDrop || undefined}
                  aria-current={active ? 'page' : undefined}
                  title={edit && active ? 'Double-click to rename; drag to reorder' : s.name}
                  onClick={() => onSelect(s.id)}
                  onDoubleClick={() => {
                    if (edit) setRenaming({ id: s.id, text: s.name });
                  }}
                  onPointerDown={(e) => onDown(e, s.id)}
                  onPointerMove={onMoveP}
                  onPointerUp={onUp}
                  onPointerCancel={() => {
                    press.current = null;
                    setDrag(null);
                  }}
                  className={cn(
                    'flex max-w-[16rem] items-center gap-1.5 rounded-control px-2.5 text-ui font-medium outline-none transition-colors duration-fast focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
                    control,
                    edit && 'touch-none',
                    active
                      ? 'bg-surface-2 text-fg shadow-[inset_0_-2px_0_var(--color-accent)]'
                      : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                    isDrop &&
                      'bg-accent-soft text-accent-text shadow-[inset_0_0_0_2px_var(--color-accent)]',
                    drag?.id === s.id && 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'tnum min-w-5 rounded-full px-1 text-center text-2xs',
                      active ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg-muted',
                    )}
                  >
                    {number}
                  </span>{' '}
                  <span className="truncate">{s.name}</span>
                </button>
              )}
              {after ? (
                <span
                  aria-hidden
                  className="absolute -right-0.5 inset-y-1 w-0.5 rounded bg-accent"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {edit && cur ? (
        confirm === cur.id ? (
          <fieldset
            aria-label={`Delete ${cur.name}?`}
            className="m-0 flex min-w-0 shrink-0 items-center gap-1 border-0 p-0 pl-1"
            data-testid="sheet-delete-confirm-group"
          >
            <span className="truncate text-xs text-fg-muted">
              Delete {cur.name}
              {edit.contents?.(cur.id) ? ` and its ${edit.contents(cur.id)}` : ''}?
            </span>
            <Button
              variant="secondary"
              size={touch ? 'touch' : 'md'}
              onClick={() => {
                setConfirm(null);
                edit.onDelete(cur.id);
              }}
              data-testid="sheet-delete-confirm"
            >
              Delete
            </Button>
            <Button variant="ghost" size={touch ? 'touch' : 'md'} onClick={() => setConfirm(null)}>
              Keep
            </Button>
          </fieldset>
        ) : (
          <div className="flex shrink-0 items-center" data-testid="sheet-actions">
            <IconButton
              label={`Rename ${cur.name}`}
              icon={<Pencil className="size-4" />}
              size={size}
              onClick={() => setRenaming({ id: cur.id, text: cur.name })}
              data-testid="sheet-rename-start"
            />
            <IconButton
              label={`Move ${cur.name} left`}
              icon={<ChevronLeft className="size-4" />}
              size={size}
              disabled={index <= 0}
              onClick={() => index > 0 && edit.onMove(cur.id, index - 1)}
              data-testid="sheet-move-left"
            />
            <IconButton
              label={`Move ${cur.name} right`}
              icon={<ChevronRight className="size-4" />}
              size={size}
              disabled={index >= sheets.length - 1}
              onClick={() => index < sheets.length - 1 && edit.onMove(cur.id, index + 1)}
              data-testid="sheet-move-right"
            />
            <IconButton
              label={`Delete ${cur.name}`}
              icon={<Trash2 className="size-4" />}
              size={size}
              disabled={sheets.length <= 1}
              {...(sheets.length <= 1 ? { hint: 'A drawing needs at least one sheet' } : {})}
              onClick={() => sheets.length > 1 && setConfirm(cur.id)}
              data-testid="sheet-delete"
            />
          </div>
        )
      ) : null}
      {edit ? (
        <IconButton
          label="Add sheet"
          icon={<Plus className="size-4" />}
          size={size}
          onClick={edit.onAdd}
          data-testid="sheet-add"
        />
      ) : null}
    </nav>
  );
}
