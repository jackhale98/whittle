import type { DeviceTier } from '@wren-cad/contracts';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { DesktopShell } from './DesktopShell';
import type { ShellProps } from './types';

export type AppShellProps = ShellProps & { tier: DeviceTier };

// Only one shell is on screen at a time, so the phone shell loads as its own chunk (ADR-089). The
// desktop shell, which the tablet shares at touch density (ADR-099), stays in the initial route.
// `preloadShell` lets the app load the one it needs before the first render, so a phone never sees
// a fallback flash.
type ShellComponent = (props: ShellProps) => ReactNode;
const loaded: { phone?: ShellComponent } = {};
const loadPhone = () =>
  import('./PhoneShell').then((m) => {
    loaded.phone = m.PhoneShell;
    return { default: m.PhoneShell };
  });
const LazyPhone = lazy(loadPhone);

/** Starts loading the shell for `tier`; resolves when it is ready (immediately for desktop). */
export function preloadShell(tier: DeviceTier): Promise<unknown> {
  if (tier === 'phone') return loadPhone();
  return Promise.resolve();
}

/**
 * Hosts the phone shell. The component type is fixed when the host mounts: the loaded shell when
 * it was preloaded (renders synchronously, no fallback), else the lazy one. Switching from lazy to
 * loaded on a later render would change the element type and remount the shell, losing its state
 * (open sheet tab, section offset).
 */
function PhoneShellHost({ props }: { props: ShellProps }) {
  const [Shell] = useState<ShellComponent>(() => loaded.phone ?? LazyPhone);
  return (
    <Suspense fallback={null}>
      <Shell {...props} />
    </Suspense>
  );
}

/**
 * Picks the shell for a device tier (PLAN 8.4 / 9.1): the desktop structure for desktop and tablet
 * (the tablet at touch density), the bottom-sheet shell for the phone. Switching tiers remounts the
 * chrome only.
 */
export function AppShell({ tier, ...props }: AppShellProps) {
  switch (tier) {
    case 'desktop':
    case 'tablet':
      return <DesktopShell key="desktop" tier={tier} {...props} />;
    case 'phone':
      return <PhoneShellHost key="phone" props={props} />;
  }
}
