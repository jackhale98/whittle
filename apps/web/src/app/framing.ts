/**
 * Framing (PLAN M3.8, "the camera frames the model in the unobstructed area"): the phone's bottom
 * sheet, top bar and floating tool stack, and the tablet's overlaid side panels (ADR-099) cover
 * part of the canvas, so the viewport is told which strip each covers (`setFrameInsets`). Docked
 * panels resize the canvas instead and need no insets. A mode start (section, measure) re-fits; a sheet
 * change only shifts the camera (the viewport trucks inside `setFrameInsets`, keeping zoom and
 * orientation, ADR-086 amendment), so the user's zoom and pan survive the sheet moving.
 */

import type { TouchViewport } from '@wren-cad/contracts';
import type { Workbench } from './workbench';

/** The viewport's inset API: `TouchViewport.setFrameInsets` (optional in the contract, ADR-086). */
type InsetViewport = TouchViewport;
interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface State {
  sheetPx: number;
  /** Px of the canvas an overlaid side panel covers (tablet, narrow widths). */
  overlay: { left: number; right: number };
  /** An overlay has covered the canvas at least once: from then on zeros are sent too. */
  overlayUsed: boolean;
  queued: boolean;
}

const states = new WeakMap<Workbench, State>();
const stateOf = (wb: Workbench): State => {
  let s = states.get(wb);
  if (!s) {
    s = { sheetPx: 0, overlay: { left: 0, right: 0 }, overlayUsed: false, queued: false };
    states.set(wb, s);
  }
  return s;
};

/** Gap kept between the framed model and the chrome around it. */
const GAP = 8;

/** The part of the canvas covered by the top bar, the sheet and the floating tool stack (px). */
export function measureInsets(wb: Workbench): Insets | null {
  const canvas = wb.canvas;
  if (!canvas) return null;
  const c = canvas.getBoundingClientRect();
  if (c.height === 0) return null;
  // Desktop and tablet: only an overlaid side panel covers the canvas (the top bar is outside it).
  if (wb.tier !== 'phone') {
    const s = stateOf(wb);
    if (!s.overlayUsed) return null; // desktop and a docked tablet never touch the insets
    return { top: 0, right: s.overlay.right, bottom: 0, left: s.overlay.left };
  }
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

/** The sheet's visible height changed (reported by the shell): shift the view, never re-fit. */
export function onSheetHeight(wb: Workbench, px: number): void {
  const s = stateOf(wb);
  if (s.sheetPx === px) return;
  s.sheetPx = px;
  apply(wb);
}

/** An overlaid side panel's covered width changed (reported by the shell each frame): shift the view, never re-fit. */
export function onOverlayInsets(wb: Workbench, insets: { left: number; right: number }): void {
  const s = stateOf(wb);
  if (s.overlay.left === insets.left && s.overlay.right === insets.right) return;
  s.overlay = { left: insets.left, right: insets.right };
  if (insets.left + insets.right > 0) s.overlayUsed = true;
  apply(wb);
}

/** Re-frames the model in the free area on the next microtask (calls in one tick coalesce). */
export function reframeSoon(wb: Workbench): void {
  const s = stateOf(wb);
  // Desktop and a docked tablet have nothing over the canvas: their fits stay as they were.
  if (wb.tier !== 'phone' && s.overlay.left + s.overlay.right === 0) return;
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
