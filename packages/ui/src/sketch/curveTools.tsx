import type { ReactNode } from 'react';
import type { SketchCurveToolId, ToolSpec } from './SketchToolbar';

const ic = 'size-[18px]';

function CurveSvg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** A B-spline: the curve and its dashed control polygon with two control points. */
export function SplineControlIcon({ className }: { className?: string }) {
  return (
    <CurveSvg className={className}>
      <path
        d="M3.5 18 8 6.5 15 17.5 20.5 6"
        strokeDasharray="1.6 2.6"
        strokeWidth="1.4"
        opacity="0.7"
      />
      <path d="M3.5 18C6 9 9 6.5 11.5 12s6 6.5 9-6" />
      <circle cx="8" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
    </CurveSvg>
  );
}

/** A spline through points: the curve passes through the dots. */
export function SplineThroughIcon({ className }: { className?: string }) {
  return (
    <CurveSvg className={className}>
      <path d="M3.5 17C7 17 7.5 7 12 7s5 10 8.5 10" />
      <circle cx="3.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </CurveSvg>
  );
}

export function EllipseIcon({ className }: { className?: string }) {
  return (
    <CurveSvg className={className}>
      <ellipse cx="12" cy="12" rx="9" ry="5.5" transform="rotate(-20 12 12)" />
    </CurveSvg>
  );
}

/** An arc of an ellipse (solid) on its faint full ellipse, with its two end points. */
export function EllipticArcIcon({ className }: { className?: string }) {
  return (
    <CurveSvg className={className}>
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="5.5"
        transform="rotate(-20 12 12)"
        strokeDasharray="1.6 2.6"
        strokeWidth="1.2"
        opacity="0.45"
      />
      <path d="M4.3 14.2A9 5.5 -20 0 0 19.3 9.6" />
      <circle cx="4.3" cy="14.2" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19.3" cy="9.6" r="1.4" fill="currentColor" stroke="none" />
    </CurveSvg>
  );
}

/**
 * M3.5 curve tools as data (ADR-046): the toolbar renders whatever `curveTools` it is given, so the
 * integration can add or hide entries. The shortcuts avoid every drawing and edit tool's key: B and
 * Shift+B for the two B-spline tools, Shift+E and Shift+A for the ellipse and elliptic arc (E and
 * A are Extend and Arc). They are bound by `KeyboardEvent.code` in the keymap; these strings are
 * display and fallback only.
 */
export const sketchCurveTools: readonly (ToolSpec & { id: SketchCurveToolId })[] = [
  {
    id: 'splineControl',
    label: 'Spline (control points)',
    short: 'Spline',
    shortcut: 'B',
    icon: <SplineControlIcon className={ic} />,
  },
  {
    id: 'splineThrough',
    label: 'Spline (through points)',
    short: 'Fit spline',
    shortcut: '⇧B',
    icon: <SplineThroughIcon className={ic} />,
  },
  { id: 'ellipse', label: 'Ellipse', shortcut: '⇧E', icon: <EllipseIcon className={ic} /> },
  {
    id: 'ellipticArc',
    label: 'Elliptic arc',
    short: 'Elliptic arc',
    shortcut: '⇧A',
    icon: <EllipticArcIcon className={ic} />,
  },
];
