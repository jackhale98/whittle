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
