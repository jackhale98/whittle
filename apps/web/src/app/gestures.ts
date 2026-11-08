/**
 * What the viewport's discrete gestures and the context bubble mean in the app (PLAN §9.1, §9.3).
 * Pure: the workbench feeds the gesture and the current mode in and performs the answer.
 */

import type { DeviceTier, PickKind, ViewportGesture } from '@whittle/contracts';

export type GestureAction = 'select' | 'zoomTo' | 'fit' | 'menu' | 'undo' | 'redo' | null;

export interface GestureMode {
  /** Sketch mode: taps and long-presses go to the sketch session's own pointer path. */
  sketch: boolean;
  /** A drawing tool has a shape in progress (a double-tap ends the chain, it doesn't zoom). */
  drawing: boolean;
  /** Something is under the gesture's point. */
  onGeometry: boolean;
}

/**
 * One path per input: touch taps select through `onGesture` (the pointer-up path ignores touch in
 * model mode), mouse clicks through pointer-up (they carry modifiers), and pen taps also through
 * pointer-up (with `penDraws` the viewport reports no pen gestures).
 */
export function gestureAction(g: ViewportGesture, mode: GestureMode): GestureAction {
  switch (g.kind) {
    case 'tap':
      return g.pointerType === 'touch' && !mode.sketch ? 'select' : null;
    case 'doubleTap':
      if (mode.drawing) return null;
      return mode.onGeometry && !mode.sketch ? 'zoomTo' : 'fit';
    case 'longPress':
      return g.pointerType === 'mouse' || mode.sketch ? null : 'menu';
    case 'twoFingerTap':
      return 'undo';
    case 'threeFingerTap':
      return 'redo';
  }
}

export type BubbleActionId =
  | 'sketch'
  | 'pushPull'
  | 'extrude'
  | 'cut'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'measure'
  | 'section'
  | 'fit'
  | 'undo'
  | 'redo';

export interface BubbleSelection {
  kind: PickKind;
  /** Faces: planar (push/pull, sketch, section plane). */
  planar?: boolean;
}

/**
 * Context bubble actions for the selection (3-4, select first, act second). Tablets get the
 * modeling actions; the phone is viewer-first (measure, section). Empty = nothing to offer.
 */
export function bubbleActions(sel: readonly BubbleSelection[], tier: DeviceTier): BubbleActionId[] {
  if (sel.length === 0 || tier === 'desktop') return [];
  const all = (k: PickKind) => sel.every((s) => s.kind === k);
  const planar = sel.every((s) => s.planar === true);
  const measurable =
    sel.length <= 2 &&
    sel.every((s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex');
  if (tier === 'phone') {
    const out: BubbleActionId[] = [];
    if (measurable) out.push('measure');
    if (sel.length === 1 && all('face') && planar) out.push('section');
    return out;
  }
  if (all('region')) return ['extrude', 'cut', 'revolve'];
  if (all('edge')) return measurable ? ['fillet', 'chamfer', 'measure'] : ['fillet', 'chamfer'];
  if (all('face')) {
    const out: BubbleActionId[] = [];
    if (sel.length === 1 && planar) out.push('sketch');
    if (planar) out.push('pushPull');
    if (measurable) out.push('measure');
    return out;
  }
  return measurable ? ['measure'] : [];
}

/** Long-press on empty space: view actions. */
export const VIEW_ACTIONS: readonly BubbleActionId[] = ['fit', 'undo', 'redo'];
