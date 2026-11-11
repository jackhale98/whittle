import type { FeatureStatus, FeatureType, Id } from '@wren-cad/contracts';
import { ListTree } from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type FloatingAnchor, Menu } from '../components/floating';
import { cn } from '../components/primitives';
import { useLongPress } from '../logic/longPress';
import {
  applySteps,
  type BlockStep,
  canFolder,
  effectiveSketchShown,
  folderOf,
  folderRange,
  isReferenceType,
  membershipAfterMove,
  planBlockMove,
  planFolderMove,
  runWithNested,
  type SketchVisibilityMode,
  type TreeFolder,
} from '../logic/treeFolders';
import {
  allowedRollbacks,
  computeNesting,
  type MoveStep,
  sharedCount,
  snapRollback,
} from '../logic/treeNesting';
import { buildRows, folderKey, gapBefore, type TreeRow } from '../logic/treeRows';
import { useSpring } from '../motion';
import { EmptyState } from '../shells/shared';
import { FeatureRowBody } from './FeatureRowBody';
import { FolderRow } from './FolderRow';
import { featureMeta } from './featureMeta';
import { describeStatus } from './featureStatus';
import type { FeatureTreeConfiguration } from './suppressMenu';
import { DropIndicator, RollbackBar } from './TreeMarkers';
import { DeletePrompt, LeavePrompt, UndoLine } from './TreePrompts';
import type { DragState, Slot } from './treeDrag';
import { folderMenuItems, type MenuCtx, menuItems } from './treeMenus';

/** The slice of a document `Feature` the tree needs. */
export interface FeatureTreeItem {
  id: Id;
  type: FeatureType;
  name: string;
  suppressed: boolean;
  /**
   * Sketches and reference geometry (plane, axis, point; ADR-093): the document's `visibility`
   * (absent = `'auto'`: sketches follow the consumed rule, reference geometry is shown).
   */
  visibility?: SketchVisibilityMode;
  /**
   * Sketches and reference geometry: whether the viewport shows it. Pass it when the app resolves visibility itself
   * (ADR-060: it also counts a revolve axis as consumed). Otherwise the tree computes it from
   * `visibility` and the features that use the sketch.
   */
  shown?: boolean;
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
  /**
   * Several features selected (Ctrl/Cmd-click toggles, Shift-click selects a range, or "Add to
   * selection" in the row menu). Controlled when given; otherwise the tree keeps it. A plain click
   * resets it to the one clicked row.
   */
  selectedIds?: readonly Id[];
  onSelectedIdsChange?(ids: readonly Id[]): void;
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

  /* ---- M3.6 folders (ADR-066) ---- */
  /** The part's folders (`Part.folders`). Each is a contiguous run of `features`. */
  folders?: readonly TreeFolder[];
  /**
   * Folders that are collapsed. UI state, never document data: controlled when given (the app may
   * persist it per user), otherwise the tree keeps it and every folder starts open.
   */
  collapsedFolders?: readonly Id[];
  onCollapsedFoldersChange?(ids: readonly Id[]): void;
  /**
   * "Add to new folder" on the features (a contiguous run, nested sketches included, in history
   * order). The app creates the folder (`addFolder`); once it shows up in `folders` the tree opens
   * its name for inline editing.
   */
  onAddFolder?(featureIds: readonly Id[]): void;
  onRenameFolder?(folderId: Id, name: string): void;
  /** Ungroup: the folder goes, its features stay. */
  onRemoveFolder?(folderId: Id): void;
  /** Drag a folder. `toIndex` is the `moveFolder` value: its first member's position with the run taken out. */
  onMoveFolder?(folderId: Id, toIndex: number): MoveResult | Promise<MoveResult> | undefined;
  /** Folder "Suppress all" / "Unsuppress all": one undo step (`setSuppressedMany`). */
  onSuppressMany?(ids: readonly Id[], suppressed: boolean): void;
  /** Reverses the last change; offered as "Undo" after a drop changed a folder's members. */
  onUndo?(): void;

  /* ---- M3.6 sketch visibility ---- */
  /**
   * Sets viewport visibility of sketches (`setSketchVisibility`): the eye, a folder's
   * "Show / Hide sketches" and the tree-level commands all come through here. Without it no eye
   * is drawn.
   */
  onSketchVisibility?(ids: readonly Id[], visibility: SketchVisibilityMode): void;

  /**
   * M3.7: configuration awareness. When the part has configurations, the row menu offers "Suppress
   * in this configuration only" / "Suppress in all configurations" (one item naming the
   * configuration in `review` mode) instead of a plain Suppress, and a row whose suppression the
   * active configuration overrides carries a marker. See `FeatureTreeConfiguration`.
   */
  configuration?: FeatureTreeConfiguration;
  /** `touch` = 44px rows and always-visible handles. */
  density?: 'compact' | 'touch';
  /**
   * `review` (phones): the tree only reviews history. The row menu offers Suppress / Unsuppress,
   * Show / Hide for sketches and Roll to here; folders only collapse; no delete, edit, rename,
   * folders, reordering or nesting toggle. The rollback bar stays draggable. Default `full`.
   */
  actions?: 'full' | 'review';
  className?: string;
}

const clampIdx = (n: number, max: number) => Math.max(0, Math.min(max, n));
const NO_FOLDERS: readonly TreeFolder[] = [];
/** The touch rollback bar's in-flow gap: its 44 px target. */
const BAR_GAP_PX = 44;

/**
 * Feature history (PLAN 2.2, 9.1): type icons, inline rename, failure badges with a one-line
 * explanation, a draggable rollback bar, drag-to-reorder with refusal feedback, context actions.
 *
 * Sketches that exactly one feature uses nest under it (ADR-015): collapsible, collapsed by
 * default, an ARIA tree with `aria-level` / `aria-expanded`. A shared sketch stays top-level with a
 * "used by N" badge. A feature moves with its sketches, and the rollback bar skips the gap between
 * them. This is a view only: the document keeps the flat serial order.
 *
 * Folders (M3.6, ADR-066) group a contiguous run of features. Dragging the folder row moves the
 * run, dragging a member out takes it out (after an inline "Take X out of Y?"), dropping a feature
 * strictly between two members adds it. The rollback bar can sit inside an open folder; a collapsed
 * folder is skipped over as a unit. Every sketch row has an eye (see `SketchEye`).
 *
 * Keyboard: Up/Down/Home/End move; Right/Left expand, collapse or step in and out of a nested
 * sketch or folder; Space selects (Ctrl+Space adds to the selection); Enter/F2 renames; Alt+Up/Down
 * reorders; Delete deletes; Shift+F10 / Menu opens actions. The rollback bar is a separate
 * focusable splitter.
 */
export function FeatureTree({
  features,
  statuses,
  rollbackIndex,
  selectedId = null,
  selectedIds,
  onSelectedIdsChange,
  lineage,
  onSelect,
  onRename: onRenameProp,
  onRollback,
  onMove: onMoveProp,
  onReorder: onReorderProp,
  onEdit: onEditProp,
  onSuppress,
  configuration,
  onDelete: onDeleteProp,
  nestSketches = true,
  onNestSketchesChange: onNestSketchesChangeProp,
  folders = NO_FOLDERS,
  collapsedFolders,
  onCollapsedFoldersChange,
  onAddFolder: onAddFolderProp,
  onRenameFolder: onRenameFolderProp,
  onRemoveFolder: onRemoveFolderProp,
  onMoveFolder: onMoveFolderProp,
  onSuppressMany: onSuppressManyProp,
  onUndo,
  onSketchVisibility,
  density = 'compact',
  actions = 'full',
  className,
}: FeatureTreeProps) {
  // Review-only (phones): history review without editing. Only suppress, the sketch eye, rolling
  // back and folder collapse remain, so every editing handler is dropped here, once.
  const review = actions === 'review';
  const [onRename, onMove, onReorder, onEdit, onDelete, onNestSketchesChange] = review
    ? [undefined, undefined, undefined, undefined, undefined, undefined]
    : [onRenameProp, onMoveProp, onReorderProp, onEditProp, onDeleteProp, onNestSketchesChangeProp];
  const [onAddFolder, onRenameFolder, onRemoveFolder, onMoveFolder, onSuppressMany] = review
    ? [undefined, undefined, undefined, undefined, undefined]
    : [
        onAddFolderProp,
        onRenameFolderProp,
        onRemoveFolderProp,
        onMoveFolderProp,
        onSuppressManyProp,
      ];
  const n = features.length;
  const rollback = clampIdx(rollbackIndex ?? n, n);
  const touch = density === 'touch';
  const statusById = new Map(statuses?.map((s) => [s.featureId, s]));
  const nameById = new Map(features.map((f) => [f.id, f.name]));
  const nameOf = (id: Id) => nameById.get(id);

  const wrap = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: FloatingAnchor } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<Id>>(new Set());
  const [confirm, setConfirm] = useState<Id | null>(null);
  const [multi, setMulti] = useState<readonly Id[]>([]);
  const [anchorId, setAnchorId] = useState<Id | null>(null);
  const [localCollapsed, setLocalCollapsed] = useState<readonly Id[]>([]);
  const [leave, setLeave] = useState<{
    id: Id;
    folderId: Id;
    joinsId?: Id;
    steps: BlockStep[];
  } | null>(null);
  const [info, setInfo] = useState('');
  const [awaitFolder, setAwaitFolder] = useState<Id | null>(null);
  const [dropSay, setDropSay] = useState('');
  // Touch and pen: press and hold a row for its menu (mouse has right-click, keyboards the Menu key).
  const longPress = useLongPress<string>((key, at) => {
    setFocusKey(key);
    setMenu({ key, anchor: at });
  });
  const [shake, setShake] = useState<{ key: string; n: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [geom, setGeom] = useState<{ stop: number[] }>({ stop: [] });
  const [barDrag, setBarDrag] = useState<number | null>(null);
  const gapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rejectSpring = useSpring('reject');
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ----------------------------------------------------------- nesting, folders, selection */
  const nesting = useMemo(
    () => (nestSketches ? computeNesting(features) : computeNesting([])),
    [features, nestSketches],
  );
  const consumers = useMemo(() => computeNesting(features).consumers, [features]);
  const indexOf = useMemo(() => new Map(features.map((f, i) => [f.id, i])), [features]);
  const allowed = useMemo(() => allowedRollbacks(features, nesting), [features, nesting]);
  const anyNested = nesting.parentOf.size > 0;

  const collapsedIds = collapsedFolders ?? localCollapsed;
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const setCollapsed = useCallback(
    (id: Id, closed: boolean) => {
      const has = collapsedIds.includes(id);
      if (has === closed) return;
      const next = closed ? [...collapsedIds, id] : collapsedIds.filter((x) => x !== id);
      setLocalCollapsed(next);
      onCollapsedFoldersChange?.(next);
    },
    [collapsedIds, onCollapsedFoldersChange],
  );
  const ranges = useMemo(
    () =>
      folders.flatMap((f) => {
        const r = folderRange(features, f);
        return r ? [{ folder: f, ...r }] : [];
      }),
    [features, folders],
  );
  // Rollback stops that sit inside a folder that is closed are skipped (it steps as one unit).
  const stops = useMemo(
    () =>
      allowed.filter(
        (r) => !ranges.some((g) => collapsed.has(g.folder.id) && r > g.start && r <= g.end),
      ),
    [allowed, ranges, collapsed],
  );

  const picked = selectedIds ?? multi;
  const effective = useMemo<readonly Id[]>(
    () => (picked.length ? picked : selectedId ? [selectedId] : []),
    [picked, selectedId],
  );
  const setPicked = useCallback(
    (ids: readonly Id[]) => {
      setMulti(ids);
      onSelectedIdsChange?.(ids);
    },
    [onSelectedIdsChange],
  );
  // The app moved the selection elsewhere (viewport pick): the extra picks no longer apply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the primary selection resets
  useEffect(() => {
    if (multi.length && selectedId && !multi.includes(selectedId)) setPicked([]);
  }, [selectedId]);

  // Selecting a nested sketch (from the viewport, or while sketching) shows it; so does a
  // selection inside a closed folder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per selection change
  useEffect(() => {
    const parent = selectedId ? nesting.parentOf.get(selectedId) : undefined;
    if (parent) setExpanded((e) => (e.has(parent) ? e : new Set(e).add(parent)));
    const f = selectedId ? folderOf(folders, selectedId) : undefined;
    if (f && collapsed.has(f.id)) setCollapsed(f.id, false);
  }, [selectedId, nesting]);

  // A rollback position inside a folder opens it, so the bar is visible where it sits.
  const lastRollback = useRef(rollback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the position only; a later manual collapse must stick
  useEffect(() => {
    if (lastRollback.current === rollback) return;
    lastRollback.current = rollback;
    for (const g of ranges) {
      if (rollback > g.start && rollback <= g.end && collapsed.has(g.folder.id)) {
        setCollapsed(g.folder.id, false);
      }
    }
  }, [rollback]);

  // "Add to new folder": the folder arrives through `folders`; then its name opens for editing.
  useEffect(() => {
    if (!awaitFolder) return;
    const f = folders.find((x) => x.features[0] === awaitFolder);
    if (f) {
      setAwaitFolder(null);
      setRenaming(folderKey(f.id));
      setFocusKey(folderKey(f.id));
    }
  }, [awaitFolder, folders]);

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

  /** Rows as shown (see `buildRows`). */
  const visible = useMemo<TreeRow[]>(
    () => buildRows({ features, nesting, folders, expanded, collapsed }),
    [features, nesting, folders, expanded, collapsed],
  );
  const rowByKey = useMemo(() => new Map(visible.map((r) => [r.key, r])), [visible]);

  const activeFocus = visible.some((r) => r.key === focusKey)
    ? focusKey
    : (visible.find((r) => r.key === selectedId)?.key ?? visible[0]?.key ?? null);

  /* ----------------------------------------------------------- measuring the rollback bar */
  // biome-ignore lint/correctness/useExhaustiveDependencies: row heights depend on these inputs
  useLayoutEffect(() => {
    const measure = () => {
      const heads = visible.filter((r) => !r.nestedSketch);
      // The touch bar's gap is in the flow: stops are the layout without it, so they do not move
      // while the bar (and its gap) is dragged from one position to the next.
      const gapEl = gapRef.current;
      const gapTop = gapEl ? gapEl.offsetTop : Number.POSITIVE_INFINITY;
      const gapH = gapEl ? gapEl.offsetHeight : 0;
      const nat = (y: number) => (y >= gapTop + gapH - 0.5 ? y - gapH : y);
      const tops = heads.map((h) => nat(rows.current.get(h.key)?.offsetTop ?? 0));
      const lastEl = rows.current.get(visible[visible.length - 1]?.key ?? '');
      const bottom = lastEl ? nat(lastEl.offsetTop) + lastEl.offsetHeight : 0;
      // y of each rollback position: above the first head row at or after it
      const stop: number[] = [];
      for (let r = 0; r <= n; r++) {
        const k = heads.findIndex((h) => h.i >= r);
        stop.push(k >= 0 ? (tops[k] ?? 0) : bottom);
      }
      setGeom((prev) =>
        prev.stop.length === stop.length && prev.stop.every((v, i) => v === stop[i])
          ? prev
          : { stop },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [
    features,
    statuses,
    renaming,
    density,
    expanded,
    confirm,
    nestSketches,
    collapsed,
    folders,
    leave,
    info,
    rollback,
  ]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const focusRow = useCallback((key: string) => {
    setFocusKey(key);
    rows.current.get(key)?.focus();
  }, []);
  const refocus = (key: string) => requestAnimationFrame(() => rows.current.get(key)?.focus());

  /* ----------------------------------------------------------- moves */
  function reject(key: string, reason: string) {
    setShake((s) => ({ key, n: (s?.n ?? 0) + 1 }));
    setNotice(reason);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  }

  /** Runs the `moveFeature` steps of one block move through `onReorder` / `onMove`. */
  function runSteps(key: string, steps: readonly MoveStep[], after?: () => void) {
    if (!onMove || steps.length === 0) return;
    const done = (r: MoveResult | undefined) => {
      if (r && !r.ok) reject(key, r.reason);
      else {
        setNotice('');
        after?.();
      }
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

  /** The block a feature row moves as: its nested sketches, then itself. */
  const blockOf = (id: Id): Id[] => [...(nesting.childrenOf.get(id) ?? []), id];

  /** Every place `row` could be dropped, in display order (no geometry yet: `y` is 0). */
  function computeSlots(row: TreeRow): Slot[] {
    const ids = features.map((f) => f.id);
    const seen = new Set<number>();
    const cands: Array<{ g: number; before: string | null }> = [];
    for (const h of visible) {
      if (h.nestedSketch) continue;
      const g = gapBefore(h, features, nesting);
      if (seen.has(g)) continue; // an open folder's first member shares its header's gap
      seen.add(g);
      cands.push({ g, before: h.key });
    }
    if (!seen.has(n)) cands.push({ g: n, before: null });
    const out: Slot[] = [];
    for (const { g, before } of cands) {
      if (row.kind === 'folder') {
        const plan = planFolderMove(features, folders, row.id, g);
        if (plan.ok === true) out.push({ g, before, kind: 'top', toIndex: plan.toIndex, y: 0 });
        continue;
      }
      const block = blockOf(row.id);
      const ref = features[g]?.id;
      if (ref !== undefined && block.includes(ref)) continue;
      const steps = planBlockMove(ids, block, ref);
      if (steps.length === 0) continue;
      const mem = membershipAfterMove(applySteps(ids, steps), folders, block);
      const own = folderOf(folders, row.id);
      if (mem.leaves)
        out.push({
          g,
          before,
          kind: 'out',
          folderId: mem.leaves,
          ...(mem.joins ? { joinsId: mem.joins } : {}),
          steps,
          y: 0,
        });
      else if (mem.joins) out.push({ g, before, kind: 'into', folderId: mem.joins, steps, y: 0 });
      else if (own) out.push({ g, before, kind: 'stay', folderId: own.id, steps, y: 0 });
      else out.push({ g, before, kind: 'top', steps, y: 0 });
    }
    return out;
  }

  const folderName = (id: Id | undefined) => folders.find((f) => f.id === id)?.name ?? 'the folder';

  /** Carries out a chosen drop (pointer or keyboard). */
  function commitSlot(row: TreeRow, slot: Slot) {
    if (row.kind === 'folder') {
      if (!onMoveFolder || slot.toIndex === undefined) return;
      Promise.resolve(onMoveFolder(row.id, slot.toIndex)).then((r) => {
        if (r && !r.ok) reject(row.key, r.reason);
        else setNotice('');
      });
      return;
    }
    const steps = slot.steps ?? [];
    const name = nameOf(row.id) ?? 'The feature';
    if (slot.kind === 'out' && slot.folderId) {
      setLeave({
        id: row.id,
        folderId: slot.folderId,
        ...(slot.joinsId ? { joinsId: slot.joinsId } : {}),
        steps,
      });
      return;
    }
    runSteps(
      row.key,
      steps,
      slot.kind === 'into'
        ? () => setInfo(`Added ${name} to ${folderName(slot.folderId)}.`)
        : undefined,
    );
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
    const at = visible.findIndex((r) => r.key === id);
    const next = visible[at + 1 + (expanded.has(id) ? kids.length : 0)] ?? visible[at - 1];
    setConfirm(null);
    if (alsoSketches) onDelete?.(id, kids);
    else onDelete?.(id);
    if (next && next.key !== id) focusRow(next.key);
  }

  /* ----------------------------------------------------------- row drag (grip) */
  const canDrag = (row: TreeRow) => (row.kind === 'folder' ? !!onMoveFolder : !!onMove);
  function gripDown(e: PointerEvent<HTMLElement>, row: TreeRow) {
    if (!canDrag(row) || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const slots = computeSlots(row).map((s) => {
      const el = s.before ? rows.current.get(s.before) : undefined;
      const last = rows.current.get(visible[visible.length - 1]?.key ?? '');
      const y = el ? el.offsetTop - 1 : last ? last.offsetTop + last.offsetHeight : 0;
      return { ...s, y };
    });
    setDrag({ kind: row.kind, key: row.key, id: row.id, dy: 0, at: e.clientY, slots, slot: null });
  }
  function gripMove(e: PointerEvent<HTMLElement>) {
    if (!drag) return;
    const dy = e.clientY - drag.at;
    if (Math.abs(dy) <= 4) {
      setDrag({ ...drag, dy, slot: null });
      return;
    }
    const rel = e.clientY - (wrap.current?.getBoundingClientRect().top ?? 0);
    let best: number | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    drag.slots.forEach((s, k) => {
      const d = Math.abs(s.y - rel);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    setDrag({ ...drag, dy, slot: best });
    const s = best === null ? undefined : drag.slots[best];
    const name = drag.kind === 'folder' ? folderName(drag.id) : (nameOf(drag.id) ?? '');
    setDropSay(
      !s
        ? ''
        : s.kind === 'into'
          ? `Drop to add ${name} to ${folderName(s.folderId)}.`
          : s.kind === 'out'
            ? `Drop to take ${name} out of ${folderName(s.folderId)}.`
            : `Drop to move ${name} here.`,
    );
  }
  function gripUp() {
    if (!drag) return;
    const { key, dy, slot, slots } = drag;
    setDrag(null);
    setDropSay('');
    const row = rowByKey.get(key);
    const chosen = slot === null ? undefined : slots[slot];
    if (row && chosen && Math.abs(dy) > 4) commitSlot(row, chosen);
  }

  /** Alt+Up / Alt+Down: the nearest drop place above or below. */
  function keyboardMove(row: TreeRow, dir: -1 | 1) {
    if (!canDrag(row)) return;
    const v = visible.findIndex((r) => r.key === row.key);
    let end = v;
    while ((visible[end + 1]?.level ?? 0) > row.level) end++;
    const at = (s: Slot) =>
      s.before === null ? visible.length : visible.findIndex((r) => r.key === s.before);
    const slots = computeSlots(row);
    const pick =
      dir < 0
        ? slots.filter((s) => at(s) < v).sort((a, b) => at(b) - at(a))[0]
        : slots.filter((s) => at(s) > end).sort((a, b) => at(a) - at(b))[0];
    if (pick) commitSlot(row, pick);
  }

  /* ----------------------------------------------------------- rollback bar */
  // Touch: the 44 px bar gets its own row-height gap in the list flow, right where it sits, so it
  // never overlaps the rows above and below it (a tap on a row's centre selects that row).
  const barGapKey =
    touch && onRollback
      ? (visible.find((r) => !r.nestedSketch && r.i >= rollback)?.key ?? null)
      : null;
  const barOffset = touch && onRollback ? BAR_GAP_PX / 2 : 0;
  const barGap =
    touch && onRollback ? (
      <div ref={gapRef} aria-hidden data-testid="rollback-gap" style={{ height: BAR_GAP_PX }} />
    ) : null;
  const rollbackFromY = (clientY: number) => {
    const top = wrap.current?.getBoundingClientRect().top ?? 0;
    const y = clientY - top;
    // Back to the layout without the bar's own gap, which sits at the current position.
    const g = barGap ? BAR_GAP_PX : 0;
    const at = geom.stop[rollback] ?? 0;
    const yn = y < at ? y : y <= at + g ? at : y - g;
    let best = stops[0] ?? 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (const r of stops) {
      const d = Math.abs((geom.stop[r] ?? 0) - yn);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return { index: best, y };
  };
  function barDown(e: PointerEvent<HTMLElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setBarDrag((geom.stop[rollback] ?? 0) + barOffset);
  }
  function barMove(e: PointerEvent<HTMLElement>) {
    if (barDrag === null) return;
    const { index, y } = rollbackFromY(e.clientY);
    const lo = (geom.stop[0] ?? 0) + barOffset;
    const hi = (geom.stop[n] ?? 0) + (barGap ? BAR_GAP_PX : 0);
    setBarDrag(Math.max(lo, Math.min(hi, y)));
    if (index !== rollback) onRollback?.(index);
  }
  function barKey(e: KeyboardEvent<HTMLElement>) {
    let next = rollback;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = snapRollback(rollback - 1, stops, -1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
      next = snapRollback(rollback + 1, stops, 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n;
    else if (e.key === 'PageUp') next = snapRollback(rollback - 5, stops, -1);
    else if (e.key === 'PageDown') next = snapRollback(rollback + 5, stops, 1);
    else return;
    e.preventDefault();
    next = clampIdx(next, n);
    if (next !== rollback) onRollback?.(next);
  }

  /* ----------------------------------------------------------- selection and folders */
  /** Head feature rows in display order: what a Shift-click range runs over. */
  const headIds = visible.filter((r) => r.kind === 'feature' && !r.nestedSketch).map((r) => r.id);

  function clickFeature(e: MouseEvent, id: Id) {
    if (e.ctrlKey || e.metaKey) {
      const base = effective.length ? effective : anchorId ? [anchorId] : [];
      setPicked(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
      setAnchorId(id);
      return;
    }
    if (e.shiftKey && (anchorId ?? selectedId)) {
      const a = headIds.indexOf((anchorId ?? selectedId) as Id);
      const b = headIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        setPicked(headIds.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (picked.length) setPicked([]);
    setAnchorId(id);
    onSelect?.(id);
  }

  /** The features a row's menu acts on: the whole selection when the row is part of it. */
  const targetsOf = (id: Id): Id[] =>
    effective.length > 1 && effective.includes(id) ? [...effective] : [id];

  /** Ids to group: the picks plus the sketches nested under them, in history order. */
  const folderIdsFor = (ids: readonly Id[]) => runWithNested(features, nesting, ids);
  function addFolder(ids: readonly Id[]) {
    const run = folderIdsFor(ids);
    if (!onAddFolder || !canFolder(features, folders, run).ok) return;
    setAwaitFolder(run[0] as Id);
    onAddFolder(run);
  }

  const sketchesIn = (ids: readonly Id[]) =>
    ids.filter((id) => features[indexOf.get(id) ?? -1]?.type === 'sketch');
  const isShown = (f: FeatureTreeItem) =>
    f.shown ??
    (isReferenceType(f.type)
      ? f.visibility !== 'hidden'
      : effectiveSketchShown(f.visibility, consumers.has(f.id)));

  /* ----------------------------------------------------------- row keyboard */
  function rowKey(e: KeyboardEvent<HTMLDivElement>, row: TreeRow) {
    if (e.target !== e.currentTarget) return;
    const { key, id } = row;
    const v = visible.findIndex((r) => r.key === key);
    const go = (j: number) => {
      const r = visible[clampIdx(j, visible.length - 1)];
      if (r) focusRow(r.key);
    };
    const isFolder = row.kind === 'folder';
    const kids = isFolder ? undefined : nesting.childrenOf.get(id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!row.nestedSketch) keyboardMove(row, e.key === 'ArrowUp' ? -1 : 1);
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
        if (isFolder) {
          e.preventDefault();
          if (collapsed.has(id)) setCollapsed(id, false);
          else go(v + 1);
        } else if (kids?.length) {
          e.preventDefault();
          if (!expanded.has(id)) toggle(id, true);
          else go(v + 1);
        }
        break;
      case 'ArrowLeft':
        if (row.parent) {
          e.preventDefault();
          focusRow(row.parent);
        } else if (isFolder && !collapsed.has(id)) {
          e.preventDefault();
          setCollapsed(id, true);
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
        if (isFolder) setCollapsed(id, !collapsed.has(id));
        else if (e.ctrlKey || e.metaKey) {
          setPicked(
            effective.includes(id) ? effective.filter((x) => x !== id) : [...effective, id],
          );
          setAnchorId(id);
        } else onSelect?.(selectedId === id ? null : id);
        break;
      case 'Enter':
      case 'F2':
        if (isFolder ? onRenameFolder : onRename) {
          e.preventDefault();
          setRenaming(key);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (onDelete && !isFolder) {
          e.preventDefault();
          const nextR = visible[v + 1] ?? visible[v - 1];
          if (!requestDelete(id) && nextR) focusRow(nextR.key);
        }
        break;
      case 'ContextMenu':
        e.preventDefault();
        setMenu({ key, anchor: e.currentTarget });
        break;
      case 'F10':
        if (e.shiftKey) {
          e.preventDefault();
          setMenu({ key, anchor: e.currentTarget });
        }
        break;
    }
  }

  /* ----------------------------------------------------------- menus */
  if (n === 0) {
    return (
      <EmptyState icon={ListTree} title="No features yet" className={className}>
        <p>Start with a sketch on a plane.</p>
      </EmptyState>
    );
  }

  const menuCtx: MenuCtx = {
    features,
    folders,
    indexOf,
    allowed,
    nestSketches,
    effective,
    onEdit,
    onRename,
    onSuppress,
    configuration,
    onDelete,
    onRollback,
    onAddFolder,
    onRenameFolder,
    onRemoveFolder,
    onSuppressMany,
    onSketchVisibility,
    onNestSketchesChange,
    setRenaming,
    setPicked,
    setAnchorId,
    addFolder,
    requestDelete,
    isShown,
    sketchesIn,
    folderIdsFor,
    targetsOf,
    review,
  };
  const barY =
    barDrag ?? (geom.stop[rollback] !== undefined ? geom.stop[rollback] + barOffset : undefined);
  const rowH = touch ? 'min-h-11' : 'min-h-8';
  const menuRow = menu ? rowByKey.get(menu.key) : undefined;
  const menuFeature = menuRow && menuRow.kind === 'feature' ? indexOf.get(menuRow.id) : undefined;
  const menuFolder =
    menuRow?.kind === 'folder' ? folders.find((f) => f.id === menuRow.id) : undefined;
  const chevronW = touch ? 'w-7' : 'w-4';
  const dragging = drag && Math.abs(drag.dy) > 4 ? drag : null;
  const activeSlot = dragging && dragging.slot !== null ? dragging.slots[dragging.slot] : undefined;
  const indentPx = touch ? 36 : 28;

  const renderRow = (row: TreeRow) => {
    const isMoving =
      dragging !== null &&
      (dragging.key === row.key || (dragging.kind === 'folder' && row.folderId === dragging.id));
    const dy = isMoving ? (dragging?.dy ?? 0) : 0;
    const isShaking = shake?.key === row.key;

    if (row.kind === 'folder') {
      const folder = folders.find((f) => f.id === row.id);
      if (!folder) return null;
      const open = !collapsed.has(folder.id);
      const run = folderRange(features, folder);
      const rolled = run ? run.start >= rollback : false;
      const allSuppressed = folder.features.every(
        (id) => features[indexOf.get(id) ?? -1]?.suppressed,
      );
      const dropTarget =
        !!activeSlot &&
        (activeSlot.kind === 'into' || activeSlot.kind === 'stay') &&
        activeSlot.folderId === folder.id;
      return (
        <FolderRow
          key={row.key}
          noMenu={review}
          folderId={folder.id}
          name={folder.name}
          count={folder.features.length}
          level={row.level}
          pos={row.pos}
          size={row.size}
          open={open}
          touch={touch}
          focusable={activeFocus === row.key}
          renaming={renaming === row.key}
          rolled={rolled}
          suppressed={allSuppressed}
          dropTarget={dropTarget}
          dragging={isMoving}
          dy={dy}
          draggable={!!onMoveFolder}
          description={[
            `Folder with ${folder.features.length} ${folder.features.length === 1 ? 'feature' : 'features'}.`,
            open ? 'Expanded.' : 'Collapsed.',
            allSuppressed ? 'All suppressed.' : '',
            rolled ? 'Rolled back.' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          rowRef={(el) => {
            if (el) rows.current.set(row.key, el);
            else rows.current.delete(row.key);
          }}
          rootProps={{
            onFocus: (e) => {
              if (e.target === e.currentTarget) setFocusKey(row.key);
            },
            onClick: () => {
              setFocusKey(row.key);
              if (touch) setCollapsed(folder.id, open);
            },
            onKeyDown: (e) => rowKey(e, row),
            onContextMenu: (e) => {
              e.preventDefault();
              setFocusKey(row.key);
              setMenu({ key: row.key, anchor: { x: e.clientX, y: e.clientY } });
            },
            ...longPress(row.key),
          }}
          gripProps={{
            onPointerDown: (e) => gripDown(e, row),
            onPointerMove: gripMove,
            onPointerUp: gripUp,
            onPointerCancel: () => setDrag(null),
          }}
          onToggle={() => setCollapsed(folder.id, open)}
          onMenu={(anchor) => {
            setFocusKey(row.key);
            setMenu({ key: row.key, anchor });
          }}
          onStartRename={() => onRenameFolder && setRenaming(row.key)}
          onCommitRename={(name) => {
            setRenaming(null);
            onRenameFolder?.(folder.id, name);
            refocus(row.key);
          }}
          onCancelRename={() => {
            setRenaming(null);
            refocus(row.key);
          }}
        />
      );
    }

    const f = features[row.i];
    if (!f) return null;
    const i = row.i;
    const nested = row.nestedSketch;
    const kids = nesting.childrenOf.get(f.id) ?? [];
    const open = kids.length > 0 && expanded.has(f.id);
    const shared = f.type === 'sketch' ? sharedCount(nesting, f.id) : 0;
    const meta = featureMeta[f.type];
    const status = statusById.get(f.id);
    const st = describeStatus(status, f.name, nameOf);
    const rolled = i >= rollback || status?.state === 'rolledBack';
    const suppressed = f.suppressed || status?.state === 'suppressed';
    const selected = effective.includes(f.id);
    const isSketch = f.type === 'sketch';
    const isReference = isReferenceType(f.type);
    const hasEye = isSketch || isReference;
    const shown = hasEye ? isShown(f) : false;
    const stateText = [
      suppressed ? 'suppressed' : '',
      rolled ? 'rolled back' : '',
      status?.state === 'error' ? 'error' : '',
      status?.state === 'needsAttention' ? 'needs attention' : '',
      status?.state === 'blocked' ? 'blocked' : '',
      status?.grown?.length
        ? 'check a reference'
        : status?.merged?.length
          ? 'uses a merged face or edge'
          : '',
    ]
      .filter(Boolean)
      .join(', ');
    const auto = !isReference && (f.visibility === undefined || f.visibility === 'auto');
    const suppressOverridden = !!configuration?.overriddenSuppression?.includes(f.id);
    const hidden = [
      `${meta.label}${stateText ? `, ${stateText}` : ''}.`,
      kids.length ? `Contains ${kids.length === 1 ? 'a sketch' : `${kids.length} sketches`}.` : '',
      shared ? `Used by ${shared} features.` : '',
      suppressOverridden
        ? `Suppression overridden in ${configuration?.activeName ?? 'this configuration'}.`
        : '',
      hasEye && onSketchVisibility
        ? `${shown ? 'Shown' : 'Hidden'} in the viewport${auto ? ' (automatic)' : ''}.`
        : '',
      row.folderId ? `In the folder ${folderName(row.folderId)}.` : '',
      lineage?.parents.includes(f.id) ? 'The selected feature is built from this one.' : '',
      lineage?.children.includes(f.id) ? 'Built from the selected feature.' : '',
      st?.hint,
    ]
      .filter(Boolean)
      .join(' ');
    const indent = row.level - 1;
    return (
      <div
        key={row.key}
        ref={(el) => {
          if (el) rows.current.set(row.key, el);
          else rows.current.delete(row.key);
        }}
        role="treeitem"
        aria-level={row.level}
        aria-posinset={row.pos}
        aria-setsize={row.size}
        aria-selected={selected}
        aria-expanded={kids.length ? open : undefined}
        tabIndex={activeFocus === row.key ? 0 : -1}
        data-feature-id={f.id}
        data-state={status?.state ?? 'ok'}
        data-folder={row.folderId}
        data-lineage={
          lineage?.parents.includes(f.id)
            ? 'parent'
            : lineage?.children.includes(f.id)
              ? 'child'
              : undefined
        }
        data-nested={nested || undefined}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusKey(row.key);
        }}
        onClick={(e) => {
          setFocusKey(row.key);
          clickFeature(e, f.id);
        }}
        onKeyDown={(e) => rowKey(e, row)}
        {...longPress(row.key)}
        onContextMenu={(e) => {
          e.preventDefault();
          setFocusKey(row.key);
          setMenu({ key: row.key, anchor: { x: e.clientX, y: e.clientY } });
        }}
        style={isMoving ? { transform: `translateY(${dy}px)`, zIndex: 2 } : undefined}
        className={cn(
          'group/row relative list-none outline-none',
          'data-[lineage=child]:shadow-[inset_3px_0_0_var(--color-warning)] data-[lineage=parent]:shadow-[inset_3px_0_0_var(--color-accent)]',
          isMoving && 'opacity-90',
        )}
      >
        <FeatureRowBody
          shakeKey={isShaking ? (shake?.n ?? 0) : 0}
          isShaking={isShaking}
          rejectSpring={rejectSpring}
          indent={indent}
          indentPx={indentPx}
          rowH={rowH}
          isMoving={isMoving}
          selected={selected}
          nested={nested}
          anyNested={anyNested}
          kidCount={kids.length}
          open={open}
          chevronW={chevronW}
          touch={touch}
          canMove={!!onMove}
          onGripDown={(e) => gripDown(e, row)}
          onGripMove={gripMove}
          onGripUp={gripUp}
          onGripCancel={() => setDrag(null)}
          onToggle={toggle}
          f={f}
          st={st}
          rolled={rolled}
          suppressed={suppressed}
          suppressOverridden={suppressOverridden}
          renaming={renaming === row.key}
          rowKey={row.key}
          onRename={onRename}
          setRenaming={setRenaming}
          refocus={refocus}
          hidden={hidden}
          onSelect={onSelect}
          shared={shared}
          hasEye={hasEye}
          isReference={isReference}
          onSketchVisibility={onSketchVisibility}
          shown={shown}
          setFocusKey={setFocusKey}
          setMenu={setMenu}
        />
        {confirm === f.id ? (
          <DeletePrompt
            name={f.name}
            sketches={kids.length}
            touch={touch}
            onAnswer={(also) => answerDelete(f.id, also)}
            onCancel={() => {
              setConfirm(null);
              refocus(row.key);
            }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={wrap} className="relative px-2 py-1.5" data-testid="feature-tree">
        <div
          aria-label="Features"
          role="tree"
          aria-orientation="vertical"
          aria-multiselectable={effective.length > 1 || undefined}
          className="m-0 list-none p-0"
        >
          {visible.map((row) => (
            <Fragment key={row.key}>
              {row.key === barGapKey ? barGap : null}
              {renderRow(row)}
            </Fragment>
          ))}
          {barGapKey === null ? barGap : null}
        </div>

        {activeSlot ? (
          <DropIndicator
            slot={activeSlot}
            indentPx={indentPx}
            folder={folderName(activeSlot.folderId)}
          />
        ) : null}

        {onRollback && barY !== undefined ? (
          <RollbackBar
            count={n}
            rollback={rollback}
            valueText={
              rollback >= n
                ? 'All features active'
                : rollback === 0
                  ? 'Rolled back before the first feature'
                  : `Rolled back after ${features[rollback - 1]?.name}`
            }
            y={barY}
            dragging={barDrag !== null}
            touch={touch}
            onPointerDown={barDown}
            onPointerMove={barMove}
            onPointerEnd={() => setBarDrag(null)}
            onKeyDown={barKey}
          />
        ) : null}
      </div>

      {leave ? (
        <LeavePrompt
          feature={nameOf(leave.id) ?? 'the feature'}
          folder={folderName(leave.folderId)}
          touch={touch}
          onConfirm={() => {
            const { id, folderId, joinsId, steps } = leave;
            setLeave(null);
            const what = nameOf(id) ?? 'the feature';
            runSteps(id, steps, () =>
              setInfo(
                joinsId
                  ? `Moved ${what} from ${folderName(folderId)} into ${folderName(joinsId)}.`
                  : `Took ${what} out of ${folderName(folderId)}.`,
              ),
            );
            refocus(id);
          }}
          onCancel={() => {
            const id = leave.id;
            setLeave(null);
            refocus(id);
          }}
        />
      ) : null}
      {info ? (
        <UndoLine text={info} touch={touch} onUndo={onUndo} onDismiss={() => setInfo('')} />
      ) : null}

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
      <p aria-live="polite" className="sr-only" data-testid="drop-announce">
        {dropSay}
      </p>

      {menu && menuRow && !(review && menuFolder) ? (
        <Menu
          anchor={menu.anchor}
          label={
            menuFolder
              ? `Actions for folder ${menuFolder.name}`
              : `Actions for ${menuFeature !== undefined ? features[menuFeature]?.name : ''}`
          }
          items={
            menuFolder
              ? folderMenuItems(menuCtx, menuFolder)
              : menuFeature !== undefined
                ? menuItems(menuCtx, menuRow.id, menuFeature)
                : []
          }
          size={touch ? 'touch' : 'md'}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
