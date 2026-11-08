import type { DeviceTier, RuntimeDiagnostics } from '@whittle/contracts';
import { Download, Grid3x3, Moon, Redo2, Sun, Undo2 } from 'lucide-react';
import { LazyMotion, m } from 'motion/react';
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BirdMark } from '../brand/Bird';
import type { PaletteCommand } from '../components/CommandPalette';
import { Button, cn, IconButton, TooltipProvider } from '../components/primitives';
import { COMING_SOON, tools } from '../components/tools';
import { ExportMenu } from '../export/ExportMenu';
import { useSpring } from '../motion';
import type { ParamsTableProps } from '../params/ParamsTable';
import { type ThemeControl, useTheme } from '../theme';
import type { ShellProps } from './types';

// The palette (Dialog + focus scope + scroll lock) is only fetched the first time it is opened.
const CommandPalette = lazy(() =>
  import('../components/CommandPalette').then((mod) => ({ default: mod.CommandPalette })),
);

// The params table (and the expression field it carries) is only fetched when a Params tab opens.
const ParamsTableLazy = lazy(() =>
  import('../params/ParamsTable').then((mod) => ({ default: mod.ParamsTable })),
);

/** Code-split `ParamsTable` for the shells' Params tabs and sheets. */
export function ParamsPanel(props: ParamsTableProps) {
  return (
    <Suspense
      fallback={<p className="p-6 text-center text-ui text-fg-muted">Loading parameters…</p>}
    >
      <ParamsTableLazy {...props} />
    </Suspense>
  );
}

const loadMotionFeatures = () => import('../motionFeatures').then((mod) => mod.default);

export interface ShellCore {
  theme: ThemeControl;
  openPalette(): void;
}

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');

/**
 * Common root for all shells: root test-id/tier attributes, tooltip + motion providers, theme
 * state, the global ⌘K / Ctrl+K command palette.
 */
export function ShellRoot({
  tier,
  props,
  className,
  extraCommands,
  children,
}: {
  tier: DeviceTier;
  props: ShellProps;
  className?: string;
  extraCommands?: readonly PaletteCommand[];
  children: (core: ShellCore) => ReactNode;
}) {
  const theme = useTheme({ value: props.theme, onChange: props.onThemeChange });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteWanted, setPaletteWanted] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteWanted(true);
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...tools.map(({ id, label, shortcut, Icon }) => {
        const enabled = !!props.enabledTools?.includes(id);
        return {
          id,
          label,
          shortcut,
          disabled: !enabled,
          hint: enabled ? undefined : COMING_SOON,
          run: enabled ? () => props.onTool?.(id) : undefined,
          icon: <Icon className="size-4" strokeWidth={1.75} />,
        };
      }),
      {
        id: 'toggle-theme',
        label: theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme.resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />,
        run: theme.toggle,
      },
      ...(extraCommands ?? []),
      ...(props.commands ?? []),
    ],
    [theme.resolved, theme.toggle, extraCommands, props.commands, props.enabledTools, props.onTool],
  );

  const openPalette = useCallback(() => {
    setPaletteWanted(true);
    setPaletteOpen(true);
  }, []);

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <TooltipProvider>
        <div
          data-testid="app-shell"
          data-tier={tier}
          className={cn(
            'relative h-dvh w-full overflow-hidden bg-bg text-fg select-none',
            className,
          )}
        >
          {children({ theme, openPalette })}
        </div>
        {paletteWanted ? (
          <Suspense fallback={null}>
            <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
          </Suspense>
        ) : null}
      </TooltipProvider>
    </LazyMotion>
  );
}

/* ------------------------------------------------------------------------- viewport */

/**
 * Holds the app's viewport. `viewport-slot` is positioned and fills this stage, so a
 * `<canvas style="width:100%;height:100%">` inside it always matches the visible area. Overlays are
 * siblings above it and never resize it.
 */
export function ViewportStage({
  viewport,
  overlay,
  className,
}: {
  viewport: ReactNode;
  overlay?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative isolate min-h-0 min-w-0 overflow-hidden bg-gradient-to-b from-viewport-top to-viewport-bottom',
        className,
      )}
    >
      <div data-testid="viewport-slot" className="absolute inset-0 z-[var(--z-viewport)]">
        {viewport}
      </div>
      <div className="pointer-events-none absolute inset-0 z-[var(--z-overlay)]">{overlay}</div>
    </div>
  );
}

/* ------------------------------------------------------------------------- small pieces */

export function ThemeToggle({
  theme,
  size,
  tooltipSide,
}: {
  theme: ThemeControl;
  size?: 'md' | 'touch';
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const dark = theme.resolved === 'dark';
  return (
    <IconButton
      label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      icon={dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
      onClick={theme.toggle}
      size={size}
      tooltipSide={tooltipSide}
    />
  );
}

export function UndoRedo({
  onUndo,
  onRedo,
  size,
  tooltipSide,
}: Pick<ShellProps, 'onUndo' | 'onRedo'> & {
  size?: 'md' | 'touch';
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <>
      <IconButton
        label="Undo"
        shortcut={`${modKey()}Z`}
        icon={<Undo2 className="size-[18px]" />}
        disabled={!onUndo}
        onClick={onUndo}
        size={size}
        tooltipSide={tooltipSide}
      />
      <IconButton
        label="Redo"
        shortcut={`⇧${modKey()}Z`}
        icon={<Redo2 className="size-[18px]" />}
        disabled={!onRedo}
        onClick={onRedo}
        size={size}
        tooltipSide={tooltipSide}
      />
    </>
  );
}

/** Whittle mark: the perched bird (brand kit), on a soft tile so it reads at chip size. */
export function Mark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-2',
        className,
      )}
      aria-hidden="true"
    >
      <BirdMark className="size-[118%] -translate-x-[4%] -translate-y-[2%]" />
    </span>
  );
}

export function UnitsChip({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'w-panel tnum pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-fg-muted',
        className,
      )}
      data-testid="units-chip"
    >
      <Grid3x3 className="size-3.5" aria-hidden />
      <span>mm</span>
      <span aria-hidden className="text-fg-subtle">
        ·
      </span>
      <span>Grid 10</span>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-surface-2 text-fg-muted">
        <Icon className="size-5" strokeWidth={1.5} />
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children ? <div className="mt-1 text-ui text-fg-muted">{children}</div> : null}
    </div>
  );
}

export function DiagnosticsList({ d }: { d: RuntimeDiagnostics }) {
  const rows: Array<[string, string]> = [
    ['Tier', d.tier],
    ['Isolated', d.crossOriginIsolated ? 'yes' : 'no'],
    ['Kernel', d.kernelVariant ?? '—'],
    ['Renderer', d.renderBackend ?? '—'],
    ['Threads', String(d.hardwareConcurrency)],
    ['Pointer', d.primaryPointer],
    ['Version', d.appVersion],
  ];
  return (
    <dl
      className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs"
      data-testid="diagnostics"
    >
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="truncate text-right font-medium text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------------- bottom sheet */

/**
 * Bottom sheet with a peek state (tablet history, phone tools). The handle toggles it on click /
 * Enter / Space and on a short vertical swipe. Collapsed content is `inert`.
 */
export function BottomSheet({
  open,
  onOpenChange,
  peek,
  height,
  handleLabel,
  header,
  children,
  className,
  testId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Visible height (px) when collapsed, including the handle and any header. */
  peek: number;
  /** Fixed sheet height (CSS length) when expanded. */
  height: string;
  handleLabel: string;
  header?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [full, setFull] = useState(0);
  const transition = useSpring('standard');
  const startY = useRef<number | null>(null);
  const swiped = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setFull(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const y = open ? 0 : Math.max(full - peek, 0);

  return (
    <m.section
      ref={ref}
      aria-label={handleLabel}
      data-testid={testId}
      data-open={open}
      initial={false}
      animate={{ y }}
      transition={transition}
      style={{ height }}
      className={cn(
        'w-panel pointer-events-auto absolute right-0 bottom-0 left-0 z-[var(--z-sheet)] flex flex-col rounded-b-none pb-[var(--safe-bottom)]',
        'rounded-t-[var(--radius-sheet)]',
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${handleLabel}${open ? ', collapse' : ', expand'}`}
        onClick={() => {
          if (swiped.current) swiped.current = false;
          else onOpenChange(!open);
        }}
        onPointerDown={(e) => {
          startY.current = e.clientY;
          swiped.current = false;
        }}
        onPointerUp={(e) => {
          const s = startY.current;
          startY.current = null;
          if (s === null) return;
          const dy = e.clientY - s;
          if (dy < -24 && !open) {
            swiped.current = true;
            onOpenChange(true);
          } else if (dy > 24 && open) {
            swiped.current = true;
            onOpenChange(false);
          }
        }}
        className="flex h-6 w-full shrink-0 touch-none items-center justify-center"
      >
        <span className="h-1 w-9 rounded-full bg-border-strong/60" />
      </button>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto" inert={!open}>
        {children}
      </div>
    </m.section>
  );
}

/* ------------------------------------------------------------------------- export */

/**
 * The top-bar Export control: the options popover when the host handles `onExportRequest`,
 * otherwise the plain button that calls `onExport`.
 */
export function ExportControl({
  props,
  variant = 'secondary',
  size = 'md',
  className,
}: {
  props: ShellProps;
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'touch';
  className?: string;
}) {
  if (props.onExportRequest) {
    return (
      <ExportMenu
        variant={variant}
        size={size}
        className={className}
        onExport={props.onExportRequest}
        bodies={props.exportBodies}
        unavailable={props.exportUnavailable}
        busy={props.exportBusy}
      />
    );
  }
  return (
    <Button
      variant={variant}
      size={size}
      onClick={props.onExport}
      icon={<Download className={size === 'touch' ? 'size-[18px]' : 'size-4'} />}
      className={className}
    >
      Export
    </Button>
  );
}
