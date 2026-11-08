/**
 * Motion presets (PLAN 9.5). Components use these presets only, never ad-hoc durations/springs.
 * `fast` (~180 ms): hover/press feedback, popovers, toggles.
 * `standard` (~260 ms): panels, sheets, dialogs, layout changes.
 */

import { type Transition, useReducedMotion } from 'motion/react';

export const springs = {
  fast: { type: 'spring', duration: 0.18, bounce: 0 },
  standard: { type: 'spring', duration: 0.26, bounce: 0.1 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof springs;

/** Transition used when the user prefers reduced motion: state changes apply immediately. */
export const reducedTransition = { duration: 0 } as const satisfies Transition;

/** Pure form of {@link useSpring}; handy for tests and non-React callers. */
export function resolveTransition(name: SpringName, reduced: boolean): Transition {
  return reduced ? reducedTransition : springs[name];
}

/** The transition for a preset, collapsing to an instant change under `prefers-reduced-motion`. */
export function useSpring(name: SpringName): Transition {
  return resolveTransition(name, useReducedMotion() === true);
}

export { useReducedMotion };
