import { describe, expect, it } from 'vitest';
import { fitDistance, fitInsetFrame, insetPan } from '../src/views';

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

describe('insetPan', () => {
  const fov = 45;
  const h = 800;
  const dist = 100;
  const perPx = (2 * dist * Math.tan((fov * Math.PI) / 360)) / h;

  it('is zero when the insets do not change (idempotent)', () => {
    const ins = { ...none, top: 54, bottom: 300 };
    expect(insetPan(ins, ins, fov, h, dist)).toEqual({ right: 0, up: 0 });
  });

  it('opening a bottom sheet trucks the camera down by half the sheet height', () => {
    const p = insetPan(none, { ...none, bottom: 300 }, fov, h, dist);
    expect(p.up).toBeCloseTo(-150 * perPx, 9);
    expect(p.right).toBeCloseTo(0, 9);
  });

  it('collapsing it undoes the pan', () => {
    const open = { ...none, top: 54, bottom: 300 };
    const a = insetPan(none, open, fov, h, dist);
    const b = insetPan(open, none, fov, h, dist);
    expect(a.up + b.up).toBeCloseTo(0, 9);
  });

  it('shifts sideways for left/right insets and scales with distance', () => {
    const p = insetPan(none, { ...none, left: 100 }, fov, h, dist);
    expect(p.right).toBeCloseTo(-50 * perPx, 9);
    expect(insetPan(none, { ...none, bottom: 300 }, fov, h, 2 * dist).up).toBeCloseTo(
      -300 * perPx,
      9,
    );
  });
});
