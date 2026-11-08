import { lazy, Suspense } from 'react';
import type { TutorialProps } from './Tutorial';

const Tutorial = lazy(() => import('./Tutorial'));

export type { TutorialProps };

/** The coach marks, fetched only when a tutorial is actually running. */
export function TutorialCoach(props: TutorialProps) {
  if (props.state.status === 'skipped') return null;
  return (
    <Suspense fallback={null}>
      <Tutorial {...props} />
    </Suspense>
  );
}
