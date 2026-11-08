/**
 * Tutorial state machine (PLAN 9.2 "make a bracket in 60 seconds"). Steps advance on a condition
 * the app observes (`advance(stepId)`), never on a "Next" button. A stale advance (for a step that
 * is not current, e.g. a condition firing twice) is ignored, so the app can fire idempotently.
 */

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector of the element to point at (preferred; follows layout changes). */
  target?: string;
  /** Fixed point in px (fallback when the target is a location in the viewport). */
  anchor?: { x: number; y: number };
  /** What completes the step, shown under the body ("Tap the Sketch tool"). */
  hint?: string;
}

export type TutorialStatus = 'running' | 'done' | 'skipped';

export interface TutorialState {
  index: number;
  status: TutorialStatus;
}

export type TutorialAction =
  | { type: 'advance'; from?: string }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'restart' }
  | { type: 'goto'; id: string };

export const initialTutorial: TutorialState = { index: 0, status: 'running' };

export function tutorialReducer(
  steps: readonly TutorialStep[],
  state: TutorialState,
  action: TutorialAction,
): TutorialState {
  // A finished tutorial only accepts restart, or skip (which closes the closing card).
  if (state.status === 'skipped' && action.type !== 'restart') return state;
  if (state.status === 'done' && action.type !== 'restart' && action.type !== 'skip') return state;
  switch (action.type) {
    case 'advance': {
      if (action.from !== undefined && steps[state.index]?.id !== action.from) return state;
      const next = state.index + 1;
      return next >= steps.length
        ? { index: state.index, status: 'done' }
        : { index: next, status: 'running' };
    }
    case 'back':
      return { ...state, index: Math.max(0, state.index - 1) };
    case 'skip':
      return { ...state, status: 'skipped' };
    case 'restart':
      return initialTutorial;
    case 'goto': {
      const i = steps.findIndex((s) => s.id === action.id);
      return i < 0 ? state : { index: i, status: 'running' };
    }
  }
}

export function tutorialProgress(steps: readonly TutorialStep[], state: TutorialState) {
  const total = steps.length;
  const current = state.status === 'done' ? total : Math.min(state.index + 1, total);
  const done = state.status === 'done' ? total : state.index;
  return { current, total, fraction: total === 0 ? 1 : done / total };
}
