/**
 * Sketch mode (PLAN §2.1, §9.2): one editing session of a SketchFeature. Drawing tools with live
 * inference, the Dimension tool, selection and constraints, point/curve dragging through the
 * sketch worker (one undo step per drag), DOF colouring and conflict fixes. Every edit is solved
 * in the sketch worker first and lands in the document as one `updateFeature`.
 *
 * Loaded lazily (with the sketch worker) the first time the user sketches.
 */

import type {
  GeometricConstraint,
  GeometricConstraintDraft,
  HighlightItem,
  Id,
  PickHit,
  RegenResult,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SketchSolveResult,
  StrokeSample,
  SuggestedFix,
  Vec2,
} from '@wren-cad/contracts';
import { isDimension } from '@wren-cad/contracts';
import { evaluateFeatureValues, sketchSolveValues } from '@wren-cad/document';
import {
  createSketchSolverClient,
  dragDimensionLabel,
  newId,
  type SketchSolverClient,
} from '@wren-cad/sketch';
import { recognizeStroke, strokeFragment } from '@wren-cad/sketch/recognize';
import type { GeometricConstraintKind, SketchToolId } from '@wren-cad/ui';
import { toWorld } from '../model/frames';
import { toleranceFor } from '../selection/pick';
import {
  convertRadiusDiameter,
  dimensionAt,
  initialExpr,
  makeDimension,
  measure,
  removeEntities,
} from '../sketch/dimension';
import {
  cancel as cancelDraw,
  type DrawToolId,
  click as drawClick,
  finishShape as drawFinish,
  move as drawMove,
  isSplineTool,
  preview,
  type SketchData,
  type SketchEdit,
  startDraw,
  withPending,
} from '../sketch/draw';
import { sketchCurves } from '../sketch/overlay';
import {
  axisSpan,
  type Box2,
  boxOf,
  entitiesWithReferences,
  isSketchReference,
  rankSketchHits,
  referenceOverlay,
  SKETCH_ORIGIN,
  spanCovers,
} from '../sketch/references';
import { MIN_CONFIDENCE, strokeEdit } from '../sketch/stroke';
import { observable } from './observable';
import { replayedPointerDowns } from './pointers';
import { isEditTool, SketchEditTools, startEdit } from './sketch-edit';
import type { SketchUi } from './state';
import type { Workbench } from './workbench';

let solverClient: SketchSolverClient | null = null;
function solver(): SketchSolverClient {
  solverClient ??= createSketchSolverClient();
  return solverClient;
}

const DRAW_TOOLS = new Set<string>([
  'line',
  'rectangle',
  'circle',
  'arc',
  'slot',
  'polygon',
  'point',
  'ellipse',
  'ellipticArc',
  'splineControl',
  'splineThrough',
]);

/** Two taps this close in time and place end a spline (the double-tap / double-click). */
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 14;

/** A Pencil press held still this long on sketch geometry grabs it (a solver drag). */
const GRAB_HOLD_MS = 300;

/** A pen press that moves less than this (CSS px) is a tap (a click for the tool), not a stroke. */
const STROKE_SLOP_PX = 6;
/** A finger drag longer than this starts a shape at the press (touch drag-to-draw). */
const TOUCH_DRAG_PX = 10;

interface Stroke {
  pointerId: number;
  start: { x: number; y: number };
  samples: StrokeSample[];
  /** Recognition tolerance (mm): about twice the pen pick radius at the current zoom. */
  tolerance: number;
  moved: boolean;
  /** Pen down on grabbable geometry: held still for `GRAB_HOLD_MS` it grabs it instead. */
  grab?: { entity: Id; timer: ReturnType<typeof setTimeout> };
}

interface DragState {
  session: Promise<number>;
  entity: Id;
  key: string;
  inFlight: boolean;
  pending: Vec2 | null;
  moved: boolean;
  start: { x: number; y: number };
}

/**
 * Which constraints the current entity selection can take. The selection may include the origin
 * and axes (ADR-017): they take relations to the user's geometry, but are never fixed, made
 * horizontal/vertical, equal, or used as a line with a midpoint, and two references alone take
 * nothing.
 */
export function applicableConstraints(
  entities: readonly SketchEntity[],
  selected: readonly Id[],
): GeometricConstraintKind[] {
  const refs = selected.filter(isSketchReference);
  if (refs.length === 0) return applicableTo(entities, selected);
  if (refs.length === selected.length) return [];
  const all = entitiesWithReferences(entities);
  const userLines = selected.filter(
    (id) => !isSketchReference(id) && entities.find((e) => e.id === id)?.kind === 'line',
  ).length;
  const refLine = refs.some((id) => id !== SKETCH_ORIGIN);
  return applicableTo(all, selected).filter((k) => {
    if (k === 'fix' || k === 'equal') return false;
    if ((k === 'horizontal' || k === 'vertical') && userLines === 0) return false;
    // Midpoint of an axis: no such thing (the origin at a line's midpoint is fine). Concentric
    // needs centres.
    if ((k === 'midpoint' || k === 'concentric') && refLine) return false;
    return true;
  });
}

function applicableTo(
  entities: readonly SketchEntity[],
  selected: readonly Id[],
): GeometricConstraintKind[] {
  const kinds = selected.map((id) => entities.find((e) => e.id === id)?.kind);
  const n = (k: string) => kinds.filter((x) => x === k).length;
  const curves = n('line') + n('circle') + n('arc');
  const out: GeometricConstraintKind[] = [];
  if (selected.length === 1) {
    out.push('fix');
    if (n('line') === 1) out.push('horizontal', 'vertical');
  }
  if (selected.length === 2) {
    if (n('point') === 2) out.push('coincident', 'horizontalPoints', 'verticalPoints');
    if (n('line') === 2) out.push('parallel', 'perpendicular', 'equal');
    if (n('point') === 1 && n('line') === 1) out.push('midpoint', 'pointOn');
    if (n('point') === 1 && (n('circle') === 1 || n('arc') === 1)) out.push('pointOn');
    if (curves === 2 && (n('circle') > 0 || n('arc') > 0))
      out.push('tangent', 'equal', 'concentric');
  }
  if (selected.length === 3 && n('point') === 2 && n('line') === 1) out.push('symmetric');
  return out;
}

/** Builds a geometric constraint of `kind` from the selected entities (ordered by kind). */
export function constraintFrom(
  kind: GeometricConstraintKind,
  entities: readonly SketchEntity[],
  selected: readonly Id[],
): GeometricConstraint | null {
  const all = selected.some(isSketchReference) ? entitiesWithReferences(entities) : entities;
  const sel = selected.map((id) => all.find((e) => e.id === id)).filter((e) => !!e);
  const pts = sel.filter((e) => e.kind === 'point').map((e) => e.id);
  const lines = sel.filter((e) => e.kind === 'line').map((e) => e.id);
  const curves = sel.filter((e) => e.kind !== 'point').map((e) => e.id);
  const [a, b] = sel.map((e) => e.id);
  let c: GeometricConstraintDraft | null = null;
  switch (kind) {
    case 'horizontal':
    case 'vertical':
      if (lines[0]) c = { kind, line: lines[0] };
      break;
    case 'fix':
      if (a) c = { kind, entity: a };
      break;
    case 'coincident':
    case 'horizontalPoints':
    case 'verticalPoints':
      if (pts[0] && pts[1]) c = { kind, a: pts[0], b: pts[1] };
      break;
    case 'midpoint':
      if (pts[0] && lines[0]) c = { kind, point: pts[0], line: lines[0] };
      break;
    case 'pointOn':
      if (pts[0] && curves[0]) c = { kind, point: pts[0], on: curves[0] };
      break;
    case 'symmetric':
      if (pts[0] && pts[1] && lines[0]) c = { kind, a: pts[0], b: pts[1], about: lines[0] };
      break;
    default:
      if (a && b) c = { kind, a, b } as GeometricConstraintDraft;
  }
  return c ? ({ ...c, id: newId() } as GeometricConstraint) : null;
}

export class SketchSession {
  /** Bumped when the camera moves, so HTML overlays (glyphs, labels) re-project. */
  readonly camera = observable(0);
  private raf = 0;
  private lastCam = '';
  private overlayQueued = false;
  /** The sketch geometry the viewport overlay was last built from (picking is served from it). */
  private pushedFor: SketchFeature['entities'] | null = null;
  private drag: DragState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private solvedFor: SketchFeature | null = null;
  private disposed = false;
  private readonly cleanup: Array<() => void> = [];

  /** The Edit-menu tools (offset, convert, trim/extend, corner, mirror, unlink / re-pick). */
  readonly edits: SketchEditTools;

  constructor(
    private readonly wb: Workbench,
    readonly featureId: Id,
    private readonly isNew: boolean,
  ) {
    this.edits = new SketchEditTools({
      wb,
      feature: () => this.feature(),
      sketchUi: () => this.ui(),
      setEdit: (edit) => {
        this.patch({ edit, tool: edit ? edit.tool : null, draw: null });
        this.pushHighlights();
      },
      commitEdit: (edit, label) => this.commitEdit(edit, label),
      selected: () => this.ui()?.selected ?? [],
    });
  }

  // ------------------------------------------------------------------ lifecycle

  feature(): SketchFeature | null {
    const f = this.wb.part?.features.find((x) => x.id === this.featureId);
    return f?.type === 'sketch' ? f : null;
  }

  private ui(): SketchUi | null {
    return this.wb.ui.get().sketch;
  }

  private patch(p: Partial<SketchUi>): void {
    this.wb.ui.set((u) => (u.sketch ? { ...u, sketch: { ...u.sketch, ...p } } : u));
  }

  enter(): void {
    const f = this.feature();
    if (!f) return;
    const frame = this.wb.sketchFrame(f);
    // A new sketch starts with the line tool, except for a Pencil user: no tool, so the Pencil
    // draws freehand shapes that are recognised (pick a tool to draw with it instead).
    const startTool = this.isNew && !this.wb.penRecentlyUsed() ? ('line' as const) : null;
    const sketch: SketchUi = {
      featureId: f.id,
      frame,
      tool: startTool,
      variants: {},
      construction: false,
      draw: startTool ? startDraw(startTool) : null,
      dimPicks: [],
      cursor: null,
      selected: [],
      selectedConstraint: null,
      hoverEntity: null,
      solve: null,
      editDimension: null,
      highlightConstraints: null,
      highlightEntities: null,
      dimDrag: null,
      conflictsDismissed: false,
      isNew: this.isNew,
      stroke: null,
      lastStroke: null,
      edit: null,
    };
    this.wb.patchUi({ sketch });
    this.tickCamera();
    if (frame) this.wb.viewport?.lookAtPlane(frame, true);
    this.wb.refreshSketchVisibility();
    this.scheduleOverlay();
    void this.resolve();
  }

  /** Leaves sketch mode. `finish`: remove a new sketch that stayed empty. */
  exit(finish = true): void {
    const f = this.feature();
    if (finish && f && this.isNew && f.entities.length === 0) {
      const part = this.wb.part;
      if (part)
        this.wb.apply(
          { kind: 'removeFeature', partId: part.id, featureId: f.id },
          'Discard empty sketch',
        );
    }
    this.wb.commit();
    this.wb.viewport?.setSketch(this.featureId, null);
    this.wb.patchUi({ sketch: null, hover: null });
    this.dispose();
    this.wb.sketchClosed();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const fn of this.cleanup) fn();
  }

  /**
   * Re-projects the HTML overlays when the camera moves. Every frame while the camera is moving
   * (or a pointer is down / the wheel turned), otherwise a cheap check every 200 ms: a perpetual
   * requestAnimationFrame loop keeps the compositor producing frames for nothing, which on
   * software GL starves the page.
   */
  private tickCamera(): void {
    let hot = 0; // frames left at full rate
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): boolean => {
      const v = this.wb.viewport as unknown as { getCameraState?: () => unknown } | null;
      const key = v?.getCameraState ? JSON.stringify(v.getCameraState()) : '';
      if (key === this.lastCam) return false;
      this.lastCam = key;
      this.camera.set((n) => n + 1);
      this.trackReferences();
      return true;
    };
    const frame = () => {
      this.raf = 0;
      if (this.disposed) return;
      if (check()) hot = 30;
      if (--hot > 0) this.raf = requestAnimationFrame(frame);
      else timer = setTimeout(slow, 200);
    };
    const slow = () => {
      timer = undefined;
      if (this.disposed) return;
      if (check()) wake();
      else timer = setTimeout(slow, 200);
    };
    const wake = () => {
      hot = 30;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(frame);
    };
    this.wakeCamera = wake;
    const host = this.wb.canvas?.parentElement;
    for (const type of ['pointerdown', 'pointermove', 'wheel'] as const) {
      const on = (e: Event) => {
        if (type !== 'pointermove' || (e as PointerEvent).buttons !== 0) wake();
      };
      host?.addEventListener(type, on, { passive: true });
      this.cleanup.push(() => host?.removeEventListener(type, on));
    }
    // View keys (1–7, 0) animate the camera too.
    window.addEventListener('keydown', wake);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', wake);
      if (timer !== undefined) clearTimeout(timer);
    });
    wake();
  }

  /** Full-rate overlay tracking for a moment (camera animations: enter sketch, frame changes). */
  private wakeCamera: () => void = () => {};

  /** Sketch-space box the axes were last drawn across. */
  private refSpan: Box2 | null = null;

  /** The visible part of the sketch plane (sketch mm), or null when the plane is edge-on. */
  private viewBox(): Box2 | null {
    const v = this.wb.viewport;
    const frame = this.ui()?.frame;
    const c = this.wb.canvas;
    if (!v || !frame || !c) return null;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!(w > 0 && h > 0)) return null;
    return boxOf(
      [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(([x, y]) => v.screenToPlane(x as number, y as number, frame)),
    );
  }

  private sketchExtent(entities: readonly SketchEntity[]): number {
    let r = 0;
    for (const e of entities) {
      if (e.kind === 'point') r = Math.max(r, Math.abs(e.x), Math.abs(e.y));
      else if (e.kind === 'circle') r = Math.max(r, e.radius);
    }
    return r;
  }

  /** The camera moved: redraw the axes once the view leaves (or shrinks well inside) their span. */
  private trackReferences(): void {
    if (!this.refSpan || spanCovers(this.refSpan, this.viewBox())) return;
    this.scheduleOverlay();
  }

  onDocChange(): void {
    const f = this.feature();
    if (!f) return;
    this.scheduleOverlay();
    // Undo/redo (or an edit from the inspector) changed the sketch: re-solve for DOF colours.
    if (
      this.solvedFor &&
      (this.solvedFor.entities !== f.entities || this.solvedFor.constraints !== f.constraints)
    )
      void this.resolve();
  }

  onRegen(result: RegenResult): void {
    const s = result.sketches.find((x) => x.featureId === this.featureId);
    const u = this.ui();
    if (s && u && !u.frame) {
      this.patch({ frame: s.frame });
      this.wb.viewport?.lookAtPlane(s.frame, true);
      this.wakeCamera();
    }
    this.scheduleOverlay();
  }

  // ------------------------------------------------------------------ solving

  /** Drawing clicks whose edit is queued behind a solve (not yet in the document). */
  private unsettled: SketchData[] = [];

  /** What drawing infers against: the document sketch plus clicks still being solved. */
  private drawData(): SketchData {
    return withPending(this.data(), this.unsettled);
  }

  private data(): SketchData {
    const f = this.feature();
    return f
      ? { entities: f.entities, constraints: f.constraints }
      : { entities: [], constraints: [] };
  }

  private async solveData(next: SketchData): Promise<SketchSolveResult> {
    const f = this.feature();
    const doc = this.wb.doc;
    const cand: SketchFeature = {
      ...(f as SketchFeature),
      entities: [...next.entities],
      constraints: [...next.constraints],
    };
    const { values } = sketchSolveValues(cand, evaluateFeatureValues(cand, doc));
    return solver().api.solve({ entities: cand.entities, constraints: cand.constraints, values });
  }

  /** Re-solves the current sketch for DOF/conflict display (no document change). */
  private resolve(): Promise<void> {
    return this.serial(async () => {
      const f = this.feature();
      if (!f || this.disposed) return;
      const res = await this.solveData(f);
      this.solvedFor = f;
      this.patch({ solve: res, conflictsDismissed: false });
      this.scheduleOverlay();
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.queue.then(fn, fn).finally(() => {
      this.pending--;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Solves/edits queued or running (an edit lands in the document only after its solve). */
  private pending = 0;

  get busy(): boolean {
    return this.pending > 0 || this.drag !== null;
  }

  /**
   * Resolves once every queued edit has been solved and written to the document and the overlay
   * shows it (tests and anything that reads geometry after an edit).
   */
  async whenSettled(): Promise<void> {
    while (this.pending > 0) await this.queue;
    while (this.drag?.inFlight) await new Promise((r) => setTimeout(r, 4));
    if (this.overlayQueued || this.pushedFor !== this.feature()?.entities) this.pushOverlay();
  }

  /**
   * Solves an edit and writes it to the document (one undo entry unless `key` coalesces). The
   * edit is a function of the sketch as it is when the edit runs, so quick successive edits (fast
   * clicks while a solve is in flight) build on each other instead of overwriting.
   */
  commitEdit(
    edit: (cur: SketchFeature) => SketchData,
    label: string | (() => string),
    key?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const f = this.feature();
      const part = this.wb.part;
      if (!f || !part || this.disposed) return;
      const next = edit(f);
      // An edit that changed nothing (a refused operation) is not an undo step.
      if (next.entities === f.entities && next.constraints === f.constraints) return;
      const res = await this.solveData(next);
      const entities = res.status === 'solved' ? res.entities : [...next.entities];
      const feature: SketchFeature = { ...f, entities, constraints: [...next.constraints] };
      this.wb.apply(
        { kind: 'updateFeature', partId: part.id, featureId: f.id, feature },
        typeof label === 'function' ? label() : label,
        key,
      );
      if (!key) this.wb.commit();
      this.solvedFor = this.feature();
      this.patch({ solve: res, conflictsDismissed: false });
      this.scheduleOverlay();
    });
  }

  // ------------------------------------------------------------------ toolbar

  /** The last tool chosen (Space and the radial menu's Repeat slot bring it back after Esc). */
  private lastTool: { tool: SketchToolId; variant: string | undefined } | null = null;

  repeatTool(): void {
    const u = this.ui();
    if (!u || !this.lastTool) return;
    if (u.tool === this.lastTool.tool && u.draw) return; // still in it
    this.setTool(this.lastTool.tool, this.lastTool.variant);
  }

  lastToolLabel(): string | null {
    return this.lastTool?.tool ?? null;
  }

  setTool(tool: SketchToolId | null, variant?: string): void {
    const u = this.ui();
    if (!u) return;
    if (tool) this.lastTool = { tool, variant: variant ?? u.variants[tool] };
    const variants = variant && tool ? { ...u.variants, [tool]: variant } : u.variants;
    const draw =
      tool && DRAW_TOOLS.has(tool)
        ? startDraw(tool as DrawToolId, variant ?? variants[tool], u.construction)
        : null;
    // Edit-menu tools start from the current selection (select first, act second).
    const f = this.feature();
    const edit = isEditTool(tool) && f ? startEdit(tool, f.entities, u.selected) : null;
    this.patch({
      tool,
      variants,
      draw,
      edit,
      dimPicks: [],
      selected: [],
      selectedConstraint: null,
    });
    this.scheduleOverlay();
    this.pushHighlights();
  }

  toggleConstruction(): void {
    const u = this.ui();
    const f = this.feature();
    if (!u || !f) return;
    if (u.selected.length > 0 && !u.draw) {
      const set = new Set(u.selected);
      const on = !f.entities.some((e) => set.has(e.id) && e.construction);
      void this.commitEdit(
        (cur) => ({
          entities: cur.entities.map((e) =>
            set.has(e.id) && e.kind !== 'point' ? { ...e, construction: on } : e,
          ),
          constraints: cur.constraints,
        }),
        on ? 'Make construction' : 'Make regular',
      );
      return;
    }
    const construction = !u.construction;
    this.patch({ construction, draw: u.draw ? { ...u.draw, construction } : null });
  }

  constrain(kind: GeometricConstraintKind): void {
    const u = this.ui();
    const f = this.feature();
    if (!u || !f) return;
    const c = constraintFrom(kind, f.entities, u.selected);
    if (!c) return;
    void this.commitEdit(
      (cur) => ({ entities: cur.entities, constraints: [...cur.constraints, c] }),
      `Add ${kind}`,
    );
  }

  enabledConstraints(): GeometricConstraintKind[] {
    const u = this.ui();
    const f = this.feature();
    return u && f ? applicableConstraints(f.entities, u.selected) : [];
  }

  /** Esc with no tool: leave the sketch. */
  finish(): void {
    this.exit(true);
  }

  deleteSelected(): void {
    const u = this.ui();
    const f = this.feature();
    if (!u || !f) return;
    if (u.selectedConstraint) {
      const id = u.selectedConstraint;
      this.patch({ selectedConstraint: null });
      void this.commitEdit(
        (cur) => ({
          entities: cur.entities,
          constraints: cur.constraints.filter((c) => c.id !== id),
        }),
        'Delete constraint',
      );
      return;
    }
    // The origin and axes can be selected but never deleted.
    const ids = u.selected.filter((id) => !isSketchReference(id));
    if (ids.length === 0) return;
    this.patch({ selected: [] });
    void this.commitEdit((cur) => removeEntities(cur, ids), 'Delete sketch geometry');
  }

  selectConstraint(id: Id | null): void {
    this.patch({ selectedConstraint: id, selected: [] });
    this.pushHighlights();
  }

  // ------------------------------------------------------------------ dimensions

  updateDimension(id: Id, expr: string, mode: 'commit' | 'preview'): void {
    if (mode === 'commit') this.patch({ editDimension: null });
    void this.commitEdit(
      (cur) => ({
        entities: cur.entities,
        constraints: cur.constraints.map((c) =>
          c.id === id && 'value' in c ? { ...c, value: expr } : c,
        ),
      }),
      'Edit dimension',
      mode === 'preview' ? `dim:${id}` : undefined,
    );
  }

  /** Where a dragged label (screen px in the overlay) lands in the sketch, or null. */
  private labelTo(id: Id, x: number, y: number): Vec2 | null {
    const v = this.wb.viewport;
    const f = this.feature();
    const frame = this.ui()?.frame;
    const c = f?.constraints.find((k) => k.id === id);
    if (!v || !f || !frame || !c || !isDimension(c)) return null;
    const at = v.screenToPlane(x, y, frame);
    return at ? dragDimensionLabel(f.entities, c, at) : null;
  }

  /** Live: the label follows the pointer. Nothing is stored and the value never changes. */
  moveDimensionLabel(id: Id, x: number, y: number): void {
    const at = this.labelTo(id, x, y);
    if (at) this.patch({ dimDrag: { id, at } });
  }

  /** The drag ended: the label position is stored (`label`) as one undo step. */
  endMoveDimensionLabel(id: Id, x: number, y: number): void {
    const at = this.labelTo(id, x, y);
    this.patch({ dimDrag: null });
    if (!at) return;
    void this.commitEdit(
      (cur) => ({
        entities: cur.entities,
        constraints: cur.constraints.map((c) =>
          c.id === id && isDimension(c) ? { ...c, label: at } : c,
        ),
      }),
      'Move dimension',
    );
  }

  doneEditingDimension(): void {
    this.patch({ editDimension: null });
    this.wb.commit();
  }

  applyFix(fix: SuggestedFix): void {
    const a = fix.action;
    const fixConstraints = (cs: readonly SketchConstraint[]): SketchConstraint[] => {
      if (a.kind === 'removeConstraint') return cs.filter((c) => c.id !== a.constraint);
      if (a.kind === 'makeReference')
        return cs.map((c) =>
          c.id === a.constraint && 'value' in c ? { ...c, driving: false } : c,
        );
      return cs.map((c) =>
        c.id === a.constraint && 'value' in c ? { ...c, value: initialExpr(c.kind, a.value) } : c,
      );
    };
    // The conflict card under the pointer unmounts with the fix, so it never sees mouseleave:
    // drop its highlight here or the sketch keeps the stale conflict colours.
    this.patch({ highlightConstraints: null, highlightEntities: null });
    this.pushHighlights();
    void this.commitEdit(
      (cur) => ({ entities: cur.entities, constraints: fixConstraints(cur.constraints) }),
      fix.label,
    );
  }

  /** Driving ↔ reference. A reference becoming driving keeps its measured value (no jump). */
  toggleDriving(id: Id): void {
    const u = this.ui();
    void this.commitEdit(
      (cur) => ({
        entities: cur.entities,
        constraints: cur.constraints.map((c) => {
          if (c.id !== id || !('value' in c)) return c;
          if (c.driving) return { ...c, driving: false };
          const measured = u?.solve?.driven[id] ?? measure(cur, c);
          return {
            ...c,
            driving: true,
            ...(measured !== null && measured !== undefined
              ? { value: initialExpr(c.kind, Math.abs(measured)) }
              : {}),
          };
        }),
      }),
      'Toggle reference dimension',
    );
    this.patch({ editDimension: null });
  }

  /** Radius ↔ diameter on a circle/arc dimension (the expression is converted). */
  toggleRadiusDiameter(id: Id): void {
    void this.commitEdit(
      (cur) => ({
        entities: cur.entities,
        constraints: cur.constraints.map((c) =>
          c.id === id && (c.kind === 'radius' || c.kind === 'diameter')
            ? {
                ...c,
                kind: c.kind === 'radius' ? 'diameter' : 'radius',
                value: convertRadiusDiameter(c.value, c.kind === 'radius'),
              }
            : c,
        ),
      }),
      'Toggle radius / diameter',
    );
  }

  /** `aligned`: Shift held — no automatic horizontal/vertical distance. */
  private placeDimension(picks: Id[], at: Vec2, aligned = false): void {
    const f = this.feature();
    if (!f) return;
    const draft = dimensionAt(f, picks, at, { aligned });
    if (!draft) {
      this.wb.toast('Those can’t be dimensioned together.', 'info');
      this.patch({ dimPicks: [] });
      return;
    }
    const value = measure(f, draft);
    if (value === null) return;
    const c = makeDimension(draft, initialExpr(draft.kind, value), at);
    this.patch({ dimPicks: [], editDimension: c.id });
    void this.commitEdit(
      (cur) => ({ entities: cur.entities, constraints: [...cur.constraints, c] }),
      'Add dimension',
      `dim:${c.id}`,
    );
  }

  // ------------------------------------------------------------------ pointer

  /** Sketch-space position of a pointer event on the sketch plane. */
  private toSketch(e: { clientX: number; clientY: number }): Vec2 | null {
    const v = this.wb.viewport;
    const frame = this.ui()?.frame;
    if (!v || !frame) return null;
    const { x, y } = this.wb.local(e);
    return v.screenToPlane(x, y, frame);
  }

  /** Pick tolerance converted to sketch millimetres at the cursor. */
  private toleranceMm(
    e: { clientX: number; clientY: number; pointerType?: string },
    at: Vec2,
  ): number {
    const v = this.wb.viewport;
    const frame = this.ui()?.frame;
    const px = toleranceFor(e.pointerType ?? 'mouse') + 2;
    if (!v || !frame) return 1;
    const { x, y } = this.wb.local(e);
    const q = v.screenToPlane(x + px, y, frame);
    return q ? Math.max(Math.hypot(q[0] - at[0], q[1] - at[1]), 1e-6) : 1;
  }

  private pickSketch(e: PointerEvent | MouseEvent): PickHit | null {
    const v = this.wb.viewport;
    if (!v) return null;
    // Sketch picks are answered from the overlay's polylines. After a solve moved the geometry the
    // overlay is only rebuilt on the next animation frame, so a click arriving first (fast input,
    // busy main thread) would hit the *old* positions: rebuild it now from the document.
    if (this.overlayQueued || this.pushedFor !== this.feature()?.entities) this.pushOverlay();
    const { x, y } = this.wb.local(e);
    const tol = toleranceFor('pointerType' in e ? e.pointerType : 'mouse') + 2;
    const hits = v
      .pick(x, y, { kinds: ['sketchPoint', 'sketchCurve'], tolerancePx: tol, all: true })
      .filter((h) => h.bodyId === this.featureId && h.entity && !h.entity.startsWith('preview:'));
    // The user's geometry always wins over the origin and axes at the same spot.
    return rankSketchHits(hits);
  }

  setHover(entity: Id | null): void {
    if (this.ui()?.hoverEntity === entity) return;
    this.patch({ hoverEntity: entity });
    this.pushHighlights();
  }

  // ------------------------------------------------------------------ Pencil and touch

  private stroke: Stroke | null = null;
  /** The Pencil has been used in this session: from then on fingers only navigate (PLAN §9.3). */
  private penUsed = false;
  /**
   * Touch drag-to-draw: where the finger went down with a drawing tool and nothing placed.
   * `before`: the drawing state from before the drag placed its first click (restored when a
   * second finger turns the gesture into navigation).
   */
  private touchStart: {
    id: number;
    x: number;
    y: number;
    placed: boolean;
    before?: SketchUi['draw'];
  } | null = null;
  /**
   * Fingers down (before the Pencil is used), with their latest position. `withheld`: its press
   * was kept from camera navigation (a drawing/dimension tool owned it).
   */
  private readonly fingers = new Map<number, { x: number; y: number; withheld: boolean }>();
  /** Two or more fingers went down together: until all are up they only navigate (D1). */
  private navigating = false;

  /**
   * A second finger landed: the one-finger action in progress is cancelled (no point, anchor,
   * line or drag), and the fingers the session withheld are handed to camera navigation, so the
   * pair pinches, pans and twists, and two/three-finger taps reach the gesture path.
   */
  private startNavigating(): void {
    this.navigating = true;
    const ts = this.touchStart;
    if (ts?.placed) {
      // A finger drag already placed its first click: take it back.
      this.patch({ draw: ts.before ?? null, cursor: null });
      this.scheduleOverlay();
    }
    this.touchStart = null;
    // Any drag ends here, moved or not: otherwise it outlives the pinch and the next one-finger
    // orbit drags the point. What was already dragged is kept, as on a release.
    this.endDrag();
    const canvas = this.wb.canvas;
    for (const [id, f] of this.fingers) {
      if (!f.withheld || !canvas) continue;
      f.withheld = false;
      const replay = new PointerEvent('pointerdown', {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: false,
        clientX: f.x,
        clientY: f.y,
        button: 0,
        buttons: 1,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      replayedPointerDowns.add(replay);
      canvas.dispatchEvent(replay);
    }
  }

  /** A finger went up or was cancelled. */
  private fingerGone(id: number): void {
    this.fingers.delete(id);
    if (this.fingers.size === 0) this.navigating = false;
  }

  private armGrab(st: Stroke, entity: Id, e: PointerEvent): void {
    const pointerId = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    const at = this.toSketch(e);
    st.grab = {
      entity,
      timer: setTimeout(() => {
        if (this.stroke !== st || st.moved || !at) return;
        // Held still: the stroke becomes a grab. The target pulses and follows the Pencil as a
        // normal solver drag (one undo step); the release ends it.
        this.stroke = null;
        st.grab = undefined;
        this.patch({ stroke: null, highlightEntities: [entity] });
        this.pushHighlights();
        this.scheduleOverlay();
        this.startDrag(entity, at, start, pointerId);
      }, GRAB_HOLD_MS),
    };
  }

  private disarmGrab(st: Stroke | null): void {
    if (st?.grab) clearTimeout(st.grab.timer);
    if (st) st.grab = undefined;
  }

  /** Begins a solver drag of `entity` from `at` (mouse, finger, or a Pencil grab). */
  private startDrag(entity: Id, at: Vec2, start: { x: number; y: number }, _pointerId: number) {
    const f = this.feature();
    if (!f) return;
    const input = {
      entities: [...f.entities],
      constraints: [...f.constraints],
      values: this.values(f),
    };
    this.drag = {
      session: solver()
        .api.beginDrag(input, entity, at)
        .then((r) => r.session),
      entity,
      key: `drag:${newId()}`,
      inFlight: false,
      pending: null,
      moved: false,
      start,
    };
  }

  private beginStroke(e: PointerEvent): void {
    const at = this.toSketch(e);
    if (!at) return;
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    this.stroke = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      samples: [{ x: at[0], y: at[1], t: e.timeStamp, pressure: e.pressure }],
      tolerance: 2 * this.pxToMm(e, at, toleranceFor('pen')),
      moved: false,
    };
  }

  private strokeMove(e: PointerEvent): void {
    const st = this.stroke;
    if (!st) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const at = this.toSketch(ev);
      if (at) st.samples.push({ x: at[0], y: at[1], t: ev.timeStamp, pressure: ev.pressure });
    }
    if (!st.moved && Math.hypot(e.clientX - st.start.x, e.clientY - st.start.y) < STROKE_SLOP_PX)
      return;
    st.moved = true;
    this.disarmGrab(st);
    // Live feedback: the ink plus what it is recognised as so far (pure, ≈ 0.2 ms).
    const rec = recognizeStroke(st.samples, { tolerance: st.tolerance });
    this.patch({
      stroke: {
        points: st.samples.map((p) => [p.x, p.y] as Vec2),
        shape: rec && rec.confidence >= MIN_CONFIDENCE ? rec.shape.kind : null,
        confidence: rec?.confidence ?? 0,
      },
    });
    this.scheduleOverlay();
  }

  /** Pen up after a stroke: recognise it and commit it through the edit queue. */
  private finishStroke(st: Stroke): void {
    const u = this.ui();
    const rec = recognizeStroke(st.samples, { tolerance: st.tolerance });
    const points = st.samples.map((p) => [p.x, p.y] as Vec2);
    const base = this.drawData();
    const result = strokeEdit(rec, points, base, st.tolerance, u?.construction ?? false);
    this.patch({
      stroke: null,
      lastStroke: rec ? { shape: rec.shape.kind, confidence: rec.confidence } : null,
    });
    this.scheduleOverlay();
    if (!result) return;
    if (result.kind === 'erase') {
      const ids = result.ids;
      this.patch({ selected: [] });
      void this.commitEdit((cur) => removeEntities(cur, ids), 'Erase sketch geometry');
      return;
    }
    const edit = result.edit;
    const pending: SketchData = { entities: edit.entities, constraints: edit.constraints };
    this.unsettled.push(pending);
    void this.commitEdit(
      (cur) => ({
        entities: [...cur.entities, ...edit.entities],
        constraints: [...cur.constraints, ...edit.constraints],
      }),
      `Draw ${result.shape}`,
    ).finally(() => {
      this.unsettled = this.unsettled.filter((x) => x !== pending);
    });
  }

  /**
   * Ends the drag in progress (if any) through the edit queue, like a release: a drag that moved
   * keeps its result as one undo step, one that didn't move just closes its solver session.
   */
  private endDrag(onStill?: (entity: Id) => void): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.ui()?.highlightEntities?.includes(d.entity)) {
      this.patch({ highlightEntities: null });
      this.pushHighlights();
    }
    void this.serial(async () => {
      const session = await d.session;
      // Let an in-flight drag step land first.
      while (d.inFlight) await new Promise((r) => setTimeout(r, 4));
      const res = await solver().api.endDrag(session);
      if (d.moved) {
        this.applyDragResult(res, d.key);
        this.wb.commit();
      } else onStill?.(d.entity);
    });
  }

  onPointerCancel(e: PointerEvent): void {
    // The system took the pointer (e.g. a gesture): never leave a drag running behind it.
    this.endDrag();
    if (this.stroke?.pointerId === e.pointerId) {
      this.disarmGrab(this.stroke);
      this.stroke = null;
      this.patch({ stroke: null });
      this.scheduleOverlay();
    }
    if (this.touchStart?.id === e.pointerId) this.touchStart = null;
    if (e.pointerType === 'touch') this.fingerGone(e.pointerId);
  }

  /** `px` CSS pixels at the pointer, in sketch millimetres. */
  private pxToMm(e: PointerEvent | MouseEvent, at: Vec2, px: number): number {
    const v = this.wb.viewport;
    const frame = this.ui()?.frame;
    if (!v || !frame) return 1;
    const { x, y } = this.wb.local(e);
    const q = v.screenToPlane(x + px, y, frame);
    return q ? Math.max(Math.hypot(q[0] - at[0], q[1] - at[1]), 1e-6) : 1;
  }

  onPointerMove(e: PointerEvent): void {
    const u = this.ui();
    if (!u) return;
    if (this.stroke?.pointerId === e.pointerId) {
      this.strokeMove(e);
      return;
    }
    if (e.pointerType === 'touch' && this.penUsed) return; // fingers navigate
    if (e.pointerType === 'touch') {
      const f = this.fingers.get(e.pointerId);
      if (f) {
        f.x = e.clientX;
        f.y = e.clientY;
      }
      if (this.navigating) return; // a pinch / pan: the camera's
    }
    const ts = this.touchStart;
    if (ts && ts.id === e.pointerId && !ts.placed && u.draw) {
      if (Math.hypot(e.clientX - ts.x, e.clientY - ts.y) > TOUCH_DRAG_PX) {
        // A finger drag draws: the shape starts where the finger went down.
        ts.placed = true;
        ts.before = u.draw;
        this.drawClickAt({ clientX: ts.x, clientY: ts.y, pointerType: 'touch' }, u);
        return; // the next move rubber-bands from the placed corner
      }
    }
    const at = this.toSketch(e);
    if (this.drag && at) {
      this.dragTo(at, e);
      return;
    }
    if (e.buttons !== 0 && !u.draw) return; // orbiting
    if (u.draw && at) {
      const draw = drawMove(u.draw, this.drawData(), at, this.toleranceMm(e, at));
      this.patch({ draw, cursor: draw.cursor });
      this.scheduleOverlay();
      return;
    }
    if (at) this.patch({ cursor: at });
    const hit = this.pickSketch(e);
    this.setHover(hit?.entity ?? null);
  }

  onPointerDown(e: PointerEvent): void {
    const u = this.ui();
    if (!u || e.button !== 0) return;
    if (e.pointerType === 'pen') {
      this.penUsed = true;
      // With a tool selected the Pencil uses it, like a finger (drag to draw, tap to place,
      // dimension picks). With no tool it draws freehand strokes that are recognised (a stroke
      // may start on a corner and snap to it); a tap selects, and a press on *selected* geometry
      // drags it.
      if (!u.draw && u.tool !== 'dimension') {
        const picked = this.pickSketch(e)?.entity;
        const grabbable = picked && !isSketchReference(picked) ? picked : null;
        const onSelected = grabbable !== null && u.selected.includes(grabbable);
        if (!onSelected) {
          e.stopPropagation();
          e.preventDefault();
          this.beginStroke(e);
          // Held still on geometry: grab it. Moving first is a stroke (snapping to a node).
          if (grabbable && this.stroke) this.armGrab(this.stroke, grabbable, e);
          return;
        }
      }
    } else if (e.pointerType === 'touch' && this.penUsed) {
      return; // fingers never draw while the Pencil is in use: they only navigate
    } else if (e.pointerType === 'touch') {
      // Only a lone finger draws (or drags, or picks). A second one makes it navigation.
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, withheld: false });
      if (this.navigating || this.fingers.size > 1) {
        if (!this.navigating) this.startNavigating();
        return; // this finger goes to the camera as it is
      }
    }
    const withhold = () => {
      e.stopPropagation();
      e.preventDefault();
      const f = this.fingers.get(e.pointerId);
      if (f && e.pointerType === 'touch') f.withheld = true;
    };
    if (u.edit) {
      // Edit tools pick on release. Convert picks the model, so a drag there still orbits.
      if (u.edit.tool !== 'convert') withhold();
      return;
    }
    if (u.draw || u.tool === 'dimension') {
      // Drawing owns the left button: no orbit.
      withhold();
      if (
        (e.pointerType === 'touch' || e.pointerType === 'pen') &&
        u.draw &&
        u.draw.anchors.length === 0 &&
        !u.draw.chainFrom
      )
        this.touchStart = { id: e.pointerId, x: e.clientX, y: e.clientY, placed: false };
      return;
    }
    const hit = this.pickSketch(e);
    const at = this.toSketch(e);
    if (!hit?.entity || !at) return; // empty space: orbit
    // The origin and axes are selectable (on release) but never dragged.
    if (isSketchReference(hit.entity)) return;
    withhold();
    if (!this.feature()) return;
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    this.startDrag(hit.entity, at, { x: e.clientX, y: e.clientY }, e.pointerId);
  }

  private values(f: SketchFeature): Record<Id, number> {
    return sketchSolveValues(f, evaluateFeatureValues(f, this.wb.doc)).values;
  }

  private dragTo(at: Vec2, e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < 3) return;
    d.moved = true;
    if (d.inFlight) {
      d.pending = at;
      return;
    }
    d.inFlight = true;
    void (async () => {
      let to: Vec2 | null = at;
      while (to && this.drag === d) {
        d.pending = null;
        const session = await d.session;
        const res = await solver().api.drag(session, to);
        this.applyDragResult(res, d.key);
        to = d.pending;
      }
      d.inFlight = false;
    })();
  }

  private applyDragResult(res: SketchSolveResult, key: string): void {
    const f = this.feature();
    const part = this.wb.part;
    if (!f || !part || res.status === 'failed') return;
    this.wb.apply(
      {
        kind: 'updateFeature',
        partId: part.id,
        featureId: f.id,
        feature: { ...f, entities: res.entities },
      },
      'Drag sketch geometry',
      key,
    );
    this.solvedFor = this.feature();
    this.patch({ solve: res });
  }

  onPointerUp(
    e: PointerEvent,
    down: { x: number; y: number; id: number; type: string } | null,
  ): void {
    const u = this.ui();
    if (!u) return;
    const st = this.stroke;
    if (st && st.pointerId === e.pointerId) {
      this.disarmGrab(st);
      this.stroke = null;
      e.stopPropagation();
      if (st.moved) {
        this.finishStroke(st);
        return;
      }
      // A Pencil tap: a click for the tool (or a selection), as with the mouse.
      this.patch({ stroke: null });
    } else if (e.pointerType === 'touch' && this.penUsed) return;
    if (this.touchStart?.id === e.pointerId) this.touchStart = null;
    if (e.pointerType === 'touch') {
      const navigated = this.navigating;
      this.fingerGone(e.pointerId);
      // Part of a pinch / pan / multi-finger tap: no click for the tool, and camera navigation
      // must see the release (no stopPropagation).
      if (navigated) {
        this.endDrag();
        return;
      }
    }
    if (this.drag) {
      e.stopPropagation();
      // Queued like any edit, so the final drag result lands before anything after the release
      // (an immediate undo, a dimension, `whenSettled`) — never after it as a separate step.
      this.endDrag((entity) => this.selectEntity(entity, e.shiftKey));
      return;
    }
    // Only this pointer's own press counts (never another finger's or the pen's).
    if (e.button !== 0 || !down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
    if (u.edit) {
      e.stopPropagation();
      if (moved) return;
      const { x, y } = this.wb.local(e);
      const hit = u.edit.tool === 'convert' ? null : this.pickSketch(e);
      void this.wb.track(
        this.edits.click(hit, this.toSketch(e), { x, y, pointerType: e.pointerType }),
      );
      return;
    }
    if (u.draw) {
      e.stopPropagation();
      if (moved && down.type === 'mouse') return;
      this.drawClickAt(e, this.ui() ?? u);
      return;
    }
    if (u.tool === 'dimension') {
      e.stopPropagation();
      const hit = this.pickSketch(e);
      const at = this.toSketch(e) ?? [0, 0];
      if (hit?.entity) {
        // Up to two entities; a click in empty space then places the label (and, for two points
        // or an oblique line, its position picks horizontal / vertical / aligned).
        const picks = [...u.dimPicks.filter((p) => p !== hit.entity), hit.entity].slice(-2);
        this.patch({ dimPicks: picks });
        this.pushHighlights();
        return;
      }
      if (u.dimPicks.length === 0) return;
      this.placeDimension(u.dimPicks, at, e.shiftKey);
      this.pushHighlights();
      return;
    }
    if (moved) return;
    const hit = this.pickSketch(e);
    if (hit?.entity) this.selectEntity(hit.entity, e.shiftKey || e.metaKey || e.ctrlKey);
    else this.patch({ selected: [], selectedConstraint: null });
    this.pushHighlights();
  }

  /** A drawing click at a client point (tap, click, Pencil tap, or a finger drag's ends). */
  private drawClickAt(
    e: { clientX: number; clientY: number; pointerType: string },
    u: SketchUi,
  ): void {
    if (!u.draw) return;
    const at = this.toSketch(e);
    if (!at) return;
    const base = this.drawData();
    const state = drawMove(u.draw, base, at, this.toleranceMm(e, at));
    // A spline ends on a double-tap or double-click (open); its second tap adds no point.
    const prev = this.lastTap;
    this.lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
    if (
      isSplineTool(u.draw.tool) &&
      u.draw.anchors.length > 0 &&
      prev &&
      performance.now() - prev.t < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX
    ) {
      this.lastTap = null;
      this.finishShape();
      return;
    }
    const r = drawClick(state, base);
    this.patch({ draw: r.state, cursor: r.state.cursor });
    this.commitDrawEdit(r.edit, u.tool);
    this.scheduleOverlay();
  }

  private lastTap: { t: number; x: number; y: number } | null = null;

  /** Enter or a double-tap: ends the spline being drawn. Returns whether there was one. */
  finishShape(): boolean {
    const u = this.ui();
    if (!u?.draw) return false;
    const r = drawFinish(u.draw);
    if (!r) return false;
    this.patch({ draw: r.state, cursor: r.state.cursor });
    this.commitDrawEdit(r.edit, u.tool);
    this.scheduleOverlay();
    return true;
  }

  private commitDrawEdit(edit: SketchEdit | null, tool: SketchToolId | null): void {
    if (edit) {
      const pending: SketchData = { entities: edit.entities, constraints: edit.constraints };
      this.unsettled.push(pending);
      void this.commitEdit(
        (cur) => ({
          entities: [...cur.entities, ...edit.entities],
          constraints: [...cur.constraints, ...edit.constraints],
        }),
        `Draw ${tool ?? 'geometry'}`,
      ).finally(() => {
        this.unsettled = this.unsettled.filter((x) => x !== pending);
      });
    }
  }

  onDoubleClick(e: MouseEvent): void {
    const u = this.ui();
    if (!u?.draw) return;
    e.stopPropagation();
    if (this.finishShape()) return;
    const next = cancelDraw(u.draw);
    if (next) this.patch({ draw: next });
    this.scheduleOverlay();
  }

  private selectEntity(id: Id, additive: boolean): void {
    const u = this.ui();
    if (!u) return;
    const selected = additive
      ? u.selected.includes(id)
        ? u.selected.filter((x) => x !== id)
        : [...u.selected, id]
      : [id];
    this.patch({ selected, selectedConstraint: null });
    this.pushHighlights();
  }

  /** Esc inside a drawing tool: drop the shape in progress, else leave the tool. */
  escapeTool(): boolean {
    const u = this.ui();
    if (!u) return false;
    // An edit tool: first Esc drops its picks, the next leaves the tool.
    if (u.edit && (u.edit.picks.length || u.edit.model.length || u.edit.axis)) {
      this.patch({ edit: { ...u.edit, picks: [], model: [], axis: null, phase: 'entities' } });
      this.pushHighlights();
      return true;
    }
    if (u.draw) {
      const next = cancelDraw(u.draw);
      if (next) {
        this.patch({ draw: next });
        this.scheduleOverlay();
        return true;
      }
    }
    if (u.dimPicks.length) {
      this.patch({ dimPicks: [] });
      this.pushHighlights();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ display

  scheduleOverlay(): void {
    if (this.overlayQueued) return;
    this.overlayQueued = true;
    requestAnimationFrame(() => {
      this.overlayQueued = false;
      if (!this.disposed) this.pushOverlay();
    });
  }

  private pushOverlay(): void {
    const v = this.wb.viewport;
    const u = this.ui();
    const f = this.feature();
    if (!v || !u || !f || !u.frame) return;
    const prev = u.draw ? preview(u.draw, f) : null;
    const ink = u.stroke ? this.strokePreview(u.stroke) : [];
    const entities = [...f.entities, ...(prev?.entities ?? []), ...ink];
    const regen = this.wb.regen.get()?.result.sketches.find((s) => s.featureId === f.id);
    const dof: Record<string, 'free' | 'partial' | 'fixed'> = { ...(u.solve?.entityDof ?? {}) };
    for (const e of prev?.entities ?? []) dof[e.id] = 'free';
    for (const e of ink) dof[e.id] = 'free';
    const conflicting = new Set<string>();
    for (const c of u.solve?.conflicts ?? [])
      for (const id of c.constraints) {
        const k = f.constraints.find((x) => x.id === id);
        if (k)
          for (const [key, val] of Object.entries(k))
            if (key !== 'id' && typeof val === 'string' && f.entities.some((e) => e.id === val))
              conflicting.add(val);
      }
    this.pushedFor = f.entities;
    // Reference geometry (ADR-017): the axes across the visible view, the origin glyph and dot.
    const own = sketchCurves(entities, u.frame);
    const view = this.viewBox();
    const span = axisSpan(view, this.sketchExtent(f.entities));
    this.refSpan = span;
    const size = Math.max(span.max[0] - span.min[0], span.max[1] - span.min[1]);
    const refs = referenceOverlay(u.frame, span, size / 80);
    for (const c of refs.curves) dof[c.entity] = 'fixed';
    for (const p of refs.points ?? []) dof[p.entity] = 'fixed';
    v.setSketch(f.id, {
      sketch: {
        featureId: f.id,
        // References first: the user's geometry draws over them.
        curves: [...refs.curves, ...own.curves],
        points: [...(refs.points ?? []), ...(own.points ?? [])],
        regions: regen?.regions.length ? regen.regions : [],
        frame: u.frame,
      },
      dof,
      conflicting: [...conflicting],
      active: true,
    });
    this.pushHighlights();
  }

  /**
   * Live Pencil feedback: the ink as a construction polyline and, once recognised, the cleaned-up
   * shape on top of it (preview ids, never picked or saved).
   */
  private strokePreview(stroke: NonNullable<SketchUi['stroke']>): SketchEntity[] {
    const pts = stroke.points;
    const out: SketchEntity[] = [];
    const step = Math.max(1, Math.ceil(pts.length / 200));
    let prevId: Id | null = null;
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i] as Vec2;
      const id = `preview:ink:${i}`;
      out.push({ id, kind: 'point', construction: true, x: p[0], y: p[1] });
      if (prevId)
        out.push({ id: `${id}:l`, kind: 'line', construction: true, start: prevId, end: id });
      prevId = id;
    }
    if (stroke.shape && this.stroke) {
      const rec = recognizeStroke(this.stroke.samples, { tolerance: this.stroke.tolerance });
      let n = 0;
      const frag = rec ? strokeFragment(rec, { id: () => `preview:shape:${n++}` }) : null;
      if (frag) out.push(...frag.entities);
    }
    return out;
  }

  pushHighlights(): void {
    const v = this.wb.viewport;
    const u = this.ui();
    const f = this.feature();
    if (!v || !u || !f) return;
    const item = (id: Id): HighlightItem | null => {
      if (isSketchReference(id))
        return {
          bodyId: f.id,
          kind: id === SKETCH_ORIGIN ? 'sketchPoint' : 'sketchCurve',
          index: 0,
          entity: id,
        };
      const e = f.entities.find((x) => x.id === id);
      if (!e) return null;
      return {
        bodyId: f.id,
        kind: e.kind === 'point' ? 'sketchPoint' : 'sketchCurve',
        index: 0,
        entity: id,
      };
    };
    const selectedIds = [
      ...u.selected,
      ...u.dimPicks,
      ...(u.edit?.picks ?? []),
      ...(u.edit?.axis ? [u.edit.axis] : []),
    ];
    const c = u.selectedConstraint
      ? f.constraints.find((x) => x.id === u.selectedConstraint)
      : null;
    if (c)
      for (const [k, val] of Object.entries(c))
        if (
          k !== 'id' &&
          typeof val === 'string' &&
          (isSketchReference(val) || f.entities.some((e) => e.id === val))
        )
          selectedIds.push(val);
    for (const id of u.highlightEntities ?? []) selectedIds.push(id);
    for (const id of u.highlightConstraints ?? []) {
      const k = f.constraints.find((x) => x.id === id);
      if (k)
        for (const [key, val] of Object.entries(k))
          if (key !== 'id' && typeof val === 'string') selectedIds.push(val);
    }
    const selected = selectedIds.map(item).filter((x): x is HighlightItem => !!x);
    // Model edges / a face picked for Convert entities.
    for (const p of u.edit?.model ?? [])
      selected.push({ bodyId: p.bodyId, kind: p.kind, index: p.index });
    const hover = u.hoverEntity ? item(u.hoverEntity) : null;
    v.setHighlights({ selected, preselected: hover ? [hover] : [] });
  }

  /** World position of a sketch point (for HTML overlays). */
  world(p: Vec2) {
    const frame = this.ui()?.frame;
    return frame ? toWorld(frame, p) : null;
  }
}
