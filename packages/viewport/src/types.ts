import type { CompareViewport, Vec3, ViewportOptions } from '@wren-cad/contracts';
import type { PivotSource } from './navigation';
import type { Bounds } from './views';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

export interface ViewportEngineOptions extends ViewportOptions {
  /** Render the view cube in the canvas' top-right corner. Default true. */
  viewCube?: boolean;
  /** Warm the shader cache on an idle frame after creation. Default true. */
  precompile?: boolean;
}

export type ViewportEventMap = {
  /** The GPU context was lost; the app should show a message and may recreate the viewport. */
  contextlost: { reason: string };
  contextrestored: Record<string, never>;
};

/** Compare overlay diagnostics for tests (the `__viewport` probe). */
export interface CompareStats {
  /** An overlay is set (bodies are ghosted). */
  active: boolean;
  /** Which sides are currently drawn. */
  show: 'both' | 'added' | 'removed';
  addedMeshes: number;
  removedMeshes: number;
  /** Ghost opacity applied to live bodies; null when no overlay is set. */
  ghostOpacity: number | null;
  /** Geometry builds so far (a `show`/`ghostOpacity` change must not increase this). */
  geometryBuilds: number;
  /** Bounds of the visible overlay meshes, null when none. */
  bounds: Bounds | null;
}

export interface FitOptions {
  /** Also frame the visible compare overlay (default false: bodies only). */
  includeOverlay?: boolean;
}

export interface BodyMaterialState {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  color: string;
}

/** The contract `CompareViewport` plus a few extras for hosts and tests. */
export interface ViewportEngine extends CompareViewport {
  /** `fitAll` with an option to frame the compare overlay as well. */
  fitAll(animate?: boolean, options?: FitOptions): void;
  getCompareStats(): CompareStats;
  /** Live material state of a body (tests: ghosting is restored exactly on `setCompare(null)`). */
  getBodyMaterialState(id: string): BodyMaterialState | null;
  readonly canvas: HTMLCanvasElement;
  getCameraState(): CameraState;
  setReducedMotion(reduced: boolean): void;
  /** Number of frames rendered so far (lets tests assert render-on-demand). */
  getRenderCount(): number;
  /** True while the camera is transitioning, damping or under a pointer (tests wait on it). */
  isCameraMoving(): boolean;
  /** Current roll of the camera around its view axis relative to world +Z up, radians. */
  getRoll(): number;
  /** Preview/handle/section diagnostics for tests. */
  getTouchStats(): TouchStats;
  /** On-screen length (CSS px) of a handle arrow right now; null if unknown or behind the camera. */
  getHandleScreenLength(id: string): number | null;
  /** Animate to look along `dir` (unit vector from the target toward the camera). */
  setViewDirection(dir: Vec3, animate?: boolean): void;
  /**
   * Resolves once the face ID buffer matches the current camera/scene (face picks are then
   * served from the GPU buffer instead of the CPU fallback). Enables ID-buffer rendering.
   */
  whenPickReady(): Promise<void>;
  getPickStats(): PickStats;
  /** M3.5 diagnostics for tests: the orbit in progress and the pivot marker. */
  getNavigationState(): NavigationState;
  on<K extends keyof ViewportEventMap>(type: K, cb: (e: ViewportEventMap[K]) => void): () => void;
}

export interface TouchStats {
  /** Number of prism geometry builds (a distance-only update must not increase this). */
  prismBuilds: number;
  /** Frame index (render count) at which the last preview update was presented. */
  lastPreviewPresentedAt: number;
  warmMs: number;
  /** The studio environment (built on idle after the first frame) is in place. */
  environmentReady: boolean;
  handleHover: string | null;
  sectionActive: boolean;
}

export interface NavigationState {
  /** A mouse/touch/pen orbit or pan drag is past its threshold. */
  dragging: 'orbit' | 'pan' | null;
  /** World pivot of the drag in progress (or the last one); null before any drag. */
  pivot: Vec3 | null;
  /** How the pivot was chosen. */
  pivotSource: PivotSource | null;
  /** The pivot marker is shown right now. */
  markerVisible: boolean;
  /** Screen position (CSS px) of the pivot right now; null when there is none. */
  pivotScreen: { x: number; y: number } | null;
  /** Milliseconds the last orbit/pan start spent resolving its pivot (the pick under the cursor). */
  lastPivotMs: number;
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
