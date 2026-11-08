import { lazy, Suspense } from 'react';
import type { ConflictPanelProps } from './ConflictPanel';

const Impl = lazy(() => import('./ConflictPanel'));

export type { ConflictPanelProps };

/** Code-split wrapper: the panel's chunk is only fetched when a sketch first goes over-constrained. */
export function ConflictPanel(props: ConflictPanelProps) {
  if (props.conflicts.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
