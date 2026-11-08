import { useSyncExternalStore } from 'react';
import { getDiagnostics } from './platform/diagnostics';
import { getRuntimeState, subscribeRuntimeState } from './platform/runtime-state';

/**
 * Placeholder shell: proves the platform layer works. The lead replaces this component with the
 * real shell + viewport + kernel; the `data-testid="app-shell"` contract should be kept.
 */
export function PlaceholderShell() {
  const runtime = useSyncExternalStore(subscribeRuntimeState, getRuntimeState);
  const diagnostics = getDiagnostics();

  const mode =
    runtime.isolation === 'pending'
      ? 'checking isolation'
      : runtime.isolation === 'isolated'
        ? 'threaded kernel available'
        : 'fallback (single-threaded kernel)';

  return (
    <div data-testid="app-shell" className="flex h-full flex-col items-center justify-center gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">Whittle</h1>
      <p data-testid="status-line" className="font-mono text-sm opacity-70">
        crossOriginIsolated: {String(diagnostics.crossOriginIsolated)} · service worker:{' '}
        {runtime.serviceWorker} · {mode}
      </p>
      <p className="font-mono text-xs opacity-50">
        {diagnostics.appVersion} · {diagnostics.tier}
      </p>
    </div>
  );
}
