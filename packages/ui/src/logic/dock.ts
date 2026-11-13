/**
 * When the tablet's two side panels can dock beside the view and when they must overlay it
 * (ADR-099 amendment). Pure, so the rule is unit-tested and the shell only measures a width.
 */

/** The narrowest view (CSS px) we keep while both panels are docked: the command bar (~330) plus the chips and the view cube. */
export const MIN_VIEW_WIDTH = 480;
/** Left panel's default width, right panel's width and the gutter next to each (px). */
export const LEFT_PANEL_WIDTH = 288;
export const RIGHT_PANEL_WIDTH = 296;
export const PANEL_GUTTER = 8;
/** The shell body's side padding (px, both sides). */
export const BODY_PADDING = 16;

/** The view's width if both panels docked in a body of `bodyWidth` px. */
export function dockedViewWidth(bodyWidth: number, leftWidth = LEFT_PANEL_WIDTH): number {
  return bodyWidth - BODY_PADDING - (leftWidth + PANEL_GUTTER) - (RIGHT_PANEL_WIDTH + PANEL_GUTTER);
}

/** Both panels may dock when the view keeps at least `MIN_VIEW_WIDTH`; otherwise one overlays at a time. */
export function canDockBoth(bodyWidth: number, leftWidth = LEFT_PANEL_WIDTH): boolean {
  return dockedViewWidth(bodyWidth, leftWidth) >= MIN_VIEW_WIDTH;
}

/** The narrowest body width that docks both panels at the default left width (for docs and tests). */
export const DOCK_MIN_WIDTH =
  MIN_VIEW_WIDTH + BODY_PADDING + LEFT_PANEL_WIDTH + RIGHT_PANEL_WIDTH + 2 * PANEL_GUTTER;

/** The drawing route docks its 352 px side panel when the sheet keeps this width: 56 px rail + panel + 480. */
export const DRAWING_DOCK_MIN_WIDTH = 56 + 352 + MIN_VIEW_WIDTH;
