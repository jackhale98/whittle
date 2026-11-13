/**
 * The Wren viewport engine: imperative three.js on `WebGPURenderer` (automatic WebGL2
 * fallback), camera-controls for orbit/pan/zoom, render-on-demand, plus M1 picking (GPU ID buffer
 * + BVH + screen-space distance), selection highlights, sketch overlays, ghosts and a view cube.
 */

import type {
  BodyDisplay,
  CameraChange,
  CompareOverlay,
  CreateViewport,
  HandleSpec,
  HighlightItem,
  InputPolicy,
  Marker,
  MeshBuffers,
  MotionSample,
  NavigationOptions,
  PickHit,
  PickOptions,
  PreviewSpec,
  RectPickOptions,
  RenderBackend,
  ScreenRect,
  SectionPlane,
  SketchOverlay,
  StandardView,
  Vec2,
  Vec3,
  ViewportGesture,
  ViewportStats,
} from '@wren-cad/contracts';
import { DEFAULT_NAVIGATION } from '@wren-cad/contracts';
import CameraControls from 'camera-controls';
import {
  Box3,
  ClippingGroup,
  DirectionalLight,
  Group,
  HemisphereLight,
  Line2NodeMaterial,
  Matrix4,
  Plane,
  Quaternion,
  Raycaster,
  type RenderTarget,
  Scene,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
  WebGPURenderer,
} from 'three/webgpu';
import {
  clearHighlightObjects,
  getHandleScreenLength,
  removePreview,
  setHandle,
  setHighlights,
  setMarkers,
  setPreview,
} from './adornments';
import { probeWebGPU } from './backend';
import {
  applyPalette,
  disposeBody,
  removeBody,
  scheduleEnvironment,
  setBody,
  setDisplay,
  setGhost,
  setTheme,
  updateSceneBounds,
} from './bodies';
import {
  configureControls,
  createViewCube,
  fitAll,
  getRoll,
  keepInView,
  lookAtPlane,
  screenToPlane,
  setReducedMotion,
  setView,
  setViewDirection,
  worldToScreen,
  zoomTo,
} from './camera';
import type { CompareObjects } from './compare';
import { setCompare } from './compareView';
import { GestureRecognizer } from './gestures';
import { ContactShadow, Grid } from './ground';
import type { ArrowHandle } from './handles';
import { attachInput, onCamera, onGesture, setInputPolicy } from './input';
import {
  type BodyEntry,
  FOV_DEG,
  type GhostEntry,
  type MarkerEntry,
  type PreviewEntry,
  type SketchEntry,
  type WheelState,
} from './internal';
import { createMotionState, type MotionState, motionSample } from './motion/nav';
import { getNavigation, getNavigationState, setNavigation } from './navControl';
import { NavigationMachine, type NavSample, type PivotSource } from './navigation';
import { applyDepthBias, type Dot } from './overlays';
import { pick, whenPickReady } from './picking';
import type { PlaneFrame } from './plane';
import {
  getBodyMaterialState,
  getCameraState,
  getCompareStats,
  getPickStats,
  getRenderCount,
  getTouchStats,
  isCameraMoving,
  stats,
} from './probes';
import { pickRect } from './rectPick';
import { ReferenceLayer } from './references';
import {
  attachContextHandlers,
  nextFrame,
  requestRender,
  resize,
  scheduleWarmup,
} from './renderLoop';
import type { SectionEq } from './section';
import { setSection } from './sectionView';
import { setSketch } from './sketchOverlays';
import { OVERLAY_COLORS, type OverlayColors, PALETTES, type Palette } from './themes';
import type {
  BodyMaterialState,
  CameraState,
  CompareStats,
  FitOptions,
  NavigationState,
  PickStats,
  ReferenceStats,
  TouchStats,
  ViewportEngine,
  ViewportEngineOptions,
  ViewportEventMap,
  ViewportReference,
} from './types';
import { ViewCamera } from './viewCamera';
import type { ViewCube } from './viewcube';
import {
  type Bounds,
  boundsRadius,
  EMPTY_BOUNDS,
  type FrameInsets,
  NO_FRAME_INSETS,
} from './views';

CameraControls.install({
  THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

export type {
  BodyMaterialState,
  CameraState,
  CompareStats,
  FitOptions,
  NavigationState,
  PickStats,
  ReferenceFrame,
  ReferenceStats,
  TouchStats,
  ViewportEngine,
  ViewportEngineOptions,
  ViewportEventMap,
  ViewportReference,
} from './types';

export const createViewport = (async (canvas, options = {}) =>
  ViewportImpl.create(canvas, options)) satisfies CreateViewport as (
  canvas: HTMLCanvasElement,
  options?: ViewportEngineOptions,
) => Promise<ViewportEngine>;

export class ViewportImpl implements ViewportEngine {
  readonly canvas: HTMLCanvasElement;
  readonly backend: RenderBackend;

  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  /** Parent of all clippable scene content (bodies, highlights, ghosts); planes set by sections. */
  readonly bodyRoot = new ClippingGroup();
  /** Same for the ID-buffer scene so picking sees what is drawn. */
  readonly idRoot = new ClippingGroup();
  readonly sectionPlane = new Plane();
  section: { eq: SectionEq; caps: boolean } | null = null;
  capCounter = 0;
  readonly camera = new ViewCamera(FOV_DEG, 1, 0.1, 10000);
  readonly controls: CameraControls;
  readonly bodies = new Map<string, BodyEntry>();
  readonly edgeMaterial: Line2NodeMaterial;
  readonly grid = new Grid();
  readonly shadow = new ContactShadow();
  /** ADR-093: reference planes, axes and points. */
  readonly references = new ReferenceLayer(this);
  readonly keyLight = new DirectionalLight(0xffffff, 1);
  /** Built after the first body frame (see scheduleEnvironment); null until then. */
  envTarget: { dispose(): void; texture: Scene['environment'] } | null = null;
  envScheduled = false;
  /** Stand-in ambient light until the studio environment exists. */
  readonly fillLight = new HemisphereLight(0xffffff, 0x8a929e, 2.2);

  theme: 'light' | 'dark';
  palette: Palette;
  ui: OverlayColors;
  reducedMotion: boolean;
  maxPixelRatio: number;
  sceneBounds: Bounds = EMPTY_BOUNDS;
  sceneRadius = boundsRadius(EMPTY_BOUNDS);
  /** Canvas px covered by floating chrome: fits frame the model in the rest (`setFrameInsets`). */
  frameInsets: FrameInsets = NO_FRAME_INSETS;

  raf = 0;
  dirty = true;
  /** True between camera-controls `controlstart` and `controlend` (a pointer is down). */
  interacting = false;
  /** camera-controls dispatched 'wake' and not yet 'sleep'. */
  cameraAwake = false;
  disposed = false;
  lastFrameTime = 0;
  frameTimes: number[] = [];
  lastDrawCalls = 0;
  renderCount = 0;
  waiters: Array<() => void> = [];
  resizeObserver: ResizeObserver | null = null;
  cleanup: Array<() => void> = [];
  readonly listeners = new Map<string, Set<(e: never) => void>>();

  // ---- picking state
  pickingEnabled = false;
  /** Bumped when the camera, canvas size or visible geometry changes (invalidates the ID image). */
  viewVersion = 0;
  cameraKey: number[] = [];
  readonly idScene = new Scene();
  idTarget: RenderTarget | null = null;
  idImage: { data: Uint8Array; w: number; h: number; version: number } | null = null;
  idLayout: Array<{ id: string; entry: BodyEntry; base: number; faces: number }> = [];
  idBusy = false;
  pickWaiters: Array<() => void> = [];
  readonly pickStats: PickStats = {
    idRefreshes: 0,
    lastIdRefreshMs: 0,
    lastBvhBuildMs: 0,
    idBufferPicks: 0,
    fallbackPicks: 0,
  };

  // ---- overlays
  highlights: { selected: HighlightItem[]; preselected: HighlightItem[] } = {
    selected: [],
    preselected: [],
  };
  readonly highlightGroup = new Group();
  highlightDots: Dot[] = [];
  readonly sketches = new Map<string, SketchEntry>();
  readonly ghosts = new Map<string, GhostEntry>();
  compare: { overlay: CompareOverlay; objects: CompareObjects; ghost: number } | null = null;
  compareBuilds = 0;
  cube: ViewCube | null = null;

  // ---- M2 touch state
  readonly recognizer = new GestureRecognizer();
  readonly gestureListeners = new Set<(g: ViewportGesture) => void>();
  readonly cameraListeners = new Set<(c: CameraChange) => void>();
  /** Until an app subscribes to gestures, a double tap/click fits the view (M1 behaviour). */
  appOwnsGestures = false;
  longPressTimer = 0;
  cameraChangedSinceEmit = false;
  lastEmittedMoving = false;
  readonly previews = new Map<string, PreviewEntry>();
  readonly handles = new Map<string, ArrowHandle>();
  hoveredHandle: string | null = null;
  readonly markerSets = new Map<string, MarkerEntry>();
  readonly touchStats: TouchStats = {
    prismBuilds: 0,
    lastPreviewPresentedAt: 0,
    warmMs: 0,
    environmentReady: false,
    handleHover: null,
    sectionActive: false,
    sectionNormal: null,
    sectionOffset: null,
    capsDrawn: 0,
    capColor: null,
  };
  followSystemMotion = false;
  previewDirty = false;

  // ---- M3.5 navigation
  navigation: NavigationOptions = { ...DEFAULT_NAVIGATION };
  readonly navMachine = new NavigationMachine();
  /** A touch / pen press waiting to reach the window's bubble phase (see `attachInput`). */
  lateNavDown: NavSample | null = null;
  nav: {
    mode: 'orbit' | 'pan';
    pivot: Vec3;
    source: PivotSource;
    /** Orbit distance kept constant so the controls' target stays on the view axis. */
    dist: number;
    /** Pan: world units per pixel at the grabbed depth. */
    wpp: number;
  } | null = null;
  idTotalsCache: { img: object; counts: Uint32Array } | null = null;
  lastPivot: { point: Vec3; source: PivotSource } | null = null;
  /** Pivot set by a middle click (`middleOrbit`), used only for orbits that start on a miss. */
  pivotOverride: Vec3 | null = null;
  pivotMarker: { group: Group; dots: Dot[] } | null = null;
  pivotFlashTimer = 0;
  lastPivotMs = 0;
  /** Button of the press the navigation machine is tracking (for lost-release recovery). */
  navButton = 0;
  /**
   * Wheel zoom in progress (ADR-057 addendum): the camera slides along the cursor ray toward the
   * anchor, easing `current` to `goal` (distance to the anchor) frame-rate independently.
   */
  wheel: WheelState | null = null;
  restTimer = 0;
  // ---- M4.5 3D mouse (ADR-096)
  readonly motionState: MotionState = createMotionState();
  /** Last pointer position over the canvas (CSS px): the pivot and zoom anchor of 3D mouse motion. */
  cursor: { x: number; y: number } | null = null;
  /** `performance.now()` of the last pointer move (wheel echo rule). */
  lastPointerMoveAt = 0;
  /** Pointers with a button or finger down on the canvas (motion is ignored meanwhile). */
  readonly pointersDown = new Set<number>();
  /** `performance.now()` of the last wheel event or moving frame (rest work waits for quiet). */
  lastActivityAt = 0;

  static async create(
    canvas: HTMLCanvasElement,
    options: ViewportEngineOptions,
  ): Promise<ViewportImpl> {
    const forceWebGL = options.backend === 'webgl2' || !(await probeWebGPU());
    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      forceWebGL,
      alpha: false,
      stencil: true, // section caps
    });
    try {
      await renderer.init();
    } catch (err) {
      renderer.dispose();
      throw err;
    }
    return new ViewportImpl(canvas, renderer, options);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    renderer: WebGPURenderer,
    options: ViewportEngineOptions,
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl2';
    this.theme = options.theme ?? 'light';
    this.palette = PALETTES[this.theme];
    this.ui = OVERLAY_COLORS[this.theme];
    // Honour prefers-reduced-motion unless the host decides explicitly.
    this.followSystemMotion = options.reducedMotion === undefined;
    this.reducedMotion =
      options.reducedMotion ??
      (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.maxPixelRatio = options.maxPixelRatio ?? 2;

    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.style.setProperty('-webkit-user-select', 'none');
    canvas.style.setProperty('-webkit-touch-callout', 'none');
    canvas.style.outline = 'none';
    canvas.tabIndex = Math.max(canvas.tabIndex, 0);

    // Procedural studio environment (no external HDR) is built *after* the first body frame:
    // PMREM generation compiles and renders several shader passes, which costs ~1.6 s of
    // main-thread time on software GL and would delay first paint (PLAN §10). Until then a
    // hemisphere fill light stands in. See ADR-005.
    this.scene.add(this.fillLight);
    this.cleanup.push(() => {
      clearTimeout(envFallback);
    });
    const envFallback = setTimeout(() => scheduleEnvironment(this), 3000);

    this.keyLight.position.set(-60, -90, 120);
    this.scene.add(this.keyLight);

    this.edgeMaterial = applyDepthBias(
      new Line2NodeMaterial({ color: this.palette.edge, linewidth: 1.6 }),
    );
    this.scene.add(this.grid.mesh, this.shadow.mesh, this.bodyRoot);
    this.bodyRoot.add(this.highlightGroup);
    this.bodyRoot.enabled = false;
    this.idRoot.enabled = false;
    this.bodyRoot.clippingPlanes = [this.sectionPlane];
    this.idRoot.clippingPlanes = [this.sectionPlane];
    this.idScene.add(this.idRoot);
    this.highlightGroup.renderOrder = 20;

    // Z-up CAD convention. Must be set before camera-controls captures the up vector.
    this.camera.up.set(0, 0, 1);
    this.camera.orthographic = this.navigation.projection !== 'perspective';
    this.camera.position.set(80, -110, 70);
    this.controls = new CameraControls(this.camera, canvas);
    configureControls(this);
    applyPalette(this);
    updateSceneBounds(this);
    this.fitAll(false);
    attachInput(this);
    attachContextHandlers(this);
    this.resize();

    if (options.viewCube !== false) createViewCube(this);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    if (this.followSystemMotion && typeof matchMedia !== 'undefined') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      const change = () => this.setReducedMotion(mq.matches);
      mq.addEventListener('change', change);
      this.cleanup.push(() => mq.removeEventListener('change', change));
    }
    requestRender(this);
    if (options.precompile !== false) scheduleWarmup(this);
  }

  setBody(id: string, mesh: MeshBuffers, display: BodyDisplay = {}): void {
    setBody(this, id, mesh, display);
  }

  removeBody(id: string): void {
    removeBody(this, id);
  }

  setDisplay(id: string, display: BodyDisplay): void {
    setDisplay(this, id, display);
  }

  fitAll(animate = true, options: FitOptions = {}): void {
    fitAll(this, animate, options);
  }

  /**
   * The canvas area covered by floating chrome (bottom sheet, top bar). Later fits centre and
   * size the model in the rest; the view cube moves clear of the top inset. Does not move the
   * camera away from what it shows: when the insets change after a fit, the camera trucks (snaps,
   * no zoom or orientation change) so the view's old centre stays at the centre of the free area
   * (ADR-086 amendment). Call `fitAll` to fully re-frame.
   */
  setFrameInsets(insets: Partial<FrameInsets>): void {
    const prev = this.frameInsets;
    this.frameInsets = { ...NO_FRAME_INSETS, ...insets };
    keepInView(this, prev, this.frameInsets);
    this.cube?.place(this.canvas, this.frameInsets);
  }

  setView(view: StandardView, animate = true): void {
    setView(this, view, animate);
  }

  setViewDirection(dir: Vec3, animate = true): void {
    setViewDirection(this, dir, animate);
  }

  setTheme(theme: 'light' | 'dark'): void {
    setTheme(this, theme);
  }

  setReducedMotion(reduced: boolean): void {
    setReducedMotion(this, reduced);
  }

  resize(): void {
    resize(this);
  }

  nextFrame(): Promise<void> {
    return nextFrame(this);
  }

  stats(): ViewportStats {
    return stats(this);
  }

  getRenderCount(): number {
    return getRenderCount(this);
  }

  isCameraMoving(): boolean {
    return isCameraMoving(this);
  }

  getPickStats(): PickStats {
    return getPickStats(this);
  }

  getCameraState(): CameraState {
    return getCameraState(this);
  }

  on<K extends keyof ViewportEventMap>(type: K, cb: (e: ViewportEventMap[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set<(e: never) => void>();
    this.listeners.set(type, set);
    set.add(cb as (e: never) => void);
    return () => set.delete(cb as (e: never) => void);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.restTimer);
    if (this.motionState.watchdog !== null) clearTimeout(this.motionState.watchdog);
    this.motionState.integ.reset();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.controls.dispose();
    this.cube?.dispose();
    this.cube = null;
    for (const e of this.bodies.values()) disposeBody(this, e);
    this.bodies.clear();
    clearHighlightObjects(this);
    for (const id of [...this.sketches.keys()]) this.setSketch(id, null);
    for (const id of [...this.ghosts.keys()]) this.setGhost(id, null);
    this.setCompare(null);
    for (const [id, p] of [...this.previews]) removePreview(this, id, p);
    for (const id of [...this.handles.keys()]) this.setHandle(id, null);
    for (const id of [...this.markerSets.keys()]) this.setMarkers(id, null);
    this.idTarget?.dispose();
    this.idTarget = null;
    this.references.dispose();
    this.grid.dispose();
    this.shadow.dispose();
    this.edgeMaterial.dispose();
    this.envTarget?.dispose();
    this.envTarget = null;
    this.scene.environment = null;
    this.renderer.dispose();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    const pw = this.pickWaiters;
    this.pickWaiters = [];
    for (const w of pw) w();
  }

  pick(x: number, y: number, options: PickOptions = {}): PickHit[] {
    return pick(this, x, y, options);
  }

  setHighlights(highlights: { selected: HighlightItem[]; preselected: HighlightItem[] }): void {
    setHighlights(this, highlights);
  }

  setSketch(featureId: string, overlay: SketchOverlay | null): void {
    setSketch(this, featureId, overlay);
  }

  setGhost(bodyId: string, mesh: MeshBuffers | null): void {
    setGhost(this, bodyId, mesh);
  }

  screenToPlane(x: number, y: number, plane: PlaneFrame): Vec2 | null {
    return screenToPlane(this, x, y, plane);
  }

  worldToScreen(point: Vec3): { x: number; y: number; visible: boolean } {
    return worldToScreen(this, point);
  }

  lookAtPlane(plane: PlaneFrame, animate = true): void {
    lookAtPlane(this, plane, animate);
  }

  whenPickReady(): Promise<void> {
    return whenPickReady(this);
  }

  setCompare(overlay: CompareOverlay | null): void {
    setCompare(this, overlay);
  }

  setReferences(refs: readonly ViewportReference[]): void {
    if (this.disposed) return;
    this.references.setReferences(refs);
  }

  setOriginReferences(show: boolean): void {
    if (this.disposed) return;
    this.references.setOrigin(show);
  }

  getReferenceStats(): ReferenceStats {
    return this.references.stats();
  }

  getCompareStats(): CompareStats {
    return getCompareStats(this);
  }

  getBodyMaterialState(id: string): BodyMaterialState | null {
    return getBodyMaterialState(this, id);
  }

  emit<K extends keyof ViewportEventMap>(type: K, e: ViewportEventMap[K]): void {
    for (const cb of this.listeners.get(type) ?? []) (cb as (x: ViewportEventMap[K]) => void)(e);
  }

  setInputPolicy(policy: InputPolicy): void {
    setInputPolicy(this, policy);
  }

  onGesture(listener: (g: ViewportGesture) => void): () => void {
    return onGesture(this, listener);
  }

  onCamera(listener: (c: CameraChange) => void): () => void {
    return onCamera(this, listener);
  }

  zoomTo(point: Vec3, radius: number, animate = true): void {
    zoomTo(this, point, radius, animate);
  }

  getRoll(): number {
    return getRoll(this);
  }

  getTouchStats(): TouchStats {
    return getTouchStats(this);
  }

  getHandleScreenLength(id: string): number | null {
    return getHandleScreenLength(this, id);
  }

  setSection(section: SectionPlane | null): void {
    setSection(this, section);
  }

  setPreview(id: string, spec: PreviewSpec | null): void {
    setPreview(this, id, spec);
  }

  setHandle(id: string, handle: HandleSpec | null): void {
    setHandle(this, id, handle);
  }

  setNavigation(options: Partial<NavigationOptions>): void {
    setNavigation(this, options);
  }

  getNavigation(): NavigationOptions {
    return getNavigation(this);
  }

  getNavigationState(): NavigationState {
    return getNavigationState(this);
  }

  /** M4.5 (ADR-096): one 6-DoF sample from a 3D mouse; see `TouchViewport.motion`. */
  motion(sample: MotionSample): void {
    motionSample(this, sample);
  }

  /**
   * Everything in a screen rectangle. `window` = entirely inside, `crossing` = touching.
   * Faces come from the ID buffer (visible pixels; `await whenPickReady()` first for an exact
   * answer, otherwise a geometric test filtered by sampled rays), edges and vertices from their
   * projected polylines, occlusion-tested against the BVH when `visibleOnly` (default). Sketch
   * entities are never occlusion-tested. Default kinds: face, edge, vertex, sketchPoint,
   * sketchCurve (regions and handles only when asked for). Nearest to the camera first.
   */
  pickRect(rectIn: ScreenRect, options: RectPickOptions): PickHit[] {
    return pickRect(this, rectIn, options);
  }

  setMarkers(id: string, markers: Marker[] | null): void {
    setMarkers(this, id, markers);
  }
}
