import { Box, Download, Ruler, Scissors, SlidersHorizontal } from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { Button, cn } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import { ExportPanel } from '../export/ExportMenu';
import { BottomSheet, EmptyState, Mark, ParamsPanel, ShellRoot, ViewportStage } from './shared';
import type { ShellProps } from './types';

type SheetTab = 'parts' | 'params' | 'measure' | 'section' | 'export';

const sheetTabs: Array<{
  id: SheetTab;
  label: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
}> = [
  {
    id: 'parts',
    label: 'Parts',
    Icon: Box,
    title: 'No parts yet',
    body: 'Parts in this document will be listed here. Tap one to focus it.',
  },
  {
    id: 'params',
    label: 'Params',
    Icon: SlidersHorizontal,
    title: 'No parameters',
    body: 'Named dimensions appear here so you can adjust them with a thumb.',
  },
  {
    id: 'measure',
    label: 'Measure',
    Icon: Ruler,
    title: 'Measure',
    body: 'Tap two points, edges or faces to read distances and angles.',
  },
  {
    id: 'section',
    label: 'Section',
    Icon: Scissors,
    title: 'Section view',
    body: 'Slice the model along a plane to look inside.',
  },
  {
    id: 'export',
    label: 'Export',
    Icon: Download,
    title: 'Export',
    body: 'Share STL, 3MF, GLB or STEP once your model is ready.',
  },
];

const PEEK = 24 + 64;

export function PhoneShell(props: ShellProps) {
  const { documentName, kernelStatus, viewport, onExport, paramsTable, onExportRequest } = props;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SheetTab>('parts');

  return (
    <ShellRoot tier="phone" props={props}>
      {() => (
        <ViewportStage
          viewport={viewport}
          className="h-full w-full"
          overlay={
            <>
              <header
                data-testid="top-bar"
                className="absolute top-[max(10px,var(--safe-top))] right-[max(10px,var(--safe-right))] left-[max(10px,var(--safe-left))] flex items-start justify-between gap-2"
              >
                <div className="w-panel pointer-events-auto flex h-10 min-w-0 items-center gap-2 rounded-full pr-4 pl-1.5">
                  <Mark className="size-7" />
                  <h1
                    className="truncate text-ui font-semibold tracking-tight"
                    data-testid="document-name"
                  >
                    {documentName}
                  </h1>
                </div>
                <StatusChip
                  status={kernelStatus}
                  compact
                  className="pointer-events-auto h-10 shrink-0"
                />
              </header>

              <BottomSheet
                open={open}
                onOpenChange={setOpen}
                peek={PEEK}
                height="min(52dvh, 420px)"
                handleLabel="Tools"
                testId="tools-sheet"
                header={
                  <fieldset className="m-0 grid min-w-0 shrink-0 grid-cols-5 gap-1 border-0 px-2 pt-0 pb-1">
                    <legend className="sr-only">Viewer tools</legend>
                    {sheetTabs.map(({ id, label, Icon }) => {
                      const on = tab === id && open;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            setTab(id);
                            setOpen(true);
                          }}
                          className={cn(
                            'flex h-16 flex-col items-center justify-center gap-1 rounded-control text-2xs font-medium transition-colors duration-150',
                            on
                              ? 'bg-accent-soft text-accent-text'
                              : 'text-fg-muted active:bg-surface-2',
                          )}
                        >
                          <Icon className="size-[22px]" strokeWidth={1.6} />
                          {label}
                        </button>
                      );
                    })}
                  </fieldset>
                }
              >
                <div className="px-2 pb-4" data-testid="sheet-content">
                  {tab === 'params' && paramsTable ? (
                    <ParamsPanel {...paramsTable} density="touch" />
                  ) : null}
                  {tab === 'export' && onExportRequest ? (
                    <div className="px-3 pt-1 pb-4">
                      <ExportPanel
                        onExport={onExportRequest}
                        bodies={props.exportBodies}
                        unavailable={props.exportUnavailable}
                        busy={props.exportBusy}
                        size="touch"
                      />
                    </div>
                  ) : null}
                  {sheetTabs.map(({ id, Icon, title, body }) =>
                    id === tab &&
                    !(id === 'params' && paramsTable) &&
                    !(id === 'export' && onExportRequest) ? (
                      <EmptyState key={id} icon={Icon} title={title}>
                        {body}
                        {id === 'export' ? (
                          <Button
                            variant="primary"
                            size="touch"
                            className="mt-4"
                            onClick={onExport}
                            icon={<Download className="size-[18px]" />}
                          >
                            Export model
                          </Button>
                        ) : null}
                      </EmptyState>
                    ) : null,
                  )}
                </div>
              </BottomSheet>
            </>
          }
        />
      )}
    </ShellRoot>
  );
}
