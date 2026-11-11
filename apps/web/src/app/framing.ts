/**
 * Phone framing (PLAN M3.8, "the camera frames the model in the unobstructed area"): the bottom
 * sheet, the top bar and the floating tool stack cover part of the canvas, so the viewport is told
 * which strip each covers (`setFrameInsets`) and re-fits when a mode starts or the sheet changes
 * height. The model then sits centred in what is left, not behind the sheet.
 */

import type { TouchViewport } from '@wren-cad/contracts';
import type { Workbench } from './workbench';

/** The viewport's inset API (packages/viewport `ViewportEngine`; not in the contract yet). */
type InsetViewport = TouchViewport & { setFrameInsets?(i: Partial<Insets>): void };
interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface State {
  sheetPx: number;
  queued: boolean;
}

const states = new WeakMap<Workbench, State>();
const stateOf = (wb: Workbench): State => {
  let s = states.get(wb);
  if (!s) {
    s = { sheetPx: 0, queued: false };
    states.set(wb, s);
  }
  return s;
};

/** Gap kept between the framed model and the chrome around it. */
const GAP = 8;

/** The part of the canvas covered by the top bar, the sheet and the floating tool stack (px). */
export function measureInsets(wb: Workbench): Insets | null {
  const canvas = wb.canvas;
  if (!canvas || wb.tier !== 'phone') return null;
  const c = canvas.getBoundingClientRect();
  if (c.height === 0) return null;
  const bar = document.querySelector('[data-testid="top-bar"]')?.getBoundingClientRect();
  let bottom = stateOf(wb).sheetPx;
  const stack = document.querySelector('[data-testid="overlay-stack"]');
  if (stack && stack.childElementCount > 0) {
    const r = stack.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, c.bottom - r.top + GAP);
  }
  return {
    top: bar ? Math.max(0, bar.bottom - c.top + GAP) : 0,
    right: 0,
    bottom,
    left: 0,
  };
}

function apply(wb: Workbench): boolean {
  const v = wb.viewport as InsetViewport | null;
  const ins = measureInsets(wb);
  if (!v?.setFrameInsets || !ins) return false;
  v.setFrameInsets(ins);
  return true;
}

/** Sets the insets as soon as the viewport exists (before the first body is fitted). */
export function syncFrameInsets(wb: Workbench): void {
  apply(wb);
}

/** The sheet's visible height changed (reported by the shell): re-frame once it has. */
export function onSheetHeight(wb: Workbench, px: number): void {
  const s = stateOf(wb);
  const first = s.sheetPx === 0;
  if (s.sheetPx === px) return;
  s.sheetPx = px;
  if (first) apply(wb);
  else reframeSoon(wb);
}

/** Re-frames the model in the free area on the next microtask (calls in one tick coalesce). */
export function reframeSoon(wb: Workbench): void {
  if (wb.tier !== 'phone') return;
  const s = stateOf(wb);
  if (s.queued) return;
  s.queued = true;
  queueMicrotask(() => {
    s.queued = false;
    // After React commits the same state change (chip hidden, sheet tab shown).
    requestAnimationFrame(() => {
      if (apply(wb)) wb.viewport?.fitAll(true);
    });
  });
}
