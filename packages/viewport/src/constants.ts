/**
 * Gesture and input thresholds (PLAN §9.3). One place, so tests, docs and the app agree. Times
 * are milliseconds, distances CSS pixels, angles radians.
 */

/** Max press-to-release time of a tap. Also bounds a multi-finger tap (all fingers up in time). */
export const TAP_MAX_MS = 300;
/** A tap may not move further than this between press and release. */
export const TAP_SLOP_PX = 8;
/** Second tap must follow the first within this time ... */
export const DOUBLE_TAP_MAX_MS = 300;
/** ... and land within this distance of it. */
export const DOUBLE_TAP_SLOP_PX = 10;
/** Hold time that turns a press into a long-press. */
export const LONG_PRESS_MS = 500;
/** A long-press is cancelled once the pointer moves further than this. */
export const LONG_PRESS_SLOP_PX = 8;
/** Default palm-rejection window after the last pen contact. */
export const DEFAULT_PALM_REJECT_MS = 500;
/** Two-finger twist below this accumulated angle is ignored (pure pinch/pan jitter). */
export const TWIST_START_RAD = (5 * Math.PI) / 180;
/** Default constant on-screen length of a handle arrow, CSS px. */
export const HANDLE_LENGTH_PX = 84;
/** Extra pick tolerance around a handle arrow (it is thick), CSS px. */
export const HANDLE_PICK_PAD_PX = 8;
/** A long-press timer this late means the main thread stalled; queued pointer moves get a chance first. */
export const LONG_PRESS_JANK_MS = 80;
/** How long to wait for them (once). */
export const LONG_PRESS_GRACE_MS = 60;

// ---- M3.5 navigation (ADR-046) ---------------------------------------------------------------

/** A mouse press that moves further than this starts navigating (and is no longer a click). */
export const NAV_DRAG_PX = 4;
/** `rightOrbitRepeat`: a right click released sooner than this is "repeat last command". */
export const REPEAT_CLICK_MAX_MS = 250;
/**
 * `rightOrbitRepeat`: a right press held at least this long (and not dragged) opens the menu.
 * Between REPEAT_CLICK_MAX_MS and this the press also opens the menu: a dead zone that does
 * nothing would feel like a lost click.
 */
export const MENU_HOLD_MS = 350;
/** Turntable orbit stops this far (radians) short of the poles so the view never flips. */
export const TURNTABLE_POLE_MARGIN = (0.5 * Math.PI) / 180;
/** Allowed `rotateSpeed` range (contract: 0.25-4). */
export const ROTATE_SPEED_MIN = 0.25;
export const ROTATE_SPEED_MAX = 4;
/** Pivot marker diameters, CSS px. */
export const PIVOT_RING_PX = 22;
export const PIVOT_DOT_PX = 8;
/** How long a `setPivot` click shows the marker without a drag, ms. */
export const PIVOT_FLASH_MS = 700;
