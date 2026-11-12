/**
 * 3D mouse wiring in the app (M4.5, ADR-096): the device layer (`MotionInput`, built by
 * @wren-cad/viewport) is handed in with `Workbench.setMotionInput(input)`. This module keeps the
 * per-device settings and the button mapping, pushes settings to the device and runs the mapped
 * command when a button is pressed.
 */

import type { MotionButtonCommand, MotionInputState, MotionSettings } from '@wren-cad/contracts';
import {
  commandForButton,
  type MotionButtonMap,
  type MotionInputLike,
  readButtonMap,
  readMotionSettings,
  watchButtons,
  writeButtonMap,
  writeMotionSettings,
} from '@wren-cad/ui';
import { useSyncExternalStore } from 'react';
import type { Workbench } from './workbench';

export interface MotionPrefs {
  settings: MotionSettings;
  buttons: MotionButtonMap;
}

/** Commands run from 3D mouse buttons, newest last (test hook). */
export const motionLog: string[] = [];

export function loadMotionPrefs(): MotionPrefs {
  return { settings: readMotionSettings(), buttons: readButtonMap() };
}

/** What the panel shows before (or without) a device layer. */
const UNSUPPORTED: MotionInputState = { path: 'none', state: 'unsupported' };
const NOT_PAIRED: MotionInputState = { path: 'none', state: 'notPaired' };
export function fallbackMotionState(): MotionInputState {
  return typeof navigator !== 'undefined' && 'hid' in navigator ? NOT_PAIRED : UNSUPPORTED;
}

/** The prefs, read from storage on first use. */
export function ensureMotionPrefs(wb: Workbench): MotionPrefs {
  let p = wb.motionPrefs.get();
  if (!p) {
    p = loadMotionPrefs();
    wb.motionPrefs.set(p);
  }
  return p;
}

export function setMotionSettings(wb: Workbench, settings: MotionSettings): void {
  writeMotionSettings(settings);
  wb.motionPrefs.set({ ...ensureMotionPrefs(wb), settings });
  wb.motionInput.get()?.setSettings(settings);
}

export function setMotionButtons(wb: Workbench, buttons: MotionButtonMap): void {
  writeButtonMap(buttons);
  wb.motionPrefs.set({ ...ensureMotionPrefs(wb), buttons });
}

/** Plug the device layer in (or `null` to unplug). Pushes the stored settings, listens for buttons. */
export function setMotionInput(wb: Workbench, input: MotionInputLike | null): void {
  wb.motionUnwatch?.();
  wb.motionUnwatch = null;
  wb.motionInput.set(input);
  if (!input) return;
  input.setSettings(ensureMotionPrefs(wb).settings);
  wb.motionUnwatch = watchButtons(input, (b) =>
    runMotionCommand(wb, commandForButton(ensureMotionPrefs(wb).buttons, b)),
  );
}

/** Run a mapped command through the app's existing commands (the same ones keys and menus use). */
export function runMotionCommand(wb: Workbench, cmd: MotionButtonCommand): void {
  if (cmd === 'none') return;
  motionLog.push(cmd);
  if (motionLog.length > 50) motionLog.shift();
  switch (cmd) {
    case 'fit':
      wb.viewport?.fitAll(true);
      return;
    case 'radialMenu': {
      if (wb.ui.get().radial) {
        wb.patchUi({ radial: null });
        return;
      }
      const p = wb.lastPointer ?? wb.canvasCentre();
      wb.patchUi({ radial: { x: p.x, y: p.y, source: 'keyboard' }, bubble: null, chooser: null });
      return;
    }
    case 'repeatLast':
      wb.repeatLast();
      return;
    case 'viewFront':
      wb.viewport?.setView('front', true);
      return;
    case 'viewTop':
      wb.viewport?.setView('top', true);
      return;
    case 'viewRight':
      wb.viewport?.setView('right', true);
      return;
    case 'viewIso':
      wb.viewport?.setView('iso', true);
      return;
    case 'toggleRotate':
    case 'toggleDominant': {
      const cur = ensureMotionPrefs(wb).settings;
      const key = cmd === 'toggleRotate' ? 'rotate' : 'dominant';
      setMotionSettings(wb, { ...cur, [key]: !cur[key] });
      return;
    }
  }
}

/** Live state of the device layer for React (re-renders at the layer's ~10 Hz while live). */
export function useMotionState(input: MotionInputLike | null): MotionInputState {
  const fallback = fallbackMotionState();
  return useSyncExternalStore(
    (cb) => (input ? input.onState(cb) : () => {}),
    () => (input ? input.state() : fallback),
  );
}
