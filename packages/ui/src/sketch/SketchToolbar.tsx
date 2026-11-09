import * as RToolbar from '@radix-ui/react-toolbar';
import type { GeometricConstraint } from '@wren-cad/contracts';
import {
  Check,
  ChevronDown,
  Circle,
  Construction,
  Dot,
  FlipHorizontal2,
  Hexagon,
  Link2,
  MoveRight,
  Pencil,
  Pill,
  RectangleHorizontal,
  Ruler,
  Scissors,
  Slash,
  SquareRoundCorner,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Menu, type MenuItem } from '../components/floating';
import { ChamferIcon } from '../components/icons';
import { Button, cn, Tooltip } from '../components/primitives';
import { ConstraintGlyph, constraintLabels, geometricConstraintKinds } from './ConstraintGlyph';
import { SplineControlIcon, sketchCurveTools } from './curveTools';
import type { SketchEditToolId } from './EditChrome';

export type SketchDrawToolId =
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'slot'
  | 'polygon'
  | 'point'
  | 'dimension';
/** M3.5 curve tools (ADR-046). They sit behind the "Curves" menu button. */
export type SketchCurveToolId = 'splineControl' | 'splineThrough' | 'ellipse' | 'ellipticArc';
export type SketchToolId = SketchDrawToolId | SketchCurveToolId | SketchEditToolId;
export type GeometricConstraintKind = GeometricConstraint['kind'];

export interface ToolSpec {
  id: SketchToolId;
  label: string;
  /** Text under the icon in touch density. */
  short?: string;
  shortcut?: string;
  icon: ReactNode;
  variants?: readonly { id: string; label: string }[];
}

function ArcIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4.5 18.5A10 10 0 0 1 19.5 18.5" />
      <circle cx="4.5" cy="18.5" r="1.4" fill="currentColor" />
      <circle cx="19.5" cy="18.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

const ic = 'size-[18px]';
export const sketchTools: readonly ToolSpec[] = [
  {
    id: 'line',
    label: 'Line',
    shortcut: 'L',
    icon: <Slash className={ic} strokeWidth={1.75} />,
    variants: [
      { id: 'line', label: 'Line' },
      { id: 'polyline', label: 'Polyline' },
    ],
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    icon: <RectangleHorizontal className={ic} strokeWidth={1.75} />,
    variants: [
      { id: 'corner', label: 'Corner rectangle' },
      { id: 'center', label: 'Centre rectangle' },
      { id: 'threePoint', label: '3-point rectangle' },
    ],
  },
  {
    id: 'circle',
    label: 'Circle',
    shortcut: '⇧C',
    icon: <Circle className={ic} strokeWidth={1.75} />,
    variants: [
      { id: 'center', label: 'Centre circle' },
      { id: 'threePoint', label: '3-point circle' },
    ],
  },
  {
    id: 'arc',
    label: 'Arc',
    shortcut: 'A',
    icon: <ArcIcon className={ic} />,
    variants: [
      { id: 'threePoint', label: '3-point arc' },
      { id: 'tangent', label: 'Tangent arc' },
      { id: 'center', label: 'Centre-point arc' },
    ],
  },
  { id: 'slot', label: 'Slot', icon: <Pill className={ic} strokeWidth={1.75} /> },
  {
    id: 'polygon',
    label: 'Polygon',
    short: 'Polygon',
    icon: <Hexagon className={ic} strokeWidth={1.75} />,
  },
  /** Sketch points: hole centres (hole wizard), construction and reference points (M3). */
  { id: 'point', label: 'Point', shortcut: 'P', icon: <Dot className={ic} strokeWidth={3} /> },
  {
    id: 'dimension',
    label: 'Dimension',
    shortcut: 'D',
    icon: <Ruler className={ic} strokeWidth={1.75} />,
  },
];

function OffsetIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 17h9a5 5 0 0 0 5-5V4" />
      <path d="M4 21h13a5 5 0 0 0 5-5V4" opacity="0.55" />
    </svg>
  );
}

/**
 * M3 sketch-editing tools. They live behind one "Edit" menu button so the bar (and the tablet
 * rail) keep their length; their single-key shortcuts work like the drawing tools'.
 */
export const sketchEditTools: readonly (ToolSpec & { id: SketchEditToolId })[] = [
  { id: 'offset', label: 'Offset', shortcut: 'O', icon: <OffsetIcon className={ic} /> },
  {
    id: 'convert',
    label: 'Convert entities',
    short: 'Convert',
    shortcut: 'V',
    icon: <Link2 className={ic} strokeWidth={1.75} />,
  },
  {
    id: 'trim',
    label: 'Trim',
    shortcut: 'T',
    icon: <Scissors className={ic} strokeWidth={1.75} />,
  },
  {
    id: 'extend',
    label: 'Extend',
    shortcut: 'E',
    icon: <MoveRight className={ic} strokeWidth={1.75} />,
  },
  {
    id: 'sketchFillet',
    label: 'Sketch fillet',
    short: 'Fillet',
    shortcut: 'F',
    icon: <SquareRoundCorner className={ic} strokeWidth={1.75} />,
  },
  {
    id: 'sketchChamfer',
    label: 'Sketch chamfer',
    short: 'Chamfer',
    shortcut: '⇧F',
    icon: <ChamferIcon className={ic} />,
  },
  {
    id: 'sketchMirror',
    label: 'Mirror',
    shortcut: 'M',
    icon: <FlipHorizontal2 className={ic} strokeWidth={1.75} />,
  },
];

const allSketchTools: readonly ToolSpec[] = [
  ...sketchTools,
  ...sketchCurveTools,
  ...sketchEditTools,
];

export { sketchCurveTools };

/**
 * `⇧C` -> shift + c; `O` -> o. Matches the physical key (`KeyboardEvent.code`, PLAN 9.4) so a
 * shortcut sits on the same key on every layout; synthetic events without a code fall back to `key`.
 */
function matchesShortcut(e: KeyboardEvent, shortcut: string | undefined): boolean {
  if (!shortcut) return false;
  const shift = shortcut.startsWith('⇧');
  if (e.shiftKey !== shift) return false;
  const letter = shortcut.replace('⇧', '');
  return e.code
    ? e.code === `Key${letter.toUpperCase()}`
    : e.key.toLowerCase() === letter.toLowerCase();
}

export interface SketchToolbarProps {
  activeTool: SketchToolId | null;
  /** Chosen variant per tool; omit to let the toolbar remember them. */
  variants?: Partial<Record<SketchToolId, string>>;
  /** `tool` null = leave the tool (Esc). */
  onTool(tool: SketchToolId | null, variant?: string): void;
  construction: boolean;
  onToggleConstruction(): void;
  /** Applies a constraint to the current selection. */
  onConstraint?(kind: GeometricConstraintKind): void;
  /** M3.5 curve tools behind the "Curves" button (default {@link sketchCurveTools}); [] hides it. */
  curveTools?: readonly ToolSpec[];
  /** Constraints applicable to the current selection; others are shown disabled. */
  enabledConstraints?: readonly GeometricConstraintKind[];
  onFinish(): void;
  /** Esc pressed with no tool active. */
  onEscape?(): void;
  /** Attach L / A / Shift+C / D / X / Esc listeners on `window` (default true). */
  shortcuts?: boolean;
  layout?: 'bar' | 'rail';
  /** `touch`: a short text label under every icon (no hover tooltips on touch) and 56 px targets. */
  density?: 'compact' | 'touch';
  className?: string;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const itemBase =
  'relative flex shrink-0 items-center justify-center rounded-control text-fg-muted transition-colors duration-fast select-none outline-none hover:bg-surface-2 hover:text-fg active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-text disabled:opacity-40';

/**
 * Sketch-mode toolbar (PLAN 9.1, 9.4). Variants open on ArrowDown / right-click / long-press;
 * pressing a tool's shortcut again cycles its variant.
 */
export function SketchToolbar({
  activeTool,
  variants,
  onTool,
  construction,
  onToggleConstruction,
  onConstraint,
  curveTools = sketchCurveTools,
  enabledConstraints,
  onFinish,
  onEscape,
  shortcuts = true,
  layout = 'bar',
  density = 'compact',
  className,
}: SketchToolbarProps) {
  const rail = layout === 'rail';
  const [own, setOwn] = useState<Partial<Record<SketchToolId, string>>>({});
  const chosen = { ...own, ...variants };
  const [menu, setMenu] = useState<
    | { kind: 'variants'; tool: ToolSpec; anchor: HTMLElement }
    | { kind: 'constraints'; anchor: HTMLElement }
    | { kind: 'edit'; anchor: HTMLElement }
    | { kind: 'curves'; anchor: HTMLElement }
    | null
  >(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef({ activeTool, chosen, onTool, onToggleConstruction, onEscape });
  live.current = { activeTool, chosen, onTool, onToggleConstruction, onEscape };

  function pick(spec: ToolSpec, variant?: string) {
    const v = variant ?? chosen[spec.id] ?? spec.variants?.[0]?.id;
    if (variant) setOwn((o) => ({ ...o, [spec.id]: variant }));
    onTool(spec.id, v);
  }

  useEffect(() => {
    if (!shortcuts) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || e.defaultPrevented) return;
      const L = live.current;
      const run = (id: SketchToolId) => {
        const spec = allSketchTools.find((t) => t.id === id);
        if (!spec) return;
        e.preventDefault();
        const cur = L.chosen[id] ?? spec.variants?.[0]?.id;
        if (L.activeTool === id && spec.variants) {
          const i = spec.variants.findIndex((v) => v.id === cur);
          const next = spec.variants[(i + 1) % spec.variants.length]?.id;
          if (next) setOwn((o) => ({ ...o, [id]: next }));
          L.onTool(id, next);
        } else L.onTool(id, cur);
      };
      if (e.key === 'Escape') {
        if (L.activeTool) {
          e.preventDefault();
          L.onTool(null);
        } else L.onEscape?.();
      } else if (!e.shiftKey && (e.code ? e.code === 'KeyX' : e.key.toLowerCase() === 'x')) {
        e.preventDefault();
        L.onToggleConstruction();
      } else {
        const hit = allSketchTools.find((t) => matchesShortcut(e, t.shortcut));
        if (hit) run(hit.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  const enabled = (k: GeometricConstraintKind) =>
    !enabledConstraints || enabledConstraints.includes(k);
  const side = rail ? 'right' : 'top';
  const activeEdit = sketchEditTools.find((t) => t.id === activeTool);
  const activeCurve = curveTools.find((t) => t.id === activeTool);
  const touch = density === 'touch';
  const size = touch ? 'h-14 w-16 flex-col gap-0.5' : rail ? 'size-11' : 'size-10';
  const wide = touch ? size : rail ? size : 'h-10 w-12 gap-0.5';
  const lbl = (t: string) =>
    touch ? (
      <span aria-hidden data-testid="tool-label" className="text-2xs leading-3 font-medium">
        {t}
      </span>
    ) : null;

  const menuItems: MenuItem[] =
    menu?.kind === 'variants'
      ? (menu.tool.variants ?? []).map((v) => ({
          id: v.id,
          label: v.label,
          checked: (chosen[menu.tool.id] ?? menu.tool.variants?.[0]?.id) === v.id,
          onSelect: () => pick(menu.tool, v.id),
        }))
      : menu?.kind === 'curves'
        ? curveTools.map((t) => ({
            id: t.id,
            label: t.label,
            icon: t.icon,
            ...(t.shortcut ? { shortcut: t.shortcut } : {}),
            checked: activeTool === t.id,
            onSelect: () => onTool(t.id),
          }))
        : menu?.kind === 'edit'
          ? sketchEditTools.map((t) => ({
              id: t.id,
              label: t.label,
              icon: t.icon,
              shortcut: t.shortcut,
              checked: activeTool === t.id,
              onSelect: () => onTool(t.id),
            }))
          : geometricConstraintKinds.map((k) => ({
              id: k,
              label: constraintLabels[k],
              disabled: !enabled(k) || !onConstraint,
              icon: <ConstraintGlyph kind={k} size={18} tone="plain" />,
              onSelect: () => onConstraint?.(k),
            }));

  return (
    <>
      <RToolbar.Root
        aria-label="Sketch tools"
        orientation={rail ? 'vertical' : 'horizontal'}
        className={cn(
          'w-panel pointer-events-auto flex items-center gap-0.5 rounded-panel p-1.5',
          touch && !rail && 'max-w-full flex-wrap justify-center',
          rail && 'flex-col',
          className,
        )}
      >
        {sketchTools.map((spec) => {
          const active = activeTool === spec.id;
          const variantLabel = spec.variants?.find(
            (v) => v.id === (chosen[spec.id] ?? spec.variants?.[0]?.id),
          )?.label;
          return (
            <Tooltip
              key={spec.id}
              content={
                variantLabel && spec.variants && spec.variants.length > 1
                  ? `${variantLabel}`
                  : spec.label
              }
              shortcut={spec.shortcut}
              side={side}
            >
              <RToolbar.Button
                aria-label={spec.label}
                aria-pressed={active}
                aria-haspopup={spec.variants ? 'menu' : undefined}
                data-tool={spec.id}
                onClick={() => (active ? onTool(null) : pick(spec))}
                onKeyDown={(e) => {
                  if (
                    spec.variants &&
                    (e.key === 'ArrowDown' || e.key === 'ContextMenu') &&
                    !rail
                  ) {
                    e.preventDefault();
                    setMenu({ kind: 'variants', tool: spec, anchor: e.currentTarget });
                  }
                }}
                onContextMenu={(e) => {
                  if (!spec.variants) return;
                  e.preventDefault();
                  setMenu({ kind: 'variants', tool: spec, anchor: e.currentTarget });
                }}
                onPointerDown={(e) => {
                  if (!spec.variants || e.pointerType === 'mouse') return;
                  const el = e.currentTarget;
                  pressTimer.current = setTimeout(
                    () => setMenu({ kind: 'variants', tool: spec, anchor: el }),
                    480,
                  );
                }}
                onPointerUp={() => clearTimeout(pressTimer.current)}
                onPointerLeave={() => clearTimeout(pressTimer.current)}
                className={cn(itemBase, size)}
              >
                {spec.icon}
                {lbl(spec.short ?? spec.label)}
                {spec.variants ? (
                  <span
                    aria-hidden
                    className="absolute right-1 bottom-1 size-0 border-b-[4px] border-l-[4px] border-b-current border-l-transparent opacity-50"
                  />
                ) : null}
              </RToolbar.Button>
            </Tooltip>
          );
        })}
        {curveTools.length ? (
          <Tooltip content="Splines, ellipses, elliptic arcs" side={side}>
            <RToolbar.Button
              aria-label="Curves"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'curves'}
              aria-pressed={activeCurve !== undefined}
              data-tool-group="curves"
              onClick={(e) => setMenu({ kind: 'curves', anchor: e.currentTarget })}
              className={cn(itemBase, wide)}
            >
              {activeCurve?.icon ?? <SplineControlIcon className={ic} />}
              {touch ? lbl('Curves') : <ChevronDown className="size-3" aria-hidden />}
            </RToolbar.Button>
          </Tooltip>
        ) : null}
        <Tooltip content="Offset, convert, trim, fillet, mirror" side={side}>
          <RToolbar.Button
            aria-label="Edit"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'edit'}
            aria-pressed={activeEdit !== undefined}
            data-tool-group="edit"
            onClick={(e) => setMenu({ kind: 'edit', anchor: e.currentTarget })}
            className={cn(itemBase, wide)}
          >
            {activeEdit?.icon ?? <Pencil className={ic} strokeWidth={1.75} aria-hidden />}
            {touch ? lbl('Edit') : <ChevronDown className="size-3" aria-hidden />}
          </RToolbar.Button>
        </Tooltip>
        <RToolbar.Separator
          className={cn('shrink-0 bg-border', rail ? 'mx-1.5 my-1 h-px w-auto' : 'mx-1 h-6 w-px')}
        />
        <Tooltip content="Construction geometry" shortcut="X" side={side}>
          <RToolbar.Button
            aria-label="Construction"
            aria-pressed={construction}
            onClick={onToggleConstruction}
            className={cn(itemBase, size)}
          >
            <Construction className={ic} strokeWidth={1.75} aria-hidden />
            {lbl('Construction')}
          </RToolbar.Button>
        </Tooltip>
        <Tooltip content="Constraints" side={side}>
          <RToolbar.Button
            aria-label="Constraints"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'constraints'}
            onClick={(e) => setMenu({ kind: 'constraints', anchor: e.currentTarget })}
            className={cn(itemBase, wide)}
          >
            <ConstraintGlyph kind="parallel" size={20} tone="plain" />
            {touch ? lbl('Constraints') : <ChevronDown className="size-3" aria-hidden />}
          </RToolbar.Button>
        </Tooltip>
        <RToolbar.Separator
          className={cn('shrink-0 bg-border', rail ? 'mx-1.5 my-1 h-px w-auto' : 'mx-1 h-6 w-px')}
        />
        <RToolbar.Button asChild>
          <Button
            variant="primary"
            icon={<Check className="size-4" aria-hidden />}
            onClick={onFinish}
            className={cn(
              'h-10 rounded-control px-3.5',
              touch && 'h-14',
              rail && (touch ? 'h-14 w-16 px-0' : 'size-11 px-0'),
            )}
            aria-label="Finish sketch"
          >
            {rail ? null : 'Finish'}
          </Button>
        </RToolbar.Button>
      </RToolbar.Root>
      {menu ? (
        <Menu
          anchor={menu.anchor}
          label={
            menu.kind === 'variants'
              ? `${menu.tool.label} options`
              : menu.kind === 'edit'
                ? 'Edit tools'
                : menu.kind === 'curves'
                  ? 'Curve tools'
                  : 'Constraints'
          }
          items={menuItems}
          placement={rail ? 'right-start' : 'top-start'}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
