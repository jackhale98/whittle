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
/**
 * A long-press timer later than this means the main thread was busy at the deadline: queued
 * pointer input (a lift, a move) gets a chance first. A little above normal timer jitter; 80 ms
 * let a timer 28 ms late beat a queued lift on a loaded phone.
 */
export const LONG_PRESS_JANK_MS = 12;
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

// ---- Wheel zoom (ADR-057 addendum) ------------------------------------------------------------

/** One wheel notch in CSS px of `deltaY` (a mouse notch reports 100). */
export const WHEEL_NOTCH_PX = 100;
/** Camera-to-anchor distance after one notch zooming in (0.85 = 15 % closer, every notch). */
export const WHEEL_ZOOM_PER_NOTCH = 0.85;
/** A single wheel event never zooms more than this many notches (a fast flick, a free-spin wheel). */
export const WHEEL_MAX_NOTCHES_PER_EVENT = 3;
/** `deltaMode` 1 (lines): Firefox reports 3 lines for a notch. */
export const WHEEL_LINES_PER_NOTCH = 3;
/**
 * Time constant of the wheel ease, seconds. The ease is exponential in the log of the distance,
 * so it is frame-rate independent: 28 % of a notch lands on the first 60 Hz frame and 95 % after
 * about 3 tau (150 ms). Reduced motion applies a notch at once.
 */
export const WHEEL_SMOOTH_TAU_S = 0.05;
/** The zoom anchor is kept while the cursor stays this close to where it was picked, CSS px ... */
export const WHEEL_ANCHOR_SLOP_PX = 3;
/** ... and the wheel was last turned less than this long ago, ms. */
export const WHEEL_ANCHOR_HOLD_MS = 400;
/** Closest the camera comes to the anchor, as a fraction of the scene radius (near plane: 0.002). */
export const WHEEL_MIN_DISTANCE_RADII = 0.005;
/** Furthest the camera goes from the anchor, in scene radii. */
export const WHEEL_MAX_DISTANCE_RADII = 200;
/**
 * Rest work (ID-buffer refresh, BVH prebuild) waits until the camera has been still this long, so
 * it never lands between two wheel notches. `whenPickReady()` skips the wait.
 */
export const REST_WORK_DEBOUNCE_MS = 220;
/**
 * A BVH build for a large model (over NAV_SYNC_BVH_TRIANGLES) is one task of hundreds of ms and
 * cannot be interrupted, so it only starts after this long without wheel or camera activity
 * (longer than the pauses of a person turning a wheel).
 */
export const BVH_PREBUILD_QUIET_MS = 1500;
