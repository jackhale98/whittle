import type { DeviceTier } from '@wren-cad/contracts';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { DesktopShell } from './DesktopShell';
import type { ShellProps } from './types';

export type AppShellProps = ShellProps & { tier: DeviceTier };

// Only one shell is on screen at a time, so the touch shells load as their own chunks (ADR-089).
// The desktop shell stays in the initial route. `preloadShell` lets the app load the one it needs
// before the first render, so a phone or tablet never sees a fallback flash.
type ShellComponent = (props: ShellProps) => ReactNode;
const loaded: { tablet?: ShellComponent; phone?: ShellComponent } = {};
const loadTablet = () =>
  import('./TabletShell').then((m) => {
    loaded.tablet = m.TabletShell;
    return { default: m.TabletShell };
  });
const loadPhone = () =>
  import('./PhoneShell').then((m) => {
    loaded.phone = m.PhoneShell;
    return { default: m.PhoneShell };
  });
const LazyTablet = lazy(loadTablet);
const LazyPhone = lazy(loadPhone);

/** Starts loading the shell for `tier`; resolves when it is ready (immediately for desktop). */
export function preloadShell(tier: DeviceTier): Promise<unknown> {
  if (tier === 'tablet') return loadTablet();
  if (tier === 'phone') return loadPhone();
  return Promise.resolve();
}

/**
 * Hosts one touch shell. The component type is fixed when the host mounts: the loaded shell when
 * it was preloaded (renders synchronously, no fallback), else the lazy one. Switching from lazy to
 * loaded on a later render would change the element type and remount the shell, losing its state
 * (open sheet tab, section offset).
 */
function TouchShellHost({ props, kind }: { props: ShellProps; kind: 'tablet' | 'phone' }) {
  const [Shell] = useState<ShellComponent>(() =>
    kind === 'tablet' ? (loaded.tablet ?? LazyTablet) : (loaded.phone ?? LazyPhone),
  );
  return (
    <Suspense fallback={null}>
      <Shell {...props} />
    </Suspense>
  );
}

/** Picks the shell for a device tier (PLAN 8.4 / 9.1). Switching tiers remounts the chrome only. */
export function AppShell({ tier, ...props }: AppShellProps) {
  switch (tier) {
    case 'desktop':
      return <DesktopShell {...props} />;
    case 'tablet':
      return <TouchShellHost key="tablet" kind="tablet" props={props} />;
    case 'phone':
      return <TouchShellHost key="phone" kind="phone" props={props} />;
  }
}
