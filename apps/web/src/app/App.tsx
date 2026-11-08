import type { KernelStatus, MeshBuffers, Viewport } from '@whittle/contracts';
import { AppShell, useTheme } from '@whittle/ui';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getDiagnostics } from '../platform/diagnostics';
import { getRuntimeState, subscribeRuntimeState } from '../platform/runtime-state';
import { applySwUpdate, checkForSwUpdateNow, onSwUpdateAvailable } from '../platform/sw-register';
import { DEMO_BOX } from './demo';
import { bootKernel } from './kernel-boot';
import { failBoot, mark } from './timing';
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
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => onSwUpdateAvailable(() => setUpdateReady(true)), []);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const commands = useMemo(
    () => [
      {
        id: 'check-updates',
        label: 'Check for updates',
        run: () => {
          setUpdateNote('Checking for updates…');
          void checkForSwUpdateNow().then((r) => {
            if (r === 'update') {
              setUpdateNote(null);
              setUpdateReady(true);
            } else {
              setUpdateNote(
                r === 'current'
                  ? `You're up to date (${diagnostics.appVersion}).`
                  : "Couldn't check for updates (offline?).",
              );
            }
            window.setTimeout(() => setUpdateNote(null), 4000);
          });
        },
      },
      { id: 'about', label: `About Whittle · ${diagnostics.appVersion}`, hint: 'Version' },
    ],
    [diagnostics.appVersion],
  );

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
        failBoot(`kernel: ${err instanceof Error ? err.message : String(err)}`);
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

  const [viewportError, setViewportError] = useState<string | null>(null);
  const onViewportError = useCallback((message: string) => {
    failBoot(`viewport: ${message}`);
    setViewportError(message);
  }, []);

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
        commands={commands}
        theme={theme.setting}
        onThemeChange={theme.setSetting}
        viewport={
          <>
            <ViewportHost
              theme={theme.resolved}
              onReady={onViewportReady}
              onError={onViewportError}
            />
            {viewportError && (
              <div
                role="alert"
                data-testid="viewport-error"
                className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm"
              >
                {viewportError} Your browser may have WebGL disabled.
              </div>
            )}
          </>
        }
      />
      {updateReady && (
        <button
          type="button"
          data-testid="update-available"
          onClick={applySwUpdate}
          className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-lg"
        >
          Update available · Reload
        </button>
      )}
      {updateNote && (
        <output
          data-testid="update-note"
          className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--color-surface)] px-4 py-2 text-sm shadow-lg"
        >
          {updateNote}
        </output>
      )}
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
