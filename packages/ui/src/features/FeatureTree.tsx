import type { FeatureStatus, FeatureType, Id } from '@whittle/contracts';
import {
  Ban,
  CircleAlert,
  Ellipsis,
  Eye,
  EyeOff,
  GripVertical,
  ListTree,
  Pencil,
  PenLine,
  SkipBack,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { m } from 'motion/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type FloatingAnchor, Menu, type MenuItem } from '../components/floating';
import { cn, Tooltip } from '../components/primitives';
import { useLongPress } from '../logic/longPress';
import { useSpring } from '../motion';
import { EmptyState } from '../shells/shared';
import { featureMeta } from './featureMeta';

/** The slice of a document `Feature` the tree needs. */
export interface FeatureTreeItem {
  id: Id;
  type: FeatureType;
  name: string;
  suppressed: boolean;
}

/** `onMove` may refuse (e.g. a fillet cannot move above the solid it rounds). */
export type MoveResult = { ok: true } | { ok: false; reason: string };

export interface FeatureTreeProps {
  features: readonly FeatureTreeItem[];
  /** Latest regeneration status per feature (`RegenResult.features`). */
  statuses?: readonly FeatureStatus[];
  /** Features at index >= this are rolled back. Default `features.length`. */
  rollbackIndex?: number;
  selectedId?: Id | null;
  onSelect?(id: Id | null): void;
  onRename?(id: Id, name: string): void;
  onRollback?(index: number): void;
  /** Reorder. May return a promise; `{ ok: false }` triggers the gentle shake and shows `reason`. */
  onMove?(id: Id, toIndex: number): MoveResult | Promise<MoveResult> | undefined;
  onEdit?(id: Id): void;
  onSuppress?(id: Id, suppressed: boolean): void;
  onDelete?(id: Id): void;
  /** `touch` = 44px rows and always-visible handles. */
  density?: 'compact' | 'touch';
  className?: string;
}

const clampIdx = (n: number, max: number) => Math.max(0, Math.min(max, n));

function describeStatus(
  s: FeatureStatus | undefined,
): { tone: 'danger' | 'warning' | 'muted'; message: string; hint?: string } | null {
  if (!s) return null;
  if (s.state === 'error') {
    return {
      tone: 'danger',
      message: s.error?.message ?? 'This feature failed to rebuild.',
      hint: s.error?.hint,
    };
  }
  if (s.state === 'needsAttention') {
    const n = s.unresolved?.length ?? 0;
    return {
      tone: 'warning',
      message:
        n === 1 ? 'A reference needs re-picking.' : `${n || 'Some'} references need re-picking.`,
      hint: 'Select the feature and pick the highlighted references again.',
    };
  }
  if (s.state === 'blocked') {
    return {
      tone: 'muted',
      message: 'Waiting on an earlier feature.',
      hint: 'Fix the failing feature above first.',
    };
  }
  return null;
}

/**
 * Feature history (PLAN 2.2, 9.1): type icons, inline rename, failure badges with a one-line
 * explanation, a draggable rollback bar, drag-to-reorder with refusal feedback, context actions.
 *
 * Keyboard: Up/Down/Home/End move; Space selects; Enter/F2 renames; Alt+Up/Down reorders; Delete
 * deletes; Shift+F10 / Menu opens actions. The rollback bar is a separate focusable splitter.
 */
export function FeatureTree({
  features,
  statuses,
  rollbackIndex,
  selectedId = null,
  onSelect,
  onRename,
  onRollback,
  onMove,
  onEdit,
  onSuppress,
  onDelete,
  density = 'compact',
  className,
}: FeatureTreeProps) {
  const n = features.length;
  const rollback = clampIdx(rollbackIndex ?? n, n);
  const touch = density === 'touch';
  const statusById = new Map(statuses?.map((s) => [s.featureId, s]));

  const wrap = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<Id, HTMLDivElement>());
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [menu, setMenu] = useState<{ id: Id; anchor: FloatingAnchor } | null>(null);
  // Touch and pen: press and hold a row for its menu (mouse has right-click, keyboards the Menu key).
  const longPress = useLongPress<Id>((id, at) => {
    setFocusId(id);
    setMenu({ id, anchor: at });
  });
  const [shake, setShake] = useState<{ id: Id; key: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [barDrag, setBarDrag] = useState<number | null>(null);
  const [drag, setDrag] = useState<{
    id: Id;
    dy: number;
    from: number;
    to: number;
    at: number;
  } | null>(null);
  const rejectSpring = useSpring('reject');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const activeFocus = features.some((f) => f.id === focusId)
    ? focusId
    : (features.find((f) => f.id === selectedId)?.id ?? features[0]?.id ?? null);

  /* ----------------------------------------------------------- measuring the rollback bar */
  // biome-ignore lint/correctness/useExhaustiveDependencies: row heights depend on these inputs
  useLayoutEffect(() => {
    const measure = () => {
      const b: number[] = [];
      let last = 0;
      for (const f of features) {
        const el = rows.current.get(f.id);
        if (!el) continue;
        b.push(el.offsetTop);
        last = el.offsetTop + el.offsetHeight;
      }
      if (b.length) b.push(last);
      setBoundaries((prev) =>
        prev.length === b.length && prev.every((v, i) => v === b[i]) ? prev : b,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [features, statuses, renaming, density]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const focusRow = useCallback((id: Id) => {
    setFocusId(id);
    rows.current.get(id)?.focus();
  }, []);

  /* ----------------------------------------------------------- moves */
  function reject(id: Id, reason: string) {
    setShake((s) => ({ id, key: (s?.key ?? 0) + 1 }));
    setNotice(reason);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  }
  function requestMove(id: Id, toIndex: number) {
    if (!onMove || toIndex < 0 || toIndex >= n) return;
    Promise.resolve(onMove(id, toIndex)).then((r) => {
      if (r && !r.ok) reject(id, r.reason);
      else setNotice('');
    });
  }

  /* ----------------------------------------------------------- row drag (grip) */
  function gripDown(e: PointerEvent<HTMLElement>, id: Id, from: number) {
    if (!onMove || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, dy: 0, from, to: from, at: e.clientY });
    // dy tracks live; `at` is the pointer start.
  }
  function gripMove(e: PointerEvent<HTMLElement>) {
    if (!drag) return;
    const dy = e.clientY - drag.at;
    // Insertion slot among the *other* rows (the dragged row itself moves with the pointer).
    let q = 0;
    features.forEach((f, j) => {
      if (j === drag.from) return;
      const r = rows.current.get(f.id)?.getBoundingClientRect();
      if (r && r.top + r.height / 2 < e.clientY) q++;
    });
    setDrag({ ...drag, dy, to: clampIdx(q, n - 1) });
  }
  function gripUp() {
    if (!drag) return;
    const { id, from, to, dy } = drag;
    setDrag(null);
    if (Math.abs(dy) > 4 && to !== from) requestMove(id, to);
  }

  /* ----------------------------------------------------------- rollback bar */
  const rollbackFromY = (clientY: number) => {
    const top = wrap.current?.getBoundingClientRect().top ?? 0;
    const y = clientY - top;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    boundaries.forEach((b, i) => {
      const d = Math.abs(b - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { index: best, y };
  };
  function barDown(e: PointerEvent<HTMLElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setBarDrag(boundaries[rollback] ?? 0);
  }
  function barMove(e: PointerEvent<HTMLElement>) {
    if (barDrag === null) return;
    const { index, y } = rollbackFromY(e.clientY);
    const lo = boundaries[0] ?? 0;
    const hi = boundaries[n] ?? 0;
    setBarDrag(Math.max(lo, Math.min(hi, y)));
    if (index !== rollback) onRollback?.(index);
  }
  function barKey(e: KeyboardEvent<HTMLElement>) {
    let next = rollback;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = rollback - 1;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = rollback + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n;
    else if (e.key === 'PageUp') next = rollback - 5;
    else if (e.key === 'PageDown') next = rollback + 5;
    else return;
    e.preventDefault();
    next = clampIdx(next, n);
    if (next !== rollback) onRollback?.(next);
  }

  /* ----------------------------------------------------------- row keyboard */
  function rowKey(e: KeyboardEvent<HTMLDivElement>, id: Id, i: number) {
    if (e.target !== e.currentTarget) return;
    const go = (j: number) => {
      const f = features[clampIdx(j, n - 1)];
      if (f) focusRow(f.id);
    };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      requestMove(id, i + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(n - 1);
        break;
      case ' ':
        e.preventDefault();
        onSelect?.(selectedId === id ? null : id);
        break;
      case 'Enter':
      case 'F2':
        if (onRename) {
          e.preventDefault();
          setRenaming(id);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (onDelete) {
          e.preventDefault();
          const nextF = features[i + 1] ?? features[i - 1];
          onDelete(id);
          if (nextF) focusRow(nextF.id);
        }
        break;
      case 'ContextMenu':
        e.preventDefault();
        setMenu({ id, anchor: e.currentTarget });
        break;
      case 'F10':
        if (e.shiftKey) {
          e.preventDefault();
          setMenu({ id, anchor: e.currentTarget });
        }
        break;
    }
  }

  function menuItems(id: Id, i: number): MenuItem[] {
    const f = features[i];
    if (!f) return [];
    const items: MenuItem[] = [];
    if (onEdit)
      items.push({
        id: 'edit',
        label: 'Edit',
        icon: <PenLine className="size-4" />,
        onSelect: () => onEdit(id),
      });
    if (onRename)
      items.push({
        id: 'rename',
        label: 'Rename',
        shortcut: 'F2',
        icon: <Pencil className="size-4" />,
        onSelect: () => setRenaming(id),
      });
    if (onSuppress)
      items.push({
        id: 'suppress',
        label: f.suppressed ? 'Unsuppress' : 'Suppress',
        icon: f.suppressed ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
        onSelect: () => onSuppress(id, !f.suppressed),
      });
    if (onRollback)
      items.push({
        id: 'rollto',
        label: 'Roll to here',
        icon: <SkipBack className="size-4 rotate-180" />,
        onSelect: () => onRollback(i + 1),
      });
    if (onDelete)
      items.push({
        id: 'delete',
        label: 'Delete',
        shortcut: 'Del',
        danger: true,
        separatorBefore: true,
        icon: <Trash2 className="size-4" />,
        onSelect: () => onDelete(id),
      });
    return items;
  }

  if (n === 0) {
    return (
      <EmptyState icon={ListTree} title="No features yet" className={className}>
        <p>Start with a sketch on a plane.</p>
      </EmptyState>
    );
  }

  const barY = barDrag ?? boundaries[rollback];
  const rowH = touch ? 'min-h-11' : 'min-h-8';
  const menuFor = menu ? features.findIndex((f) => f.id === menu.id) : -1;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={wrap} className="relative px-2 py-1.5" data-testid="feature-tree">
        <div
          aria-label="Features"
          role="tree"
          aria-orientation="vertical"
          className="m-0 list-none p-0"
        >
          {features.map((f, i) => {
            const meta = featureMeta[f.type];
            const status = statusById.get(f.id);
            const st = describeStatus(status);
            const rolled = i >= rollback || status?.state === 'rolledBack';
            const suppressed = f.suppressed || status?.state === 'suppressed';
            const selected = selectedId === f.id;
            const dragging = drag?.id === f.id && Math.abs(drag.dy) > 4;
            const stateText = [
              suppressed ? 'suppressed' : '',
              rolled ? 'rolled back' : '',
              status?.state === 'error' ? 'error' : '',
              status?.state === 'needsAttention' ? 'needs attention' : '',
              status?.state === 'blocked' ? 'blocked' : '',
            ]
              .filter(Boolean)
              .join(', ');
            const hidden = [`${meta.label}${stateText ? `, ${stateText}` : ''}.`, st?.hint]
              .filter(Boolean)
              .join(' ');
            const isShaking = shake?.id === f.id;
            return (
              <div
                key={f.id}
                ref={(el) => {
                  if (el) rows.current.set(f.id, el);
                  else rows.current.delete(f.id);
                }}
                role="treeitem"
                aria-level={1}
                aria-posinset={i + 1}
                aria-setsize={n}
                aria-selected={selected}
                tabIndex={activeFocus === f.id ? 0 : -1}
                data-feature-id={f.id}
                data-state={status?.state ?? 'ok'}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusId(f.id);
                }}
                onClick={() => {
                  setFocusId(f.id);
                  onSelect?.(f.id);
                }}
                onKeyDown={(e) => rowKey(e, f.id, i)}
                {...longPress(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFocusId(f.id);
                  setMenu({ id: f.id, anchor: { x: e.clientX, y: e.clientY } });
                }}
                style={dragging ? { transform: `translateY(${drag?.dy}px)`, zIndex: 2 } : undefined}
                className={cn(
                  'group/row relative list-none outline-none',
                  dragging && 'opacity-90',
                )}
              >
                <m.div
                  key={isShaking ? shake?.key : 0}
                  initial={isShaking ? { x: 9 } : false}
                  animate={{ x: 0 }}
                  transition={rejectSpring}
                  className={cn(
                    'flex items-start gap-2 rounded-[9px] pr-1 pl-1 transition-colors duration-fast',
                    rowH,
                    'group-focus-visible/row:outline-2 group-focus-visible/row:outline-offset-[-2px] group-focus-visible/row:outline-accent',
                    selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                    dragging && 'bg-surface shadow-float',

                    isShaking && 'bg-danger-soft',
                  )}
                >
                  <span
                    aria-hidden
                    data-grip
                    data-no-longpress
                    onPointerDown={(e) => gripDown(e, f.id, i)}
                    onPointerMove={gripMove}
                    onPointerUp={gripUp}
                    onPointerCancel={() => setDrag(null)}
                    className={cn(
                      'mt-[7px] flex shrink-0 touch-none items-center text-fg-subtle',
                      onMove ? 'cursor-grab active:cursor-grabbing' : 'invisible',
                      touch ? 'mt-[11px] w-6' : 'w-4',
                      touch
                        ? ''
                        : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
                    )}
                  >
                    <GripVertical className="size-4" />
                  </span>
                  <span
                    className={cn(
                      'flex shrink-0 items-center justify-center',
                      touch ? 'mt-[11px]' : 'mt-[7px]',
                      st?.tone === 'danger'
                        ? 'text-danger'
                        : selected
                          ? 'text-accent-text'
                          : rolled
                            ? 'text-fg-subtle opacity-70'
                            : 'text-fg-muted',
                    )}
                  >
                    <meta.Icon className="size-[18px]" strokeWidth={1.6} aria-hidden />
                  </span>
                  <div className={cn('min-w-0 flex-1', touch ? 'py-[11px]' : 'py-[5px]')}>
                    {renaming === f.id ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: inline rename focuses its field by design
                        autoFocus
                        aria-label={`Rename ${f.name}`}
                        defaultValue={f.name}
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
                          const cancelled = e.currentTarget.dataset.cancel === '1';
                          setRenaming(null);
                          if (!cancelled && v && v !== f.name) onRename?.(f.id, v);
                          requestAnimationFrame(() => rows.current.get(f.id)?.focus());
                        }}
                        className="h-6 w-full min-w-0 rounded-[6px] bg-surface px-1.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none"
                      />
                    ) : (
                      // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename; keyboard uses Enter/F2 on the row
                      <span
                        onDoubleClick={(e) => {
                          if (!onRename) return;
                          e.stopPropagation();
                          setRenaming(f.id);
                        }}
                        className={cn(
                          'block truncate text-ui leading-[22px] font-medium',
                          rolled && !suppressed && 'text-fg-subtle',
                          suppressed && 'text-fg-muted line-through decoration-fg-subtle',
                          st?.tone === 'danger' && !suppressed && 'text-danger-text',
                        )}
                      >
                        {f.name}
                      </span>
                    )}
                    {st ? (
                      <Tooltip content={st.hint ?? st.message} side="bottom">
                        <span
                          data-testid="feature-message"
                          className={cn(
                            'mt-px flex items-start gap-1 text-2xs leading-4',
                            st.tone === 'danger' && 'text-danger-text',
                            st.tone === 'warning' && 'text-warning-text',
                            st.tone === 'muted' && 'text-fg-muted',
                          )}
                        >
                          {st.tone === 'danger' ? (
                            <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
                          ) : st.tone === 'warning' ? (
                            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
                          ) : (
                            <Ban className="mt-px size-3 shrink-0" aria-hidden />
                          )}
                          <span>{st.message}</span>
                        </span>
                      </Tooltip>
                    ) : null}
                    <span className="sr-only">{hidden}</span>
                  </div>
                  {suppressed ? (
                    <EyeOff
                      className={cn(
                        'shrink-0 text-fg-subtle',
                        touch ? 'mt-[13px] size-4' : 'mt-[8px] size-4',
                      )}
                      aria-hidden
                    />
                  ) : null}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    aria-label={`Actions for ${f.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusId(f.id);
                      setMenu({ id: f.id, anchor: e.currentTarget });
                    }}
                    className={cn(
                      'flex shrink-0 items-center justify-center rounded-[7px] text-fg-muted hover:bg-surface-3 hover:text-fg',
                      touch ? 'mt-0 size-11' : 'mt-0.5 size-7',
                      touch
                        ? ''
                        : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
                    )}
                  >
                    <Ellipsis className="size-4" aria-hidden />
                  </button>
                </m.div>
              </div>
            );
          })}
        </div>

        {drag && Math.abs(drag.dy) > 4 && drag.to !== drag.from ? (
          <div
            aria-hidden
            className="pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent"
            style={{
              top:
                ((drag.to < n - 1
                  ? boundaries[drag.to < drag.from ? drag.to : drag.to + 1]
                  : boundaries[drag.from === n - 1 ? n - 1 : n]) ?? 0) - 1,
            }}
          />
        ) : null}

        {onRollback && barY !== undefined ? (
          // biome-ignore lint/a11y/useSemanticElements: a focusable ARIA splitter, not an <hr>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Rollback bar"
            aria-valuemin={0}
            aria-valuemax={n}
            aria-valuenow={rollback}
            aria-valuetext={
              rollback >= n
                ? 'All features active'
                : rollback === 0
                  ? 'Rolled back before the first feature'
                  : `Rolled back after ${features[rollback - 1]?.name}`
            }
            tabIndex={0}
            onPointerDown={barDown}
            onPointerMove={barMove}
            onPointerUp={() => setBarDrag(null)}
            onPointerCancel={() => setBarDrag(null)}
            onKeyDown={barKey}
            data-testid="rollback-bar"
            className={cn(
              'group/bar absolute right-0 left-0 z-[3] flex cursor-row-resize touch-none items-center outline-none',
              touch ? 'h-6' : 'h-3.5',
              barDrag === null && 'transition-[top] duration-fast',
            )}
            style={{ top: barY - (touch ? 12 : 7) }}
          >
            <span
              aria-hidden
              className={cn(
                'pointer-events-none mx-2 flex-1 rounded-full transition-colors duration-fast',
                rollback < n
                  ? 'h-[3px] bg-warning'
                  : 'h-0.5 bg-accent/55 group-hover/bar:bg-accent',
                'group-focus-visible/bar:bg-accent group-focus-visible/bar:shadow-[0_0_0_3px_var(--color-accent-soft)]',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute left-0 h-3.5 w-1.5 rounded-full',
                rollback < n ? 'bg-warning' : 'bg-accent',
              )}
            />
          </div>
        ) : null}
      </div>

      <p
        role="status"
        aria-live="polite"
        data-testid="tree-notice"
        className={cn(
          'mx-3 mb-2 rounded-[8px] bg-danger-soft px-2.5 py-1.5 text-2xs leading-4 text-danger-text',
          !notice && 'sr-only',
        )}
      >
        {notice}
      </p>

      {menu && menuFor >= 0 ? (
        <Menu
          anchor={menu.anchor}
          label={`Actions for ${features[menuFor]?.name}`}
          items={menuItems(menu.id, menuFor)}
          size={touch ? 'touch' : 'md'}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
