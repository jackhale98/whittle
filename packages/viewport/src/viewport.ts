/**
 * The Whittle viewport engine: imperative three.js on `WebGPURenderer` (automatic WebGL2
 * fallback), camera-controls for orbit/pan/zoom, render-on-demand, plus M1 picking (GPU ID buffer
 * + BVH + screen-space distance), selection highlights, sketch overlays, ghosts and a view cube.
 */

import type {
  BodyDisplay,
  CreateViewport,
  HighlightItem,
  InteractiveViewport,
  MeshBuffers,
  PickHit,
  PickKind,
  PickOptions,
  RenderBackend,
  SketchOverlay,
  StandardView,
  Vec2,
  Vec3,
  ViewportOptions,
  ViewportStats,
} from '@whittle/contracts';
import CameraControls from 'camera-controls';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FrontSide,
  Group,
  HemisphereLight,
  Line2NodeMaterial,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NearestFilter,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Ray,
  Raycaster,
  RenderTarget,
  Scene,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
  WebGPURenderer,
} from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { probeWebGPU } from './backend';
import { edgesToSegments, meshBuffersToGeometry } from './geometry';
import { ContactShadow, Grid } from './ground';
import {
  deriveVertices,
  encodeId,
  type FaceIdLayout,
  faceDrawRange,
  faceIdPerVertex,
  idAtPixel,
  MAX_ID,
  NO_FACE,
  triangleToFace,
} from './ids';
import {
  type Dot,
  disposeOverlay,
  makeDot,
  makeFill,
  makeLines,
  polylineSegments,
  sizeDots,
} from './overlays';
import {
  bestCandidate,
  closestOnPolyline,
  type ProjectFn,
  raycastTriangles,
  sortByDistance,
} from './pick';
import { lookAtPlanePose, type PlaneFrame, rayToPlane } from './plane';
import { entityColor, mixHex } from './sketchStyle';
import { OVERLAY_COLORS, type OverlayColors, PALETTES, type Palette } from './themes';
import { type CubeHit, ViewCube } from './viewcube';
import {
  type Bounds,
  boundsCenter,
  boundsRadius,
  cameraPositionFor,
  clipPlanes,
  EMPTY_BOUNDS,
  fitDistance,
  gridCellSize,
  unionBounds,
  VIEW_DIRECTIONS,
} from './views';

CameraControls.install({
  THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

const FOV_DEG = 35;
const DEFAULT_BODY_COLOR_KEY = 'default';
/** ID buffer resolution relative to the canvas' CSS size. */
const ID_SCALE = 0.5;
const DEFAULT_TOLERANCE_PX = 6;
/** Faces above this many triangles are ray-cast through the BVH instead of brute force. */
const LARGE_FACE_TRIANGLES = 20_000;

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

export interface ViewportEngineOptions extends ViewportOptions {
  /** Render the view cube in the canvas' top-right corner. Default true. */
  viewCube?: boolean;
}

export type ViewportEventMap = {
  /** The GPU context was lost; the app should show a message and may recreate the viewport. */
  contextlost: { reason: string };
  contextrestored: Record<string, never>;
};

/** The contract `InteractiveViewport` plus a few extras for hosts and tests. */
export interface ViewportEngine extends InteractiveViewport {
  readonly canvas: HTMLCanvasElement;
  getCameraState(): CameraState;
  setReducedMotion(reduced: boolean): void;
  /** Number of frames rendered so far (lets tests assert render-on-demand). */
  getRenderCount(): number;
  /** Animate to look along `dir` (unit vector from the target toward the camera). */
  setViewDirection(dir: Vec3, animate?: boolean): void;
  /**
   * Resolves once the face ID buffer matches the current camera/scene (face picks are then
   * served from the GPU buffer instead of the CPU fallback). Enables ID-buffer rendering.
   */
  whenPickReady(): Promise<void>;
  getPickStats(): PickStats;
  on<K extends keyof ViewportEventMap>(type: K, cb: (e: ViewportEventMap[K]) => void): () => void;
}

export interface PickStats {
  idRefreshes: number;
  /** CPU ms of the last ID render + readback wait. */
  lastIdRefreshMs: number;
  lastBvhBuildMs: number;
  /** Face picks answered from the ID buffer / from the BVH fallback. */
  idBufferPicks: number;
  fallbackPicks: number;
}

interface BodyEntry {
  group: Group;
  object: Mesh;
  lines: LineSegments2 | null;
  material: MeshStandardNodeMaterial;
  geometry: BufferGeometry;
  buffers: MeshBuffers;
  triangles: number;
  bounds: Bounds;
  display: Required<BodyDisplay>;
  // lazily built picking data
  bvh: MeshBVH | null;
  triFace: Uint32Array | null;
  vertices: Float32Array | null;
  faceLayout: FaceIdLayout | null;
  idMesh: Mesh | null;
  /** Global id base the id colours were built with (-1 = not built). */
  idBuiltBase: number;
  idBase: number;
}

interface GhostEntry {
  group: Group;
  material: MeshStandardNodeMaterial;
  lineMaterial: Line2NodeMaterial | null;
}

interface SketchEntry {
  overlay: SketchOverlay;
  group: Group;
  dots: Dot[];
  /** Per-curve data for picking. */
  curves: Array<{ entity: string; points: Float32Array; isPoint: boolean }>;
  regions: Array<{ name: string; mesh: MeshBuffers }>;
}

const DEFAULT_DISPLAY: Required<BodyDisplay> = {
  color: DEFAULT_BODY_COLOR_KEY,
  visible: true,
  opacity: 1,
};

export const createViewport = (async (canvas, options = {}) =>
  ViewportImpl.create(canvas, options)) satisfies CreateViewport as (
  canvas: HTMLCanvasElement,
  options?: ViewportEngineOptions,
) => Promise<ViewportEngine>;

class ViewportImpl implements ViewportEngine {
  readonly canvas: HTMLCanvasElement;
  readonly backend: RenderBackend;

  private readonly renderer: WebGPURenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 10000);
  private readonly controls: CameraControls;
  private readonly bodies = new Map<string, BodyEntry>();
  private readonly edgeMaterial: Line2NodeMaterial;
  private readonly grid = new Grid();
  private readonly shadow = new ContactShadow();
  private readonly keyLight = new DirectionalLight(0xffffff, 1);
  /** Built after the first body frame (see scheduleEnvironment); null until then. */
  private envTarget: { dispose(): void; texture: Scene['environment'] } | null = null;
  private envScheduled = false;
  /** Stand-in ambient light until the studio environment exists. */
  private readonly fillLight = new HemisphereLight(0xffffff, 0x8a929e, 2.2);

  private theme: 'light' | 'dark';
  private palette: Palette;
  private ui: OverlayColors;
  private reducedMotion: boolean;
  private maxPixelRatio: number;
  private sceneBounds: Bounds = EMPTY_BOUNDS;
  private sceneRadius = boundsRadius(EMPTY_BOUNDS);

  private raf = 0;
  private dirty = true;
  /** True between camera-controls `controlstart` and `controlend` (a pointer is down). */
  private interacting = false;
  private disposed = false;
  private lastFrameTime = 0;
  private frameTimes: number[] = [];
  private lastDrawCalls = 0;
  private renderCount = 0;
  private waiters: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private cleanup: Array<() => void> = [];
  private readonly listeners = new Map<string, Set<(e: never) => void>>();

  // ---- picking state
  private pickingEnabled = false;
  /** Bumped when the camera, canvas size or visible geometry changes (invalidates the ID image). */
  private viewVersion = 0;
  private cameraKey: number[] = [];
  private readonly idScene = new Scene();
  private idTarget: RenderTarget | null = null;
  private idImage: { data: Uint8Array; w: number; h: number; version: number } | null = null;
  private idLayout: Array<{ id: string; entry: BodyEntry; base: number; faces: number }> = [];
  private idBusy = false;
  private pickWaiters: Array<() => void> = [];
  private readonly pickStats: PickStats = {
    idRefreshes: 0,
    lastIdRefreshMs: 0,
    lastBvhBuildMs: 0,
    idBufferPicks: 0,
    fallbackPicks: 0,
  };

  // ---- overlays
  private highlights: { selected: HighlightItem[]; preselected: HighlightItem[] } = {
    selected: [],
    preselected: [],
  };
  private readonly highlightGroup = new Group();
  private highlightDots: Dot[] = [];
  private readonly sketches = new Map<string, SketchEntry>();
  private readonly ghosts = new Map<string, GhostEntry>();
  private cube: ViewCube | null = null;

  static async create(
    canvas: HTMLCanvasElement,
    options: ViewportEngineOptions,
  ): Promise<ViewportImpl> {
    const forceWebGL = options.backend === 'webgl2' || !(await probeWebGPU());
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL, alpha: false });
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
    this.reducedMotion = options.reducedMotion ?? false;
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
    const envFallback = setTimeout(() => this.scheduleEnvironment(), 3000);

    this.keyLight.position.set(-60, -90, 120);
    this.scene.add(this.keyLight);

    this.edgeMaterial = new Line2NodeMaterial({ color: this.palette.edge, linewidth: 1.6 });
    this.scene.add(this.grid.mesh, this.shadow.mesh, this.highlightGroup);
    this.highlightGroup.renderOrder = 20;

    // Z-up CAD convention. Must be set before camera-controls captures the up vector.
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -110, 70);
    this.controls = new CameraControls(this.camera, canvas);
    this.configureControls();
    this.applyPalette();
    this.updateSceneBounds();
    this.fitAll(false);
    this.attachInput();
    this.attachContextHandlers();
    this.resize();

    if (options.viewCube !== false) this.createViewCube();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.requestRender();
  }

  // ---------------------------------------------------------------- Viewport API

  setBody(id: string, mesh: MeshBuffers, display: BodyDisplay = {}): void {
    if (this.disposed) return;
    // The first body has priority over the environment; build it right after that frame.
    queueMicrotask(() => this.scheduleEnvironment());
    const wasEmpty = this.bodies.size === 0;
    const previous = this.bodies.get(id);
    const merged: Required<BodyDisplay> = {
      ...DEFAULT_DISPLAY,
      ...previous?.display,
      ...stripUndefined(display),
    };

    const bounds: Bounds = { min: [...mesh.bbox.min], max: [...mesh.bbox.max] };
    let entry: BodyEntry;
    if (previous) {
      // Cheap replace (coarse <-> fine during drags): keep the mesh, material (no shader
      // recompile), group and line object; only swap or refill the geometry.
      entry = previous;
      this.replaceGeometry(entry, mesh);
      entry.buffers = mesh;
      entry.triangles = mesh.indices.length / 3;
      entry.bounds = bounds;
      entry.display = merged;
    } else {
      const geometry = meshBuffersToGeometry(mesh);
      const material = new MeshStandardNodeMaterial({
        color: this.resolveBodyColor(merged.color),
        roughness: 0.52,
        metalness: 0.0,
        side: FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const object = new Mesh(geometry, material);
      object.frustumCulled = false;
      const group = new Group();
      group.add(object);
      this.scene.add(group);
      entry = {
        group,
        object,
        lines: null,
        material,
        geometry,
        buffers: mesh,
        triangles: mesh.indices.length / 3,
        bounds,
        display: merged,
        bvh: null,
        triFace: null,
        vertices: null,
        faceLayout: null,
        idMesh: null,
        idBuiltBase: -1,
        idBase: 0,
      };
      this.bodies.set(id, entry);
      this.setEdges(entry, mesh);
    }
    this.invalidatePickData(entry);
    this.applyDisplay(entry);
    this.updateSceneBounds();
    if (wasEmpty) this.fitAll(false);
    this.viewVersion++;
    this.rebuildHighlights();
    this.requestRender();
  }

  removeBody(id: string): void {
    const entry = this.bodies.get(id);
    if (!entry) return;
    this.disposeBody(entry);
    this.bodies.delete(id);
    this.updateSceneBounds();
    this.viewVersion++;
    this.rebuildHighlights();
    this.requestRender();
  }

  setDisplay(id: string, display: BodyDisplay): void {
    const entry = this.bodies.get(id);
    if (!entry) return;
    entry.display = { ...entry.display, ...stripUndefined(display) };
    this.applyDisplay(entry);
    this.updateSceneBounds();
    this.viewVersion++;
    this.requestRender();
  }

  fitAll(animate = true): void {
    this.fitTo(this.currentDirection(), animate);
  }

  setView(view: StandardView, animate = true): void {
    this.fitTo(VIEW_DIRECTIONS[view], animate);
  }

  setViewDirection(dir: Vec3, animate = true): void {
    this.fitTo(dir, animate);
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    this.palette = PALETTES[theme];
    this.ui = OVERLAY_COLORS[theme];
    this.applyPalette();
    for (const e of this.bodies.values()) this.applyDisplay(e);
    this.cube?.setColors(this.ui);
    this.rebuildHighlights();
    for (const [id, s] of [...this.sketches]) this.setSketch(id, s.overlay);
    for (const [id, g] of [...this.ghosts]) this.rebuildGhostColors(id, g);
    this.requestRender();
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.configureControls();
  }

  resize(): void {
    if (this.disposed) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.cube?.place(this.canvas);
    this.viewVersion++;
    this.requestRender();
  }

  nextFrame(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.requestRender();
    });
  }

  stats(): ViewportStats {
    let triangles = 0;
    for (const e of this.bodies.values()) if (e.display.visible) triangles += e.triangles;
    const n = this.frameTimes.length;
    const frameMs = n === 0 ? 0 : this.frameTimes.reduce((a, b) => a + b, 0) / n;
    return { backend: this.backend, frameMs, triangles, drawCalls: this.lastDrawCalls };
  }

  getRenderCount(): number {
    return this.renderCount;
  }

  getPickStats(): PickStats {
    return { ...this.pickStats };
  }

  getCameraState(): CameraState {
    const p = this.controls.getPosition(new Vector3());
    const t = this.controls.getTarget(new Vector3());
    return {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      distance: p.distanceTo(t),
    };
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
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.controls.dispose();
    this.cube?.dispose();
    this.cube = null;
    for (const e of this.bodies.values()) this.disposeBody(e);
    this.bodies.clear();
    this.clearHighlightObjects();
    for (const id of [...this.sketches.keys()]) this.setSketch(id, null);
    for (const id of [...this.ghosts.keys()]) this.setGhost(id, null);
    this.idTarget?.dispose();
    this.idTarget = null;
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

  // ---------------------------------------------------------------- InteractiveViewport API

  pick(x: number, y: number, options: PickOptions = {}): PickHit[] {
    if (this.disposed) return [];
    this.enablePicking();
    const tol = options.tolerancePx ?? DEFAULT_TOLERANCE_PX;
    const want = (k: PickKind) => !options.kinds || options.kinds.includes(k);
    const out: PickHit[] = [];
    const ray = this.rayAt(x, y);
    const project = this.projector();
    const anySketchActive = [...this.sketches.values()].some((s) => s.overlay.active);

    // Sketch entities.
    if (want('sketchCurve') || want('sketchPoint') || want('region')) {
      for (const [featureId, s] of this.sketches) {
        s.curves.forEach((c, i) => {
          const kind: PickKind = c.isPoint ? 'sketchPoint' : 'sketchCurve';
          if (!want(kind)) return;
          const h = closestOnPolyline(c.points, 0, c.points.length / 3, project, x, y);
          if (h && h.distancePx <= tol) {
            out.push({
              bodyId: featureId,
              kind,
              index: i,
              entity: c.entity,
              point: h.point,
              distancePx: h.distancePx,
            });
          }
        });
        if (want('region')) {
          s.regions.forEach((r, i) => {
            const tri = raycastTriangles(
              ray.origin,
              ray.dir,
              r.mesh.positions,
              r.mesh.indices,
              0,
              r.mesh.indices.length / 3,
              false,
            );
            if (tri) {
              out.push({
                bodyId: featureId,
                kind: 'region',
                index: i,
                entity: r.name,
                point: [
                  ray.origin[0] + ray.dir[0] * tri.t,
                  ray.origin[1] + ray.dir[1] * tri.t,
                  ray.origin[2] + ray.dir[2] * tri.t,
                ],
                distancePx: 0,
              });
            }
          });
        }
      }
    }

    // Body vertices and edges (screen-space distance, occlusion-tested).
    const thin: PickHit[] = [];
    for (const [id, e] of this.bodies) {
      if (!e.display.visible) continue;
      if (want('vertex')) {
        const v = this.vertexPositions(e);
        for (let i = 0; i < v.length / 3; i++) {
          const h = closestOnPolyline(v, i, 1, project, x, y);
          if (h && h.distancePx <= tol) {
            thin.push({
              bodyId: id,
              kind: 'vertex',
              index: i,
              point: h.point,
              distancePx: h.distancePx,
            });
          }
        }
      }
      if (want('edge')) {
        const { edgePositions, edgeRanges } = e.buffers;
        const pointCount = edgePositions.length / 3;
        for (let i = 0; i < edgeRanges.length / 2; i++) {
          const first = edgeRanges[2 * i] as number;
          const count = Math.min(edgeRanges[2 * i + 1] as number, pointCount - first);
          const h = closestOnPolyline(edgePositions, first, count, project, x, y);
          if (h && h.distancePx <= tol) {
            thin.push({
              bodyId: id,
              kind: 'edge',
              index: i,
              point: h.point,
              distancePx: h.distancePx,
            });
          }
        }
      }
    }
    for (const t of thin) {
      if (anySketchActive || this.isVisiblePoint(ray.origin, t.point)) out.push(t);
    }

    // Faces (ID buffer, BVH fallback).
    if (want('face') && !anySketchActive) {
      const f = this.pickFace(x, y, ray);
      if (f) out.push(f);
    }

    if (options.all) return sortByDistance(out);
    const best = bestCandidate(out);
    return best ? [best] : [];
  }

  setHighlights(highlights: { selected: HighlightItem[]; preselected: HighlightItem[] }): void {
    this.highlights = {
      selected: [...highlights.selected],
      preselected: [...highlights.preselected],
    };
    this.rebuildHighlights();
    this.requestRender();
  }

  setSketch(featureId: string, overlay: SketchOverlay | null): void {
    const prev = this.sketches.get(featureId);
    if (prev) {
      this.scene.remove(prev.group);
      disposeOverlay(prev.group);
      this.sketches.delete(featureId);
    }
    if (overlay && !this.disposed) this.sketches.set(featureId, this.buildSketch(overlay));
    this.applyDimming();
    this.rebuildHighlights();
    this.requestRender();
  }

  setGhost(bodyId: string, mesh: MeshBuffers | null): void {
    const prev = this.ghosts.get(bodyId);
    if (prev) {
      this.scene.remove(prev.group);
      disposeOverlay(prev.group);
      this.ghosts.delete(bodyId);
    }
    if (mesh && !this.disposed) {
      const material = new MeshStandardNodeMaterial({
        color: this.ghostColor(),
        roughness: 0.6,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: FrontSide,
      });
      const m = new Mesh(meshBuffersToGeometry(mesh), material);
      m.frustumCulled = false;
      m.renderOrder = 2;
      const group = new Group();
      group.add(m);
      let lineMaterial: Line2NodeMaterial | null = null;
      const segs = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
      if (segs.length > 0) {
        const g = new LineSegmentsGeometry();
        g.setPositions(segs);
        lineMaterial = new Line2NodeMaterial({ color: this.ghostEdgeColor(), linewidth: 1.2 });
        const l = new LineSegments2(g, lineMaterial);
        l.frustumCulled = false;
        l.renderOrder = 3;
        group.add(l);
      }
      this.scene.add(group);
      this.ghosts.set(bodyId, { group, material, lineMaterial });
    }
    this.requestRender();
  }

  screenToPlane(x: number, y: number, plane: PlaneFrame): Vec2 | null {
    const ray = this.rayAt(x, y);
    return rayToPlane(ray.origin, ray.dir, plane)?.local ?? null;
  }

  worldToScreen(point: Vec3): { x: number; y: number; visible: boolean } {
    this.syncCameraMatrices();
    const v = new Vector3(point[0], point[1], point[2]).project(this.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const eye = new Vector3(point[0], point[1], point[2]).applyMatrix4(
      this.camera.matrixWorldInverse,
    );
    return {
      x: (v.x * 0.5 + 0.5) * w,
      y: (1 - (v.y * 0.5 + 0.5)) * h,
      visible: eye.z < 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
    };
  }

  lookAtPlane(plane: PlaneFrame, animate = true): void {
    const target = this.controls.getTarget(new Vector3());
    const pos = this.controls.getPosition(new Vector3());
    const pose = lookAtPlanePose(
      plane,
      [target.x, target.y, target.z],
      Math.max(pos.distanceTo(target), this.sceneRadius * 0.2),
    );
    const transition = animate && !this.reducedMotion;
    void this.controls.setLookAt(
      pose.position[0],
      pose.position[1],
      pose.position[2],
      pose.target[0],
      pose.target[1],
      pose.target[2],
      transition,
    );
    if (!transition) this.controls.update(0);
    this.requestRender();
  }

  whenPickReady(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.enablePicking();
    if (this.idFresh()) return Promise.resolve();
    return new Promise((resolve) => {
      this.pickWaiters.push(resolve);
      this.requestRender();
    });
  }

  // ---------------------------------------------------------------- picking internals

  private enablePicking(): void {
    if (this.pickingEnabled) return;
    this.pickingEnabled = true;
    this.requestRender();
  }

  private idFresh(): boolean {
    return this.idImage !== null && this.idImage.version === this.viewVersion;
  }

  private syncCameraMatrices(): void {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }

  private rayAt(x: number, y: number): { origin: Vec3; dir: Vec3 } {
    this.syncCameraMatrices();
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const p = new Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(this.camera);
    const o = this.camera.position;
    const d = p.sub(o).normalize();
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  /** World -> CSS px projector for the current camera (allocation-free per call). */
  private projector(): ProjectFn {
    this.syncCameraMatrices();
    const m = new Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    ).elements;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const m0 = m[0] as number;
    const m1 = m[1] as number;
    const m3 = m[3] as number;
    const m4 = m[4] as number;
    const m5 = m[5] as number;
    const m7 = m[7] as number;
    const m8 = m[8] as number;
    const m9 = m[9] as number;
    const m11 = m[11] as number;
    const m12 = m[12] as number;
    const m13 = m[13] as number;
    const m15 = m[15] as number;
    return (x, y, z, out) => {
      const cw = m3 * x + m7 * y + m11 * z + m15;
      if (cw <= 1e-9) return false;
      const cx = m0 * x + m4 * y + m8 * z + m12;
      const cy = m1 * x + m5 * y + m9 * z + m13;
      out.x = (cx / cw) * 0.5 * w + 0.5 * w;
      out.y = (1 - cy / cw) * 0.5 * h;
      return true;
    };
  }

  private invalidatePickData(e: BodyEntry): void {
    e.bvh = null;
    e.triFace = null;
    e.vertices = null;
    e.faceLayout = null;
    e.idBuiltBase = -1;
    if (e.idMesh) {
      this.idScene.remove(e.idMesh);
      disposeOverlay(e.idMesh, true);
      e.idMesh = null;
    }
  }

  private vertexPositions(e: BodyEntry): Float32Array {
    e.vertices ??= deriveVertices(e.buffers.edgePositions, e.buffers.edgeRanges, e.buffers.bbox);
    return e.vertices;
  }

  private bvhFor(e: BodyEntry): MeshBVH {
    if (!e.bvh) {
      const t0 = performance.now();
      // `indirect` keeps the kernel's index buffer untouched (it is shared with the GPU geometry).
      e.bvh = new MeshBVH(e.geometry, { indirect: true });
      this.pickStats.lastBvhBuildMs = performance.now() - t0;
    }
    return e.bvh;
  }

  private triFaceFor(e: BodyEntry): Uint32Array {
    e.triFace ??= triangleToFace(e.buffers.faceRanges, e.triangles);
    return e.triFace;
  }

  /** True when no visible body lies between the camera and `point`. */
  private isVisiblePoint(origin: Vec3, point: Vec3): boolean {
    const dx = point[0] - origin[0];
    const dy = point[1] - origin[1];
    const dz = point[2] - origin[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-9) return true;
    const eps = dist * 3e-3 + this.sceneRadius * 2e-3;
    const ray = new Ray(
      new Vector3(origin[0], origin[1], origin[2]),
      new Vector3(dx / dist, dy / dist, dz / dist),
    );
    for (const e of this.bodies.values()) {
      if (!e.display.visible) continue;
      const hit = this.bvhFor(e).raycastFirst(ray, FrontSide, 0, Math.max(dist - eps, 0));
      if (hit) return false;
    }
    return true;
  }

  private pickFace(x: number, y: number, ray: { origin: Vec3; dir: Vec3 }): PickHit | null {
    // 1. ID buffer, when current.
    if (this.idFresh() && this.idImage) {
      const img = this.idImage;
      const id = idAtPixel(
        img.data,
        img.w,
        img.h,
        (x * img.w) / (this.canvas.clientWidth || 1),
        (y * img.h) / (this.canvas.clientHeight || 1),
        this.backend === 'webgl2',
      );
      if (id === 0) {
        this.pickStats.idBufferPicks++;
        return null;
      }
      const slot = this.idLayout.find((l) => id - 1 >= l.base && id - 1 < l.base + l.faces);
      if (slot) {
        this.pickStats.idBufferPicks++;
        const face = id - 1 - slot.base;
        const hit = this.faceHit(slot.id, slot.entry, face, ray);
        if (hit) return hit;
        // The pixel's face was missed by the exact ray (silhouette rounding): use the BVH.
      }
    }
    // 2. CPU fallback: nearest front-facing triangle over all visible bodies.
    this.pickStats.fallbackPicks++;
    let best: {
      id: string;
      e: BodyEntry;
      dist: number;
      tri: number;
      nx: number;
      ny: number;
      nz: number;
      px: number;
      py: number;
      pz: number;
    } | null = null;
    const r = new Ray(
      new Vector3(ray.origin[0], ray.origin[1], ray.origin[2]),
      new Vector3(ray.dir[0], ray.dir[1], ray.dir[2]),
    );
    for (const [id, e] of this.bodies) {
      if (!e.display.visible) continue;
      const hit = this.bvhFor(e).raycastFirst(r, FrontSide);
      if (hit && hit.faceIndex != null && (!best || hit.distance < best.dist)) {
        best = {
          id,
          e,
          dist: hit.distance,
          tri: hit.faceIndex,
          nx: hit.face?.normal.x ?? 0,
          ny: hit.face?.normal.y ?? 0,
          nz: hit.face?.normal.z ?? 0,
          px: hit.point.x,
          py: hit.point.y,
          pz: hit.point.z,
        };
      }
    }
    if (!best) return null;
    const face = this.triFaceFor(best.e)[best.tri];
    if (face === undefined || face === NO_FACE) return null;
    return {
      bodyId: best.id,
      kind: 'face',
      index: face,
      point: [best.px, best.py, best.pz],
      normal: [best.nx, best.ny, best.nz],
      distancePx: 0,
    };
  }

  /** Exact hit point and smooth normal of the ray on one face (brute force over its triangles). */
  private faceHit(
    bodyId: string,
    e: BodyEntry,
    face: number,
    ray: { origin: Vec3; dir: Vec3 },
  ): PickHit | null {
    const { faceRanges, indices, positions, normals } = e.buffers;
    if (2 * face + 1 >= faceRanges.length) return null;
    const first = faceRanges[2 * face] as number;
    const count = faceRanges[2 * face + 1] as number;
    // Huge faces (dense imports) are cheaper through the BVH than brute force.
    if (count > LARGE_FACE_TRIANGLES) return null;
    const hit = raycastTriangles(ray.origin, ray.dir, positions, indices, first, count, true);
    if (!hit) return null;
    const ia = indices[3 * hit.tri] as number;
    const ib = indices[3 * hit.tri + 1] as number;
    const ic = indices[3 * hit.tri + 2] as number;
    const wa = 1 - hit.u - hit.v;
    const n: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      n[k] =
        wa * (normals[3 * ia + k] as number) +
        hit.u * (normals[3 * ib + k] as number) +
        hit.v * (normals[3 * ic + k] as number);
    }
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return {
      bodyId,
      kind: 'face',
      index: face,
      point: [
        ray.origin[0] + ray.dir[0] * hit.t,
        ray.origin[1] + ray.dir[1] * hit.t,
        ray.origin[2] + ray.dir[2] * hit.t,
      ],
      normal: [n[0] / len, n[1] / len, n[2] / len],
      distancePx: 0,
    };
  }

  /**
   * Render body face ids into the offscreen target and read it back asynchronously. Runs when the
   * view is idle, so orbiting never pays for it; `pick` uses the result while it is current and
   * the BVH otherwise.
   */
  private kickIdRefresh(): void {
    if (!this.pickingEnabled || this.idBusy || this.disposed || this.idFresh()) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const rw = Math.max(1, Math.round(w * ID_SCALE));
    const rh = Math.max(1, Math.round(h * ID_SCALE));
    const version = this.viewVersion;
    const t0 = performance.now();

    if (!this.idTarget) {
      this.idTarget = new RenderTarget(rw, rh, {
        depthBuffer: true,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        generateMipmaps: false,
      });
    } else if (this.idTarget.width !== rw || this.idTarget.height !== rh) {
      this.idTarget.setSize(rw, rh);
    }

    // Lay out ids and (re)build id geometry for bodies that need it.
    this.idLayout = [];
    let base = 0;
    for (const [id, e] of this.bodies) {
      const faces = e.buffers.faceRanges.length / 2;
      if (!e.display.visible || faces === 0 || base + faces > MAX_ID - 1) {
        if (e.idMesh) e.idMesh.visible = false;
        continue;
      }
      e.idBase = base;
      this.ensureIdMesh(e);
      if (e.idMesh) e.idMesh.visible = true;
      this.idLayout.push({ id, entry: e, base, faces });
      base += faces;
    }

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    this.syncCameraMatrices();
    r.setRenderTarget(this.idTarget);
    r.render(this.idScene, this.camera);
    r.setRenderTarget(prevTarget);

    this.idBusy = true;
    const target = this.idTarget;
    void r
      .readRenderTargetPixelsAsync(target, 0, 0, rw, rh)
      .then((data) => {
        this.idImage = { data: data as Uint8Array, w: rw, h: rh, version };
        this.pickStats.idRefreshes++;
        this.pickStats.lastIdRefreshMs = performance.now() - t0;
      })
      .catch((err) => {
        console.warn('[whittle/viewport] ID buffer readback failed', err);
      })
      .finally(() => {
        this.idBusy = false;
        if (this.disposed) return;
        this.prebuildBvh();
        if (this.idFresh()) {
          const waiters = this.pickWaiters;
          this.pickWaiters = [];
          for (const wk of waiters) wk();
        } else {
          this.requestRender(); // the view moved meanwhile; refresh again when idle
        }
      });
  }

  private hasBody(e: BodyEntry): boolean {
    for (const b of this.bodies.values()) if (b === e) return true;
    return false;
  }

  /** Build missing BVHs one body per idle slot so the first edge/occlusion pick does not stall. */
  private prebuildBvh(): void {
    const next = [...this.bodies.values()].find((b) => b.display.visible && !b.bvh);
    if (!next) return;
    const run = () => {
      if (this.disposed || next.bvh || !this.hasBody(next)) return;
      this.bvhFor(next);
      this.prebuildBvh();
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (ric) ric(run);
    else setTimeout(run, 50);
  }

  private ensureIdMesh(e: BodyEntry): void {
    if (e.idMesh && e.idBuiltBase === e.idBase) return;
    if (!e.faceLayout) {
      e.faceLayout = faceIdPerVertex(
        e.buffers.positions.length / 3,
        e.buffers.indices,
        e.buffers.faceRanges,
      );
    }
    const layout = e.faceLayout;
    const nVerts = layout.faceOfVertex.length;
    const colors = new Uint8Array(nVerts * 3);
    for (let v = 0; v < nVerts; v++) {
      const f = layout.faceOfVertex[v] as number;
      if (f === NO_FACE) continue;
      const [r, g, b] = encodeId(e.idBase + f + 1);
      colors[3 * v] = r;
      colors[3 * v + 1] = g;
      colors[3 * v + 2] = b;
    }
    if (e.idMesh) {
      // Same mesh version, shifted base: refill the colour attribute in place.
      const attr = e.idMesh.geometry.getAttribute('color') as BufferAttribute;
      attr.array = colors;
      attr.needsUpdate = true;
      e.idBuiltBase = e.idBase;
      return;
    }
    const geometry = new BufferGeometry();
    if (layout.appended.length === 0) {
      geometry.setAttribute('position', e.geometry.getAttribute('position'));
      geometry.setIndex(e.geometry.index);
    } else {
      const src = e.buffers.positions;
      const n = src.length / 3;
      const pos = new Float32Array(nVerts * 3);
      pos.set(src);
      for (let i = 0; i < layout.appended.length; i++) {
        const s = (layout.appended[i] as number) * 3;
        pos[3 * (n + i)] = src[s] as number;
        pos[3 * (n + i) + 1] = src[s + 1] as number;
        pos[3 * (n + i) + 2] = src[s + 2] as number;
      }
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setIndex(new BufferAttribute(layout.indices, 1));
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3, true));
    const material = new MeshBasicNodeMaterial({ vertexColors: true, side: FrontSide });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.idScene.add(mesh);
    e.idMesh = mesh;
    e.idBuiltBase = e.idBase;
  }

  // ---------------------------------------------------------------- highlights

  private clearHighlightObjects(): void {
    for (const child of [...this.highlightGroup.children]) {
      this.highlightGroup.remove(child);
      disposeOverlay(child, true);
    }
    this.highlightDots = [];
  }

  private rebuildHighlights(): void {
    this.clearHighlightObjects();
    const ui = this.ui;
    const pre = {
      fill: 0.16,
      edge: mixHex(ui.accent, this.palette.edge, 0.15),
      width: 2.8,
      dot: 9,
      ring: 'ghost' as const,
    };
    const sel = { fill: 0.34, edge: ui.accent, width: 3.6, dot: 11, ring: 'solid' as const };
    const apply = (items: HighlightItem[], style: typeof pre | typeof sel, order: number) => {
      for (const item of items) this.addHighlight(item, style, order);
    };
    // Preselection first so selection draws over it where they overlap.
    apply(this.highlights.preselected, pre, 21);
    apply(this.highlights.selected, sel, 22);
  }

  private addHighlight(
    item: HighlightItem,
    style: { fill: number; edge: string; width: number; dot: number },
    order: number,
  ): void {
    const ui = this.ui;
    const onTopSketch = this.sketches.get(item.bodyId)?.overlay.active === true;
    if (item.kind === 'face') {
      const e = this.bodies.get(item.bodyId);
      if (!e) return;
      const range = faceDrawRange(e.buffers.faceRanges, item.index, e.triangles);
      if (!range) return;
      const g = new BufferGeometry();
      g.setAttribute('position', e.geometry.getAttribute('position'));
      g.setIndex(e.geometry.index);
      g.setDrawRange(range.start, range.count);
      this.highlightGroup.add(makeFill(g, ui.accent, style.fill, false, order));
    } else if (item.kind === 'edge') {
      const e = this.bodies.get(item.bodyId);
      if (!e) return;
      const { edgeRanges, edgePositions } = e.buffers;
      if (2 * item.index + 1 >= edgeRanges.length) return;
      const first = edgeRanges[2 * item.index] as number;
      const count = edgeRanges[2 * item.index + 1] as number;
      const segs = polylineSegments(edgePositions, first, count);
      if (segs.length === 0) return;
      this.highlightGroup.add(
        makeLines(segs, {
          color: style.edge,
          width: style.width,
          onTop: false,
          renderOrder: order,
        }),
      );
    } else if (item.kind === 'vertex') {
      const e = this.bodies.get(item.bodyId);
      const v = e ? this.vertexPositions(e) : null;
      if (!v || 3 * item.index + 2 >= v.length) return;
      const dot = makeDot(style.dot, style.edge, ui.surface, order + 5, [
        v[3 * item.index] as number,
        v[3 * item.index + 1] as number,
        v[3 * item.index + 2] as number,
      ]);
      this.highlightGroup.add(dot.sprite);
      this.highlightDots.push(dot);
    } else {
      const s = this.sketches.get(item.bodyId);
      if (!s) return;
      const onTop = s.overlay.active === true || onTopSketch;
      if (item.kind === 'sketchCurve') {
        const c = s.curves.find((x) => x.entity === item.entity) ?? s.curves[item.index];
        if (!c || c.isPoint) return;
        this.highlightGroup.add(
          makeLines(polylineSegments(c.points, 0, c.points.length / 3), {
            color: style.edge,
            width: style.width + 0.6,
            onTop,
            renderOrder: order + 8,
          }),
        );
      } else if (item.kind === 'sketchPoint') {
        const c = s.curves.find((x) => x.entity === item.entity) ?? s.curves[item.index];
        if (!c?.isPoint) return;
        const dot = makeDot(style.dot + 2, style.edge, ui.surface, order + 12, [
          c.points[0] as number,
          c.points[1] as number,
          c.points[2] as number,
        ]);
        this.highlightGroup.add(dot.sprite);
        this.highlightDots.push(dot);
      } else if (item.kind === 'region') {
        const r = s.regions[item.index];
        if (!r) return;
        this.highlightGroup.add(
          makeFill(meshBuffersToGeometry(r.mesh), ui.accent, style.fill, onTop, order + 6),
        );
      }
    }
  }

  // ---------------------------------------------------------------- sketches

  private buildSketch(overlay: SketchOverlay): SketchEntry {
    const ui = this.ui;
    const { sketch } = overlay;
    const onTop = overlay.active === true;
    const conflicting = new Set(overlay.conflicting ?? []);
    const group = new Group();
    const dots: Dot[] = [];
    const curves: SketchEntry['curves'] = [];

    // Extent for dash sizing.
    let diag = 0;
    {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const c of sketch.curves) {
        for (let i = 0; i < c.points.length; i++) {
          const v = c.points[i] as number;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      diag = Number.isFinite(max - min) ? max - min : this.sceneRadius;
    }
    const dash = Math.max(diag / 60, 1e-3);

    // Bucket curve segments by (colour, dashed) -> one fat-line object each.
    const buckets = new Map<string, { color: string; dashed: boolean; segs: number[] }>();
    for (const c of sketch.curves) {
      const count = Math.floor(c.points.length / 3);
      const isPoint = count === 1;
      curves.push({ entity: c.entity, points: c.points, isPoint });
      const color = entityColor(ui, overlay.dof?.[c.entity], conflicting.has(c.entity));
      if (isPoint) {
        const dot = makeDot(8, color, this.palette.background, 31, [
          c.points[0] as number,
          c.points[1] as number,
          c.points[2] as number,
        ]);
        group.add(dot.sprite);
        dots.push(dot);
        continue;
      }
      if (count < 2) continue;
      const key = `${color}|${c.construction ? 'd' : 's'}`;
      const b = buckets.get(key) ?? { color, dashed: c.construction, segs: [] as number[] };
      buckets.set(key, b);
      for (let i = 0; i < count - 1; i++) {
        for (let k = 0; k < 6; k++) b.segs.push(c.points[3 * i + k] as number);
      }
    }
    for (const b of buckets.values()) {
      const lines = makeLines(Float32Array.from(b.segs), {
        color: b.color,
        width: b.dashed ? 1.8 : 2.4,
        dashed: b.dashed,
        dash,
        onTop,
        renderOrder: onTop ? 30 : 6,
      });
      group.add(lines);
    }
    // Faint region fills (also the pick surface for profiles).
    for (const r of sketch.regions) {
      group.add(makeFill(meshBuffersToGeometry(r.mesh), ui.accent, 0.1, onTop, onTop ? 28 : 5));
    }
    this.scene.add(group);
    return { overlay, group, dots, curves, regions: sketch.regions };
  }

  private applyDimming(): void {
    for (const e of this.bodies.values()) this.applyDisplay(e);
    this.edgeMaterial.color.set(
      this.anySketchActive()
        ? mixHex(this.palette.edge, this.palette.background, 0.65)
        : this.palette.edge,
    );
  }

  private anySketchActive(): boolean {
    for (const s of this.sketches.values()) if (s.overlay.active) return true;
    return false;
  }

  // ---------------------------------------------------------------- ghosts

  private ghostColor(): string {
    return mixHex(this.palette.body, this.ui.danger, 0.35);
  }

  private ghostEdgeColor(): string {
    return mixHex(this.palette.edge, this.palette.background, 0.45);
  }

  private rebuildGhostColors(_id: string, g: GhostEntry): void {
    g.material.color.set(this.ghostColor());
    g.lineMaterial?.color.set(this.ghostEdgeColor());
  }

  // ---------------------------------------------------------------- view cube

  private createViewCube(): void {
    const host = this.canvas.parentElement ?? document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const touch =
      typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches === true;
    this.cube = new ViewCube({
      host,
      colors: this.ui,
      touch,
      onSelect: (hit: CubeHit) => this.setViewDirection(hit.dir, true),
    });
    this.cube.place(this.canvas);
  }

  // ---------------------------------------------------------------- events / context loss

  private emit<K extends keyof ViewportEventMap>(type: K, e: ViewportEventMap[K]): void {
    for (const cb of this.listeners.get(type) ?? []) (cb as (x: ViewportEventMap[K]) => void)(e);
  }

  private attachContextHandlers(): void {
    const lost = (ev: Event) => {
      ev.preventDefault(); // lets the browser restore the context
      this.emit('contextlost', { reason: 'webglcontextlost' });
    };
    const restored = () => {
      // Resources are re-created lazily by the renderer; force a full redraw and re-pick.
      this.viewVersion++;
      this.idImage = null;
      this.emit('contextrestored', {});
      this.requestRender();
    };
    this.canvas.addEventListener('webglcontextlost', lost);
    this.canvas.addEventListener('webglcontextrestored', restored);
    this.cleanup.push(() => {
      this.canvas.removeEventListener('webglcontextlost', lost);
      this.canvas.removeEventListener('webglcontextrestored', restored);
    });
    const device = (
      this.renderer.backend as {
        device?: { lost?: Promise<{ message?: string; reason?: string }> };
      }
    ).device;
    void device?.lost?.then((info) => {
      if (!this.disposed) {
        this.emit('contextlost', {
          reason: `webgpu device lost: ${info.reason ?? info.message ?? ''}`,
        });
      }
    });
  }

  // ---------------------------------------------------------------- rendering internals

  /** Swap geometry in place: refill same-size buffers, otherwise replace the geometry object. */
  private replaceGeometry(e: BodyEntry, mesh: MeshBuffers): void {
    const g = e.geometry;
    const pos = g.getAttribute('position') as BufferAttribute;
    const nor = g.getAttribute('normal') as BufferAttribute;
    const idx = g.index as BufferAttribute;
    if (
      pos.array.length === mesh.positions.length &&
      nor.array.length === mesh.normals.length &&
      idx.array.length === mesh.indices.length
    ) {
      pos.array = mesh.positions;
      nor.array = mesh.normals;
      idx.array = mesh.indices;
      pos.needsUpdate = true;
      nor.needsUpdate = true;
      idx.needsUpdate = true;
      const { min, max } = mesh.bbox;
      g.boundingSphere?.center.set(
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      );
      g.boundingSphere?.set(
        g.boundingSphere.center,
        Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
      );
      g.userData.faces = { faceRanges: mesh.faceRanges, faceNames: mesh.faceNames };
    } else {
      const next = meshBuffersToGeometry(mesh);
      e.object.geometry = next;
      e.geometry = next;
      g.dispose();
    }
    this.setEdges(e, mesh);
  }

  private setEdges(e: BodyEntry, mesh: MeshBuffers): void {
    const segments = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
    if (segments.length === 0) {
      if (e.lines) {
        e.group.remove(e.lines);
        e.lines.geometry.dispose();
        e.lines = null;
      }
      return;
    }
    const lineGeometry = new LineSegmentsGeometry();
    lineGeometry.setPositions(segments);
    if (e.lines) {
      const old = e.lines.geometry;
      e.lines.geometry = lineGeometry;
      old.dispose();
    } else {
      e.lines = new LineSegments2(lineGeometry, this.edgeMaterial);
      e.lines.frustumCulled = false;
      e.group.add(e.lines);
    }
  }

  /** Builds the studio environment once, on idle after the next presented frame. */
  private scheduleEnvironment(): void {
    if (this.envScheduled || this.disposed) return;
    this.envScheduled = true;
    void this.nextFrame().then(() => {
      const build = () => {
        if (this.disposed) return;
        const pmrem = new PMREMGenerator(this.renderer);
        // 64² faces: CAD materials are rough, so a small environment looks the same.
        const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: 64 });
        pmrem.dispose();
        this.envTarget = envRT;
        this.scene.environment = envRT.texture;
        this.scene.remove(this.fillLight);
        this.requestRender();
      };
      const ric = (
        globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
      ).requestIdleCallback;
      if (ric) ric(build, { timeout: 500 });
      else setTimeout(build, 0);
    });
  }

  private configureControls(): void {
    const c = this.controls;
    const A = CameraControls.ACTION;
    c.mouseButtons.left = A.ROTATE;
    c.mouseButtons.right = A.TRUCK;
    c.mouseButtons.middle = A.TRUCK;
    c.mouseButtons.wheel = A.DOLLY;
    c.touches.one = A.TOUCH_ROTATE;
    c.touches.two = A.TOUCH_DOLLY_TRUCK;
    c.touches.three = A.TOUCH_TRUCK;
    c.dollyToCursor = true;
    c.smoothTime = this.reducedMotion ? 0 : 0.18;
    c.draggingSmoothTime = this.reducedMotion ? 0 : 0.06;
    c.azimuthRotateSpeed = 1;
    c.polarRotateSpeed = 1;
  }

  private attachInput(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      this.canvas.addEventListener(type, fn);
      this.cleanup.push(() => this.canvas.removeEventListener(type, fn));
    };

    on('contextmenu', (e) => e.preventDefault());

    // Wake the render loop whenever the controls start moving.
    const wake = () => this.requestRender();
    const start = () => {
      this.interacting = true;
      this.requestRender();
    };
    const end = () => {
      this.interacting = false;
      this.requestRender(); // let damping settle
    };
    this.controls.addEventListener('wake', wake);
    this.controls.addEventListener('controlstart', start);
    this.controls.addEventListener('controlend', end);
    this.controls.addEventListener('update', wake);
    this.cleanup.push(() => {
      this.controls.removeEventListener('wake', wake);
      this.controls.removeEventListener('controlstart', start);
      this.controls.removeEventListener('controlend', end);
      this.controls.removeEventListener('update', wake);
    });

    // Double click / double tap -> fit all. Uniform across mouse, touch and pen via pointer events.
    let downAt: { x: number; y: number; t: number } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;
    on('pointerdown', (e) => {
      downAt = e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
    });
    const cancel = () => {
      downAt = null;
    };
    on('pointercancel', cancel);
    on('pointerup', (e) => {
      const d = downAt;
      downAt = null;
      if (!d || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 8 || e.timeStamp - d.t > 350) {
        lastTap = null;
        return;
      }
      const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (
        lastTap &&
        tap.t - lastTap.t < 400 &&
        Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 30
      ) {
        lastTap = null;
        this.fitAll(true);
      } else {
        lastTap = tap;
      }
    });
  }

  private currentDirection(): Readonly<[number, number, number]> {
    const p = this.controls.getPosition(new Vector3());
    const t = this.controls.getTarget(new Vector3());
    const d = p.sub(t);
    if (d.lengthSq() < 1e-12) return VIEW_DIRECTIONS.iso;
    return [d.x, d.y, d.z];
  }

  private fitTo(direction: Readonly<[number, number, number]>, animate: boolean): void {
    const target = boundsCenter(this.sceneBounds);
    const distance = fitDistance(this.sceneRadius, this.camera.fov, this.camera.aspect || 1);
    const pos = cameraPositionFor(target, direction, distance);
    const transition = animate && !this.reducedMotion;
    // setLookAt is synchronous when transition is false (smoothing is bypassed via a jump).
    void this.controls.setLookAt(
      pos[0],
      pos[1],
      pos[2],
      target[0],
      target[1],
      target[2],
      transition,
    );
    if (!transition) this.controls.update(0);
    this.requestRender();
  }

  private updateSceneBounds(): void {
    const visible = [...this.bodies.values()].filter((b) => b.display.visible).map((b) => b.bounds);
    this.sceneBounds = unionBounds(visible) ?? EMPTY_BOUNDS;
    this.sceneRadius = boundsRadius(this.sceneBounds);
    const [cx, cy] = boundsCenter(this.sceneBounds);
    const { min, max } = this.sceneBounds;
    const eps = Math.max(this.sceneRadius * 0.0004, 1e-4);

    this.grid.place(cx, cy, min[2] - eps * 2, this.sceneRadius * 9, gridCellSize(this.sceneRadius));
    this.shadow.place(
      cx,
      cy,
      min[2] - eps,
      Math.max(max[0] - min[0], 1),
      Math.max(max[1] - min[1], 1),
    );
    this.shadow.mesh.visible = visible.length > 0;
    this.controls.minDistance = this.sceneRadius * 0.05;
    this.controls.maxDistance = this.sceneRadius * 40;
    this.keyLight.position
      .set(-0.4, -0.6, 0.9)
      .multiplyScalar(this.sceneRadius * 6)
      .add(new Vector3(cx, cy, 0));
  }

  private applyPalette(): void {
    const p = this.palette;
    this.scene.background = new Color(p.background);
    this.edgeMaterial.color.set(
      this.anySketchActive() ? mixHex(p.edge, p.background, 0.65) : p.edge,
    );
    this.grid.setPalette(p);
    this.shadow.setPalette(p);
    this.scene.environmentIntensity = p.envIntensity;
    this.keyLight.intensity = p.keyLight;
  }

  private resolveBodyColor(color: string): string {
    return color === DEFAULT_BODY_COLOR_KEY ? this.palette.body : color;
  }

  private applyDisplay(e: BodyEntry): void {
    e.group.visible = e.display.visible;
    const base = this.resolveBodyColor(e.display.color);
    // While a sketch is being edited the rest of the model recedes toward the background.
    e.material.color.set(
      this.anySketchActive() ? mixHex(base, this.palette.background, 0.6) : base,
    );
    const translucent = e.display.opacity < 1;
    e.material.transparent = translucent;
    e.material.opacity = e.display.opacity;
    e.material.depthWrite = !translucent;
    e.material.needsUpdate = true;
  }

  private disposeBody(e: BodyEntry): void {
    this.scene.remove(e.group);
    if (e.idMesh) {
      this.idScene.remove(e.idMesh);
      disposeOverlay(e.idMesh, true);
      e.idMesh = null;
    }
    e.geometry.dispose();
    e.material.dispose();
    e.lines?.geometry.dispose();
  }

  private requestRender(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.lastFrameTime === 0 ? 1 / 60 : Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    const moving = this.controls.update(dt);
    if (moving || this.dirty) {
      this.dirty = false;
      this.renderOnce();
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
    // While a pointer is down the loop must keep ticking even if nothing moved this frame:
    // camera-controls only applies pointer deltas inside update() (`_dragNeedsUpdate`), and it
    // emits no event on pointermove, so an idle loop would swallow touch drags.
    if (moving || this.interacting) {
      this.schedule();
    } else {
      // Idle: stop the loop; the next frame's dt must not include the idle gap.
      this.lastFrameTime = 0;
      // Settled: refresh the face ID buffer if picking is in use and the view changed.
      this.kickIdRefresh();
    }
  }

  private renderOnce(): void {
    const { near, far } = clipPlanes(this.controls.distance, this.sceneRadius);
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    sizeDots(
      [...this.highlightDots, ...[...this.sketches.values()].flatMap((s) => s.dots)],
      this.camera.projectionMatrix.elements[5] as number,
      this.canvas.clientHeight,
    );
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const dt = performance.now() - t0;
    this.renderCount++;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.lastDrawCalls = this.renderer.info.render.drawCalls;

    // Camera changes invalidate the ID image; the view cube follows the camera orientation.
    const m = this.camera.matrixWorld.elements;
    const key = [
      ...m,
      this.camera.projectionMatrix.elements[0] as number,
      this.camera.projectionMatrix.elements[5] as number,
    ];
    if (key.length !== this.cameraKey.length || key.some((v, i) => v !== this.cameraKey[i])) {
      this.cameraKey = key;
      this.viewVersion++;
      this.cube?.update({
        right: [m[0] as number, m[1] as number, m[2] as number],
        up: [m[4] as number, m[5] as number, m[6] as number],
        back: [m[8] as number, m[9] as number, m[10] as number],
      });
    }
  }
}

function stripUndefined(d: BodyDisplay): BodyDisplay {
  const out: BodyDisplay = {};
  if (d.color !== undefined) out.color = d.color;
  if (d.visible !== undefined) out.visible = d.visible;
  if (d.opacity !== undefined) out.opacity = d.opacity;
  return out;
}
