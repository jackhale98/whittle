import type { KernelStatus, MeshBuffers, Viewport } from '@whittle/contracts';
import { AppShell, useTheme } from '@whittle/ui';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getDiagnostics } from '../platform/diagnostics';
import { getRuntimeState, subscribeRuntimeState } from '../platform/runtime-state';
import { DEMO_BOX } from './demo';
import { bootKernel } from './kernel-boot';
import { mark } from './timing';
import { ViewportHost } from './ViewportHost';

function isolationLabel(isolation: ReturnType<typeof getRuntimeState>['isolation']): string {
  if (isolation === 'pending') return 'checking isolation';
  return isolation === 'isolated'
    ? 'threaded kernel available'
    : 'fallback (single-threaded kernel)';
}

export function App() {
  const runtime = useSyncExternalStore(subscribeRuntimeState, getRuntimeState);
  const diagnostics = getDiagnostics();
  const theme = useTheme({});
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>({ state: 'idle' });

  const viewportRef = useRef<Viewport | null>(null);
  const meshRef = useRef<MeshBuffers | null>(null);

  const showBody = useCallback(() => {
    const viewport = viewportRef.current;
    const mesh = meshRef.current;
    if (!viewport || !mesh) return;
    viewport.setBody(DEMO_BOX.id, mesh);
    void viewport.nextFrame().then(() => mark('firstBodyMs'));
  }, []);

  useEffect(() => {
    mark('shellInteractiveMs');
    const boot = bootKernel(setKernelStatus);
    boot.firstMesh.then(
      (mesh) => {
        meshRef.current = mesh;
        showBody();
      },
      (err: unknown) => {
        if (err instanceof Error && err.message === 'disposed') return;
        setKernelStatus({
          state: 'error',
          error: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : 'The geometry kernel failed to start.',
          },
        });
      },
    );
    return () => boot.dispose();
  }, [showBody]);

  const onViewportReady = useCallback(
    (viewport: Viewport) => {
      viewportRef.current = viewport;
      showBody();
    },
    [showBody],
  );

  return (
    <>
      <AppShell
        tier={diagnostics.tier}
        documentName="Untitled part"
        kernelStatus={kernelStatus}
        diagnostics={{ ...diagnostics, ...runtimeOverrides(runtime) }}
        theme={theme.setting}
        onThemeChange={theme.setSetting}
        viewport={<ViewportHost theme={theme.resolved} onReady={onViewportReady} />}
      />
      <p data-testid="status-line" className="sr-only" aria-live="polite">
        crossOriginIsolated: {String(diagnostics.crossOriginIsolated)} · service worker:{' '}
        {runtime.serviceWorker} · {isolationLabel(runtime.isolation)}
      </p>
    </>
  );
}

function runtimeOverrides(runtime: ReturnType<typeof getRuntimeState>) {
  return {
    serviceWorker: runtime.serviceWorker,
    kernelVariant: runtime.kernelVariant,
    renderBackend: runtime.renderBackend,
  };
}
