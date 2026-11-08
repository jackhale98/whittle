/**
 * The Whittle viewport engine: imperative three.js on `WebGPURenderer` (automatic WebGL2
 * fallback), camera-controls for orbit/pan/zoom, render-on-demand.
 */

import type {
  BodyDisplay,
  CreateViewport,
  MeshBuffers,
  RenderBackend,
  StandardView,
  Viewport,
  ViewportOptions,
  ViewportStats,
} from '@whittle/contracts';
import CameraControls from 'camera-controls';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import {
  Box3,
  Color,
  DirectionalLight,
  FrontSide,
  Group,
  HemisphereLight,
  Line2NodeMaterial,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
  WebGPURenderer,
} from 'three/webgpu';
import { probeWebGPU } from './backend';
import { edgesToSegments, meshBuffersToGeometry } from './geometry';
import { ContactShadow, Grid } from './ground';
import { PALETTES, type Palette } from './themes';
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

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

/** The contract `Viewport` plus a few extras for hosts and tests. */
export interface ViewportEngine extends Viewport {
  readonly canvas: HTMLCanvasElement;
  getCameraState(): CameraState;
  setReducedMotion(reduced: boolean): void;
  /** Number of frames rendered so far (lets tests assert render-on-demand). */
  getRenderCount(): number;
}

interface BodyEntry {
  group: Group;
  mesh: Mesh;
  lines: LineSegments2 | null;
  material: MeshStandardNodeMaterial;
  triangles: number;
  bounds: Bounds;
  display: Required<BodyDisplay>;
}

const DEFAULT_DISPLAY: Required<BodyDisplay> = {
  color: DEFAULT_BODY_COLOR_KEY,
  visible: true,
  opacity: 1,
};

export const createViewport = (async (canvas, options = {}) =>
  ViewportImpl.create(canvas, options)) satisfies CreateViewport as (
  canvas: HTMLCanvasElement,
  options?: ViewportOptions,
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
  private reducedMotion: boolean;
  private maxPixelRatio: number;
  private sceneBounds: Bounds = EMPTY_BOUNDS;
  private sceneRadius = boundsRadius(EMPTY_BOUNDS);

  private raf = 0;
  private dirty = true;
  private disposed = false;
  private lastFrameTime = 0;
  private frameTimes: number[] = [];
  private lastDrawCalls = 0;
  private renderCount = 0;
  private waiters: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private cleanup: Array<() => void> = [];

  static async create(canvas: HTMLCanvasElement, options: ViewportOptions): Promise<ViewportImpl> {
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
    options: ViewportOptions,
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl2';
    this.theme = options.theme ?? 'light';
    this.palette = PALETTES[this.theme];
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
    this.scene.add(this.grid.mesh, this.shadow.mesh);

    // Z-up CAD convention. Must be set before camera-controls captures the up vector.
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -110, 70);
    this.controls = new CameraControls(this.camera, canvas);
    this.configureControls();
    this.applyPalette();
    this.updateSceneBounds();
    this.fitAll(false);
    this.attachInput();
    this.resize();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.requestRender();
  }

  // ---------------------------------------------------------------- public API

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
    if (previous) this.disposeBody(previous);

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
    const body = new Mesh(geometry, material);
    body.frustumCulled = false;
    const group = new Group();
    group.add(body);

    let lines: LineSegments2 | null = null;
    const segments = edgesToSegments(mesh.edgePositions, mesh.edgeRanges);
    if (segments.length > 0) {
      const lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(segments);
      lines = new LineSegments2(lineGeometry, this.edgeMaterial);
      lines.frustumCulled = false;
      group.add(lines);
    }
    this.scene.add(group);

    const entry: BodyEntry = {
      group,
      mesh: body,
      lines,
      material,
      triangles: mesh.indices.length / 3,
      bounds: { min: [...mesh.bbox.min], max: [...mesh.bbox.max] },
      display: merged,
    };
    this.bodies.set(id, entry);
    this.applyDisplay(entry);
    this.updateSceneBounds();
    if (wasEmpty) this.fitAll(false);
    this.requestRender();
  }

  removeBody(id: string): void {
    const entry = this.bodies.get(id);
    if (!entry) return;
    this.disposeBody(entry);
    this.bodies.delete(id);
    this.updateSceneBounds();
    this.requestRender();
  }

  setDisplay(id: string, display: BodyDisplay): void {
    const entry = this.bodies.get(id);
    if (!entry) return;
    entry.display = { ...entry.display, ...stripUndefined(display) };
    this.applyDisplay(entry);
    this.updateSceneBounds();
    this.requestRender();
  }

  fitAll(animate = true): void {
    this.fitTo(this.currentDirection(), animate);
  }

  setView(view: StandardView, animate = true): void {
    this.fitTo(VIEW_DIRECTIONS[view], animate);
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    this.palette = PALETTES[theme];
    this.applyPalette();
    for (const e of this.bodies.values()) {
      e.material.color.set(this.resolveBodyColor(e.display.color));
    }
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

  getCameraState(): CameraState {
    const p = this.controls.getPosition(new Vector3());
    const t = this.controls.getTarget(new Vector3());
    return {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      distance: p.distanceTo(t),
    };
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
    for (const e of this.bodies.values()) this.disposeBody(e);
    this.bodies.clear();
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

  // ---------------------------------------------------------------- internals

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
    this.controls.addEventListener('wake', wake);
    this.controls.addEventListener('controlstart', wake);
    this.controls.addEventListener('update', wake);
    this.cleanup.push(() => {
      this.controls.removeEventListener('wake', wake);
      this.controls.removeEventListener('controlstart', wake);
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
    this.edgeMaterial.color.set(p.edge);
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
    e.material.color.set(this.resolveBodyColor(e.display.color));
    const translucent = e.display.opacity < 1;
    e.material.transparent = translucent;
    e.material.opacity = e.display.opacity;
    e.material.depthWrite = !translucent;
    e.material.needsUpdate = true;
  }

  private disposeBody(e: BodyEntry): void {
    this.scene.remove(e.group);
    e.mesh.geometry.dispose();
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
    if (moving) {
      this.schedule();
    } else {
      // Idle: stop the loop; the next frame's dt must not include the idle gap.
      this.lastFrameTime = 0;
    }
  }

  private renderOnce(): void {
    const { near, far } = clipPlanes(this.controls.distance, this.sceneRadius);
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const dt = performance.now() - t0;
    this.renderCount++;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.lastDrawCalls = this.renderer.info.render.drawCalls;
  }
}

function stripUndefined(d: BodyDisplay): BodyDisplay {
  const out: BodyDisplay = {};
  if (d.color !== undefined) out.color = d.color;
  if (d.visible !== undefined) out.visible = d.visible;
  if (d.opacity !== undefined) out.opacity = d.opacity;
  return out;
}
