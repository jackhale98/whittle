/**
 * The workbench: the app's controller between the document store (single source of truth), the
 * regen engine, the viewport and the React chrome. React renders state from here
 * (`useObservable`) and calls its intention-revealing methods; nothing in React talks to the
 * engine or the viewport directly.
 */

import type {
  CameraChange,
  Command,
  DeviceTier,
  EntityRef,
  EvalResult,
  Expr,
  Feature,
  HighlightItem,
  Id,
  JsonPatchOp,
  Material,
  MeshBuffers,
  NamedDimension,
  Part,
  PickHit,
  PickKind,
  ProjectFiles,
  RegenResult,
  SketchFeature,
  SketchVisibility,
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
  scopeOf,
} from '@wren-cad/document';
import {
  type ExportRequest,
  eventBindingId,
  type KeymapOverrides,
  type SheetSnap,
  type SheetTabId,
  type ToolId,
} from '@wren-cad/ui';
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
  contextFeatureTools,
  contextTools,
  type FeatureTool,
  type ModelTool,
  newSketch,
  TOOL_NEEDS,
} from '../features/factories';
import { attentionItems, attentionMarkers, locateName, partDiagonal } from '../model/attention';
import { bootEngine, type EngineBoot } from '../model/engine';
import { explainStatus, followBlockedCauses } from '../model/explain';
import { type FaceInfo, faceInfo, type SectionSettings } from '../model/faces';
import { isOriginPlane, ORIGIN_FRAMES, type PlaneFrame, toPlaneFrame } from '../model/frames';
import { foldHeals, type Heal, healsFrom } from '../model/heal';
import { type Attachment, createRegenLoop, type Modeling, type RegenLoop } from '../model/modeling';
import { sketchShown, type VisibilityContext } from '../model/sketch-visibility';
import { getDiagnostics } from '../platform/diagnostics';
import { policyFor, type TierPolicy } from '../platform/tier-policy';
import {
  type Accepts,
  applyPick,
  hitKey,
  pickVertices,
  toHighlight,
  vertexAt,
} from '../selection/pick';
import type { SyncController, SyncHost } from '../sync/controller';
import * as fileOps from './files';
import type { BubbleActionId } from './gestures';
import { commandFor, type InputSettings, loadInput } from './input';
import * as keys from './keyboard';
import { MeasureTool } from './measure-tool';
import { type Observable, observable } from './observable';
import * as pointer from './pointer';
import { PointerDowns } from './pointers';
import * as sync from './project-sync';
import { PushPullTool } from './push-pull';
import type { SketchSession } from './sketch-session';
import {
  type EngineState,
  initialUi,
  type RegenView,
  type SectionUi,
  type SelectionItem,
  type UiState,
} from './state';
import * as hooks from './test-hooks';
import { failBoot, mark, markOnce } from './timing';
import * as tools from './tools';
import * as tree from './tree-actions';
import * as view from './view-actions';
import { freshDocument, readLastDoc, writeLastDoc } from './workbench-util';

export { freshDocument };

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
  loop: RegenLoop | null = null;
  boot: EngineBoot | null = null;
  private libraryPromise: Promise<DocLibrary | null> | null = null;
  autosaver: Autosaver;
  shownBodies = new Set<string>();
  shownSketches = new Set<string>();
  private ghosts = new Set<string>();
  markers = new Set<string>();
  /** Faces looked at for bubbles, push/pull and sections, per mesh (meshes are immutable). */
  private faceCache = new WeakMap<MeshBuffers, Map<number, FaceInfo | null>>();
  /** Project files outside the document model (attachments, previews/, releases/). */
  extra: ProjectFiles = new Map();
  /** `.wren/` cache of the open project (mesh cache, other regenerable files). */
  cache: ProjectFiles = new Map();
  /** Document key of the meshes in `cache` and of the last cache that reached the library. */
  cacheKey: string | null = null;
  savedCacheKey: string | null = null;
  cacheTimer: ReturnType<typeof setTimeout> | undefined;
  /** The open document has a library entry (saved or opened from it). */
  inLibrary = false;
  /** Rebound reference names waiting to be folded into the next user edit (ADR-008). */
  heals = new Map<Id, Heal[]>();
  /** The document the pending heals were computed for: only that exact version may take them. */
  private healsFor: WrenDoc | null = null;
  /** Auto-fit once per opened document, then leave the camera to the user. */
  fitPending = true;
  private initialBundle: Promise<ProjectBundle | null> | null = null;
  private lastGood = new Map<string, MeshBuffers>();
  private firstRendered = false;
  lastThumbAt = 0;
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanup: Array<() => void> = [];
  /** Presses by pointer id (a pen and a finger, or two fingers, can be down at once). */
  readonly downs = new PointerDowns();
  sketch: SketchSession | null = null;
  private sketchModule: Promise<typeof import('./sketch-session')> | null = null;
  /** Top bar: sync status and branch of the open project (M2.5; `local` until linked). */
  readonly projectBar = observable<{ status: SyncStatus; branch: string | null }>({
    status: { state: 'local' },
    branch: null,
  });
  /** Connections, sync and versions (lazy chunk with `@wren-cad/sync` and isomorphic-git). */
  syncCtl: SyncController | null = null;
  syncLoad: Promise<SyncController> | null = null;
  /** Library writes run one at a time (saves and sync's compare-and-swap writes). */
  libChain: Promise<unknown> = Promise.resolve();
  /** The document object last written to the library (sync may replace only that one). */
  persistedDoc: WrenDoc | null = null;
  /** History files written in memory and not yet saved. */
  extraDirty = false;
  /** A merged result from sync waits for the current sketch or drag to finish. */
  syncDeferred = false;
  /** The store change being applied came from another device: don't autosave it back. */
  applyingRemote = false;

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
  kernelIfNothingCached(): void {
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
    const pv = this.preview.get();
    if (pv !== null && part) {
      // Phone step-through (M3.6): a copy of the document at another rollback position. The
      // document itself is untouched; the copy is memoised so the regen loop sees a stable value.
      const idx = Math.max(0, Math.min(part.features.length, pv));
      if (idx === part.rollbackIndex) return doc;
      const memo = this.previewMemo;
      if (memo && memo.doc === doc && memo.index === idx) return memo.out;
      const out = { ...doc, parts: [{ ...part, rollbackIndex: idx }, ...doc.parts.slice(1)] };
      this.previewMemo = { doc, index: idx, out };
      return out;
    }
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
  private previewMemo: { doc: WrenDoc; index: number; out: WrenDoc } | null = null;
  /**
   * The phone's step-through preview (M3.6): the rollback position being shown, or null. View
   * state only: it never writes the document (no undo entry, autosave, sync or dirty flag).
   */
  readonly preview = observable<number | null>(null);

  /** Shows the model after the first `index` features without changing the document. */
  previewRollback(index: number): void {
    const part = this.part;
    if (!part) return;
    const idx = Math.max(0, Math.min(part.features.length, Math.round(index)));
    if (this.preview.get() === idx) return;
    this.ensureKernel(); // a phone viewer boots the kernel on the first step
    this.previewSteps.push({ index: idx, t0: performance.now() });
    this.preview.set(idx);
    this.refreshSketchVisibility();
    this.loop?.request();
  }

  /** Back to the full model (the document was never changed). */
  endPreview(): void {
    if (this.preview.get() === null) return;
    this.preview.set(null);
    this.previewMemo = null;
    this.refreshSketchVisibility();
    this.loop?.request();
  }

  /** "Keep this rollback": the one write a preview makes. */
  keepPreview(): void {
    const part = this.part;
    const idx = this.preview.get();
    if (!part || idx === null) return;
    this.preview.set(null);
    this.previewMemo = null;
    if (idx !== part.rollbackIndex) {
      this.apply({ kind: 'setRollback', partId: part.id, index: idx }, undefined, 'rollback');
      this.commit();
    } else {
      this.loop?.request();
    }
  }

  private recordPreviewStep(outcome: RegenView): void {
    if (this.preview.get() === null || outcome.doc !== this.viewDoc()) return;
    const idx = outcome.doc.parts[0]?.rollbackIndex;
    const at = this.previewSteps.findIndex((x) => x.index === idx);
    if (at < 0) return;
    const [step] = this.previewSteps.splice(at, 1);
    if (!step) return;
    const cached = outcome.result.features.every(
      (f) => f.cached || f.state === 'rolledBack' || f.state === 'suppressed',
    );
    void (this.viewport?.nextFrame() ?? Promise.resolve()).then(() => {
      this.previewTimings.push({
        index: step.index,
        ms: Math.round(performance.now() - step.t0),
        cached,
      });
    });
  }

  /** Step timings for the budget check: when a step was asked for, and when its result showed. */
  private previewSteps: { index: number; t0: number }[] = [];
  previewTimings: { index: number; ms: number; cached: boolean }[] = [];
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
    // Which sketches show depends on what is being edited or picked: re-evaluate whenever that
    // changes, on every path (Done, clear selection, Esc, tree clicks), not only on some of them.
    const u = this.ui.get();
    const visKey = `${u.featureId ?? ''}|${key}|${u.prompt?.tool ?? ''}|${u.sketch?.featureId ?? ''}`;
    if (visKey !== this.lastVisKey) {
      this.lastVisKey = visKey;
      this.refreshSketchVisibility();
    }
  }
  private lastVisKey = '';

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

  /** Names of features seen in this session, so "<name> was deleted" can still name a deleted cause. */
  private readonly names = new Map<Id, string>();
  rememberedName(id: Id): string | undefined {
    return this.names.get(id);
  }

  /** `loaded`: the document was replaced (open/new), not edited: nothing to autosave yet. */
  private onDocChange(doc: WrenDoc, loaded: boolean): void {
    this.syncCollapsed();
    // An edit that arrives during a step-through (sync, undo, a load) ends the preview: what it
    // showed is no longer a view of this document.
    if (this.preview.get() !== null) {
      this.preview.set(null);
      this.previewMemo = null;
    }
    if (!this.ui.get().ready) return;
    this.loop?.request();
    if (!loaded && !this.applyingRemote) this.autosaver.schedule(doc);
    if (!loaded && this.ui.get().welcome) this.patchUi({ welcome: false });
    const part = this.part;
    const ids = new Set(part?.features.map((f) => f.id));
    for (const f of part?.features ?? []) this.names.set(f.id, f.name);
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
    const features = followBlockedCauses(raw.result.features.map((s) => explainStatus(raw.doc, s)));
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
    this.recordPreviewStep(outcome);
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
  fitOnFirstGeometry = false;

  /** Shows the document's cached meshes until the live regen replaces them (PLAN §4). */
  showCached(doc: WrenDoc): void {
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
  scheduleCacheSave(): void {
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
      this.listen(host, 'pointerleave', () => {
        this.forgetPick();
        this.setHover(null);
      }),
      this.listen(host, 'dblclick', (e) => this.sketch?.onDoubleClick(e as MouseEvent), true),
      this.listen(host, 'dragover', (e) => this.onDragOver(e as DragEvent)),
      this.listen(host, 'drop', (e) => void this.onDrop(e as DragEvent)),
      // The app decides what discrete gestures mean (PLAN §9.3); the viewport keeps navigation.
      viewport.onGesture((g) => this.onGesture(g)),
      viewport.onCamera((c) => this.onCamera(c)),
    );
    viewport.setNavigation(this.input.get().navigation);
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

  bodyColor(): string | undefined {
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

  /** The ids of the sketches the viewport shows (what the tree's eye draws). */
  readonly shownSketchIds = observable<ReadonlySet<Id>>(new Set());

  /**
   * Which sketches are shown (`sketchShown`, ADR-060 / ADR-066): the document's per-sketch
   * visibility, the consumed-sketch default, and picking / editing. The tree's eye reads the same
   * set (`shownSketchIds`), so it matches the viewport exactly.
   */
  refreshSketchVisibility(): void {
    const part = this.part;
    const u = this.ui.get();
    const pickKinds = this.pickAccepts()?.kinds ?? [];
    // Regions, sketch curves (sweep paths) and sketch points (hole centres) are picked on sketches.
    const wantRegions =
      (u.prompt !== null && TOOL_NEEDS[u.prompt.tool].kinds.includes('region')) ||
      pickKinds.some((k) => k === 'region' || k === 'sketchCurve' || k === 'sketchPoint');
    const features = part?.features ?? [];
    const ctx: VisibilityContext = {
      features,
      rollback: this.preview.get() ?? part?.rollbackIndex ?? features.length,
      activeSketch: u.sketch?.featureId,
      editing: u.featureId ? features.find((f) => f.id === u.featureId) : undefined,
      wantRegions,
    };
    const ids = new Set<Id>();
    for (const f of features) if (f.type === 'sketch' && sketchShown(f, ctx)) ids.add(f.id);
    const prev = this.shownSketchIds.get();
    if (prev.size !== ids.size || [...ids].some((id) => !prev.has(id)))
      this.shownSketchIds.set(ids);

    const v = this.viewport;
    const view = this.regen.get();
    if (!v || !view) return;
    const next = new Set<string>();
    for (const s of view.result.sketches) {
      if (u.sketch?.featureId === s.featureId) {
        next.add(s.featureId);
        continue; // the sketch session owns the active overlay
      }
      if (!ids.has(s.featureId)) continue;
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
    return pointer.local(this, e);
  }

  /** Kinds selectable right now (model mode). */
  pickKinds(): PickKind[] {
    return pointer.pickKinds(this);
  }

  /** What the inspector field being picked accepts (null when nothing is being picked). */
  pickAccepts(): Accepts | null {
    return pointer.pickAccepts(this);
  }

  /** The prompt chip text while an inspector field is picked (the tool's own wording first). */
  pickPrompt(): string | null {
    return pointer.pickPrompt(this);
  }

  pick(e: PointerEvent | MouseEvent, kinds: PickKind[], all = true): PickHit[] {
    return pointer.pick(this, e, kinds, all);
  }

  /** Viewport pick at canvas px with the pointer type's tolerance. */
  pickAt(x: number, y: number, pointerType: string, kinds: PickKind[], all = true): PickHit[] {
    return pointer.pickAt(this, x, y, pointerType, kinds, all);
  }

  regionAreas = new WeakMap<MeshBuffers, number>();

  /** Area (mm²) of a picked sketch region's mesh (cached per immutable mesh). */
  regionArea(h: PickHit): number {
    return pointer.regionArea(this, h);
  }

  /** Only presses on the canvas itself count (not the view cube or other host children). */
  onCanvas(e: Event): boolean {
    return pointer.onCanvas(this, e);
  }

  /** Time of the last pen contact (sketch mode: fingers never draw while the Pencil is in use). */
  lastPenAt = Number.NEGATIVE_INFINITY;

  /** The Apple Pencil was used anywhere in the app in the last 10 minutes. */
  penRecentlyUsed(): boolean {
    return pointer.penRecentlyUsed(this);
  }

  private onPointerMove(e: PointerEvent): void {
    pointer.onPointerMove(this, e);
  }

  // ------------------------------------------------------------------ box selection

  /** A left press in model mode that may turn into a box selection (mouse and Pencil only). */
  boxDown: { id: number; x: number; y: number; on: boolean } | null = null;
  penHold: {
    id: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  boxAllowed(): boolean {
    return pointer.boxAllowed(this);
  }

  /** Left-drag in model mode: the rubber band. Returns true while a box is being dragged. */
  boxMove(e: PointerEvent): boolean {
    return pointer.boxMove(this, e);
  }

  /** Release of a box drag: pick the rectangle and fold it into the selection. */
  boxEnd(e: PointerEvent): boolean {
    return pointer.boxEnd(this, e);
  }

  /**
   * A box selection: left to right selects what lies entirely inside (window), right to left what
   * the box touches (crossing). Shift adds, Ctrl / Cmd toggles, a plain drag replaces.
   */
  applyBox(
    box: NonNullable<UiState['box']>,
    mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): Promise<void> {
    return pointer.applyBox(this, box, mods);
  }

  /** The Pencil whose long press opened the radial menu: its lift must not also be a click. */
  penOpened: number | null = null;

  endPenHold(): void {
    pointer.endPenHold(this);
  }

  /** A Pencil press held still opens the radial menu (touch uses the viewport's long-press). */
  startPenHold(e: PointerEvent): void {
    pointer.startPenHold(this, e);
  }

  setHover(hit: PickHit | null): void {
    pointer.setHover(this, hit);
  }

  private onPointerDown(e: PointerEvent): void {
    pointer.onPointerDown(this, e);
  }

  private onPointerUp(e: PointerEvent): void {
    pointer.onPointerUp(this, e);
  }

  private onPointerCancel(e: PointerEvent): void {
    pointer.onPointerCancel(this, e);
  }

  onClick(e: PointerEvent): void {
    pointer.onClick(this, e);
  }

  /** A tap or click at canvas px: the best hit, or the "Which one?" chooser for near-ties. */
  tapAt(x: number, y: number, pointerType: string, additive: boolean): void {
    pointer.tapAt(this, x, y, pointerType, additive);
  }

  /** Discrete viewport gestures (PLAN §9.3): see `gestureAction` for the mapping. */
  private onGesture(g: ViewportGesture): void {
    pointer.onGesture(this, g);
  }

  /** Double-tap on geometry: centre it and fill about half the view with it. */
  zoomToHit(hit: PickHit): void {
    pointer.zoomToHit(this, hit);
  }

  /** Hover or Tab in the "Which one?" list preselects that candidate in the view. */
  previewChooser(index: number | null): void {
    pointer.previewChooser(this, index);
  }

  /** A hit was chosen (click or "Which one?"). */
  /** Applies a pick (a click or the overlap chooser); tracked so `idle()` waits for it. */
  choose(hit: PickHit | null, additive = false): Promise<void> {
    return pointer.choose(this, hit, additive);
  }

  /** Picks applied (tests: one tap = one pick, whichever input path delivered it). */
  choices = 0;

  applyChoice(hit: PickHit | null, additive: boolean): Promise<void> {
    return pointer.applyChoice(this, hit, additive);
  }

  refFor(hit: PickHit, as?: EntityRef['kind']): Promise<EntityRef | null> {
    return pointer.refFor(this, hit, as);
  }

  /**
   * Puts a reference into the inspector field being picked: a viewport pick, or a reference chip
   * (origin plane or axis, a plane / axis / point feature). Filling a single field, or the one
   * pick a profile takes, moves on to the tool's next empty field; list fields stay open until
   * Enter, Done or another field.
   */
  pickRef(ref: EntityRef): void {
    pointer.pickRef(this, ref);
  }

  /** Picking moves to the tool's next empty reference field after `from`, or ends. */
  advancePicking(f?: Feature, from?: string): void {
    pointer.advancePicking(this, f, from);
  }

  /** The feature whose output a model hit belongs to (latest named), before `before`. */
  ownerFeature(hit: PickHit, before: Id): Id | null {
    return pointer.ownerFeature(this, hit, before);
  }

  /** Adds a feature to the mirror / pattern source being picked (no duplicates, earlier only). */
  addSourceFeature(id: Id): void {
    pointer.addSourceFeature(this, id);
  }

  selectHit(hit: PickHit, additive: boolean): Promise<void> {
    return pointer.selectHit(this, hit, additive);
  }

  clearSelection(): void {
    pointer.clearSelection(this);
  }

  // ------------------------------------------------------------------ tools

  /** Command bar / shortcut / context action. */
  runTool(tool: ToolId): Promise<void> {
    return tools.runTool(this, tool);
  }

  /**
   * An M3 tool: creates its feature with defaults at once (inspector open), then collects its
   * references field by field (`FEATURE_PICKS`). Select first, act second: a selection that fits
   * the first field fills it; a feature selected in the tree becomes a mirror / pattern source.
   */
  startFeatureTool(tool: FeatureTool): Promise<void> {
    return tools.startFeatureTool(this, tool);
  }

  /** Bubble "Cut": the selected regions cut through everything (holes); more can be tapped. */
  cutSelection(): Promise<void> {
    return tools.cutSelection(this);
  }

  /** A context bubble action (tablet / phone, select first, act second). */
  bubbleAction(id: BubbleActionId): void {
    tools.bubbleAction(this, id);
  }

  // ------------------------------------------------------------------ sheet (tablet, phone)

  setSheet(patch: { snap?: SheetSnap; tab?: SheetTabId }): void {
    view.setSheet(this, patch);
  }

  /** Shows a sheet section at least half open (touch tiers). */
  openSheet(tab: SheetTabId, auto = false): void {
    view.openSheet(this, tab, auto);
  }

  sheetOpenedForUser = false;

  /** Collapses a sheet the app opened by itself (Done in the inspector, Measure off). */
  restoreSheet(): void {
    view.restoreSheet(this);
  }

  // ------------------------------------------------------------------ section view

  /** The plane last sent to the viewport (a new view starts without one: nothing to send). */
  lastSection = 'null';

  /** Section settings → the viewport plane (caps on); a new axis or face starts mid-part. */
  setSection(patch: Partial<SectionUi>): void {
    view.setSection(this, patch);
  }

  /** ⌘K "Section view": the section panel (inspector on desktop/tablet, sheet tab on phones). */
  openSection(): void {
    view.openSection(this);
  }

  closeSection(): void {
    view.closeSection(this);
  }

  /** The slider range for the current section axis (the part's extent). */
  sectionRange(): { min: number; max: number } {
    return view.sectionRange(this);
  }

  sectionSettings(): SectionSettings {
    return view.sectionSettings(this);
  }

  bounds() {
    return view.bounds(this);
  }

  syncSection(): void {
    view.syncSection(this);
  }

  /** Section along a picked face's plane. */
  sectionFromFace(hit: PickHit): void {
    view.sectionFromFace(this, hit);
  }

  /** "Face of Extrude 1": the hit's kind and the feature its mesh name comes from. */
  selectionLabel(hit: PickHit): string | null {
    return view.selectionLabel(this, hit);
  }

  /** Adds a feature and opens its inspector, keeping its main pick field live. */
  addFeature(feature: Feature, pickPath?: string): void {
    view.addFeature(this, feature, pickPath);
  }

  addPrimitive(shape: 'box' | 'cylinder'): void {
    view.addPrimitive(this, shape);
  }

  addPlane(): void {
    view.addPlane(this);
  }

  addBoolean(): void {
    view.addBoolean(this);
  }

  /** Esc: closes the innermost transient state. Returns whether anything was cancelled. */
  cancel(): boolean {
    return view.cancel(this);
  }

  // ------------------------------------------------------------------ feature tree / inspector

  selectFeature(id: Id | null): void {
    tree.selectFeature(this, id);
  }

  // ------------------------------------------------------------------ tree: folders, visibility

  /** The features picked in the tree (several: Ctrl/Shift-click). The radial menu reads it. */
  readonly treeSelection = observable<readonly Id[]>([]);
  setTreeSelection(ids: readonly Id[]): void {
    tree.setTreeSelection(this, ids);
  }

  /** Folders the user has collapsed: UI state, remembered per document (never in the document). */
  readonly collapsedFolders = observable<readonly Id[]>([]);
  collapsedFor = '';
  private syncCollapsed(): void {
    tree.syncCollapsed(this);
  }
  setCollapsedFolders(ids: readonly Id[]): void {
    tree.setCollapsedFolders(this, ids);
  }

  /**
   * "Add to new folder": `ids` (a contiguous run, nested sketches included) become a folder named
   * "Folder N". One undo entry. Returns false (and says why) when the run cannot be a folder.
   */
  addFolder(ids: readonly Id[]): boolean {
    return tree.addFolder(this, ids);
  }

  /** The tree's multi-selection plus the sketches nested under each pick, in history order. */
  folderRunOf(ids: readonly Id[]): Id[] {
    return tree.folderRunOf(this, ids);
  }

  renameFolder(folderId: Id, name: string): void {
    tree.renameFolder(this, folderId, name);
  }

  removeFolder(folderId: Id): void {
    tree.removeFolder(this, folderId);
  }

  /** Drags a folder's run. A refusal comes back as a reason (nothing changes). */
  moveFolder(folderId: Id, toIndex: number): { ok: true } | { ok: false; reason: string } {
    return tree.moveFolder(this, folderId, toIndex);
  }

  /** A folder's "Suppress all" / "Unsuppress all": one undo entry, one regeneration. */
  suppressMany(featureIds: readonly Id[], suppressed: boolean): void {
    tree.suppressMany(this, featureIds, suppressed);
  }

  /** The eye, a folder's Show / Hide sketches, Show all / Hide all, Reset: one undo entry. */
  setSketchVisibility(featureIds: readonly Id[], visibility: SketchVisibility): void {
    tree.setSketchVisibility(this, featureIds, visibility);
  }

  editFeature(id: Id): void {
    tree.editFeature(this, id);
  }

  updateFeature(feature: Feature, mode: 'commit' | 'preview'): void {
    tree.updateFeature(this, feature, mode);
  }

  startPicking(featureId: Id, path: string): void {
    tree.startPicking(this, featureId, path);
  }

  evaluate = (expr: Expr, expected?: NamedDimension): EvalResult => {
    const scope = scopeOf(this.doc);
    if (expected) return expressionEngine.evaluate(expr, expected, scope);
    const r = expressionEngine.evaluateAny(expr, scope);
    return r.ok ? { ok: true, value: r.value, dimension: r.dimension, dependsOn: r.dependsOn } : r;
  };

  setMaterial(material: Material | null): void {
    tree.setMaterial(this, material);
  }

  renameDocument(name: string): void {
    tree.renameDocument(this, name);
  }

  massSummary(): MassSummaryView | undefined {
    return tree.massSummary(this);
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

  /**
   * Shortcuts bind the physical key (`KeyboardEvent.code`) through the keymap (PLAN 9.4, ADR-049):
   * `matchCommand` with the contexts `['model','global']` or `['sketch','global']`, the user's
   * overrides from `wren.keymap`. The sketch toolbar matches its own tool keys with the same
   * keymap (`sketchShortcut`); here are the global, model and view commands.
   */
  private onKey(e: KeyboardEvent): void {
    keys.onKey(this, e);
  }

  /** The sketch toolbar's tool keys from the keymap: a tool id, `construction`, or null. */
  sketchShortcut = (e: KeyboardEvent): string | null => {
    const id = eventBindingId(e);
    const cmd = id ? commandFor(this.input.get(), id, true) : undefined;
    if (!cmd?.id.startsWith('sketch:')) return null;
    return cmd.id.slice('sketch:'.length);
  };

  // ------------------------------------------------------------------ input settings

  /** Navigation preset and keymap (persisted per device: `wren.navigation`, `wren.keymap`). */
  readonly input: Observable<InputSettings> = observable(loadInput());

  setNavigationSettings(navigation: InputSettings['navigation']): void {
    keys.setNavigationSettings(this, navigation);
  }

  setKeymapOverrides(overrides: KeymapOverrides): void {
    keys.setKeymapOverrides(this, overrides);
  }

  openSettings(tab: 'navigation' | 'keyboard' = 'navigation'): void {
    keys.openSettings(this, tab);
  }

  closeSettings(): void {
    keys.closeSettings(this);
  }

  /** Last pointer position over the page (client px): where a held key opens the radial menu. */
  lastPointer: { x: number; y: number } | null = null;

  canvasCentre(): { x: number; y: number } {
    return keys.canvasCentre(this);
  }

  // ------------------------------------------------------------------ repeat, radial, Tab cycling

  /** Space, a quick right click under `rightOrbitRepeat`, the radial's Repeat slot. */
  repeatLast(): void {
    keys.repeatLast(this);
  }

  /** The label of what Repeat would run now, for the radial menu's fixed slot. */
  lastCommandLabel(): string | null {
    return keys.lastCommandLabel(this);
  }

  /** A radial item was chosen (see `radial.ts` for the ids). */
  radialAction(id: string): void {
    keys.radialAction(this, id);
  }

  /**
   * Opens the radial menu at a gesture. In model mode the geometry under the cursor is selected
   * first (right-click on an unselected face selects it), so the menu's contents match what the
   * user pointed at; on empty space the current selection (or the general set) decides.
   */
  openRadial(
    g: { x: number; y: number; pointerType: 'mouse' | 'pen' | 'touch'; pointerId?: number },
    hit: PickHit | null,
    held: boolean,
  ): Promise<void> {
    return keys.openRadial(this, g, hit, held);
  }

  /** The candidates under the pointer at its last move, in the chooser's stable order. */
  lastPick: Array<{
    id: string;
    kind: 'face' | 'edge' | 'vertex' | 'body';
    depth?: number;
    hit: PickHit;
  }> = [];
  /** Tab's current preselection (a hit of `lastPick`), valid while the pointer stays put. */
  tabHit: PickHit | null = null;

  forgetPick(): void {
    keys.forgetPick(this);
  }

  rememberPick(hits: readonly PickHit[]): void {
    keys.rememberPick(this, hits);
  }

  /** Tab / Shift+Tab with a still pointer over overlapping geometry; false when it does not apply. */
  tabCycle(e: KeyboardEvent): boolean {
    return keys.tabCycle(this, e);
  }

  // ------------------------------------------------------------------ library & files

  /** The open project's extra files and cache (open/new/import replace them). */
  setProjectFiles(
    bundle: { extra?: ProjectFiles; cache?: ProjectFiles },
    inLibrary: boolean,
  ): void {
    fileOps.setProjectFiles(this, bundle, inLibrary);
  }

  /** Attachment bytes of the document's import features (ImportFeature.source.path). */
  attachmentsFor(doc: WrenDoc): Attachment[] {
    return fileOps.attachmentsFor(this, doc);
  }

  saveToLibrary(doc: WrenDoc): Promise<void> {
    return fileOps.saveToLibrary(this, doc);
  }

  /** Files of documents that were replaced while a save of them may still be pending. */
  retired = new Map<string, { extra: ProjectFiles; cache: ProjectFiles; key: string | null }>();

  /** Saves pending changes now (page hidden, switching documents, tests), with a thumbnail. */
  flushSave(): Promise<void> {
    return fileOps.flushSave(this);
  }

  thumbWanted = false;
  thumbDocs = new Set<string>();

  thumbnail(): Promise<Uint8Array | undefined> {
    return fileOps.thumbnail(this);
  }

  refreshLibrary(query = ''): Promise<void> {
    return fileOps.refreshLibrary(this, query);
  }

  toggleLibrary(open = !this.ui.get().library): void {
    fileOps.toggleLibrary(this, open);
  }

  /** Replaces the open document (history cleared). */
  loadDocument(
    bundle: { doc: WrenDoc; extra?: ProjectFiles; cache?: ProjectFiles },
    inLibrary: boolean,
  ): boolean {
    return fileOps.loadDocument(this, bundle, inLibrary);
  }

  /** Starts the bracket tutorial on a fresh part (App owns the tutorial state). */
  requestTour(): void {
    fileOps.requestTour(this);
  }

  // ------------------------------------------------------------------ parts (phone sheet)

  hiddenParts = new Set<Id>();

  partVisible(id: Id): boolean {
    return fileOps.partVisible(this, id);
  }

  setPartVisible(id: Id, visible: boolean): void {
    fileOps.setPartVisible(this, id, visible);
  }

  /** Frames a part (Parts tab tap). */
  focusPart(id: Id): void {
    fileOps.focusPart(this, id);
  }

  newDocument(): Promise<void> {
    return fileOps.newDocument(this);
  }

  /** Opens an editable copy of the demo bracket (saved to the library right away). */
  openDemo(): Promise<void> {
    return fileOps.openDemo(this);
  }

  openFromLibrary(id: string): Promise<void> {
    return fileOps.openFromLibrary(this, id);
  }

  renameInLibrary(id: string, name: string): Promise<void> {
    return fileOps.renameInLibrary(this, id, name);
  }

  deleteFromLibrary(id: string): Promise<void> {
    return fileOps.deleteFromLibrary(this, id);
  }

  /**
   * Open… : a `.wrencad` project replaces the document; a CAD/mesh file is imported. `into`:
   * `current` adds the import to the open part (the inspector's Open…, ⌘O, drag and drop), `new`
   * starts a new document for it (library and welcome, where no part is being worked on).
   */
  openFromDisk(into: 'current' | 'new' = 'current'): Promise<void> {
    return fileOps.openFromDisk(this, into);
  }

  openBytes(name: string, bytes: Uint8Array, into: 'current' | 'new' = 'current'): Promise<void> {
    return fileOps.openBytes(this, name, bytes, into);
  }

  /**
   * Opens a project from a file without ever overwriting a different library entry: the same
   * library id with different content (the entry was edited after this file was saved, or the
   * file comes from elsewhere) opens as a new entry — new id, " (copy)" when the name is taken —
   * and says so; only the identical project reuses its entry.
   */
  openProject(bundle: ProjectBundle): Promise<void> {
    return fileOps.openProject(this, bundle);
  }

  /** Imports CAD/mesh files as ImportFeatures (attachments `imports/<featureId>.<ext>`). */
  importFiles(files: readonly OpenedFile[], into: 'current' | 'new'): Promise<void> {
    return fileOps.importFiles(this, files, into);
  }

  /** Drops orphaned attachments that no undo or redo can restore any more. */
  pruneAttachments(): void {
    fileOps.pruneAttachments(this);
  }

  exportWren(): Promise<void> {
    return fileOps.exportWren(this);
  }

  export(request: ExportRequest): Promise<void> {
    return fileOps.exportDoc(this, request);
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
  actions = new Set<Promise<unknown>>();

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
  libLocked<T>(fn: () => Promise<T>): Promise<T> {
    return sync.libLocked(this, fn);
  }

  /** A sketch session, a push/pull drag or a pointer press on the model is in progress. */
  midEdit(): boolean {
    return sync.midEdit(this);
  }

  /** The sync chunk, loaded on first use (Connections, Versions, a linked project, OAuth). */
  syncController(): Promise<SyncController> {
    return sync.syncController(this);
  }

  /** A document was opened or replaced: its sync engine and history follow it. */
  projectOpened(): void {
    sync.projectOpened(this);
  }

  /** Opens (or with `null` closes) the project panel: versions, connections. */
  openProjectPanel(tab: 'versions' | 'connections' | null): void {
    sync.openProjectPanel(this, tab);
  }

  /** Sync merged another device's edits into the library entry: show them as one undo step. */
  adoptRemote(doc: WrenDoc, extra: ProjectFiles, ops: JsonPatchOp[]): void {
    sync.adoptRemote(this, doc, extra, ops);
  }

  /** Restore, branch switch, merge: the project's files as one undoable edit (then saved). */
  applyProject(extra: ProjectFiles, label: string, ops: JsonPatchOp[]): boolean {
    return sync.applyProject(this, extra, label, ops);
  }

  syncHost(): SyncHost {
    return sync.syncHost(this);
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
    return hooks.testHooks(this);
  }
}
