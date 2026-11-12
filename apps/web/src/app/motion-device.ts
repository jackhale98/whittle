/**
 * The WebHID device layer of the 3D mouse (M4.5, ADR-096), loaded lazily by `regen-view.ts`:
 * creates `MotionInput` from @wren-cad/viewport, sends its samples to `viewport.motion` and hands
 * it to the UI through `wb.setMotionInput` (settings, pairing, buttons live in `motion.ts`).
 * Test seam: E2E defines a fake `navigator.hid` (init script) whose reports go through the real
 * parser.
 */

import { DEFAULT_MOTION_SETTINGS } from '@wren-cad/contracts';
import { createMotionInput } from '@wren-cad/viewport';
import type { Workbench } from './workbench';

export function startMotionDevice(wb: Workbench): void {
  if (wb.deviceDispose) return;
  const input = createMotionInput({
    settings: DEFAULT_MOTION_SETTINGS, // the UI pushes the stored settings in `setMotionInput`
    onSample: (s) => wb.viewport?.motion?.(s),
    onButton: () => {}, // buttons reach the UI through `input.onButton`
  });
  wb.deviceDispose = () => input.dispose();
  wb.setMotionInput(input);
}
