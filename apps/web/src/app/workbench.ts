/**
 * The workbench: the app's controller between the document store (single source of truth), the
 * regen engine, the viewport and the React chrome. React renders state from here
 * (`useObservable`) and calls its intention-revealing methods; nothing in React talks to the
 * engine or the viewport directly.
 */

import type {
  CameraChange,
  CircularPatternFeature,
  Command,
  DeviceTier,
  EntityRef,
  EvalResult,
  Expr,
  Feature,
  HighlightItem,
  Id,
  JsonPatchOp,
  LinearPatternFeature,
  Material,
  MeshBuffers,
  MirrorFeature,
  NamedDimension,
  Part,
  PickHit,
  PickKind,
  ProjectFiles,
  RegenResult,
  SketchFeature,
  SyncStatus,
  TouchViewport,
  Vec3,
  ViewportGesture,
  WrenDoc,
} from '@wren-cad/contracts';
import {
  compileCommand,
  createDocumentStore,
  type DocumentStoreImpl,
  entityRefs,
  expressionEngine,
  newDoc,
  scopeOf,
  ulid,
} from '@wren-cad/document';
import type { ExportRequest, SheetSnap, SheetTabId, ToolId } from '@wren-cad/ui';
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
  consumedSketchRefs,
  contextFeatureTools,
  contextTools,
  defaultAxisFor,
  FEATURE_PICKS,
  type FeatureTool,
  isFeatureTool,
  isModelTool,
  isUnset,
  type ModelTool,
  newBox,
  newChamfer,
  newCut,
  newCylinder,
  newExtrude,
  newExtrudeCut,
  newFeatureFor,
  newFillet,
  newPlane,
  newRevolve,
  newRevolveCut,
  newSketch,
  TOOL_NEEDS,
} from '../features/factories';
import { pruneAttachments, savedExtra } from '../model/attachments';
import { attentionItems, attentionMarkers, locateName, partDiagonal } from '../model/attention';
import { bootEngine, type EngineBoot } from '../model/engine';
import { explainStatus } from '../model/explain';
import {
  type FaceInfo,
  faceInfo,
  type SectionSettings,
  sectionPlane,
  sectionRange,
  unionBounds,
} from '../model/faces';
import { isOriginPlane, ORIGIN_FRAMES, type PlaneFrame, toPlaneFrame } from '../model/frames';
import { foldHeals, type Heal, healsFrom } from '../model/heal';
import { IMPORT_EXTENSIONS, importFeature, importFormat } from '../model/import';
import { type Attachment, createRegenLoop, type Modeling, type RegenLoop } from '../model/modeling';
import { getDiagnostics } from '../platform/diagnostics';
import { policyFor, type TierPolicy } from '../platform/tier-policy';
import {
  type Accepts,
  acceptsFor,
  applyPick,
  hitKey,
  orderStackedRegions,
  pickVertices,
  refForHit,
  resolvePick,
  toHighlight,
  toleranceFor,
  vertexAt,
} from '../selection/pick';
import type { SyncController, SyncHost } from '../sync/controller';
import { type BubbleActionId, gestureAction } from './gestures';
import { MeasureTool } from './measure-tool';
import { type Observable, observable } from './observable';
import { PointerDowns, replayedPointerDowns } from './pointers';
import { PushPullTool } from './push-pull';
import type { SketchSession } from './sketch-session';
import {
  type EngineState,
  initialSection,
  initialUi,
  type RegenView,
  type SectionUi,
  type SelectionItem,
  type UiState,
} from './state';
import { failBoot, mark, markOnce, marks } from './timing';

const LAST_DOC_KEY = 'whittle:last-document';
const LINKS_KEY = 'whittle:links';
const HISTORY_DIR = '.wren-history/';

/** The page is an OAuth callback (`state` plus `code` or `error`). */
const isOAuthCallback = () => {
  const q = new URLSearchParams(globalThis.location?.search ?? '');
  if (!(q.has('state') && (q.has('code') || q.has('error')))) return false;
  // Only a sign-in this tab started (its PKCE record, packages/sync auth/oauth.ts): a stray or
  // bookmarked `?code=` is left alone and doesn't load the sync chunk.
  try {
    return sessionStorage.getItem('whittle:oauth-pending') !== null;
  } catch {
    return false;
  }
};

/** A library project linked to a connection (sync/store.ts); read without loading the sync chunk. */
function isLinked(id: string | undefined): boolean {
  if (!id) return false;
  try {
    const links = JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, unknown>;
    return !!links[id];
  } catch {
    return false;
  }
}
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

export function freshDocument(): WrenDoc {
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
  readonly libraryEntries = observable<import('@wren-cad/contracts').LibraryEntry[] | null>(null);

  viewport: TouchViewport | null = null;
  canvas: HTMLCanvasElement | null = null;
  modeling: Modeling | null = null;
  /** Device tier and what it means (PLAN §8.4): regen budget, mesh quality, kernel boot. */
  readonly tier: DeviceTier;
  readonly policy: TierPolicy;
  /** The camera moved / came to rest (`onCamera`): `rest` counts the stops. */
  readonly camera = observable({ moving: false, rest: 0 });
  /** Every camera change (one per frame while moving), for HTML labels that follow geometry. */
  readonly cameraTick = observable(0);
  /** Successful exports (the tutorial's last step). */
  readonly exports = observable(0);
  /** "Take the tour" requests (welcome card, ⌘K); the app runs the tutorial on a new part. */
  readonly tourRequests = observable(0);
  readonly pushPull: PushPullTool;
  readonly measure: MeasureTool;
  private loop: RegenLoop | null = null;
  private boot: EngineBoot | null = null;
  private libraryPromise: Promise<DocLibrary | null> | null = null;
  private autosaver: Autosaver;
  private shownBodies = new Set<string>();
  private shownSketches = new Set<string>();
  private ghosts = new Set<string>();
  private markers = new Set<string>();
  /** Faces looked at for bubbles, push/pull and sections, per mesh (meshes are immutable). */
  private faceCache = new WeakMap<MeshBuffers, Map<number, FaceInfo | null>>();
  /** Project files outside the document model (attachments, previews/, releases/). */
  private extra: ProjectFiles = new Map();
  /** `.wren/` cache of the open project (mesh cache, other regenerable files). */
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
  private healsFor: WrenDoc | null = null;
  /** Auto-fit once per opened document, then leave the camera to the user. */
  private fitPending = true;
  private initialBundle: Promise<ProjectBundle | null> | null = null;
  private lastGood = new Map<string, MeshBuffers>();
  private firstRendered = false;
  private lastThumbAt = 0;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanup: Array<() => void> = [];
  /** Presses by pointer id (a pen and a finger, or two fingers, can be down at once). */
  private readonly downs = new PointerDowns();
  sketch: SketchSession | null = null;
  private sketchModule: Promise<typeof import('./sketch-session')> | null = null;
  /** Top bar: sync status and branch of the open project (M2.5; `local` until linked). */
  readonly projectBar = observable<{ status: SyncStatus; branch: string | null }>({
    status: { state: 'local' },
    branch: null,
  });
  /** Connections, sync and versions (lazy chunk with `@wren-cad/sync` and isomorphic-git). */
  private syncCtl: SyncController | null = null;
  private syncLoad: Promise<SyncController> | null = null;
  /** Library writes run one at a time (saves and sync's compare-and-swap writes). */
  private libChain: Promise<unknown> = Promise.resolve();
  /** The document object last written to the library (sync may replace only that one). */
  private persistedDoc: WrenDoc | null = null;
  /** History files written in memory and not yet saved. */
  private extraDirty = false;
  /** A merged result from sync waits for the current sketch or drag to finish. */
  private syncDeferred = false;
  /** The store change being applied came from another device: don't autosave it back. */
  private applyingRemote = false;

  constructor() {
    this.tier = getDiagnostics().tier;
    this.policy = policyFor(this.tier);
    this.pushPull = new PushPullTool(this);
    this.measure = new MeasureTool(this);
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
    this.bootKernelIfEager();
    void this.resolveInitialDocument();
  }

  /**
   * Boots the kernel now unless the tier loads it lazily (phone: a viewer of cached meshes until
   * the first edit or measurement, or a document that has no cached meshes).
   */
  bootKernelIfEager(): void {
    if (this.policy.kernelBoot === 'eager') this.bootKernel();
  }

  /** The kernel is needed now (an edit, a measurement, a document with nothing cached). */
  ensureKernel(): void {
    this.bootKernel();
  }

  /** Whether the kernel worker has been started (phone: lazily). */
  get kernelStarted(): boolean {
    return this.boot !== null;
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
    if (bundle) this.persistedDoc = this.doc;
    this.projectOpened();
    this.loop?.request();
    this.kernelIfNothingCached();
    this.markViewerShown();
    void import('../doc/library').then(({ onLaunchFiles }) =>
      onLaunchFiles((files) => {
        const f = files[0];
        // Opened from the OS (double-click, "Open with"): a CAD file starts its own document
        // rather than landing in whatever was open last.
        if (f) void this.openBytes(f.name, f.bytes, 'new');
      }),
    );
  }

  /** A document with features but no cached meshes can only be shown by the kernel: boot it. */
  private kernelIfNothingCached(): void {
    if (this.boot || (this.part?.features.length ?? 0) === 0) return;
    const view = this.regen.get();
    if (view?.source === 'cache' && view.result.partId === this.part?.id) return;
    this.ensureKernel();
  }

  /**
   * Lazy tiers show the document without the kernel (cached meshes, or nothing to show): that
   * first frame is the "first body" for the boot timing marks.
   */
  private markViewerShown(): void {
    const v = this.viewport;
    if (this.boot || this.firstRendered || !v || !this.ui.get().ready) return;
    this.firstRendered = true;
    void v.nextFrame().then(() => mark('firstBodyMs'));
  }

  /**
   * Resolves once the kernel is up and the latest live regen is of the current document (booting
   * the kernel on lazy tiers). False when the kernel failed to start.
   */
  async whenLive(): Promise<boolean> {
    this.ensureKernel();
    const modeling = await this.boot?.modeling.catch(() => null);
    if (!modeling) return false;
    for (let i = 0; i < 400; i++) {
      await this.loop?.whenIdle();
      const r = this.regen.get();
      if (r?.source === 'live' && r.doc === this.viewDoc()) return true;
      if (!this.loop) return false;
      this.loop.request();
      await new Promise((res) => setTimeout(res, 25));
    }
    return false;
  }

  private onEngineReady(modeling: Modeling): void {
    this.modeling = modeling;
    this.engine.set((s) => ({ ...s, ready: true }));
    // The tier's regen cache budget (also sent before init by createKernelClient).
    const spare = this.policy.regenMaxSpareResults;
    if (spare !== undefined) void modeling.port.configureRegen?.({ maxSpareResults: spare });
    this.loop = createRegenLoop({
      port: modeling.port,
      // Phones settle at coarse meshes (viewer-first, memory); others refine on idle.
      fine: this.policy.meshQuality === 'fine',
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
  viewDoc(): WrenDoc {
    const doc = this.store.getDoc();
    const p = this.ui.get().picking;
    const part = doc.parts[0];
    if (!p || !part) return doc;
    const kinds = this.pickAccepts()?.kinds ?? [];
    if (!kinds.some((k) => k === 'edge' || k === 'face' || k === 'vertex')) return doc;
    const idx = part.features.findIndex((f) => f.id === p.featureId);
    if (idx < 0 || idx >= part.rollbackIndex) return doc;
    const memo = this.viewMemo;
    if (memo && memo.doc === doc && memo.index === idx) return memo.out;
    const out = { ...doc, parts: [{ ...part, rollbackIndex: idx }, ...doc.parts.slice(1)] };
    this.viewMemo = { doc, index: idx, out };
    return out;
  }

  private viewMemo: { doc: WrenDoc; index: number; out: WrenDoc } | null = null;
  private lastPickKey = '';
  /** Feature statuses of the last regen of the real (not rolled-back-for-picking) document. */
  readonly treeStatuses = observable<RegenResult['features'] | undefined>(undefined);

  private onUiChange(): void {
    if (this.syncDeferred && !this.midEdit()) {
      // The sketch or drag that held back a synced change is over: merge it in now.
      this.syncDeferred = false;
      void this.syncCtl?.syncNow();
    }
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
  readonly getDoc = (): WrenDoc => this.store.getDoc();

  get doc(): WrenDoc {
    return this.store.getDoc();
  }

  get part(): Part | null {
    return this.doc.parts[0] ?? null;
  }

  // ------------------------------------------------------------------ document changes

  /** `loaded`: the document was replaced (open/new), not edited: nothing to autosave yet. */
  private onDocChange(doc: WrenDoc, loaded: boolean): void {
    if (!this.ui.get().ready) return;
    this.loop?.request();
    if (!loaded && !this.applyingRemote) this.autosaver.schedule(doc);
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
    this.ensureKernel(); // phones boot the kernel on the first edit
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
    // Tracked, so `idle()` waits for the deferred undo/redo too.
    if (this.sketch?.busy) void this.track(this.sketch.whenSettled().then(run));
    else run();
  }

  redo(): void {
    const run = () => {
      if (!this.store.redo()) this.toast('Nothing to redo', 'info');
    };
    // Tracked, so `idle()` waits for the deferred undo/redo too.
    if (this.sketch?.busy) void this.track(this.sketch.whenSettled().then(run));
    else run();
  }

  // ------------------------------------------------------------------ regeneration → viewport

  private onRegen(raw: RegenView): void {
    // Errors the app can explain better (propagate: false naming its tangent edges, ADR-040).
    const features = raw.result.features.map((s) => explainStatus(raw.doc, s));
    const outcome = features.some((s, i) => s !== raw.result.features[i])
      ? { ...raw, result: { ...raw.result, features } }
      : raw;
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
    // The cache holds the tier's settled quality (phones: coarse; the fine pass never runs there).
    if (current && (outcome.quality === 'fine' || outcome.quality === this.policy.meshQuality))
      this.updateMeshCache(outcome);
    this.pushPull.onRegen();
    this.measure.onRegen();
    this.syncSection();
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
  private showCached(doc: WrenDoc): void {
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

  /** Keeps the latest fine meshes in the project's `.wren/` cache (saved with the document). */
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
    this.patchUi({ selection, hover: null });
  }

  attachViewport(viewport: TouchViewport, canvas: HTMLCanvasElement): void {
    markOnce('viewportReadyMs');
    this.viewport = viewport;
    this.canvas = canvas;
    const host = canvas.parentElement ?? canvas;
    this.cleanup.push(
      this.listen(host, 'pointermove', (e) => this.onPointerMove(e as PointerEvent)),
      this.listen(host, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true),
      // Pencil presses anywhere (tool buttons too) mark the Pencil as in use; never handled here.
      this.listen(
        host.ownerDocument,
        'pointerdown',
        (e) => {
          if ((e as PointerEvent).pointerType === 'pen') this.lastPenAt = performance.now();
        },
        true,
      ),
      this.listen(host, 'pointerup', (e) => this.onPointerUp(e as PointerEvent), true),
      this.listen(host, 'pointercancel', (e) => this.onPointerCancel(e as PointerEvent), true),
      this.listen(host, 'pointerleave', () => this.setHover(null)),
      this.listen(host, 'dblclick', (e) => this.sketch?.onDoubleClick(e as MouseEvent), true),
      this.listen(host, 'dragover', (e) => this.onDragOver(e as DragEvent)),
      this.listen(host, 'drop', (e) => void this.onDrop(e as DragEvent)),
      // The app decides what discrete gestures mean (PLAN §9.3); the viewport keeps navigation.
      viewport.onGesture((g) => this.onGesture(g)),
      viewport.onCamera((c) => this.onCamera(c)),
    );
    // Touch tiers: the Pencil draws or selects and never orbits; fingers keep navigating, and
    // touch taps right after a pen contact are palm rejected.
    if (this.tier !== 'desktop') viewport.setInputPolicy({ penDraws: true });
    this.syncViewport();
    this.syncSection();
    const view = this.regen.get();
    if (view) this.keepInView(view);
    if (view?.source === 'live' && !this.firstRendered) {
      this.firstRendered = true;
      void viewport.nextFrame().then(() => mark('firstBodyMs'));
    }
    this.markCachedFrame();
    this.markViewerShown();
  }

  private onCamera(c: CameraChange): void {
    this.cameraTick.set((n) => n + 1);
    const cur = this.camera.get();
    if (c.moving !== cur.moving)
      this.camera.set({ moving: c.moving, rest: c.moving ? cur.rest : cur.rest + 1 });
  }

  /** Projects a world point to stage px (canvas-relative), or null when off screen. */
  project(p: Vec3): { x: number; y: number } | null {
    const s = this.viewport?.worldToScreen(p);
    return s?.visible ? { x: s.x, y: s.y } : null;
  }

  /** Face geometry (centroid, normal, planar) of a body face in the current regen; cached. */
  face(bodyId: string, index: number): FaceInfo | null {
    const mesh = this.regen.get()?.result.bodies.find((b) => b.id === bodyId)?.mesh;
    if (!mesh) return null;
    let m = this.faceCache.get(mesh);
    if (!m) {
      m = new Map();
      this.faceCache.set(mesh, m);
    }
    if (!m.has(index)) m.set(index, faceInfo(mesh, index));
    return m.get(index) ?? null;
  }

  private onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = 'copy';
  }

  /** Files dropped on the viewport: a `.wrencad` opens, CAD/mesh files import into the part. */
  private async onDrop(e: DragEvent): Promise<void> {
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length === 0) return;
    e.preventDefault();
    const files = await Promise.all(
      list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const project = files.find((f) => /\.(wrencad|whittle)$/i.test(f.name));
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
    const visible = this.partVisible(result.partId);
    const next = new Set<string>();
    for (const b of result.bodies) {
      v.setBody(b.id, b.mesh, { ...(color ? { color } : {}), visible });
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
   * The old location of every unresolved reference (PLAN §7.3 rule 4): dashed warning markers at
   * the stored fingerprint, until the user re-picks it.
   */
  private syncAttentionMarkers(): void {
    const v = this.viewport;
    if (!v) return;
    const items = attentionItems(this.treeStatuses.get());
    const size = Math.max(partDiagonal(this.regen.get()?.result) * 0.05, 0.5);
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
    for (const id of this.markers) if (!next.has(id)) v.setMarkers(id, null);
    for (const [id, markers] of next) v.setMarkers(id, markers);
    this.markers = new Set(next.keys());
  }

  /** Which sketches are shown: unconsumed ones, or any when regions are being picked. */
  refreshSketchVisibility(): void {
    const v = this.viewport;
    const view = this.regen.get();
    if (!v || !view) return;
    const part = this.part;
    const u = this.ui.get();
    const pickKinds = this.pickAccepts()?.kinds ?? [];
    // Regions, sketch curves (sweep paths) and sketch points (hole centres) are picked on sketches.
    const wantRegions =
      (u.prompt !== null && TOOL_NEEDS[u.prompt.tool].kinds.includes('region')) ||
      pickKinds.some((k) => k === 'region' || k === 'sketchCurve' || k === 'sketchPoint');
    const editing = u.featureId ? part?.features.find((f) => f.id === u.featureId) : undefined;
    const next = new Set<string>();
    const uses = (f: Feature | undefined, id: Id) =>
      !!f && consumedSketchRefs(f).some((r) => r.name.startsWith(`S${id}:`));
    for (const s of view.result.sketches) {
      if (u.sketch?.featureId === s.featureId) {
        next.add(s.featureId);
        continue; // the sketch session owns the active overlay
      }
      const consumed = part?.features.some((f) => uses(f, s.featureId));
      const related = editing?.id === s.featureId || uses(editing, s.featureId);
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
    // Measure picks are highlighted like a selection.
    for (const p of u.measure?.picks ?? [])
      if ('bodyId' in p.target)
        selected.push({ bodyId: p.target.bodyId, kind: p.target.kind, index: p.target.index });
    // Refs of the feature being edited show as selected too.
    const editing = u.featureId ? this.part?.features.find((f) => f.id === u.featureId) : null;
    if (editing && view) selected.push(...this.highlightsForRefs(editing, view.result));
    v.setHighlights({ selected, preselected: u.hover ? [fix(toHighlight(u.hover))] : [] });
  }

  private highlightsForRefs(f: Feature, result: RegenResult): HighlightItem[] {
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

  // ------------------------------------------------------------------ pointer input

  /** Canvas-relative CSS px of a pointer event. */
  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  /** Kinds selectable right now (model mode). */
  private pickKinds(): PickKind[] {
    const u = this.ui.get();
    if (u.section.picking) return ['face'];
    if (u.measure?.active) return ['face', 'edge', 'vertex'];
    if (u.picking) return this.pickAccepts()?.kinds ?? [];
    if (u.prompt) return TOOL_NEEDS[u.prompt.tool].kinds;
    return ['face', 'edge', 'vertex', 'region'];
  }

  /** What the inspector field being picked accepts (null when nothing is being picked). */
  pickAccepts(): Accepts | null {
    const p = this.ui.get().picking;
    if (!p) return null;
    return acceptsFor(
      p.path,
      this.part?.features.find((f) => f.id === p.featureId),
    );
  }

  /** The prompt chip text while an inspector field is picked (the tool's own wording first). */
  pickPrompt(): string | null {
    const p = this.ui.get().picking;
    const f = p ? this.part?.features.find((x) => x.id === p.featureId) : undefined;
    if (!p || !f) return null;
    const tool = toolOfFeature(f);
    const root = p.path.replace(/\/\d+$/, '');
    const step = tool ? FEATURE_PICKS[tool].find((s) => s.path === root) : undefined;
    return step?.prompt ?? `Select ${this.pickAccepts()?.noun ?? 'geometry'}`;
  }

  private pick(e: PointerEvent | MouseEvent, kinds: PickKind[], all = true): PickHit[] {
    const { x, y } = this.local(e);
    return this.pickAt(x, y, 'pointerType' in e ? e.pointerType : 'mouse', kinds, all);
  }

  /** Viewport pick at canvas px with the pointer type's tolerance. */
  pickAt(x: number, y: number, pointerType: string, kinds: PickKind[], all = true): PickHit[] {
    const v = this.viewport;
    if (!v) return [];
    const hits = v.pick(x, y, { kinds, tolerancePx: toleranceFor(pointerType), all });
    // Sketch regions are all "0 px away": of stacked ones (a sketch on a face above another
    // sketch's region) the one nearest the camera is the one under the cursor.
    const cam = (
      v as { getCameraState?: () => { position: [number, number, number] } }
    ).getCameraState?.()?.position;
    if (!cam) return hits;
    return orderStackedRegions(hits, cam as [number, number, number], (h) => this.regionArea(h));
  }

  private regionAreas = new WeakMap<MeshBuffers, number>();

  /** Area (mm²) of a picked sketch region's mesh (cached per immutable mesh). */
  private regionArea(h: PickHit): number {
    const mesh = this.regen
      .get()
      ?.result.sketches.find((s) => s.featureId === h.bodyId)
      ?.regions.find((r) => r.name === h.entity)?.mesh;
    if (!mesh) return Number.POSITIVE_INFINITY;
    const cached = this.regionAreas.get(mesh);
    if (cached !== undefined) return cached;
    const p = mesh.positions;
    const ix = mesh.indices;
    const at = (v: number, c: number) => p[(ix[v] as number) * 3 + c] as number;
    let a = 0;
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const u = [0, 1, 2].map((c) => at(t + 1, c) - at(t, c)) as [number, number, number];
      const w = [0, 1, 2].map((c) => at(t + 2, c) - at(t, c)) as [number, number, number];
      a +=
        Math.hypot(
          u[1] * w[2] - u[2] * w[1],
          u[2] * w[0] - u[0] * w[2],
          u[0] * w[1] - u[1] * w[0],
        ) / 2;
    }
    this.regionAreas.set(mesh, a);
    return a;
  }

  /** Only presses on the canvas itself count (not the view cube or other host children). */
  private onCanvas(e: Event): boolean {
    return e.target === this.canvas;
  }

  /** Time of the last pen contact (sketch mode: fingers never draw while the Pencil is in use). */
  lastPenAt = Number.NEGATIVE_INFINITY;

  /** The Apple Pencil was used anywhere in the app in the last 10 minutes. */
  penRecentlyUsed(): boolean {
    return performance.now() - this.lastPenAt < 10 * 60_000;
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pushPull.onPointerMove(e)) return;
    if (!this.onCanvas(e)) return;
    if (this.ui.get().sketch) {
      this.sketch?.onPointerMove(e);
      return;
    }
    if (e.buttons !== 0) return; // orbiting
    // Mouse and Pencil hover (where supported) preselect.
    const { best } = resolvePick(this.pick(e, this.pickKinds()), {
      pointerType: 'pointerType' in e ? e.pointerType : 'mouse',
    });
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
    if (replayedPointerDowns.has(e)) return; // the sketch session handing a finger to the camera
    if (!this.onCanvas(e)) {
      this.downs.drop(e.pointerId);
      return;
    }
    if (e.pointerType === 'pen') this.lastPenAt = performance.now();
    this.downs.press(e);
    if (this.ui.get().sketch) {
      this.sketch?.onPointerDown(e);
      return;
    }
    // A press on the push/pull arrow drags it (the viewport keeps the camera still).
    if (this.pushPull.onPointerDown(e)) this.downs.drop(e.pointerId);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.downs.release(e.pointerId);
    if (e.pointerType === 'pen') this.lastPenAt = performance.now();
    if (this.pushPull.onPointerUp(e)) return;
    if (this.ui.get().sketch) {
      this.sketch?.onPointerUp(e, d);
      return;
    }
    if (!d || d.id !== e.pointerId || e.button !== 0) return;
    // One path per input: touch taps select through `onGesture` (with palm rejection and
    // double-tap handling); mouse and Pencil clicks come through here.
    if (d.type === 'touch') return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // it was an orbit drag
    this.onClick(e);
  }

  private onPointerCancel(e: PointerEvent): void {
    this.downs.drop(e.pointerId);
    this.pushPull.onPointerCancel(e);
    this.sketch?.onPointerCancel(e);
  }

  private onClick(e: PointerEvent): void {
    const { x, y } = this.local(e);
    this.tapAt(x, y, e.pointerType, e.shiftKey || e.metaKey || e.ctrlKey);
  }

  /** A tap or click at canvas px: the best hit, or the "Which one?" chooser for near-ties. */
  private tapAt(x: number, y: number, pointerType: string, additive: boolean): void {
    if (this.ui.get().bubble) this.patchUi({ bubble: null });
    const { best, ties } = resolvePick(this.pickAt(x, y, pointerType, this.pickKinds()), {
      pointerType,
    });
    if (ties.length > 1) {
      const r = this.canvas?.getBoundingClientRect();
      const at = { x: x + (r?.left ?? 0), y: y + (r?.top ?? 0) };
      this.patchUi({ chooser: { ...at, hits: ties, additive } });
      return;
    }
    void this.choose(best, additive);
  }

  /** Discrete viewport gestures (PLAN §9.3): see `gestureAction` for the mapping. */
  private onGesture(g: ViewportGesture): void {
    const u = this.ui.get();
    const draw = u.sketch?.draw;
    const probe = g.kind === 'doubleTap' || g.kind === 'longPress';
    const best = probe
      ? resolvePick(this.pickAt(g.x, g.y, g.pointerType, this.pickKinds()), {
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
        this.tapAt(g.x, g.y, g.pointerType, false);
        break;
      case 'zoomTo':
        if (best) this.zoomToHit(best);
        break;
      case 'fit':
        this.viewport?.fitAll(true);
        break;
      case 'menu':
        void this.track(this.openBubbleAt(g, best));
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case null:
        break;
    }
  }

  /** Double-tap on geometry: centre it and fill about half the view with it. */
  private zoomToHit(hit: PickHit): void {
    const v = this.viewport;
    if (!v) return;
    // `zoomTo`'s radius fills about half the view: half the face's radius makes it fill the view.
    const f = hit.kind === 'face' ? this.face(hit.bodyId, hit.index) : null;
    const diag = partDiagonal(this.regen.get()?.result);
    if (f) v.zoomTo(f.centroid, Math.max(f.radius / 2, diag * 0.02), true);
    else v.zoomTo(hit.point, Math.max(diag * 0.06, 0.5), true);
  }

  /** Long-press: the context bubble for what is under the finger, or view actions on empty space. */
  private async openBubbleAt(g: ViewportGesture, hit: PickHit | null): Promise<void> {
    if (!hit) {
      this.patchUi({ bubble: { at: null, screen: { x: g.x, y: g.y }, view: true } });
      return;
    }
    await this.applyChoice(hit, false);
    if (this.ui.get().selection.length)
      this.patchUi({ bubble: { at: hit.point, screen: null, view: false } });
  }

  /** A hit was chosen (click or "Which one?"). */
  /** Applies a pick (a click or the overlap chooser); tracked so `idle()` waits for it. */
  choose(hit: PickHit | null, additive = false): Promise<void> {
    return this.track(this.applyChoice(hit, additive));
  }

  /** Picks applied (tests: one tap = one pick, whichever input path delivered it). */
  private choices = 0;

  private async applyChoice(hit: PickHit | null, additive: boolean): Promise<void> {
    this.choices++;
    this.patchUi({ chooser: null });
    const u = this.ui.get();
    const part = this.part;
    if (!part) return;
    if (u.section.picking) {
      if (hit?.kind === 'face') this.sectionFromFace(hit);
      return;
    }
    if (u.measure?.active) {
      if (hit) await this.measure.pick(hit);
      return;
    }
    if (u.pushPull) {
      // Another flat face moves the arrow there; anything else ends push/pull.
      if (hit?.kind === 'face' && this.pushPull.start([hit], true)) return;
      this.pushPull.cancel();
    }
    if (u.picking) {
      if (!hit) return;
      const f = part.features.find((x) => x.id === u.picking?.featureId);
      if (!f) return;
      const accepts = acceptsFor(u.picking.path, f);
      if (accepts.features) {
        // Mirror / pattern sources: the feature that made the clicked geometry.
        const owner = this.ownerFeature(hit, f.id);
        if (owner) this.addSourceFeature(owner);
        else this.toast('Pick geometry a feature made, or the feature in the tree.', 'info');
        return;
      }
      const ref = await this.refFor(hit, accepts.as);
      if (!ref) return this.toast('That can’t be referenced yet — try again in a moment.', 'info');
      this.pickRef(ref);
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

  async refFor(hit: PickHit, as?: EntityRef['kind']): Promise<EntityRef | null> {
    const part = this.part;
    const modeling = this.modeling;
    if (!part) return null;
    return refForHit(hit, part.id, (p, q) => modeling?.refFor(p, q) ?? Promise.resolve(null), as);
  }

  /**
   * Puts a reference into the inspector field being picked: a viewport pick, or a reference chip
   * (origin plane or axis, a plane / axis / point feature). Filling a single field, or the one
   * pick a profile takes, moves on to the tool's next empty field; list fields stay open until
   * Enter, Done or another field.
   */
  pickRef(ref: EntityRef): void {
    const p = this.ui.get().picking;
    const part = this.part;
    const f = p ? part?.features.find((x) => x.id === p.featureId) : undefined;
    if (!p || !part || !f) return;
    const next = applyPick(f, p.path, ref);
    if (next !== f)
      this.apply({ kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next });
    this.commit();
    const root = p.path.replace(/\/\d+$/, '');
    const list = root === p.path && Array.isArray(pointerValue(f, p.path));
    const tool = toolOfFeature(next);
    const once = tool ? FEATURE_PICKS[tool].find((s) => s.path === root)?.once : false;
    if (!list || once) this.advancePicking(next, root);
  }

  /** Picking moves to the tool's next empty reference field after `from`, or ends. */
  advancePicking(f?: Feature, from?: string): void {
    const p = this.ui.get().picking;
    const feature = f ?? (p ? this.part?.features.find((x) => x.id === p.featureId) : undefined);
    const after = from ?? p?.path.replace(/\/\d+$/, '');
    if (!feature) return;
    const tool = toolOfFeature(feature);
    const steps = tool ? FEATURE_PICKS[tool] : [];
    const i = steps.findIndex((s) => s.path === after);
    const next = i >= 0 ? steps.slice(i + 1).find((s) => emptyField(feature, s.path)) : undefined;
    this.patchUi({ picking: next ? { featureId: feature.id, path: next.path } : null });
    this.loop?.request();
    this.refreshSketchVisibility();
    this.pushHighlights();
  }

  /** The feature whose output a model hit belongs to (latest named), before `before`. */
  private ownerFeature(hit: PickHit, before: Id): Id | null {
    const part = this.part;
    const mesh = this.regen.get()?.result.bodies.find((b) => b.id === hit.bodyId)?.mesh;
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

  /** Adds a feature to the mirror / pattern source being picked (no duplicates, earlier only). */
  addSourceFeature(id: Id): void {
    const p = this.ui.get().picking;
    const part = this.part;
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
      this.toast('Only features before this one can be copied.', 'info');
      return;
    }
    if (f.source.features.includes(id)) return;
    const next = {
      ...f,
      source: { kind: 'features' as const, features: [...f.source.features, id] },
    };
    this.apply(
      { kind: 'updateFeature', partId: part.id, featureId: f.id, feature: next as Feature },
      `Copy ${part.features[at]?.name ?? 'feature'}`,
    );
    this.commit();
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
    if (tool === 'section') {
      if (this.ui.get().section.open) this.closeSection();
      else this.openSection();
      return;
    }
    if (tool === 'measure') {
      if (this.ui.get().measure?.active) this.measure.stop();
      else await this.measure.start(this.ui.get().selection.map((s) => s.hit));
      return;
    }
    if (isFeatureTool(tool)) return this.startFeatureTool(tool);
    if (!isModelTool(tool)) return;
    const u = this.ui.get();
    if (u.welcome) this.patchUi({ welcome: false });
    if (u.measure?.active) this.measure.stop();
    const need = TOOL_NEEDS[tool];
    const picked = u.selection.filter((s) => need.kinds.includes(s.hit.kind));
    if (tool === 'pushPull' && picked.length > 0 && picked.length === u.selection.length) {
      // Select first: the arrow appears on the selected face(s).
      if (this.pushPull.start(picked.map((s) => s.hit))) {
        this.patchUi({ prompt: null, lastTool: tool, featureId: null, picking: null });
        return;
      }
    }
    if (picked.length === 0 || picked.length !== u.selection.length || tool === 'pushPull') {
      // Act first, select second.
      this.pushPull.cancel();
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
      case 'extrudeCut':
        feature = newExtrudeCut(part, refs);
        break;
      case 'revolve':
      case 'revolveCut': {
        const sk = part.features.find(
          (f): f is SketchFeature =>
            f.type === 'sketch' && (refs[0]?.name ?? '').startsWith(`S${f.id}:`),
        );
        feature =
          tool === 'revolve'
            ? newRevolve(part, refs, defaultAxisFor(sk), bodies)
            : newRevolveCut(part, refs, defaultAxisFor(sk));
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

  /**
   * An M3 tool: creates its feature with defaults at once (inspector open), then collects its
   * references field by field (`FEATURE_PICKS`). Select first, act second: a selection that fits
   * the first field fills it; a feature selected in the tree becomes a mirror / pattern source.
   */
  private async startFeatureTool(tool: FeatureTool): Promise<void> {
    const part = this.part;
    if (!part) return;
    const u = this.ui.get();
    if (u.welcome) this.patchUi({ welcome: false });
    if (u.measure?.active) this.measure.stop();
    this.pushPull.cancel();
    const copies = tool === 'mirror' || tool === 'linearPattern' || tool === 'circularPattern';
    const selected = u.featureId ? part.features.find((f) => f.id === u.featureId) : undefined;
    const sources = copies && selected && selected.type !== 'sketch' ? [selected.id] : [];
    let feature = newFeatureFor(tool, part, {
      bodyCount: this.regen.get()?.result.bodies.length ?? 0,
      sources,
    });
    const steps = FEATURE_PICKS[tool];
    const first = steps[0];
    if (first && u.selection.length > 0) {
      const accepts = acceptsFor(first.path, feature);
      if (!accepts.features && u.selection.every((s) => accepts.kinds.includes(s.hit.kind))) {
        for (const s of u.selection) {
          const ref = s.ref ?? (await this.refFor(s.hit, accepts.as));
          if (ref) feature = applyPick(feature, first.path, ref);
        }
      }
    }
    // The first field still empty (a pre-filled list field moves on to the next one).
    const filledFirst = first && !emptyField(feature, first.path);
    const next = steps.find((s, i) => (i > 0 || !filledFirst) && emptyField(feature, s.path));
    this.patchUi({ lastTool: tool });
    this.addFeature(feature, next?.path);
  }

  /** Bubble "Cut": the selected regions cut through everything (holes); more can be tapped. */
  cutSelection(): Promise<void> {
    return this.track(
      (async () => {
        const part = this.part;
        const regions = this.ui.get().selection.filter((s) => s.hit.kind === 'region');
        if (!part || regions.length === 0) return;
        const refs: EntityRef[] = [];
        for (const s of regions) {
          const ref = s.ref ?? (await this.refFor(s.hit));
          if (ref) refs.push(ref);
        }
        if (refs.length) this.addFeature(newCut(part, refs), '/profile');
      })(),
    );
  }

  /** A context bubble action (tablet / phone, select first, act second). */
  bubbleAction(id: BubbleActionId): void {
    const hits = this.ui.get().selection.map((s) => s.hit);
    this.patchUi({ bubble: null });
    switch (id) {
      case 'sketch':
        this.sketchTool();
        break;
      case 'cut':
        void this.cutSelection();
        break;
      case 'measure':
        void this.track(this.measure.start(hits));
        break;
      case 'section': {
        const face = hits.find((h) => h.kind === 'face');
        if (face) this.sectionFromFace(face);
        this.openSheet(this.tier === 'phone' ? 'section' : 'inspector');
        break;
      }
      case 'fit':
        this.viewport?.fitAll(true);
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      default:
        void this.track(this.runTool(id));
    }
  }

  // ------------------------------------------------------------------ sheet (tablet, phone)

  setSheet(patch: { snap?: SheetSnap; tab?: SheetTabId }): void {
    const u = this.ui.get();
    if (patch.snap === 'full' || (patch.snap === 'peek' && u.sheetSnap !== 'peek'))
      this.sheetOpenedForUser = false; // the user moved it: it is theirs now
    const tab = patch.tab ?? u.sheetTab;
    this.patchUi({ sheetSnap: patch.snap ?? u.sheetSnap, sheetTab: tab });
    // The phone's Measure tab is the measure tool: open = picking, closed = done.
    if (this.tier === 'phone' && patch.tab !== undefined && patch.tab !== u.sheetTab) {
      if (patch.tab === 'measure') {
        if (!u.measure?.active) void this.track(this.measure.start([]));
      } else if (u.sheetTab === 'measure') this.measure.stop();
    }
  }

  /** Shows a sheet section at least half open (touch tiers). */
  openSheet(tab: SheetTabId, auto = false): void {
    const snap = this.ui.get().sheetSnap;
    // Opened for the user (a new feature, a measurement): Done puts it back.
    if (auto && snap === 'peek') this.sheetOpenedForUser = true;
    this.setSheet({ tab, snap: snap === 'peek' ? 'half' : snap });
  }

  private sheetOpenedForUser = false;

  /** Collapses a sheet the app opened by itself (Done in the inspector, Measure off). */
  restoreSheet(): void {
    if (!this.sheetOpenedForUser) return;
    this.sheetOpenedForUser = false;
    if (this.ui.get().sheetSnap === 'half') this.setSheet({ snap: 'peek' });
  }

  // ------------------------------------------------------------------ section view

  /** The plane last sent to the viewport (a new view starts without one: nothing to send). */
  private lastSection = 'null';

  /** Section settings → the viewport plane (caps on); a new axis or face starts mid-part. */
  setSection(patch: Partial<SectionUi>): void {
    const cur = this.ui.get().section;
    const next: SectionUi = { ...cur, ...patch };
    const restart =
      (patch.axis !== undefined && patch.axis !== cur.axis) ||
      patch.face !== undefined ||
      (patch.enabled === true && !cur.enabled);
    if (restart && patch.offset === undefined) {
      const r = sectionRange(next, this.bounds());
      // A face plane starts halfway into the part (behind the face), an axis mid-part.
      next.offset = next.axis === 'face' ? (r.min + Math.min(r.max, 0)) / 2 : (r.min + r.max) / 2;
    }
    this.patchUi({ section: next });
    this.syncSection();
  }

  /** ⌘K "Section view": the section panel (inspector on desktop/tablet, sheet tab on phones). */
  openSection(): void {
    this.patchUi({ section: { ...this.ui.get().section, open: true }, featureId: null });
    if (this.tier !== 'desktop') this.openSheet(this.tier === 'phone' ? 'section' : 'inspector');
  }

  closeSection(): void {
    this.patchUi({ section: { ...this.ui.get().section, open: false, picking: false } });
  }

  /** The slider range for the current section axis (the part's extent). */
  sectionRange(): { min: number; max: number } {
    return sectionRange(this.sectionSettings(), this.bounds());
  }

  private sectionSettings(): SectionSettings {
    const s = this.ui.get().section;
    return { enabled: s.enabled, axis: s.axis, offset: s.offset, flipped: s.flipped, face: s.face };
  }

  private bounds() {
    return unionBounds((this.regen.get()?.result.bodies ?? []).map((b) => b.mesh.bbox));
  }

  private syncSection(): void {
    const v = this.viewport;
    if (!v) return;
    const plane = sectionPlane(this.sectionSettings());
    const key = JSON.stringify(plane);
    if (key === this.lastSection) return;
    this.lastSection = key;
    v.setSection(plane);
  }

  /** Section along a picked face's plane. */
  sectionFromFace(hit: PickHit): void {
    const f = hit.kind === 'face' ? this.face(hit.bodyId, hit.index) : null;
    if (!f) return;
    if (!f.planar) {
      this.toast('Pick a flat face for the section plane.', 'info');
      return;
    }
    const label = this.selectionLabel(hit) ?? 'Face';
    this.setSection({
      enabled: true,
      axis: 'face',
      face: { origin: f.centroid, normal: f.normal, label },
      picking: false,
    });
  }

  /** "Face of Extrude 1": the hit's kind and the feature its mesh name comes from. */
  selectionLabel(hit: PickHit): string | null {
    const mesh = this.regen.get()?.result.bodies.find((b) => b.id === hit.bodyId)?.mesh;
    const name =
      hit.kind === 'face'
        ? mesh?.faceNames[hit.index]
        : hit.kind === 'edge'
          ? mesh?.edgeNames[hit.index]
          : undefined;
    const noun = hit.kind[0]?.toUpperCase() + hit.kind.slice(1);
    const owner = name ? this.part?.features.findLast((f) => name.includes(f.id)) : undefined;
    return owner ? `${noun} of ${owner.name}` : noun;
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
    // Tablet: the new feature's values are in the sheet's inspector (PLAN §9.1).
    if (this.tier === 'tablet') this.openSheet('inspector', true);
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
    else if (u.bubble) this.patchUi({ bubble: null });
    else if (u.pushPull) this.pushPull.cancel();
    else if (u.section.picking) this.setSection({ picking: false });
    else if (u.measure?.active) this.measure.stop();
    else if (u.picking) this.patchUi({ picking: null });
    else if (u.prompt) this.patchUi({ prompt: null });
    else if (u.selection.length) this.clearSelection();
    else if (u.featureId) {
      this.patchUi({ featureId: null });
      this.restoreSheet();
    } else if (u.section.open) this.closeSection();
    else if (u.library) this.patchUi({ library: false });
    else if (u.project) this.openProjectPanel(null);
    else if (u.welcome) this.patchUi({ welcome: false });
    else return false;
    this.refreshSketchVisibility();
    this.pushHighlights();
    return true;
  }

  // ------------------------------------------------------------------ feature tree / inspector

  selectFeature(id: Id | null): void {
    // A tree click while a mirror / pattern picks its sources adds that feature.
    if (id && this.pickAccepts()?.features) {
      this.addSourceFeature(id);
      return;
    }
    this.patchUi({ featureId: id, picking: null, selection: [], prompt: null });
    if (id === null) this.restoreSheet();
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
    void this.track(this.runTool('sketch')); // tracked: `idle()` waits for it (bubble, rail, ⌘K)
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
        void this.exportWren();
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
    // Enter while a list field is being picked: done with it, on to the tool's next field.
    if (e.key === 'Enter' && this.ui.get().picking) {
      e.preventDefault();
      this.advancePicking();
      return;
    }
    // Shortcuts (PLAN 9.4, ADR-038); the shifted ones are the M3 tools' second keys.
    const tools: Record<string, ModelTool | FeatureTool> = e.shiftKey
      ? {
          e: 'extrudeCut',
          r: 'revolveCut',
          w: 'loft',
          t: 'draft',
          o: 'thread',
          n: 'circularPattern',
          g: 'axis',
          p: 'point',
        }
      : {
          s: 'sketch',
          e: 'extrude',
          r: 'revolve',
          f: 'fillet',
          c: 'chamfer',
          p: 'pushPull',
          w: 'sweep',
          t: 'shell',
          o: 'hole',
          i: 'mirror',
          n: 'linearPattern',
          g: 'plane',
        };
    const tool = tools[k];
    if (e.shiftKey && !tool) return;
    if (k === 'm') {
      e.preventDefault();
      void this.runTool('measure');
    } else if (tool) {
      e.preventDefault();
      if (tool === 'sketch') this.sketchTool();
      else void this.runTool(tool);
    } else if (k === ' ' && this.ui.get().lastTool) {
      e.preventDefault();
      const last = this.ui.get().lastTool as ModelTool | FeatureTool;
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
  private attachmentsFor(doc: WrenDoc): Attachment[] {
    const out: Attachment[] = [];
    for (const f of doc.parts[0]?.features ?? []) {
      if (f.type !== 'import') continue;
      const bytes = this.extra.get(f.source.path);
      if (bytes) out.push({ path: f.source.path, sha256: f.source.sha256, bytes });
    }
    return out;
  }

  private async saveToLibrary(doc: WrenDoc): Promise<void> {
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
    // Orphaned import attachments are never written; in memory they live on while the history
    // could bring their feature back (model/attachments.ts, ADR-016).
    if (current) this.pruneAttachments();
    const extra = savedExtra(files.extra, doc);
    const wasDirty = current && this.extraDirty;
    await this.libLocked(() =>
      lib.save(doc, {
        ...(thumbnail ? { thumbnail } : {}),
        extra,
        cache: files.cache,
      }),
    );
    if (doc.meta.id) this.syncCtl?.onSaved(doc.meta.id, doc, extra);
    if (current && doc.meta.id === this.doc.meta.id) {
      if (wasDirty) this.extraDirty = false;
      this.persistedDoc = doc;
      const first = !this.inLibrary;
      this.inLibrary = true;
      if (first) void this.syncCtl?.openProject(doc.meta.id);
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
    bundle: { doc: WrenDoc; extra?: ProjectFiles; cache?: ProjectFiles },
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
    this.kernelIfNothingCached();
    this.pushPull.cancel();
    this.measure.stop();
    this.setSection(initialSection);
    this.persistedDoc = inLibrary ? this.doc : null;
    this.extraDirty = false;
    this.syncDeferred = false;
    this.projectOpened();
    return true;
  }

  /** Starts the bracket tutorial on a fresh part (App owns the tutorial state). */
  requestTour(): void {
    this.tourRequests.set((n) => n + 1);
  }

  // ------------------------------------------------------------------ parts (phone sheet)

  private hiddenParts = new Set<Id>();

  partVisible(id: Id): boolean {
    return !this.hiddenParts.has(id);
  }

  setPartVisible(id: Id, visible: boolean): void {
    if (visible) this.hiddenParts.delete(id);
    else this.hiddenParts.add(id);
    this.syncViewport();
    this.ui.set((u) => ({ ...u })); // re-render the parts list
  }

  /** Frames a part (Parts tab tap). */
  focusPart(id: Id): void {
    const view = this.regen.get();
    if (!view || view.result.partId !== id) return;
    const b = this.bounds();
    if (!b) return;
    const c: Vec3 = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    this.viewport?.zoomTo(c, Math.max(r, 1), true);
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
   * Open… : a `.wrencad` project replaces the document; a CAD/mesh file is imported. `into`:
   * `current` adds the import to the open part (the inspector's Open…, ⌘O, drag and drop), `new`
   * starts a new document for it (library and welcome, where no part is being worked on).
   */
  async openFromDisk(into: 'current' | 'new' = 'current'): Promise<void> {
    const { openFile } = await import('../doc/library');
    // `.whittle`: files saved before the rename (ADR-032) still open.
    const f = await openFile(['.wrencad', '.whittle', ...IMPORT_EXTENSIONS]);
    if (f) await this.openBytes(f.name, f.bytes, into);
  }

  async openBytes(
    name: string,
    bytes: Uint8Array,
    into: 'current' | 'new' = 'current',
  ): Promise<void> {
    if (/\.(wrencad|whittle)$/i.test(name)) {
      try {
        const { fromWrenBytes } = await import('../doc/library');
        await this.openProject(fromWrenBytes(bytes));
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
        `Wren can open .wrencad projects and import STEP, IGES, BREP, STL, OBJ, 3MF and GLB files${names ? ` (not ${names})` : ''}.`,
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

  /** Drops orphaned attachments that no undo or redo can restore any more. */
  private pruneAttachments(): void {
    pruneAttachments(this.extra, this.doc, (paths) => this.store.historyMentions(paths));
  }

  async exportWren(): Promise<void> {
    const { toWrenBytes, saveFile, MIME } = await import('../doc/library');
    this.pruneAttachments();
    await saveFile(
      toWrenBytes(this.doc, savedExtra(this.extra, this.doc), this.cache),
      `${fileBase(this.doc.meta.name)}.wrencad`,
      MIME.wrencad,
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
      if (request.target === 'wren') return await this.exportWren();
      if (request.target === '3mf' || request.target === 'glb') {
        const bodies = (view?.result.bodies ?? []).filter(
          (b) => !request.options.bodies || request.options.bodies.includes(b.id),
        );
        if (bodies.length === 0) return this.toast('There is nothing to export yet.', 'info');
        const { meshExporters } = await import('@wren-cad/io');
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
        this.exports.set((n) => n + 1);
        return;
      }
      // Exact formats need the kernel (phones boot it now).
      const live = view?.source === 'live' || (await this.whenLive());
      const modeling = this.modeling;
      if (!modeling || !live) return this.toast('The geometry kernel is still loading.', 'info');
      const r = await modeling.exportPart(part.id, request.target, request.options);
      if (!r.ok) return this.toast(r.error.message, 'error');
      const ext = request.target === 'step' ? 'step' : request.target;
      await lib.saveFile(r.bytes, `${base}.${ext}`, lib.MIME[request.target]);
      this.exports.set((n) => n + 1);
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

  /** UI actions still in flight (they await the engine before editing the document). */
  private actions = new Set<Promise<unknown>>();

  /** Registers an in-flight UI action so `idle()` waits for it. */
  track<T>(p: Promise<T>): Promise<T> {
    this.actions.add(p);
    const done = () => this.actions.delete(p);
    p.then(done, done);
    return p;
  }

  /** A candidate from the "Which one?" list for an ambiguous reference. */
  chooseCandidate(name: string | null): Promise<void> {
    return this.track(this.applyCandidate(name));
  }

  private async applyCandidate(name: string | null): Promise<void> {
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

  // ------------------------------------------------------------------ connections, sync, versions (M2.5)

  /** Library writes, one at a time (autosave and sync's compare-and-swap never interleave). */
  private libLocked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.libChain.then(fn, fn);
    this.libChain = run.catch(() => undefined);
    return run;
  }

  /** A sketch session, a push/pull drag or a pointer press on the model is in progress. */
  midEdit(): boolean {
    const u = this.ui.get();
    return !!u.sketch || !!u.pushPull?.dragging || this.downs.size > 0;
  }

  /** The sync chunk, loaded on first use (Connections, Versions, a linked project, OAuth). */
  syncController(): Promise<SyncController> {
    this.syncLoad ??= import('../sync/controller').then(async (m) => {
      const ctl = m.createSyncController(this.syncHost());
      this.syncCtl = ctl;
      const place = isOAuthCallback() ? ctl.restorePlace() : null;
      if (place?.doc && place.doc !== this.doc.meta.id) await this.openFromLibrary(place.doc);
      await ctl.openProject(this.doc.meta.id);
      if (isOAuthCallback()) await ctl.completeSignIn();
      return ctl;
    });
    return this.syncLoad;
  }

  /** A document was opened or replaced: its sync engine and history follow it. */
  private projectOpened(): void {
    if (this.syncCtl) {
      void this.syncCtl.openProject(this.doc.meta.id);
      return;
    }
    this.projectBar.set({ status: { state: 'local' }, branch: null });
    const hasHistory = [...this.extra.keys()].some((k) => k.startsWith(HISTORY_DIR));
    if (isLinked(this.doc.meta.id) || hasHistory || isOAuthCallback()) void this.syncController();
  }

  /** Opens (or with `null` closes) the project panel: versions, connections. */
  openProjectPanel(tab: 'versions' | 'connections' | null): void {
    if (tab === null) this.syncCtl?.closeMode();
    this.patchUi({ project: tab, ...(tab ? { library: false } : {}) });
    if (tab) void this.flushSave().then(() => this.syncController());
  }

  /** Sync merged another device's edits into the library entry: show them as one undo step. */
  private adoptRemote(doc: WrenDoc, extra: ProjectFiles, ops: JsonPatchOp[]): void {
    this.extra = new Map(extra);
    if (ops.length) {
      this.applyingRemote = true;
      try {
        const r = this.store.apply(
          { kind: 'patch', ops },
          { label: 'Changes from another device' },
        );
        this.store.commit();
        if (!r.ok) this.store.load(doc); // never leave the screen behind the library
      } finally {
        this.applyingRemote = false;
      }
    }
    this.persistedDoc = this.doc;
    this.loop?.request();
  }

  /** Restore, branch switch, merge: the project's files as one undoable edit (then saved). */
  private applyProject(extra: ProjectFiles, label: string, ops: JsonPatchOp[]): boolean {
    this.extra = new Map(extra);
    this.extraDirty = true;
    if (ops.length === 0) {
      void this.saveToLibrary(this.doc);
      return true;
    }
    const ok = this.apply({ kind: 'patch', ops }, label);
    this.commit();
    return ok;
  }

  private syncHost(): SyncHost {
    return {
      currentId: () => this.doc.meta.id,
      doc: () => this.doc,
      extra: () => this.extra,
      lockLibrary: async (fn) => {
        const lib = await this.library();
        return lib ? this.libLocked(() => fn(lib)) : null;
      },
      canAdoptRemote: () => {
        if (this.midEdit()) {
          this.syncDeferred = true;
          return false;
        }
        if (
          this.autosaver.pending ||
          this.extraDirty ||
          this.store.getDoc() !== this.persistedDoc
        ) {
          // Save what is on screen first; the engine then merges against it.
          void this.autosaver.flush().then(() => {
            if (this.store.getDoc() !== this.persistedDoc || this.extraDirty)
              return this.saveToLibrary(this.doc);
          });
          return false;
        }
        return true;
      },
      adoptRemote: (doc, extra, ops) => this.adoptRemote(doc, extra, ops),
      applyFiles: (extra, label, ops) => this.applyProject(extra, label, ops),
      setExtraFiles: (changes) => {
        for (const [p, b] of changes) {
          if (b) this.extra.set(p, b);
          else this.extra.delete(p);
        }
        this.extraDirty = true;
      },
      persist: async () => {
        await this.autosaver.flush();
        await this.saveToLibrary(this.doc);
      },
      flush: () => this.flushSave(),
      openNewProject: async (doc, extra) => {
        const lib = await this.library();
        if (!lib) return false;
        await this.flushSave();
        await this.libLocked(() => lib.save(doc, { extra }));
        if (!this.loadDocument({ doc, extra }, true)) return false;
        this.patchUi({ library: false, welcome: false });
        return true;
      },
      modeling: async () => ((await this.whenLive()) ? this.modeling : null),
      viewport: () => this.viewport,
      attachments: (doc) =>
        Object.fromEntries(this.attachmentsFor(doc).map((a) => [a.path, a.bytes])),
      evaluate: (e) => this.evaluate(e),
      toast: (t, tone) => this.toast(t, tone),
      setBar: (bar) => this.projectBar.set(bar),
      openPanel: (tab) => this.patchUi({ project: tab, library: false }),
    };
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
  selectionTools(): Array<ModelTool | FeatureTool> {
    const kinds = this.ui.get().selection.map((s) => s.hit.kind);
    return [...new Set([...contextTools(kinds), ...contextFeatureTools(kinds)])];
  }

  /**
   * Reference geometry the field being picked can take but the view has no shape for: the origin
   * planes and axes, and plane / axis / point features before the feature being edited (PLAN
   * 9.2). Shown as chips beside the prompt; tapping one is the pick.
   */
  referenceChoices(): { label: string; ref: EntityRef }[] {
    const accepts = this.pickAccepts();
    const p = this.ui.get().picking;
    const part = this.part;
    if (!accepts?.refs || !p || !part) return [];
    const end = part.features.findIndex((f) => f.id === p.featureId);
    const earlier = part.features.slice(0, end < 0 ? undefined : end).filter((f) => !f.suppressed);
    const out: { label: string; ref: EntityRef }[] = [];
    if (accepts.refs.includes('plane')) {
      out.push(
        { label: 'Top (XY)', ref: { name: 'origin:XY', kind: 'face' } },
        { label: 'Front (XZ)', ref: { name: 'origin:XZ', kind: 'face' } },
        { label: 'Right (YZ)', ref: { name: 'origin:YZ', kind: 'face' } },
      );
      for (const f of earlier)
        if (f.type === 'plane')
          out.push({ label: f.name, ref: { name: `F${f.id}:plane`, kind: 'face' } });
    }
    if (accepts.refs.includes('axis')) {
      out.push(
        { label: 'X axis', ref: { name: 'origin:X', kind: 'edge' } },
        { label: 'Y axis', ref: { name: 'origin:Y', kind: 'edge' } },
        { label: 'Z axis', ref: { name: 'origin:Z', kind: 'edge' } },
      );
      for (const f of earlier)
        if (f.type === 'axis')
          out.push({ label: f.name, ref: { name: `F${f.id}:axis`, kind: 'edge' } });
    }
    if (accepts.refs.includes('point')) {
      for (const f of earlier)
        if (f.type === 'point')
          out.push({ label: f.name, ref: { name: `F${f.id}:point`, kind: 'vertex' } });
    }
    return out;
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
        // (Phones may not have started the kernel at all: then there is nothing to wait for.)
        for (let i = 0; i < 50 && this.boot && !this.loop; i++)
          await new Promise((r) => setTimeout(r, 20));
        // Settled = no UI action in flight, the regen loop idle, and the last live result is of
        // the document as displayed now (not of the version before the last edit).
        for (let i = 0; i < 200; i++) {
          while (this.actions.size > 0) await Promise.allSettled([...this.actions]);
          await this.sketch?.whenSettled();
          await this.loop?.whenIdle();
          const r = this.regen.get();
          if (!this.loop || (r?.source === 'live' && r.doc === this.viewDoc())) break;
          if (this.actions.size === 0 && !this.ui.get().ready) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        await this.viewport?.nextFrame();
      },
      flushSave: () => this.flushSave(),
      /**
       * What a mouse click at canvas px would pick in the current mode, as the click itself
       * resolves it (`pickAt` + `resolvePick`): the best hit and how many tie ("Which one?").
       */
      resolveAt: (x: number, y: number) => {
        const r = resolvePick(this.pickAt(x, y, 'mouse', this.pickKinds()), {
          pointerType: 'mouse',
        });
        return {
          best: r.best
            ? {
                bodyId: r.best.bodyId,
                kind: r.best.kind,
                index: r.best.index,
                ...(r.best.entity !== undefined ? { entity: r.best.entity } : {}),
                point: r.best.point,
                distancePx: r.best.distancePx,
              }
            : null,
          ties: r.ties.length,
        };
      },
      /** The persistent name of a viewport hit's face or edge (read only; E2E pick checks). */
      hitName: (bodyId: string, kind: string, index: number): string | null => {
        const mesh = this.regen.get()?.result.bodies.find((b) => b.id === bodyId)?.mesh;
        if (kind === 'face') return mesh?.faceNames[index] ?? null;
        if (kind === 'edge') return mesh?.edgeNames[index] ?? null;
        return null;
      },
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
                featureId: u.sketch.featureId,
                plane: u.sketch.frame,
                edit: u.sketch.edit
                  ? {
                      tool: u.sketch.edit.tool,
                      picks: u.sketch.edit.picks.length,
                      model: u.sketch.edit.model.length,
                      busy: u.sketch.edit.busy,
                    }
                  : null,
                tool: u.sketch.tool,
                dimPicks: u.sketch.dimPicks,
                editDimension: u.sketch.editDimension,
                frame: u.sketch.frame !== null,
                highlight: u.sketch.highlightConstraints,
                selected: u.sketch.selected,
                stroke: u.sketch.stroke
                  ? { shape: u.sketch.stroke.shape, points: u.sketch.stroke.points.length }
                  : null,
                lastStroke: u.sketch.lastStroke,
              }
            : null,
          selection: u.selection.map((x) => x.hit.kind),
          selectionKeys: u.selection.map((x) => x.key),
          hover: u.hover?.kind ?? null,
          choices: this.choices,
          prompt: u.prompt?.tool ?? null,
          pushPull: u.pushPull
            ? {
                faces: u.pushPull.faces.length,
                distance: u.pushPull.distance,
                expr: u.pushPull.expr,
                dragging: u.pushPull.dragging,
              }
            : null,
          measure: u.measure
            ? {
                active: u.measure.active,
                picks: u.measure.picks.map((p) => p.kind),
                results: u.measure.results,
                busy: u.measure.busy,
                error: u.measure.error,
              }
            : null,
          section: {
            enabled: u.section.enabled,
            axis: u.section.axis,
            offset: u.section.offset,
            flipped: u.section.flipped,
            picking: u.section.picking,
          },
          bubble: u.bubble !== null,
          chooser: u.chooser?.hits.map((h) => h.kind) ?? null,
          sheet: { snap: u.sheetSnap, tab: u.sheetTab },
          kernel: { started: this.boot !== null, ready: this.engine.get().ready },
          camera: this.camera.get(),
        };
      },
      /** The undo and redo stacks, oldest first (labels of the steps; read only). */
      history: () => this.store.history(),
      /** Applies a command as one undo step (E2E edits that aren't about the UI path). */
      apply: (command: Command, label?: string) => {
        const ok = this.apply(command, label);
        this.commit();
        return ok;
      },
      /** M2.5: the sync controller's state (loads the sync chunk). */
      sync: async () => {
        const c = await this.syncController();
        await c.idle();
        return c.testState();
      },
      /** M2.5: sync the open project now and wait for it to settle. */
      syncNow: async () => {
        const c = await this.syncController();
        await c.syncNow();
        await c.idle();
      },
      syncLoaded: () => this.syncCtl !== null,
      /** The sync controller itself (only usable inside page.evaluate). */
      syncController: () => this.syncController(),
      projectBar: () => this.projectBar.get(),
      /** Replaces the document (fixtures for E2E scenarios), saved to the library. */
      load: (doc: WrenDoc) => {
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
      libraryFiles: async (id: string) => {
        const lib = await this.library();
        const b = await lib?.open(id);
        return [...(b?.extra?.keys() ?? [])].sort();
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

/** The M3 tool that makes a feature (its pick sequence), if any. */
function toolOfFeature(f: Feature): FeatureTool | null {
  return isFeatureTool(f.type) ? f.type : null;
}

/** A reference field still to be picked: an empty list or an unset reference. */
function emptyField(f: Feature, path: string): boolean {
  const v = pointerValue(f, path);
  if (Array.isArray(v)) return v.length === 0;
  return v === undefined || isUnset(v as EntityRef);
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
