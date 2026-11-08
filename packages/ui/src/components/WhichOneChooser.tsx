import { Box, Circle, Slash, Square } from 'lucide-react';
import { type ComponentType, useRef } from 'react';
import { FloatingLayer } from './floating';
import { cn } from './primitives';

export type CandidateKind = 'face' | 'edge' | 'vertex' | 'body';

export interface PickCandidate {
  id: string;
  kind: CandidateKind;
  /** e.g. "Top face", "Edge of Extrude 1". */
  label: string;
  /** Secondary text, e.g. "Planar · 412 mm²". */
  detail?: string;
}

export interface WhichOneChooserProps {
  candidates: readonly PickCandidate[];
  /** Viewport point where the user pressed (px, client coordinates). */
  at: { x: number; y: number };
  onPick(id: string): void;
  /** Hover / keyboard focus: preselect-highlight in the viewport (null clears). */
  onHover?(id: string | null): void;
  onDismiss(): void;
  size?: 'md' | 'touch';
}

const kindIcon: Record<CandidateKind, ComponentType<{ className?: string }>> = {
  face: Square,
  edge: Slash,
  vertex: Circle,
  body: Box,
};

/**
 * "Which one?" chooser (PLAN 9.2) for ambiguous hits on touch or dense geometry. A non-modal
 * listbox next to the press point: arrows move (and preselect in the viewport), Enter picks,
 * Esc dismisses.
 */
export function WhichOneChooser({
  candidates,
  at,
  onPick,
  onHover,
  onDismiss,
  size = 'md',
}: WhichOneChooserProps) {
  const list = useRef<HTMLUListElement>(null);
  const move = (d: number) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + d + els.length) % els.length]?.focus();
  };
  return (
    <FloatingLayer
      anchor={at}
      onDismiss={() => {
        onHover?.(null);
        onDismiss();
      }}
      role="dialog"
      label="Which one?"
      testId="which-one"
      className="w-64 p-1.5"
    >
      <p className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
        Which one?
      </p>
      <ul
        ref={list}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a listbox of picks
        role="listbox"
        aria-label="Candidates under the pointer"
        className="m-0 list-none p-0"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') move(1);
          else if (e.key === 'ArrowUp') move(-1);
          else return;
          e.preventDefault();
        }}
      >
        {candidates.map((c, i) => {
          const Icon = kindIcon[c.kind];
          return (
            <li key={c.id} role="presentation" className="list-none">
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-autofocus={i === 0 ? '' : undefined}
                data-kind={c.kind}
                onMouseEnter={() => onHover?.(c.id)}
                onMouseLeave={() => onHover?.(null)}
                onFocus={() => onHover?.(c.id)}
                onClick={() => {
                  onHover?.(null);
                  onPick(c.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[8px] px-2 text-left outline-none transition-colors duration-150 hover:bg-surface-2 focus-visible:bg-accent-soft',
                  size === 'touch' ? 'h-12' : 'h-9',
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-2 text-fg-muted">
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium">{c.label}</span>
                  {c.detail ? (
                    <span className="tnum block truncate text-2xs text-fg-muted">{c.detail}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </FloatingLayer>
  );
}
