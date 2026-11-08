/**
 * Viewport engine API (PLAN §4, §9). Lead-owned.
 *
 * The viewport is imperative three.js, created once per canvas and driven by the app; React only
 * renders chrome around it. Meshes arrive as `MeshBuffers` transferred from the kernel worker.
 */

import type { Vec2, Vec3 } from './document';
import type { MeshBuffers } from './kernel';
import type { SketchResult } from './modeling';
import type { DofState } from './sketch';

export type RenderBackend = 'webgpu' | 'webgl2';

export interface ViewportOptions {
  /** Force a backend (CI forces `webgl2` for deterministic screenshots). Default: try WebGPU. */
  backend?: RenderBackend | 'auto';
  /** Device pixel ratio cap (tablets/phones cap lower). */
  maxPixelRatio?: number;
  /** Light/dark theme drives background and edge colours. */
  theme?: 'light' | 'dark';
  /** Honour prefers-reduced-motion: disable camera animation/damping when true. */
  reducedMotion?: boolean;
  /** Show the view cube (top-right). Default true. */
  viewCube?: boolean;
}

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export interface ViewportStats {
  backend: RenderBackend;
  /** Rolling average CPU frame time, ms. */
  frameMs: number;
  triangles: number;
  drawCalls: number;
}

export interface BodyDisplay {
  /** CSS hex colour. */
  color?: string;
  visible?: boolean;
  /** 0–1. */
  opacity?: number;
}

// ---- M1: picking, selection, sketch overlays -----------------------------------------------

export type PickKind = 'face' | 'edge' | 'vertex' | 'sketchCurve' | 'sketchPoint' | 'region';

/** What is under a screen point. `index` is the ordinal in the body's MeshBuffers face/edge ranges. */
export interface PickHit {
  bodyId: string;
  kind: PickKind;
  /** Face/edge ordinal (MeshBuffers), vertex ordinal, or region ordinal for sketches. */
  index: number;
  /** Sketch entity id for sketch picks. */
  entity?: string;
  /** World point (mm) and surface normal at the hit. */
  point: Vec3;
  normal?: Vec3;
  /** Screen distance in CSS px from the query point (edges/vertices are picked within a tolerance). */
  distancePx: number;
}

export interface PickOptions {
  kinds?: PickKind[];
  /** Pick radius in CSS px for edges/vertices/sketch curves. Touch ≈ 22, pen ≈ 10, mouse ≈ 6. */
  tolerancePx?: number;
  /** Return all candidates within tolerance sorted by distance (for the "Which one?" chooser). */
  all?: boolean;
}

export interface HighlightItem {
  bodyId: string;
  kind: PickKind;
  index: number;
  entity?: string;
}

export interface SketchOverlay {
  sketch: SketchResult;
  /** DOF colouring per entity (PLAN §9.5). */
  dof?: Record<string, DofState>;
  /** Entities to draw as conflicting (red). */
  conflicting?: string[];
  /** True while editing this sketch: camera looks at the plane, other geometry dims. */
  active?: boolean;
}

export interface Viewport {
  readonly backend: RenderBackend;
  /** Add or replace a body's render buffers. `id` is an app-level body id (e.g. part id). */
  setBody(id: string, mesh: MeshBuffers, display?: BodyDisplay): void;
  removeBody(id: string): void;
  setDisplay(id: string, display: BodyDisplay): void;
  /** Frame all visible geometry. `animate` is ignored when reducedMotion is on. */
  fitAll(animate?: boolean): void;
  setView(view: StandardView, animate?: boolean): void;
  setTheme(theme: 'light' | 'dark'): void;
  /** Must be called when the canvas' CSS size changes (the engine also observes it). */
  resize(): void;
  /** Resolves after the next frame has been presented (used by tests and perf probes). */
  nextFrame(): Promise<void>;
  stats(): ViewportStats;
  dispose(): void;
}

export type CreateViewport = (
  canvas: HTMLCanvasElement,
  options?: ViewportOptions,
) => Promise<Viewport>;

/**
 * M1 surface (picking, selection, sketch overlays). Implemented by packages/viewport in M1;
 * `createViewport` will return this type once it lands, then this folds into `Viewport`.
 */
/**
 * Screen coordinates in this API are canvas-relative CSS pixels. For sketch picks/highlights,
 * `bodyId` is the sketch feature id and `entity` the sketch entity id or region name.
 */
export interface InteractiveViewport extends Viewport {
  /** Resolves once the face ID buffer is current (tests; picking is always correct regardless). */
  whenPickReady(): Promise<void>;
  /** Looks along `dir` (from the camera toward the target), animated unless reduced motion. */
  setViewDirection(dir: Vec3, animate?: boolean): void;
  /** Rendering context lost/restored (WebGL context or WebGPU device). The app decides to recreate. */
  on(event: 'contextlost' | 'contextrestored', listener: () => void): () => void;
  /** Synchronous CPU/GPU pick (ID buffer + BVH). Returns null/[] when nothing is within tolerance. */
  pick(x: number, y: number, options?: PickOptions): PickHit[];
  /** Selected (accent) and preselected (hover/press) highlights; replaces previous sets. */
  setHighlights(highlights: { selected: HighlightItem[]; preselected: HighlightItem[] }): void;
  /** Adds/replaces a sketch overlay by feature id; `null` removes it. */
  setSketch(featureId: string, overlay: SketchOverlay | null): void;
  /** Last-good geometry shown translucent while a feature is in error (PLAN §9.2); `null` clears. */
  setGhost(bodyId: string, mesh: MeshBuffers | null): void;
  /** Unprojects a screen point onto a plane (sketching); null if parallel to the view ray. */
  screenToPlane(
    x: number,
    y: number,
    plane: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 },
  ): Vec2 | null;
  /** Projects a world point to CSS px (HTML overlays: dimension labels, context bubble). */
  worldToScreen(point: Vec3): { x: number; y: number; visible: boolean };
  /** Aligns the camera normal to a plane (enter sketch) with an animated transition. */
  lookAtPlane(plane: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }, animate?: boolean): void;
}
