/**
 * The loaded half of the 3D mouse service (`motion.ts`): creates the WebHID adapter and wires it
 * to the viewport. Imported dynamically (with `@wren-cad/viewport`) so none of it is in the
 * initial route.
 */

import {
  DEFAULT_MOTION_SETTINGS,
  type MotionInputState,
  type MotionSample,
  type MotionSettings,
  type TouchViewport,
} from '@wren-cad/contracts';
import { createMotionInput, type HIDLike, type MotionInput } from '@wren-cad/viewport';

export interface MotionHost {
  viewport(): TouchViewport | null;
  hid(): HIDLike | undefined;
  settings(): MotionSettings | null;
  onState(s: MotionInputState): void;
  onButton(button: number, down: boolean): void;
}

export function startMotionInput(host: MotionHost): MotionInput {
  const hid = host.hid();
  const input = createMotionInput({
    settings: host.settings() ?? DEFAULT_MOTION_SETTINGS,
    onSample: (s: MotionSample) => host.viewport()?.motion?.(s),
    onButton: (b, down) => host.onButton(b, down),
    ...(hid ? { hid } : {}),
  });
  host.onState(input.state());
  input.onState((s) => host.onState(s));
  return input;
}
