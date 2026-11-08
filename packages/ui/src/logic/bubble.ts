/**
 * Placement of floating UI next to a point (context bubble, value chip, keypad).
 * Rules: stay inside the safe area, flip to the opposite side when there is no room, and never
 * cover the anchor (a keep-out disc around it).
 */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Side = 'above' | 'below' | 'right' | 'left';

export interface BubbleInput {
  anchor: Point;
  size: Size;
  /** Size of the area the bubble is positioned in (same coordinate system as the anchor). */
  viewport: Size;
  insets?: Insets;
  /** Gap between the anchor's keep-out disc and the bubble. */
  gap?: number;
  /** Radius of the keep-out disc around the anchor. */
  anchorRadius?: number;
  preferred?: Side;
  /** The side used last frame: kept while it still fits, so the bubble does not flicker. */
  previous?: Side;
  /** Other UI the bubble should stay clear of (rails, top bar). */
  obstacles?: readonly Rect[];
}

export interface BubblePlacement {
  left: number;
  top: number;
  side: Side;
  /** Where the pointer tip is, relative to the bubble's top-left (for the little arrow). */
  tip: Point;
  /** True when no side had room and the bubble was pushed to fit. */
  squeezed: boolean;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const ORDER: Record<Side, Side[]> = {
  above: ['above', 'below', 'right', 'left'],
  below: ['below', 'above', 'right', 'left'],
  right: ['right', 'left', 'above', 'below'],
  left: ['left', 'right', 'above', 'below'],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

export function placeBubble(input: BubbleInput): BubblePlacement {
  const {
    anchor,
    size,
    viewport,
    insets = NO_INSETS,
    gap = 12,
    anchorRadius = 14,
    preferred = 'above',
    previous,
    obstacles = [],
  } = input;
  const minX = insets.left;
  const maxX = viewport.w - insets.right - size.w;
  const minY = insets.top;
  const maxY = viewport.h - insets.bottom - size.h;
  const away = gap + anchorRadius;
  const keepOut: Rect = {
    left: anchor.x - anchorRadius,
    top: anchor.y - anchorRadius,
    width: anchorRadius * 2,
    height: anchorRadius * 2,
  };

  const candidate = (side: Side): { left: number; top: number; fits: boolean } => {
    let left: number;
    let top: number;
    let fits: boolean;
    if (side === 'above' || side === 'below') {
      left = clamp(anchor.x - size.w / 2, minX, maxX);
      top = side === 'above' ? anchor.y - away - size.h : anchor.y + away;
      fits = top >= minY && top <= maxY;
    } else {
      top = clamp(anchor.y - size.h / 2, minY, maxY);
      left = side === 'left' ? anchor.x - away - size.w : anchor.x + away;
      fits = left >= minX && left <= maxX;
    }
    const box = (l: number, t: number): Rect => ({
      left: l,
      top: t,
      width: size.w,
      height: size.h,
    });
    const clear = (r: Rect) =>
      !rectsIntersect(r, keepOut) && !obstacles.some((o) => rectsIntersect(r, o));
    if (fits && !clear(box(left, top))) {
      // Slide along the cross axis to just past an obstacle (e.g. a top bar), if that clears.
      const slide: Array<[number, number]> = [];
      for (const o of obstacles) {
        if (side === 'above' || side === 'below') {
          slide.push([o.left + o.width + 6, top], [o.left - size.w - 6, top]);
        } else {
          slide.push([left, o.top + o.height + 6], [left, o.top - size.h - 6]);
        }
      }
      const hit = slide.find(([l, t]) => {
        const inside =
          l >= minX &&
          l <= maxX &&
          t >= minY &&
          t <= maxY &&
          (side === 'above' || side === 'below'
            ? Math.abs(l + size.w / 2 - anchor.x) < size.w / 2 + anchorRadius
            : Math.abs(t + size.h / 2 - anchor.y) < size.h / 2 + anchorRadius);
        return inside && clear(box(l, t));
      });
      if (hit) return { left: hit[0], top: hit[1], fits: true };
      fits = false;
    }
    return { left, top, fits };
  };

  function finish(left: number, top: number, side: Side, squeezed: boolean): BubblePlacement {
    const pad = 16;
    const tip: Point =
      side === 'above'
        ? { x: clamp(anchor.x - left, pad, size.w - pad), y: size.h }
        : side === 'below'
          ? { x: clamp(anchor.x - left, pad, size.w - pad), y: 0 }
          : side === 'left'
            ? { x: size.w, y: clamp(anchor.y - top, pad, size.h - pad) }
            : { x: 0, y: clamp(anchor.y - top, pad, size.h - pad) };
    return { left: Math.round(left), top: Math.round(top), side, tip, squeezed };
  }

  const order = previous
    ? [previous, ...ORDER[preferred].filter((s) => s !== previous)]
    : ORDER[preferred];
  for (const side of order) {
    const c = candidate(side);
    if (c.fits) return finish(c.left, c.top, side, false);
  }

  // Nothing fits cleanly (small viewport): take the roomiest side, clamp, then slide sideways out
  // of the keep-out disc so the anchor stays visible.
  const room: Record<Side, number> = {
    above: anchor.y - minY,
    below: viewport.h - insets.bottom - anchor.y,
    left: anchor.x - minX,
    right: viewport.w - insets.right - anchor.x,
  };
  const side = (Object.keys(room) as Side[]).reduce((a, b) => (room[b] > room[a] ? b : a));
  const base = candidate(side);
  let left = clamp(base.left, minX, maxX);
  let top = clamp(base.top, minY, maxY);
  if (rectsIntersect({ left, top, width: size.w, height: size.h }, keepOut)) {
    if (side === 'above' || side === 'below') {
      const leftRoom = keepOut.left - minX;
      const rightRoom = viewport.w - insets.right - (keepOut.left + keepOut.width);
      left = leftRoom >= rightRoom ? keepOut.left - size.w : keepOut.left + keepOut.width;
      left = clamp(left, minX, maxX);
    } else {
      const upRoom = keepOut.top - minY;
      const downRoom = viewport.h - insets.bottom - (keepOut.top + keepOut.height);
      top = upRoom >= downRoom ? keepOut.top - size.h : keepOut.top + keepOut.height;
      top = clamp(top, minY, maxY);
    }
  }
  return finish(left, top, side, true);
}

export type KeypadPlacement = 'below' | 'above' | 'beside' | 'dock';

export interface KeypadPosition {
  placement: KeypadPlacement;
  left: number;
  top: number;
  /** The keypad would hide the field where it is now (only until the caller scrolls it). */
  coversField: boolean;
  /**
   * px to scroll the field's container (positive: the field moves up) so the field sits just
   * above the docked keypad. Non-zero only with `coversField`.
   */
  scrollBy: number;
}

/**
 * Where the numeric keypad goes relative to the field it edits, in order: below, above, beside
 * (right, then left: landscape phones are wide but short), docked to the bottom or the top edge
 * clear of the field. The caller switches to the compact layout when it gets `dock` and tries
 * again. When even that would cover the field (a short landscape viewport with the field in the
 * middle), the result is the bottom dock plus `scrollBy`, the distance to scroll the field up to
 * just above it: the field is never left under the keypad.
 */
export function placeKeypad(
  field: Rect,
  size: Size,
  viewport: Size,
  insets: Insets = NO_INSETS,
  gap = 8,
): KeypadPosition {
  const minX = insets.left + 8;
  const maxX = viewport.w - insets.right - size.w - 8;
  const minY = insets.top + 8;
  const maxY = viewport.h - insets.bottom - size.h - 8;
  const left = clamp(field.left, minX, maxX);
  const at = (placement: KeypadPlacement, l: number, top: number): KeypadPosition => ({
    placement,
    left: l,
    top,
    coversField: false,
    scrollBy: 0,
  });
  const belowTop = field.top + field.height + gap;
  if (belowTop <= maxY) return at('below', left, belowTop);
  const aboveTop = field.top - gap - size.h;
  if (aboveTop >= minY) return at('above', left, aboveTop);
  if (maxY >= minY) {
    const sideTop = clamp(field.top + field.height / 2 - size.h / 2, minY, maxY);
    const right = field.left + field.width + gap;
    if (right <= maxX) return at('beside', right, sideTop);
    const leftOf = field.left - gap - size.w;
    if (leftOf >= minX) return at('beside', leftOf, sideTop);
  }
  const overlaps = (top: number) => top < field.top + field.height && top + size.h > field.top;
  const bottom = Math.max(minY, maxY);
  if (!overlaps(bottom)) return at('dock', left, bottom);
  if (!overlaps(minY)) return at('dock', left, minY);
  return {
    placement: 'dock',
    left,
    top: bottom,
    coversField: true,
    scrollBy: field.top + field.height + gap - bottom,
  };
}
