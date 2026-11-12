import {
  DEFAULT_MOTION_SETTINGS,
  type MotionButtonCommand,
  type MotionInputState,
  type MotionSettings,
} from '@wren-cad/contracts';
import { readJson, writeJson } from './persist';

/**
 * 3D mouse settings and button mapping (M4.5, ADR-096). Device-local like the navigation
 * settings: `wren.motion` (axes, sensitivity ...) and `wren.motionButtons` (button -> command).
 */
export const MOTION_SETTINGS_KEY = 'wren.motion';
export const MOTION_BUTTONS_KEY = 'wren.motionButtons';

/**
 * The structural shape of the device layer's `MotionInput` (exported by @wren-cad/viewport). The
 * UI codes against this so it never imports the viewport. `onButton` is optional: when the device
 * layer offers it, presses are exact; otherwise `watchButtons` derives them from state edges.
 */
export interface MotionInputLike {
  state(): MotionInputState;
  onState(listener: (s: MotionInputState) => void): () => void;
  pair(): Promise<void>;
  setSettings(s: MotionSettings): void;
  dispose(): void;
  onButton?(listener: (button: number, down: boolean) => void): () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const SENSITIVITY_RANGE = { min: 0.25, max: 4 } as const;
export const DEAD_ZONE_RANGE = { min: 0, max: 0.3 } as const;

export const MOTION_AXES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const;
export type MotionAxis = (typeof MOTION_AXES)[number];

/** Clamp and default anything stored: old versions, hand-edited values, other types. */
export function sanitizeMotionSettings(raw: unknown): MotionSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_MOTION_SETTINGS;
  const inv = (o.invert && typeof o.invert === 'object' ? o.invert : {}) as Record<string, unknown>;
  const invert = { ...d.invert };
  for (const a of MOTION_AXES) if (typeof inv[a] === 'boolean') invert[a] = inv[a] as boolean;
  return {
    sensitivity: clamp(
      num(o.sensitivity, d.sensitivity),
      SENSITIVITY_RANGE.min,
      SENSITIVITY_RANGE.max,
    ),
    invert,
    dominant: typeof o.dominant === 'boolean' ? o.dominant : d.dominant,
    rotate: typeof o.rotate === 'boolean' ? o.rotate : d.rotate,
    translate: typeof o.translate === 'boolean' ? o.translate : d.translate,
    deadZone: clamp(num(o.deadZone, d.deadZone), DEAD_ZONE_RANGE.min, DEAD_ZONE_RANGE.max),
  };
}

export function readMotionSettings(): MotionSettings {
  return sanitizeMotionSettings(readJson<unknown>(MOTION_SETTINGS_KEY, null));
}

export function writeMotionSettings(value: MotionSettings): void {
  writeJson(MOTION_SETTINGS_KEY, sanitizeMotionSettings(value));
}

/** Pure reducer for the settings panel's controls. */
export type MotionSettingsAction =
  | { type: 'sensitivity'; value: number }
  | { type: 'deadZone'; value: number }
  | { type: 'invert'; axis: MotionAxis; value: boolean }
  | { type: 'dominant' | 'rotate' | 'translate'; value: boolean }
  | { type: 'reset' };

export function motionSettingsReducer(s: MotionSettings, a: MotionSettingsAction): MotionSettings {
  switch (a.type) {
    case 'reset':
      return DEFAULT_MOTION_SETTINGS;
    case 'invert':
      return sanitizeMotionSettings({ ...s, invert: { ...s.invert, [a.axis]: a.value } });
    default:
      return sanitizeMotionSettings({ ...s, [a.type]: a.value });
  }
}

// ---- button mapping ------------------------------------------------------------------------

/** 1-based device button number -> command. A missing button is `none`. */
export type MotionButtonMap = Readonly<Record<number, MotionButtonCommand>>;

export const DEFAULT_MOTION_BUTTONS: MotionButtonMap = { 1: 'radialMenu', 2: 'fit' };

/** Every command a button can run (labels live with the picker, which is lazy). */
export const MOTION_BUTTON_COMMAND_IDS: readonly MotionButtonCommand[] = [
  'none',
  'fit',
  'radialMenu',
  'repeatLast',
  'viewFront',
  'viewTop',
  'viewRight',
  'viewIso',
  'toggleRotate',
  'toggleDominant',
];

const COMMAND_IDS = new Set<string>(MOTION_BUTTON_COMMAND_IDS);

/** Keep only integer buttons 1..64 mapped to a known command; unknown values are dropped. */
export function sanitizeButtonMap(raw: unknown): MotionButtonMap {
  if (!raw || typeof raw !== 'object') return DEFAULT_MOTION_BUTTONS;
  const out: Record<number, MotionButtonCommand> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= 64 && typeof v === 'string' && COMMAND_IDS.has(v))
      out[n] = v as MotionButtonCommand;
  }
  return out;
}

export function readButtonMap(): MotionButtonMap {
  const raw = readJson<unknown>(MOTION_BUTTONS_KEY, undefined);
  return raw === undefined ? DEFAULT_MOTION_BUTTONS : sanitizeButtonMap(raw);
}

export function writeButtonMap(map: MotionButtonMap): void {
  writeJson(MOTION_BUTTONS_KEY, sanitizeButtonMap(map));
}

export function setButtonCommand(
  map: MotionButtonMap,
  button: number,
  command: MotionButtonCommand,
): MotionButtonMap {
  return { ...map, [button]: command };
}

export function commandForButton(map: MotionButtonMap, button: number): MotionButtonCommand {
  return map[button] ?? 'none';
}

/** Buttons newly down in `next` compared with `prev` (both 1-based lists). */
export function pressedEdges(prev: readonly number[], next: readonly number[]): number[] {
  const had = new Set(prev);
  return next.filter((b) => !had.has(b));
}

/**
 * Adapter from the device layer to button presses. Uses `input.onButton` when it exists; else
 * derives presses from the ~10 Hz state's `buttons` (a tap shorter than one tick can be missed,
 * which is why the device layer should offer `onButton`). Returns the unsubscribe.
 */
export function watchButtons(
  input: Pick<MotionInputLike, 'state' | 'onState' | 'onButton'>,
  onPress: (button: number) => void,
): () => void {
  if (input.onButton) return input.onButton((b, down) => down && onPress(b));
  const buttonsOf = (s: MotionInputState) => (s.path === 'webhid' ? s.buttons : []);
  let prev = buttonsOf(input.state());
  return input.onState((s) => {
    const now = buttonsOf(s);
    for (const b of pressedEdges(prev, now)) onPress(b);
    prev = now;
  });
}

/** How many buttons to list: the highest seen live or mapped, at least the defaults. */
export function buttonCount(map: MotionButtonMap, seen: number): number {
  return Math.max(2, seen, ...Object.keys(map).map(Number));
}
