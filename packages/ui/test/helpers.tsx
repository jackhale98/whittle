import { render } from '@testing-library/react';
import { domAnimation, LazyMotion } from 'motion/react';
import type { ReactElement } from 'react';
import { TooltipProvider } from '../src';

/** Render with the providers the shells normally supply (motion features + tooltips). */
export function renderUI(ui: ReactElement) {
  return render(
    <LazyMotion features={domAnimation}>
      <TooltipProvider>{ui}</TooltipProvider>
    </LazyMotion>,
  );
}

export { makeEvaluator } from '../harness/fixtures';
