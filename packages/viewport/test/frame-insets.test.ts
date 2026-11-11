import { describe, expect, it } from 'vitest';
import { fitDistance, fitInsetFrame } from '../src/views';

const none = { top: 0, right: 0, bottom: 0, left: 0 };

describe('fitInsetFrame', () => {
  it('matches fitDistance with no insets and no shift', () => {
    const f = fitInsetFrame(50, 45, 390, 844, none);
    expect(f.distance).toBeCloseTo(fitDistance(50, 45, 390 / 844), 9);
    expect(f.shiftRight).toBeCloseTo(0, 9);
    expect(f.shiftUp).toBeCloseTo(0, 9);
  });

  it('backs off and shifts the target down for a bottom sheet', () => {
    // A landscape canvas is height-limited, so the sheet makes the camera back off.
    const f = fitInsetFrame(50, 45, 800, 600, { ...none, top: 54, bottom: 300 });
    expect(f.distance).toBeGreaterThan(fitDistance(50, 45, 800 / 600));
    // The free area's centre is above the canvas centre, so the look-at target moves below the model.
    expect(f.shiftUp).toBeLessThan(0);
    expect(f.shiftRight).toBeCloseTo(0, 9);
  });

  it('keeps the sphere inside the free area', () => {
    const f = fitInsetFrame(50, 45, 390, 844, { ...none, top: 54, bottom: 400 });
    const tanHalf = Math.tan((45 * Math.PI) / 360);
    const pxPerWorld = 844 / (2 * f.distance * tanHalf);
    expect(50 * pxPerWorld).toBeLessThanOrEqual((844 - 454) / 2);
    expect(50 * pxPerWorld).toBeLessThanOrEqual(390 / 2);
  });
});
