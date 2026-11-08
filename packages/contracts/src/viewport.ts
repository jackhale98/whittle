/**
 * Viewport engine API (PLAN §4, §9). Lead-owned.
 *
 * The viewport is imperative three.js, created once per canvas and driven by the app; React only
 * renders chrome around it. Meshes arrive as `MeshBuffers` transferred from the kernel worker.
 */

import type { MeshBuffers } from './kernel';

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
