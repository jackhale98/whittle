import { describe, expect, it } from 'vitest';
import {
  canDockBoth,
  DOCK_MIN_WIDTH,
  DRAWING_DOCK_MIN_WIDTH,
  dockedViewWidth,
  MIN_VIEW_WIDTH,
} from '../src/logic/dock';

describe('tablet panel docking (ADR-099)', () => {
  it('docks both panels on landscape iPads and overlays on portrait ones', () => {
    for (const w of [1180, 1194, 1366]) expect(canDockBoth(w)).toBe(true);
    for (const w of [744, 768, 810, 820, 834, 1024]) expect(canDockBoth(w)).toBe(false);
  });

  it('the threshold is the width that leaves the minimum view', () => {
    expect(dockedViewWidth(1180)).toBe(1180 - 16 - 296 - 304);
    expect(dockedViewWidth(DOCK_MIN_WIDTH)).toBe(MIN_VIEW_WIDTH);
    expect(canDockBoth(DOCK_MIN_WIDTH)).toBe(true);
    expect(canDockBoth(DOCK_MIN_WIDTH - 1)).toBe(false);
  });

  it('a wider left panel needs a wider window', () => {
    expect(canDockBoth(1180, 420)).toBe(false);
  });

  it('the drawing side panel docks from 888', () => {
    expect(DRAWING_DOCK_MIN_WIDTH).toBe(888);
  });
});
