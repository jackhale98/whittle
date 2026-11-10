import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TAP_MAX_MS } from '../src/constants';
import {
  type GestureOutput,
  GestureRecognizer,
  type PointerKind,
  type PointerSample,
} from '../src/gestures';

/** Tiny driver: feeds samples with a running clock and collects outputs. */
class Driver {
  readonly r = new GestureRecognizer();
  t = 1000;
  out: GestureOutput[] = [];
  feed(
    type: PointerSample['type'],
    id: number,
    x: number,
    y: number,
    pointerType: PointerKind = 'touch',
    extra: Partial<PointerSample> = {},
  ) {
    this.out.push(
      ...this.r.handle({ type, id, x, y, pointerType, t: this.t, button: 0, ...extra }),
    );
  }
  wait(ms: number) {
    this.t += ms;
    this.out.push(...this.r.tick(this.t));
  }
  gestures() {
    return this.out.flatMap((o) => (o.type === 'gesture' ? [o.gesture.kind] : []));
  }
}

describe('gesture recognizer: taps', () => {
  it('a short stationary press is a tap at the press point', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.wait(80);
    d.feed('up', 1, 101, 80);
    expect(d.out).toEqual([
      { type: 'gesture', gesture: { kind: 'tap', x: 101 - 1, y: 80, pointerType: 'touch' } },
    ]);
  });

  it('does not fire after a drag', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.wait(30);
    d.feed('move', 1, 130, 80);
    d.wait(30);
    d.feed('up', 1, 130, 80);
    expect(d.gestures()).toEqual([]);
  });

  it('does not fire when released only after the tap time limit', () => {
    const d = new Driver();
    d.feed('down', 1, 10, 10);
    d.wait(TAP_MAX_MS + 1);
    d.feed('up', 1, 10, 10);
    expect(d.gestures()).toEqual([]);
  });

  it('a drag that returns to its start still counts as moved', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.feed('move', 1, 140, 80);
    d.feed('move', 1, 100, 80);
    d.feed('up', 1, 100, 80);
    expect(d.gestures()).toEqual([]);
  });

  it('two taps within 300 ms and 10 px make tap then doubleTap', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.wait(50);
    d.feed('up', 1, 100, 80);
    d.wait(120);
    d.feed('down', 2, 106, 84);
    d.wait(50);
    d.feed('up', 2, 106, 84);
    expect(d.gestures()).toEqual(['tap', 'doubleTap']);
  });

  it('a third tap starts a new sequence', () => {
    const d = new Driver();
    for (let i = 0; i < 3; i++) {
      d.feed('down', i, 100, 80);
      d.wait(40);
      d.feed('up', i, 100, 80);
      d.wait(60);
    }
    expect(d.gestures()).toEqual(['tap', 'doubleTap', 'tap']);
  });

  it('too slow or too far apart is two taps', () => {
    const slow = new Driver();
    slow.feed('down', 1, 100, 80);
    slow.feed('up', 1, 100, 80);
    slow.wait(400);
    slow.feed('down', 2, 100, 80);
    slow.feed('up', 2, 100, 80);
    expect(slow.gestures()).toEqual(['tap', 'tap']);

    const far = new Driver();
    far.feed('down', 1, 100, 80);
    far.feed('up', 1, 100, 80);
    far.wait(100);
    far.feed('down', 2, 130, 80);
    far.feed('up', 2, 130, 80);
    expect(far.gestures()).toEqual(['tap', 'tap']);
  });

  it('a drag between two taps breaks the double-tap', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.feed('up', 1, 100, 80);
    d.wait(60);
    d.feed('down', 2, 100, 80);
    d.feed('move', 2, 150, 80);
    d.feed('up', 2, 150, 80);
    d.wait(60);
    d.feed('down', 3, 100, 80);
    d.feed('up', 3, 100, 80);
    expect(d.gestures()).toEqual(['tap', 'tap']);
  });

  it('only the primary mouse button taps', () => {
    const d = new Driver();
    d.feed('down', 1, 5, 5, 'mouse', { button: 2 });
    d.feed('up', 1, 5, 5, 'mouse', { button: 2 });
    expect(d.gestures()).toEqual([]);
    d.feed('down', 2, 5, 5, 'mouse');
    d.feed('up', 2, 5, 5, 'mouse');
    expect(d.out.map((o) => o.type === 'gesture' && o.gesture.pointerType)).toEqual(['mouse']);
  });

  it('a press that starts on a handle never forms a gesture', () => {
    const d = new Driver();
    d.feed('down', 1, 5, 5, 'touch', { onHandle: true });
    d.feed('up', 1, 5, 5);
    expect(d.out).toEqual([]);
  });
});

describe('gesture recognizer: long-press', () => {
  it('fires once at 500 ms for a stationary finger, then releases navigation, no tap on lift', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    expect(d.r.nextDeadline()).toBe(d.t + LONG_PRESS_MS);
    d.wait(LONG_PRESS_MS - 1);
    expect(d.gestures()).toEqual([]);
    d.wait(1);
    expect(d.gestures()).toEqual(['longPress']);
    expect(d.out.some((o) => o.type === 'releaseNavigation' && o.id === 1)).toBe(true);
    expect(d.out.some((o) => o.type === 'gesture' && o.gesture.pointerId === 1)).toBe(true);
    d.feed('up', 1, 100, 80);
    expect(d.gestures()).toEqual(['longPress']);
    expect(d.r.nextDeadline()).toBeNull();
  });

  it('is cancelled by movement beyond 8 px (and a small wobble is fine)', () => {
    const wobble = new Driver();
    wobble.feed('down', 1, 100, 80);
    wobble.feed('move', 1, 105, 83);
    wobble.wait(LONG_PRESS_MS);
    expect(wobble.gestures()).toEqual(['longPress']);

    const drag = new Driver();
    drag.feed('down', 1, 100, 80);
    drag.wait(100);
    drag.feed('move', 1, 112, 80);
    expect(drag.r.nextDeadline()).toBeNull();
    drag.wait(LONG_PRESS_MS);
    expect(drag.gestures()).toEqual([]);
  });

  it('a second finger cancels it', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80);
    d.wait(100);
    d.feed('down', 2, 200, 80);
    d.wait(LONG_PRESS_MS);
    expect(d.gestures()).toEqual([]);
  });

  it('mice have no long-press', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 80, 'mouse');
    expect(d.r.nextDeadline()).toBeNull();
  });
});

describe('gesture recognizer: multi-finger taps', () => {
  it('two fingers down and up together is a twoFingerTap at their centroid', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 100);
    d.feed('down', 2, 160, 120);
    d.wait(80);
    d.feed('up', 1, 100, 100);
    d.feed('up', 2, 160, 120);
    expect(d.out).toEqual([
      { type: 'gesture', gesture: { kind: 'twoFingerTap', x: 130, y: 110, pointerType: 'touch' } },
    ]);
  });

  it('three fingers is a threeFingerTap', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 100);
    d.feed('down', 2, 160, 120);
    d.feed('down', 3, 220, 100);
    d.wait(80);
    d.feed('up', 3, 220, 100);
    d.feed('up', 2, 160, 120);
    d.feed('up', 1, 100, 100);
    expect(d.gestures()).toEqual(['threeFingerTap']);
  });

  it('a pinch or pan is not a tap', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 100);
    d.feed('down', 2, 160, 100);
    d.wait(40);
    d.feed('move', 2, 190, 100);
    d.feed('up', 1, 100, 100);
    d.feed('up', 2, 190, 100);
    expect(d.gestures()).toEqual([]);
  });

  it('lifting one finger of two and putting it back does not emit a one-finger tap', () => {
    const d = new Driver();
    d.feed('down', 1, 100, 100);
    d.feed('down', 2, 160, 100);
    d.feed('up', 2, 160, 100);
    d.wait(30);
    d.feed('up', 1, 100, 100);
    expect(d.gestures()).toEqual(['twoFingerTap']);
  });
});

describe('gesture recognizer: twist', () => {
  const spread = (d: Driver, angle: number) => {
    const r = 60;
    d.feed('move', 1, 200 - r * Math.cos(angle), 200 - r * Math.sin(angle));
    d.feed('move', 2, 200 + r * Math.cos(angle), 200 + r * Math.sin(angle));
  };

  it('ignores the first 5 degrees, then reports deltas without a jump', () => {
    const d = new Driver();
    d.feed('down', 1, 140, 200);
    d.feed('down', 2, 260, 200);
    const deg = Math.PI / 180;
    const total = () => d.out.reduce((a, o) => a + (o.type === 'twist' ? o.delta : 0), 0);
    spread(d, 3 * deg);
    expect(total()).toBe(0);
    spread(d, 8 * deg); // crosses the threshold: still nothing yet
    spread(d, 28 * deg);
    // From the crossing move onward the whole remaining rotation is reported.
    expect(total()).toBeGreaterThan(18 * deg);
    expect(total()).toBeLessThanOrEqual(23.001 * deg);
  });

  it('wraps across +-180 degrees', () => {
    const d = new Driver();
    d.feed('down', 1, 140, 200);
    d.feed('down', 2, 260, 200);
    const deg = Math.PI / 180;
    for (let a = 0; a <= 360; a += 6) spread(d, (a * deg) % (2 * Math.PI));
    const sum = d.out.reduce((a, o) => a + (o.type === 'twist' ? o.delta : 0), 0);
    expect(Math.abs(sum)).toBeGreaterThan(300 * deg);
    expect(Math.abs(sum)).toBeLessThan(361 * deg);
  });

  it('never twists with one or three fingers', () => {
    const d = new Driver();
    d.feed('down', 1, 140, 200);
    d.feed('move', 1, 150, 230);
    expect(d.out).toEqual([]);
  });
});

describe('gesture recognizer: pen policy and palm rejection', () => {
  it('without penDraws a pen behaves like a mouse (taps, camera allowed)', () => {
    const d = new Driver();
    expect(d.r.blocksCamera('pen')).toBe(false);
    d.feed('down', 1, 10, 10, 'pen');
    d.feed('up', 1, 10, 10, 'pen');
    expect(d.gestures()).toEqual(['tap']);
  });

  it('with penDraws pen pointers are the app’s: no camera, no gestures', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true });
    expect(d.r.blocksCamera('pen')).toBe(true);
    expect(d.r.blocksCamera('touch')).toBe(false);
    d.feed('down', 1, 10, 10, 'pen');
    d.feed('move', 1, 40, 10, 'pen');
    d.feed('up', 1, 40, 10, 'pen');
    expect(d.out).toEqual([]);
  });

  it('suppresses touch taps while the pen is down and for palmRejectMs (default 500) after', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true });
    d.feed('down', 1, 10, 10, 'pen');
    // palm lands and lifts during the stroke
    d.wait(50);
    d.feed('down', 2, 80, 80);
    d.wait(40);
    d.feed('up', 2, 80, 80);
    d.wait(100);
    d.feed('up', 1, 12, 10, 'pen');
    // within the window
    d.wait(300);
    d.feed('down', 3, 80, 80);
    d.wait(40);
    d.feed('up', 3, 80, 80);
    expect(d.gestures()).toEqual([]);
    // after the window
    d.wait(600);
    d.feed('down', 4, 80, 80);
    d.wait(40);
    d.feed('up', 4, 80, 80);
    expect(d.gestures()).toEqual(['tap']);
  });

  it('honours a custom palmRejectMs', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true, palmRejectMs: 100 });
    d.feed('down', 1, 10, 10, 'pen');
    d.feed('up', 1, 10, 10, 'pen');
    d.wait(150);
    d.feed('down', 2, 80, 80);
    d.feed('up', 2, 80, 80);
    expect(d.gestures()).toEqual(['tap']);
  });

  it('suppresses long-press and multi-finger taps too', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true });
    d.feed('down', 1, 10, 10, 'pen');
    d.wait(10);
    d.feed('down', 2, 80, 80);
    d.wait(LONG_PRESS_MS + 10);
    d.feed('up', 2, 80, 80);
    d.feed('up', 1, 10, 10, 'pen');
    d.wait(200);
    d.feed('down', 3, 80, 80);
    d.feed('down', 4, 120, 80);
    d.wait(30);
    d.feed('up', 3, 80, 80);
    d.feed('up', 4, 120, 80);
    expect(d.gestures()).toEqual([]);
  });

  it('a finger already down when the pen lands cannot tap', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true });
    d.feed('down', 1, 80, 80);
    d.wait(20);
    d.feed('down', 2, 10, 10, 'pen');
    d.wait(20);
    d.feed('up', 2, 10, 10, 'pen');
    d.wait(20);
    d.feed('up', 1, 80, 80);
    expect(d.gestures()).toEqual([]);
  });

  it('fingers keep navigating: twist is still reported during palm rejection', () => {
    const d = new Driver();
    d.r.setPolicy({ penDraws: true });
    d.feed('down', 9, 10, 10, 'pen');
    d.feed('down', 1, 140, 200);
    d.feed('down', 2, 260, 200);
    const a = (40 * Math.PI) / 180;
    d.feed('move', 1, 200 - 60 * Math.cos(a), 200 - 60 * Math.sin(a));
    d.feed('move', 2, 200 + 60 * Math.cos(a), 200 + 60 * Math.sin(a));
    expect(d.out.some((o) => o.type === 'twist')).toBe(true);
  });
});
