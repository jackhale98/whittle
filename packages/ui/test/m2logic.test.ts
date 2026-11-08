import { describe, expect, it } from 'vitest';
import { placeBubble, placeKeypad, type Rect, rectsIntersect } from '../src/logic/bubble';
import { applyKeypadKey, type KeypadKey } from '../src/logic/keypad';
import {
  estimateVelocity,
  nearestSnap,
  rubberBand,
  settleSnap,
  snapHeights,
  stepSnap,
  toggleSnap,
} from '../src/logic/sheet';
import {
  initialTutorial,
  type TutorialState,
  tutorialProgress,
  tutorialReducer,
} from '../src/logic/tutorial';
import {
  formatLengthMm,
  type Measurement,
  measurementKind,
  parseLengthMm,
  readMeasurement,
  speakMeasurement,
} from '../src/measure/types';
import { bracketTutorial } from '../src/tutorial/bracketSteps';

/* ------------------------------------------------------------------ sheet snapping */

describe('sheet snapping', () => {
  const h = snapHeights({ container: 800, peek: 68, topGap: 96 });

  it('orders peek <= half <= full and never exceeds the container', () => {
    expect(h).toEqual({ peek: 68, half: 360, full: 704 });
    const tiny = snapHeights({ container: 120, peek: 68, topGap: 96 });
    expect(tiny.peek).toBeLessThanOrEqual(tiny.half);
    expect(tiny.half).toBeLessThanOrEqual(tiny.full);
    expect(tiny.full).toBeLessThanOrEqual(120);
  });

  it('honours halfMax', () => {
    expect(snapHeights({ container: 1180, peek: 68, halfMax: 460 }).half).toBe(460);
  });

  it('nearest snap by visible height', () => {
    expect(nearestSnap(80, h)).toBe('peek');
    expect(nearestSnap(300, h)).toBe('half');
    expect(nearestSnap(600, h)).toBe('full');
  });

  it('a slow release settles on the nearest snap', () => {
    expect(settleSnap(230, 0, h, 'peek')).toBe('half');
    expect(settleSnap(120, 0.05, h, 'half')).toBe('peek');
  });

  it('a fling carries past the nearest snap (inertia projection)', () => {
    // Released at 200px moving up fast (negative = up): projects well beyond half.
    expect(settleSnap(200, -2, h, 'peek')).toBe('full');
    // Moving down fast from full collapses.
    expect(settleSnap(650, 3.5, h, 'full')).toBe('peek');
  });

  it('a fast flick that would land on the same snap still moves one step', () => {
    expect(settleSnap(380, -0.6, snapHeights({ container: 800, peek: 68 }), 'half')).toBe('full');
    expect(settleSnap(350, 0.6, h, 'half')).toBe('peek');
  });

  it('rubber-bands beyond the ends but not inside', () => {
    expect(rubberBand(300, 68, 704)).toBe(300);
    expect(rubberBand(804, 68, 704)).toBeCloseTo(704 + 100 * 0.35);
    expect(rubberBand(0, 68, 704)).toBeCloseTo(68 - 68 * 0.35);
  });

  it('steps and toggles', () => {
    expect(stepSnap('peek', 1)).toBe('half');
    expect(stepSnap('full', 1)).toBe('full');
    expect(stepSnap('peek', -1)).toBe('peek');
    expect(toggleSnap('peek')).toBe('half');
    expect(toggleSnap('half')).toBe('peek');
    expect(toggleSnap('full')).toBe('peek');
  });

  it('estimates velocity from the last 100 ms only', () => {
    expect(estimateVelocity([])).toBe(0);
    const v = estimateVelocity([
      { y: 0, t: 0 },
      { y: 500, t: 20 }, // too old to count
      { y: 600, t: 200 },
      { y: 640, t: 240 },
      { y: 680, t: 280 },
    ]);
    expect(v).toBeCloseTo(1); // 80 px in 80 ms
  });
});

/* ------------------------------------------------------------------ bubble placement */

describe('context bubble placement', () => {
  const viewport = { w: 1180, h: 820 };
  const size = { w: 240, h: 64 };
  const keepOut = (a: { x: number; y: number }, r = 14): Rect => ({
    left: a.x - r,
    top: a.y - r,
    width: 2 * r,
    height: 2 * r,
  });
  const rectOf = (p: { left: number; top: number }): Rect => ({
    ...p,
    width: size.w,
    height: size.h,
  });

  it('sits above the anchor by default, centred', () => {
    const a = { x: 600, y: 400 };
    const p = placeBubble({ anchor: a, size, viewport });
    expect(p.side).toBe('above');
    expect(p.left).toBe(480);
    expect(p.top + size.h).toBeLessThan(a.y);
    expect(p.squeezed).toBe(false);
  });

  it('flips below when there is no room above', () => {
    const a = { x: 600, y: 40 };
    const p = placeBubble({ anchor: a, size, viewport });
    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThan(a.y);
  });

  it('flips above near the bottom edge', () => {
    const p = placeBubble({
      anchor: { x: 600, y: 790 },
      size,
      viewport,
      preferred: 'below',
    });
    expect(p.side).toBe('above');
  });

  it('clamps horizontally inside the safe-area insets and keeps the tip on the anchor', () => {
    const insets = { top: 20, right: 24, bottom: 34, left: 24 };
    const a = { x: 10, y: 400 };
    const p = placeBubble({ anchor: a, size, viewport, insets });
    expect(p.left).toBe(24);
    expect(p.tip.x).toBeGreaterThanOrEqual(16);
    const r = placeBubble({ anchor: { x: 1175, y: 400 }, size, viewport, insets });
    expect(r.left + size.w).toBe(1180 - 24);
  });

  it('respects the top inset: below the notch', () => {
    const p = placeBubble({
      anchor: { x: 600, y: 120 },
      size,
      viewport,
      insets: { top: 100, right: 0, bottom: 0, left: 0 },
    });
    expect(p.side).toBe('below');
  });

  it('never covers the anchor, wherever it is', () => {
    for (const vp of [
      { w: 1180, h: 820 },
      { w: 820, h: 1180 },
      { w: 390, h: 844 },
      { w: 300, h: 150 },
    ]) {
      for (let x = 0; x <= vp.w; x += 37) {
        for (let y = 0; y <= vp.h; y += 41) {
          const a = { x, y };
          const p = placeBubble({ anchor: a, size, viewport: vp });
          expect(rectsIntersect(rectOf(p), keepOut(a)), `${vp.w}x${vp.h} @${x},${y}`).toBe(false);
        }
      }
    }
  });

  it('avoids obstacles such as the tool rail', () => {
    const rail: Rect = { left: 12, top: 84, width: 68, height: 300 };
    const p = placeBubble({ anchor: { x: 130, y: 300 }, size, viewport, obstacles: [rail] });
    expect(rectsIntersect(rectOf(p), rail)).toBe(false);
  });

  it('slides along the cross axis past a bar instead of giving up the preferred side', () => {
    const topBar: Rect = { left: 12, top: 12, width: 490, height: 56 };
    const card = { w: 320, h: 210 };
    const p = placeBubble({
      anchor: { x: 46, y: 118 },
      anchorRadius: 40,
      size: card,
      viewport,
      preferred: 'right',
      obstacles: [topBar],
    });
    expect(p.side).toBe('right');
    expect(p.top).toBeGreaterThanOrEqual(topBar.top + topBar.height);
    expect(
      rectsIntersect({ left: p.left, top: p.top, width: card.w, height: card.h }, topBar),
    ).toBe(false);
  });

  it('keeps the previous side while it still fits (no flicker)', () => {
    const a = { x: 600, y: 300 };
    const p = placeBubble({ anchor: a, size, viewport, previous: 'below' });
    expect(p.side).toBe('below');
  });
});

describe('keypad placement', () => {
  const vp = { w: 820, h: 1180 };
  const pad = { w: 344, h: 340 };
  it('goes below the field when it fits', () => {
    const r = placeKeypad({ left: 100, top: 200, width: 200, height: 44 }, pad, vp);
    expect(r.placement).toBe('below');
    expect(r.top).toBeGreaterThanOrEqual(244);
    expect(r.coversField).toBe(false);
  });
  it('goes above a field near the bottom', () => {
    const r = placeKeypad({ left: 100, top: 1000, width: 200, height: 44 }, pad, vp);
    expect(r.placement).toBe('above');
    expect(r.top + pad.h).toBeLessThanOrEqual(1000);
  });
  it('docks (and reports covering) when neither side has room', () => {
    const r = placeKeypad({ left: 10, top: 150, width: 200, height: 44 }, pad, { w: 390, h: 400 });
    expect(r.placement).toBe('dock');
    expect(r.coversField).toBe(true);
  });
  it('stays inside the horizontal safe area', () => {
    const r = placeKeypad({ left: 700, top: 100, width: 100, height: 44 }, pad, vp, {
      top: 0,
      right: 20,
      bottom: 0,
      left: 0,
    });
    expect(r.left + pad.w).toBeLessThanOrEqual(820 - 20);
  });

  describe('landscape phone (844 × 390)', () => {
    const land = { w: 844, h: 390 };
    const compact = { w: 344, h: 236 };
    const covers = (f: Rect, r: { left: number; top: number }, s: { w: number; h: number }) =>
      rectsIntersect(f, { left: r.left, top: r.top, width: s.w, height: s.h });

    it('a narrow field mid-screen gets the keypad beside it, full size', () => {
      const f = { left: 120, top: 170, width: 200, height: 44 };
      const r = placeKeypad(f, pad, land);
      expect(r.placement).toBe('beside');
      expect(r.left).toBeGreaterThanOrEqual(f.left + f.width);
      expect(r.top).toBeGreaterThanOrEqual(8);
      expect(r.top + pad.h).toBeLessThanOrEqual(390 - 8);
      expect(r.coversField).toBe(false);
      expect(covers(f, r, pad)).toBe(false);
      // A field on the right: the keypad goes to its left.
      const g = { left: 560, top: 170, width: 240, height: 44 };
      const s = placeKeypad(g, pad, land);
      expect(s.placement).toBe('beside');
      expect(s.left + pad.w).toBeLessThanOrEqual(g.left);
    });

    it('a full-width sheet field: compact, docked clear of the field when it can be', () => {
      // Full size neither fits above, below nor beside: dock (the keypad then goes compact).
      const low = { left: 16, top: 60, width: 812, height: 44 };
      expect(placeKeypad(low, pad, land).placement).toBe('dock');
      const r = placeKeypad(low, compact, land);
      expect(r.placement).toBe('below');
      expect(covers(low, r, compact)).toBe(false);
      // Field low on the screen: the compact keypad goes above it.
      const bottom = { left: 16, top: 300, width: 812, height: 44 };
      const b = placeKeypad(bottom, compact, land);
      expect(covers(bottom, b, compact)).toBe(false);
    });

    it('never leaves the field covered: mid-screen, it says how far to scroll the field up', () => {
      const mid = { left: 16, top: 170, width: 812, height: 44 };
      const r = placeKeypad(mid, compact, land);
      expect(r.placement).toBe('dock');
      expect(r.coversField).toBe(true);
      expect(r.scrollBy).toBeGreaterThan(0);
      // Scrolled by that much, the field sits just above the keypad, which then stays put.
      const moved = { ...mid, top: mid.top - r.scrollBy };
      expect(moved.top).toBeGreaterThanOrEqual(0);
      const again = placeKeypad(moved, compact, land);
      expect(again.coversField).toBe(false);
      expect(again.scrollBy).toBe(0);
      expect(covers(moved, again, compact)).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ keypad editing */

describe('keypad input editing', () => {
  const press = (text: string, a: number, b: number, key: KeypadKey) =>
    applyKeypadKey(text, a, b, key);
  const digit = (d: string): KeypadKey => ({ kind: 'insert', text: d });

  it('inserts at the caret and moves it', () => {
    expect(press('12', 1, 1, digit('5'))).toEqual({ text: '152', caret: 2 });
  });
  it('replaces the selection (a focused field starts fully selected)', () => {
    expect(press('25mm', 0, 4, digit('7'))).toEqual({ text: '7', caret: 1 });
  });
  it('appends units after a number: 4 5 deg -> 45deg', () => {
    const a = press('45', 2, 2, { kind: 'unit', unit: 'deg' });
    expect(a).toEqual({ text: '45deg', caret: 5 });
  });
  it('replaces a unit already typed instead of stacking', () => {
    expect(press('45deg', 5, 5, { kind: 'unit', unit: 'mm' })).toEqual({ text: '45mm', caret: 4 });
    expect(press('(2+3)in', 7, 7, { kind: 'unit', unit: 'mm' })).toEqual({
      text: '(2+3)mm',
      caret: 7,
    });
  });
  it('writes operators with spaces, and swaps a repeated operator', () => {
    const plus = press('10', 2, 2, { kind: 'operator', op: '+' });
    expect(plus).toEqual({ text: '10 + ', caret: 5 });
    const minus = press(plus?.text ?? '', 5, 5, { kind: 'operator', op: '-' });
    expect(minus).toEqual({ text: '10 - ', caret: 5 });
  });
  it('backspace removes one char, a whole " + ", or the selection', () => {
    expect(press('125', 3, 3, { kind: 'backspace' })).toEqual({ text: '12', caret: 2 });
    expect(press('10 + ', 5, 5, { kind: 'backspace' })).toEqual({ text: '10', caret: 2 });
    expect(press('12345', 1, 4, { kind: 'backspace' })).toEqual({ text: '15', caret: 1 });
    expect(press('', 0, 0, { kind: 'backspace' })).toEqual({ text: '', caret: 0 });
  });
  it('param names multiply when they follow a number or name', () => {
    expect(press('', 0, 0, { kind: 'param', name: 'width' })).toEqual({ text: 'width', caret: 5 });
    expect(press('2', 1, 1, { kind: 'param', name: 'width' })).toEqual({
      text: '2 * width',
      caret: 9,
    });
    expect(press('width + ', 8, 8, { kind: 'param', name: 'wall' })).toEqual({
      text: 'width + wall',
      caret: 12,
    });
    expect(press('(', 1, 1, { kind: 'param', name: 'wall' })).toEqual({ text: '(wall', caret: 5 });
  });
  it('parentheses insert literally; clear empties; arrows move the caret within bounds', () => {
    expect(press('2 * ', 4, 4, digit('('))).toEqual({ text: '2 * (', caret: 5 });
    expect(press('abc', 3, 3, { kind: 'clear' })).toEqual({ text: '', caret: 0 });
    expect(press('abc', 1, 1, { kind: 'move', dir: -1 })).toEqual({ text: 'abc', caret: 0 });
    expect(press('abc', 0, 0, { kind: 'move', dir: -1 })?.caret).toBe(0);
    expect(press('abc', 3, 3, { kind: 'move', dir: 1 })?.caret).toBe(3);
    expect(press('abc', 0, 3, { kind: 'move', dir: 1 })?.caret).toBe(3);
  });
  it('non-editing keys return null', () => {
    expect(press('1', 1, 1, { kind: 'enter' })).toBeNull();
    expect(press('1', 1, 1, { kind: 'close' })).toBeNull();
    expect(press('1', 1, 1, { kind: 'osKeyboard' })).toBeNull();
  });
  it('builds an expression the evaluator would read: 2 * width + 1/8in', () => {
    let t = '';
    let c = 0;
    const keys: KeypadKey[] = [
      digit('2'),
      { kind: 'param', name: 'width' },
      { kind: 'operator', op: '+' },
      digit('1'),
      { kind: 'operator', op: '/' },
      digit('8'),
      { kind: 'unit', unit: 'in' },
    ];
    for (const k of keys) {
      const r = applyKeypadKey(t, c, c, k);
      if (r) {
        t = r.text;
        c = r.caret;
      }
    }
    expect(t).toBe('2 * width + 1 / 8in');
  });
});

/* ------------------------------------------------------------------ tutorial state machine */

describe('tutorial state machine', () => {
  const steps = bracketTutorial;
  const run = (s: TutorialState, ...a: Parameters<typeof tutorialReducer>[2][]) =>
    a.reduce((acc, x) => tutorialReducer(steps, acc, x), s);

  it('has touch-first, ordered bracket content with unique ids', () => {
    expect(steps.map((s) => s.id)).toEqual([
      'sketch',
      'rectangle',
      'dimension',
      'extrude',
      'holes',
      'fillet',
      'params',
      'export',
    ]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    for (const s of steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(10);
      expect(s.target ?? s.anchor).toBeTruthy();
    }
    expect(steps.map((s) => s.body).join(' ')).toMatch(/\bTap\b/);
  });

  it('starts running at step 0', () => {
    expect(initialTutorial).toEqual({ index: 0, status: 'running' });
    expect(tutorialProgress(steps, initialTutorial)).toMatchObject({ current: 1, total: 8 });
  });

  it('advances on a condition, only for the current step', () => {
    let s = run(initialTutorial, { type: 'advance', from: 'sketch' });
    expect(s.index).toBe(1);
    // the same condition firing twice is ignored
    s = run(s, { type: 'advance', from: 'sketch' });
    expect(s.index).toBe(1);
    // a condition for a later step does not skip ahead
    s = run(s, { type: 'advance', from: 'extrude' });
    expect(s.index).toBe(1);
    s = run(s, { type: 'advance' });
    expect(s.index).toBe(2);
  });

  it('finishes after the last step and then ignores everything but restart and closing', () => {
    let s: TutorialState = { index: steps.length - 1, status: 'running' };
    s = run(s, { type: 'advance', from: 'export' });
    expect(s.status).toBe('done');
    expect(tutorialProgress(steps, s)).toMatchObject({ current: 8, fraction: 1 });
    expect(run(s, { type: 'advance' })).toEqual(s);
    expect(run(s, { type: 'back' })).toEqual(s);
    expect(run(s, { type: 'skip' }).status).toBe('skipped');
    expect(run(s, { type: 'restart' })).toEqual(initialTutorial);
    expect(run({ index: 2, status: 'skipped' }, { type: 'advance' }).status).toBe('skipped');
  });

  it('skip ends it from any step; back never goes below 0; goto jumps by id', () => {
    expect(run({ index: 3, status: 'running' }, { type: 'skip' }).status).toBe('skipped');
    expect(run(initialTutorial, { type: 'back' }).index).toBe(0);
    expect(run({ index: 3, status: 'running' }, { type: 'back' }).index).toBe(2);
    expect(run(initialTutorial, { type: 'goto', id: 'fillet' }).index).toBe(5);
    expect(run(initialTutorial, { type: 'goto', id: 'nope' })).toEqual(initialTutorial);
  });

  it('reports progress as completed steps over total', () => {
    expect(tutorialProgress(steps, { index: 4, status: 'running' }).fraction).toBeCloseTo(0.5);
  });
});

/* ------------------------------------------------------------------ measurements */

describe('measurement readings', () => {
  it('formats each kind with units and a true minus', () => {
    expect(readMeasurement({ length: 60 })).toMatchObject({
      kind: 'length',
      label: 'Length',
      value: '60.00',
      unit: 'mm',
    });
    expect(readMeasurement({ angle: Math.PI / 2 })).toMatchObject({
      value: '90.00',
      unit: '°',
    });
    expect(readMeasurement({ area: 1800 })).toMatchObject({
      value: '1,800.0',
      unit: 'mm²',
    });
    const r = readMeasurement({ radius: 5 });
    expect(r?.label).toBe('Radius');
    expect(r?.extra).toEqual([{ label: 'Diameter', value: '10.00', unit: 'mm' }]);
    const d = readMeasurement({ distance: { value: 42.5, a: [0, 0, 0], b: [30, -25.5, 17] } });
    expect(d?.parts?.map((p) => p.value)).toEqual(['30.00', '−25.50', '17.00']);
    const p = readMeasurement({ position: [1, 2, 3] });
    expect(p?.parts?.map((x) => x.axis)).toEqual(['X', 'Y', 'Z']);
    expect(readMeasurement({})).toBeNull();
  });
  it('leads with the distance and lists the other quantities', () => {
    const m: Measurement = { distance: { value: 6, a: [0, 0, 0], b: [0, 0, 6] }, angle: Math.PI };
    expect(measurementKind(m)).toBe('distance');
    expect(readMeasurement(m)?.extra).toEqual([{ label: 'Angle', value: '180.00', unit: '°' }]);
    const edge = readMeasurement({ length: 31.416, radius: 5 });
    expect(edge?.kind).toBe('length');
    expect(edge?.extra?.map((x) => x.label)).toEqual(['Radius', 'Diameter']);
  });
  it('converts to inches', () => {
    expect(readMeasurement({ length: 25.4 }, 'in')).toMatchObject({
      value: '1.0000',
      unit: 'in',
    });
    expect(readMeasurement({ area: 645.16 }, 'in')?.unit).toBe('in²');
  });
  it('speaks readings', () => {
    expect(speakMeasurement({ angle: Math.PI })).toBe('Angle 180.00 degrees');
    expect(speakMeasurement({ length: 3 }, 'in')).toContain('inches');
    expect(speakMeasurement({ area: 10 })).toBe('Area 10.0 square millimetres');
  });
  it('parses and formats lengths', () => {
    expect(parseLengthMm('12')).toBe(12);
    expect(parseLengthMm('0.5in')).toBeCloseTo(12.7);
    expect(parseLengthMm('1.5 cm')).toBe(15);
    expect(parseLengthMm('−3mm')).toBe(-3);
    expect(parseLengthMm('12', 'in')).toBeCloseTo(304.8);
    expect(parseLengthMm('width')).toBeNull();
    expect(formatLengthMm(12.345)).toBe('12.35mm');
    expect(parseLengthMm(formatLengthMm(25.4, 'in'), 'in')).toBeCloseTo(25.4, 2);
  });
});
