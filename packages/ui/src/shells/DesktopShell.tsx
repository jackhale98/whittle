import * as RTabs from '@radix-ui/react-tabs';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListTree,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Variable,
} from 'lucide-react';
import { m } from 'motion/react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { CommandBar } from '../components/CommandBar';
import { Button, cn, IconButton, Kbd, Separator, Tooltip } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import { reducedTransition, useSpring } from '../motion';
import {
  DiagnosticsList,
  EmptyState,
  ExportControl,
  Mark,
  ParamsPanel,
  ShellRoot,
  ThemeToggle,
  TreePanel,
  UndoRedo,
  UnitsChip,
  ViewportOverlays,
  ViewportStage,
} from './shared';
import type { ShellProps } from './types';

const LEFT_MIN = 240;
const LEFT_MAX = 420;
const LEFT_DEFAULT = 288;
const RIGHT_WIDTH = 296;
const GUTTER = 8;

const tabTrigger =
  'h-7 flex-1 rounded-[8px] px-3 text-xs font-medium tracking-[0.005em] text-fg-muted transition-colors duration-fast hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-[0_1px_2px_rgb(15_23_42/0.12)]';

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-4 pt-3.5 pb-2 text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">
      {children}
    </h2>
  );
}

export function DesktopShell(props: ShellProps) {
  const {
    documentName,
    kernelStatus,
    viewport,
    diagnostics,
    onUndo,
    onRedo,
    featureTree,
    paramsTable,
    inspector,
  } = props;
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState('features');
  const drag = useRef<{ x: number; w: number } | null>(null);
  const spring = useSpring('standard');
  const clamp = (w: number) => Math.min(LEFT_MAX, Math.max(LEFT_MIN, w));

  function onResizeDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: leftWidth };
    setDragging(true);
  }
  function onResizeMove(e: PointerEvent<HTMLDivElement>) {
    if (drag.current) setLeftWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  }
  function onResizeUp() {
    drag.current = null;
    setDragging(false);
  }
  function onResizeKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') setLeftWidth((w) => clamp(w - step));
    else if (e.key === 'ArrowRight') setLeftWidth((w) => clamp(w + step));
    else if (e.key === 'Home') setLeftWidth(LEFT_MIN);
    else if (e.key === 'End') setLeftWidth(LEFT_MAX);
    else return;
    e.preventDefault();
  }

  const leftT = dragging ? reducedTransition : spring;

  return (
    <ShellRoot tier="desktop" props={props} className="flex flex-col">
      {(core) => (
        <>
          <header
            className="flex h-12 shrink-0 items-center gap-1 px-3 pb-px"
            data-testid="top-bar"
          >
            <IconButton
              label="Feature panel"
              icon={<PanelLeft className="size-[18px]" />}
              pressed={leftOpen}
              onClick={() => setLeftOpen((o) => !o)}
            />
            <div className="mx-1.5 flex items-center gap-2.5">
              <Mark />
              <h1
                className="max-w-[28ch] truncate text-sm font-semibold tracking-tight"
                data-testid="document-name"
              >
                {documentName}
              </h1>
            </div>
            <Separator orientation="vertical" className="mx-1.5" />
            <UndoRedo onUndo={onUndo} onRedo={onRedo} />
            <div className="flex-1" />
            {props.projectBar ? (
              <div className="flex items-center gap-1.5" data-testid="project-bar">
                {props.projectBar}
              </div>
            ) : (
              <Tooltip content="Version history — coming in M2.5">
                <Button
                  variant="ghost"
                  aria-disabled="true"
                  onClick={(e) => e.preventDefault()}
                  icon={<GitBranch className="size-4" />}
                >
                  <span>main</span>
                  <ChevronDown className="-mr-1 size-3.5" />
                  <span className="sr-only">Version menu</span>
                </Button>
              </Tooltip>
            )}
            <ExportControl props={props} className="ml-1" />
            <Separator orientation="vertical" className="mx-1.5" />
            <ThemeToggle theme={core.theme} />
            <IconButton
              label="Inspector"
              icon={<PanelRight className="size-[18px]" />}
              pressed={rightOpen}
              onClick={() => setRightOpen((o) => !o)}
            />
          </header>

          <div className="flex min-h-0 flex-1 px-2 pb-2">
            {/* Left panel: feature tree + params */}
            <m.aside
              aria-label="Feature panel"
              data-testid="left-panel"
              initial={false}
              animate={{ width: leftOpen ? leftWidth + GUTTER : 0, opacity: leftOpen ? 1 : 0 }}
              transition={leftT}
              inert={!leftOpen}
              className="shrink-0 overflow-hidden"
            >
              <div className="flex h-full" style={{ width: leftWidth + GUTTER }}>
                <RTabs.Root
                  value={tab}
                  onValueChange={setTab}
                  className="w-card flex min-w-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="p-2.5 pb-1.5">
                    <RTabs.List
                      aria-label="Panel sections"
                      className="flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5"
                    >
                      <RTabs.Trigger value="features" className={tabTrigger}>
                        Features
                      </RTabs.Trigger>
                      <RTabs.Trigger value="params" className={tabTrigger}>
                        Params
                      </RTabs.Trigger>
                    </RTabs.List>
                  </div>
                  <RTabs.Content value="features" className="min-h-0 flex-1 overflow-y-auto">
                    {featureTree ? (
                      <TreePanel {...featureTree} />
                    ) : (
                      <EmptyState icon={ListTree} title="No features yet">
                        <p>Start with a sketch on a plane.</p>
                        <p className="mt-2 inline-flex items-center gap-1.5">
                          Press <Kbd>S</Kbd> to begin
                        </p>
                      </EmptyState>
                    )}
                  </RTabs.Content>
                  <RTabs.Content value="params" className="min-h-0 flex-1 overflow-y-auto">
                    {paramsTable ? (
                      <ParamsPanel {...paramsTable} />
                    ) : (
                      <EmptyState icon={Variable} title="No parameters">
                        <p>Name a dimension to reuse it. Values accept expressions like</p>
                        <p className="tnum mt-1.5 font-medium text-fg">25mm + 1/8in</p>
                      </EmptyState>
                    )}
                  </RTabs.Content>
                </RTabs.Root>
                {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a focusable resize handle */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize feature panel"
                  aria-valuemin={LEFT_MIN}
                  aria-valuemax={LEFT_MAX}
                  aria-valuenow={leftWidth}
                  tabIndex={0}
                  onPointerDown={onResizeDown}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeUp}
                  onPointerCancel={onResizeUp}
                  onKeyDown={onResizeKey}
                  className="group flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center"
                >
                  <span
                    className={cn(
                      'h-10 w-1 rounded-full transition-colors duration-fast group-hover:bg-border-strong/50',
                      dragging ? 'bg-accent' : 'bg-transparent',
                    )}
                  />
                </div>
              </div>
            </m.aside>

            {/* Centre: viewport */}
            <ViewportStage
              viewport={viewport}
              className="flex-1 rounded-panel shadow-[var(--shadow-card)]"
              overlay={
                <>
                  <div className="absolute top-3 left-3 flex items-center gap-2">
                    <UnitsChip />
                    <StatusChip status={kernelStatus} className="pointer-events-auto" />
                  </div>
                  <ViewportOverlays props={props} />
                  {/* Top-right is intentionally free: the view cube mounts there. */}
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
                    <CommandBar
                      onMore={core.openPalette}
                      enabledTools={props.enabledTools}
                      activeTool={props.activeTool}
                      onTool={props.onTool}
                    />
                  </div>
                </>
              }
            />

            {/* Right: context inspector */}
            <m.aside
              aria-label="Inspector"
              data-testid="right-panel"
              initial={false}
              animate={{ width: rightOpen ? RIGHT_WIDTH + GUTTER : 0, opacity: rightOpen ? 1 : 0 }}
              transition={spring}
              inert={!rightOpen}
              className="shrink-0 overflow-hidden"
            >
              <div className="flex h-full pl-2" style={{ width: RIGHT_WIDTH + GUTTER }}>
                <div className="w-card flex min-w-0 flex-1 flex-col overflow-hidden">
                  <SectionTitle>Inspector</SectionTitle>
                  {inspector ? (
                    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="inspector-slot">
                      {inspector}
                    </div>
                  ) : (
                    <EmptyState
                      icon={MousePointer2}
                      title="Nothing selected"
                      className="flex-1 pt-6"
                    >
                      Select a face, edge or feature to see its properties.
                    </EmptyState>
                  )}
                  {diagnostics ? (
                    // Collapsed by default so the inspector keeps its height at 1280×720.
                    <details
                      className="group shrink-0 border-t border-border"
                      data-testid="runtime-details"
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase select-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                        <ChevronRight
                          className="size-3.5 transition-transform duration-fast group-open:rotate-90"
                          aria-hidden
                        />
                        Runtime
                        <span className="ml-auto font-medium tracking-normal normal-case">
                          {diagnostics.kernelVariant ?? '—'} · {diagnostics.renderBackend ?? '—'}
                        </span>
                      </summary>
                      <div className="px-4 pb-3">
                        <DiagnosticsList d={diagnostics} />
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </m.aside>
          </div>
        </>
      )}
    </ShellRoot>
  );
}
