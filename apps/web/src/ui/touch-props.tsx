/**
 * M2 shell props built from workbench state (PLAN §9.1): the context bubble anchored at the
 * selection, the push/pull value chip, the Parts / Measure / Section panels and the bracket
 * tutorial. Each hook reads the workbench and returns plain props for `AppShell`.
 */

import {
  type BubbleAction,
  bracketTutorial,
  type ContextBubbleProps,
  type MeasurePanelProps,
  type MeasureUnits,
  type PartsPanelProps,
  type Rect,
  type SectionPanelProps,
  tools as shellTools,
  type TutorialProps,
  useTutorial,
  type ValueChipProps,
} from '@wren-cad/ui';
import { CircleMinus, Maximize, Redo2, Scissors, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type BubbleActionId, bubbleActions, VIEW_ACTIONS } from '../app/gestures';
import { useObservable } from '../app/observable';
import { stepDone, trackParams } from '../app/tutorial';
import type { Workbench } from '../app/workbench';
import { useDoc } from './Inspector';

const icon = 'size-[22px]';

/** The viewport's double-tap window (packages/viewport gestureConstants.DOUBLE_TAP_MAX_MS) + 20. */
const BUBBLE_DELAY_MS = 320;

const EXTRA: Partial<Record<BubbleActionId, { label: string; Icon: typeof Scissors }>> = {
  cut: { label: 'Cut', Icon: CircleMinus },
  section: { label: 'Section', Icon: Scissors },
  fit: { label: 'Fit', Icon: Maximize },
  undo: { label: 'Undo', Icon: Undo2 },
  redo: { label: 'Redo', Icon: Redo2 },
};

function actionFor(wb: Workbench, id: BubbleActionId): BubbleAction {
  const t = shellTools.find((x) => x.id === id);
  const meta = t ? { label: t.label, Icon: t.Icon } : (EXTRA[id] ?? { label: id, Icon: Maximize });
  return {
    id,
    label: meta.label,
    icon: <meta.Icon className={icon} strokeWidth={1.75} aria-hidden />,
    onSelect: () => wb.bubbleAction(id),
  };
}

/** Floating chrome the bubble must not cover (top bar, tool rail, sheets), in stage px. */
function chromeObstacles(wb: Workbench): Rect[] {
  const stage = wb.canvas?.getBoundingClientRect();
  if (!stage) return [];
  const out: Rect[] = [];
  for (const el of document.querySelectorAll(
    '[data-testid="top-bar"], [aria-label="Modeling tools"], [data-testid$="-sheet"]',
  )) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0)
      out.push({
        left: r.left - stage.left,
        top: r.top - stage.top,
        width: r.width,
        height: r.height,
      });
  }
  return out;
}

/**
 * The context bubble near the selection (tablet, phone): 3-4 actions for what is selected, or view
 * actions after a long-press on empty space. It follows the selection's picked point
 * (`worldToScreen`), recomputed when the camera comes to rest; while the camera moves it hides,
 * so orbiting never re-renders the shell.
 */
export function useContextBubble(wb: Workbench): ContextBubbleProps | undefined {
  const ui = useObservable(wb.ui);
  const camera = useObservable(wb.camera);
  const regen = useObservable(wb.regen);
  // A new selection's bubble waits out the double-tap window, so a second tap lands on the model
  // (double-tap = zoom to it), never on a bubble that popped up under the finger.
  const key = ui.selection.map((s) => s.key).join(',');
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setSettled(key), BUBBLE_DELAY_MS);
    return () => clearTimeout(t);
  }, [key]);
  if (wb.tier === 'desktop') return undefined;
  const busy =
    ui.sketch !== null ||
    ui.prompt !== null ||
    ui.picking !== null ||
    ui.pushPull !== null ||
    ui.measure?.active === true ||
    ui.section.picking ||
    ui.chooser !== null ||
    ui.candidates !== null ||
    ui.library;
  const view = ui.bubble?.view === true;
  if (busy || camera.moving || regen === null || (!view && ui.selection.length === 0))
    return undefined;
  if (!view && !ui.bubble && settled !== key) return undefined;
  const ids = view
    ? VIEW_ACTIONS
    : bubbleActions(
        ui.selection.map((s) => ({
          kind: s.hit.kind,
          ...(s.hit.kind === 'face'
            ? { planar: wb.face(s.hit.bodyId, s.hit.index)?.planar === true }
            : {}),
        })),
        wb.tier,
      );
  if (ids.length === 0) return undefined;
  const last = ui.selection[ui.selection.length - 1];
  const at = ui.bubble?.at ?? last?.hit.point ?? null;
  const anchor = ui.bubble?.screen ?? (at ? wb.project(at) : null);
  if (!anchor) return undefined;
  return {
    anchor,
    actions: ids.map((id) => actionFor(wb, id)),
    label: view ? 'View actions' : 'Selection actions',
    obstacles: chromeObstacles(wb),
    onDismiss: () => wb.cancel(),
    ...(view ? {} : { onClear: () => wb.clearSelection() }),
  };
}

const minus = (s: string) => s.replace('-', '−');

/** The push/pull value chip beside the arrow; tap it to type an exact value. */
export function useValueChip(wb: Workbench): ValueChipProps | undefined {
  const ui = useObservable(wb.ui);
  const camera = useObservable(wb.camera);
  const pp = ui.pushPull;
  if (!pp || (camera.moving && !pp.dragging)) return undefined;
  return {
    point: wb.pushPull.chipPoint(),
    value: pp.expr,
    display: minus(pp.expr),
    label: 'Push/pull distance',
    dragging: pp.dragging,
    evaluate: (e) => wb.evaluate(e, 'length'),
    unitHint: 'mm',
    onPreview: (e) => wb.pushPull.preview(e),
    onCommit: (e) => void wb.pushPull.commit(e),
    onCancel: () => wb.pushPull.revert(),
  };
}

/** Measure panel props (phone sheet tab, desktop/tablet inspector). */
export function useMeasureProps(wb: Workbench): MeasurePanelProps {
  const ui = useObservable(wb.ui);
  const [units, setUnits] = useState<MeasureUnits>('mm');
  const m = ui.measure;
  return {
    measurements: m?.results ?? [],
    targets: (m?.picks ?? []).map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
    units,
    onUnitsChange: setUnits,
    onRemoveTarget: (id) => void wb.measure.removePick(id),
    onClear: () => wb.measure.clear(),
    note: m?.error ?? null,
    busy: m?.busy === true && (m.results.length ?? 0) === 0,
  };
}

/** Section panel props: axis X/Y/Z or a picked face's plane, offset within the part, flip. */
export function useSectionProps(wb: Workbench): SectionPanelProps {
  const ui = useObservable(wb.ui);
  useObservable(wb.regen); // the range follows the part
  const s = ui.section;
  return {
    enabled: s.enabled,
    onEnabledChange: (enabled) => wb.setSection({ enabled }),
    axis: s.axis,
    onAxisChange: (axis) =>
      wb.setSection(axis === 'face' ? { axis, picking: !s.face, enabled: true } : { axis }),
    faceLabel: s.face?.label ?? null,
    onPickFace: () => {
      wb.setSection({ picking: true });
      if (wb.tier === 'phone') wb.setSheet({ snap: 'peek' }); // the face is tapped in the view
    },
    offset: s.offset,
    range: wb.sectionRange(),
    onOffsetChange: (offset) => wb.setSection({ offset }),
    flipped: s.flipped,
    onFlippedChange: (flipped) => wb.setSection({ flipped }),
  };
}

/** Phone Parts tab: the document's parts, visibility and focus. */
export function usePartsProps(wb: Workbench): PartsPanelProps {
  const doc = useDoc(wb);
  useObservable(wb.ui);
  return {
    parts: doc.parts.map((p) => {
      const color = p.color ?? p.material?.appearance;
      return { id: p.id, name: p.name, visible: wb.partVisible(p.id), ...(color ? { color } : {}) };
    }),
    onSelect: (id) => wb.focusPart(id),
    onToggleVisible: (id, visible) => wb.setPartVisible(id, visible),
  };
}

/**
 * The "make a bracket" tutorial (PLAN §9.2): offered from the welcome card and ⌘K, run on a new
 * part, and advanced by the real document (`stepDone`), never by a Next button.
 */
export function useBracketTutorial(wb: Workbench): TutorialProps {
  const tutorial = useTutorial(bracketTutorial, { index: 0, status: 'skipped' });
  const doc = useDoc(wb);
  const ui = useObservable(wb.ui);
  const statuses = useObservable(wb.treeStatuses);
  const exports = useObservable(wb.exports);
  const requests = useObservable(wb.tourRequests);
  const base = useRef({ exports: 0, params: {} as Record<string, string> });
  const { restart, advance } = tutorial;

  // A tour request: a fresh part, then step 1.
  const seen = useRef(requests);
  useEffect(() => {
    if (requests === seen.current) return;
    seen.current = requests;
    void wb.newDocument().then(() => {
      base.current = { exports: wb.exports.get(), params: {} };
      restart();
    });
  }, [requests, wb, restart]);

  const running = tutorial.state.status === 'running';
  const step = tutorial.step;
  useEffect(() => {
    if (!running || !step) return;
    const snapshot = {
      doc,
      statuses,
      editingDimension: ui.sketch?.editDimension ?? null,
      exports: exports - base.current.exports,
      paramsInUse: base.current.params,
    };
    const done = stepDone(step.id, snapshot);
    base.current.params = trackParams(base.current.params, doc).seen;
    if (done) advance(step.id);
  }, [running, step, doc, statuses, ui.sketch?.editDimension, exports, advance]);

  return useMemo(
    () => ({
      steps: bracketTutorial,
      state: tutorial.state,
      title: 'Make a bracket',
      onSkip: tutorial.skip,
      onBack: tutorial.back,
      onDone: tutorial.skip,
    }),
    [tutorial.state, tutorial.skip, tutorial.back],
  );
}
