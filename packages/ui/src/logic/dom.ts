import type { Insets } from './bubble';

let probe: HTMLElement | null = null;

/**
 * Safe-area insets in px. `env(safe-area-inset-*)` is only resolvable by CSS, so a hidden probe
 * with `padding: env(...)` is measured. Returns zeros outside a browser.
 */
export function readSafeInsets(): Insets {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!probe?.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;inset:0;width:0;height:0;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return {
    top: px(cs.paddingTop),
    right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft),
  };
}

/**
 * The nearest ancestor of `el` that scrolls vertically (has overflow and room to scroll): a sheet
 * or panel. Never the page itself (the app shell does not scroll) and never a container of the
 * 3D view, whose overlays (sketch dimension fields) must not shift against the canvas.
 */
export function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (p.querySelector('canvas')) return null;
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
