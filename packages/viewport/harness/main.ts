import type { HighlightItem, PickHit, RenderBackend, StandardView } from '@whittle/contracts';
import { boxMesh, denseMesh, sketchFixture } from '@whittle/test-fixtures';
import type { ViewportEngine } from '../src/index';
import { createViewport, defaultTolerance } from '../src/index';

export interface HarnessApi {
  viewport: ViewportEngine;
  backend: RenderBackend;
  /** Replace the scene with a dense sphere of ~n triangles (perf probe). */
  loadDense(triangles: number): void;
  loadBox(): void;
  /** Replace the box body with another size (same buffer sizes: the cheap refill path). */
  resizeBox(dx: number, dy: number, dz: number): number;
  /** Replace the box body with a sphere mesh (different buffer sizes: geometry swap). */
  replaceWithSphere(triangles: number): number;
  setView(view: StandardView): void;
  /** Show the synthetic rectangle + circle sketch on top of the box (id `F02`). */
  showSketch(active?: boolean): void;
  hideSketch(): void;
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
const reducedMotion = params.get('reducedMotion') === '1';
const maxPixelRatio = Number(params.get('maxDpr') ?? '2');
const hover = params.get('hover') !== '0';

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
  const viewport = await createViewport(canvas, { backend, theme, reducedMotion, maxPixelRatio });
  const loadBox = () => {
    viewport.removeBody('dense');
    viewport.setBody('box', boxMesh(40, 30, 20));
  };
  const api: HarnessApi = {
    viewport,
    backend: viewport.backend,
    loadBox,
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
    hideSketch() {
      viewport.setSketch('F02', null);
    },
    lastHover: [],
  };
  window.__viewport = api;
  loadBox();

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
  hud.textContent = `Whittle viewport · ${viewport.backend}`;
  document.title = `Whittle viewport harness (${viewport.backend})`;
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
