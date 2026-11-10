/**
 * Top-bar version menu and sync status (PLAN §9.1, M2.5), on every tier. Main bundle: only
 * observable state; the versions and connections panel and `@wren-cad/sync` load on first use.
 */

import type { DeviceTier } from '@wren-cad/contracts';
import { Button, IconButton, SyncStatusChip } from '@wren-cad/ui';
import { GitBranch, Settings } from 'lucide-react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';

export function ProjectBar({ wb, tier }: { wb: Workbench; tier: DeviceTier }) {
  const bar = useObservable(wb.projectBar);
  const ui = useObservable(wb.ui);
  const touch = tier !== 'desktop';
  const phone = tier === 'phone';
  const open = ui.project !== null;
  const toggle = () => wb.openProjectPanel(open ? null : 'versions');
  return (
    <>
      {phone ? (
        <IconButton
          label="Versions"
          icon={<GitBranch className="size-[18px]" />}
          size="touch"
          pressed={open}
          onClick={toggle}
          data-testid="versions-button"
          className="w-panel rounded-full"
        />
      ) : (
        <Button
          variant="ghost"
          size={touch ? 'touch' : 'md'}
          icon={<GitBranch className="size-4" />}
          aria-pressed={open}
          aria-label="Versions"
          data-testid="versions-button"
          onClick={toggle}
        >
          <span className="max-w-[16ch] truncate">{bar.branch ?? 'Versions'}</span>
        </Button>
      )}
      {/* Phones reach Settings from the command palette (More); the bar has no room. */}
      {phone ? null : (
        <IconButton
          label="Settings"
          icon={<Settings className="size-[18px]" />}
          {...(touch ? { size: 'touch' as const } : {})}
          pressed={ui.settings !== null}
          onClick={() => (ui.settings ? wb.closeSettings() : wb.openSettings('navigation'))}
          data-testid="settings-button"
        />
      )}
      {/* The phone top bar is narrow: "local only" is the quiet default, so it isn't shown there. */}
      {phone && bar.status.state === 'local' ? null : (
        <SyncStatusChip
          status={bar.status}
          compact={phone}
          density={touch ? 'touch' : 'compact'}
          onResolve={() => void wb.syncController().then((c) => c.openSyncConflicts())}
          onSignIn={() => wb.openProjectPanel('connections')}
          onRetry={() => void wb.syncController().then((c) => c.syncNow())}
        />
      )}
    </>
  );
}
