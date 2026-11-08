/**
 * Bottom-sheet snapping (PLAN 9.1): three snap points, a drag with rubber-banding at the ends, and a
 * fling that is projected forward (a short inertial glide) before choosing the nearest snap.
 * Pure functions: the component only feeds pointer samples in and animates to the answer.
 *
 * All heights are the *visible* height of the sheet in px (what sticks out above the bottom edge).
 */

export type SheetSnap = 'peek' | 'half' | 'full';
export const SHEET_SNAPS: readonly SheetSnap[] = ['peek', 'half', 'full'];

export type SnapHeights = Record<SheetSnap, number>;

export interface SnapInput {
  /** Height of the area the sheet lives in. */
  container: number;
  /** Visible height when collapsed (handle + header). */
  peek: number;
  /** Fraction of the container shown at `half` (default 0.45). */
  halfRatio?: number;
  /** Space kept free above the sheet at `full` (top bar etc.). */
  topGap?: number;
  /** Upper bound for `half`. */
  halfMax?: number;
}

/** Visible heights per snap. Always peek <= half <= full, and full never exceeds the container. */
export function snapHeights({
  container,
  peek,
  halfRatio = 0.45,
  topGap = 72,
  halfMax = Number.POSITIVE_INFINITY,
}: SnapInput): SnapHeights {
  const full = Math.max(peek, container - topGap);
  const half = Math.min(Math.max(peek, Math.round(container * halfRatio)), halfMax, full);
  return { peek: Math.min(peek, full), half, full };
}

/** Time (ms) a fling keeps gliding: matches the `fast` motion preset (180 ms). */
export const INERTIA_MS = 180;
/** px/ms above which a fling always moves at least one snap point. */
export const FLING_VELOCITY = 0.55;

export interface PointerSample {
  y: number;
  t: number;
}

/** Velocity in px/ms (positive = moving down) from the last ~100 ms of samples. */
export function estimateVelocity(samples: readonly PointerSample[], windowMs = 100): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i];
    if (!s || last.t - s.t > windowMs) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt <= 0 ? 0 : (last.y - first.y) / dt;
}

/** Visible height while dragging: linear inside [min, max], with resistance outside. */
export function rubberBand(visible: number, min: number, max: number, stiffness = 0.35): number {
  if (visible > max) return max + (visible - max) * stiffness;
  if (visible < min) return min - (min - visible) * stiffness;
  return visible;
}

export function nearestSnap(visible: number, heights: SnapHeights): SheetSnap {
  let best: SheetSnap = 'peek';
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of SHEET_SNAPS) {
    const d = Math.abs(heights[s] - visible);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** One snap up (+1) or down (-1), clamped. */
export function stepSnap(from: SheetSnap, dir: 1 | -1): SheetSnap {
  const i = SHEET_SNAPS.indexOf(from) + dir;
  return SHEET_SNAPS[Math.min(SHEET_SNAPS.length - 1, Math.max(0, i))] ?? from;
}

/** The snap to settle on after releasing at `visible` with `velocity` px/ms (positive = downward). */
export function settleSnap(
  visible: number,
  velocity: number,
  heights: SnapHeights,
  from: SheetSnap,
): SheetSnap {
  const projected = visible - velocity * INERTIA_MS;
  let target = nearestSnap(projected, heights);
  if (target === from && Math.abs(velocity) >= FLING_VELOCITY) {
    target = stepSnap(from, velocity < 0 ? 1 : -1);
  }
  return target;
}

/** What a click/tap on the handle does: peek opens to half, anything else collapses. */
export function toggleSnap(from: SheetSnap): SheetSnap {
  return from === 'peek' ? 'half' : 'peek';
}
