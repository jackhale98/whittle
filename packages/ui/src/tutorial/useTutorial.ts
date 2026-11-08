import { useReducer } from 'react';
import {
  initialTutorial,
  type TutorialAction,
  type TutorialState,
  type TutorialStep,
  tutorialReducer,
} from '../logic/tutorial';

export interface TutorialController {
  state: TutorialState;
  step: TutorialStep | undefined;
  /** Call when the condition of the current step is met. Pass the step id to make it idempotent. */
  advance(from?: string): void;
  back(): void;
  skip(): void;
  restart(): void;
  goto(id: string): void;
}

/**
 * State machine for a step list: `advance()` is driven by the app, never by a "Next" button.
 * `initial` defaults to running from the first step; pass `{ index: 0, status: 'skipped' }` to
 * offer the tutorial and start it later with `restart()`.
 */
export function useTutorial(
  steps: readonly TutorialStep[],
  initial: TutorialState = initialTutorial,
): TutorialController {
  const [state, dispatch] = useReducer(
    (s: TutorialState, a: TutorialAction) => tutorialReducer(steps, s, a),
    initial,
  );
  return {
    state,
    step: steps[state.index],
    advance: (from) => dispatch({ type: 'advance', from }),
    back: () => dispatch({ type: 'back' }),
    skip: () => dispatch({ type: 'skip' }),
    restart: () => dispatch({ type: 'restart' }),
    goto: (id) => dispatch({ type: 'goto', id }),
  };
}
