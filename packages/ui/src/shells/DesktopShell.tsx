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
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { CommandBar } from '../components/CommandBar';
import { Button, cn, IconButton, Kbd, Separator, Tooltip } from '../components/primitives';
import { StatusChip } from '../components/StatusChip';
import { canDockBoth, LEFT_PANEL_WIDTH, PANEL_GUTTER, RIGHT_PANEL_WIDTH } from '../logic/dock';
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
const LEFT_DEFAULT = LEFT_PANEL_WIDTH;
const RIGHT_WIDTH = RIGHT_PANEL_WIDTH;
const GUTTER = PANEL_GUTTER;
/** An overlaid panel floats this far from the body edge, over the view (px). */
const OVERLAY_INSET = 8;

const tabTrigger = (touch: boolean) =>
  `${touch ? 'h-11' : 'h-7'} flex-1 rounded-[8px] px-3 text-xs font-medium tracking-[0.005em] text-fg-muted transition-colors duration-fast hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-[0_1px_2px_rgb(15_23_42/0.12)]`;

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-4 pt-3.5 pb-2 text-2xs font-semibold tracking-[0.08em] text-fg-muted uppercase">
      {children}
    </h2>
  );
}

export interface DesktopShellProps extends ShellProps {
  /**
   * `tablet` renders this same structure at touch density (ADR-099): 44 px targets, touch spacing,
   * no resize handle, and the side panels overlay the view when both would not fit beside it.
   */
  tier?: 'desktop' | 'tablet';
}

/** The width of the shell body, measured (the first render uses the window's). */
function useBodyWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(() => globalThis.innerWidth || 1280);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function DesktopShell(props: DesktopShellProps) {
  const {
    documentName,
    kernelStatus,
    viewport,
    diagnostics,
    kernelMemory,
    onUndo,
    onRedo,
    featureTree,
    paramsTable,
    inspector,
    onOverlayInsets,
  } = props;
  const tier = props.tier ?? 'desktop';
  const touch = tier === 'tablet';
  const size = touch ? 'touch' : 'md';
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = useBodyWidth(bodyRef);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  // Both panels beside the view only when the view keeps a usable width (ADR-099). Desktop always docks.
  const overlay = touch && !canDockBoth(bodyWidth, leftWidth);
  const [leftOpen, setLeftOpen] = useState(() => !touch || canDockBoth(bodyWidth));
  // The inspector is controlled when the app drives it (it opens while editing); local otherwise.
  const [rightLocal, setRightLocal] = useState(!touch);
  const rightOpen = props.inspectorOpen ?? rightLocal;
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState('features');
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const spring = useSpring('standard');
  const clamp = (w: number) => Math.min(LEFT_MAX, Math.max(LEFT_MIN, w));

  const { onInspectorOpenChange } = props;
  const setRight = useCallback(
    (open: boolean) => {
      setRightLocal(open);
      onInspectorOpenChange?.(open);
      if (open && overlay) setLeftOpen(false); // one overlay at a time
    },
    [onInspectorOpenChange, overlay],
  );
  const toggleLeft = () => {
    const next = !leftOpen;
    setLeftOpen(next);
    if (next && overlay && rightOpen) setRight(false);
  };
  // The app opened the inspector (a feature was added, a mode started): it takes over from the tree.
  const wasRight = useRef(rightOpen);
  useEffect(() => {
    if (rightOpen && !wasRight.current && overlay) setLeftOpen(false);
    wasRight.current = rightOpen;
  }, [rightOpen, overlay]);
  // Both open when the view turns narrow (rotation): keep the inspector, it is the one being edited.
  useEffect(() => {
    if (overlay && leftOpen && rightOpen) setLeftOpen(false);
  }, [overlay, leftOpen, rightOpen]);

  const closeOverlay = useCallback(
    (refocus?: boolean) => {
      const left = leftOpen;
      if (left) setLeftOpen(false);
      if (rightOpen) setRight(false);
      if (refocus)
        bodyRef.current?.ownerDocument
          .querySelector<HTMLElement>(
            left ? '[data-testid="left-toggle"]' : '[data-testid="right-toggle"]',
          )
          ?.focus();
    },
    [leftOpen, rightOpen, setRight],
  );

  // What the overlaid panels cover, read while they animate, so the camera follows them (ADR-086).
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const covered = useRef({ left: 0, right: 0 });
  const reportCovered = useCallback(() => {
    const body = bodyRef.current;
    let left = 0;
    let right = 0;
    if (body && overlay) {
      const b = body.getBoundingClientRect();
      const l = leftRef.current?.getBoundingClientRect();
      const r = rightRef.current?.getBoundingClientRect();
      // The card's visible edge, measured where the spring has it now, plus the gap to it.
      if (l && l.right - b.left > 0) left = Math.round(l.right - b.left + OVERLAY_INSET);
      if (r && b.right - r.left > 0) right = Math.round(b.right - r.left + OVERLAY_INSET);
    }
    const prev = covered.current;
    if (prev.left === left && prev.right === right) return;
    covered.current = { left, right };
    body?.style.setProperty('--cover-left', `${left}px`);
    body?.style.setProperty('--cover-right', `${right}px`);
    onOverlayInsets?.({ left, right });
  }, [overlay, onOverlayInsets]);
  // Docked or closed: nothing covered. The spring's frames report while it moves (`onUpdate`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the open state or the mode changes
  useLayoutEffect(() => {
    reportCovered();
  }, [reportCovered, leftOpen, rightOpen, overlay, leftWidth]);

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
  const panelOpen = overlay && (leftOpen || rightOpen);
  // Docked: the panel's width animates and the view resizes. Overlay: the panel slides over the
  // view, which does not resize (the camera trucks by the covered width instead).
  const leftAnimate = overlay
    ? { x: leftOpen ? 0 : -(leftWidth + GUTTER + OVERLAY_INSET * 2), opacity: leftOpen ? 1 : 0 }
    : { width: leftOpen ? leftWidth + GUTTER : 0, opacity: leftOpen ? 1 : 0 };
  const rightAnimate = overlay
    ? { x: rightOpen ? 0 : RIGHT_WIDTH + GUTTER + OVERLAY_INSET * 2, opacity: rightOpen ? 1 : 0 }
    : { width: rightOpen ? RIGHT_WIDTH + GUTTER : 0, opacity: rightOpen ? 1 : 0 };
  const leftStyle: CSSProperties | undefined = overlay
    ? { width: leftWidth + GUTTER, left: OVERLAY_INSET * 2 }
    : undefined;
  const rightStyle: CSSProperties | undefined = overlay
    ? { width: RIGHT_WIDTH + GUTTER, right: OVERLAY_INSET * 2 }
    : undefined;
  const overlayCls = 'absolute top-0 bottom-2 z-[var(--z-panel)] rounded-panel shadow-float';

  return (
    <ShellRoot tier={tier} props={props} className="flex flex-col">
      {(core) => (
        <>
          <header
            className={cn('flex shrink-0 items-center gap-1 px-3 pb-px', touch ? 'h-14' : 'h-12')}
            data-testid="top-bar"
          >
            <IconButton
              label="Feature panel"
              icon={<PanelLeft className="size-[18px]" />}
              pressed={leftOpen}
              size={size}
              data-testid="left-toggle"
              onClick={toggleLeft}
            />
            <div className="mx-1.5 flex items-center gap-2.5">
              <Mark className={touch ? 'size-7' : undefined} />
              <h1
                className="max-w-[28ch] truncate text-sm font-semibold tracking-tight"
                data-testid="document-name"
              >
                {documentName}
              </h1>
            </div>
            <Separator orientation="vertical" className="mx-1.5" />
            <UndoRedo size={size} onUndo={onUndo} onRedo={onRedo} />
            <div className="flex-1" />
            {props.configurationBar ? (
              <div className="mr-1 flex items-center" data-testid="configuration-bar">
                {props.configurationBar}
              </div>
            ) : null}
            {props.projectBar ? (
              <div className="flex items-center gap-1.5" data-testid="project-bar">
                {props.projectBar}
              </div>
            ) : (
              <Tooltip content="Version history — coming in M2.5">
                <Button
                  variant="ghost"
                  size={size}
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
            <ExportControl props={props} size={size} className="ml-1" />
            <Separator orientation="vertical" className="mx-1.5" />
            <ThemeToggle theme={core.theme} size={size} />
            <IconButton
              label="Inspector"
              icon={<PanelRight className="size-[18px]" />}
              pressed={rightOpen}
              size={size}
              data-testid="right-toggle"
              onClick={() => setRight(!rightOpen)}
            />
          </header>

          {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape closes an overlaid panel from anywhere inside it */}
          <div
            ref={bodyRef}
            data-testid="shell-body"
            data-panels={overlay ? 'overlay' : 'docked'}
            className="relative flex min-h-0 flex-1 px-2 pb-2"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && panelOpen) {
                e.stopPropagation();
                closeOverlay(true);
              }
            }}
          >
            {/* Left panel: feature tree + params */}
            <m.aside
              ref={leftRef}
              aria-label="Feature panel"
              data-testid="left-panel"
              data-overlay={overlay || undefined}
              initial={false}
              animate={leftAnimate}
              transition={leftT}
              onUpdate={reportCovered}
              inert={!leftOpen}
              style={leftStyle}
              className={cn('overflow-hidden', overlay ? overlayCls : 'shrink-0')}
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
                      <RTabs.Trigger value="features" className={tabTrigger(touch)}>
                        Features
                      </RTabs.Trigger>
                      <RTabs.Trigger value="params" className={tabTrigger(touch)}>
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
                        {touch ? null : (
                          <p className="mt-2 inline-flex items-center gap-1.5">
                            Press <Kbd>S</Kbd> to begin
                          </p>
                        )}
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
                {touch ? (
                  <span className="w-2 shrink-0" aria-hidden />
                ) : (
                  // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a focusable resize handle
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
                )}
              </div>
            </m.aside>

            {/* Centre: viewport */}
            <ViewportStage
              viewport={viewport}
              className={cn(
                'flex-1 rounded-panel shadow-[var(--shadow-card)]',
                touch && '[--chrome-bottom:6.75rem]',
              )}
              // Chrome the app places over the view (library, project panel) keeps clear of an overlaid panel.
              style={
                touch
                  ? ({ '--chrome-left': 'calc(var(--cover-left, 0px) + 0.75rem)' } as CSSProperties)
                  : undefined
              }
              overlay={
                <>
                  <div
                    className="absolute top-3 flex items-center gap-2"
                    style={{ left: 'calc(var(--cover-left, 0px) + 0.75rem)' }}
                  >
                    <UnitsChip />
                    <StatusChip status={kernelStatus} className="pointer-events-auto" />
                  </div>
                  <ViewportOverlays props={props} />
                  {/* Top-right is intentionally free: the view cube mounts there. */}
                  <div
                    className="absolute bottom-4 flex justify-center"
                    style={{ left: 'var(--cover-left, 0px)', right: 'var(--cover-right, 0px)' }}
                  >
                    <CommandBar
                      density={touch ? 'touch' : 'compact'}
                      onMore={core.openPalette}
                      enabledTools={props.enabledTools}
                      activeTool={props.activeTool}
                      onTool={props.onTool}
                    />
                  </div>
                </>
              }
            />

            {/* Tap outside an overlaid panel: it closes (the tap does not also act on the view). */}
            {panelOpen ? (
              // biome-ignore lint/a11y/noStaticElementInteractions: a dismiss layer; Escape and the toggle buttons are the keyboard paths
              <div
                data-testid="panel-scrim"
                aria-hidden="true"
                onPointerDown={(e) => {
                  e.preventDefault();
                  closeOverlay();
                }}
                className="absolute inset-0 z-[calc(var(--z-panel)-1)]"
              />
            ) : null}

            {/* Right: context inspector */}
            <m.aside
              ref={rightRef}
              aria-label="Inspector"
              data-testid="right-panel"
              data-overlay={overlay || undefined}
              initial={false}
              animate={rightAnimate}
              transition={spring}
              onUpdate={reportCovered}
              inert={!rightOpen}
              style={rightStyle}
              className={cn('overflow-hidden', overlay ? overlayCls : 'shrink-0')}
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
                      onToggle={(e) => setRuntimeOpen(e.currentTarget.open)}
                    >
                      <summary
                        className={cn(
                          'flex cursor-pointer list-none items-center gap-1.5 px-4 text-2xs font-semibold tracking-wider text-fg-muted uppercase select-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden',
                          touch ? 'min-h-11' : 'py-2.5',
                        )}
                      >
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
                        <DiagnosticsList
                          d={diagnostics}
                          active={runtimeOpen}
                          {...(kernelMemory ? { kernelMemory } : {})}
                        />
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
