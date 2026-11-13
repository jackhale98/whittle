import { Check } from 'lucide-react';
import { m } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../components/primitives';
import { placeBubble, type Side } from '../logic/bubble';
import { readSafeInsets } from '../logic/dom';
import { type TutorialState, type TutorialStep, tutorialProgress } from '../logic/tutorial';
import { useSpring } from '../motion';

export interface TutorialProps {
  steps: readonly TutorialStep[];
  state: TutorialState;
  /** Name shown above the step, e.g. "Make a bracket". */
  title?: string;
  /** Skip pressed (or Escape inside the card). */
  onSkip(): void;
  /** "Back" pressed. Omit to hide the button. */
  onBack?(): void;
  /** Done pressed on the closing card (defaults to `onSkip`). */
  onDone?(): void;
  doneTitle?: string;
  doneBody?: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Resolved {
  box: Box;
  el: Element | null;
}

function resolveTarget(step: TutorialStep | undefined): Resolved | null {
  if (!step) return null;
  if (step.target) {
    const el = document.querySelector<HTMLElement>(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { box: { left: r.left, top: r.top, width: r.width, height: r.height }, el };
      }
    }
  }
  if (step.anchor) {
    return {
      box: { left: step.anchor.x - 16, top: step.anchor.y - 16, width: 32, height: 32 },
      el: null,
    };
  }
  return null;
}

/**
 * What the card must not cover: title bar, command bar, sheets and the side panels (unless the target is inside), and
 * the floating controls the step is about (context bubble, value chip, keypad).
 */
const CHROME =
  '[data-testid="top-bar"], [aria-label="Modeling tools"], [data-testid$="-sheet"], [data-testid="left-panel"], [data-testid="right-panel"], [data-testid="context-bubble"], [data-testid="value-chip"], [data-testid="keypad"]';

/**
 * Open menus the user is choosing from: always obstacles, even when the step's target is inside
 * one (the ring still marks it). A card over a tool flyout hid Extrude on the iPad.
 */
const MENUS = '[data-testid="tool-flyout"], [role="menu"], [data-radix-popper-content-wrapper]';

function chromeRects(target: Element | null): Box[] {
  const out: Box[] = [];
  const add = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0)
      out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  };
  for (const el of document.querySelectorAll(CHROME)) {
    if (target && el.contains(target)) continue;
    add(el);
  }
  out.push(...menuRects());
  return out;
}

function menuRects(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll(MENUS)) {
    if (el.closest('[data-testid="tutorial"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0)
      out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return out;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

/** Top dock for a card with no (or a low) target: centred, else right or left of the obstacles. */
function dockTop(
  size: { w: number; h: number },
  vw: number,
  top: number,
  safe: { left: number; right: number },
  obstacles: Box[],
): number {
  const lefts = [
    Math.round((vw - size.w) / 2),
    vw - safe.right - size.w,
    ...obstacles.map((o) => o.left + o.width + 12),
  ];
  for (const left of lefts) {
    const box = { left, top, width: size.w, height: size.h };
    const inside = left >= safe.left && left + size.w <= vw - safe.right;
    if (inside && !obstacles.some((o) => overlaps(box, o))) return left;
  }
  return lefts[0] as number;
}

/**
 * Non-modal coach marks for the 60-second tutorial (PLAN 9.2). A ring highlights the target and a
 * card (title, body, hint, progress, Skip) sits beside it without covering it. Nothing is blocked:
 * the user keeps working in the real UI, and the app calls `advance()` when the step's condition is
 * met. The card never takes focus; changes are announced politely.
 */
export default function Tutorial({
  steps,
  state,
  title = 'Tutorial',
  onSkip,
  onBack,
  onDone,
  doneTitle = 'Your first part is done',
  doneBody = 'Change a parameter to see it update, or start a new part.',
}: TutorialProps) {
  const card = useRef<HTMLElement>(null);
  const [target, setTarget] = useState<Box | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: Side | null }>({
    left: 0,
    top: 0,
    side: null,
  });
  const [ready, setReady] = useState(false);
  const spring = useSpring('standard');
  const running = state.status === 'running';
  const done = state.status === 'done';
  const step = steps[state.index];
  const { current, total } = tutorialProgress(steps, state);

  // Track the target and place the card; a rAF loop copes with sheets and rails that animate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step id captures what matters
  useLayoutEffect(() => {
    if (state.status === 'skipped') return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = card.current;
      if (el) {
        const found = done ? null : resolveTarget(step);
        const t = found?.box ?? null;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const obstacles = done ? [] : chromeRects(found?.el ?? null);
        const key = `${t?.left}|${t?.top}|${t?.width}|${t?.height}|${el.offsetWidth}|${el.offsetHeight}|${vw}|${vh}|${obstacles.map((o) => `${o.left},${o.top},${o.width},${o.height}`).join(';')}`;
        if (key !== last) {
          last = key;
          const insets = readSafeInsets();
          const size = { w: el.offsetWidth, h: el.offsetHeight };
          const pad = 12;
          const safe = {
            top: insets.top + pad,
            right: insets.right + pad,
            bottom: insets.bottom + pad,
            left: insets.left + pad,
          };
          // A target low on the screen (the sketch toolbar, a bubble above the sheet) would put
          // the card over the middle of the view, where the user is drawing or tapping: dock it
          // at the top instead, the ring still marks the target.
          const low = t !== null && t.top > vh * 0.62 && t.left > vw * 0.2;
          if (t && !low) {
            const p = placeBubble({
              anchor: { x: t.left + t.width / 2, y: t.top + t.height / 2 },
              anchorRadius: Math.max(t.width, t.height) / 2 + 8,
              gap: 10,
              size,
              viewport: { w: vw, h: vh },
              insets: safe,
              preferred: t.left < vw * 0.2 ? 'right' : t.top > vh * 0.55 ? 'above' : 'below',
              obstacles,
            });
            const placed = { left: p.left, top: p.top, width: size.w, height: size.h };
            if (menuRects().some((m) => overlaps(placed, m))) {
              // No clear spot beside the target: dock at the top, clear of the open menu.
              const top = safe.top + 64;
              setPlace({ left: dockTop(size, vw, top, safe, obstacles), top, side: null });
            } else {
              setPlace({ left: p.left, top: p.top, side: p.side });
            }
          } else {
            // No target (or a low one): float at the top, under the title bar, centred.
            setPlace({
              left: dockTop(size, vw, safe.top + 64, safe, obstacles),
              top: safe.top + 64,
              side: null,
            });
          }
          setTarget(t);
          setReady(true);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step?.id, state.status, done]);

  if (state.status === 'skipped') return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[var(--z-popover)]" data-testid="tutorial">
      {target && running ? (
        <span
          aria-hidden
          data-testid="tutorial-ring"
          className="w-pulse absolute rounded-[14px] shadow-[0_0_0_2px_var(--color-accent),0_0_0_6px_color-mix(in_srgb,var(--color-accent)_24%,transparent)]"
          style={{
            left: target.left - 4,
            top: target.top - 4,
            width: target.width + 8,
            height: target.height + 8,
          }}
        />
      ) : null}
      <section
        ref={card}
        aria-label={`${title}, step ${current} of ${total}`}
        data-testid="tutorial-card"
        data-step={done ? 'done' : step?.id}
        data-side={place.side ?? undefined}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate3d(${place.left}px, ${place.top}px, 0)`,
          visibility: ready ? 'visible' : 'hidden',
        }}
        className="pointer-events-auto w-[min(320px,calc(100vw-24px))]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onSkip();
          }
        }}
      >
        <m.div
          key={done ? 'done' : step?.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
          className="w-panel p-4"
          style={{ boxShadow: 'var(--shadow-pop)' }}
        >
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div
              role="progressbar"
              aria-label="Tutorial progress"
              aria-valuemin={1}
              aria-valuemax={total}
              aria-valuenow={current}
              aria-valuetext={`Step ${current} of ${total}`}
              className="flex min-w-0 flex-1 gap-1"
            >
              {steps.map((s, i) => (
                <span
                  key={s.id}
                  aria-hidden
                  className={cn(
                    'h-1 min-w-0 flex-1 rounded-full transition-colors duration-fast',
                    i < state.index || done
                      ? 'bg-accent'
                      : i === state.index
                        ? 'bg-accent/60'
                        : 'bg-border-strong/35',
                  )}
                />
              ))}
            </div>
            <span aria-hidden className="tnum shrink-0 text-2xs font-medium text-fg-muted">
              {current}/{total}
            </span>
          </div>

          <div aria-live="polite" aria-atomic="true">
            {done ? (
              <>
                <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-fg">
                  <Check className="size-4 text-success-text" aria-hidden /> {doneTitle}
                </h2>
                <p className="mt-1 text-sm leading-5 text-fg-muted">{doneBody}</p>
              </>
            ) : step ? (
              <>
                <h2 className="text-base font-semibold tracking-tight text-fg">{step.title}</h2>
                <p className="mt-1 text-sm leading-5 text-fg-muted">{step.body}</p>
              </>
            ) : null}
          </div>

          {!done && step?.hint ? (
            <p className="mt-2.5 flex items-center gap-2 text-2xs font-medium text-accent-text">
              <span aria-hidden className="w-pulse size-1.5 rounded-full bg-accent" />
              {step.hint}
            </p>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-2">
            {done ? (
              <button
                type="button"
                onClick={onDone ?? onSkip}
                className="ml-auto h-11 rounded-control bg-accent px-5 text-sm font-medium text-accent-fg active:brightness-95"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onSkip}
                  className="-ml-2 h-11 rounded-control px-3 text-sm font-medium text-fg-muted active:bg-surface-2"
                >
                  Skip tutorial
                </button>
                {onBack && state.index > 0 ? (
                  <button
                    type="button"
                    onClick={onBack}
                    className="-mr-2 h-11 rounded-control px-3 text-sm font-medium text-accent-text active:bg-surface-2"
                  >
                    Back
                  </button>
                ) : null}
              </>
            )}
          </div>
        </m.div>
      </section>
    </div>
  );
}
