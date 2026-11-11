/**
 * Regeneration to viewport: applying a regen result, the cached first frame, mesh cache, selection remapping, viewport attach and highlights.
 */

import type {
  CameraChange,
  EntityRef,
  Feature,
  HighlightItem,
  MeshBuffers,
  RegenResult,
  TouchViewport,
  Vec3,
  WrenDoc,
} from '@wren-cad/contracts';
import { entityRefs } from '@wren-cad/document';
import {
  type CachedGeometry,
  decodeCache,
  docKey,
  encodeCache,
  withoutMeshes,
} from '../doc/mesh-cache';
import { attentionItems, attentionMarkers, partDiagonal } from '../model/attention';
import { explainStatus, followBlockedCauses } from '../model/explain';
import { type FaceInfo, faceInfo } from '../model/faces';
import { healsFrom } from '../model/heal';
import { hitKey, pickVertices, toHighlight, vertexAt } from '../selection/pick';
import { mergeIssueStatuses } from './config-model';
import type { RegenView, SelectionItem } from './state';
import { failBoot, mark, markOnce } from './timing';
import type { Workbench } from './workbench';

export function onRegen(wb: Workbench, raw: RegenView): void {
  // Errors the app can explain better (propagate: false naming its tangent edges, ADR-040).
  const current = wb.config.isCurrent(raw.doc);
  const explained = followBlockedCauses(raw.result.features.map((s) => explainStatus(raw.doc, s)));
  // M3.7: an override that no longer applies makes that feature "needs attention" here.
  const features = current
    ? mergeIssueStatuses(explained, wb.config.resolved().issues, wb.config.activeName)
    : explained;
  const outcome = features.some((s, i) => s !== raw.result.features[i])
    ? { ...raw, result: { ...raw.result, features } }
    : raw;
  if (current || !wb.ui.get().picking) wb.treeStatuses.set(outcome.result.features);
  if (current) {
    wb.heals = healsFrom(outcome.result.features);
    wb.healsFor = outcome.doc;
  }
  wb.regen.set(outcome);
  wb.remapSelection(outcome.result);
  wb.syncViewport();
  wb.sketch?.onRegen(outcome.result);
  wb.keepInView(outcome);
  if (!wb.firstRendered && wb.viewport && outcome.source === 'live') {
    wb.firstRendered = true;
    void wb.viewport.nextFrame().then(() => mark('firstBodyMs'));
  }
  // The cache holds the tier's settled quality (phones: coarse; the fine pass never runs there).
  if (current && (outcome.quality === 'fine' || outcome.quality === wb.policy.meshQuality))
    wb.updateMeshCache(outcome);
  wb.pushPull.onRegen();
  wb.measure.onRegen();
  wb.syncSection();
  if (current && outcome.source === 'live') {
    wb.config.onRegenResult(outcome.result.totalMs, outcome.result.cache.misses === 0);
    if (outcome.quality === wb.policy.meshQuality || outcome.quality === 'fine')
      wb.config.onSettled();
  }
}

/**
 * Mass properties fetched after the geometry (ADR-084, `RegenLoopOptions.onMass`): added to the
 * displayed live result when it still shows those shapes. Nothing else changes (no viewport sync:
 * the meshes are the same), so only the readouts that use them re-render.
 */
export function onMass(wb: Workbench, result: RegenResult): void {
  const view = wb.regen.get();
  if (view?.source !== 'live' || view.result.partId !== result.partId) return;
  // Settled even if some fetch failed: those bodies show no mass rather than "Calculating…".
  wb.massSettledRevision = result.revision;
  const byShape = new Map(result.bodies.map((b) => [b.shape, b.massProperties] as const));
  let changed = false;
  const bodies = view.result.bodies.map((b) => {
    const mp = b.massProperties ? undefined : byShape.get(b.shape);
    if (!mp) return b;
    changed = true;
    return { ...b, massProperties: mp };
  });
  wb.regen.set({ ...view, result: { ...view.result, ...(changed ? { bodies } : {}) } });
}

export function keepInView(wb: Workbench, view: RegenView): void {
  const v = wb.viewport;
  if (!v || !wb.fitPending || wb.ui.get().sketch) return;
  const bodies = view.result.bodies;
  if (bodies.length === 0) return;
  wb.fitPending = false;
  const outside = bodies.some((b) => {
    const { min, max } = b.mesh.bbox;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) if (!v.worldToScreen([x, y, z]).visible) return true;
    return false;
  });
  if (wb.fitOnFirstGeometry || outside) v.fitAll(false);
}

export function showCached(wb: Workbench, doc: WrenDoc): void {
  const geometry = decodeCache(wb.cache, docKey(doc));
  if (!geometry) return;
  wb.cacheKey = geometry.key;
  wb.savedCacheKey = geometry.key;
  const part = doc.parts[0];
  const current = wb.regen.get();
  // Never replace live geometry of this very part (only a previous document's, or nothing).
  if (!part || (current?.source === 'live' && current.result.partId === part.id)) return;
  const view: RegenView = {
    source: 'cache',
    quality: 'fine',
    doc,
    result: {
      partId: part.id,
      revision: -1,
      features: [],
      bodies: geometry.bodies.map((b) => ({ id: b.id, shape: 0, mesh: b.mesh })),
      sketches: geometry.sketches,
      totalMs: 0,
      cache: { hits: 0, misses: 0 },
    },
  };
  wb.regen.set(view);
  wb.syncViewport();
  wb.keepInView(view);
  wb.markCachedFrame();
}

export function markCachedFrame(wb: Workbench): void {
  const v = wb.viewport;
  if (!v || wb.regen.get()?.source !== 'cache' || !wb.regen.get()?.result.bodies.length) return;
  void v.nextFrame().then(() => {
    if (wb.regen.get()?.source === 'cache') markOnce('cachedBodyMs');
  });
}

export function updateMeshCache(wb: Workbench, view: RegenView): void {
  // Keyed by the stored document (what a reload reads), not the resolved one (M3.7); only the
  // current document is ever cached, so the stored one is the view's own.
  const key = docKey(wb.doc);
  if (key === wb.cacheKey) return;
  const geometry: CachedGeometry = {
    key,
    bodies: view.result.bodies.map((b) => ({ id: b.id, mesh: b.mesh })),
    sketches: view.result.sketches,
  };
  wb.cache = new Map([...withoutMeshes(wb.cache), ...encodeCache(geometry)]);
  wb.cacheKey = key;
  // A save already queued for this document picks the cache up; otherwise save it shortly.
  if (!wb.inLibrary || wb.autosaver.pending) return;
  wb.scheduleCacheSave();
}

export function scheduleCacheSave(wb: Workbench): void {
  clearTimeout(wb.cacheTimer);
  wb.cacheTimer = setTimeout(() => {
    if (wb.cacheKey !== wb.savedCacheKey && docKey(wb.doc) === wb.cacheKey)
      void wb.autosaver.flush().then(() => wb.saveToLibrary(wb.doc));
  }, 600);
}

export function remapSelection(wb: Workbench, result: RegenResult): void {
  const u = wb.ui.get();
  const selection = u.selection.flatMap((s): SelectionItem[] => {
    const k = s.hit.kind;
    if ((k !== 'face' && k !== 'edge' && k !== 'vertex') || !s.ref) return [s];
    const body = result.bodies.find((b) => b.id === s.hit.bodyId);
    const names =
      k === 'face' ? body?.mesh.faceNames : k === 'edge' ? body?.mesh.edgeNames : undefined;
    // Vertices have no names in the mesh: re-find them by position (dropped if they moved).
    const i =
      k === 'vertex'
        ? vertexAt(pickVertices(body?.mesh), s.hit.point)
        : s.ref && names
          ? names.indexOf(s.ref.name)
          : -1;
    if (i < 0) return [];
    const hit = { ...s.hit, index: i };
    return [{ ...s, hit, key: hitKey(hit) }];
  });
  wb.patchUi({ selection, hover: null });
}

export function attachViewport(
  wb: Workbench,
  viewport: TouchViewport,
  canvas: HTMLCanvasElement,
): void {
  markOnce('viewportReadyMs');
  wb.viewport = viewport;
  wb.canvas = canvas;
  const host = canvas.parentElement ?? canvas;
  wb.cleanup.push(
    wb.listen(host, 'pointermove', (e) => wb.onPointerMove(e as PointerEvent)),
    wb.listen(host, 'pointerdown', (e) => wb.onPointerDown(e as PointerEvent), true),
    // Pencil presses anywhere (tool buttons too) mark the Pencil as in use; never handled here.
    wb.listen(
      host.ownerDocument,
      'pointerdown',
      (e) => {
        if ((e as PointerEvent).pointerType === 'pen') wb.lastPenAt = performance.now();
      },
      true,
    ),
    wb.listen(host, 'pointerup', (e) => wb.onPointerUp(e as PointerEvent), true),
    wb.listen(host, 'pointercancel', (e) => wb.onPointerCancel(e as PointerEvent), true),
    wb.listen(host, 'pointerleave', () => {
      wb.forgetPick();
      wb.setHover(null);
    }),
    wb.listen(host, 'dblclick', (e) => wb.sketch?.onDoubleClick(e as MouseEvent), true),
    wb.listen(host, 'dragover', (e) => wb.onDragOver(e as DragEvent)),
    wb.listen(host, 'drop', (e) => void wb.onDrop(e as DragEvent)),
    // The app decides what discrete gestures mean (PLAN §9.3); the viewport keeps navigation.
    viewport.onGesture((g) => wb.onGesture(g)),
    viewport.onCamera((c) => wb.onCamera(c)),
  );
  viewport.setNavigation(wb.input.get().navigation);
  // Touch tiers: the Pencil draws or selects and never orbits; fingers keep navigating, and
  // touch taps right after a pen contact are palm rejected.
  if (wb.tier !== 'desktop') viewport.setInputPolicy({ penDraws: true });
  wb.syncViewport();
  wb.syncSection();
  const view = wb.regen.get();
  if (view) wb.keepInView(view);
  if (view?.source === 'live' && !wb.firstRendered) {
    wb.firstRendered = true;
    void viewport.nextFrame().then(() => mark('firstBodyMs'));
  }
  wb.markCachedFrame();
  wb.markViewerShown();
}

export function onCamera(wb: Workbench, c: CameraChange): void {
  wb.cameraTick.set((n) => n + 1);
  wb.sectionTool.onCamera();
  const cur = wb.camera.get();
  if (c.moving !== cur.moving)
    wb.camera.set({ moving: c.moving, rest: c.moving ? cur.rest : cur.rest + 1 });
}

export function project(wb: Workbench, p: Vec3): { x: number; y: number } | null {
  const s = wb.viewport?.worldToScreen(p);
  return s?.visible ? { x: s.x, y: s.y } : null;
}

export function face(wb: Workbench, bodyId: string, index: number): FaceInfo | null {
  const mesh = wb.regen.get()?.result.bodies.find((b) => b.id === bodyId)?.mesh;
  if (!mesh) return null;
  let m = wb.faceCache.get(mesh);
  if (!m) {
    m = new Map();
    wb.faceCache.set(mesh, m);
  }
  if (!m.has(index)) m.set(index, faceInfo(mesh, index));
  return m.get(index) ?? null;
}

export function onDragOver(_wb: Workbench, e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault(); // allow the drop
  e.dataTransfer.dropEffect = 'copy';
}

export async function onDrop(wb: Workbench, e: DragEvent): Promise<void> {
  const list = [...(e.dataTransfer?.files ?? [])];
  if (list.length === 0) return;
  e.preventDefault();
  const files = await Promise.all(
    list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
  const project = files.find((f) => /\.(wrencad|whittle)$/i.test(f.name));
  if (project) await wb.openBytes(project.name, project.bytes);
  else await wb.importFiles(files, 'current');
}

export function viewportFailed(_wb: Workbench, message: string): void {
  failBoot(`viewport: ${message}`);
}

export function bodyColor(wb: Workbench): string | undefined {
  const part = wb.part;
  return part?.color ?? part?.material?.appearance ?? undefined;
}

export function syncViewport(wb: Workbench): void {
  const v = wb.viewport;
  const view = wb.regen.get();
  if (!v || !view) return;
  const { result } = view;
  const color = wb.bodyColor();
  const visible = wb.partVisible(result.partId);
  const next = new Set<string>();
  for (const b of result.bodies) {
    v.setBody(b.id, b.mesh, { ...(color ? { color } : {}), visible });
    next.add(b.id);
  }
  for (const id of wb.shownBodies) if (!next.has(id)) v.removeBody(id);
  wb.shownBodies = next;

  // Ghosts: last good geometry while something is in error (PLAN §9.2). The engine reports
  // them (`RegenResult.ghosts`); engines that don't get the app's own last-all-ok fallback.
  const broken = result.features.some(
    (s) => s.state === 'error' || s.state === 'needsAttention' || s.state === 'blocked',
  );
  const ghosts = new Map<string, MeshBuffers>();
  if (!broken) wb.lastGood = new Map(result.bodies.map((b) => [b.id, b.mesh]));
  else if (result.ghosts) for (const g of result.ghosts) ghosts.set(g.id, g.mesh);
  else
    for (const [id, mesh] of wb.lastGood)
      if (result.bodies.find((b) => b.id === id)?.mesh !== mesh) ghosts.set(id, mesh);
  for (const id of wb.ghosts) if (!ghosts.has(id)) v.setGhost(id, null);
  for (const [id, mesh] of ghosts) v.setGhost(id, mesh);
  wb.ghosts = new Set(ghosts.keys());
  wb.syncAttentionMarkers();
  wb.refreshSketchVisibility();
  wb.pushHighlights();
}

export function syncAttentionMarkers(wb: Workbench): void {
  const v = wb.viewport;
  if (!v) return;
  const items = attentionItems(wb.treeStatuses.get());
  const size = Math.max(partDiagonal(wb.regen.get()?.result) * 0.05, 0.5);
  const next = new Map<string, ReturnType<typeof attentionMarkers>>();
  for (const it of items) {
    // The stored fingerprint, else the engine's last known location of the reference.
    const { ref, lastKnown } = it.unresolved;
    const markers = attentionMarkers(
      ref.fingerprint || !lastKnown ? ref : { ...ref, fingerprint: lastKnown },
      size,
    );
    if (markers) next.set(`attention:${it.featureId}:${it.unresolved.path}`, markers);
  }
  for (const id of wb.markers) if (!next.has(id)) v.setMarkers(id, null);
  for (const [id, markers] of next) v.setMarkers(id, markers);
  wb.markers = new Set(next.keys());
}

export function pushHighlights(wb: Workbench): void {
  const v = wb.viewport;
  if (!v) return;
  const u = wb.ui.get();
  if (u.sketch) {
    wb.sketch?.pushHighlights();
    return;
  }
  const view = wb.regen.get();
  const fix = (h: HighlightItem): HighlightItem => {
    if (h.kind !== 'region' || !view) return h;
    const s = view.result.sketches.find((x) => x.featureId === h.bodyId);
    const i = s?.regions.findIndex((r) => r.name === h.entity) ?? -1;
    return i >= 0 ? { ...h, index: i } : h;
  };
  const selected = u.selection.map((s) => fix(toHighlight(s.hit)));
  // Measure picks are highlighted like a selection.
  for (const p of u.measure?.picks ?? [])
    if ('bodyId' in p.target)
      selected.push({ bodyId: p.target.bodyId, kind: p.target.kind, index: p.target.index });
  // Refs of the feature being edited show as selected too.
  const editing = u.featureId ? wb.part?.features.find((f) => f.id === u.featureId) : null;
  if (editing && view) selected.push(...wb.highlightsForRefs(editing, view.result));
  v.setHighlights({ selected, preselected: u.hover ? [fix(toHighlight(u.hover))] : [] });
}

export function highlightsForRefs(
  _wb: Workbench,
  f: Feature,
  result: RegenResult,
): HighlightItem[] {
  const out: HighlightItem[] = [];
  // Every reference of the feature (M3 features too), except its sketch plane.
  const refs: EntityRef[] = f.type === 'sketch' ? [] : entityRefs(f);
  for (const ref of refs) {
    if (ref.kind === 'region') {
      for (const s of result.sketches) {
        const i = s.regions.findIndex((r) => r.name === ref.name);
        if (i >= 0) out.push({ bodyId: s.featureId, kind: 'region', index: i, entity: ref.name });
      }
    } else if (ref.kind === 'edge') {
      for (const b of result.bodies) {
        const i = b.mesh.edgeNames.indexOf(ref.name);
        if (i >= 0) out.push({ bodyId: b.id, kind: 'edge', index: i });
      }
    } else if (ref.kind === 'face') {
      for (const b of result.bodies) {
        const i = b.mesh.faceNames.indexOf(ref.name);
        if (i >= 0) out.push({ bodyId: b.id, kind: 'face', index: i });
      }
    }
  }
  return out;
}
