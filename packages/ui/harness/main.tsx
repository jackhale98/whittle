import '../src/styles/index.css';
import type { DeviceTier, KernelStatus, RuntimeDiagnostics } from '@wren-cad/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, StatusChip, type ThemeSetting } from '../src';
import { DataShell } from './dataShell';
import { Gallery } from './gallery';

/**
 * Query params:
 *   ?shell=desktop|tablet|phone   (default desktop)
 *   &theme=light|dark|system      (default light)
 *   &status=idle|downloading|downloading-unknown|compiling|ready|error  (default ready)
 *   ?view=chips                   renders every KernelStatus chip (gallery)
 */
const q = new URLSearchParams(location.search);

const statuses: Record<string, KernelStatus> = {
  idle: { state: 'idle' },
  downloading: { state: 'downloading', loaded: 14_680_064, total: 36_700_160 },
  'downloading-unknown': { state: 'downloading', loaded: 9_437_184 },
  compiling: { state: 'compiling' },
  ready: {
    state: 'ready',
    info: { variant: 'threaded', occtVersion: '8.0.1', buildId: 'harness', initMs: 812 },
  },
  error: {
    state: 'error',
    error: {
      code: 'INTERNAL',
      message: 'Could not load the geometry kernel.',
      hint: 'Check your connection and reload.',
    },
  },
};

const diagnostics = (tier: DeviceTier): RuntimeDiagnostics => ({
  tier,
  crossOriginIsolated: true,
  kernelVariant: 'threaded',
  renderBackend: 'webgpu',
  hardwareConcurrency: 8,
  primaryPointer: tier === 'desktop' ? 'fine' : 'coarse',
  serviceWorker: 'active',
  appVersion: '0.1.0+harness',
});

/** Stand-in viewport: a 100%x100% canvas painted like a studio floor with a simple box. */
function FakeViewport() {
  return (
    <canvas
      data-testid="fake-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
      ref={(c) => {
        if (!c) return;
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
        const g = c.getContext('2d');
        if (!g) return;
        g.scale(dpr, dpr);
        const cx = r.width / 2;
        const cy = r.height / 2 - 10;
        const s = Math.min(r.width, r.height) * 0.16;
        const face = (pts: Array<[number, number]>, fill: string) => {
          g.beginPath();
          for (const [i, [x, y]] of pts.entries()) {
            if (i) g.lineTo(cx + x * s, cy + y * s);
            else g.moveTo(cx + x * s, cy + y * s);
          }
          g.closePath();
          g.fillStyle = fill;
          g.fill();
          g.strokeStyle = 'rgba(15,23,42,0.55)';
          g.lineWidth = 1.2;
          g.stroke();
        };
        face(
          [
            [-1, -0.5],
            [0, -1],
            [1, -0.5],
            [0, 0],
          ],
          '#f4f6fa',
        );
        face(
          [
            [-1, -0.5],
            [0, 0],
            [0, 1.1],
            [-1, 0.6],
          ],
          '#c3cad6',
        );
        face(
          [
            [0, 0],
            [1, -0.5],
            [1, 0.6],
            [0, 1.1],
          ],
          '#9aa4b5',
        );
      }}
    />
  );
}

function Harness() {
  const tier = (q.get('shell') ?? 'desktop') as DeviceTier;
  const theme = (q.get('theme') ?? 'light') as ThemeSetting;
  const status = statuses[q.get('status') ?? 'ready'] ?? { state: 'idle' };

  if (q.get('view') === 'chips') {
    return (
      <div
        data-testid="chip-gallery"
        className="flex min-h-dvh flex-col items-start gap-3 bg-gradient-to-b from-viewport-top to-viewport-bottom p-6"
      >
        {Object.entries(statuses).map(([k, s]) => (
          <div key={k} className="flex items-center gap-4">
            <span className="w-44 text-xs text-fg-muted">{k}</span>
            <StatusChip status={s} />
            <StatusChip status={s} compact />
          </div>
        ))}
      </div>
    );
  }

  if (q.get('view') === 'gallery') {
    return <Gallery section={q.get('section') ?? 'tree'} tier={tier} theme={theme} />;
  }

  if (q.get('data')) {
    return (
      <DataShell
        tier={tier}
        theme={theme}
        status={status}
        viewport={<FakeViewport />}
        inspector={q.get('inspector') ?? 'feature'}
      />
    );
  }

  return (
    <AppShell
      tier={tier}
      theme={theme}
      documentName="Untitled bracket"
      kernelStatus={status}
      viewport={<FakeViewport />}
      diagnostics={diagnostics(tier)}
    />
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
