import { Box, Layers } from 'lucide-react';
import { Button, cn } from '../components/primitives';
import { EmptyState } from './EmptyState';
import { ConfigBadge } from './ViewInspector';
import { type BaseViewName, ViewGlyph, ViewPicker } from './ViewPicker';

export interface ViewRow {
  id: string;
  name: string;
  /** Nesting depth under its parent (0 = base). */
  depth: number;
  kind: 'base' | 'projected' | 'iso' | 'section' | 'detail';
  scale: string;
  /** The view's own configuration, badged (undefined = the drawing's). */
  configuration?: { name: string; missing?: boolean };
  /** The view cannot be solved: its problem, in words. */
  problem?: string;
}

export interface ViewsPanelProps {
  views: readonly ViewRow[];
  selectedId?: string | null;
  onSelect(id: string): void;
  onAddBase(name: BaseViewName): void;
  onAddIso(): void;
  /** Adds the top and side views of the selected (or first) base view. */
  onAddStandard(): void;
  canAddDerived: boolean;
  /** Phone: review only. */
  reviewOnly?: boolean;
  size?: 'md' | 'touch';
}

/** The sheet's views as a list (with each one's scale and configuration badge) and the base view picker. */
export function ViewsPanel({
  views,
  selectedId,
  onSelect,
  onAddBase,
  onAddIso,
  onAddStandard,
  canAddDerived,
  reviewOnly,
  size = 'md',
}: ViewsPanelProps) {
  const touch = size === 'touch';
  return (
    <div className="flex flex-col gap-3 px-4 pb-4" data-testid="views-panel">
      {views.length === 0 ? (
        <EmptyState icon={Box} title="No views yet">
          {reviewOnly
            ? 'This sheet has no views.'
            : 'Pick a standard view below to start the drawing.'}
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Views on this sheet">
          {views.map((v) => {
            const on = selectedId === v.id;
            return (
              <li key={v.id} style={{ paddingLeft: `${v.depth * 14}px` }}>
                <button
                  type="button"
                  data-view-row={v.id}
                  aria-pressed={on}
                  onClick={() => onSelect(v.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-control px-2 text-left transition-colors duration-fast',
                    touch ? 'min-h-12' : 'min-h-10',
                    on ? 'bg-accent-soft text-accent-text' : 'bg-surface-2 hover:bg-surface-3',
                  )}
                >
                  <ViewGlyph
                    name={v.kind === 'iso' ? 'iso' : 'front'}
                    className="size-6 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui font-medium">{v.name}</span>
                    {v.problem ? (
                      <span className="truncate text-2xs text-danger-text">{v.problem}</span>
                    ) : null}
                  </span>
                  {v.configuration ? (
                    <ConfigBadge
                      own
                      name={v.configuration.name}
                      {...(v.configuration.missing ? { missing: true } : {})}
                    />
                  ) : null}
                  <span className="tnum shrink-0 text-2xs text-fg-muted">{v.scale}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {reviewOnly ? null : (
        <>
          <div className="flex flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
              <Layers className="size-3.5" aria-hidden /> Base view
            </h3>
            <ViewPicker onPick={onAddBase} size={touch ? 'touch' : 'md'} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size={touch ? 'touch' : 'md'}
              disabled={!canAddDerived}
              onClick={onAddStandard}
              data-testid="add-standard-views"
            >
              Add top and side views
            </Button>
            <Button
              variant="secondary"
              size={touch ? 'touch' : 'md'}
              disabled={!canAddDerived}
              onClick={onAddIso}
              data-testid="add-iso-view"
            >
              Add isometric
            </Button>
          </div>
          <p className="text-2xs text-fg-subtle">
            Or select a view and drag an arrow out of its edge: the new view aligns and follows the
            projection method.
          </p>
        </>
      )}
    </div>
  );
}
