import type { Viewport } from '@whittle/contracts';
import { useEffect, useRef } from 'react';
import { reportRenderBackend } from '../platform/runtime-state';

export interface ViewportHostProps {
  theme: 'light' | 'dark';
  /** Called once the engine exists (lazy-loaded after the shell paints). */
  onReady(viewport: Viewport): void;
  /** The 3D view could not be created (no WebGPU and no WebGL2, context lost at start...). */
  onError(message: string): void;
}

function forcedBackend(): 'webgl2' | 'webgpu' | 'auto' {
  const v = new URLSearchParams(location.search).get('backend');
  return v === 'webgl2' || v === 'webgpu' ? v : 'auto';
}

/**
 * Owns the canvas and the imperative viewport engine. three.js (~240 KB gzip) is lazy-loaded so the
 * shell paints within the initial-route budget (PLAN §10); React never re-renders the canvas.
 */
export function ViewportHost({ theme, onReady, onError }: ViewportHostProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    void import('@whittle/viewport')
      .then(async ({ createViewport }) => {
        if (disposed) return;
        const viewport = await createViewport(canvas, {
          backend: forcedBackend(),
          theme: themeRef.current,
          reducedMotion,
        });
        if (disposed) {
          viewport.dispose();
          return;
        }
        viewportRef.current = viewport;
        // Test/perf probe handle (not an extension API).
        (window as unknown as { __whittleViewport?: Viewport }).__whittleViewport = viewport;
        reportRenderBackend(viewport.backend);
        onReadyRef.current(viewport);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        const detail = err instanceof Error ? err.message : String(err);
        onErrorRef.current(`The 3D view could not start (${detail}).`);
      });
    return () => {
      disposed = true;
      viewportRef.current?.dispose();
      viewportRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewportRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="viewport-canvas"
      aria-label="3D viewport"
      style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
    />
  );
}
