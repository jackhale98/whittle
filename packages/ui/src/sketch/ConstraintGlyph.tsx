import type { SketchConstraintKind } from '@whittle/contracts';
import type { ReactNode } from 'react';
import { cn } from '../components/primitives';

export const constraintLabels: Record<SketchConstraintKind, string> = {
  coincident: 'Coincident',
  pointOn: 'Point on curve',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  horizontalPoints: 'Horizontal points',
  verticalPoints: 'Vertical points',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  midpoint: 'Midpoint',
  concentric: 'Concentric',
  symmetric: 'Symmetric',
  fix: 'Fix',
  distance: 'Distance',
  hDistance: 'Horizontal distance',
  vDistance: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  offset: 'Offset',
};

/** Geometric constraints in menu order (the P0 set of PLAN 2.1). */
export const geometricConstraintKinds = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'midpoint',
  'concentric',
  'symmetric',
  'fix',
  'pointOn',
  'horizontalPoints',
  'verticalPoints',
] as const satisfies readonly SketchConstraintKind[];

export const dimensionKinds = [
  'distance',
  'hDistance',
  'vDistance',
  'length',
  'radius',
  'diameter',
  'angle',
] as const satisfies readonly SketchConstraintKind[];

/** 24x24 line glyphs (stroke = currentColor). Fills are used for point dots only. */
const glyphs: Record<SketchConstraintKind, ReactNode> = {
  coincident: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  pointOn: (
    <>
      <path d="M3.5 18 20.5 7" />
      <circle cx="12" cy="12.6" r="2.6" fill="currentColor" stroke="none" />
    </>
  ),
  horizontal: (
    <>
      <path d="M6 12h12" />
      <circle cx="4.5" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="12" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  vertical: (
    <>
      <path d="M12 6v12" />
      <circle cx="12" cy="4.5" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19.5" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  horizontalPoints: (
    <>
      <circle cx="5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M8.5 12h7" strokeDasharray="2 2" />
    </>
  ),
  verticalPoints: (
    <>
      <circle cx="12" cy="5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="2.2" fill="currentColor" stroke="none" />
      <path d="M12 8.5v7" strokeDasharray="2 2" />
    </>
  ),
  parallel: <path d="M6.5 20 12 4M13 20l5.5-16" />,
  perpendicular: <path d="M4 19h16M12 19V5M12 15h4v4" />,
  tangent: (
    <>
      <circle cx="12" cy="9" r="6" />
      <path d="M3 15h18" />
    </>
  ),
  equal: <path d="M6 9h12M6 15h12" />,
  midpoint: (
    <>
      <path d="M3.5 17h17" />
      <path d="M12 7.2 15.2 12 12 16.8 8.8 12z" fill="currentColor" stroke="none" />
    </>
  ),
  concentric: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  symmetric: (
    <>
      <path d="M12 3v18" strokeDasharray="2.5 2" />
      <circle cx="5.5" cy="8" r="2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="8" r="2" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="16" r="2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="16" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  fix: (
    <>
      <rect x="6" y="11" width="12" height="9" rx="2.2" />
      <path d="M8.8 11V8.4a3.2 3.2 0 0 1 6.4 0V11" />
    </>
  ),
  distance: <path d="M4 6v12M20 6v12M4 12h16M4 12l3-2.2M4 12l3 2.2M20 12l-3-2.2M20 12l-3 2.2" />,
  hDistance: <path d="M4 5v10M20 5v10M4 10h16M4 10l3-2M4 10l3 2M20 10l-3-2M20 10l-3 2M4 19h16" />,
  vDistance: <path d="M5 4h10M5 20h10M10 4v16M10 4 8 7M10 4l2 3M10 20l-2-3M10 20l2-3M19 4v16" />,
  length: <path d="M5 19 19 5M3.5 16.5l3 3M16.5 3.5l3 3M8.5 12.5 11 15M12.5 8.5 15 11" />,
  radius: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M12 12 18 6M18 6h-3.6M18 6v3.6" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  diameter: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.3 17.7 17.7 6.3M6.3 17.7h3.4M6.3 17.7v-3.4M17.7 6.3h-3.4M17.7 6.3v3.4" />
    </>
  ),
  angle: <path d="M4 19h16M4 19 17 7M11 19a7 7 0 0 0-2.4-5.3" />,
  offset: <path d="M4 16h11a5 5 0 0 0 5-5V4M4 20h11a9 9 0 0 0 9-9V4" />,
};

export type GlyphTone = 'placed' | 'hint' | 'selected' | 'conflict' | 'redundant' | 'plain';

const tones: Record<GlyphTone, string> = {
  placed: 'bg-surface text-fully-constrained shadow-[inset_0_0_0_1px_var(--color-border-strong)]',
  hint: 'bg-accent-soft text-accent-text shadow-[inset_0_0_0_1px_var(--color-accent)] [stroke-dasharray:0]',
  selected: 'bg-accent text-accent-fg',
  conflict: 'bg-danger-soft text-danger-text shadow-[inset_0_0_0_1.5px_var(--color-danger)]',
  redundant: 'bg-warning-soft text-warning-text shadow-[inset_0_0_0_1px_var(--color-warning)]',
  plain: 'text-current',
};

export interface ConstraintGlyphProps {
  kind: SketchConstraintKind;
  /** Square edge in px (default 24). */
  size?: number;
  /** `hint` = inferred while drawing (subtle), `placed` = existing constraint. */
  tone?: GlyphTone;
  /** Adds an accessible name; omit for purely decorative use next to a text label. */
  labelled?: boolean;
  className?: string;
}

/** A single constraint glyph. All 21 constraint kinds of `sketch.ts` are covered. */
export function ConstraintGlyph({
  kind,
  size = 24,
  tone = 'placed',
  labelled,
  className,
}: ConstraintGlyphProps) {
  const label = constraintLabels[kind];
  const pad = tone === 'plain' ? 0 : 3;
  return (
    <span
      data-kind={kind}
      data-tone={tone}
      {...(labelled ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      style={{ width: size, height: size, padding: pad }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[7px]',
        tones[tone],
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        width="100%"
        height="100%"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
      >
        {glyphs[kind]}
      </svg>
    </span>
  );
}
