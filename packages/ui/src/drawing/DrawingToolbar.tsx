import * as RToolbar from '@radix-ui/react-toolbar';
import {
  Flag,
  Frame,
  Layers,
  ListPlus,
  MousePointer2,
  Ruler,
  ScanSearch,
  Scissors,
  StickyNote,
  Waves,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, Tooltip } from '../components/primitives';

export type DrawingToolId =
  | 'select'
  | 'views'
  | 'section'
  | 'detail'
  | 'dimension'
  | 'datum'
  | 'gdt'
  | 'finish'
  | 'note'
  | 'import';

interface ToolDef {
  id: DrawingToolId;
  label: string;
  hint: string;
  icon: ReactNode;
  shortcut?: string;
  group: 'select' | 'views' | 'annotate';
  /** A mode that stays active (pressed) until another is chosen; others are one-shot actions. */
  mode: boolean;
}

const ic = 'size-5';

export const drawingTools: readonly ToolDef[] = [
  {
    id: 'select',
    label: 'Select and move',
    hint: 'Pick views and annotations, drag to move',
    icon: <MousePointer2 className={ic} />,
    shortcut: 'V',
    group: 'select',
    mode: true,
  },
  {
    id: 'views',
    label: 'Add view',
    hint: 'Base views, isometric, standard views',
    icon: <Layers className={ic} />,
    shortcut: 'W',
    group: 'views',
    mode: false,
  },
  {
    id: 'section',
    label: 'Section view',
    hint: 'Drag a cut line across a view',
    icon: <Scissors className={ic} />,
    shortcut: 'S',
    group: 'views',
    mode: true,
  },
  {
    id: 'detail',
    label: 'Detail view',
    hint: 'Drag a circle on a view',
    icon: <ScanSearch className={ic} />,
    shortcut: 'E',
    group: 'views',
    mode: true,
  },
  {
    id: 'dimension',
    label: 'Dimension',
    hint: 'Pick edges: circle, two edges, or one edge twice',
    icon: <Ruler className={ic} />,
    shortcut: 'D',
    group: 'annotate',
    mode: true,
  },
  {
    id: 'datum',
    label: 'Datum',
    hint: 'Pick an edge',
    icon: <Flag className={ic} />,
    group: 'annotate',
    mode: true,
  },
  {
    id: 'gdt',
    label: 'Tolerance frame',
    hint: 'Pick an edge',
    icon: <Frame className={ic} />,
    group: 'annotate',
    mode: true,
  },
  {
    id: 'finish',
    label: 'Surface finish',
    hint: 'Pick an edge',
    icon: <Waves className={ic} />,
    group: 'annotate',
    mode: true,
  },
  {
    id: 'note',
    label: 'Note',
    hint: 'Pick an edge for the leader',
    icon: <StickyNote className={ic} />,
    group: 'annotate',
    mode: true,
  },
  {
    id: 'import',
    label: 'Import model annotations',
    hint: 'Place the model’s dimensions on the views',
    icon: <ListPlus className={ic} />,
    shortcut: 'I',
    group: 'annotate',
    mode: false,
  },
];

export interface DrawingToolbarProps {
  active: DrawingToolId | null;
  /** Tools that cannot be used right now, with the reason (shown on focus and hover). */
  disabled?: Partial<Record<DrawingToolId, string>>;
  onTool(id: DrawingToolId): void;
  orientation?: 'vertical' | 'horizontal';
  size?: 'md' | 'touch';
  className?: string;
}

/** The drawing's tools. One tab stop; arrows move between tools (Radix toolbar). */
export function DrawingToolbar({
  active,
  disabled,
  onTool,
  orientation = 'vertical',
  size = 'md',
  className,
}: DrawingToolbarProps) {
  const groups: ToolDef['group'][] = ['select', 'views', 'annotate'];
  return (
    <RToolbar.Root
      orientation={orientation}
      aria-label="Drawing tools"
      data-testid="drawing-toolbar"
      className={cn(
        'flex gap-0.5 rounded-panel p-1',
        orientation === 'vertical' ? 'flex-col' : 'flex-row',
        className,
      )}
    >
      {groups.map((g, gi) => (
        <div
          key={g}
          role="presentation"
          className={cn(
            'flex gap-0.5',
            orientation === 'vertical' ? 'flex-col' : 'flex-row',
            gi > 0 &&
              (orientation === 'vertical'
                ? 'mt-1 border-t border-border pt-1'
                : 'ml-1 border-l border-border pl-1'),
          )}
        >
          {drawingTools
            .filter((t) => t.group === g)
            .map((t) => {
              const why = disabled?.[t.id];
              const on = active === t.id;
              return (
                <Tooltip
                  key={t.id}
                  content={why ? `${t.label} — ${why}` : t.label}
                  shortcut={t.shortcut}
                  side={orientation === 'vertical' ? 'right' : 'bottom'}
                >
                  <RToolbar.Button
                    aria-label={t.label}
                    aria-pressed={t.mode ? on : undefined}
                    aria-disabled={why !== undefined || undefined}
                    data-tool={t.id}
                    onClick={(e) => {
                      if (why !== undefined) {
                        e.preventDefault();
                        return;
                      }
                      onTool(t.id);
                    }}
                    className={cn(
                      'inline-flex items-center justify-center rounded-control transition-colors duration-fast select-none aria-disabled:opacity-40',
                      size === 'touch' ? 'size-12' : 'size-9',
                      on
                        ? 'bg-accent text-accent-fg'
                        : 'text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3',
                    )}
                  >
                    {t.icon}
                  </RToolbar.Button>
                </Tooltip>
              );
            })}
        </div>
      ))}
    </RToolbar.Root>
  );
}
