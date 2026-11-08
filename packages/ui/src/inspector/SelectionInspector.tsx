import { Box, Circle, MousePointer2, RectangleHorizontal, Slash, Square } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Section } from '../components/controls';
import { Button, cn, Kbd } from '../components/primitives';
import { EmptyState } from '../shells/shared';

export type SelectionKind = 'face' | 'edge' | 'vertex' | 'body' | 'region';

export type SelectionState =
  | { kind: 'none' }
  | {
      kind: SelectionKind;
      /** How many entities are selected. */
      count: number;
      /** e.g. "Planar face" or a persistent name. */
      label?: string;
      /** Measured facts, e.g. ["Area", "412 mm²"]. */
      details?: ReadonlyArray<readonly [string, string]>;
    };

export interface SelectionAction {
  id: string;
  label: string;
  shortcut?: string;
  icon?: ReactNode;
}

export interface SelectionInspectorProps {
  selection: SelectionState;
  /** Context tools offered for this selection (select first, act second). */
  actions?: readonly SelectionAction[];
  onAction?(id: string): void;
  className?: string;
}

const kindMeta: Record<
  SelectionKind,
  { noun: string; Icon: ComponentType<{ className?: string }> }
> = {
  face: { noun: 'face', Icon: Square },
  edge: { noun: 'edge', Icon: Slash },
  vertex: { noun: 'vertex', Icon: Circle },
  body: { noun: 'body', Icon: Box },
  region: { noun: 'sketch region', Icon: RectangleHorizontal },
};

/** Empty / hint state, and facts + context actions for the current viewport selection. */
export function SelectionInspector({
  selection,
  actions,
  onAction,
  className,
}: SelectionInspectorProps) {
  if (selection.kind === 'none') {
    return (
      <EmptyState icon={MousePointer2} title="Nothing selected" className={cn('pt-6', className)}>
        <p>Select a face, edge or feature to see its properties.</p>
        <p className="mt-2 text-2xs">Or pick a tool and choose what it should act on.</p>
      </EmptyState>
    );
  }
  const { noun, Icon } = kindMeta[selection.kind];
  const title = selection.count === 1 ? `1 ${noun}` : `${selection.count} ${noun}s`;
  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="selection-inspector">
      <header className="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
        <span className="flex size-8 items-center justify-center rounded-control bg-accent-soft text-accent-text">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm leading-5 font-semibold">{title}</h2>
          {selection.label ? (
            <p className="truncate text-2xs text-fg-muted">{selection.label}</p>
          ) : null}
        </div>
      </header>
      {selection.details?.length ? (
        <Section title="Properties">
          <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
            {selection.details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{k}</dt>
                <dd className="truncate text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
      {actions?.length ? (
        <Section title="Actions">
          <div className="flex flex-col gap-1.5">
            {actions.map((a) => (
              <Button
                key={a.id}
                variant="secondary"
                icon={a.icon}
                onClick={() => onAction?.(a.id)}
                className="justify-start"
              >
                <span className="flex-1 text-left">{a.label}</span>
                {a.shortcut ? <Kbd>{a.shortcut}</Kbd> : null}
              </Button>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
