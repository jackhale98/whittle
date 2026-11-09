import { Box, Circle, Slash, Square } from 'lucide-react';
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react';
import { type CandidateKind, cyclePreselection, sortCandidates } from '../logic/chooser';
import { FloatingLayer } from './floating';
import { cn } from './primitives';

export type { CandidateKind };

export interface PickCandidate {
  id: string;
  kind: CandidateKind;
  /** Distance along the pick ray; nearer first within a kind. Omit when unknown. */
  depth?: number;
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
 * listbox next to the press point. The order is stable (kind priority, then depth, then id).
 * Hovering a row, arrows, or Tab / Shift+Tab move the preselection (`onHover`, so the app
 * highlights it in 3D); Enter or a click picks, Esc dismisses.
 */
export function WhichOneChooser({
  candidates: unsorted,
  at,
  onPick,
  onHover,
  onDismiss,
  size = 'md',
}: WhichOneChooserProps) {
  const list = useRef<HTMLUListElement>(null);
  const candidates = useMemo(() => sortCandidates(unsorted), [unsorted]);
  const ids = useMemo(() => candidates.map((c) => c.id), [candidates]);
  const [active, setActive] = useState<string | null>(candidates[0]?.id ?? null);
  const live = useRef({ ids, active, onHover });
  live.current = { ids, active, onHover };
  const focusId = (id: string | null) => {
    if (id === null) return;
    setActive(id);
    live.current.onHover?.(id);
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const move = (d: 1 | -1) => focusId(cyclePreselection(ids, active, d));

  // Tab / Shift+Tab cycle the preselection wherever focus is while the chooser is open (a still
  // pointer, focus left on the canvas), instead of walking out into the page.
  useEffect(() => {
    function onTab(e: KeyboardEvent) {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      focusRef.current(
        cyclePreselection(live.current.ids, live.current.active, e.shiftKey ? -1 : 1),
      );
    }
    document.addEventListener('keydown', onTab, true);
    return () => document.removeEventListener('keydown', onTab, true);
  }, []);
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
        {candidates.map((c) => {
          const Icon = kindIcon[c.kind];
          return (
            <li key={c.id} role="presentation" className="list-none">
              <button
                type="button"
                role="option"
                aria-selected={active === c.id}
                tabIndex={active === c.id ? 0 : -1}
                data-autofocus={c.id === candidates[0]?.id ? '' : undefined}
                data-kind={c.kind}
                data-id={c.id}
                onMouseEnter={() => {
                  setActive(c.id);
                  onHover?.(c.id);
                }}
                onMouseLeave={() => onHover?.(null)}
                onFocus={() => {
                  setActive(c.id);
                  onHover?.(c.id);
                }}
                onClick={() => {
                  onHover?.(null);
                  onPick(c.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[8px] px-2 text-left outline-none transition-colors duration-fast hover:bg-surface-2 focus-visible:bg-accent-soft aria-selected:bg-accent-soft',
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
