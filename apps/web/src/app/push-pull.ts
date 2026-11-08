/**
 * Push/pull direct editing (PLAN §9.2, §12 M2; ADR-009 item 3, ADR-014): an arrow handle on the
 * selected flat face(s), a drag with a same-frame GPU prism preview and the value chip, and on
 * release (or a typed value) a `PushPullFeature` the kernel regenerates exactly.
 *
 * The drag follows the viewport recipe: the pointer delta is projected onto the screen image of
 * the face normal, `setPreview` / `setHandle` are called in the pointer handler itself (neither
 * allocates after the first build), and the React chrome (value chip) catches up once per frame.
 */

import type { EntityRef, PickHit, Vec3 } from '@whittle/contracts';
import { newPushPull } from '../features/factories';
import { partDiagonal } from '../model/attention';
import { distanceExpr, dragDistance, groupByNormal, snapDistance } from '../model/faces';
import { hitKey } from '../selection/pick';
import type { PushPullUi } from './state';
import type { Workbench } from './workbench';

const HANDLE = 'pp';

const along = (p: Vec3, n: Vec3, d: number): Vec3 => [
  p[0] + n[0] * d,
  p[1] + n[1] * d,
  p[2] + n[2] * d,
];

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  start: number;
  axis: { x: number; y: number };
  axisMm: number;
  moved: boolean;
}

export class PushPullTool {
  private drag: Drag | null = null;
  private previewIds: string[] = [];
  /** Previews stay up after a commit until the regen that contains the feature lands. */
  private committedAt: unknown = null;
  private raf = 0;

  constructor(private readonly wb: Workbench) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  private state(): PushPullUi | null {
    return this.wb.ui.get().pushPull;
  }

  /**
   * Shows the arrow on these faces (all flat, one body). `quiet`: no note when they don't qualify
   * (a tap on another face while push/pull is on). Returns whether push/pull started.
   */
  start(hits: readonly PickHit[], quiet = false): boolean {
    const faces = hits.filter((h) => h.kind === 'face');
    const first = faces[0];
    if (!first) return false;
    if (faces.some((h) => h.bodyId !== first.bodyId)) {
      if (!quiet) this.wb.toast('Push/pull moves faces of one body at a time.', 'info');
      return false;
    }
    const infos = faces.map((h) => ({ h, f: this.wb.face(h.bodyId, h.index) }));
    if (infos.some((x) => !x.f?.planar)) {
      if (!quiet)
        this.wb.toast('Push/pull moves flat faces. Pick a flat face to push or pull.', 'info');
      return false;
    }
    this.clearPreviews();
    this.committedAt = null;
    this.startedFor = this.wb.regen.get()?.doc ?? null;
    const f0 = infos[0]?.f;
    if (!f0) return false;
    const known = new Map(this.wb.ui.get().selection.map((s) => [s.key, s.ref]));
    const pp: PushPullUi = {
      bodyId: first.bodyId,
      faces: infos.map(({ h, f }) => ({
        index: h.index,
        normal: f?.normal ?? f0.normal,
        ref: known.get(hitKey(h)) ?? null,
      })),
      origin: f0.centroid,
      normal: f0.normal,
      distance: 0,
      expr: '0 mm',
      dragging: false,
    };
    this.wb.patchUi({
      pushPull: pp,
      selection: faces.map((h) => ({ key: hitKey(h), hit: h, ref: known.get(hitKey(h)) ?? null })),
      prompt: null,
      picking: null,
      featureId: null,
      bubble: null,
      hover: null,
    });
    this.wb.pushHighlights();
    this.show(0);
    void this.wb.track(this.resolveRefs(faces));
    return true;
  }

  /** Face references for the feature (the engine names them); fetched while the user drags. */
  private async resolveRefs(faces: readonly PickHit[]): Promise<void> {
    const refs = await Promise.all(faces.map((h) => this.wb.refFor(h)));
    this.wb.ui.set((u) =>
      u.pushPull
        ? {
            ...u,
            pushPull: {
              ...u.pushPull,
              faces: u.pushPull.faces.map((f, i) => ({ ...f, ref: f.ref ?? refs[i] ?? null })),
            },
          }
        : u,
    );
  }

  /** Handle and previews at `distance` (mm). Synchronous: same frame as the input. */
  private show(distance: number): void {
    const v = this.wb.viewport;
    const pp = this.state();
    if (!v || !pp) return;
    v.setHandle(HANDLE, {
      kind: 'arrow',
      origin: along(pp.origin, pp.normal, distance),
      direction: pp.normal,
    });
    const groups = groupByNormal(pp.faces);
    const ids = groups.map((_, k) => `${HANDLE}:${k}`);
    for (const id of this.previewIds) if (!ids.includes(id)) v.setPreview(id, null);
    this.previewIds = distance === 0 ? [] : ids;
    groups.forEach((g, k) => {
      v.setPreview(
        `${HANDLE}:${k}`,
        distance === 0
          ? null
          : { kind: 'prism', bodyId: pp.bodyId, faces: g.faces, direction: g.normal, distance },
      );
    });
  }

  private clearPreviews(): void {
    const v = this.wb.viewport;
    for (const id of this.previewIds) v?.setPreview(id, null);
    this.previewIds = [];
  }

  /** Where the value chip goes: beside the arrow's tip (stage px). */
  chipPoint(): { x: number; y: number } | null {
    const pp = this.state();
    if (!pp) return null;
    const base = along(pp.origin, pp.normal, pp.distance);
    const a = this.wb.project(base);
    if (!a) return null;
    const b = this.wb.project(along(base, pp.normal, this.axisMm()));
    if (!b) return a;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 4) return a;
    const len = 84; // the handle's on-screen length (HandleSpec default)
    return { x: a.x + ((b.x - a.x) / l) * len, y: a.y + ((b.y - a.y) / l) * len };
  }

  private axisMm(): number {
    return Math.max(partDiagonal(this.wb.regen.get()?.result) * 0.1, 1);
  }

  // ---------------------------------------------------------------- drag

  onPointerDown(e: PointerEvent): boolean {
    const pp = this.state();
    const v = this.wb.viewport;
    if (!pp || !v || e.button !== 0) return false;
    const { x, y } = this.wb.local(e);
    const onHandle = this.wb
      .pickAt(x, y, e.pointerType, ['handle'], false)
      .some((h) => h.kind === 'handle' && (h.entity ?? h.bodyId) === HANDLE);
    if (!onHandle) return false;
    const base = along(pp.origin, pp.normal, pp.distance);
    const axisMm = this.axisMm();
    const a = v.worldToScreen(base);
    const b = v.worldToScreen(along(base, pp.normal, axisMm));
    this.drag = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      start: pp.distance,
      axis: { x: b.x - a.x, y: b.y - a.y },
      axisMm,
      moved: false,
    };
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    this.wb.patchUi({ pushPull: { ...pp, dragging: true } });
    return true;
  }

  onPointerMove(e: PointerEvent): boolean {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    const delta = dragDistance({ dx: e.clientX - d.x, dy: e.clientY - d.y }, d.axis, d.axisMm);
    if (delta === null) return true;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return true;
    d.moved = true;
    const distance = snapDistance(d.start + delta);
    this.show(distance); // same frame as the pointer event
    this.queueUi(distance);
    return true;
  }

  /** The chip and the inspector catch up at most once per frame. */
  private queueUi(distance: number): void {
    this.pendingDistance = distance;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flushUi();
    });
  }

  private pendingDistance: number | null = null;

  private flushUi(): void {
    const distance = this.pendingDistance;
    this.pendingDistance = null;
    if (distance === null) return;
    this.wb.ui.set((u) =>
      u.pushPull
        ? { ...u, pushPull: { ...u.pushPull, distance, expr: distanceExpr(distance) } }
        : u,
    );
  }

  onPointerUp(e: PointerEvent): boolean {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return false;
    this.drag = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flushUi();
    const pp = this.state();
    if (!pp) return true;
    this.wb.patchUi({ pushPull: { ...pp, dragging: false } });
    // A tap on the arrow without a drag leaves it for typing a value on the chip.
    if (d.moved && pp.distance !== 0) void this.commit(pp.expr);
    return true;
  }

  onPointerCancel(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const pp = this.state();
    if (pp) {
      this.wb.patchUi({ pushPull: { ...pp, dragging: false, distance: d.start } });
      this.show(d.start);
    }
  }

  // ---------------------------------------------------------------- typed values

  /** The chip's field changed (preview only). */
  preview(expr: string): void {
    const r = this.wb.evaluate(expr, 'length');
    if (!r.ok) return;
    this.show(r.value);
  }

  /** The chip's typed value was cancelled: back to the current distance. */
  revert(): void {
    this.show(this.state()?.distance ?? 0);
  }

  /** Records the push/pull with this distance (the expression is kept, e.g. `2 * thickness`). */
  commit(expr: string): Promise<void> {
    return this.wb.track(this.record(expr));
  }

  private async record(expr: string): Promise<void> {
    const pp = this.state();
    const part = this.wb.part;
    if (!pp || !part) return;
    const r = this.wb.evaluate(expr, 'length');
    if (!r.ok) {
      this.wb.toast(r.error.message, 'error');
      return;
    }
    if (Math.abs(r.value) < 1e-9) {
      this.cancel();
      return;
    }
    this.show(r.value);
    const refs: EntityRef[] = [];
    for (const f of pp.faces) {
      const ref =
        f.ref ??
        (await this.wb.refFor({
          bodyId: pp.bodyId,
          kind: 'face',
          index: f.index,
          point: pp.origin,
          distancePx: 0,
        }));
      if (ref) refs.push(ref);
    }
    if (refs.length !== pp.faces.length) {
      this.cancel();
      this.wb.toast('That face can’t be referenced yet — try again in a moment.', 'info');
      return;
    }
    const feature = newPushPull(part, refs, expr.trim());
    if (!this.wb.apply({ kind: 'addFeature', partId: part.id, feature }, `Push/pull ${expr}`)) {
      this.cancel();
      return;
    }
    this.wb.commit();
    // The preview stays until the regen with the feature replaces it.
    this.committedAt = this.wb.doc;
    this.wb.viewport?.setHandle(HANDLE, null);
    this.wb.patchUi({ pushPull: null, selection: [], hover: null });
    this.wb.pushHighlights();
    if (!(await this.wb.whenLive())) return;
    this.clearPreviews();
    const status = this.wb.treeStatuses.get()?.find((s) => s.featureId === feature.id);
    if (status?.state === 'error' && status.error) {
      const hint = status.error.hint ? ` ${status.error.hint}` : '';
      this.wb.toast(`${status.error.message}${hint}`, 'error');
    }
  }

  /** Ends push/pull without recording anything. */
  cancel(): void {
    this.drag = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pendingDistance = null;
    this.clearPreviews();
    this.committedAt = null;
    this.wb.viewport?.setHandle(HANDLE, null);
    if (this.state()) this.wb.patchUi({ pushPull: null });
  }

  /** A regen landed: drop a committed preview, and end a session whose face moved away. */
  onRegen(): void {
    const view = this.wb.regen.get();
    if (this.committedAt && view?.source === 'live' && view.doc === this.committedAt) {
      this.clearPreviews();
      this.committedAt = null;
    }
    // The document changed under an open push/pull (undo, an inspector edit): its face
    // ordinals belong to the old geometry.
    if (this.state() && !this.drag && view && view.doc !== this.startedFor) this.cancel();
  }

  /** The document the open push/pull's faces were picked in. */
  private startedFor: unknown = null;
}
