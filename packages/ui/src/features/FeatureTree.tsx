import type { FeatureStatus, FeatureType, Id } from '@wren-cad/contracts';
import {
  Ban,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  Eye,
  EyeOff,
  FolderInput,
  FolderMinus,
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
  type MouseEvent,
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
  applySteps,
  type BlockStep,
  canFolder,
  effectiveSketchShown,
  folderOf,
  folderRange,
  membershipAfterMove,
  planBlockMove,
  planFolderMove,
  runWithNested,
  type SketchVisibilityMode,
  type TreeFolder,
  toggledVisibility,
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
import { FolderRow } from './FolderRow';
import { featureMeta } from './featureMeta';
import { SketchEye } from './SketchEye';
import { DeletePrompt, LeavePrompt, UndoLine } from './TreePrompts';

/** The slice of a document `Feature` the tree needs. */
export interface FeatureTreeItem {
  id: Id;
  type: FeatureType;
  name: string;
  suppressed: boolean;
  /** Sketches only: the document's `visibility` (absent = `'auto'`). */
  visibility?: SketchVisibilityMode;
  /**
   * Sketches only: whether the viewport shows it. Pass it when the app resolves visibility itself
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

const clampIdx = (n: number, max: number) => Math.max(0, Math.min(max, n));
const NO_FOLDERS: readonly TreeFolder[] = [];

/** One place a dragged row can land: a document gap with what it does to folders. */
interface Slot {
  /** Document gap: the dragged block would sit before feature index `g`. */
  g: number;
  /** Key of the head row the line sits above; null = after the last row. */
  before: string | null;
  /** `into` joins a folder, `out` leaves one, `stay` reorders inside its own folder. */
  kind: 'top' | 'into' | 'stay' | 'out';
  folderId?: Id;
  steps?: BlockStep[];
  toIndex?: number;
  /** Pixel y of the line, measured when the drag starts. */
  y: number;
}

interface DragState {
  kind: 'feature' | 'folder';
  key: string;
  id: Id;
  dy: number;
  at: number;
  slots: Slot[];
  slot: number | null;
}

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
  onRename,
  onRollback,
  onMove,
  onReorder,
  onEdit,
  onSuppress,
  onDelete,
  nestSketches = true,
  onNestSketchesChange,
  folders = NO_FOLDERS,
  collapsedFolders,
  onCollapsedFoldersChange,
  onAddFolder,
  onRenameFolder,
  onRemoveFolder,
  onMoveFolder,
  onSuppressMany,
  onUndo,
  onSketchVisibility,
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
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: FloatingAnchor } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<Id>>(new Set());
  const [confirm, setConfirm] = useState<Id | null>(null);
  const [multi, setMulti] = useState<readonly Id[]>([]);
  const [anchorId, setAnchorId] = useState<Id | null>(null);
  const [localCollapsed, setLocalCollapsed] = useState<readonly Id[]>([]);
  const [leave, setLeave] = useState<{ id: Id; folderId: Id; steps: BlockStep[] } | null>(null);
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
      const tops = heads.map((h) => rows.current.get(h.key)?.offsetTop ?? 0);
      const lastEl = rows.current.get(visible[visible.length - 1]?.key ?? '');
      const bottom = lastEl ? lastEl.offsetTop + lastEl.offsetHeight : 0;
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
      if (mem.leaves) out.push({ g, before, kind: 'out', folderId: mem.leaves, steps, y: 0 });
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
      setLeave({ id: row.id, folderId: slot.folderId, steps });
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
  const rollbackFromY = (clientY: number) => {
    const top = wrap.current?.getBoundingClientRect().top ?? 0;
    const y = clientY - top;
    let best = stops[0] ?? 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (const r of stops) {
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
      const base = effective;
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
    f.shown ?? effectiveSketchShown(f.visibility, consumers.has(f.id));

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
  function folderMenuItems(folder: TreeFolder): MenuItem[] {
    const items: MenuItem[] = [];
    const run = folderRange(features, folder);
    if (onRenameFolder)
      items.push({
        id: 'rename',
        label: 'Rename',
        shortcut: 'F2',
        icon: <Pencil className="size-4" />,
        onSelect: () => setRenaming(folderKey(folder.id)),
      });
    if (onRemoveFolder)
      items.push({
        id: 'ungroup',
        label: 'Ungroup',
        icon: <FolderMinus className="size-4" />,
        onSelect: () => onRemoveFolder(folder.id),
      });
    if (onSuppressMany) {
      const all = folder.features.every((id) => features[indexOf.get(id) ?? -1]?.suppressed);
      items.push({
        id: 'suppress-all',
        label: all ? 'Unsuppress all' : 'Suppress all',
        icon: all ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
        onSelect: () => onSuppressMany(folder.features, !all),
      });
    }
    const sk = sketchesIn(folder.features);
    if (onSketchVisibility && sk.length) {
      const allShown = sk.every((id) => isShown(features[indexOf.get(id) ?? 0] as FeatureTreeItem));
      items.push({
        id: 'folder-sketches',
        label: allShown ? 'Hide sketches' : 'Show sketches',
        icon: allShown ? <EyeOff className="size-4" /> : <Eye className="size-4" />,
        onSelect: () => onSketchVisibility(sk, allShown ? 'hidden' : 'shown'),
      });
    }
    if (onRollback && run)
      items.push({
        id: 'rollto',
        label: 'Roll back to before folder',
        icon: <SkipBack className="size-4" />,
        onSelect: () => onRollback(snapRollback(run.start, allowed, -1)),
      });
    return items;
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
    if (onSketchVisibility && f.type === 'sketch') {
      const shown = isShown(f);
      items.push({
        id: 'viewport',
        label: shown ? 'Hide in viewport' : 'Show in viewport',
        icon: shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />,
        onSelect: () => onSketchVisibility([id], toggledVisibility(shown)),
      });
      if (f.visibility === 'shown' || f.visibility === 'hidden')
        items.push({
          id: 'viewport-auto',
          label: 'Reset to automatic',
          hint: 'Shown until a feature uses it, then hidden.',
          icon: <Eye className="size-4" />,
          onSelect: () => onSketchVisibility([id], 'auto'),
        });
    }
    if (onRollback)
      items.push({
        id: 'rollto',
        label: 'Roll to here',
        icon: <SkipBack className="size-4 rotate-180" />,
        // A nested sketch rolls to after the feature it sits under.
        onSelect: () => onRollback(snapRollback(i + 1, allowed, 1)),
      });
    if (onAddFolder) {
      const run = folderIdsFor(targetsOf(id));
      const can = canFolder(features, folders, run);
      items.push({
        id: 'add-folder',
        label: 'Add to new folder',
        icon: <FolderInput className="size-4" />,
        separatorBefore: true,
        disabled: !can.ok,
        ...(can.ok ? {} : { hint: can.reason }),
        onSelect: () => addFolder(targetsOf(id)),
      });
      const on = effective.includes(id) && effective.length > 0;
      items.push({
        id: 'select-more',
        label: on ? 'Remove from selection' : 'Add to selection',
        icon: <ListTree className="size-4" />,
        onSelect: () => {
          setPicked(on ? effective.filter((x) => x !== id) : [...effective, id]);
          setAnchorId(id);
        },
      });
    }
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
  const menuRow = menu ? rowByKey.get(menu.key) : undefined;
  const menuFeature = menuRow && menuRow.kind === 'feature' ? indexOf.get(menuRow.id) : undefined;
  const menuFolder =
    menuRow?.kind === 'folder' ? folders.find((f) => f.id === menuRow.id) : undefined;
  const chevronW = touch ? 'w-7' : 'w-4';
  const dragging = drag && Math.abs(drag.dy) > 4 ? drag : null;
  const activeSlot = dragging && dragging.slot !== null ? dragging.slots[dragging.slot] : undefined;
  const indentPx = touch ? 36 : 28;

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
          {visible.map((row) => {
            const isMoving =
              dragging !== null &&
              (dragging.key === row.key ||
                (dragging.kind === 'folder' && row.folderId === dragging.id));
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
            const shown = isSketch ? isShown(f) : false;
            const stateText = [
              suppressed ? 'suppressed' : '',
              rolled ? 'rolled back' : '',
              status?.state === 'error' ? 'error' : '',
              status?.state === 'needsAttention' ? 'needs attention' : '',
              status?.state === 'blocked' ? 'blocked' : '',
            ]
              .filter(Boolean)
              .join(', ');
            const auto = f.visibility === undefined || f.visibility === 'auto';
            const hidden = [
              `${meta.label}${stateText ? `, ${stateText}` : ''}.`,
              kids.length
                ? `Contains ${kids.length === 1 ? 'a sketch' : `${kids.length} sketches`}.`
                : '',
              shared ? `Used by ${shared} features.` : '',
              isSketch && onSketchVisibility
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
                <m.div
                  key={isShaking ? shake?.n : 0}
                  initial={isShaking ? { x: 9 } : false}
                  animate={{ x: 0 }}
                  transition={rejectSpring}
                  style={indent ? { marginLeft: indent * indentPx } : undefined}
                  className={cn(
                    'flex items-start gap-2 rounded-[9px] pr-1 pl-1 transition-colors duration-fast',
                    rowH,
                    'group-focus-visible/row:outline-2 group-focus-visible/row:outline-offset-[-2px] group-focus-visible/row:outline-accent',
                    selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                    isMoving && 'bg-surface shadow-float',
                    isShaking && 'bg-danger-soft',
                  )}
                >
                  {nested ? null : (
                    <span
                      aria-hidden
                      data-grip
                      data-no-longpress
                      onPointerDown={(e) => gripDown(e, row)}
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
                    {renaming === row.key ? (
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
                          refocus(row.key);
                        }}
                        className="h-6 w-full min-w-0 rounded-[6px] bg-surface px-1.5 text-ui text-fg shadow-[inset_0_0_0_2px_var(--color-accent)] outline-none"
                      />
                    ) : (
                      // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename; keyboard uses Enter/F2 on the row
                      <span
                        onDoubleClick={(e) => {
                          if (!onRename) return;
                          e.stopPropagation();
                          setRenaming(row.key);
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
                  {isSketch && onSketchVisibility ? (
                    <SketchEye
                      name={f.name}
                      shown={shown}
                      visibility={f.visibility}
                      touch={touch}
                      onToggle={() => onSketchVisibility([f.id], toggledVisibility(shown))}
                    />
                  ) : null}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    aria-label={`Actions for ${f.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusKey(row.key);
                      setMenu({ key: row.key, anchor: e.currentTarget });
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
                      refocus(row.key);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {activeSlot ? (
          <div
            aria-hidden
            data-testid="drop-indicator"
            data-kind={activeSlot.kind}
            className="pointer-events-none absolute right-2 left-2 flex items-center transition-[top] duration-fast"
            style={{
              top: activeSlot.y - 1,
              left: activeSlot.kind === 'into' || activeSlot.kind === 'stay' ? 8 + indentPx : 8,
            }}
          >
            <span
              className={cn(
                'h-0.5 flex-1 rounded-full',
                activeSlot.kind === 'out' ? 'bg-warning' : 'bg-accent',
              )}
            />
            {activeSlot.kind === 'into' || activeSlot.kind === 'out' ? (
              <span
                className={cn(
                  'ml-1 rounded-full px-1.5 text-2xs leading-4 font-medium whitespace-nowrap',
                  activeSlot.kind === 'out'
                    ? 'bg-warning-soft text-warning-text'
                    : 'bg-accent-soft text-accent-text',
                )}
              >
                {activeSlot.kind === 'out' ? 'Out of' : 'Into'} {folderName(activeSlot.folderId)}
              </span>
            ) : null}
          </div>
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

      {leave ? (
        <LeavePrompt
          feature={nameOf(leave.id) ?? 'the feature'}
          folder={folderName(leave.folderId)}
          touch={touch}
          onConfirm={() => {
            const { id, folderId, steps } = leave;
            setLeave(null);
            runSteps(id, steps, () =>
              setInfo(`Took ${nameOf(id) ?? 'the feature'} out of ${folderName(folderId)}.`),
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

      {menu && menuRow ? (
        <Menu
          anchor={menu.anchor}
          label={
            menuFolder
              ? `Actions for folder ${menuFolder.name}`
              : `Actions for ${menuFeature !== undefined ? features[menuFeature]?.name : ''}`
          }
          items={
            menuFolder
              ? folderMenuItems(menuFolder)
              : menuFeature !== undefined
                ? menuItems(menuRow.id, menuFeature)
                : []
          }
          size={touch ? 'touch' : 'md'}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
