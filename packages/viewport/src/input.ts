import type { CameraChange, InputPolicy, ViewportGesture } from '@wren-cad/contracts';
import { handleAt, setHoveredHandle } from './adornments';
import { applyRoll } from './camera';
import { LONG_PRESS_GRACE_MS, LONG_PRESS_JANK_MS } from './constants';
import type { GestureOutput, PointerKind, PointerSample } from './gestures';
import { eventTime, inputPending } from './internal';
import { dispatchNav } from './navControl';
import type { Mods, NavPointerKind, NavSample } from './navigation';
import { defaultTolerance } from './pick';
import { requestRender } from './renderLoop';
import type { ViewportImpl } from './viewport';
import { onWheel } from './wheel';

export function attachInput(vp: ViewportImpl): void {
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
  ) => {
    vp.canvas.addEventListener(type, fn);
    vp.cleanup.push(() => vp.canvas.removeEventListener(type, fn));
  };

  on('contextmenu', (e) => e.preventDefault());
  // Capture phase on the canvas runs before camera-controls' own wheel listener (also on the
  // canvas); stopImmediatePropagation keeps it (and its ctrl+wheel pinch zoom) out.
  const wheelListener = (e: WheelEvent) => onWheel(vp, e);
  vp.canvas.addEventListener('wheel', wheelListener, { capture: true, passive: false });
  vp.cleanup.push(() => vp.canvas.removeEventListener('wheel', wheelListener, { capture: true }));

  // Wake the render loop whenever the controls start moving.
  const wake = () => {
    vp.cameraAwake = true;
    requestRender(vp);
  };
  const redraw = () => requestRender(vp);
  const sleep = () => {
    vp.cameraAwake = false;
    requestRender(vp); // one more frame so onCamera can report moving=false
  };
  const start = () => {
    vp.interacting = true;
    requestRender(vp);
  };
  const end = () => {
    vp.interacting = false;
    requestRender(vp); // let damping settle
  };
  vp.controls.addEventListener('wake', wake);
  vp.controls.addEventListener('sleep', sleep);
  vp.controls.addEventListener('controlstart', start);
  vp.controls.addEventListener('controlend', end);
  vp.controls.addEventListener('update', redraw);
  vp.cleanup.push(() => {
    vp.controls.removeEventListener('wake', wake);
    vp.controls.removeEventListener('sleep', sleep);
    vp.controls.removeEventListener('controlstart', start);
    vp.controls.removeEventListener('controlend', end);
    vp.controls.removeEventListener('update', redraw);
  });

  attachPointerGestures(vp);
}

export function setInputPolicy(vp: ViewportImpl, policy: InputPolicy): void {
  vp.recognizer.setPolicy(policy);
}

export function onGesture(vp: ViewportImpl, listener: (g: ViewportGesture) => void): () => void {
  vp.appOwnsGestures = true; // the app decides what a double tap means from now on
  vp.gestureListeners.add(listener);
  return () => {
    vp.gestureListeners.delete(listener);
  };
}

export function onCamera(vp: ViewportImpl, listener: (c: CameraChange) => void): () => void {
  vp.cameraListeners.add(listener);
  vp.lastEmittedMoving = vp.isCameraMoving();
  return () => {
    vp.cameraListeners.delete(listener);
  };
}

/** camera-controls' public `enabled` setter cancels drags; we only veto a single pointerdown. */
export function setCameraEnabled(vp: ViewportImpl, enabled: boolean): void {
  (vp.controls as unknown as { _enabled: boolean })._enabled = enabled;
}

export function attachPointerGestures(vp: ViewportImpl): void {
  const canvas = vp.canvas;
  const kind = (e: PointerEvent): PointerKind =>
    e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
  const sample = (type: PointerSample['type'], e: PointerEvent): PointerSample => {
    const r = canvas.getBoundingClientRect();
    return {
      type,
      id: e.pointerId,
      pointerType: kind(e),
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      t: eventTime(e),
      button: e.button,
    };
  };
  const navSample = (type: NavSample['type'], e: PointerEvent): NavSample => {
    const r = canvas.getBoundingClientRect();
    const mods: Mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    return {
      type,
      id: e.pointerId,
      pointerType: kind(e) as NavPointerKind,
      button: e.button,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      t: eventTime(e),
      mods,
    };
  };
  let vetoed = false;
  const restore = () => {
    if (!vetoed) return;
    vetoed = false;
    setCameraEnabled(vp, true);
  };
  // Capture phase on window runs before camera-controls' own pointerdown listener.
  const down = (e: PointerEvent) => {
    if (e.target !== canvas || vp.disposed) return;
    // A host-replayed press (e.g. sketch mode handing a held-back finger to the camera) is for
    // camera-controls only: the recogniser already saw the real one, and a second entry would
    // reset that finger's start and tap slop.
    if (!e.isTrusted) return;
    const s = sample('down', e);
    const handle = handleAt(vp, s.x, s.y, defaultTolerance(s.pointerType));
    if (handle) {
      s.onHandle = true;
      setHoveredHandle(vp, handle.id);
    }
    const blocked = handle !== null || vp.recognizer.blocksCamera(s.pointerType);
    // Mouse and pen never reach camera-controls (the navigation machine drives them); touch
    // does, for the two/three-finger gestures.
    if (blocked || s.pointerType !== 'touch') {
      vetoed = true;
      setCameraEnabled(vp, false);
      setTimeout(restore, 0); // in case an app listener stops propagation before the bubble hook
    }
    dispatch(vp, vp.recognizer.handle(s));
    armLongPress(vp);
    if (!blocked && s.pointerType !== 'mouse') {
      // Touch and pen: the app may keep the press for itself (sketch drawing and dimensioning
      // stop its propagation on the canvas). The navigation machine therefore sees it only if
      // it reaches the window's bubble phase (`navDownLate`), never in this capture hook.
      vp.navButton = e.button;
      vp.lateNavDown = navSample('down', e);
    } else if (!blocked) {
      vp.navButton = e.button;
      dispatchNav(vp, vp.navMachine.handle(navSample('down', e)));
      if (s.pointerType === 'mouse' && vp.navMachine.tracking()) {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // synthetic or already-released pointer: the window listeners still see the moves
        }
      }
    }
  };
  const navDownLate = (e: PointerEvent) => {
    const late = vp.lateNavDown;
    vp.lateNavDown = null;
    if (vp.disposed || !late || late.id !== e.pointerId) return;
    dispatchNav(vp, vp.navMachine.handle(late));
  };
  const move = (e: PointerEvent) => {
    if (vp.disposed) return;
    if (e.target === canvas && e.buttons === 0 && vp.handles.size > 0) {
      const s = sample('move', e);
      setHoveredHandle(vp, handleAt(vp, s.x, s.y, defaultTolerance(s.pointerType))?.id ?? null);
    }
    dispatch(vp, vp.recognizer.handle(sample('move', e)));
    armLongPress(vp);
    if (vp.navMachine.tracking()) {
      // A release outside the window without capture never arrives: treat "no buttons" as up.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        dispatchNav(vp, vp.navMachine.handle({ ...navSample('up', e), button: vp.navButton }));
      } else {
        dispatchNav(vp, vp.navMachine.handle(navSample('move', e)));
      }
    }
  };
  const end = (type: 'up' | 'cancel') => (e: PointerEvent) => {
    if (vp.disposed) return;
    dispatch(vp, vp.recognizer.handle(sample(type, e)));
    armLongPress(vp);
    dispatchNav(vp, vp.navMachine.handle(navSample(type, e)));
  };
  const blur = () => dispatchNav(vp, vp.navMachine.abort());
  const up = end('up');
  const cancel = end('cancel');
  const leave = () => setHoveredHandle(vp, null);
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerdown', restore, false);
  window.addEventListener('pointerdown', navDownLate, false);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  canvas.addEventListener('pointerleave', leave);
  window.addEventListener('blur', blur);
  // Middle-button auto-scroll would grab the pointer on some platforms.
  const noMiddle = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
  canvas.addEventListener('mousedown', noMiddle);
  canvas.addEventListener('auxclick', noMiddle);
  vp.cleanup.push(() => {
    window.removeEventListener('blur', blur);
    canvas.removeEventListener('mousedown', noMiddle);
    canvas.removeEventListener('auxclick', noMiddle);
    clearTimeout(vp.pivotFlashTimer);
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerdown', restore, false);
    window.removeEventListener('pointerdown', navDownLate, false);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    canvas.removeEventListener('pointerleave', leave);
    clearTimeout(vp.longPressTimer);
  });
}

export function armLongPress(vp: ViewportImpl, graceUsed = false): void {
  clearTimeout(vp.longPressTimer);
  const at = vp.recognizer.nextDeadline();
  if (at === null) return;
  vp.longPressTimer = window.setTimeout(
    () => {
      const now = performance.now();
      // A late timer means the main thread was busy at the deadline: a lift or move that queued
      // behind that work has not been seen yet (on a loaded phone a 50 ms tap fired as a
      // long-press, opened the radial menu and the menu then ate the next tap). Give queued input
      // one short chance to end or move the press first; Chromium also reports it directly.
      if (!graceUsed && (now - at > LONG_PRESS_JANK_MS || inputPending())) {
        armLongPressAfter(vp, LONG_PRESS_GRACE_MS);
        return;
      }
      dispatch(vp, vp.recognizer.tick(now));
      armLongPress(vp); // timers can fire a hair early: re-arm until the deadline passes
    },
    Math.max(0, at - performance.now()),
  );
}

export function armLongPressAfter(vp: ViewportImpl, ms: number): void {
  clearTimeout(vp.longPressTimer);
  vp.longPressTimer = window.setTimeout(() => {
    dispatch(vp, vp.recognizer.tick(performance.now()));
    armLongPress(vp, true);
  }, ms);
}

export function dispatch(vp: ViewportImpl, outputs: GestureOutput[]): void {
  for (const o of outputs) {
    if (o.type === 'gesture') emitGesture(vp, o.gesture);
    else if (o.type === 'twist') applyRoll(vp, o.delta);
    else {
      vp.controls.cancel(); // a long-press fired: the held finger must not orbit
      dispatchNav(vp, vp.navMachine.abort());
    }
  }
}

export function emitGesture(vp: ViewportImpl, g: ViewportGesture): void {
  if (!vp.appOwnsGestures) {
    if (g.kind === 'doubleTap') vp.fitAll(true); // M1 behaviour until the app takes over
    return;
  }
  for (const l of [...vp.gestureListeners]) l(g);
}
