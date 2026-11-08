import type { RenderBackend, StandardView } from '@whittle/contracts';
import { boxMesh, denseMesh } from '@whittle/test-fixtures';
import type { ViewportEngine } from '../src/index';
import { createViewport } from '../src/index';

export interface HarnessApi {
  viewport: ViewportEngine;
  backend: RenderBackend;
  /** Replace the scene with a dense sphere of ~n triangles (perf probe). */
  loadDense(triangles: number): void;
  loadBox(): void;
  setView(view: StandardView): void;
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

const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
document.documentElement.style.background = theme === 'dark' ? '#14171c' : '#eceff3';

async function main() {
  const viewport = await createViewport(canvas, { backend, theme, reducedMotion, maxPixelRatio });
  const loadBox = () => {
    viewport.removeBody('dense');
    viewport.setBody('box', boxMesh(40, 30, 20));
  };
  window.__viewport = {
    viewport,
    backend: viewport.backend,
    loadBox,
    loadDense(triangles) {
      viewport.removeBody('box');
      viewport.setBody('dense', denseMesh(triangles));
      viewport.fitAll(false);
    },
    setView: (v) => viewport.setView(v, false),
  };
  loadBox();
  await viewport.nextFrame();
  hud.textContent = `Whittle viewport · ${viewport.backend}`;
  document.title = `Whittle viewport harness (${viewport.backend})`;
}

main().catch((err) => {
  window.__viewportError = String(err?.stack ?? err);
  hud.textContent = `error: ${window.__viewportError}`;
  console.error(err);
});
