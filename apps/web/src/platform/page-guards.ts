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

const SCROLLABLE = /(auto|scroll)/;

/** Movement (CSS px) under which an Apple Pencil touch is still a tap, not a drag. */
export const STYLUS_TAP_SLOP_PX = 10;

/** WebKit's `Touch.touchType` is `'stylus'` for the Apple Pencil. */
function isStylus(t: Touch): boolean {
  return (t as Touch & { touchType?: string }).touchType === 'stylus';
}

/**
 * True when a one-finger move of (dx, dy) px starting on `target` would scroll an element that
 * can still scroll that way (a panel list, the sheet content). Anything else would move the page
 * itself (iOS lets a `overflow: hidden` page be dragged), so the guard cancels it.
 */
export function canScroll(target: EventTarget | null, dx: number, dy: number): boolean {
  for (let el = target as Element | null; el && el.nodeType === 1; el = el.parentElement) {
    if (el.matches('input, textarea, [contenteditable="true"]')) return true; // caret / selection
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    const cs = getComputedStyle(el);
    const vertical = Math.abs(dy) >= Math.abs(dx);
    if (vertical && SCROLLABLE.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      // Finger moving down scrolls content up (towards scrollTop 0), and vice versa.
      if (dy > 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)
        return true;
    }
    if (!vertical && SCROLLABLE.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
        return true;
    }
  }
  return false;
}

function isField(el: Element | null | undefined): boolean {
  return (
    !!el && el.nodeType === 1 && el.matches('input, textarea, select, [contenteditable="true"]')
  );
}

/** Scrolls the (pinned) page and its root back to the origin after the keyboard moved them. */
export function resetPagePosition(doc: Document): void {
  const win = doc.defaultView;
  if (win && (win.scrollX !== 0 || win.scrollY !== 0)) win.scrollTo(0, 0);
  const root = doc.scrollingElement ?? doc.documentElement;
  if (root && (root.scrollTop !== 0 || root.scrollLeft !== 0)) {
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }
  if (doc.body && doc.body.scrollTop !== 0) doc.body.scrollTop = 0;
}

/** Installs the guards; returns an uninstall function. Safe to call in non-browser contexts. */
export function installPageGuards(doc: Document | undefined = globalThis.document): () => void {
  if (!doc) return () => {};
  const block = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  let start: { x: number; y: number } | null = null;
  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (!e.cancelable) return;
    if (e.touches.length > 1) {
      e.preventDefault(); // page pinch-zoom
      return;
    }
    // One finger: only scrollable panels may move; never the page (rubber-band, sheet drags
    // dragging the whole screen). Pointer events keep flowing, so canvas and sheet drags work.
    const t = e.touches[0];
    if (!t || !start) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // The Apple Pencil reports sub-pixel moves during a tap (a finger's jitter is filtered).
    // Cancelling those cancels the tap on iOS, so buttons never got the Pencil's clicks: a
    // stylus only counts as a drag past a small slop.
    if (isStylus(t) && Math.hypot(dx, dy) < STYLUS_TAP_SLOP_PX) return;
    if (!canScroll(e.target, dx, dy)) e.preventDefault();
  };
  // The on-screen keyboard: iOS slides the page up to show the focused field and often leaves it
  // there after the keyboard closes. Once no field has focus any more, put the page back.
  const win = doc.defaultView;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const onFocusOut = (): void => {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (isField(doc.activeElement)) return; // focus moved to another field
      resetPagePosition(doc);
    }, 50);
  };
  const onViewportResize = (): void => {
    if (!isField(doc.activeElement)) resetPagePosition(doc);
  };
  for (const type of GESTURE_EVENTS) doc.addEventListener(type, block, { passive: false });
  doc.addEventListener('touchstart', onTouchStart, { passive: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('focusout', onFocusOut);
  win?.visualViewport?.addEventListener('resize', onViewportResize);
  return () => {
    clearTimeout(resetTimer);
    for (const type of GESTURE_EVENTS) doc.removeEventListener(type, block);
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('focusout', onFocusOut);
    win?.visualViewport?.removeEventListener('resize', onViewportResize);
  };
}
