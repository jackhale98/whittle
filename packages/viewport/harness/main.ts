import type {
  CompareOverlay,
  HighlightItem,
  MeshBuffers,
  PickHit,
  RenderBackend,
  StandardView,
} from '@wren-cad/contracts';
import { boxMesh, denseMesh, sketchFixture } from '@wren-cad/test-fixtures';
import type { ViewportEngine } from '../src/index';
import { createViewport, defaultTolerance } from '../src/index';
import { sharedOverlayMaterialCount } from '../src/overlays';

export interface HarnessApi {
  viewport: ViewportEngine;
  backend: RenderBackend;
  /** Replace the scene with a dense sphere of ~n triangles (perf probe). */
  loadDense(triangles: number): void;
  loadBox(): void;
  /** Add (or replace) another box body, e.g. to test several bodies at once. */
  addBox(id: string, size: [number, number, number], origin: [number, number, number]): void;
  /** Replace the box body with another size (same buffer sizes: the cheap refill path). */
  resizeBox(dx: number, dy: number, dz: number): number;
  /** Replace the box body with a sphere mesh (different buffer sizes: geometry swap). */
  replaceWithSphere(triangles: number): number;
  setView(view: StandardView): void;
  /** Show the synthetic rectangle + circle sketch on top of the box (id `F02`). */
  showSketch(active?: boolean): void;
  hideSketch(): void;
  /** The synthetic sketch at height `z` (id `F02`): the top face of the box is at z = 20. */
  showSketchAt(z: number): void;
  /** Translucent mesh preview: a box at `origin` (kind 'mesh'); `null` removes it. */
  previewBox(id: string, origin: [number, number, number] | null): void;
  /** The synthetic sketch plus `SketchResult.points` entries (id `F03`, z = 20). */
  showSketchPoints(points: Array<{ entity: string; at: [number, number, number] }>): void;
  /**
   * Compare fixture on the 40x30x20 box: an added 15x30x8 block on its +X side (x 40-55) and a
   * removed 12x12 through-hole (x 14-26, y 9-21, full height). `fresh` builds new arrays (forces a
   * geometry rebuild); otherwise the same arrays are reused (only show/ghost change).
   */
  setCompare(opts?: { show?: 'both' | 'added' | 'removed'; ghost?: number; fresh?: boolean }): void;
  clearCompare(): void;
  /** Number of distinct shared overlay materials (re-setting must not grow it). */
  sharedMaterialCount(): number;
  /** Last hover pick result (what the harness is highlighting). */
  lastHover: PickHit[];
}

declare global {
  interface Window {
    __viewport?: HarnessApi;
    __viewportError?: string;
  }
}

const params = new URLSearchParams(location.search);
const backendParam = params.get('backend');
const backend = backendParam === 'webgl2' || backendParam === 'webgpu' ? backendParam : 'auto';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const reducedParam = params.get('reducedMotion');
/** Absent = follow the system `prefers-reduced-motion` (the engine default). */
const reducedMotion = reducedParam === null ? undefined : reducedParam === '1';
const precompile = params.get('warm') !== '0';
const maxPixelRatio = Number(params.get('maxDpr') ?? '2');
const hover = params.get('hover') !== '0';
const empty = params.get('empty') === '1';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
document.documentElement.style.background = theme === 'dark' ? '#14171c' : '#eceff3';

const toItem = (h: PickHit): HighlightItem => ({
  bodyId: h.bodyId,
  kind: h.kind,
  index: h.index,
  ...(h.entity ? { entity: h.entity } : {}),
});

async function main() {
  const viewport = await createViewport(canvas, {
    backend,
    theme,
    maxPixelRatio,
    precompile,
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
  });
  const loadBox = () => {
    viewport.removeBody('dense');
    viewport.setBody('box', boxMesh(40, 30, 20));
  };
  const api: HarnessApi = {
    viewport,
    backend: viewport.backend,
    loadBox,
    addBox(id, size, origin) {
      viewport.setBody(id, boxMesh(size[0], size[1], size[2], { origin }));
    },
    loadDense(triangles) {
      viewport.removeBody('box');
      viewport.setBody('dense', denseMesh(triangles));
      viewport.fitAll(false);
    },
    setView: (v) => viewport.setView(v, false),
    resizeBox(dx, dy, dz) {
      const t = performance.now();
      viewport.setBody('box', boxMesh(dx, dy, dz));
      return performance.now() - t;
    },
    replaceWithSphere(triangles) {
      const t = performance.now();
      viewport.setBody('box', denseMesh(triangles, 20));
      return performance.now() - t;
    },
    showSketch(active = false) {
      viewport.setSketch('F02', { sketch: sketchFixture(20, 'F02'), active, dof: DOF });
    },
    showSketchPoints(points) {
      const sketch = sketchFixture(20, 'F03');
      viewport.setSketch('F03', {
        sketch: { ...sketch, points: points.map((p) => ({ ...p, construction: false })) },
        active: false,
      });
    },
    previewBox(id, origin) {
      viewport.setPreview(
        id,
        origin ? { kind: 'mesh', mesh: boxMesh(12, 12, 12, { origin }) } : null,
      );
    },
    showSketchAt(z) {
      viewport.setSketch('F02', { sketch: sketchFixture(z, 'F02'), active: false, dof: DOF });
    },
    hideSketch() {
      viewport.setSketch('F02', null);
    },
    setCompare(opts = {}) {
      if (!compareFixture || opts.fresh) {
        compareFixture = {
          added: [boxMesh(15, 30, 8, { origin: [40, 0, 0] })],
          removed: [boxMesh(12, 12, 20, { origin: [14, 9, 0] })],
        };
      }
      const overlay: CompareOverlay = { ...compareFixture };
      if (opts.show) overlay.show = opts.show;
      if (opts.ghost !== undefined) overlay.ghostOpacity = opts.ghost;
      viewport.setCompare(overlay);
    },
    clearCompare() {
      viewport.setCompare(null);
    },
    sharedMaterialCount: sharedOverlayMaterialCount,
    lastHover: [],
  };
  let compareFixture: { added: MeshBuffers[]; removed: MeshBuffers[] } | null = null;
  window.__viewport = api;
  if (!empty) loadBox();

  // Hover = preselection; click = selection (demo of the app's wiring).
  let selected: HighlightItem[] = [];
  let pre: HighlightItem[] = [];
  let pending: { x: number; y: number; type: string } | null = null;
  const apply = () => viewport.setHighlights({ selected, preselected: pre });
  const hitAt = (x: number, y: number, type: string) => {
    const t = type === 'touch' || type === 'pen' || type === 'mouse' ? type : 'mouse';
    return viewport.pick(x, y, { tolerancePx: defaultTolerance(t) });
  };
  if (hover) {
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0) return;
      const first = pending === null;
      pending = { x: e.offsetX, y: e.offsetY, type: e.pointerType };
      if (!first) return;
      requestAnimationFrame(() => {
        const p = pending;
        pending = null;
        if (!p) return;
        const hits = hitAt(p.x, p.y, p.type);
        api.lastHover = hits;
        pre = hits.map(toItem);
        apply();
        hud.textContent = hits[0]
          ? `${hits[0].kind} #${hits[0].index}${hits[0].entity ? ` (${hits[0].entity})` : ''}`
          : viewport.backend;
      });
    });
    canvas.addEventListener('pointerleave', () => {
      pre = [];
      apply();
    });
  }
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.offsetX, y: e.offsetY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 6) return;
    const hits = hitAt(e.offsetX, e.offsetY, e.pointerType);
    selected = hits.map(toItem);
    apply();
  });

  await viewport.nextFrame();
  hud.textContent = `Wren viewport · ${viewport.backend}`;
  document.title = `Wren viewport harness (${viewport.backend})`;
}

const DOF = {
  l1: 'fixed',
  l2: 'fixed',
  l3: 'fixed',
  l4: 'fixed',
  c1: 'partial',
  k1: 'free',
  p1: 'free',
} as const;

main().catch((err) => {
  window.__viewportError = String(err?.stack ?? err);
  hud.textContent = `error: ${window.__viewportError}`;
  console.error(err);
});
