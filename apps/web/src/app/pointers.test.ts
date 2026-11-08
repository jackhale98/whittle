import { describe, expect, it } from 'vitest';
import { PointerDowns } from './pointers';

const ev = (pointerId: number, pointerType: string, clientX = 0, clientY = 0) => ({
  pointerId,
  pointerType,
  clientX,
  clientY,
});

describe('PointerDowns', () => {
  it('a pen tap with a finger resting on the screen keeps its own press (D9)', () => {
    const downs = new PointerDowns();
    downs.press(ev(7, 'pen', 100, 120)); // the Pencil goes down…
    downs.press(ev(2, 'touch', 400, 500)); // …then the palm or a finger
    // The pen lifts first: its release finds the pen's press, not the finger's.
    expect(downs.release(7)).toEqual({ x: 100, y: 120, id: 7, type: 'pen' });
    expect(downs.release(2)).toEqual({ x: 400, y: 500, id: 2, type: 'touch' });
    expect(downs.size).toBe(0);
  });

  it('two fingers: each release matches its own finger; unknown or dropped ids give null', () => {
    const downs = new PointerDowns();
    downs.press(ev(1, 'touch', 10, 10));
    downs.press(ev(2, 'touch', 50, 50));
    expect(downs.release(2)?.x).toBe(50);
    expect(downs.release(2)).toBeNull();
    downs.drop(1);
    expect(downs.release(1)).toBeNull();
    expect(downs.release(99)).toBeNull();
  });
});
