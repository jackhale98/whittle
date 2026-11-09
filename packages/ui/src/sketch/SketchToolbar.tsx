import * as RToolbar from '@radix-ui/react-toolbar';
import type { GeometricConstraint } from '@whittle/contracts';
import {
  Check,
  ChevronDown,
  Circle,
  Construction,
  Hexagon,
  Pill,
  RectangleHorizontal,
  Ruler,
  Slash,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Menu, type MenuItem } from '../components/floating';
import { Button, cn, Tooltip } from '../components/primitives';
import { ConstraintGlyph, constraintLabels, geometricConstraintKinds } from './ConstraintGlyph';

export type SketchToolId =
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'slot'
  | 'polygon'
  | 'dimension';
export type GeometricConstraintKind = GeometricConstraint['kind'];

interface ToolSpec {
  id: SketchToolId;
  label: string;
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
  { id: 'polygon', label: 'Polygon', icon: <Hexagon className={ic} strokeWidth={1.75} /> },
  {
    id: 'dimension',
    label: 'Dimension',
    shortcut: 'D',
    icon: <Ruler className={ic} strokeWidth={1.75} />,
  },
];

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
  /** Constraints applicable to the current selection; others are shown disabled. */
  enabledConstraints?: readonly GeometricConstraintKind[];
  onFinish(): void;
  /** Esc pressed with no tool active. */
  onEscape?(): void;
  /** Attach L / A / Shift+C / D / X / Esc listeners on `window` (default true). */
  shortcuts?: boolean;
  layout?: 'bar' | 'rail';
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
  enabledConstraints,
  onFinish,
  onEscape,
  shortcuts = true,
  layout = 'bar',
  className,
}: SketchToolbarProps) {
  const rail = layout === 'rail';
  const [own, setOwn] = useState<Partial<Record<SketchToolId, string>>>({});
  const chosen = { ...own, ...variants };
  const [menu, setMenu] = useState<
    | { kind: 'variants'; tool: ToolSpec; anchor: HTMLElement }
    | { kind: 'constraints'; anchor: HTMLElement }
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
        const spec = sketchTools.find((t) => t.id === id);
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
      } else if (!e.shiftKey && e.key.toLowerCase() === 'l') run('line');
      else if (!e.shiftKey && e.key.toLowerCase() === 'a') run('arc');
      else if (e.shiftKey && e.key.toLowerCase() === 'c') run('circle');
      else if (!e.shiftKey && e.key.toLowerCase() === 'd') run('dimension');
      else if (!e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        L.onToggleConstruction();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  const enabled = (k: GeometricConstraintKind) =>
    !enabledConstraints || enabledConstraints.includes(k);
  const side = rail ? 'right' : 'top';
  const size = rail ? 'size-11' : 'size-10';

  const menuItems: MenuItem[] =
    menu?.kind === 'variants'
      ? (menu.tool.variants ?? []).map((v) => ({
          id: v.id,
          label: v.label,
          checked: (chosen[menu.tool.id] ?? menu.tool.variants?.[0]?.id) === v.id,
          onSelect: () => pick(menu.tool, v.id),
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
          </RToolbar.Button>
        </Tooltip>
        <Tooltip content="Constraints" side={side}>
          <RToolbar.Button
            aria-label="Constraints"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'constraints'}
            onClick={(e) => setMenu({ kind: 'constraints', anchor: e.currentTarget })}
            className={cn(itemBase, rail ? size : 'h-10 w-12 gap-0.5')}
          >
            <ConstraintGlyph kind="parallel" size={20} tone="plain" />
            <ChevronDown className="size-3" aria-hidden />
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
            className={cn('h-10 rounded-control px-3.5', rail && 'size-11 px-0')}
            aria-label="Finish sketch"
          >
            {rail ? null : 'Finish'}
          </Button>
        </RToolbar.Button>
      </RToolbar.Root>
      {menu ? (
        <Menu
          anchor={menu.anchor}
          label={menu.kind === 'variants' ? `${menu.tool.label} options` : 'Constraints'}
          items={menuItems}
          placement={rail ? 'right-start' : 'top-start'}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
