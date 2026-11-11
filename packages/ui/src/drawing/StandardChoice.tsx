import type { Projection } from '@wren-cad/contracts';
import { useState } from 'react';
import { Segmented } from '../components/controls';
import { Button, cn } from '../components/primitives';

export type StandardFamily = 'iso' | 'asme';

export interface StandardChoiceValue {
  family: StandardFamily;
  projection: Projection;
}

/** Layout of the front, top and side views under each projection method (one glyph each). */
function ProjectionGlyph({ projection }: { projection: Projection }) {
  // First angle: the top view sits below the front, the right-hand view to its left.
  const first = projection === 'first';
  const front = { x: 20, y: 20 };
  const top = { x: 20, y: first ? 38 : 4 };
  const side = { x: first ? 2 : 38, y: 20 };
  const box = (p: { x: number; y: number }, fill: string, label: string) => (
    <g key={label}>
      <rect
        x={p.x}
        y={p.y}
        width="14"
        height="14"
        rx="1.5"
        fill={fill}
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <text
        x={p.x + 7}
        y={p.y + 10}
        textAnchor="middle"
        fontSize="7"
        fill="currentColor"
        stroke="none"
      >
        {label}
      </text>
    </g>
  );
  return (
    <svg viewBox="0 0 54 54" className="size-14" aria-hidden>
      {box(front, 'var(--color-accent)', 'F')}
      {box(top, 'var(--color-surface-3)', 'T')}
      {box(side, 'var(--color-surface-3)', 'R')}
    </svg>
  );
}

export interface StandardChoiceProps {
  /** Pre-selected (a project that already has a choice offers it again from the settings). */
  value?: StandardChoiceValue;
  onConfirm(value: StandardChoiceValue): void;
  busy?: boolean;
  /** The part this is for, shown in the heading. */
  partName?: string;
  size?: 'md' | 'touch';
}

const FAMILY_TEXT: Record<StandardFamily, { title: string; body: string }> = {
  iso: {
    title: 'ISO',
    body: 'ISO 5457 sheet (A3) with an ISO 7200 title block, ISO 128 lines, ISO 1101 tolerances. First-angle projection is the usual choice.',
  },
  asme: {
    title: 'ASME / ANSI',
    body: 'ASME Y14.1 sheet (ANSI B) with an ASME title block, Y14.2 lines, Y14.5 tolerances. Third-angle projection is the usual choice.',
  },
};

/**
 * The explicit standard and projection choice at the project's first drawing (D10). An inline
 * card in the drawing route, not a dialog: nothing is implied by the sheet size or the locale.
 * The choice is remembered for the project and can be changed in the drawing settings.
 */
export function StandardChoice({
  value,
  onConfirm,
  busy,
  partName,
  size = 'md',
}: StandardChoiceProps) {
  const [family, setFamily] = useState<StandardFamily>(value?.family ?? 'iso');
  const [projection, setProjection] = useState<Projection | null>(value?.projection ?? null);
  const touch = size === 'touch';
  return (
    <section
      aria-labelledby="standard-choice-title"
      data-testid="standard-choice"
      className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-panel bg-surface p-5 shadow-pop"
    >
      <header className="flex flex-col gap-1">
        <h2 id="standard-choice-title" className="text-base font-semibold tracking-tight">
          {partName ? `New drawing of ${partName}` : 'New drawing'}
        </h2>
        <p className="text-ui text-fg-muted">
          Choose the standard and projection once for this project. They decide the sheet, the lines
          and symbols, and where each view goes. Nothing is guessed from the sheet size.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span id="standard-family-label" className="text-xs font-medium text-fg-muted">
          Standard
        </span>
        <Segmented
          label="Drawing standard"
          size={touch ? 'touch' : 'md'}
          value={family}
          onChange={(f) => {
            setFamily(f);
          }}
          options={[
            { value: 'iso', label: 'ISO' },
            { value: 'asme', label: 'ASME / ANSI' },
          ]}
        />
        <p className="text-xs text-fg-muted" data-testid="standard-body">
          {FAMILY_TEXT[family].body}
        </p>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-xs font-medium text-fg-muted">Projection method</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['first', 'third'] as const).map((p) => {
            const on = projection === p;
            return (
              <label
                key={p}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1 rounded-control p-3 text-center transition-colors duration-fast focus-within:outline-2 focus-within:outline-accent',
                  on
                    ? 'bg-accent-soft shadow-[inset_0_0_0_2px_var(--color-accent)]'
                    : 'bg-surface-2 hover:bg-surface-3',
                  touch && 'min-h-28',
                )}
              >
                <input
                  type="radio"
                  name="projection"
                  value={p}
                  checked={on}
                  onChange={() => setProjection(p)}
                  className="sr-only"
                />
                <ProjectionGlyph projection={p} />
                <span className="text-ui font-medium">
                  {p === 'first' ? 'First angle' : 'Third angle'}
                </span>
                <span className="text-2xs text-fg-muted">
                  {p === 'first'
                    ? 'Top view below the front, right view on the left'
                    : 'Top view above the front, right view on the right'}
                </span>
              </label>
            );
          })}
        </div>
        {projection === null ? (
          <p className="text-xs text-fg-muted">Pick one to continue.</p>
        ) : null}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <p className="text-2xs text-fg-subtle">
          You can change both later in the drawing settings; aligned views follow the change.
        </p>
        <Button
          variant="primary"
          size={touch ? 'touch' : 'md'}
          disabled={projection === null || busy}
          onClick={() => projection && onConfirm({ family, projection })}
          data-testid="standard-confirm"
        >
          Create drawing
        </Button>
      </div>
    </section>
  );
}
