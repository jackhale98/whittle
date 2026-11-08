import type { DeviceTier } from '@whittle/contracts';
import { DesktopShell } from './DesktopShell';
import { PhoneShell } from './PhoneShell';
import { TabletShell } from './TabletShell';
import type { ShellProps } from './types';

export type AppShellProps = ShellProps & { tier: DeviceTier };

/** Picks the shell for a device tier (PLAN 8.4 / 9.1). Switching tiers remounts the chrome only. */
export function AppShell({ tier, ...props }: AppShellProps) {
  switch (tier) {
    case 'desktop':
      return <DesktopShell {...props} />;
    case 'tablet':
      return <TabletShell {...props} />;
    case 'phone':
      return <PhoneShell {...props} />;
  }
}
