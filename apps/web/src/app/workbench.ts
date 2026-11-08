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
  ProjectFiles,
  RegenResult,
  SketchFeature,
  WhittleDoc,
} from '@whittle/contracts';
import {
  compileCommand,
  createDocumentStore,
  type DocumentStoreImpl,
  expressionEngine,
  newDoc,
  scopeOf,
  ulid,
} from '@whittle/document';
import type { ExportRequest, ToolId } from '@whittle/ui';
import { type Autosaver, createAutosaver } from '../doc/autosave';
import type { DocLibrary, OpenedFile, ProjectBundle } from '../doc/library';
import {
  type CachedGeometry,
  decodeCache,
  docKey,
  encodeCache,
  withoutMeshes,
} from '../doc/mesh-cache';
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
import { attentionItems, locateName, markerMesh, partDiagonal } from '../model/attention';
import { bootEngine, type EngineBoot } from '../model/engine';
import { isOriginPlane, ORIGIN_FRAMES, type PlaneFrame, toPlaneFrame } from '../model/frames';
import { foldHeals, type Heal, healsFrom } from '../model/heal';
import { IMPORT_EXTENSIONS, importFeature, importFormat } from '../model/import';
import { type Attachment, createRegenLoop, type Modeling, type RegenLoop } from '../model/modeling';
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
import { failBoot, mark, markOnce, marks } from './timing';

const LAST_DOC_KEY = 'whittle:last-document';
/**
 * Library thumbnails read the WebGL canvas back (≈ 200 ms on software GL), so while editing they
 * are taken at most this often; flushes (page hidden, switching documents, opening the library)
 * and a document's first save always take one.
 */
const THUMB_EVERY_MS = 30_000;

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
  private markers = new Set<string>();
  /** Project files outside the document model (attachments, previews/, releases/). */
  private extra: ProjectFiles = new Map();
  /** `.whittle/` cache of the open project (mesh cache, other regenerable files). */
  private cache: ProjectFiles = new Map();
  /** Document key of the meshes in `cache` and of the last cache that reached the library. */
  private cacheKey: string | null = null;
  private savedCacheKey: string | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open document has a library entry (saved or opened from it). */
  private inLibrary = false;
  /** Rebound reference names waiting to be folded into the next user edit (ADR-008). */
  private heals = new Map<Id, Heal[]>();
  /** The document the pending heals were computed for: only that exact version may take them. */
  private healsFor: WhittleDoc | null = null;
  /** Auto-fit once per opened document, then leave the camera to the user. */
  private fitPending = true;
  private initialBundle: Promise<ProjectBundle | null> | null = null;
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
    // Coalescing groups are closed explicitly (pointer up, Enter, blur); the idle window only
    // guards against a forgotten commit, so it is long enough that a drag or a typed value on a
    // busy main thread (software GL, long regens) never splits into several undo steps.
    this.store = createDocumentStore(freshDocument(), { coalesceWindowMs: 10_000 });
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
      this.ui.subscribe(() => this.onUiChange()),
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
   * Starts reading the last document (and its mesh cache) from the library before React renders,
   * so a cached document is on screen before the kernel is ready (PLAN §10: ≤ 500 ms).
   */
  prefetchInitialDocument(): void {
    if (this.initialBundle) return;
    const lastId = readLastDoc();
    this.initialBundle = lastId
      ? this.library().then(async (lib) => {
          if (!lib) return null;
          try {
            const bundle = await lib.open(lastId);
            markOnce('libraryOpenMs');
            return bundle;
          } catch (e) {
            console.warn('Could not reopen the last document:', String(e));
            writeLastDoc(undefined);
            return null;
          }
        })
      : Promise.resolve(null);
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

  /**
   * Settles once the last document has been read from the library (or at most `timeoutMs`): the
   * viewport waits for it before compiling its shaders, which would otherwise hold up the read.
   */
  initialDocumentRead(timeoutMs = 400): Promise<void> {
    this.prefetchInitialDocument();
    const read = (this.initialBundle ?? Promise.resolve(null)).then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([read, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  private async resolveInitialDocument(): Promise<void> {
    if (!readLastDoc()) this.patchUi({ welcome: true }); // first launch
    this.prefetchInitialDocument();
    const bundle = await this.initialBundle;
    if (bundle && !this.ui.get().ready) {
      if (this.store.load(bundle.doc).ok) {
        this.setProjectFiles(bundle, true);
        this.showCached(bundle.doc);
      }
    }
    this.ui.set((u) => ({ ...u, ready: true }));
    this.loop?.request();
    void import('../doc/library').then(({ onLaunchFiles }) =>
      onLaunchFiles((files) => {
        const f = files[0];
        // Opened from the OS (double-click, "Open with"): a CAD file starts its own document
        // rather than landing in whatever was open last.
        if (f) void this.openBytes(f.name, f.bytes, 'new');
      }),
    );
  }

  private onEngineReady(modeling: Modeling): void {
    this.modeling = modeling;
    this.engine.set((s) => ({ ...s, ready: true }));
    this.loop = createRegenLoop({
      port: modeling.port,
      getDoc: () => this.viewDoc(),
      onResult: (o) => this.onRegen({ ...o, source: 'live' }),
      onError: (e) => this.toast(e.message, 'error'),
      attachments: (doc) => this.attachmentsFor(doc),
    });
    if (this.ui.get().ready) this.loop.request();
  }

  /**
   * The document as regenerated for display. While an inspector pick field takes edges or faces,
   * the model is rolled back to just before that feature (as Onshape does), so picks name the
   * feature's *input* geometry, never its own output.
   */
  viewDoc(): WhittleDoc {
    const doc = this.store.getDoc();
    const p = this.ui.get().picking;
    const part = doc.parts[0];
    if (!p || !part) return doc;
    const kinds = acceptsFor(p.path).kinds;
    if (!kinds.some((k) => k === 'edge' || k === 'face' || k === 'vertex')) return doc;
    const idx = part.features.findIndex((f) => f.id === p.featureId);
    if (idx < 0 || idx >= part.rollbackIndex) return doc;
    const memo = this.viewMemo;
    if (memo && memo.doc === doc && memo.index === idx) return memo.out;
    const out = { ...doc, parts: [{ ...part, rollbackIndex: idx }, ...doc.parts.slice(1)] };
    this.viewMemo = { doc, index: idx, out };
    return out;
  }

  private viewMemo: { doc: WhittleDoc; index: number; out: WhittleDoc } | null = null;
  private lastPickKey = '';
  /** Feature statuses of the last regen of the real (not rolled-back-for-picking) document. */
  readonly treeStatuses = observable<RegenResult['features'] | undefined>(undefined);

  private onUiChange(): void {
    const p = this.ui.get().picking;
    const key = p ? `${p.featureId}|${p.path}` : '';
    if (key !== this.lastPickKey) {
      this.lastPickKey = key;
      this.loop?.request();
    }
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
    if (!loaded && this.ui.get().welcome) this.patchUi({ welcome: false });
    const part = this.part;
    const ids = new Set(part?.features.map((f) => f.id));
    const u = this.ui.get();
    if (u.featureId && !ids.has(u.featureId)) this.patchUi({ featureId: null, picking: null });
    if (u.sketch && !ids.has(u.sketch.featureId)) this.sketch?.exit(false);
    this.sketch?.onDocChange();
    this.refreshSketchVisibility();
  }

  apply(command: Command, label?: string, coalesceKey?: string): boolean {
    // Stale reference names the engine rebound ride along with this edit (ADR-008).
    // Heals from a regen of another version (before an undo/redo/load) would rename references
    // that version had: drop them; the next regen of this version computes its own.
    const heals = this.healsFor === this.store.getDoc() ? this.heals : new Map<Id, Heal[]>();
    const folded = foldHeals(command, this.part ?? undefined, heals, (c) =>
      compileCommand(this.store.getDoc(), c),
    );
    this.heals = new Map();
    this.healsFor = null;
    const lbl = label ?? folded.label;
    const r = this.store.apply(folded.command, {
      ...(lbl ? { label: lbl } : {}),
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

  /** Undo/redo wait for sketch edits still being solved (they land first, then are undone). */
  undo(): void {
    const run = () => {
      if (!this.store.undo()) this.toast('Nothing to undo', 'info');
    };
    if (this.sketch?.busy) void this.sketch.whenSettled().then(run);
    else run();
  }

  redo(): void {
    const run = () => {
      if (!this.store.redo()) this.toast('Nothing to redo', 'info');
    };
    if (this.sketch?.busy) void this.sketch.whenSettled().then(run);
    else run();
  }

  // ------------------------------------------------------------------ regeneration → viewport

  private onRegen(outcome: RegenView): void {
    const current = outcome.doc === this.store.getDoc();
    if (current || !this.ui.get().picking) this.treeStatuses.set(outcome.result.features);
    if (current) {
      this.heals = healsFrom(outcome.result.features);
      this.healsFor = outcome.doc;
    }
    this.regen.set(outcome);
    this.remapSelection(outcome.result);
    this.syncViewport();
    this.sketch?.onRegen(outcome.result);
    this.keepInView(outcome);
    if (!this.firstRendered && this.viewport && outcome.source === 'live') {
      this.firstRendered = true;
      void this.viewport.nextFrame().then(() => mark('firstBodyMs'));
    }
    if (outcome.quality === 'fine') {
      if (current) this.updateMeshCache(outcome);
    }
  }

  /**
   * Fits the view once per opened document — when its first geometry arrives, and, for a document
   * that started empty, when its first body would not be fully visible — then leaves the camera to
   * the user.
   */
  private keepInView(view: RegenView): void {
    const v = this.viewport;
    if (!v || !this.fitPending || this.ui.get().sketch) return;
    const bodies = view.result.bodies;
    if (bodies.length === 0) return;
    this.fitPending = false;
    const outside = bodies.some((b) => {
      const { min, max } = b.mesh.bbox;
      for (const x of [min[0], max[0]])
        for (const y of [min[1], max[1]])
          for (const z of [min[2], max[2]]) if (!v.worldToScreen([x, y, z]).visible) return true;
      return false;
    });
    if (this.fitOnFirstGeometry || outside) v.fitAll(false);
  }

  /** Set by document loads (the first geometry always fits); a fresh empty document fits only if needed. */
  private fitOnFirstGeometry = false;

  /** Shows the document's cached meshes until the live regen replaces them (PLAN §4). */
  private showCached(doc: WhittleDoc): void {
    const geometry = decodeCache(this.cache, docKey(doc));
    if (!geometry) return;
    this.cacheKey = geometry.key;
    this.savedCacheKey = geometry.key;
    const part = doc.parts[0];
    const current = this.regen.get();
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
    this.regen.set(view);
    this.syncViewport();
    this.keepInView(view);
    this.markCachedFrame();
  }

  private markCachedFrame(): void {
    const v = this.viewport;
    if (!v || this.regen.get()?.source !== 'cache' || !this.regen.get()?.result.bodies.length)
      return;
    void v.nextFrame().then(() => {
      if (this.regen.get()?.source === 'cache') markOnce('cachedBodyMs');
    });
  }

  /** Keeps the latest fine meshes in the project's `.whittle/` cache (saved with the document). */
  private updateMeshCache(view: RegenView): void {
    const key = docKey(view.doc);
    if (key === this.cacheKey) return;
    const geometry: CachedGeometry = {
      key,
      bodies: view.result.bodies.map((b) => ({ id: b.id, mesh: b.mesh })),
      sketches: view.result.sketches,
    };
    this.cache = new Map([...withoutMeshes(this.cache), ...encodeCache(geometry)]);
    this.cacheKey = key;
    // A save already queued for this document picks the cache up; otherwise save it shortly.
    if (!this.inLibrary || this.autosaver.pending) return;
    this.scheduleCacheSave();
  }

  /** Saves the document again shortly so a mesh cache newer than the stored one reaches it. */
  private scheduleCacheSave(): void {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      if (this.cacheKey !== this.savedCacheKey && docKey(this.doc) === this.cacheKey)
        void this.autosaver.flush().then(() => this.saveToLibrary(this.doc));
    }, 600);
  }

  /** Body pick indices change between regens: re-find selected faces/edges by name. */
  private remapSelection(result: RegenResult): void {
    const u = this.ui.get();
    const selection = u.selection.flatMap((s): SelectionItem[] => {
      const k = s.hit.kind;
      if ((k !== 'face' && k !== 'edge' && k !== 'vertex') || !s.ref) return [s];
      const body = result.bodies.find((b) => b.id === s.hit.bodyId);
      const names =
        k === 'face' ? body?.mesh.faceNames : k === 'edge' ? body?.mesh.edgeNames : undefined;
      const i = s.ref && names ? names.indexOf(s.ref.name) : -1;
      if (i < 0) return [];
      const hit = { ...s.hit, index: i };
      return [{ ...s, hit, key: hitKey(hit) }];
    });
    this.patchUi({ selection, hover: null });
  }

  attachViewport(viewport: InteractiveViewport, canvas: HTMLCanvasElement): void {
    markOnce('viewportReadyMs');
    this.viewport = viewport;
    this.canvas = canvas;
    const host = canvas.parentElement ?? canvas;
    this.cleanup.push(
      this.listen(host, 'pointermove', (e) => this.onPointerMove(e as PointerEvent)),
      this.listen(host, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true),
      this.listen(host, 'pointerup', (e) => this.onPointerUp(e as PointerEvent), true),
      this.listen(host, 'pointerleave', () => this.setHover(null)),
      this.listen(host, 'dblclick', (e) => this.sketch?.onDoubleClick(e as MouseEvent), true),
      this.listen(host, 'dragover', (e) => this.onDragOver(e as DragEvent)),
      this.listen(host, 'drop', (e) => void this.onDrop(e as DragEvent)),
    );
    this.syncViewport();
    const view = this.regen.get();
    if (view) this.keepInView(view);
    if (view?.source === 'live' && !this.firstRendered) {
      this.firstRendered = true;
      void viewport.nextFrame().then(() => mark('firstBodyMs'));
    }
    this.markCachedFrame();
  }

  private onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = 'copy';
  }

  /** Files dropped on the viewport: a `.whittle` opens, CAD/mesh files import into the part. */
  private async onDrop(e: DragEvent): Promise<void> {
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length === 0) return;
    e.preventDefault();
    const files = await Promise.all(
      list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const project = files.find((f) => /\.whittle$/i.test(f.name));
    if (project) await this.openBytes(project.name, project.bytes);
    else await this.importFiles(files, 'current');
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

    // Ghosts: last good geometry while something is in error (PLAN §9.2). The engine reports
    // them (`RegenResult.ghosts`); engines that don't get the app's own last-all-ok fallback.
    const broken = result.features.some(
      (s) => s.state === 'error' || s.state === 'needsAttention' || s.state === 'blocked',
    );
    const ghosts = new Map<string, MeshBuffers>();
    if (!broken) this.lastGood = new Map(result.bodies.map((b) => [b.id, b.mesh]));
    else if (result.ghosts) for (const g of result.ghosts) ghosts.set(g.id, g.mesh);
    else
      for (const [id, mesh] of this.lastGood)
        if (result.bodies.find((b) => b.id === id)?.mesh !== mesh) ghosts.set(id, mesh);
    for (const id of this.ghosts) if (!ghosts.has(id)) v.setGhost(id, null);
    for (const [id, mesh] of ghosts) v.setGhost(id, mesh);
    this.ghosts = new Set(ghosts.keys());
    this.syncAttentionMarkers();
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  /**
   * The old location of every unresolved reference, ghosted (PLAN §7.3 rule 4): a dashed proxy at
   * the stored fingerprint, until the user re-picks it.
   */
  private syncAttentionMarkers(): void {
    const v = this.viewport;
    if (!v) return;
    const items = attentionItems(this.treeStatuses.get());
    const size = Math.max(partDiagonal(this.regen.get()?.result) * 0.05, 0.5);
    const next = new Map<string, MeshBuffers>();
    for (const it of items) {
      // The stored fingerprint, else the engine's last known location of the reference.
      const { ref, lastKnown } = it.unresolved;
      const mesh = markerMesh(
        ref.fingerprint || !lastKnown ? ref : { ...ref, fingerprint: lastKnown },
        size,
      );
      if (mesh) next.set(`attention:${it.featureId}:${it.unresolved.path}`, mesh);
    }
    for (const id of this.markers) if (!next.has(id)) v.setGhost(id, null);
    for (const [id, mesh] of next) v.setGhost(id, mesh);
    this.markers = new Set(next.keys());
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
    const hits = v.pick(x, y, { kinds, tolerancePx: toleranceFor(type), all });
    // Sketch regions are all "0 px away": of stacked ones (a sketch on a face above another
    // sketch's region) the one nearest the camera is the one under the cursor.
    const cam = (
      v as { getCameraState?: () => { position: [number, number, number] } }
    ).getCameraState?.()?.position;
    if (!cam) return hits;
    const d = (h: PickHit) =>
      h.kind === 'region' ? Math.hypot(...h.point.map((c, k) => c - (cam[k] as number))) : 0;
    const regions = hits.filter((h) => h.kind === 'region').sort((p, q) => d(p) - d(q));
    return [...hits.filter((h) => h.kind !== 'region'), ...regions];
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
    if (u.welcome) this.patchUi({ welcome: false });
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
    else if (u.welcome) this.patchUi({ welcome: false });
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

  /** The open project's extra files and cache (open/new/import replace them). */
  private setProjectFiles(
    bundle: { extra?: ProjectFiles; cache?: ProjectFiles },
    inLibrary: boolean,
  ): void {
    this.extra = new Map(bundle.extra ?? []);
    this.cache = new Map(bundle.cache ?? []);
    this.cacheKey = null;
    this.savedCacheKey = null;
    this.inLibrary = inLibrary;
    this.heals = new Map();
    this.fitPending = true;
    this.fitOnFirstGeometry = true;
  }

  /** Attachment bytes of the document's import features (ImportFeature.source.path). */
  private attachmentsFor(doc: WhittleDoc): Attachment[] {
    const out: Attachment[] = [];
    for (const f of doc.parts[0]?.features ?? []) {
      if (f.type !== 'import') continue;
      const bytes = this.extra.get(f.source.path);
      if (bytes) out.push({ path: f.source.path, sha256: f.source.sha256, bytes });
    }
    return out;
  }

  private async saveToLibrary(doc: WhittleDoc): Promise<void> {
    const lib = await this.library();
    if (!lib) return;
    // A save can run after another document was loaded (it was scheduled or queued before the
    // switch): it must write *its* document's files, never the newly open one's.
    const current = doc.meta.id === this.doc.meta.id;
    const files = current
      ? { extra: this.extra, cache: this.cache, key: this.cacheKey }
      : this.retired.get(doc.meta.id ?? '');
    if (!files) return; // nothing known about that document's files: never guess them
    const thumbnail = current ? await this.thumbnail() : undefined;
    await lib.save(doc, {
      ...(thumbnail ? { thumbnail } : {}),
      extra: files.extra,
      cache: files.cache,
    });
    if (current && doc.meta.id === this.doc.meta.id) {
      this.inLibrary = true;
      this.savedCacheKey = files.key;
      writeLastDoc(doc.meta.id);
      // Finer meshes that arrived while this save ran (e.g. the first save of a new document,
      // when updateMeshCache could not schedule one yet) still need to reach the library.
      if (this.cacheKey !== files.key && !this.autosaver.pending) this.scheduleCacheSave();
    }
    if (this.ui.get().library) void this.refreshLibrary();
  }

  /** Files of documents that were replaced while a save of them may still be pending. */
  private retired = new Map<
    string,
    { extra: ProjectFiles; cache: ProjectFiles; key: string | null }
  >();

  /** Saves pending changes now (page hidden, switching documents, tests), with a thumbnail. */
  flushSave(): Promise<void> {
    this.thumbWanted = true;
    return this.autosaver.flush().finally(() => {
      this.thumbWanted = false;
    });
  }

  private thumbWanted = false;
  private thumbDocs = new Set<string>();

  private async thumbnail(): Promise<Uint8Array | undefined> {
    const canvas = this.canvas;
    const v = this.viewport;
    if (!canvas || !v || this.shownBodies.size === 0 || this.ui.get().sketch) return undefined;
    const now = performance.now();
    const id = this.doc.meta.id ?? '';
    const first = !this.thumbDocs.has(id);
    if (!first && !this.thumbWanted && now - this.lastThumbAt < THUMB_EVERY_MS) return undefined;
    this.lastThumbAt = now;
    this.thumbDocs.add(id);
    try {
      const { canvasToThumbnail } = await import('../doc/library');
      // Read pixels in the same task as a fresh frame (the drawing buffer is not preserved).
      await v.nextFrame();
      return await canvasToThumbnail(canvas, { width: 256, height: 192 });
    } catch {
      return undefined;
    }
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
  private loadDocument(
    bundle: { doc: WhittleDoc; extra?: ProjectFiles; cache?: ProjectFiles },
    inLibrary: boolean,
  ): boolean {
    this.sketch?.exit(false);
    this.patchUi({
      selection: [],
      featureId: null,
      picking: null,
      prompt: null,
      hover: null,
      chooser: null,
      candidates: null,
    });
    const old = this.part?.id;
    // Edits made while a switch was in flight are still pending for the outgoing document: save
    // them with that document's own files (snapshotted here), then let the new one load.
    const outgoing = this.doc.meta.id;
    if (outgoing && this.autosaver.pending) {
      this.retired.set(outgoing, { extra: this.extra, cache: this.cache, key: this.cacheKey });
      const flushed = this.autosaver.flush();
      void flushed.finally(() => {
        if (outgoing !== this.doc.meta.id) this.retired.delete(outgoing);
      });
    }
    const r = this.store.load(bundle.doc);
    if (!r.ok) {
      this.toast(r.error, 'error');
      return false;
    }
    clearTimeout(this.cacheTimer);
    this.setProjectFiles(bundle, inLibrary);
    writeLastDoc(bundle.doc.meta.id);
    if (old && old !== this.part?.id) {
      this.loop?.forget(old);
      void this.modeling?.closePart(old);
    }
    this.showCached(this.doc);
    return true;
  }

  async newDocument(): Promise<void> {
    await this.flushSave();
    this.loadDocument({ doc: freshDocument() }, false);
    this.patchUi({ library: false, welcome: false });
  }

  /** Opens an editable copy of the demo bracket (saved to the library right away). */
  async openDemo(): Promise<void> {
    await this.flushSave();
    const { demoBracket } = await import('../samples/bracket');
    const doc = demoBracket();
    this.loadDocument({ doc }, false);
    this.autosaver.schedule(doc);
    this.patchUi({ library: false, welcome: false });
  }

  async openFromLibrary(id: string): Promise<void> {
    await this.flushSave();
    const lib = await this.library();
    if (!lib) return;
    try {
      this.loadDocument(await lib.open(id), true);
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
      this.loadDocument({ doc: freshDocument() }, false);
      this.patchUi({ library: true });
    } else await lib.remove(id);
    await this.refreshLibrary();
  }

  /**
   * Open… : a `.whittle` project replaces the document; a CAD/mesh file is imported. `into`:
   * `current` adds the import to the open part (the inspector's Open…, ⌘O, drag and drop), `new`
   * starts a new document for it (library and welcome, where no part is being worked on).
   */
  async openFromDisk(into: 'current' | 'new' = 'current'): Promise<void> {
    const { openFile } = await import('../doc/library');
    const f = await openFile(['.whittle', ...IMPORT_EXTENSIONS]);
    if (f) await this.openBytes(f.name, f.bytes, into);
  }

  async openBytes(
    name: string,
    bytes: Uint8Array,
    into: 'current' | 'new' = 'current',
  ): Promise<void> {
    if (/\.whittle$/i.test(name)) {
      try {
        const { fromWhittleBytes } = await import('../doc/library');
        await this.openProject(fromWhittleBytes(bytes));
      } catch (e) {
        this.toast(e instanceof Error ? e.message : 'That file could not be read', 'error');
      }
      return;
    }
    await this.importFiles([{ name, bytes }], into);
  }

  /**
   * Opens a project from a file without ever overwriting a different library entry: the same
   * library id with different content (the entry was edited after this file was saved, or the
   * file comes from elsewhere) opens as a new entry — new id, " (copy)" when the name is taken —
   * and says so; only the identical project reuses its entry.
   */
  private async openProject(bundle: ProjectBundle): Promise<void> {
    await this.flushSave();
    const lib = await this.library();
    let { doc } = bundle;
    let note: string | null = null;
    let inLibrary = false;
    if (lib && doc.meta.id) {
      const { sameProject, copyName } = await import('../doc/library');
      // A lookup that fails is not "absent": treat it like a different version (open as a copy)
      // rather than letting autosave overwrite whatever is stored under that id.
      const existing = await lib.find(doc.meta.id).catch(() => 'unknown' as const);
      if (existing && existing !== 'unknown' && sameProject(existing, bundle)) inLibrary = true;
      else if (existing) {
        const names = new Set((await lib.list()).map((e) => e.name));
        const name = copyName(doc.meta.name, names);
        doc = { ...doc, meta: { ...doc.meta, id: ulid(), name } };
        note = `Opened as “${name}”: your library already has a different version of this document, and it is unchanged.`;
      }
    }
    if (!this.loadDocument({ ...bundle, doc }, inLibrary)) return;
    this.autosaver.schedule(this.doc); // opened from disk: keep a copy in the library
    this.patchUi({ library: false, welcome: false });
    if (note) this.toast(note, 'info');
  }

  /** Imports CAD/mesh files as ImportFeatures (attachments `imports/<featureId>.<ext>`). */
  async importFiles(files: readonly OpenedFile[], into: 'current' | 'new'): Promise<void> {
    const usable = files.filter((f) => importFormat(f.name));
    if (usable.length === 0) {
      const names = files.map((f) => f.name).join(', ');
      this.toast(
        `Whittle can open .whittle projects and import STEP, BREP, STL, OBJ, 3MF and GLB files${names ? ` (not ${names})` : ''}.`,
        'info',
      );
      return;
    }
    if (into === 'new' || !this.part) {
      await this.flushSave();
      const doc = freshDocument();
      const stem = (usable[0]?.name ?? 'Import').replace(/\.[^.]+$/, '');
      this.loadDocument({ doc: { ...doc, meta: { ...doc.meta, name: stem } } }, false);
    }
    if (this.ui.get().sketch) this.sketch?.exit(true);
    for (const f of usable) {
      const part = this.part;
      if (!part) return;
      const made = await importFeature(part, f.name, f.bytes);
      if (!made) continue;
      this.extra.set(made.path, f.bytes);
      if (
        !this.apply(
          { kind: 'addFeature', partId: part.id, feature: made.feature },
          `Import ${f.name}`,
        )
      )
        this.extra.delete(made.path);
      this.commit();
    }
    this.fitPending = true;
    this.fitOnFirstGeometry = true;
    this.patchUi({ library: false, welcome: false, selection: [], featureId: null });
  }

  async exportWhittle(): Promise<void> {
    const { toWhittleBytes, saveFile, MIME } = await import('../doc/library');
    await saveFile(
      toWhittleBytes(this.doc, this.extra, this.cache),
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
      if (!modeling || view?.source !== 'live')
        return this.toast('The geometry kernel is still loading.', 'info');
      const r = await modeling.exportPart(part.id, request.target, request.options);
      if (!r.ok) return this.toast(r.error.message, 'error');
      const ext = request.target === 'step' ? 'step' : request.target;
      await lib.saveFile(r.bytes, `${base}.${ext}`, lib.MIME[request.target]);
    } finally {
      this.patchUi({ exporting: false });
    }
  }

  // ------------------------------------------------------------------ needs attention

  /**
   * One-click re-pick of an unresolved reference: picking starts on that entry (the model rolls
   * back to the feature's input) and, when the engine found several candidates, the "Which one?"
   * chooser lists them at the reference's old location.
   */
  repick(featureId: Id, path?: string): void {
    const status = this.treeStatuses.get()?.find((s) => s.featureId === featureId);
    const u = path ? status?.unresolved?.find((x) => x.path === path) : status?.unresolved?.[0];
    const target = u?.path ?? path;
    if (!target) return;
    this.patchUi({ featureId, picking: { featureId, path: target }, selection: [], prompt: null });
    this.refreshSketchVisibility();
    this.pushHighlights();
    if (u?.reason === 'ambiguous' && u.candidates?.length) {
      const fp = u.ref.fingerprint?.centroid;
      const s = fp && this.viewport ? this.viewport.worldToScreen(fp) : null;
      const r = this.canvas?.getBoundingClientRect();
      this.patchUi({
        candidates: {
          featureId,
          path: target,
          kind: u.ref.kind,
          names: [...u.candidates],
          x: (r?.left ?? 0) + (s?.visible ? s.x : (r?.width ?? 0) / 2),
          y: (r?.top ?? 0) + (s?.visible ? s.y : (r?.height ?? 0) / 2),
        },
      });
    } else this.patchUi({ candidates: null });
  }

  /** A candidate from the "Which one?" list for an ambiguous reference. */
  async chooseCandidate(name: string | null): Promise<void> {
    const c = this.ui.get().candidates;
    this.patchUi({ candidates: null });
    if (!c || name === null) return;
    // The picking view (rolled back to the feature's input) holds the candidates.
    await this.loop?.whenIdle();
    const at = locateName(this.regen.get()?.result, name, c.kind);
    const part = this.part;
    const f = part?.features.find((x) => x.id === c.featureId);
    if (!part || !f) return;
    const ref = at ? await this.modeling?.refFor(part.id, at) : null;
    const next = applyPick(f, c.path, ref ?? { name, kind: c.kind });
    this.apply({ kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next });
    this.commit();
    this.patchUi({ picking: null });
  }

  /** Rough centre (mm) of a named face/edge in the current regen, for labels. */
  locate(name: string, kind: EntityRef['kind']): [number, number, number] | null {
    const result = this.regen.get()?.result;
    const at = locateName(result, name, kind);
    const mesh = result?.bodies.find((b) => b.id === at?.bodyId)?.mesh;
    if (!at || !mesh) return null;
    const sum: [number, number, number] = [0, 0, 0];
    let n = 0;
    const addPoint = (arr: Float32Array, i: number) => {
      sum[0] += arr[i * 3] as number;
      sum[1] += arr[i * 3 + 1] as number;
      sum[2] += arr[i * 3 + 2] as number;
      n++;
    };
    if (at.kind === 'edge') {
      const first = mesh.edgeRanges[at.index * 2] ?? 0;
      const count = mesh.edgeRanges[at.index * 2 + 1] ?? 0;
      for (let i = first; i < first + count; i++) addPoint(mesh.edgePositions, i);
    } else {
      const first = mesh.faceRanges[at.index * 2] ?? 0;
      const count = mesh.faceRanges[at.index * 2 + 1] ?? 0;
      for (let t = first; t < first + count; t++)
        for (let k = 0; k < 3; k++) addPoint(mesh.positions, mesh.indices[t * 3 + k] as number);
    }
    return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
  }

  /** Preselect a candidate while hovering it in the chooser. */
  previewCandidate(name: string | null): void {
    const c = this.ui.get().candidates;
    const at = c && name ? locateName(this.regen.get()?.result, name, c.kind) : null;
    this.patchUi({ hover: at ? { ...at, point: [0, 0, 0], distancePx: 0 } : null });
    this.pushHighlights();
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
        const view = this.regen.get();
        const r = view?.result;
        return r && view
          ? {
              revision: r.revision,
              source: view.source,
              quality: view.quality,
              bodies: r.bodies.map((b) => ({
                id: b.id,
                volume: b.massProperties?.volume ?? null,
                bbox: b.mesh.bbox,
              })),
              features: r.features.map((f) => ({
                id: f.featureId,
                state: f.state,
                ...(f.unresolved ? { unresolved: f.unresolved } : {}),
                ...(f.rebound ? { rebound: f.rebound } : {}),
                ...(f.error ? { error: f.error.message } : {}),
              })),
              sketches: r.sketches.map((s) => ({
                id: s.featureId,
                regions: s.regions.map((x) => x.name),
              })),
            }
          : null;
      },
      idle: async () => {
        await this.sketch?.whenSettled();
        await this.boot?.modeling;
        for (let i = 0; i < 50 && !this.loop; i++) await new Promise((r) => setTimeout(r, 20));
        await this.loop?.whenIdle();
        await this.viewport?.nextFrame();
      },
      flushSave: () => this.flushSave(),
      sketch: () => {
        const solve = this.ui.get().sketch?.solve;
        return solve ? { ...solve, busy: this.sketch?.busy ?? false } : null;
      },
      sketchSettled: () => this.sketch?.whenSettled() ?? Promise.resolve(),
      marks: () => marks(),
      ui: () => {
        const u = this.ui.get();
        return {
          featureId: u.featureId,
          picking: u.picking,
          candidates: u.candidates?.names ?? null,
          toast: u.toast?.text ?? null,
          sketch: u.sketch
            ? {
                tool: u.sketch.tool,
                dimPicks: u.sketch.dimPicks,
                editDimension: u.sketch.editDimension,
                frame: u.sketch.frame !== null,
                highlight: u.sketch.highlightConstraints,
                selected: u.sketch.selected,
              }
            : null,
        };
      },
      /** Replaces the document (fixtures for E2E scenarios), saved to the library. */
      load: (doc: WhittleDoc) => {
        if (this.loadDocument({ doc }, false)) this.autosaver.schedule(doc);
      },
      projectFiles: () => ({
        extra: [...this.extra.keys()].sort(),
        cache: [...this.cache.keys()].sort(),
        cacheKey: this.cacheKey,
        savedCacheKey: this.savedCacheKey,
      }),
      sentAttachments: () => [...(this.loop?.sentAttachments ?? [])],
      /** Ghost markers at the old location of unresolved references. */
      attentionMarkers: () => [...this.markers],
      pendingHeals: () => Object.fromEntries(this.heals),
      library: async () => {
        const lib = await this.library();
        return (await lib?.list())?.map((e) => ({ id: e.id, name: e.name })) ?? [];
      },
      /** Waits until the mesh cache of the current document has reached the library. */
      cacheSaved: async () => {
        for (let i = 0; i < 200; i++) {
          await this.loop?.whenIdle();
          await this.autosaver.flush();
          if (this.cacheKey && this.cacheKey === this.savedCacheKey) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      },
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
