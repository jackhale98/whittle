/**
 * Installed-PWA page guards (PLAN §12 M2: no browser chrome or page zoom interferes).
 *
 * iOS Safari ignores `user-scalable=no` and `maximum-scale`, so pinch-zoom of the page is blocked
 * here: `gesture*` events (Safari-only, fire for the page-zoom pinch) are cancelled, as are
 * multi-touch `touchmove`s that would zoom. Double-tap zoom is prevented in CSS with
 * `touch-action: manipulation` on the root (src/index.css). The viewport canvas keeps
 * `touch-action: none` and drives its own camera from pointer events, which are unaffected by
 * cancelling touch/gesture events.
 */

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/** Installs the guards; returns an uninstall function. Safe to call in non-browser contexts. */
export function installPageGuards(doc: Document | undefined = globalThis.document): () => void {
  if (!doc) return () => {};
  const block = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const blockMultiTouchMove = (e: TouchEvent): void => {
    if (e.touches.length > 1 && e.cancelable) e.preventDefault();
  };
  for (const type of GESTURE_EVENTS) doc.addEventListener(type, block, { passive: false });
  doc.addEventListener('touchmove', blockMultiTouchMove, { passive: false });
  return () => {
    for (const type of GESTURE_EVENTS) doc.removeEventListener(type, block);
    doc.removeEventListener('touchmove', blockMultiTouchMove);
  };
}
