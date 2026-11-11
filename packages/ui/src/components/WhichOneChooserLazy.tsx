import { lazy, Suspense } from 'react';
import type { WhichOneChooserProps } from './WhichOneChooser';

const load = () => import('./WhichOneChooser').then((m) => ({ default: m.WhichOneChooser }));
const WhichOneChooser = lazy(load);

/** Warms the chunk once the app is idle, so the first ambiguous pick does not wait for it. */
export function prefetchWhichOneChooser(): void {
  void load();
}

/** The "Which one?" chooser, fetched when an ambiguous pick first shows it (ADR-089). */
export function WhichOneChooserLazy(props: WhichOneChooserProps) {
  return (
    <Suspense fallback={null}>
      <WhichOneChooser {...props} />
    </Suspense>
  );
}
