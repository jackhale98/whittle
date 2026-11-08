import { type PointerEvent, useCallback, useEffect, useRef } from 'react';

export interface LongPressOptions {
  /** Hold time before it fires (ms). */
  delay?: number;
  /** Movement (px) that cancels it, so scrolling and dragging never trigger it. */
  slop?: number;
}

export interface LongPressHandlers {
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  /** Swallows the click that follows a long press so it does not also select. */
  onClickCapture(e: { stopPropagation(): void; preventDefault(): void }): void;
}

/**
 * Long-press for touch and pen (mouse users have right-click; keyboards have the Menu key).
 * `bind(payload)` returns the handlers for one item; `onLongPress` receives the payload and the
 * press point. A single timer is shared because only one finger can hold at a time.
 */
export function useLongPress<T>(
  onLongPress: (payload: T, at: { x: number; y: number }) => void,
  { delay = 500, slop = 8 }: LongPressOptions = {},
): (payload: T) => LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  return useCallback(
    (payload: T) => ({
      onPointerDown(e) {
        if (e.pointerType === 'mouse') return;
        // Buttons inside the row (grip, eye ...) keep their own behaviour.
        if ((e.target as HTMLElement).closest('[data-no-longpress]')) return;
        clear();
        fired.current = false;
        const at = { x: e.clientX, y: e.clientY };
        start.current = at;
        timer.current = setTimeout(() => {
          timer.current = null;
          fired.current = true;
          globalThis.navigator?.vibrate?.(8);
          cb.current(payload, at);
        }, delay);
      },
      onPointerMove(e) {
        const s = start.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > slop) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onClickCapture(e) {
        if (fired.current) {
          fired.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      },
    }),
    [clear, delay, slop],
  );
}
