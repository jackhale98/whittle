import type { ViewportGesture } from '@wren-cad/contracts';
import { describe, expect, it } from 'vitest';
import { bubbleActions, type GestureMode, gestureAction, VIEW_ACTIONS } from './gestures';

const g = (
  kind: ViewportGesture['kind'],
  pointerType: ViewportGesture['pointerType'] = 'touch',
) => ({
  kind,
  x: 10,
  y: 20,
  pointerType,
});
const model: GestureMode = { sketch: false, drawing: false, onGeometry: true };

describe('gesture map (PLAN §9.3)', () => {
  it('touch taps select in model mode; mouse and sketch taps use the pointer path', () => {
    expect(gestureAction(g('tap'), model)).toBe('select');
    expect(gestureAction(g('tap', 'mouse'), model)).toBeNull();
    expect(gestureAction(g('tap', 'pen'), model)).toBeNull();
    expect(gestureAction(g('tap'), { ...model, sketch: true })).toBeNull();
  });
  it('double-tap: zoom to geometry, fit on empty space; never while a shape is being drawn', () => {
    expect(gestureAction(g('doubleTap'), model)).toBe('zoomTo');
    expect(gestureAction(g('doubleTap'), { ...model, onGeometry: false })).toBe('fit');
    expect(gestureAction(g('doubleTap', 'mouse'), model)).toBe('zoomTo');
    expect(gestureAction(g('doubleTap'), { ...model, sketch: true })).toBe('fit');
    expect(gestureAction(g('doubleTap'), { ...model, sketch: true, drawing: true })).toBeNull();
    // A drawing or dimension tool with nothing in progress: two quick taps are tool clicks.
    expect(gestureAction(g('doubleTap'), { ...model, sketch: true, tool: true })).toBeNull();
    expect(
      gestureAction(g('doubleTap'), { ...model, sketch: true, tool: false, onGeometry: false }),
    ).toBe('fit');
    // Multi-finger taps still undo / redo while a tool is active.
    expect(gestureAction(g('twoFingerTap'), { ...model, sketch: true, tool: true })).toBe('undo');
    expect(gestureAction(g('threeFingerTap'), { ...model, sketch: true, tool: true })).toBe('redo');
  });
  it('long-press opens the context bubble (touch and pen, not in sketch mode)', () => {
    expect(gestureAction(g('longPress'), model)).toBe('menu');
    expect(gestureAction(g('longPress', 'mouse'), model)).toBeNull();
    expect(gestureAction(g('longPress'), { ...model, sketch: true })).toBeNull();
  });
  it('two-finger tap undoes and three-finger tap redoes, in any mode', () => {
    expect(gestureAction(g('twoFingerTap'), model)).toBe('undo');
    expect(gestureAction(g('threeFingerTap'), { ...model, sketch: true })).toBe('redo');
  });
});

describe('context bubble actions', () => {
  it('tablet: face, edge and region actions', () => {
    expect(bubbleActions([{ kind: 'face', planar: true }], 'tablet')).toEqual([
      'sketch',
      'pushPull',
      'hole',
      'measure',
    ]);
    expect(bubbleActions([{ kind: 'face', planar: false }], 'tablet')).toEqual([
      'thread',
      'measure',
    ]);
    expect(
      bubbleActions(
        [
          { kind: 'face', planar: true },
          { kind: 'face', planar: true },
        ],
        'tablet',
      ),
    ).toEqual(['pushPull', 'shell', 'draft', 'measure']);
    expect(
      bubbleActions(
        [
          { kind: 'face', planar: true },
          { kind: 'face', planar: true },
          { kind: 'face', planar: false },
        ],
        'tablet',
      ),
    ).toEqual(['shell', 'draft']);
    expect(bubbleActions([{ kind: 'edge' }], 'tablet')).toEqual(['fillet', 'chamfer', 'measure']);
    expect(bubbleActions([{ kind: 'edge' }, { kind: 'edge' }, { kind: 'edge' }], 'tablet')).toEqual(
      ['fillet', 'chamfer'],
    );
    expect(bubbleActions([{ kind: 'region' }], 'tablet')).toEqual([
      'extrude',
      'cut',
      'revolve',
      'sweep',
    ]);
    expect(bubbleActions([{ kind: 'vertex' }], 'tablet')).toEqual(['measure']);
  });
  it('phone: viewer actions only; desktop: none', () => {
    expect(bubbleActions([{ kind: 'face', planar: true }], 'phone')).toEqual([
      'measure',
      'section',
    ]);
    expect(bubbleActions([{ kind: 'edge' }], 'phone')).toEqual(['measure']);
    expect(bubbleActions([{ kind: 'face', planar: true }], 'desktop')).toEqual([]);
    expect(bubbleActions([], 'tablet')).toEqual([]);
    expect(VIEW_ACTIONS).toEqual(['fit', 'undo', 'redo']);
  });
});
