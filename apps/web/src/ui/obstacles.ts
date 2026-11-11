/**
 * Collision-aware placement inputs (PLAN M3.8): the floating chrome an anchored overlay must stay
 * clear of, measured from the DOM in stage px. Priority, high to low: the shell chrome (top bar,
 * rail, sheets, view cube, Library), the bottom stack (prompt, section chip, sketch toolbar,
 * toast), inline value fields (extrude depth, push/pull), then the context bubble. An overlay
 * avoids everything above it.
 */

import type { Rect } from '@wren-cad/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Workbench } from '../app/workbench';

const CHROME = [
  '[data-testid="top-bar"]',
  '[aria-label="Modeling tools"]',
  '[data-testid$="-sheet"]',
  '[data-testid="view-cube"]',
  '[data-testid="library-button"]',
  '[data-testid="keypad"]',
  '[data-testid="overlay-stack"] > *',
];
const VALUE_FIELDS = ['[data-testid="extrude-depth"]', '[data-testid="value-chip"]'];

/** `values`: also keep clear of the inline value fields (for the context bubble). */
export function chromeObstacles(wb: Workbench, values = false): Rect[] {
  const stage = wb.canvas?.getBoundingClientRect();
  if (!stage) return [];
  const out: Rect[] = [];
  const sel = (values ? [...CHROME, ...VALUE_FIELDS] : CHROME).join(', ');
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0)
      out.push({
        left: r.left - stage.left,
        top: r.top - stage.top,
        width: r.width,
        height: r.height,
      });
  }
  return out;
}

/**
 * The obstacles for an overlay that renders now. Other overlays commit in the same pass, so the
 * DOM is measured again after commit and the host re-renders once if anything moved.
 */
export function useChromeObstacles(wb: Workbench, values = false): Rect[] {
  const seen = useRef('');
  const [, relayout] = useState(0);
  const now = chromeObstacles(wb, values);
  seen.current = JSON.stringify(now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured after every commit on purpose
  useLayoutEffect(() => {
    if (JSON.stringify(chromeObstacles(wb, values)) !== seen.current) relayout((n) => n + 1);
  });
  return now;
}
