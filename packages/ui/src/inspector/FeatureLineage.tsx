import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../components/primitives';
import type { LineageRef } from './SelectionInspector';

export interface FeatureLineageProps {
  /** What the selected feature references: its sketch, features whose faces or edges it uses. */
  parents: readonly LineageRef[];
  /** Children: features that reference the selected one. */
  dependents: readonly LineageRef[];
  /** Select that feature. */
  onSelect(id: string): void;
  /** Hover / focus: highlight it in the tree (null clears). */
  onHover?(id: string | null): void;
  className?: string;
}

function Group({
  title,
  icon,
  items,
  onSelect,
  onHover,
  kind,
}: {
  title: string;
  icon: ReactNode;
  items: readonly LineageRef[];
  onSelect(id: string): void;
  onHover: ((id: string | null) => void) | undefined;
  kind: 'parents' | 'children';
}) {
  return (
    <div data-lineage-group={kind} className="flex min-w-0 flex-col gap-1">
      <h3 className="flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
        {icon}
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-fg-subtle">None</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {items.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                data-lineage-item={r.id}
                onClick={() => onSelect(r.id)}
                onMouseEnter={() => onHover?.(r.id)}
                onMouseLeave={() => onHover?.(null)}
                onFocus={() => onHover?.(r.id)}
                onBlur={() => onHover?.(null)}
                className={cn(
                  'h-7 max-w-44 truncate rounded-full bg-surface-2 px-2.5 text-xs font-medium text-fg outline-none',
                  'hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent',
                )}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Parents and children of the selected feature as small selectable chips. */
export function FeatureLineage({
  parents,
  dependents,
  onSelect,
  onHover,
  className,
}: FeatureLineageProps) {
  return (
    <section
      aria-label="Feature lineage"
      data-testid="feature-lineage"
      className={cn('flex flex-col gap-2.5 px-4 py-3', className)}
    >
      <Group
        kind="parents"
        title="Built from"
        icon={<ArrowDownToLine className="size-3" aria-hidden />}
        items={parents}
        onSelect={onSelect}
        onHover={onHover}
      />
      <Group
        kind="children"
        title="Used by"
        icon={<ArrowUpFromLine className="size-3" aria-hidden />}
        items={dependents}
        onSelect={onSelect}
        onHover={onHover}
      />
    </section>
  );
}
