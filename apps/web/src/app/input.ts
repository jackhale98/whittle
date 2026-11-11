/**
 * Input settings (PLAN 9.4, M3.5): the navigation preset and the keymap overrides, persisted per
 * device under `wren.navigation` and `wren.keymap`. Small and eager (the workbench reads them at
 * start); the panels that edit them are lazy.
 */

import type { NavigationOptions } from '@wren-cad/contracts';
import {
  DEFAULT_COMMANDS,
  type KeymapCommand,
  type KeymapContext,
  type KeymapOverrides,
  matchCommand,
  type ResolvedKeymap,
  readNavigation,
  resolveKeymap,
  writeNavigation,
} from '@wren-cad/ui';

export const KEYMAP_KEY = 'wren.keymap';

/**
 * The app's commands: the UI package's defaults plus the radial menu key. Q is free in every
 * context (asserted by a test), is not a browser shortcut on its own, and sits next to the tool
 * keys on the left hand.
 */
export const RADIAL_COMMAND: KeymapCommand = {
  id: 'radial',
  label: 'Radial menu (hold, flick, release)',
  group: 'General',
  context: 'global',
  defaults: ['KeyQ'],
};
export const APP_COMMANDS: readonly KeymapCommand[] = [...DEFAULT_COMMANDS, RADIAL_COMMAND];

export function sanitizeOverrides(raw: unknown): KeymapOverrides {
  if (!raw || typeof raw !== 'object') return {};
  // A null-prototype map and an allow-list of known command ids: a stored `__proto__` (or any
  // unknown key) is dropped, never written onto an object prototype.
  const known = new Set(APP_COMMANDS.map((c) => c.id));
  const out: Record<string, string[]> = Object.create(null);
  for (const [id, v] of Object.entries(raw as Record<string, unknown>))
    if (known.has(id) && Array.isArray(v))
      out[id] = v.filter((b): b is string => typeof b === 'string');
  return out;
}

export function readKeymap(): KeymapOverrides {
  try {
    const s = globalThis.localStorage?.getItem(KEYMAP_KEY);
    return s ? sanitizeOverrides(JSON.parse(s)) : {};
  } catch {
    return {};
  }
}

export function writeKeymap(overrides: KeymapOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) globalThis.localStorage?.removeItem(KEYMAP_KEY);
    else globalThis.localStorage?.setItem(KEYMAP_KEY, JSON.stringify(overrides));
  } catch {
    // Storage may be unavailable (private mode): the setting lasts for the session.
  }
}

/** Per-device sketch input options (M3.8), next to the navigation settings. */
export const SKETCH_INPUT_KEY = 'wren.sketchInput';

/** Settings → Navigation: a right click finishes the sketch tool in progress (default on). */
export function readRightClickFinishes(): boolean {
  try {
    const s = globalThis.localStorage?.getItem(SKETCH_INPUT_KEY);
    const v = s ? (JSON.parse(s) as { rightClickFinishes?: unknown }).rightClickFinishes : true;
    return v !== false;
  } catch {
    return true;
  }
}

export function writeRightClickFinishes(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.removeItem(SKETCH_INPUT_KEY);
    else
      globalThis.localStorage?.setItem(
        SKETCH_INPUT_KEY,
        JSON.stringify({ rightClickFinishes: false }),
      );
  } catch {
    // Storage may be unavailable (private mode): the setting lasts for the session.
  }
}

export interface InputSettings {
  navigation: NavigationOptions;
  keymap: KeymapOverrides;
  resolved: ResolvedKeymap;
  /** A right click finishes the sketch chain or spline in progress (M3.8; absent = true). */
  rightClickFinishes?: boolean;
}

export function loadInput(): InputSettings {
  const keymap = readKeymap();
  return {
    navigation: readNavigation(),
    keymap,
    resolved: resolveKeymap(APP_COMMANDS, keymap),
    rightClickFinishes: readRightClickFinishes(),
  };
}

export function withRightClickFinishes(s: InputSettings, on: boolean): InputSettings {
  writeRightClickFinishes(on);
  return { ...s, rightClickFinishes: on };
}

export function withKeymap(s: InputSettings, keymap: KeymapOverrides): InputSettings {
  writeKeymap(keymap);
  return { ...s, keymap, resolved: resolveKeymap(APP_COMMANDS, keymap) };
}

export function withNavigation(s: InputSettings, navigation: NavigationOptions): InputSettings {
  writeNavigation(navigation);
  return { ...s, navigation };
}

/** The command a binding runs in the contexts that are active (`sketch` or `model`, plus global). */
export function commandFor(
  s: InputSettings,
  bindingId: string,
  sketch: boolean,
): KeymapCommand | undefined {
  const ctx: KeymapContext[] = sketch ? ['sketch', 'global'] : ['model', 'global'];
  return matchCommand(APP_COMMANDS, s.resolved, bindingId, ctx);
}
