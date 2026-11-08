/**
 * The workbench: the app's controller between the document store (single source of truth), the
 * regen engine, the viewport and the React chrome. React renders state from here
 * (`useObservable`) and calls its intention-revealing methods; nothing in React talks to the
 * engine or the viewport directly.
 */

import type {
  Command,
  EntityRef,
  EvalResult,
  Expr,
  Feature,
  HighlightItem,
  Id,
  InteractiveViewport,
  Material,
  MeshBuffers,
  NamedDimension,
  Part,
  PickHit,
  PickKind,
  RegenResult,
  SketchFeature,
  WhittleDoc,
} from '@whittle/contracts';
import {
  createDocumentStore,
  type DocumentStoreImpl,
  expressionEngine,
  newDoc,
  scopeOf,
  ulid,
} from '@whittle/document';
import type { ExportRequest, ToolId } from '@whittle/ui';
import { type Autosaver, createAutosaver } from '../doc/autosave';
import type { DocLibrary } from '../doc/library';
import {
  contextTools,
  defaultAxisFor,
  type ModelTool,
  newBox,
  newChamfer,
  newCylinder,
  newExtrude,
  newFillet,
  newPlane,
  newRevolve,
  newSketch,
  TOOL_NEEDS,
} from '../features/factories';
import { bootEngine, type EngineBoot } from '../model/engine';
import { isOriginPlane, ORIGIN_FRAMES, type PlaneFrame, toPlaneFrame } from '../model/frames';
import { createRegenLoop, type Modeling, type RegenLoop } from '../model/modeling';
import {
  acceptsFor,
  applyPick,
  hitKey,
  refForHit,
  resolvePick,
  toHighlight,
  toleranceFor,
} from '../selection/pick';
import { type Observable, observable } from './observable';
import type { SketchSession } from './sketch-session';
import {
  type EngineState,
  initialUi,
  type RegenView,
  type SelectionItem,
  type UiState,
} from './state';
import { failBoot, mark } from './timing';

const LAST_DOC_KEY = 'whittle:last-document';
const THUMB_EVERY_MS = 4000;

function readLastDoc(): string | null {
  try {
    return localStorage.getItem(LAST_DOC_KEY);
  } catch {
    return null;
  }
}
function writeLastDoc(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(LAST_DOC_KEY, id);
    else localStorage.removeItem(LAST_DOC_KEY);
  } catch {
    // storage blocked: the library still works, we just won't reopen automatically
  }
}

export function freshDocument(): WhittleDoc {
  const doc = newDoc({ name: 'Untitled part', firstPart: 'Part 1' });
  return { ...doc, meta: { ...doc.meta, id: ulid() } };
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

export interface MassSummaryView {
  volume: number;
  area: number;
  mass?: number;
  centroid: [number, number, number];
}

export class Workbench {
  readonly store: DocumentStoreImpl;
  readonly ui: Observable<UiState> = observable(initialUi);
  readonly regen: Observable<RegenView | null> = observable<RegenView | null>(null);
  readonly engine: Observable<EngineState> = observable<EngineState>({
    status: { state: 'idle' },
    ready: false,
    error: null,
  });
  /** Library contents for the library panel (refreshed on demand). */
  readonly libraryEntries = observable<import('@whittle/contracts').LibraryEntry[] | null>(null);

  viewport: InteractiveViewport | null = null;
  canvas: HTMLCanvasElement | null = null;
  modeling: Modeling | null = null;
  private loop: RegenLoop | null = null;
  private boot: EngineBoot | null = null;
  private libraryPromise: Promise<DocLibrary | null> | null = null;
  private autosaver: Autosaver;
  private shownBodies = new Set<string>();
  private shownSketches = new Set<string>();
  private ghosts = new Set<string>();
  private lastGood = new Map<string, MeshBuffers>();
  private firstRendered = false;
  private lastThumbAt = 0;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanup: Array<() => void> = [];
  private down: { x: number; y: number; id: number; type: string } | null = null;
  sketch: SketchSession | null = null;
  private sketchModule: Promise<typeof import('./sketch-session')> | null = null;

  constructor() {
    this.store = createDocumentStore(freshDocument());
    this.autosaver = createAutosaver({
      save: (doc) => this.saveToLibrary(doc),
      onError: (e) => this.toast(e instanceof Error ? e.message : 'Autosave failed', 'error'),
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    mark('shellInteractiveMs');
    this.cleanup.push(
      this.store.subscribe((doc, change) => this.onDocChange(doc, change.patches[0]?.path === '')),
      this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent)),
      this.listen(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flushSave();
      }),
      this.listen(window, 'pagehide', () => void this.flushSave()),
    );
    this.bootKernel();
    void this.resolveInitialDocument();
  }

  /**
   * Starts the kernel worker and the regen engine (idempotent). `main.tsx` calls this before the
   * first render so Wasm streaming/compilation overlaps the shell's paint (PLAN §4, §10).
   */
  bootKernel(): void {
    if (this.boot) return;
    // Download progress arrives hundreds of times a second; re-rendering the shell for each one
    // competes with the kernel boot. Show it at ≤ 8 Hz; every other state change immediately.
    let lastProgress = 0;
    const boot = bootEngine((status) => {
      if (this.boot !== boot) return;
      if (status.state === 'downloading') {
        const now = performance.now();
        if (now - lastProgress < 125) return;
        lastProgress = now;
      }
      this.engine.set((s) => ({ ...s, status }));
    });
    this.boot = boot;
    boot.modeling.then(
      (modeling) => {
        if (this.boot === boot) this.onEngineReady(modeling);
      },
      (err: unknown) => {
        if (this.boot !== boot || (err instanceof Error && err.message === 'disposed')) return;
        const message = err instanceof Error ? err.message : 'The geometry kernel failed to start.';
        failBoot(`kernel: ${message}`);
        this.engine.set((s) => ({
          ...s,
          error: message,
          status: { state: 'error', error: { code: 'INTERNAL', message } },
        }));
      },
    );
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.loop?.dispose();
    this.loop = null;
    this.boot?.dispose();
    this.boot = null;
    this.sketch?.dispose();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false) {
    target.addEventListener(type, fn, capture);
    return () => target.removeEventListener(type, fn, capture);
  }

  /** The library (lazy). Null when storage is unavailable. */
  library(): Promise<DocLibrary | null> {
    this.libraryPromise ??= import('../doc/library')
      .then((m) => m.createDocLibrary())
      .catch(() => null);
    return this.libraryPromise;
  }

  private async resolveInitialDocument(): Promise<void> {
    const lastId = readLastDoc();
    if (lastId) {
      const lib = await this.library();
      if (lib) {
        try {
          const doc = await lib.open(lastId);
          this.store.load(doc);
        } catch {
          writeLastDoc(undefined);
        }
      }
    }
    this.ui.set((u) => ({ ...u, ready: true }));
    this.loop?.request();
    void import('../doc/library').then(({ onLaunchFiles }) =>
      onLaunchFiles((files) => {
        const f = files[0];
        if (f) void this.openBytes(f.name, f.bytes);
      }),
    );
  }

  private onEngineReady(modeling: Modeling): void {
    this.modeling = modeling;
    this.engine.set((s) => ({ ...s, ready: true }));
    this.loop = createRegenLoop({
      port: modeling.port,
      getDoc: () => this.store.getDoc(),
      onResult: (o) => this.onRegen(o),
      onError: (e) => this.toast(e.message, 'error'),
    });
    if (this.ui.get().ready) this.loop.request();
  }

  /** Stable subscribe/snapshot pair for `useSyncExternalStore`. */
  readonly subscribeDoc = (listener: () => void): (() => void) =>
    this.store.subscribe(() => listener());
  readonly getDoc = (): WhittleDoc => this.store.getDoc();

  get doc(): WhittleDoc {
    return this.store.getDoc();
  }

  get part(): Part | null {
    return this.doc.parts[0] ?? null;
  }

  // ------------------------------------------------------------------ document changes

  /** `loaded`: the document was replaced (open/new), not edited: nothing to autosave yet. */
  private onDocChange(doc: WhittleDoc, loaded: boolean): void {
    if (!this.ui.get().ready) return;
    this.loop?.request();
    if (!loaded) this.autosaver.schedule(doc);
    const part = this.part;
    const ids = new Set(part?.features.map((f) => f.id));
    const u = this.ui.get();
    if (u.featureId && !ids.has(u.featureId)) this.patchUi({ featureId: null, picking: null });
    if (u.sketch && !ids.has(u.sketch.featureId)) this.sketch?.exit(false);
    this.sketch?.onDocChange();
    this.refreshSketchVisibility();
  }

  apply(command: Command, label?: string, coalesceKey?: string): boolean {
    const r = this.store.apply(command, {
      ...(label ? { label } : {}),
      ...(coalesceKey ? { coalesceKey } : {}),
    });
    if (!r.ok) {
      this.toast(r.error, 'error');
      return false;
    }
    return true;
  }

  commit(): void {
    this.store.commit();
  }

  undo(): void {
    if (!this.store.undo()) this.toast('Nothing to undo', 'info');
  }

  redo(): void {
    if (!this.store.redo()) this.toast('Nothing to redo', 'info');
  }

  // ------------------------------------------------------------------ regeneration → viewport

  private onRegen(outcome: RegenView): void {
    this.regen.set(outcome);
    this.syncViewport();
    this.sketch?.onRegen(outcome.result);
    if (!this.firstRendered && this.viewport) {
      this.firstRendered = true;
      void this.viewport.nextFrame().then(() => mark('firstBodyMs'));
    }
    if (outcome.quality === 'fine') this.maybeThumbnail();
  }

  attachViewport(viewport: InteractiveViewport, canvas: HTMLCanvasElement): void {
    this.viewport = viewport;
    this.canvas = canvas;
    const host = canvas.parentElement ?? canvas;
    this.cleanup.push(
      this.listen(host, 'pointermove', (e) => this.onPointerMove(e as PointerEvent)),
      this.listen(host, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true),
      this.listen(host, 'pointerup', (e) => this.onPointerUp(e as PointerEvent), true),
      this.listen(host, 'pointerleave', () => this.setHover(null)),
      this.listen(host, 'dblclick', (e) => this.sketch?.onDoubleClick(e as MouseEvent), true),
    );
    this.syncViewport();
    if (this.regen.get() && !this.firstRendered) {
      this.firstRendered = true;
      void viewport.nextFrame().then(() => mark('firstBodyMs'));
    }
  }

  viewportFailed(message: string): void {
    failBoot(`viewport: ${message}`);
  }

  private bodyColor(): string | undefined {
    const part = this.part;
    return part?.color ?? part?.material?.appearance ?? undefined;
  }

  syncViewport(): void {
    const v = this.viewport;
    const view = this.regen.get();
    if (!v || !view) return;
    const { result } = view;
    const color = this.bodyColor();
    const next = new Set<string>();
    for (const b of result.bodies) {
      v.setBody(b.id, b.mesh, color ? { color } : {});
      next.add(b.id);
    }
    for (const id of this.shownBodies) if (!next.has(id)) v.removeBody(id);
    this.shownBodies = next;

    // Ghosts: last good geometry while something is in error (PLAN §9.2).
    const broken = result.features.some(
      (s) => s.state === 'error' || s.state === 'needsAttention' || s.state === 'blocked',
    );
    if (!broken) {
      this.lastGood = new Map(result.bodies.map((b) => [b.id, b.mesh]));
      for (const id of this.ghosts) v.setGhost(id, null);
      this.ghosts.clear();
    } else {
      for (const [id, mesh] of this.lastGood) {
        const current = result.bodies.find((b) => b.id === id)?.mesh;
        if (current === mesh) continue;
        v.setGhost(id, mesh);
        this.ghosts.add(id);
      }
    }
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  /** Which sketches are shown: unconsumed ones, or any when regions are being picked. */
  refreshSketchVisibility(): void {
    const v = this.viewport;
    const view = this.regen.get();
    if (!v || !view) return;
    const part = this.part;
    const u = this.ui.get();
    const wantRegions =
      u.prompt?.tool === 'extrude' ||
      u.prompt?.tool === 'revolve' ||
      (u.picking !== null && acceptsFor(u.picking.path).kinds.includes('region'));
    const editing = u.featureId ? part?.features.find((f) => f.id === u.featureId) : undefined;
    const next = new Set<string>();
    for (const s of view.result.sketches) {
      if (u.sketch?.featureId === s.featureId) {
        next.add(s.featureId);
        continue; // the sketch session owns the active overlay
      }
      const consumed = part?.features.some(
        (f) =>
          (f.type === 'extrude' || f.type === 'revolve') &&
          f.profile.some((r) => r.name.startsWith(`S${s.featureId}:`)),
      );
      const related =
        editing?.id === s.featureId ||
        ((editing?.type === 'extrude' || editing?.type === 'revolve') &&
          editing.profile.some((r) => r.name.startsWith(`S${s.featureId}:`)));
      if (consumed && !wantRegions && !related) continue;
      v.setSketch(s.featureId, { sketch: s, active: false });
      next.add(s.featureId);
    }
    for (const id of this.shownSketches) if (!next.has(id)) v.setSketch(id, null);
    this.shownSketches = next;
  }

  /** Selection + preselection highlights (sketch mode adds its own). */
  pushHighlights(): void {
    const v = this.viewport;
    if (!v) return;
    const u = this.ui.get();
    if (u.sketch) {
      this.sketch?.pushHighlights();
      return;
    }
    const view = this.regen.get();
    const fix = (h: HighlightItem): HighlightItem => {
      if (h.kind !== 'region' || !view) return h;
      const s = view.result.sketches.find((x) => x.featureId === h.bodyId);
      const i = s?.regions.findIndex((r) => r.name === h.entity) ?? -1;
      return i >= 0 ? { ...h, index: i } : h;
    };
    const selected = u.selection.map((s) => fix(toHighlight(s.hit)));
    // Refs of the feature being edited show as selected too.
    const editing = u.featureId ? this.part?.features.find((f) => f.id === u.featureId) : null;
    if (editing && view) selected.push(...this.highlightsForRefs(editing, view.result));
    v.setHighlights({ selected, preselected: u.hover ? [fix(toHighlight(u.hover))] : [] });
  }

  private highlightsForRefs(f: Feature, result: RegenResult): HighlightItem[] {
    const out: HighlightItem[] = [];
    const refs: EntityRef[] =
      f.type === 'extrude' || f.type === 'revolve'
        ? f.profile
        : f.type === 'fillet' || f.type === 'chamfer'
          ? f.edges
          : [];
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
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ pointer input

  /** Canvas-relative CSS px of a pointer event. */
  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  /** Kinds selectable right now (model mode). */
  private pickKinds(): PickKind[] {
    const u = this.ui.get();
    if (u.picking) return acceptsFor(u.picking.path).kinds;
    if (u.prompt) return TOOL_NEEDS[u.prompt.tool].kinds;
    return ['face', 'edge', 'vertex', 'region'];
  }

  private pick(e: PointerEvent | MouseEvent, kinds: PickKind[], all = true): PickHit[] {
    const v = this.viewport;
    if (!v) return [];
    const { x, y } = this.local(e);
    const type = 'pointerType' in e ? e.pointerType : 'mouse';
    return v.pick(x, y, { kinds, tolerancePx: toleranceFor(type), all });
  }

  /** Only presses on the canvas itself count (not the view cube or other host children). */
  private onCanvas(e: Event): boolean {
    return e.target === this.canvas;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.onCanvas(e)) return;
    if (this.ui.get().sketch) {
      this.sketch?.onPointerMove(e);
      return;
    }
    if (e.buttons !== 0) return; // orbiting
    const { best } = resolvePick(this.pick(e, this.pickKinds()));
    this.setHover(best);
  }

  private setHover(hit: PickHit | null): void {
    const u = this.ui.get();
    if (u.sketch) {
      this.sketch?.setHover(null);
      return;
    }
    const same =
      (hit === null && u.hover === null) || (hit && u.hover && hitKey(hit) === hitKey(u.hover));
    if (same) return;
    this.patchUi({ hover: hit });
    this.pushHighlights();
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.onCanvas(e)) {
      this.down = null;
      return;
    }
    this.down = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType };
    if (this.ui.get().sketch) this.sketch?.onPointerDown(e);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (this.ui.get().sketch) {
      this.sketch?.onPointerUp(e, d);
      return;
    }
    if (!d || d.id !== e.pointerId || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // it was an orbit drag
    this.onClick(e);
  }

  private onClick(e: PointerEvent): void {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const { best, ties } = resolvePick(this.pick(e, this.pickKinds()));
    if (ties.length > 1) {
      this.patchUi({ chooser: { x: e.clientX, y: e.clientY, hits: ties, additive } });
      return;
    }
    void this.choose(best, additive);
  }

  /** A hit was chosen (click or "Which one?"). */
  async choose(hit: PickHit | null, additive = false): Promise<void> {
    this.patchUi({ chooser: null });
    const u = this.ui.get();
    const part = this.part;
    if (!part) return;
    if (u.picking) {
      if (!hit) return;
      const f = part.features.find((x) => x.id === u.picking?.featureId);
      if (!f) return;
      const accepts = acceptsFor(u.picking.path);
      const ref = await this.refFor(hit, accepts.as);
      if (!ref) return this.toast('That can’t be referenced yet — try again in a moment.', 'info');
      const next = applyPick(f, u.picking.path, ref);
      if (next !== f)
        this.apply({ kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next });
      this.commit();
      // Replacing one entry ends picking; adding to a list keeps it open.
      if (/\/\d+$/.test(u.picking.path) || !Array.isArray(pointerValue(f, u.picking.path)))
        this.patchUi({ picking: null });
      return;
    }
    if (u.prompt) {
      if (!hit) return;
      await this.selectHit(hit, false);
      await this.runTool(u.prompt.tool);
      return;
    }
    if (!hit) {
      if (!additive) this.clearSelection();
      return;
    }
    await this.selectHit(hit, additive);
  }

  private async refFor(hit: PickHit, as?: EntityRef['kind']): Promise<EntityRef | null> {
    const part = this.part;
    const modeling = this.modeling;
    if (!part) return null;
    return refForHit(hit, part.id, (p, q) => modeling?.refFor(p, q) ?? Promise.resolve(null), as);
  }

  private async selectHit(hit: PickHit, additive: boolean): Promise<void> {
    const key = hitKey(hit);
    const u = this.ui.get();
    const exists = u.selection.some((s) => s.key === key);
    let selection: SelectionItem[];
    if (additive) {
      selection = exists
        ? u.selection.filter((s) => s.key !== key)
        : [...u.selection, { key, hit, ref: null }];
    } else selection = [{ key, hit, ref: null }];
    this.patchUi({ selection, featureId: null });
    this.pushHighlights();
    const ref = await this.refFor(hit);
    this.ui.set((s) => ({
      ...s,
      selection: s.selection.map((x) => (x.key === key ? { ...x, ref } : x)),
    }));
  }

  clearSelection(): void {
    this.patchUi({ selection: [], featureId: null, picking: null });
    this.pushHighlights();
  }

  // ------------------------------------------------------------------ tools

  /** Command bar / shortcut / context action. */
  async runTool(tool: ToolId): Promise<void> {
    if (this.ui.get().sketch) return;
    const part = this.part;
    if (!part) return;
    if (
      tool !== 'sketch' &&
      tool !== 'extrude' &&
      tool !== 'revolve' &&
      tool !== 'fillet' &&
      tool !== 'chamfer'
    )
      return;
    const u = this.ui.get();
    const need = TOOL_NEEDS[tool];
    const picked = u.selection.filter((s) => need.kinds.includes(s.hit.kind));
    if (picked.length === 0 || picked.length !== u.selection.length) {
      // Act first, select second.
      this.patchUi({
        prompt: { tool, text: need.prompt },
        selection: [],
        featureId: null,
        picking: null,
        lastTool: tool,
      });
      this.refreshSketchVisibility();
      this.pushHighlights();
      return;
    }
    const refs: EntityRef[] = [];
    for (const s of picked) {
      const ref = s.ref ?? (await this.refFor(s.hit));
      if (ref) refs.push(ref);
    }
    if (refs.length === 0) return this.toast('That selection can’t be referenced yet.', 'info');
    this.patchUi({ prompt: null, selection: [], lastTool: tool });
    const bodies = this.regen.get()?.result.bodies.length ?? 0;
    let feature: Feature;
    switch (tool) {
      case 'sketch':
        return this.startSketch(refs[0] as EntityRef);
      case 'extrude':
        feature = newExtrude(part, refs, bodies);
        break;
      case 'revolve': {
        const sk = part.features.find(
          (f): f is SketchFeature =>
            f.type === 'sketch' && (refs[0]?.name ?? '').startsWith(`S${f.id}:`),
        );
        feature = newRevolve(part, refs, defaultAxisFor(sk), bodies);
        break;
      }
      case 'fillet':
        feature = newFillet(part, refs);
        break;
      case 'chamfer':
        feature = newChamfer(part, refs);
        break;
    }
    this.addFeature(feature, need.path);
  }

  /** Adds a feature and opens its inspector, keeping its main pick field live. */
  addFeature(feature: Feature, pickPath?: string): void {
    const part = this.part;
    if (!part) return;
    if (!this.apply({ kind: 'addFeature', partId: part.id, feature })) return;
    this.commit();
    this.patchUi({
      featureId: feature.id,
      picking: pickPath ? { featureId: feature.id, path: pickPath } : null,
      selection: [],
      prompt: null,
    });
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  addPrimitive(shape: 'box' | 'cylinder'): void {
    const part = this.part;
    if (!part) return;
    this.addFeature(shape === 'box' ? newBox(part) : newCylinder(part));
  }

  addPlane(): void {
    const part = this.part;
    if (!part) return;
    this.addFeature(newPlane(part, { name: 'origin:XY', kind: 'face' }), '/definition/from');
  }

  addBoolean(): void {
    const part = this.part;
    const bodies = this.regen.get()?.result.bodies ?? [];
    if (!part) return;
    if (bodies.length < 2) {
      this.toast('A boolean needs at least two bodies.', 'info');
      return;
    }
    const [target, ...tools] = bodies.map((b) => ({ name: b.id, kind: 'body' as const }));
    if (!target) return;
    void import('../features/factories').then(({ newBoolean }) =>
      this.addFeature(newBoolean(part, target, tools)),
    );
  }

  /** Esc: closes the innermost transient state. Returns whether anything was cancelled. */
  cancel(): boolean {
    const u = this.ui.get();
    if (u.chooser) this.patchUi({ chooser: null });
    else if (u.picking) this.patchUi({ picking: null });
    else if (u.prompt) this.patchUi({ prompt: null });
    else if (u.selection.length) this.clearSelection();
    else if (u.featureId) this.patchUi({ featureId: null });
    else if (u.library) this.patchUi({ library: false });
    else return false;
    this.refreshSketchVisibility();
    this.pushHighlights();
    return true;
  }

  // ------------------------------------------------------------------ feature tree / inspector

  selectFeature(id: Id | null): void {
    this.patchUi({ featureId: id, picking: null, selection: [], prompt: null });
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  editFeature(id: Id): void {
    const f = this.part?.features.find((x) => x.id === id);
    if (!f) return;
    if (f.type === 'sketch') void this.enterSketch(f.id, false);
    else this.selectFeature(id);
  }

  updateFeature(feature: Feature, mode: 'commit' | 'preview'): void {
    const part = this.part;
    if (!part) return;
    const key = `edit:${feature.id}`;
    this.apply(
      { kind: 'updateFeature', partId: part.id, featureId: feature.id, feature },
      undefined,
      key,
    );
    if (mode === 'commit') this.commit();
  }

  startPicking(featureId: Id, path: string): void {
    this.patchUi({ picking: { featureId, path }, selection: [] });
    this.refreshSketchVisibility();
  }

  evaluate = (expr: Expr, expected?: NamedDimension): EvalResult => {
    const scope = scopeOf(this.doc);
    if (expected) return expressionEngine.evaluate(expr, expected, scope);
    const r = expressionEngine.evaluateAny(expr, scope);
    return r.ok ? { ok: true, value: r.value, dimension: r.dimension, dependsOn: r.dependsOn } : r;
  };

  setMaterial(material: Material | null): void {
    const part = this.part;
    if (part) this.apply({ kind: 'setMaterial', partId: part.id, material });
    this.commit();
    this.syncViewport();
  }

  renameDocument(name: string): void {
    const n = name.trim();
    if (!n || n === this.doc.meta.name) return;
    this.apply({ kind: 'setDocName', name: n });
    this.commit();
  }

  massSummary(): MassSummaryView | undefined {
    const bodies = this.regen.get()?.result.bodies ?? [];
    const props = bodies.flatMap((b) => (b.massProperties ? [b.massProperties] : []));
    if (props.length === 0) return undefined;
    let volume = 0;
    let area = 0;
    let mass = 0;
    let hasMass = false;
    const c: [number, number, number] = [0, 0, 0];
    for (const p of props) {
      volume += p.volume;
      area += p.area;
      if (p.mass !== undefined) {
        mass += p.mass;
        hasMass = true;
      }
      for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (p.centroid[k] as number) * p.volume;
    }
    const centroid: [number, number, number] =
      volume > 0 ? [c[0] / volume, c[1] / volume, c[2] / volume] : [0, 0, 0];
    return { volume, area, centroid, ...(hasMass ? { mass } : {}) };
  }

  // ------------------------------------------------------------------ sketch mode

  private loadSketch(): Promise<typeof import('./sketch-session')> {
    this.sketchModule ??= import('./sketch-session');
    return this.sketchModule;
  }

  /** Sketch tool: plane chooser prompt (or straight in with a selected planar face). */
  sketchTool(): void {
    void this.runTool('sketch');
    void this.loadSketch(); // warm the chunk while the user picks a plane
  }

  async startSketch(on: EntityRef): Promise<void> {
    const part = this.part;
    if (!part) return;
    const f = newSketch(part, on);
    if (!this.apply({ kind: 'addFeature', partId: part.id, feature: f })) return;
    this.commit();
    await this.enterSketch(f.id, true);
  }

  async enterSketch(featureId: Id, isNew: boolean): Promise<void> {
    const mod = await this.loadSketch();
    this.sketch?.dispose();
    this.patchUi({
      prompt: null,
      picking: null,
      selection: [],
      featureId: null,
      hover: null,
      chooser: null,
    });
    this.sketch = new mod.SketchSession(this, featureId, isNew);
    this.sketch.enter();
  }

  /** Frame of a sketch: origin planes locally, otherwise from the latest regen. */
  sketchFrame(f: SketchFeature): PlaneFrame | null {
    if (isOriginPlane(f.on.name)) return toPlaneFrame(ORIGIN_FRAMES[f.on.name]);
    const s = this.regen.get()?.result.sketches.find((x) => x.featureId === f.id);
    return s ? s.frame : null;
  }

  sketchClosed(): void {
    this.sketch = null;
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  // ------------------------------------------------------------------ keyboard

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (k === 'z' && !isTyping(e.target)) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (k === 'y' && !isTyping(e.target)) {
        e.preventDefault();
        this.redo();
      } else if (k === 's') {
        e.preventDefault();
        void this.exportWhittle();
      } else if (k === 'o') {
        e.preventDefault();
        void this.openFromDisk();
      }
      return;
    }
    if (isTyping(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
    if (this.ui.get().sketch) {
      if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        this.sketch?.deleteSelected();
      }
      return; // the sketch toolbar owns L/A/D/Esc
    }
    if (e.key === 'Escape') {
      if (this.cancel()) e.preventDefault();
      return;
    }
    if (e.shiftKey) return;
    const tools: Record<string, ModelTool> = {
      s: 'sketch',
      e: 'extrude',
      r: 'revolve',
      f: 'fillet',
      c: 'chamfer',
    };
    const tool = tools[k];
    if (tool) {
      e.preventDefault();
      if (tool === 'sketch') this.sketchTool();
      else void this.runTool(tool);
    } else if (k === ' ' && this.ui.get().lastTool) {
      e.preventDefault();
      const last = this.ui.get().lastTool as ModelTool;
      if (last === 'sketch') this.sketchTool();
      else void this.runTool(last);
    } else if (/^[0-7]$/.test(k)) {
      const views = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const;
      this.viewport?.setView(views[Number(k)] ?? 'iso', true);
    }
  }

  // ------------------------------------------------------------------ library & files

  private async saveToLibrary(doc: WhittleDoc): Promise<void> {
    const lib = await this.library();
    if (!lib) return;
    const thumb = await this.thumbnail();
    await lib.save(doc, thumb);
    writeLastDoc(doc.meta.id);
    if (this.ui.get().library) void this.refreshLibrary();
  }

  /** Saves pending changes now (page hidden, switching documents, tests). */
  flushSave(): Promise<void> {
    return this.autosaver.flush();
  }

  private async thumbnail(): Promise<Uint8Array | undefined> {
    const canvas = this.canvas;
    const v = this.viewport;
    if (!canvas || !v || this.shownBodies.size === 0) return undefined;
    const now = performance.now();
    if (now - this.lastThumbAt < THUMB_EVERY_MS) return undefined;
    this.lastThumbAt = now;
    try {
      const { canvasToThumbnail } = await import('../doc/library');
      // Read pixels in the same task as a fresh frame (the drawing buffer is not preserved).
      await v.nextFrame();
      return await canvasToThumbnail(canvas, { width: 256, height: 192 });
    } catch {
      return undefined;
    }
  }

  private maybeThumbnail(): void {
    // Fine results are the nicest picture; the next autosave picks it up.
    this.lastThumbAt = Math.min(this.lastThumbAt, performance.now() - THUMB_EVERY_MS);
  }

  async refreshLibrary(query = ''): Promise<void> {
    const lib = await this.library();
    this.libraryEntries.set(lib ? await lib.list(query) : []);
  }

  toggleLibrary(open = !this.ui.get().library): void {
    this.patchUi({ library: open });
    if (open) void this.flushSave().then(() => this.refreshLibrary());
  }

  /** Replaces the open document (history cleared). */
  private loadDocument(doc: WhittleDoc): void {
    this.sketch?.exit(false);
    this.patchUi({ selection: [], featureId: null, picking: null, prompt: null, hover: null });
    const old = this.part?.id;
    const r = this.store.load(doc);
    if (!r.ok) {
      this.toast(r.error, 'error');
      return;
    }
    writeLastDoc(doc.meta.id);
    if (old && old !== this.part?.id) void this.modeling?.closePart(old);
    this.viewport?.fitAll(false);
  }

  async newDocument(): Promise<void> {
    await this.flushSave();
    this.loadDocument(freshDocument());
    this.patchUi({ library: false });
  }

  async openFromLibrary(id: string): Promise<void> {
    await this.flushSave();
    const lib = await this.library();
    if (!lib) return;
    try {
      this.loadDocument(await lib.open(id));
      this.patchUi({ library: false });
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Could not open that document', 'error');
    }
  }

  async renameInLibrary(id: string, name: string): Promise<void> {
    if (id === this.doc.meta.id) {
      this.renameDocument(name);
      await this.flushSave();
    } else {
      const lib = await this.library();
      await lib?.rename(id, name);
    }
    await this.refreshLibrary();
  }

  async deleteFromLibrary(id: string): Promise<void> {
    const lib = await this.library();
    if (!lib) return;
    if (id === this.doc.meta.id) {
      this.autosaver.cancel();
      await lib.remove(id);
      this.loadDocument(freshDocument());
      this.patchUi({ library: true });
    } else await lib.remove(id);
    await this.refreshLibrary();
  }

  async openFromDisk(): Promise<void> {
    const { openFile } = await import('../doc/library');
    const f = await openFile(['.whittle', '.step', '.stp']);
    if (f) await this.openBytes(f.name, f.bytes);
  }

  async openBytes(name: string, bytes: Uint8Array): Promise<void> {
    if (/\.whittle$/i.test(name)) {
      try {
        const { fromWhittleBytes } = await import('../doc/library');
        await this.flushSave();
        const doc = fromWhittleBytes(bytes);
        this.loadDocument(doc);
        this.autosaver.schedule(doc); // opened from disk: keep a copy in the library
      } catch (e) {
        this.toast(e instanceof Error ? e.message : 'That file could not be read', 'error');
      }
      return;
    }
    this.toast('STEP import arrives with the regen engine (M1 merge).', 'info');
  }

  async exportWhittle(): Promise<void> {
    const { toWhittleBytes, saveFile, MIME } = await import('../doc/library');
    await saveFile(
      toWhittleBytes(this.doc),
      `${fileBase(this.doc.meta.name)}.whittle`,
      MIME.whittle,
    );
  }

  async export(request: ExportRequest): Promise<void> {
    const part = this.part;
    const view = this.regen.get();
    if (!part) return;
    this.patchUi({ exporting: true });
    try {
      const lib = await import('../doc/library');
      const base = fileBase(this.doc.meta.name);
      if (request.target === 'whittle') return await this.exportWhittle();
      if (request.target === '3mf' || request.target === 'glb') {
        const bodies = (view?.result.bodies ?? []).filter(
          (b) => !request.options.bodies || request.options.bodies.includes(b.id),
        );
        if (bodies.length === 0) return this.toast('There is nothing to export yet.', 'info');
        const { meshExporters } = await import('@whittle/io');
        const color = this.bodyColor();
        const items = bodies.map((b, i) => ({
          name: `Body ${i + 1}`,
          mesh: b.mesh,
          ...(color ? { color } : {}),
        }));
        const bytes =
          request.target === '3mf'
            ? meshExporters.to3mf(items, 'millimeter')
            : meshExporters.toGlb(items);
        await lib.saveFile(bytes, `${base}.${request.target}`, lib.MIME[request.target]);
        return;
      }
      const modeling = this.modeling;
      if (!modeling) return this.toast('The geometry kernel is still loading.', 'info');
      const r = await modeling.exportPart(part.id, request.target, request.options);
      if (!r.ok) return this.toast(r.error.message, 'error');
      const ext = request.target === 'step' ? 'step' : request.target;
      await lib.saveFile(r.bytes, `${base}.${ext}`, lib.MIME[request.target]);
    } finally {
      this.patchUi({ exporting: false });
    }
  }

  // ------------------------------------------------------------------ misc

  patchUi(patch: Partial<UiState>): void {
    this.ui.set((u) => ({ ...u, ...patch }));
  }

  toast(text: string, tone: 'info' | 'error' = 'info'): void {
    clearTimeout(this.toastTimer);
    this.patchUi({ toast: { id: ++this.toastSeq, text, tone } });
    this.toastTimer = setTimeout(
      () => this.patchUi({ toast: null }),
      tone === 'error' ? 6000 : 3500,
    );
  }

  /** Context tools for the current selection (select first, act second). */
  selectionTools(): ModelTool[] {
    return contextTools(this.ui.get().selection.map((s) => s.hit.kind));
  }

  /** Test hooks: document, regen summary, idle. */
  testHooks() {
    return {
      doc: () => this.doc,
      regen: () => {
        const r = this.regen.get()?.result;
        return r
          ? {
              revision: r.revision,
              bodies: r.bodies.map((b) => ({ id: b.id, volume: b.massProperties?.volume ?? null })),
              features: r.features.map((f) => ({ id: f.featureId, state: f.state })),
              sketches: r.sketches.map((s) => ({
                id: s.featureId,
                regions: s.regions.map((x) => x.name),
              })),
            }
          : null;
      },
      idle: async () => {
        await this.boot?.modeling;
        for (let i = 0; i < 50 && !this.loop; i++) await new Promise((r) => setTimeout(r, 20));
        await this.loop?.whenIdle();
        await this.viewport?.nextFrame();
      },
      flushSave: () => this.flushSave(),
      sketch: () => this.ui.get().sketch?.solve ?? null,
    };
  }
}

function pointerValue(f: Feature, path: string): unknown {
  let cur: unknown = f;
  for (const s of path.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

function fileBase(name: string): string {
  return (name.trim() || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-');
}
