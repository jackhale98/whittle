/**
 * Pan and zoom of the sheet viewer (pure). The sheet is in mm with y up; the screen is in px with
 * y down. `View2D` maps the sheet's top-left corner and the scale: `screen = origin + k * (X, H - Y)`.
 */

export interface View2D {
  /** px per mm. */
  k: number;
  /** Screen position (px) of the sheet's top-left corner. */
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_FIT_FACTOR = 0.4;
export const MAX_K = 60;

/** The view that fits a sheet into a viewport with `pad` px around it. */
export function fitView(sheet: Size, box: Size, pad = 16): View2D {
  const k = Math.max(0.01, Math.min((box.w - 2 * pad) / sheet.w, (box.h - 2 * pad) / sheet.h));
  return { k, x: (box.w - sheet.w * k) / 2, y: (box.h - sheet.h * k) / 2 };
}

const clampK = (k: number, fit: number): number =>
  Math.min(MAX_K, Math.max(fit * MIN_FIT_FACTOR, k));

/** Zooms by `factor` keeping the screen point `at` fixed. */
export function zoomAt(
  v: View2D,
  factor: number,
  at: { x: number; y: number },
  fit: number,
): View2D {
  const k = clampK(v.k * factor, fit);
  const f = k / v.k;
  return { k, x: at.x - (at.x - v.x) * f, y: at.y - (at.y - v.y) * f };
}

export const panBy = (v: View2D, dx: number, dy: number): View2D => ({
  ...v,
  x: v.x + dx,
  y: v.y + dy,
});

/** Screen px → sheet mm (y up). */
export function toSheet(v: View2D, sheet: Size, p: { x: number; y: number }): [number, number] {
  return [(p.x - v.x) / v.k, sheet.h - (p.y - v.y) / v.k];
}

/** Sheet mm (y up) → screen px. */
export function toScreen(
  v: View2D,
  sheet: Size,
  p: readonly [number, number],
): { x: number; y: number } {
  return { x: v.x + p[0] * v.k, y: v.y + (sheet.h - p[1]) * v.k };
}

/** Two-finger gesture: scale by the change in distance, move with the midpoint. */
export function pinch(
  v: View2D,
  from: { a: { x: number; y: number }; b: { x: number; y: number } },
  to: { a: { x: number; y: number }; b: { x: number; y: number } },
  fit: number,
): View2D {
  const d0 = Math.hypot(from.a.x - from.b.x, from.a.y - from.b.y) || 1;
  const d1 = Math.hypot(to.a.x - to.b.x, to.a.y - to.b.y) || 1;
  const m0 = { x: (from.a.x + from.b.x) / 2, y: (from.a.y + from.b.y) / 2 };
  const m1 = { x: (to.a.x + to.b.x) / 2, y: (to.a.y + to.b.y) / 2 };
  const z = zoomAt(v, d1 / d0, m0, fit);
  return panBy(z, m1.x - m0.x, m1.y - m0.y);
}

/** A zoom level as a readable percentage of the fitted sheet. */
export const zoomPercent = (v: View2D, fit: number): number => Math.round((v.k / fit) * 100);
