import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../components/primitives';
import { readSafeInsets } from '../logic/dom';
import {
  estimateVelocity,
  type PointerSample,
  rubberBand,
  type SheetSnap,
  settleSnap,
  snapHeights,
  stepSnap,
  toggleSnap,
} from '../logic/sheet';

export interface BottomSheetProps {
  snap: SheetSnap;
  onSnapChange(snap: SheetSnap): void;
  /** Visible height (px) when collapsed, including the handle and any header. */
  peek: number;
  /** Fraction of the stage shown at `half` (default 0.45). */
  halfRatio?: number;
  /** Upper bound (px) for `half`. */
  halfMax?: number;
  /** Space kept free above the sheet at `full` (px). */
  topGap?: number;
  handleLabel: string;
  /** Always visible, below the handle (tabs, title). It drags the sheet too. */
  header?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  /**
   * Visible height (px, safe-area inset included) at the current snap, reported when it settles
   * (not while dragging), so the host can keep floating chrome above the sheet.
   */
  onVisibleHeight?(px: number): void;
}

const DRAG_THRESHOLD = 6;

/**
 * Bottom sheet with three snap points (peek / half / full) that you can drag (PLAN 9.1).
 *
 * - Drag the handle or header; release flings to the nearest snap after a short inertial glide.
 * - The handle is a real button: Enter/Space/click toggles peek <-> half, Arrow Up/Down step the
 *   snaps, Home/End jump to peek/full, Escape collapses. State is announced politely.
 * - Collapsed content is `inert`; at rest the scroll area ends exactly at the visible edge.
 * - Safe-area bottom inset is part of the sheet. Reduced motion: snaps apply instantly.
 */
export function BottomSheet({
  snap,
  onSnapChange,
  peek,
  halfRatio,
  halfMax,
  topGap,
  handleLabel,
  header,
  children,
  className,
  testId,
  onVisibleHeight,
}: BottomSheetProps) {
  const ref = useRef<HTMLElement>(null);
  const [container, setContainer] = useState(0);
  const hintId = useId();
  const [announce, setAnnounce] = useState('');
  // Visible-height offset while a finger is down; null when the sheet rests on a snap.
  const [dragY, setDragY] = useState<number | null>(null);
  const dragging = dragY !== null;
  const [safeBottom, setSafeBottom] = useState(0);

  const drag = useRef<{
    id: number;
    startY: number;
    startVisible: number;
    active: boolean;
    samples: PointerSample[];
  } | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      setContainer(parent.clientHeight);
      setSafeBottom(readSafeInsets().bottom);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const heights = useMemo(
    () =>
      snapHeights({
        container: container || (typeof window === 'undefined' ? 800 : window.innerHeight),
        peek: peek + safeBottom,
        halfRatio,
        halfMax,
        topGap,
      }),
    [container, peek, halfRatio, halfMax, topGap, safeBottom],
  );
  const full = heights.full;
  const target = full - heights[snap];
  const visible = heights[snap];
  const onVisible = useRef(onVisibleHeight);
  onVisible.current = onVisibleHeight;
  useLayoutEffect(() => onVisible.current?.(visible), [visible]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setAnnounce(
      `${handleLabel} sheet ${snap === 'peek' ? 'collapsed' : snap === 'half' ? 'half open' : 'fully open'}`,
    );
  }, [snap, handleLabel]);

  const lastY = useRef(target);
  if (!dragging) lastY.current = target;

  function down(e: PointerEvent<HTMLElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = {
      id: e.pointerId,
      startY: e.clientY,
      startVisible: heights[snap],
      active: false,
      samples: [{ y: e.clientY, t: e.timeStamp }],
    };
  }

  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      d.startY = e.clientY;
      d.startVisible = full - lastY.current;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 12) d.samples.shift();
    const visible = rubberBand(d.startVisible - (e.clientY - d.startY), heights.peek, heights.full);
    lastY.current = full - visible;
    setDragY(lastY.current);
  }

  function up(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.active) return;
    suppressClick.current = true;
    const velocity = estimateVelocity(d.samples);
    const next = settleSnap(full - lastY.current, velocity, heights, snap);
    // Releasing re-renders at the snap's offset: the CSS transition glides there from the finger.
    setDragY(null);
    if (next !== snap) onSnapChange(next);
  }

  function cancel() {
    const d = drag.current;
    drag.current = null;
    if (d?.active) setDragY(null);
  }

  function key(e: KeyboardEvent<HTMLButtonElement>) {
    let next: SheetSnap | null = null;
    if (e.key === 'ArrowUp') next = stepSnap(snap, 1);
    else if (e.key === 'ArrowDown') next = stepSnap(snap, -1);
    else if (e.key === 'Home') next = 'peek';
    else if (e.key === 'End') next = 'full';
    else if (e.key === 'Escape' && snap !== 'peek') next = 'peek';
    if (next === null) return;
    e.preventDefault();
    if (next !== snap) onSnapChange(next);
  }

  const open = snap !== 'peek';
  const clip = Math.max(0, full - heights[snap]);

  return (
    <section
      ref={ref}
      aria-label={handleLabel}
      data-testid={testId}
      data-open={open}
      data-snap={snap}
      data-dragging={dragging || undefined}
      style={{
        height: full,
        transform: `translateY(${dragY ?? target}px)`,
        // The standard motion preset (260 ms, tokens.css); instant while dragging and under
        // prefers-reduced-motion (global rule).
        transition: dragging ? 'none' : 'transform var(--duration-standard) var(--ease-standard)',
      }}
      className={cn(
        'w-sheet pointer-events-auto absolute right-0 bottom-0 left-0 z-[var(--z-sheet)] flex flex-col pb-[var(--safe-bottom)]',
        className,
      )}
    >
      <div
        data-testid={testId ? `${testId}-grip` : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        className="flex shrink-0 touch-none flex-col"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${handleLabel}${open ? ', collapse' : ', expand'}`}
          aria-describedby={hintId}
          onClick={() => onSnapChange(toggleSnap(snap))}
          onKeyDown={key}
          className="group/handle flex h-7 w-full shrink-0 items-center justify-center rounded-t-[inherit]"
        >
          <span className="h-1 w-10 rounded-full bg-border-strong/60 transition-[width,background-color] duration-fast group-active/handle:w-14 group-focus-visible/handle:bg-accent" />
        </button>
        <span id={hintId} className="sr-only">
          Drag, or press the up and down arrow keys, to resize. Home and End jump to the smallest
          and largest size.
        </span>
        {header}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ paddingBottom: dragging ? undefined : clip }}
        inert={!open}
      >
        {children}
      </div>
    </section>
  );
}
