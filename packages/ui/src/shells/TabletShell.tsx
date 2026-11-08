import { History, Search } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { Segmented } from '../components/controls';
import { IconButton, Separator } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import { ToolRail } from '../components/ToolRail';
import { FeatureTree } from '../features/FeatureTree';
import { BottomSheet } from './BottomSheet';
import {
  EmptyState,
  ExportControl,
  Mark,
  modKey,
  ParamsPanel,
  ShellRoot,
  ThemeToggle,
  UndoRedo,
  UnitsChip,
  useSheetSnap,
  useSheetTab,
  ViewportOverlays,
  ViewportStage,
} from './shared';
import type { ShellProps } from './types';

/** Handle (28) + header (40). */
const PEEK = 68;
const TABS = ['history', 'params', 'inspector'] as const;
/** The bottom-right chips' top edge above the stage bottom (84 + 32 px chip + 8 px gap). */
const CHIPS_TOP = 124;

/**
 * Tablet shell (PLAN 9.1, Shapr3D-class): a full-bleed viewport, a slim tool rail with four groups,
 * a floating title bar, a context bubble near the selection and a bottom sheet (peek / half /
 * full) for feature history, parameters and the inspector.
 */
export function TabletShell(props: ShellProps) {
  const {
    documentName,
    kernelStatus,
    viewport,
    onUndo,
    onRedo,
    featureTree,
    paramsTable,
    inspector,
  } = props;
  const [snap, setSnap] = useSheetSnap(props);
  const [sheetTab, setSheetTab] = useSheetTab(props, TABS, 'history');
  // What the sheet covers, for app overlays above it (`--chrome-bottom`).
  const [sheetPx, setSheetPx] = useState(PEEK);
  const hasData = !!(featureTree || paramsTable || inspector);
  const nFeatures = featureTree?.features.length ?? 0;

  return (
    <ShellRoot tier="tablet" props={props}>
      {(core) => (
        <ViewportStage
          viewport={viewport}
          // Space taken by the floating chrome (top bar, tool rail, sheet), for app panels in the
          // overlay: `--chrome-left` / `--chrome-top` clear the rail and the top bar,
          // `--chrome-bottom` is the sheet's visible height at rest, at least up to the chips.
          className="h-full w-full [--chrome-left:5.25rem] [--chrome-top:4.75rem]"
          style={{ '--chrome-bottom': `${Math.max(sheetPx, CHIPS_TOP)}px` } as CSSProperties}
          overlay={
            <>
              {/* Top-left: document + history + actions. Top-right stays free for the view cube. */}
              <header
                data-testid="top-bar"
                className="w-panel pointer-events-auto absolute top-[max(12px,var(--safe-top))] left-[max(12px,var(--safe-left))] flex h-14 items-center gap-1 rounded-panel px-2"
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
                <ExportControl props={props} variant="primary" size="touch" className="ml-1" />
              </header>

              {/* Tool rail: Sketch / Solid / Modify / Inspect */}
              <ToolRail
                className="absolute top-[calc(max(12px,var(--safe-top))+72px)] left-[max(12px,var(--safe-left))]"
                onMore={core.openPalette}
                enabledTools={props.enabledTools}
                activeTool={props.activeTool}
                onTool={props.onTool}
              />

              <ViewportOverlays props={props} />

              {/* Chips, bottom-right, above the sheet peek */}
              <div className="absolute right-[max(12px,var(--safe-right))] bottom-[calc(var(--safe-bottom)+84px)] flex items-center gap-2">
                <UnitsChip />
                <StatusChip status={kernelStatus} className="pointer-events-auto" />
              </div>

              <BottomSheet
                snap={snap}
                onSnapChange={setSnap}
                peek={PEEK}
                halfMax={460}
                topGap={96}
                handleLabel="History"
                testId="history-sheet"
                onVisibleHeight={setSheetPx}
                className="left-1/2 w-[min(640px,calc(100%-24px))] -translate-x-1/2 right-auto"
                header={
                  <div className="flex h-10 shrink-0 items-center gap-2 px-5 text-ui">
                    <History className="size-4 text-fg-muted" aria-hidden />
                    <span className="font-semibold">History</span>
                    <span className="tnum text-fg-muted">
                      ·{' '}
                      {nFeatures === 0
                        ? 'No features yet'
                        : `${nFeatures} ${nFeatures === 1 ? 'feature' : 'features'}`}
                    </span>
                  </div>
                }
              >
                {hasData ? (
                  <div className="flex flex-col">
                    <div className="px-4 pb-1">
                      <Segmented
                        label="Sheet section"
                        size="touch"
                        value={sheetTab}
                        onChange={setSheetTab}
                        options={[
                          { value: 'history', label: 'History' },
                          { value: 'params', label: 'Params', disabled: !paramsTable },
                          { value: 'inspector', label: 'Inspector', disabled: !inspector },
                        ]}
                      />
                    </div>
                    {sheetTab === 'history' && featureTree ? (
                      <FeatureTree {...featureTree} density="touch" />
                    ) : null}
                    {sheetTab === 'params' && paramsTable ? (
                      <ParamsPanel {...paramsTable} density="touch" />
                    ) : null}
                    {sheetTab === 'inspector' && inspector ? inspector : null}
                  </div>
                ) : (
                  <EmptyState icon={History} title="Your timeline will appear here">
                    Every feature you add is recorded, and you can roll back to any step.
                  </EmptyState>
                )}
              </BottomSheet>
            </>
          }
        />
      )}
    </ShellRoot>
  );
}
