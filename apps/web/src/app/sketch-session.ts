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
  SuggestedFix,
  Vec2,
} from '@whittle/contracts';
import { evaluateFeatureValues, sketchSolveValues } from '@whittle/document';
import { createSketchSolverClient, newId, type SketchSolverClient } from '@whittle/sketch';
import type { GeometricConstraintKind, SketchToolId } from '@whittle/ui';
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
  move as drawMove,
  preview,
  type SketchData,
  startDraw,
} from '../sketch/draw';
import { sketchCurves } from '../sketch/overlay';
import { observable } from './observable';
import type { SketchUi } from './state';
import type { Workbench } from './workbench';

let solverClient: SketchSolverClient | null = null;
function solver(): SketchSolverClient {
  solverClient ??= createSketchSolverClient();
  return solverClient;
}

const DRAW_TOOLS = new Set<string>(['line', 'rectangle', 'circle', 'arc', 'slot', 'polygon']);

interface DragState {
  session: Promise<number>;
  entity: Id;
  key: string;
  inFlight: boolean;
  pending: Vec2 | null;
  moved: boolean;
  start: { x: number; y: number };
}

/** Which constraints the current entity selection can take. */
export function applicableConstraints(
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
  const sel = selected.map((id) => entities.find((e) => e.id === id)).filter((e) => !!e);
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

  constructor(
    private readonly wb: Workbench,
    readonly featureId: Id,
    private readonly isNew: boolean,
  ) {}

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
    const sketch: SketchUi = {
      featureId: f.id,
      frame,
      tool: this.isNew ? 'line' : null,
      variants: {},
      construction: false,
      draw: this.isNew ? startDraw('line') : null,
      dimPicks: [],
      cursor: null,
      selected: [],
      selectedConstraint: null,
      hoverEntity: null,
      solve: null,
      editDimension: null,
      highlightConstraints: null,
      conflictsDismissed: false,
      isNew: this.isNew,
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
  commitEdit(edit: (cur: SketchFeature) => SketchData, label: string, key?: string): Promise<void> {
    return this.serial(async () => {
      const f = this.feature();
      const part = this.wb.part;
      if (!f || !part || this.disposed) return;
      const next = edit(f);
      const res = await this.solveData(next);
      const entities = res.status === 'solved' ? res.entities : [...next.entities];
      const feature: SketchFeature = { ...f, entities, constraints: [...next.constraints] };
      this.wb.apply(
        { kind: 'updateFeature', partId: part.id, featureId: f.id, feature },
        label,
        key,
      );
      if (!key) this.wb.commit();
      this.solvedFor = this.feature();
      this.patch({ solve: res, conflictsDismissed: false });
      this.scheduleOverlay();
    });
  }

  // ------------------------------------------------------------------ toolbar

  setTool(tool: SketchToolId | null, variant?: string): void {
    const u = this.ui();
    if (!u) return;
    const variants = variant && tool ? { ...u.variants, [tool]: variant } : u.variants;
    const draw =
      tool && DRAW_TOOLS.has(tool)
        ? startDraw(tool as DrawToolId, variant ?? variants[tool], u.construction)
        : null;
    this.patch({ tool, variants, draw, dimPicks: [], selected: [], selectedConstraint: null });
    this.scheduleOverlay();
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
    if (u.selected.length === 0) return;
    const ids = u.selected;
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
    this.patch({ highlightConstraints: null });
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
  private toleranceMm(e: PointerEvent | MouseEvent, at: Vec2): number {
    const v = this.wb.viewport;
    const frame = this.ui()?.frame;
    const px = toleranceFor('pointerType' in e ? e.pointerType : 'mouse') + 2;
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
    hits.sort((a, b) =>
      a.kind === b.kind ? a.distancePx - b.distancePx : a.kind === 'sketchPoint' ? -1 : 1,
    );
    return hits[0] ?? null;
  }

  setHover(entity: Id | null): void {
    if (this.ui()?.hoverEntity === entity) return;
    this.patch({ hoverEntity: entity });
    this.pushHighlights();
  }

  onPointerMove(e: PointerEvent): void {
    const u = this.ui();
    if (!u) return;
    const at = this.toSketch(e);
    if (this.drag && at) {
      this.dragTo(at, e);
      return;
    }
    if (e.buttons !== 0 && !u.draw) return; // orbiting
    if (u.draw && at) {
      const draw = drawMove(u.draw, this.data(), at, this.toleranceMm(e, at));
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
    if (u.draw || u.tool === 'dimension') {
      // Drawing owns the left button: no orbit.
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const hit = this.pickSketch(e);
    const at = this.toSketch(e);
    if (!hit?.entity || !at) return; // empty space: orbit
    e.stopPropagation();
    e.preventDefault();
    const f = this.feature();
    if (!f) return;
    const entity = hit.entity;
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
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
      start: { x: e.clientX, y: e.clientY },
    };
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
    const d = this.drag;
    if (d) {
      this.drag = null;
      e.stopPropagation();
      void (async () => {
        const session = await d.session;
        // Let an in-flight drag step land first.
        while (d.inFlight) await new Promise((r) => setTimeout(r, 4));
        const res = await solver().api.endDrag(session);
        if (d.moved) {
          this.applyDragResult(res, d.key);
          this.wb.commit();
        } else this.selectEntity(d.entity, e.shiftKey);
      })();
      return;
    }
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
    if (u.draw) {
      e.stopPropagation();
      if (moved && down.type === 'mouse') return;
      const at = this.toSketch(e);
      if (!at) return;
      const state = drawMove(u.draw, this.data(), at, this.toleranceMm(e, at));
      const r = drawClick(state, this.data());
      this.patch({ draw: r.state, cursor: r.state.cursor });
      const edit = r.edit;
      if (edit) {
        void this.commitEdit(
          (cur) => ({
            entities: [...cur.entities, ...edit.entities],
            constraints: [...cur.constraints, ...edit.constraints],
          }),
          `Draw ${u.tool ?? 'geometry'}`,
        );
      }
      this.scheduleOverlay();
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

  onDoubleClick(e: MouseEvent): void {
    const u = this.ui();
    if (!u?.draw) return;
    e.stopPropagation();
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
    const entities = prev ? [...f.entities, ...prev.entities] : f.entities;
    const regen = this.wb.regen.get()?.result.sketches.find((s) => s.featureId === f.id);
    const dof: Record<string, 'free' | 'partial' | 'fixed'> = { ...(u.solve?.entityDof ?? {}) };
    for (const e of prev?.entities ?? []) dof[e.id] = 'free';
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
    v.setSketch(f.id, {
      sketch: {
        featureId: f.id,
        ...sketchCurves(entities, u.frame),
        regions: regen?.regions.length ? regen.regions : [],
        frame: u.frame,
      },
      dof,
      conflicting: [...conflicting],
      active: true,
    });
    this.pushHighlights();
  }

  pushHighlights(): void {
    const v = this.wb.viewport;
    const u = this.ui();
    const f = this.feature();
    if (!v || !u || !f) return;
    const item = (id: Id): HighlightItem | null => {
      const e = f.entities.find((x) => x.id === id);
      if (!e) return null;
      return {
        bodyId: f.id,
        kind: e.kind === 'point' ? 'sketchPoint' : 'sketchCurve',
        index: 0,
        entity: id,
      };
    };
    const selectedIds = [...u.selected, ...u.dimPicks];
    const c = u.selectedConstraint
      ? f.constraints.find((x) => x.id === u.selectedConstraint)
      : null;
    if (c)
      for (const [k, val] of Object.entries(c))
        if (k !== 'id' && typeof val === 'string' && f.entities.some((e) => e.id === val))
          selectedIds.push(val);
    for (const id of u.highlightConstraints ?? []) {
      const k = f.constraints.find((x) => x.id === id);
      if (k)
        for (const [key, val] of Object.entries(k))
          if (key !== 'id' && typeof val === 'string') selectedIds.push(val);
    }
    const selected = selectedIds.map(item).filter((x): x is HighlightItem => !!x);
    const hover = u.hoverEntity ? item(u.hoverEntity) : null;
    v.setHighlights({ selected, preselected: hover ? [hover] : [] });
  }

  /** World position of a sketch point (for HTML overlays). */
  world(p: Vec2) {
    const frame = this.ui()?.frame;
    return frame ? toWorld(frame, p) : null;
  }
}
