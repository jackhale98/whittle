import { Box, Download, ListTree, Ruler, Scissors, SlidersHorizontal } from 'lucide-react';
import { type ComponentType, type CSSProperties, lazy, Suspense, useState } from 'react';
import { Button, cn } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import { ExportPanel } from '../export/ExportMenu';
import { BottomSheet } from './BottomSheet';
import {
  EmptyState,
  Mark,
  ParamsPanel,
  ShellRoot,
  TreePanel,
  useSheetSnap,
  useSheetTab,
  ViewportOverlays,
  ViewportStage,
} from './shared';
import type { ShellProps } from './types';

// The viewer panels are fetched the first time their tab opens.
const PartsPanel = lazy(() =>
  import('../panels/PartsPanel').then((mod) => ({ default: mod.PartsPanel })),
);
const MeasurePanel = lazy(() =>
  import('../panels/MeasurePanel').then((mod) => ({ default: mod.MeasurePanel })),
);
const SectionPanel = lazy(() =>
  import('../panels/SectionPanel').then((mod) => ({ default: mod.SectionPanel })),
);

type SheetTab = 'parts' | 'history' | 'params' | 'measure' | 'section' | 'export';
const TABS: readonly SheetTab[] = ['parts', 'history', 'params', 'measure', 'section', 'export'];

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
    id: 'history',
    label: 'Features',
    Icon: ListTree,
    title: 'No features yet',
    body: 'The feature history appears here. Drag the line to roll the model back.',
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

/** Handle (28) + tab row (56). */
const PEEK = 28 + 56;

const loading = <p className="p-6 text-center text-ui text-fg-muted">Loading…</p>;

/**
 * Phone shell (PLAN 9.1, viewer first): the viewport fills the screen; a bottom sheet with Parts /
 * Params / Measure / Section / Export tabs slides over it. Editing is limited to parameters.
 */
export function PhoneShell(props: ShellProps) {
  const { documentName, kernelStatus, viewport, onExport, paramsTable, onExportRequest } = props;
  const [snap, setSnap] = useSheetSnap(props);
  const [tab, setTab] = useSheetTab(props, TABS, 'parts');
  // What the sheet covers, for app overlays above it (`--chrome-bottom`).
  const [sheetPx, setSheetPx] = useState(PEEK);
  const open = snap !== 'peek';

  return (
    <ShellRoot tier="phone" props={props}>
      {() => (
        <ViewportStage
          viewport={viewport}
          // App overlays: below the title pill, beside the left inset, above the sheet.
          className="h-full w-full [--chrome-left:max(10px,var(--safe-left))] [--chrome-top:calc(max(10px,var(--safe-top))+3.25rem)]"
          style={{ '--chrome-bottom': `${sheetPx}px` } as CSSProperties}
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
                <div className="flex shrink-0 items-start gap-2">
                  {props.configurationBar ? (
                    <div
                      className="pointer-events-auto flex shrink-0 items-center"
                      data-testid="configuration-bar"
                    >
                      {props.configurationBar}
                    </div>
                  ) : null}
                  {props.projectBar ? (
                    <div
                      className="pointer-events-auto flex items-center gap-1"
                      data-testid="project-bar"
                    >
                      {props.projectBar}
                    </div>
                  ) : null}
                  <StatusChip
                    status={kernelStatus}
                    compact
                    className="pointer-events-auto h-10 shrink-0"
                  />
                </div>
              </header>

              <ViewportOverlays props={props} />

              <BottomSheet
                snap={snap}
                onSnapChange={setSnap}
                peek={PEEK}
                halfMax={440}
                topGap={64}
                handleLabel="Tools"
                testId="tools-sheet"
                onVisibleHeight={setSheetPx}
                header={
                  <fieldset className="m-0 grid min-w-0 shrink-0 grid-cols-6 gap-1 border-0 px-2 pt-0 pb-1">
                    <legend className="sr-only">Viewer tools</legend>
                    {sheetTabs.map(({ id, label, Icon }) => {
                      const on = tab === id && open;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={on}
                          data-sheet-tab={id}
                          onClick={() => {
                            setTab(id);
                            if (!open) setSnap('half');
                          }}
                          className={cn(
                            'flex h-14 flex-col items-center justify-center gap-1 rounded-control text-2xs font-medium transition-colors duration-fast',
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
                  <Suspense fallback={loading}>
                    {tab === 'parts' && props.parts ? <PartsPanel {...props.parts} /> : null}
                    {tab === 'history' && props.featureTree && open ? (
                      <TreePanel {...props.featureTree} density="touch" />
                    ) : null}
                    {tab === 'measure' && props.measure ? (
                      <MeasurePanel {...props.measure} />
                    ) : null}
                    {tab === 'section' && props.section ? (
                      <SectionPanel {...props.section} />
                    ) : null}
                  </Suspense>
                  {tab === 'params' && paramsTable ? (
                    <ParamsPanel {...paramsTable} density="touch" />
                  ) : null}
                  {tab === 'export' && onExportRequest ? (
                    <div className="px-3 pt-1 pb-4">
                      <ExportPanel
                        onExport={onExportRequest}
                        bodies={props.exportBodies}
                        configurations={props.exportConfigurations}
                        unavailable={props.exportUnavailable}
                        notes={props.exportNotes}
                        onTargetChange={props.onExportTargetChange}
                        busy={props.exportBusy}
                        size="touch"
                      />
                    </div>
                  ) : null}
                  {sheetTabs.map(({ id, Icon, title, body }) =>
                    id === tab &&
                    !(id === 'parts' && props.parts) &&
                    !(id === 'history' && props.featureTree) &&
                    !(id === 'params' && paramsTable) &&
                    !(id === 'measure' && props.measure) &&
                    !(id === 'section' && props.section) &&
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
