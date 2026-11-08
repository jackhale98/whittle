import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import {
  type BubblePlacement,
  type Insets,
  NO_INSETS,
  type Point,
  placeBubble,
  type Rect,
  type Side,
  type Size,
} from '../logic/bubble';
import { readSafeInsets } from '../logic/dom';

export interface AnchoredOptions {
  preferred?: Side;
  obstacles?: readonly Rect[];
  gap?: number;
  anchorRadius?: number;
  /** Extra distance kept to the edges of the area, on top of the safe-area insets. */
  pad?: number;
}

/**
 * Positions `ref` (absolutely positioned at 0,0 inside its offset parent) next to `anchor`:
 * measures the element and the parent, reads the safe-area insets, remembers the last side so a
 * bubble does not flip back and forth, and returns the placement (null until measured).
 */
export function useAnchored(
  ref: RefObject<HTMLElement | null>,
  anchor: Point | null,
  { preferred, obstacles, gap, anchorRadius, pad = 8 }: AnchoredOptions = {},
): BubblePlacement | null {
  const [size, setSize] = useState<Size | null>(null);
  const [area, setArea] = useState<Size | null>(null);
  const [insets, setInsets] = useState<Insets>(NO_INSETS);
  const prevSide = useRef<Side | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent ?? el?.parentElement;
    if (!el || !parent) return;
    const measure = () => {
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
      setArea({ w: parent.clientWidth, h: parent.clientHeight });
      setInsets(readSafeInsets());
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [ref]);

  if (!anchor || !size || !area || size.w === 0) {
    if (!anchor) prevSide.current = undefined;
    return null;
  }
  const placement = placeBubble({
    anchor,
    size,
    viewport: area,
    insets: {
      top: insets.top + pad,
      right: insets.right + pad,
      bottom: insets.bottom + pad,
      left: insets.left + pad,
    },
    preferred,
    previous: prevSide.current,
    obstacles,
    gap,
    anchorRadius,
  });
  prevSide.current = placement.side;
  return placement;
}
