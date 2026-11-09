import type { FeatureStatus, FeatureType, Id } from '@wren-cad/contracts';
import {
  Ban,
  ChevronRight,
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
  useMemo,
  useRef,
  useState,
} from 'react';
import { type FloatingAnchor, Menu, type MenuItem } from '../components/floating';
import { cn, Tooltip } from '../components/primitives';
import { type AttentionSentence, attentionSentences } from '../inspector/attentionMessage';
import { CauseSentence } from '../inspector/CauseSentence';
import { useLongPress } from '../logic/longPress';
import { readStored, writeStored } from '../logic/persist';
import {
  allowedRollbacks,
  computeNesting,
  type MoveStep,
  planUnitMove,
  sharedCount,
  snapRollback,
} from '../logic/treeNesting';
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
  /**
   * Lineage of the selected feature (computed by the app from feature refs): its parents and
   * children are marked in the list (`data-lineage`) and announced ("built from the selected
   * feature's ..."). Selecting is unchanged; pair with `FeatureLineage` for the inline lists.
   */
  lineage?: { parents: readonly Id[]; children: readonly Id[] };
  onSelect?(id: Id | null): void;
  onRename?(id: Id, name: string): void;
  onRollback?(index: number): void;
  /** Reorder. May return a promise; `{ ok: false }` triggers the gentle shake and shows `reason`. */
  onMove?(id: Id, toIndex: number): MoveResult | Promise<MoveResult> | undefined;
  onEdit?(id: Id): void;
  onSuppress?(id: Id, suppressed: boolean): void;
  /**
   * Delete. `alsoIds` are the nested sketches the user chose to delete with it ("Delete sketch
   * too"); without it a nested sketch is kept and pops out to the top level.
   */
  onDelete?(id: Id, alsoIds?: readonly Id[]): void;
  /**
   * Moves a feature together with its nested sketches (several `moveFeature` steps). Apply them as
   * one undo step if you can, and refuse as a whole. Without it the steps go through `onMove`.
   */
  onReorder?(steps: readonly MoveStep[]): MoveResult | Promise<MoveResult> | undefined;
  /**
   * Nest a sketch under the one feature that uses it (ADR-015). Default true; `false` is the flat
   * serial history. The row menu offers "Show sketches in the history" when `onNestSketchesChange`
   * is given.
   */
  nestSketches?: boolean;
  onNestSketchesChange?(nest: boolean): void;
  /** `touch` = 44px rows and always-visible handles. */
  density?: 'compact' | 'touch';
  className?: string;
}

export const NEST_SKETCHES_KEY = 'whittle.nestSketches';

/** The persisted "nest sketches" view setting (per user, localStorage; default on). */
export function readNestSketches(): boolean {
  return readStored(NEST_SKETCHES_KEY) !== 'flat';
}
export function writeNestSketches(nest: boolean): void {
  writeStored(NEST_SKETCHES_KEY, nest ? 'nested' : 'flat');
}

interface VisibleRow {
  id: Id;
  /** Document index. */
  i: number;
  level: 1 | 2;
  /** Position among its siblings (1-based) and their count. */
  pos: number;
  size: number;
  parent?: Id;
}

const clampIdx = (n: number, max: number) => Math.max(0, Math.min(max, n));

interface StatusLine {
  tone: 'danger' | 'warning' | 'muted';
  message: string;
  hint?: string | undefined;
  /** "<feature> lost its edge because <cause> changed": the cause name is a button. */
  sentence?: AttentionSentence | undefined;
}

function describeStatus(
  s: FeatureStatus | undefined,
  name: string,
  nameOf: (id: Id) => string | undefined,
): StatusLine | null {
  if (!s) return null;
  const sentence =
    s.state === 'error' || s.state === 'needsAttention' || s.state === 'blocked'
      ? attentionSentences({
          feature: name,
          state: s.state,
          ...(s.unresolved ? { unresolved: s.unresolved } : {}),
          ...(s.cause ? { cause: s.cause } : {}),
          nameOf,
        })[0]
      : undefined;
  if (s.state === 'error') {
    return {
      tone: 'danger',
      message: sentence?.text ?? s.error?.message ?? 'This feature failed to rebuild.',
      hint: s.error?.hint,
      sentence,
    };
  }
  if (s.state === 'needsAttention') {
    const n = s.unresolved?.length ?? 0;
    return {
      tone: 'warning',
      message:
        sentence?.text ??
        (n === 1 ? 'A reference needs re-picking.' : `${n || 'Some'} references need re-picking.`),
      hint: 'Select the feature and pick the highlighted references again.',
      sentence,
    };
  }
  if (s.state === 'blocked') {
    return {
      tone: 'muted',
      message: sentence?.text ?? 'Waiting on an earlier feature.',
      hint: 'Fix the failing feature above first.',
      sentence,
    };
  }
  return null;
}

/**
 * Feature history (PLAN 2.2, 9.1): type icons, inline rename, failure badges with a one-line
 * explanation, a draggable rollback bar, drag-to-reorder with refusal feedback, context actions.
 *
 * Sketches that exactly one feature uses nest under it (ADR-015): collapsible, collapsed by
 * default, an ARIA tree with `aria-level` / `aria-expanded`. A shared sketch stays top-level with a
 * "used by N" badge. A feature moves with its sketches, and the rollback bar skips the gap between
 * them. This is a view only: the document keeps the flat serial order.
 *
 * Keyboard: Up/Down/Home/End move; Right/Left expand, collapse or step in and out of a nested
 * sketch; Space selects; Enter/F2 renames; Alt+Up/Down reorders; Delete deletes; Shift+F10 / Menu
 * opens actions. The rollback bar is a separate focusable splitter.
 */
export function FeatureTree({
  features,
  statuses,
  rollbackIndex,
  selectedId = null,
  lineage,
  onSelect,
  onRename,
  onRollback,
  onMove,
  onReorder,
  onEdit,
  onSuppress,
  onDelete,
  nestSketches = true,
  onNestSketchesChange,
  density = 'compact',
  className,
}: FeatureTreeProps) {
  const n = features.length;
  const rollback = clampIdx(rollbackIndex ?? n, n);
  const touch = density === 'touch';
  const statusById = new Map(statuses?.map((s) => [s.featureId, s]));
  const nameById = new Map(features.map((f) => [f.id, f.name]));
  const nameOf = (id: Id) => nameById.get(id);

  const wrap = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<Id, HTMLDivElement>());
  const [focusId, setFocusId] = useState<Id | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [menu, setMenu] = useState<{ id: Id; anchor: FloatingAnchor } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<Id>>(new Set());
  const [confirm, setConfirm] = useState<Id | null>(null);
  // Touch and pen: press and hold a row for its menu (mouse has right-click, keyboards the Menu key).
  const longPress = useLongPress<Id>((id, at) => {
    setFocusId(id);
    setMenu({ id, anchor: at });
  });
  const [shake, setShake] = useState<{ id: Id; key: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [geom, setGeom] = useState<{ top: number[]; bottom: number[]; stop: number[] }>({
    top: [],
    bottom: [],
    stop: [],
  });
  const [barDrag, setBarDrag] = useState<number | null>(null);
  const [drag, setDrag] = useState<{
    id: Id;
    dy: number;
    /** Positions among the top-level items. */
    from: number;
    to: number;
    at: number;
  } | null>(null);
  const rejectSpring = useSpring('reject');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ----------------------------------------------------------- nesting */
  const nesting = useMemo(
    () => (nestSketches ? computeNesting(features) : computeNesting([])),
    [features, nestSketches],
  );
  const indexOf = useMemo(() => new Map(features.map((f, i) => [f.id, i])), [features]);
  const allowed = useMemo(() => allowedRollbacks(features, nesting), [features, nesting]);
  const anyNested = nesting.parentOf.size > 0;

  // Selecting a nested sketch (from the viewport, or while sketching) shows it.
  useEffect(() => {
    const parent = selectedId ? nesting.parentOf.get(selectedId) : undefined;
    if (parent) setExpanded((e) => (e.has(parent) ? e : new Set(e).add(parent)));
  }, [selectedId, nesting]);

  const toggle = useCallback((id: Id, open?: boolean) => {
    setExpanded((e) => {
      const isOpen = e.has(id);
      if (open === isOpen) return e;
      const next = new Set(e);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Rows as shown: top-level items in document order, each followed by its open sketches. */
  const visible = useMemo<VisibleRow[]>(() => {
    const out: VisibleRow[] = [];
    const tops = features.filter((f) => !nesting.parentOf.has(f.id));
    tops.forEach((f, k) => {
      out.push({ id: f.id, i: indexOf.get(f.id) ?? 0, level: 1, pos: k + 1, size: tops.length });
      const kids = nesting.childrenOf.get(f.id) ?? [];
      if (expanded.has(f.id)) {
        kids.forEach((c, j) => {
          out.push({
            id: c,
            i: indexOf.get(c) ?? 0,
            level: 2,
            pos: j + 1,
            size: kids.length,
            parent: f.id,
          });
        });
      }
    });
    return out;
  }, [features, nesting, expanded, indexOf]);
  const units = useMemo(() => visible.filter((r) => r.level === 1), [visible]);

  const activeFocus = visible.some((r) => r.id === focusId)
    ? focusId
    : (visible.find((r) => r.id === selectedId)?.id ?? visible[0]?.id ?? null);

  /* ----------------------------------------------------------- measuring the rollback bar */
  // biome-ignore lint/correctness/useExhaustiveDependencies: row heights depend on these inputs
  useLayoutEffect(() => {
    const measure = () => {
      const top: number[] = [];
      const bottom: number[] = [];
      for (const u of units) {
        const el = rows.current.get(u.id);
        if (!el) continue;
        top.push(el.offsetTop);
        let last = el;
        for (const r of visible) {
          if (r.parent === u.id) last = rows.current.get(r.id) ?? last;
        }
        bottom.push(last.offsetTop + last.offsetHeight);
      }
      // y of each rollback position: above the first top-level item at or after it
      const stop: number[] = [];
      for (let r = 0; r <= n; r++) {
        const k = units.findIndex((u) => u.i >= r);
        stop.push(k >= 0 ? (top[k] ?? 0) : (bottom[bottom.length - 1] ?? 0));
      }
      setGeom((prev) =>
        prev.stop.length === stop.length &&
        prev.stop.every((v, i) => v === stop[i]) &&
        prev.top.length === top.length &&
        prev.top.every((v, i) => v === top[i]) &&
        prev.bottom.every((v, i) => v === bottom[i])
          ? prev
          : { top, bottom, stop },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [features, statuses, renaming, density, expanded, confirm, nestSketches]);

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
  /** Makes top-level item `id` the `to`th top-level item, taking its nested sketches along. */
  function requestMove(id: Id, to: number) {
    if (!onMove || to < 0 || to >= units.length) return;
    const steps = planUnitMove(features, nesting, id, to);
    if (steps.length === 0) return;
    const done = (r: MoveResult | undefined) => {
      if (r && !r.ok) reject(id, r.reason);
      else setNotice('');
    };
    const first = steps[0];
    if (steps.length === 1 && first) {
      Promise.resolve(onMove(first.id, first.toIndex)).then(done);
      return;
    }
    if (onReorder) {
      Promise.resolve(onReorder(steps)).then(done);
      return;
    }
    // No batch handler: one step at a time; on a refusal put the earlier steps back.
    void (async () => {
      const applied: MoveStep[] = [];
      for (const st of steps) {
        const r = await onMove(st.id, st.toIndex);
        if (r && !r.ok) {
          for (const back of applied.reverse()) await onMove(back.id, back.from);
          return done(r);
        }
        applied.push(st);
      }
      done(undefined);
    })();
  }

  /** Asks (inline) before deleting a feature that has nested sketches. */
  function requestDelete(id: Id): boolean {
    if (!onDelete) return false;
    if ((nesting.childrenOf.get(id)?.length ?? 0) > 0) {
      setConfirm(id);
      return true;
    }
    onDelete(id);
    return false;
  }
  function answerDelete(id: Id, alsoSketches: boolean) {
    const kids = nesting.childrenOf.get(id) ?? [];
    const at = visible.findIndex((r) => r.id === id);
    const next = visible[at + 1 + (expanded.has(id) ? kids.length : 0)] ?? visible[at - 1];
    setConfirm(null);
    if (alsoSketches) onDelete?.(id, kids);
    else onDelete?.(id);
    if (next && next.id !== id) focusRow(next.id);
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
    // Insertion slot among the *other* top-level items (the dragged one moves with the pointer).
    let q = 0;
    units.forEach((u, j) => {
      if (j === drag.from) return;
      const r = rows.current.get(u.id)?.getBoundingClientRect();
      if (r && r.top + Math.min(r.height, touch ? 44 : 32) / 2 < e.clientY) q++;
    });
    setDrag({ ...drag, dy, to: clampIdx(q, units.length - 1) });
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
    let best = allowed[0] ?? 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (const r of allowed) {
      const d = Math.abs((geom.stop[r] ?? 0) - y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return { index: best, y };
  };
  function barDown(e: PointerEvent<HTMLElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setBarDrag(geom.stop[rollback] ?? 0);
  }
  function barMove(e: PointerEvent<HTMLElement>) {
    if (barDrag === null) return;
    const { index, y } = rollbackFromY(e.clientY);
    const lo = geom.stop[0] ?? 0;
    const hi = geom.stop[n] ?? 0;
    setBarDrag(Math.max(lo, Math.min(hi, y)));
    if (index !== rollback) onRollback?.(index);
  }
  function barKey(e: KeyboardEvent<HTMLElement>) {
    let next = rollback;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = snapRollback(rollback - 1, allowed, -1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
      next = snapRollback(rollback + 1, allowed, 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n;
    else if (e.key === 'PageUp') next = snapRollback(rollback - 5, allowed, -1);
    else if (e.key === 'PageDown') next = snapRollback(rollback + 5, allowed, 1);
    else return;
    e.preventDefault();
    next = clampIdx(next, n);
    if (next !== rollback) onRollback?.(next);
  }

  /* ----------------------------------------------------------- row keyboard */
  function rowKey(e: KeyboardEvent<HTMLDivElement>, row: VisibleRow) {
    if (e.target !== e.currentTarget) return;
    const { id } = row;
    const v = visible.findIndex((r) => r.id === id);
    const go = (j: number) => {
      const r = visible[clampIdx(j, visible.length - 1)];
      if (r) focusRow(r.id);
    };
    const kids = nesting.childrenOf.get(id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (row.level === 1) requestMove(id, row.pos - 1 + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(v + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(v - 1);
        break;
      case 'ArrowRight':
        if (kids?.length) {
          e.preventDefault();
          if (!expanded.has(id)) toggle(id, true);
          else go(v + 1);
        }
        break;
      case 'ArrowLeft':
        if (row.parent) {
          e.preventDefault();
          focusRow(row.parent);
        } else if (kids?.length && expanded.has(id)) {
          e.preventDefault();
          toggle(id, false);
        }
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(visible.length - 1);
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
          const nextR = visible[v + 1] ?? visible[v - 1];
          if (!requestDelete(id) && nextR) focusRow(nextR.id);
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
        // A nested sketch rolls to after the feature it sits under.
        onSelect: () => onRollback(snapRollback(i + 1, allowed, 1)),
      });
    if (onDelete)
      items.push({
        id: 'delete',
        label: 'Delete',
        shortcut: 'Del',
        danger: true,
        separatorBefore: true,
        icon: <Trash2 className="size-4" />,
        onSelect: () => requestDelete(id),
      });
    if (onNestSketchesChange)
      items.push({
        id: 'flat-history',
        label: 'Show sketches in the history',
        checked: !nestSketches,
        separatorBefore: true,
        icon: <ListTree className="size-4" />,
        onSelect: () => onNestSketchesChange(!nestSketches),
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

  const barY = barDrag ?? geom.stop[rollback];
  const rowH = touch ? 'min-h-11' : 'min-h-8';
  const menuFor = menu ? features.findIndex((f) => f.id === menu.id) : -1;
  const chevronW = touch ? 'w-7' : 'w-4';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={wrap} className="relative px-2 py-1.5" data-testid="feature-tree">
        <div
          aria-label="Features"
          role="tree"
          aria-orientation="vertical"
          className="m-0 list-none p-0"
        >
          {visible.map((row) => {
            const f = features[row.i];
            if (!f) return null;
            const i = row.i;
            const nested = row.level === 2;
            const kids = nesting.childrenOf.get(f.id) ?? [];
            const open = kids.length > 0 && expanded.has(f.id);
            const shared = f.type === 'sketch' ? sharedCount(nesting, f.id) : 0;
            const meta = featureMeta[f.type];
            const status = statusById.get(f.id);
            const st = describeStatus(status, f.name, nameOf);
            const rolled = i >= rollback || status?.state === 'rolledBack';
            const suppressed = f.suppressed || status?.state === 'suppressed';
            const selected = selectedId === f.id;
            const dragging = !nested && drag?.id === f.id && Math.abs(drag.dy) > 4;
            const stateText = [
              suppressed ? 'suppressed' : '',
              rolled ? 'rolled back' : '',
              status?.state === 'error' ? 'error' : '',
              status?.state === 'needsAttention' ? 'needs attention' : '',
              status?.state === 'blocked' ? 'blocked' : '',
            ]
              .filter(Boolean)
              .join(', ');
            const hidden = [
              `${meta.label}${stateText ? `, ${stateText}` : ''}.`,
              kids.length
                ? `Contains ${kids.length === 1 ? 'a sketch' : `${kids.length} sketches`}.`
                : '',
              shared ? `Used by ${shared} features.` : '',
              lineage?.parents.includes(f.id) ? 'The selected feature is built from this one.' : '',
              lineage?.children.includes(f.id) ? 'Built from the selected feature.' : '',
              st?.hint,
            ]
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
                aria-level={row.level}
                aria-posinset={row.pos}
                aria-setsize={row.size}
                aria-selected={selected}
                aria-expanded={kids.length ? open : undefined}
                tabIndex={activeFocus === f.id ? 0 : -1}
                data-feature-id={f.id}
                data-state={status?.state ?? 'ok'}
                data-lineage={
                  lineage?.parents.includes(f.id)
                    ? 'parent'
                    : lineage?.children.includes(f.id)
                      ? 'child'
                      : undefined
                }
                data-nested={nested || undefined}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusId(f.id);
                }}
                onClick={() => {
                  setFocusId(f.id);
                  onSelect?.(f.id);
                }}
                onKeyDown={(e) => rowKey(e, row)}
                {...longPress(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFocusId(f.id);
                  setMenu({ id: f.id, anchor: { x: e.clientX, y: e.clientY } });
                }}
                style={dragging ? { transform: `translateY(${drag?.dy}px)`, zIndex: 2 } : undefined}
                className={cn(
                  'group/row relative list-none outline-none',
                  'data-[lineage=child]:shadow-[inset_3px_0_0_var(--color-warning)] data-[lineage=parent]:shadow-[inset_3px_0_0_var(--color-accent)]',
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
                    nested && (touch ? 'ml-9' : 'ml-6'),
                    'group-focus-visible/row:outline-2 group-focus-visible/row:outline-offset-[-2px] group-focus-visible/row:outline-accent',
                    selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                    dragging && 'bg-surface shadow-float',

                    isShaking && 'bg-danger-soft',
                  )}
                >
                  {nested ? null : (
                    <span
                      aria-hidden
                      data-grip
                      data-no-longpress
                      onPointerDown={(e) => gripDown(e, f.id, row.pos - 1)}
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
                  )}
                  {nested || !anyNested ? null : kids.length ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      data-testid="nest-toggle"
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${f.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(f.id);
                      }}
                      className={cn(
                        'flex shrink-0 items-center justify-center rounded-[6px] text-fg-muted hover:bg-surface-3 hover:text-fg',
                        chevronW,
                        touch ? 'h-11' : 'mt-[7px] h-4',
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          'size-3.5 transition-transform duration-fast',
                          open && 'rotate-90',
                        )}
                        aria-hidden
                      />
                    </button>
                  ) : (
                    <span aria-hidden className={cn('shrink-0', chevronW)} />
                  )}
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
                          <span>
                            {st.sentence ? (
                              <CauseSentence
                                sentence={st.sentence}
                                inTree
                                {...(onSelect ? { onSelectFeature: onSelect } : {})}
                              />
                            ) : (
                              st.message
                            )}
                          </span>
                        </span>
                      </Tooltip>
                    ) : null}
                    <span className="sr-only">{hidden}</span>
                  </div>
                  {shared ? (
                    <span
                      aria-hidden
                      data-testid="used-by"
                      className={cn(
                        'shrink-0 rounded-full bg-surface-3 px-1.5 text-2xs leading-4 font-medium whitespace-nowrap text-fg-muted',
                        touch ? 'mt-[14px]' : 'mt-[8px]',
                      )}
                    >
                      used by {shared}
                    </span>
                  ) : null}
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
                {confirm === f.id ? (
                  <DeletePrompt
                    name={f.name}
                    sketches={kids.length}
                    touch={touch}
                    onAnswer={(also) => answerDelete(f.id, also)}
                    onCancel={() => {
                      setConfirm(null);
                      requestAnimationFrame(() => rows.current.get(f.id)?.focus());
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {drag && Math.abs(drag.dy) > 4 && drag.to !== drag.from ? (
          <div
            aria-hidden
            className="pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent"
            style={{
              top: ((drag.to < drag.from ? geom.top[drag.to] : geom.bottom[drag.to]) ?? 0) - 1,
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

/**
 * The inline, non-modal question under a feature row when it has nested sketches. Escape cancels;
 * the first button is focused so a keyboard user can answer straight away.
 */
function DeletePrompt({
  name,
  sketches,
  touch,
  onAnswer,
  onCancel,
}: {
  name: string;
  sketches: number;
  touch: boolean;
  onAnswer(alsoSketches: boolean): void;
  onCancel(): void;
}) {
  const plural = sketches > 1;
  const btn = cn(
    'rounded-control px-2.5 text-2xs font-medium whitespace-nowrap select-none transition-colors duration-fast',
    touch ? 'h-11' : 'h-7',
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of buttons, not a fieldset
    <div
      role="group"
      aria-label={`Delete ${name}?`}
      data-testid="delete-prompt"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mt-0.5 mb-1 ml-7 flex flex-wrap items-center gap-1.5 rounded-[9px] border border-border bg-surface-2 p-2"
    >
      <p className="w-full text-2xs leading-4 text-fg">
        {plural ? `“${name}” has ${sketches} sketches.` : `“${name}” has a sketch.`} Delete it too?
      </p>
      <button
        type="button"
        // biome-ignore lint/a11y/noAutofocus: the prompt appears on the user's own delete action
        autoFocus
        onClick={() => onAnswer(true)}
        className={cn(btn, 'bg-danger-soft text-danger-text hover:brightness-95')}
      >
        {plural ? 'Delete sketches too' : 'Delete sketch too'}
      </button>
      <button
        type="button"
        onClick={() => onAnswer(false)}
        className={cn(btn, 'bg-surface-3 text-fg hover:bg-border')}
      >
        {plural ? 'Keep sketches' : 'Keep sketch'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={cn(btn, 'text-fg-muted hover:bg-surface-3 hover:text-fg')}
      >
        Cancel
      </button>
    </div>
  );
}
