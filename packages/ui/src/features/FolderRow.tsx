import { ChevronRight, Ellipsis, Folder, FolderOpen, GripVertical } from 'lucide-react';
import type { HTMLAttributes, PointerEvent, Ref } from 'react';
import { cn } from '../components/primitives';

export interface FolderRowProps {
  folderId: string;
  name: string;
  /** Members in the folder (all of them, also while open). */
  count: number;
  level: number;
  pos: number;
  size: number;
  open: boolean;
  touch: boolean;
  focusable: boolean;
  renaming: boolean;
  /** The rollback bar sits above the whole folder (greyed like rolled-back features). */
  rolled: boolean;
  /** Every member is suppressed. */
  suppressed: boolean;
  /** A feature drag would drop into this folder (indicator). */
  dropTarget: boolean;
  dragging: boolean;
  dy: number;
  /** Folder rows show a grip when the tree can move folders. */
  draggable: boolean;
  /** Extra description for screen readers (state, members). */
  description: string;
  rowRef: Ref<HTMLDivElement>;
  rootProps: HTMLAttributes<HTMLDivElement>;
  gripProps: {
    onPointerDown(e: PointerEvent<HTMLElement>): void;
    onPointerMove(e: PointerEvent<HTMLElement>): void;
    onPointerUp(e: PointerEvent<HTMLElement>): void;
    onPointerCancel(e: PointerEvent<HTMLElement>): void;
  };
  onToggle(): void;
  onMenu(anchor: HTMLElement): void;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
}

/**
 * A feature-tree folder header (M3.6): icon, name, member count while collapsed, collapse chevron,
 * inline rename (double-click or F2; Enter commits, Esc cancels). Collapse state is UI state held
 * by the tree, never document data.
 */
export function FolderRow(p: FolderRowProps) {
  const Icon = p.open ? FolderOpen : Folder;
  return (
    <div
      {...p.rootProps}
      ref={p.rowRef}
      role="treeitem"
      aria-level={p.level}
      aria-posinset={p.pos}
      aria-setsize={p.size}
      aria-expanded={p.open}
      aria-selected={false}
      data-folder-id={p.folderId}
      tabIndex={p.focusable ? 0 : -1}
      data-drop-target={p.dropTarget || undefined}
      className={cn(
        'group/row relative list-none outline-none',
        p.dragging && 'opacity-90',
        p.rootProps.className,
      )}
      style={p.dragging ? { transform: `translateY(${p.dy}px)`, zIndex: 2 } : undefined}
    >
      <div
        className={cn(
          'flex items-start gap-2 rounded-[9px] pr-1 pl-1 transition-colors duration-fast',
          p.touch ? 'min-h-11' : 'min-h-8',
          'group-focus-visible/row:outline-2 group-focus-visible/row:outline-offset-[-2px] group-focus-visible/row:outline-accent',
          p.dropTarget
            ? 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--color-accent)]'
            : 'bg-surface-2/60 hover:bg-surface-2',
          p.dragging && 'bg-surface shadow-float',
        )}
      >
        <span
          aria-hidden
          data-grip
          data-no-longpress
          {...p.gripProps}
          className={cn(
            'mt-[7px] flex shrink-0 touch-none items-center text-fg-subtle',
            p.draggable ? 'cursor-grab active:cursor-grabbing' : 'invisible',
            p.touch
              ? 'mt-[11px] w-6'
              : 'w-4 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
          )}
        >
          <GripVertical className="size-4" />
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-testid="folder-toggle"
          aria-label={`${p.open ? 'Collapse' : 'Expand'} ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle();
          }}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-surface-3 hover:text-fg',
            p.touch ? 'h-11 w-7' : 'mt-[7px] h-4 w-4',
          )}
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-fast', p.open && 'rotate-90')}
            aria-hidden
          />
        </button>
        <span
          className={cn(
            'flex shrink-0 items-center justify-center text-fg-muted',
            p.touch ? 'mt-[11px]' : 'mt-[7px]',
            p.rolled && 'text-fg-subtle opacity-70',
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
        </span>
        <div className={cn('min-w-0 flex-1', p.touch ? 'py-[11px]' : 'py-[5px]')}>
          {p.renaming ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: inline rename focuses its field by design
              autoFocus
              aria-label={`Rename folder ${p.name}`}
              defaultValue={p.name}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') {
                  e.currentTarget.dataset.cancel = '1';
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (e.currentTarget.dataset.cancel === '1') p.onCancelRename();
                else if (v && v !== p.name) p.onCommitRename(v);
                else p.onCancelRename();
              }}
              className="h-6 w-full min-w-0 rounded-[6px] bg-surface px-1.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none"
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename; keyboard uses Enter/F2 on the row
            <span
              onDoubleClick={(e) => {
                e.stopPropagation();
                p.onStartRename();
              }}
              className={cn(
                'block truncate text-ui leading-[22px] font-semibold',
                p.rolled && 'text-fg-subtle',
                p.suppressed && 'text-fg-muted line-through decoration-fg-subtle',
              )}
            >
              {p.name}
            </span>
          )}
          <span className="sr-only">{p.description}</span>
        </div>
        {!p.open ? (
          <span
            aria-hidden
            data-testid="folder-count"
            className={cn(
              'shrink-0 rounded-full bg-surface-3 px-1.5 text-2xs leading-4 font-medium whitespace-nowrap text-fg-muted',
              p.touch ? 'mt-[14px]' : 'mt-[8px]',
            )}
          >
            {p.count}
          </span>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          aria-label={`Actions for folder ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onMenu(e.currentTarget);
          }}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-[7px] text-fg-muted hover:bg-surface-3 hover:text-fg',
            p.touch
              ? 'size-11'
              : 'mt-0.5 size-7 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
          )}
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
