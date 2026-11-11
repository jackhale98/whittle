/**
 * Drag a parameter onto a value (ADR-080): mouse, touch and Pencil through pointer events (HTML5
 * drag and drop does not fire for touch). A drop target is any element carrying `data-param-drop`
 * that registered a handler; the element under the pointer is found with `elementsFromPoint`, so
 * it works over the viewport's HTML overlays too. Nothing here touches React, so the small
 * registry can live in the initial chunk while the dragging chip lives with the Params tab.
 */

/** Returns false when it refused the parameter (it may still show why). */
type Handler = (name: string) => boolean | undefined;

const targets = new WeakMap<Element, Handler>();

/** Makes `el` accept dropped parameters. Returns the unregister function. */
export function registerParamDrop(el: Element, handler: Handler): () => void {
  el.setAttribute('data-param-drop', '');
  targets.set(el, handler);
  return () => {
    if (targets.get(el) === handler) {
      targets.delete(el);
      el.removeAttribute('data-param-drop');
    }
  };
}

export interface ParamDragState {
  name: string;
  x: number;
  y: number;
  /** The drop target under the pointer, if any. */
  over: boolean;
}

let state: ParamDragState | null = null;
const listeners = new Set<() => void>();

export function subscribeParamDrag(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export function getParamDrag(): ParamDragState | null {
  return state;
}
function set(next: ParamDragState | null) {
  state = next;
  for (const l of listeners) l();
}

/** Pointer travel (px) before a press on the handle becomes a drag. */
export const PARAM_DRAG_SLOP = 4;

function targetAt(x: number, y: number): HTMLElement | null {
  const stack = document.elementsFromPoint?.(x, y) ?? [];
  for (const el of stack) {
    const t = (el as HTMLElement).closest?.<HTMLElement>('[data-param-drop]');
    if (t && targets.has(t)) return t;
  }
  return null;
}

let hot: HTMLElement | null = null;
function heat(el: HTMLElement | null) {
  if (hot === el) return;
  hot?.removeAttribute('data-drop-hot');
  hot = el;
  el?.setAttribute('data-drop-hot', '');
}

/**
 * Starts tracking a press on a parameter's drag handle. Returns a cleanup. `onDrop` runs after the
 * target's own handler, with whether anything accepted the parameter.
 */
export function beginParamDrag(
  e: { clientX: number; clientY: number; pointerId: number; button?: number },
  name: string,
  onEnd?: (dropped: boolean) => void,
): () => void {
  if (e.button !== undefined && e.button !== 0) return () => {};
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!active) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < PARAM_DRAG_SLOP) return;
      active = true;
      document.documentElement.setAttribute('data-param-dragging', name);
    }
    const t = targetAt(ev.clientX, ev.clientY);
    heat(t);
    set({ name, x: ev.clientX, y: ev.clientY, over: t !== null });
  };
  const finish = (ev: PointerEvent, cancelled: boolean) => {
    if (ev.pointerId !== e.pointerId) return;
    stop();
    if (!active) return;
    const t = cancelled ? null : targetAt(ev.clientX, ev.clientY);
    const handler = t ? targets.get(t) : undefined;
    // The click that follows a drag must not activate the handle.
    // The window is captured, not looked up later: the cleanup can outlive the page (or a test's
    // DOM environment), and must never throw from a stray timer.
    const win = ev.view ?? (typeof window === 'undefined' ? null : window);
    const swallow = (c: Event) => c.stopPropagation();
    win?.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => win?.removeEventListener('click', swallow, true), 60);
    const accepted = handler ? handler(name) !== false : false;
    onEnd?.(accepted);
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const cancel = (ev: PointerEvent) => finish(ev, true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && active) {
      ev.stopPropagation();
      stop();
      onEnd?.(false);
    }
  };
  function stop() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    document.documentElement.removeAttribute('data-param-dragging');
    heat(null);
    set(null);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  return stop;
}
