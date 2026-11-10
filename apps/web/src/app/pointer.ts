/**
 * Pointer input and selection: picking, hover, box selection, pen hold, gestures and the reference chooser.
 */

import type {
  CircularPatternFeature,
  EntityRef,
  Feature,
  Id,
  LinearPatternFeature,
  MirrorFeature,
  PickHit,
  PickKind,
  ViewportGesture,
} from '@wren-cad/contracts';
import { FEATURE_PICKS, TOOL_NEEDS } from '../features/factories';
import { partDiagonal } from '../model/attention';
import {
  type Accepts,
  acceptsFor,
  applyPick,
  hitKey,
  orderStackedRegions,
  refForHit,
  resolvePick,
  toleranceFor,
} from '../selection/pick';
import { gestureAction } from './gestures';
import { replayedPointerDowns } from './pointers';
import type { SelectionItem, UiState } from './state';
import type { Workbench } from './workbench';
import { emptyField, pointerValue, toolOfFeature } from './workbench-util';

/** Left-drag past this many px is a box selection, not a click. */
const BOX_DRAG_PX = 5;

/** A Pencil press held still this long opens the radial menu (touch has the viewport's long-press). */
const PEN_LONG_PRESS_MS = 500;

export function local(
  wb: Workbench,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const r = wb.canvas?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
}

export function pickKinds(wb: Workbench): PickKind[] {
  const u = wb.ui.get();
  if (u.section.picking) return ['face'];
  if (u.measure?.active) return ['face', 'edge', 'vertex'];
  if (u.picking) return wb.pickAccepts()?.kinds ?? [];
  if (u.prompt) return TOOL_NEEDS[u.prompt.tool].kinds;
  return ['face', 'edge', 'vertex', 'region'];
}

export function pickAccepts(wb: Workbench): Accepts | null {
  const p = wb.ui.get().picking;
  if (!p) return null;
  return acceptsFor(
    p.path,
    wb.part?.features.find((f) => f.id === p.featureId),
  );
}

export function pickPrompt(wb: Workbench): string | null {
  const p = wb.ui.get().picking;
  const f = p ? wb.part?.features.find((x) => x.id === p.featureId) : undefined;
  if (!p || !f) return null;
  const tool = toolOfFeature(f);
  const root = p.path.replace(/\/\d+$/, '');
  const step = tool ? FEATURE_PICKS[tool].find((s) => s.path === root) : undefined;
  return step?.prompt ?? `Select ${wb.pickAccepts()?.noun ?? 'geometry'}`;
}

export function pick(
  wb: Workbench,
  e: PointerEvent | MouseEvent,
  kinds: PickKind[],
  all = true,
): PickHit[] {
  const { x, y } = wb.local(e);
  return wb.pickAt(x, y, 'pointerType' in e ? e.pointerType : 'mouse', kinds, all);
}

export function pickAt(
  wb: Workbench,
  x: number,
  y: number,
  pointerType: string,
  kinds: PickKind[],
  all = true,
): PickHit[] {
  const v = wb.viewport;
  if (!v) return [];
  const hits = v.pick(x, y, { kinds, tolerancePx: toleranceFor(pointerType), all });
  // Sketch regions are all "0 px away": of stacked ones (a sketch on a face above another
  // sketch's region) the one nearest the camera is the one under the cursor.
  const cam = (
    v as { getCameraState?: () => { position: [number, number, number] } }
  ).getCameraState?.()?.position;
  if (!cam) return hits;
  return orderStackedRegions(hits, cam as [number, number, number], (h) => wb.regionArea(h));
}

export function regionArea(wb: Workbench, h: PickHit): number {
  const mesh = wb.regen
    .get()
    ?.result.sketches.find((s) => s.featureId === h.bodyId)
    ?.regions.find((r) => r.name === h.entity)?.mesh;
  if (!mesh) return Number.POSITIVE_INFINITY;
  const cached = wb.regionAreas.get(mesh);
  if (cached !== undefined) return cached;
  const p = mesh.positions;
  const ix = mesh.indices;
  const at = (v: number, c: number) => p[(ix[v] as number) * 3 + c] as number;
  let a = 0;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const u = [0, 1, 2].map((c) => at(t + 1, c) - at(t, c)) as [number, number, number];
    const w = [0, 1, 2].map((c) => at(t + 2, c) - at(t, c)) as [number, number, number];
    a +=
      Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) /
      2;
  }
  wb.regionAreas.set(mesh, a);
  return a;
}

export function onCanvas(wb: Workbench, e: Event): boolean {
  return e.target === wb.canvas;
}

export function penRecentlyUsed(wb: Workbench): boolean {
  return performance.now() - wb.lastPenAt < 10 * 60_000;
}

export function onPointerMove(wb: Workbench, e: PointerEvent): void {
  wb.lastPointer = { x: e.clientX, y: e.clientY };
  if (wb.pushPull.onPointerMove(e) || wb.sectionTool.onPointerMove(e)) return;
  if (!wb.onCanvas(e)) {
    wb.forgetPick(); // over a panel or button: Tab keeps its normal job
    return;
  }
  if (wb.ui.get().sketch) {
    wb.sketch?.onPointerMove(e);
    return;
  }
  if (wb.boxMove(e)) return;
  if (wb.penHold && e.pointerId === wb.penHold.id) {
    if (Math.hypot(e.clientX - wb.penHold.x, e.clientY - wb.penHold.y) > BOX_DRAG_PX)
      wb.endPenHold();
  }
  if (e.buttons !== 0) return; // orbiting
  // Mouse and Pencil hover (where supported) preselect.
  const hits = wb.pick(e, wb.pickKinds());
  wb.rememberPick(hits);
  const { best } = resolvePick(hits, {
    pointerType: 'pointerType' in e ? e.pointerType : 'mouse',
  });
  wb.setHover(best);
}

export function boxAllowed(wb: Workbench): boolean {
  const u = wb.ui.get();
  return !(u.picking || u.prompt || u.measure?.active || u.section.picking || u.pushPull);
}

export function boxMove(wb: Workbench, e: PointerEvent): boolean {
  const b = wb.boxDown;
  if (!b || b.id !== e.pointerId || (e.buttons & 1) === 0) return false;
  if (!b.on && Math.hypot(e.clientX - b.x, e.clientY - b.y) > BOX_DRAG_PX) {
    b.on = true;
    wb.endPenHold();
    wb.setHover(null);
  }
  if (!b.on) return false;
  const a = wb.local({ clientX: b.x, clientY: b.y });
  const c = wb.local(e);
  wb.patchUi({
    box: { x0: a.x, y0: a.y, x1: c.x, y1: c.y, mode: c.x >= a.x ? 'window' : 'crossing' },
  });
  return true;
}

export function boxEnd(wb: Workbench, e: PointerEvent): boolean {
  const b = wb.boxDown;
  if (!b || b.id !== e.pointerId) return false;
  wb.boxDown = null;
  if (!b.on) return false;
  const box = wb.ui.get().box;
  wb.patchUi({ box: null });
  if (box) void wb.track(wb.applyBox(box, e));
  return true;
}

export async function applyBox(
  wb: Workbench,
  box: NonNullable<UiState['box']>,
  mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): Promise<void> {
  const v = wb.viewport;
  if (!v) return;
  const hits = v.pickRect(
    { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
    { mode: box.mode, kinds: wb.pickKinds() },
  );
  const items = new Map<string, SelectionItem>();
  for (const hit of hits) items.set(hitKey(hit), { key: hitKey(hit), hit, ref: null });
  const have = wb.ui.get().selection;
  const fresh = [...items.values()].filter((i) => !have.some((s) => s.key === i.key));
  let selection: SelectionItem[];
  if (mods.ctrlKey || mods.metaKey)
    selection = [...have.filter((s) => !items.has(s.key)), ...fresh];
  else if (mods.shiftKey) selection = [...have, ...fresh];
  else selection = [...items.values()];
  wb.patchUi({ selection, featureId: null, hover: null });
  wb.pushHighlights();
  // References resolve in the background, like a single pick's.
  const refs = await Promise.all(selection.map((s) => (s.ref ? s.ref : wb.refFor(s.hit))));
  wb.ui.set((u) => ({
    ...u,
    selection: u.selection.map((s) => {
      const i = selection.findIndex((x) => x.key === s.key);
      return i >= 0 && !s.ref ? { ...s, ref: refs[i] ?? null } : s;
    }),
  }));
}

export function endPenHold(wb: Workbench): void {
  if (wb.penHold) clearTimeout(wb.penHold.timer);
  wb.penHold = null;
}

export function startPenHold(wb: Workbench, e: PointerEvent): void {
  wb.endPenHold();
  const { clientX: x, clientY: y, pointerId: id } = e;
  const timer = setTimeout(() => {
    wb.penHold = null;
    wb.boxDown = null;
    wb.penOpened = id; // its lift is the end of the long press, not a click
    const at = wb.local({ clientX: x, clientY: y });
    const hit = resolvePick(wb.pickAt(at.x, at.y, 'pen', wb.pickKinds()), {
      pointerType: 'pen',
    }).best;
    void wb.track(wb.openRadial({ ...at, pointerType: 'pen', pointerId: id }, hit, true));
  }, PEN_LONG_PRESS_MS);
  wb.penHold = { id, x, y, timer };
}

export function setHover(wb: Workbench, hit: PickHit | null): void {
  const u = wb.ui.get();
  if (u.sketch) {
    wb.sketch?.setHover(null);
    return;
  }
  const same =
    (hit === null && u.hover === null) || (hit && u.hover && hitKey(hit) === hitKey(u.hover));
  if (same) return;
  wb.patchUi({ hover: hit });
  wb.pushHighlights();
}

export function onPointerDown(wb: Workbench, e: PointerEvent): void {
  if (replayedPointerDowns.has(e)) return; // the sketch session handing a finger to the camera
  if (!wb.onCanvas(e)) {
    wb.downs.drop(e.pointerId);
    return;
  }
  if (e.pointerType === 'pen') wb.lastPenAt = performance.now();
  wb.downs.press(e);
  if (wb.ui.get().sketch) {
    wb.sketch?.onPointerDown(e);
    return;
  }
  // A press on the push/pull arrow drags it (the viewport keeps the camera still).
  if (wb.pushPull.onPointerDown(e) || wb.sectionTool.onPointerDown(e)) {
    wb.downs.drop(e.pointerId);
    return;
  }
  // Left button, mouse or Pencil: a drag from here is a box selection (touch keeps orbit).
  if (e.button === 0 && e.pointerType !== 'touch') {
    if (wb.boxAllowed()) {
      wb.boxDown = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    }
    if (e.pointerType === 'pen') wb.startPenHold(e);
  }
}

export function onPointerUp(wb: Workbench, e: PointerEvent): void {
  const d = wb.downs.release(e.pointerId);
  if (e.pointerType === 'pen') wb.lastPenAt = performance.now();
  if (wb.pushPull.onPointerUp(e) || wb.sectionTool.onPointerUp(e)) return;
  if (wb.penHold?.id === e.pointerId) wb.endPenHold();
  if (wb.penOpened === e.pointerId) {
    wb.penOpened = null;
    return;
  }
  if (!wb.ui.get().sketch && wb.boxEnd(e)) return;
  wb.boxDown = null;
  if (wb.ui.get().sketch) {
    wb.sketch?.onPointerUp(e, d);
    return;
  }
  if (!d || d.id !== e.pointerId || e.button !== 0) return;
  // One path per input: touch taps select through `onGesture` (with palm rejection and
  // double-tap handling); mouse and Pencil clicks come through here.
  if (d.type === 'touch') return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // a drag (box select or navigation), not a click
  wb.onClick(e);
}

export function onPointerCancel(wb: Workbench, e: PointerEvent): void {
  wb.downs.drop(e.pointerId);
  if (wb.boxDown?.id === e.pointerId) {
    wb.boxDown = null;
    if (wb.ui.get().box) wb.patchUi({ box: null });
  }
  if (wb.penHold?.id === e.pointerId) wb.endPenHold();
  wb.pushPull.onPointerCancel(e);
  wb.sectionTool.onPointerCancel(e);
  wb.sketch?.onPointerCancel(e);
}

export function onClick(wb: Workbench, e: PointerEvent): void {
  // Tab chose a candidate under the still pointer: the click takes that one.
  const tab = wb.tabHit;
  wb.tabHit = null;
  if (tab && wb.lastPick.some((c) => hitKey(c.hit) === hitKey(tab))) {
    wb.patchUi({ chooser: null });
    void wb.choose(tab, e.shiftKey || e.metaKey || e.ctrlKey);
    return;
  }
  const { x, y } = wb.local(e);
  wb.tapAt(x, y, e.pointerType, e.shiftKey || e.metaKey || e.ctrlKey);
}

export function tapAt(
  wb: Workbench,
  x: number,
  y: number,
  pointerType: string,
  additive: boolean,
): void {
  if (wb.ui.get().bubble) wb.patchUi({ bubble: null });
  const { best, ties } = resolvePick(wb.pickAt(x, y, pointerType, wb.pickKinds()), {
    pointerType,
  });
  if (ties.length > 1) {
    const r = wb.canvas?.getBoundingClientRect();
    const at = { x: x + (r?.left ?? 0), y: y + (r?.top ?? 0) };
    wb.patchUi({ chooser: { ...at, hits: ties, additive } });
    return;
  }
  void wb.choose(best, additive);
}

export function onGesture(wb: Workbench, g: ViewportGesture): void {
  const u = wb.ui.get();
  const draw = u.sketch?.draw;
  const probe = g.kind === 'doubleTap' || g.kind === 'longPress' || g.kind === 'contextMenu';
  const best = probe
    ? resolvePick(wb.pickAt(g.x, g.y, g.pointerType, wb.pickKinds()), {
        pointerType: g.pointerType,
      }).best
    : null;
  const action = gestureAction(g, {
    sketch: u.sketch !== null,
    drawing: !!draw && (draw.anchors.length > 0 || draw.chainFrom !== null),
    tool: !!draw || u.sketch?.tool === 'dimension',
    onGeometry: best !== null,
  });
  switch (action) {
    case 'select':
      wb.tapAt(g.x, g.y, g.pointerType, false);
      break;
    case 'zoomTo':
      if (best) wb.zoomToHit(best);
      break;
    case 'fit':
      wb.viewport?.fitAll(true);
      break;
    case 'radial':
      if (g.pointerType !== 'pen') void wb.track(wb.openRadial(g, best, g.kind === 'longPress'));
      break;
    case 'repeat':
      wb.repeatLast();
      break;
    case 'undo':
      wb.undo();
      break;
    case 'redo':
      wb.redo();
      break;
    case null:
      break;
  }
}

export function zoomToHit(wb: Workbench, hit: PickHit): void {
  const v = wb.viewport;
  if (!v) return;
  // `zoomTo`'s radius fills about half the view: half the face's radius makes it fill the view.
  const f = hit.kind === 'face' ? wb.face(hit.bodyId, hit.index) : null;
  const diag = partDiagonal(wb.regen.get()?.result);
  if (f) v.zoomTo(f.centroid, Math.max(f.radius / 2, diag * 0.02), true);
  else v.zoomTo(hit.point, Math.max(diag * 0.06, 0.5), true);
}

export function previewChooser(wb: Workbench, index: number | null): void {
  const hit = index === null ? null : (wb.ui.get().chooser?.hits[index] ?? null);
  wb.setHover(hit);
}

export function choose(wb: Workbench, hit: PickHit | null, additive = false): Promise<void> {
  return wb.track(wb.applyChoice(hit, additive));
}

export async function applyChoice(
  wb: Workbench,
  hit: PickHit | null,
  additive: boolean,
): Promise<void> {
  wb.choices++;
  wb.patchUi({ chooser: null });
  const u = wb.ui.get();
  const part = wb.part;
  if (!part) return;
  if (u.section.picking) {
    if (hit?.kind === 'face') wb.sectionFromFace(hit);
    return;
  }
  if (u.measure?.active) {
    if (hit) await wb.measure.pick(hit);
    return;
  }
  if (u.pushPull) {
    // Another flat face moves the arrow there; anything else ends push/pull.
    if (hit?.kind === 'face' && wb.pushPull.start([hit], true)) return;
    wb.pushPull.cancel();
  }
  if (u.picking) {
    if (!hit) return;
    const f = part.features.find((x) => x.id === u.picking?.featureId);
    if (!f) return;
    const accepts = acceptsFor(u.picking.path, f);
    if (accepts.features) {
      // Mirror / pattern sources: the feature that made the clicked geometry.
      const owner = wb.ownerFeature(hit, f.id);
      if (owner) wb.addSourceFeature(owner);
      else wb.toast('Pick geometry a feature made, or the feature in the tree.', 'info');
      return;
    }
    const ref = await wb.refFor(hit, accepts.as);
    if (!ref) return wb.toast('That can’t be referenced yet — try again in a moment.', 'info');
    wb.pickRef(ref);
    return;
  }
  if (u.prompt) {
    if (!hit) return;
    await wb.selectHit(hit, false);
    await wb.runTool(u.prompt.tool);
    return;
  }
  if (!hit) {
    if (!additive) wb.clearSelection();
    return;
  }
  await wb.selectHit(hit, additive);
}

export async function refFor(
  wb: Workbench,
  hit: PickHit,
  as?: EntityRef['kind'],
): Promise<EntityRef | null> {
  const part = wb.part;
  const modeling = wb.modeling;
  if (!part) return null;
  return refForHit(hit, part.id, (p, q) => modeling?.refFor(p, q) ?? Promise.resolve(null), as);
}

export function pickRef(wb: Workbench, ref: EntityRef): void {
  const p = wb.ui.get().picking;
  const part = wb.part;
  const f = p ? part?.features.find((x) => x.id === p.featureId) : undefined;
  if (!p || !part || !f) return;
  const next = applyPick(f, p.path, ref);
  if (next !== f)
    wb.apply({ kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next });
  wb.commit();
  const root = p.path.replace(/\/\d+$/, '');
  const list = root === p.path && Array.isArray(pointerValue(f, p.path));
  const tool = toolOfFeature(next);
  const once = tool ? FEATURE_PICKS[tool].find((s) => s.path === root)?.once : false;
  if (!list || once) wb.advancePicking(next, root);
}

export function advancePicking(wb: Workbench, f?: Feature, from?: string): void {
  const p = wb.ui.get().picking;
  const feature = f ?? (p ? wb.part?.features.find((x) => x.id === p.featureId) : undefined);
  const after = from ?? p?.path.replace(/\/\d+$/, '');
  if (!feature) return;
  const tool = toolOfFeature(feature);
  const steps = tool ? FEATURE_PICKS[tool] : [];
  const i = steps.findIndex((s) => s.path === after);
  const next = i >= 0 ? steps.slice(i + 1).find((s) => emptyField(feature, s.path)) : undefined;
  wb.patchUi({ picking: next ? { featureId: feature.id, path: next.path } : null });
  wb.loop?.request();
  wb.refreshSketchVisibility();
  wb.pushHighlights();
}

export function ownerFeature(wb: Workbench, hit: PickHit, before: Id): Id | null {
  const part = wb.part;
  const mesh = wb.regen.get()?.result.bodies.find((b) => b.id === hit.bodyId)?.mesh;
  const name =
    hit.kind === 'face'
      ? mesh?.faceNames[hit.index]
      : hit.kind === 'edge'
        ? mesh?.edgeNames[hit.index]
        : undefined;
  if (!part || !name) return null;
  const end = part.features.findIndex((f) => f.id === before);
  const earlier = part.features.slice(0, end < 0 ? undefined : end);
  return earlier.findLast((f) => f.type !== 'sketch' && name.includes(f.id))?.id ?? null;
}

export function addSourceFeature(wb: Workbench, id: Id): void {
  const p = wb.ui.get().picking;
  const part = wb.part;
  const f = p
    ? part?.features.find(
        (x): x is MirrorFeature | LinearPatternFeature | CircularPatternFeature =>
          x.id === p.featureId &&
          (x.type === 'mirror' || x.type === 'linearPattern' || x.type === 'circularPattern'),
      )
    : undefined;
  if (!part || !f || f.source.kind !== 'features') return;
  const at = part.features.findIndex((x) => x.id === id);
  const self = part.features.findIndex((x) => x.id === f.id);
  if (id === f.id || at < 0 || at > self) {
    wb.toast('Only features before this one can be copied.', 'info');
    return;
  }
  if (f.source.features.includes(id)) return;
  const next = {
    ...f,
    source: { kind: 'features' as const, features: [...f.source.features, id] },
  };
  wb.apply(
    { kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next as Feature },
    `Copy ${part.features[at]?.name ?? 'feature'}`,
  );
  wb.commit();
}

export async function selectHit(wb: Workbench, hit: PickHit, additive: boolean): Promise<void> {
  const key = hitKey(hit);
  const u = wb.ui.get();
  const exists = u.selection.some((s) => s.key === key);
  let selection: SelectionItem[];
  if (additive) {
    selection = exists
      ? u.selection.filter((s) => s.key !== key)
      : [...u.selection, { key, hit, ref: null }];
  } else selection = [{ key, hit, ref: null }];
  wb.patchUi({ selection, featureId: null });
  wb.pushHighlights();
  const ref = await wb.refFor(hit);
  wb.ui.set((s) => ({
    ...s,
    selection: s.selection.map((x) => (x.key === key ? { ...x, ref } : x)),
  }));
}

export function clearSelection(wb: Workbench): void {
  wb.patchUi({ selection: [], featureId: null, picking: null, bubble: null });
  wb.pushHighlights();
}
