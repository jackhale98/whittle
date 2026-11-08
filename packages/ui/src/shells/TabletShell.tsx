import { Download, History, Search } from 'lucide-react';
import { useState } from 'react';
import { CommandBar } from '../components/CommandBar';
import { Button, IconButton, Separator } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import {
  BottomSheet,
  EmptyState,
  Mark,
  modKey,
  ShellRoot,
  ThemeToggle,
  UndoRedo,
  UnitsChip,
  ViewportStage,
} from './shared';
import type { ShellProps } from './types';

const PEEK = 64;

export function TabletShell(props: ShellProps) {
  const { documentName, kernelStatus, viewport, onUndo, onRedo, onExport } = props;
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <ShellRoot tier="tablet" props={props}>
      {(core) => (
        <>
          <ViewportStage
            viewport={viewport}
            className="h-full w-full"
            overlay={
              <>
                {/* Top-left: document + history + actions. Top-right stays free for the view cube. */}
                <header
                  data-testid="top-bar"
                  className="w-panel pointer-events-auto absolute top-[max(12px,var(--safe-top))] left-[max(12px,var(--safe-left))] flex h-14 items-center gap-1 rounded-[18px] px-2"
                >
                  <div className="mr-1 flex items-center gap-2.5 pr-1 pl-1.5">
                    <Mark className="size-7" />
                    <h1
                      className="max-w-[22ch] truncate text-[15px] font-semibold tracking-tight"
                      data-testid="document-name"
                    >
                      {documentName}
                    </h1>
                  </div>
                  <Separator orientation="vertical" />
                  <UndoRedo size="touch" onUndo={onUndo} onRedo={onRedo} />
                  <Separator orientation="vertical" />
                  <IconButton
                    label="Search commands"
                    shortcut={`${modKey()}K`}
                    icon={<Search className="size-5" />}
                    size="touch"
                    onClick={core.openPalette}
                  />
                  <ThemeToggle theme={core.theme} size="touch" />
                  <Button
                    variant="primary"
                    size="touch"
                    icon={<Download className="size-[18px]" />}
                    onClick={onExport}
                    className="ml-1"
                  >
                    Export
                  </Button>
                </header>

                {/* Tool rail */}
                <div className="absolute top-[calc(max(12px,var(--safe-top))+72px)] left-[max(12px,var(--safe-left))]">
                  <CommandBar layout="rail" onMore={core.openPalette} />
                </div>

                {/* Chips, bottom-right, above the sheet peek */}
                <div className="absolute right-[max(12px,var(--safe-right))] bottom-[calc(var(--safe-bottom)+88px)] flex items-center gap-2">
                  <UnitsChip />
                  <StatusChip status={kernelStatus} className="pointer-events-auto" />
                </div>

                <BottomSheet
                  open={historyOpen}
                  onOpenChange={setHistoryOpen}
                  peek={PEEK}
                  height="min(42dvh, 380px)"
                  handleLabel="History"
                  testId="history-sheet"
                  className="left-1/2 w-[min(640px,calc(100%-24px))] -translate-x-1/2 right-auto"
                  header={
                    <div className="flex h-10 shrink-0 items-center gap-2 px-5 text-ui">
                      <History className="size-4 text-fg-muted" aria-hidden />
                      <span className="font-semibold">History</span>
                      <span className="text-fg-muted">· No features yet</span>
                    </div>
                  }
                >
                  <EmptyState icon={History} title="Your timeline will appear here">
                    Every feature you add is recorded, and you can roll back to any step.
                  </EmptyState>
                </BottomSheet>
              </>
            }
          />
        </>
      )}
    </ShellRoot>
  );
}
