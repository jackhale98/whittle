import type { Vec2 } from '@wren-cad/contracts';
import type { SvgNode } from '@wren-cad/drawing/svg';
import { Maximize, Minus, Plus } from 'lucide-react';
import {
  createElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn, IconButton } from '../components/primitives';
import {
  fitView,
  pinch,
  type Size,
  toScreen,
  toSheet,
  type View2D,
  zoomAt,
  zoomPercent,
} from './viewerMath';

/** What a pointer event means on the sheet. */
export interface SheetPointer {
  /** Sheet mm, y up. */
  at: Vec2;
  /** Screen px relative to the viewer. */
  px: { x: number; y: number };
  pointerType: string;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Pick tolerance in sheet mm (larger for touch). */
  tol: number;
  /** One screen pixel in sheet mm. */
  mm: number;
}

/**
 * A drag that a tool owns. Return one from `begin` to take the pointer; return `null` and the
 * viewer pans (one pointer) or zooms (two). `up` also fires for a plain click.
 */
export interface SheetDrag {
  move?(p: SheetPointer): void;
  up?(p: SheetPointer, moved: boolean): void;
  cancel?(): void;
}

/**
 * A drag's preview, drawn without React and without the store (ADR-094): whole groups of the sheet
 * are translated (the compositor moves them), groups are hidden while a preview stands in for them,
 * and extra nodes are drawn above the sheet. Per pointer frame the owner calls `update`.
 */
export interface SheetTransientSpec {
  /** Translated as a whole: groups with these `data-host` (views) or `data-source` keys. */
  move?: { hosts?: readonly string[]; sources?: readonly string[] };
  /**
   * Not drawn while the preview stands in for them: `data-source` keys, or one source drawn in a
   * given view's space only (a section's cutting plane on its parent, not its own geometry).
   */
  hide?: readonly (string | { source: string; host: string })[];
}

export interface SheetTransientFrame {
  /** Translation of the moved groups, sheet mm (y up). */
  dx?: number;
  dy?: number;
  /** Drawn in the sheet's model space above its geometry, replacing the last frame's. */
  nodes?: readonly SvgNode[];
  /** Drawn above everything, in the overlay's space (handles, hints). */
  overlay?: readonly SvgNode[];
}

export interface SheetTransient {
  update(frame: SheetTransientFrame): void;
  /** `cancel`: gone now. `hold`: stays until the sheet is next rebuilt (a release awaiting its build). */
  end(how: 'cancel' | 'hold'): void;
}

export interface SheetViewerApi {
  /** Starts a drag preview; see `SheetTransientSpec`. */
  transient(spec: SheetTransientSpec): SheetTransient;
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  toScreen(p: Vec2): { x: number; y: number };
  /** Zoom to a sheet rectangle (mm). */
  zoomTo(min: Vec2, max: Vec2): void;
}

export interface SheetViewerProps {
  /** `svgModel` output of the current sheet; null while it is being built. */
  model: SvgNode | null;
  sheet: Size;
  /** Re-fits when this changes (sheet id). */
  fitKey: string;
  /** Accessible name and summary of the sheet. */
  label: string;
  /** Source keys (`view:<id>`, `placement:<id>`) drawn highlighted. */
  selected?: ReadonlySet<string>;
  /** Source keys drawn as hovered. */
  hover?: string | null;
  begin?(p: SheetPointer): SheetDrag | null;
  /** A press-less pointer move (hover, tool rubber bands). */
  onHover?(p: SheetPointer | null): void;
  /** A plain click or tap that no drag took (deselect). */
  onBackgroundTap?(p: SheetPointer): void;
  onKeyDown?(e: ReactKeyboardEvent<HTMLElement>): boolean | undefined;
  /** Drawn in sheet mm (y up) above the sheet; `mm` is the size of one screen pixel. */
  overlay?(ctx: { mm: number; sheet: Size }): ReactNode;
  /** Positioned over the viewer in screen px (inline editors); gets the converter. */
  floating?(ctx: { toScreen(p: Vec2): { x: number; y: number }; box: Size }): ReactNode;
  cursor?: string;
  /** Model values changed since the last regen: values are dimmed, never shown as current. */
  pending?: boolean;
  /** Fires when the pan or zoom changes (tests, the zoom readout). */
  onView?(v: View2D, fit: number): void;
  ref?: Ref<SheetViewerApi>;
  className?: string;
}

const attrName = (k: string): string =>
  k.startsWith('data-') || k.startsWith('aria-')
    ? k
    : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function parseStyle(v: string): Record<string, string> {
  return Object.fromEntries(
    v
      .split(';')
      .filter(Boolean)
      .map((s) => {
        const [a, ...b] = s.split(':');
        return [attrName((a ?? '').trim()), b.join(':').trim()];
      }),
  );
}

/** The SVG model (kebab-case attributes) as React elements. */
function renderNode(
  n: SvgNode | string,
  key: string | number,
  selected?: ReadonlySet<string>,
  hover?: string | null,
): ReactNode {
  if (typeof n === 'string') return n;
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k === 'style') props.style = parseStyle(v);
    else props[attrName(k)] = v;
  }
  const src = n.attrs['data-source'];
  if (src && selected?.has(src)) props['data-selected'] = 'true';
  else if (src && src === hover) props['data-hover'] = 'true';
  return createElement(
    n.tag,
    props,
    ...(n.children?.map((c, i) => renderNode(c, i, selected, hover)) ?? []),
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function toDom(n: SvgNode | string): Node {
  if (typeof n === 'string') return document.createTextNode(n);
  const el = document.createElementNS(SVG_NS, n.tag);
  for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v);
  for (const c of n.children ?? []) el.append(toDom(c));
  return el;
}

const cssEscape = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v);

/** How long a released preview waits for the rebuilt sheet before it goes anyway. */
const HOLD_MS = 2500;

/**
 * The sheet viewer: pan and zoom for mouse, touch and keyboard, with tool drags handed to the
 * owner. The paper is drawn at true scale in mm; strokes never get thinner than the sheet's.
 */
export function SheetViewer({
  model,
  sheet,
  fitKey,
  label,
  selected,
  hover,
  begin,
  onHover,
  onBackgroundTap,
  onKeyDown,
  overlay,
  floating,
  cursor,
  pending,
  onView,
  ref,
  className,
}: SheetViewerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View2D>({ k: 1, x: 0, y: 0 });
  const fit = useMemo(() => (size.w > 0 ? fitView(sheet, size) : null), [sheet, size]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitted = useRef('');
  const svgRef = useRef<SVGSVGElement>(null);
  const modelLayer = useRef<SVGGElement>(null);
  const overlayLayer = useRef<SVGGElement>(null);
  /** Previews released but not yet replaced by the rebuilt sheet. */
  const held = useRef(new Set<() => void>());

  // Track the viewer's size.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit when the sheet changes, and once the size is known.
  useEffect(() => {
    if (!fit) return;
    const key = `${fitKey}|${sheet.w}x${sheet.h}`;
    if (fitted.current === key) return;
    fitted.current = key;
    setView(fit);
  }, [fit, fitKey, sheet.w, sheet.h]);

  useEffect(() => {
    if (fit) onView?.(view, fit.k);
  }, [view, fit, onView]);

  const set = useCallback((v: View2D) => setView(v), []);

  const transient = useCallback((spec: SheetTransientSpec): SheetTransient => {
    for (const r of [...held.current]) r();
    const root = svgRef.current;
    const touched: SVGElement[] = [];
    const hidden: SVGElement[] = [];
    const moved: SVGElement[] = [];
    if (root) {
      for (const h of spec.hide ?? []) {
        const sel =
          typeof h === 'string'
            ? `[data-source="${cssEscape(h)}"]`
            : `[data-source="${cssEscape(h.source)}"][data-host="${cssEscape(h.host)}"]`;
        for (const el of root.querySelectorAll<SVGElement>(sel)) {
          el.style.display = 'none';
          hidden.push(el);
        }
      }
      const pick = (sel: string) => {
        for (const el of root.querySelectorAll<SVGElement>(sel)) {
          el.style.willChange = 'transform';
          moved.push(el);
        }
      };
      for (const h of spec.move?.hosts ?? []) pick(`[data-host="${cssEscape(h)}"]`);
      for (const k of spec.move?.sources ?? []) pick(`[data-source="${cssEscape(k)}"]`);
    }
    touched.push(...hidden, ...moved);
    let lastNodes: readonly SvgNode[] | undefined;
    let lastOverlay: readonly SvgNode[] | undefined;
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      for (const el of touched) {
        el.style.transform = '';
        el.style.willChange = '';
        el.style.display = '';
      }
      modelLayer.current?.replaceChildren();
      overlayLayer.current?.replaceChildren();
      held.current.delete(restore);
    };
    return {
      update(f) {
        if (done) return;
        if (f.dx !== undefined || f.dy !== undefined) {
          const t = `translate(${f.dx ?? 0}px, ${f.dy ?? 0}px)`;
          for (const el of moved) el.style.transform = t;
        }
        if (f.nodes !== undefined && f.nodes !== lastNodes) {
          lastNodes = f.nodes;
          modelLayer.current?.replaceChildren(...f.nodes.map(toDom));
        }
        if (f.overlay !== undefined && f.overlay !== lastOverlay) {
          lastOverlay = f.overlay;
          overlayLayer.current?.replaceChildren(...f.overlay.map(toDom));
        }
      },
      end(how) {
        if (how === 'cancel') {
          restore();
          return;
        }
        held.current.add(restore);
        setTimeout(restore, HOLD_MS);
      },
    };
  }, []);

  // The rebuilt sheet replaces what a released preview stood in for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the model changes
  useLayoutEffect(() => {
    for (const r of [...held.current]) r();
  }, [model]);

  useImperativeHandle(
    ref,
    () => ({
      transient,
      fit: () => fitRef.current && set(fitRef.current),
      zoomIn: () => {
        const f = fitRef.current;
        if (f) set(zoomAt(viewRef.current, 1.25, { x: size.w / 2, y: size.h / 2 }, f.k));
      },
      zoomOut: () => {
        const f = fitRef.current;
        if (f) set(zoomAt(viewRef.current, 0.8, { x: size.w / 2, y: size.h / 2 }, f.k));
      },
      toScreen: (p) => toScreen(viewRef.current, sheet, p),
      zoomTo: (min, max) => {
        const f = fitRef.current;
        if (!f) return;
        const w = Math.max(max[0] - min[0], 1);
        const h = Math.max(max[1] - min[1], 1);
        const k = Math.min((size.w - 64) / w, (size.h - 64) / h);
        const cx = (min[0] + max[0]) / 2;
        const cy = (min[1] + max[1]) / 2;
        set({ k, x: size.w / 2 - cx * k, y: size.h / 2 - (sheet.h - cy) * k });
      },
    }),
    [set, sheet, size.h, size.w, transient],
  );

  // Pointers ----------------------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const gesture = useRef<
    | { kind: 'none' }
    | {
        kind: 'drag';
        id: number;
        drag: SheetDrag;
        start: { x: number; y: number };
        moved: boolean;
        /** The newest pointer position not yet handed to the drag (one hand-off per frame). */
        latest: SheetPointer | null;
        raf: number;
      }
    | {
        kind: 'pan';
        id: number;
        last: { x: number; y: number };
        start: { x: number; y: number };
        moved: boolean;
        button: number;
        downAt: SheetPointer;
      }
    | { kind: 'pinch'; ids: [number, number] }
  >({ kind: 'none' });
  const lastTap = useRef(0);

  /** The viewer's rectangle while a drag runs: reading it per move would force a layout each time. */
  const rect = useRef<DOMRect | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = rect.current ?? box.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const pointer = (e: ReactPointerEvent | PointerEvent): SheetPointer => {
    const px = local(e);
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    return {
      at: toSheet(viewRef.current, sheet, px),
      px,
      pointerType: e.pointerType,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      tol: (touch ? 14 : 6) / viewRef.current.k,
      mm: 1 / viewRef.current.k,
    };
  };

  const endDrag = useCallback((g: Extract<typeof gesture.current, { kind: 'drag' }>) => {
    if (g.raf) cancelAnimationFrame(g.raf);
    g.raf = 0;
    g.latest = null;
    rect.current = null;
    g.drag.cancel?.();
  }, []);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-viewer-ui]')) return;
    box.current?.focus({ preventScroll: true });
    const p = local(e);
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType });
    try {
      box.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // A synthetic or already-released pointer cannot be captured: the drag still works.
    }
    const g = gesture.current;
    if (pointers.current.size === 2) {
      // A second finger turns whatever is happening into a pinch.
      if (g.kind === 'drag') endDrag(g);
      const ids = [...pointers.current.keys()].slice(0, 2) as [number, number];
      gesture.current = { kind: 'pinch', ids };
      return;
    }
    if (pointers.current.size > 2) return;
    const info = pointer(e);
    const mouseNav = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2);
    const drag = mouseNav ? null : (begin?.(info) ?? null);
    if (drag) {
      rect.current = box.current?.getBoundingClientRect() ?? null;
      gesture.current = {
        kind: 'drag',
        id: e.pointerId,
        drag,
        start: p,
        moved: false,
        latest: null,
        raf: 0,
      };
      e.preventDefault();
    } else {
      gesture.current = {
        kind: 'pan',
        id: e.pointerId,
        last: p,
        start: p,
        moved: false,
        button: e.button,
        downAt: info,
      };
    }
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    const p = local(e);
    if (!prev) {
      onHover?.(pointer(e));
      return;
    }
    pointers.current.set(e.pointerId, { ...p, type: e.pointerType });
    const g = gesture.current;
    const f = fitRef.current;
    if (g.kind === 'pinch' && f) {
      const [i, j] = g.ids;
      const a = pointers.current.get(i);
      const b = pointers.current.get(j);
      if (!a || !b) return;
      const was = e.pointerId === i ? { a: prev, b } : { a, b: prev };
      set(pinch(viewRef.current, was, { a, b }, f.k));
      return;
    }
    if (g.kind === 'drag' && g.id === e.pointerId) {
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 3) g.moved = true;
      // One hand-off per frame, with the newest position: the events the browser coalesced into
      // this one carry nothing a drag of a position needs (ADR-094).
      const co = e.nativeEvent.getCoalescedEvents?.() ?? [];
      g.latest = pointer(co.length > 0 ? (co[co.length - 1] as PointerEvent) : e);
      if (!g.raf) {
        g.raf = requestAnimationFrame(() => {
          g.raf = 0;
          const at = g.latest;
          g.latest = null;
          if (at && gesture.current === g) g.drag.move?.(at);
        });
      }
      return;
    }
    if (g.kind === 'pan' && g.id === e.pointerId) {
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 4) g.moved = true;
      if (g.moved) {
        const dx = p.x - g.last.x;
        const dy = p.y - g.last.y;
        set({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy });
      }
      g.last = p;
    }
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.kind === 'drag' && g.id === e.pointerId) {
      const at = pointer(e);
      if (g.raf) cancelAnimationFrame(g.raf);
      g.raf = 0;
      rect.current = null;
      gesture.current = { kind: 'none' };
      g.drag.up?.(at, g.moved);
    } else if (g.kind === 'pan' && g.id === e.pointerId) {
      if (!g.moved && g.button === 0) {
        const now = e.timeStamp;
        if (now - lastTap.current < 350 && fitRef.current) set(fitRef.current);
        else onBackgroundTap?.(g.downAt);
        lastTap.current = now;
      }
      gesture.current = { kind: 'none' };
    } else if (g.kind === 'pinch') {
      if (pointers.current.size < 2) gesture.current = { kind: 'none' };
    }
    if (pointers.current.size === 0) gesture.current = { kind: 'none' };
  };

  const cancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g.kind === 'drag') endDrag(g);
    gesture.current = { kind: 'none' };
  };

  // Escape during a drag abandons it: the drag restores what it changed and the press is spent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const g = gesture.current;
      if (g.kind !== 'drag') return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(g);
      gesture.current = { kind: 'none' };
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [endDrag]);

  // Wheel and trackpad pinch: a non-passive listener so the page never scrolls.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const f = fitRef.current;
      if (!f) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.shiftKey && !e.ctrlKey) {
        set({ ...viewRef.current, x: viewRef.current.x - e.deltaY });
        return;
      }
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      set(zoomAt(viewRef.current, factor, at, f.k));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [set]);

  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (onKeyDown?.(e)) return;
    const f = fitRef.current;
    if (!f || e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 160 : 40;
    const v = viewRef.current;
    switch (e.key) {
      case 'ArrowLeft':
        set({ ...v, x: v.x + step });
        break;
      case 'ArrowRight':
        set({ ...v, x: v.x - step });
        break;
      case 'ArrowUp':
        set({ ...v, y: v.y + step });
        break;
      case 'ArrowDown':
        set({ ...v, y: v.y - step });
        break;
      case '+':
      case '=':
        set(zoomAt(v, 1.25, { x: size.w / 2, y: size.h / 2 }, f.k));
        break;
      case '-':
        set(zoomAt(v, 0.8, { x: size.w / 2, y: size.h / 2 }, f.k));
        break;
      case '0':
      case 'Home':
        set(f);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // The sheet's elements are made again only when the model or the selection changes, not on
  // every pan or zoom frame.
  const drawn = useMemo(
    () =>
      model?.children?.map((c, i) =>
        typeof c === 'string' || c.tag === 'rect' ? null : renderNode(c, i, selected, hover),
      ),
    [model, selected, hover],
  );
  const mm = 1 / view.k;
  const conv = useCallback((p: Vec2) => toScreen(view, sheet, p), [view, sheet]);
  const flip = `matrix(1 0 0 -1 0 ${sheet.h})`;

  return (
    <div
      ref={box}
      role="application"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the sheet is a keyboard-operable canvas (pan, zoom, tools)
      tabIndex={0}
      aria-label={label}
      aria-roledescription="drawing sheet"
      aria-busy={pending || undefined}
      data-testid="sheet-viewer"
      data-zoom={fit ? zoomPercent(view, fit.k) : 100}
      data-pending={pending || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onPointerLeave={() => onHover?.(null)}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        'relative size-full touch-none overflow-hidden bg-[var(--color-viewport-bottom,#e7eaf0)] outline-none select-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]',
        className,
      )}
      style={{ cursor: cursor ?? 'default' }}
    >
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        role="img"
        aria-label={label}
        className="absolute inset-0 block"
        data-testid="sheet-svg"
      >
        <g
          transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
          data-testid="drawing-sheet-content"
        >
          <rect
            x={0}
            y={0}
            width={sheet.w}
            height={sheet.h}
            fill="#ffffff"
            stroke="rgba(15,23,42,0.25)"
            strokeWidth={mm}
            style={{ filter: 'drop-shadow(0 2px 6px rgba(15,23,42,0.25))' }}
          />
          <g
            data-sheet-model
            className={cn(
              'sheet-model transition-opacity duration-fast',
              pending && 'sheet-model-pending',
            )}
          >
            {drawn}
          </g>
          {/* Drag previews (ADR-094): filled by the viewer's transient layer, never by React. */}
          <g transform={flip} className="sheet-model" data-transient="model" ref={modelLayer} />
          {overlay ? (
            <g transform={flip} data-testid="sheet-overlay">
              {overlay({ mm, sheet })}
            </g>
          ) : null}
          <g transform={flip} data-transient="overlay" ref={overlayLayer} />
        </g>
      </svg>
      {floating?.({ toScreen: conv, box: size })}
      <div
        data-viewer-ui
        className="absolute right-3 bottom-3 flex items-center gap-1 rounded-panel bg-surface/90 p-1 shadow-pop backdrop-blur"
      >
        <IconButton
          label="Zoom out"
          icon={<Minus className="size-4" />}
          onClick={() =>
            fitRef.current &&
            set(zoomAt(view, 0.8, { x: size.w / 2, y: size.h / 2 }, fitRef.current.k))
          }
        />
        <span className="tnum w-11 text-center text-2xs text-fg-muted" data-testid="zoom-readout">
          {fit ? zoomPercent(view, fit.k) : 100}%
        </span>
        <IconButton
          label="Zoom in"
          icon={<Plus className="size-4" />}
          onClick={() =>
            fitRef.current &&
            set(zoomAt(view, 1.25, { x: size.w / 2, y: size.h / 2 }, fitRef.current.k))
          }
        />
        <IconButton
          label="Fit sheet to window"
          icon={<Maximize className="size-4" />}
          onClick={() => fitRef.current && set(fitRef.current)}
        />
      </div>
    </div>
  );
}
