/** A controllable fake MotionInput for E2E (lazy: only loaded by the test hook). */

import type { MotionInputState } from '@wren-cad/contracts';
import type { MotionInputLike } from '@wren-cad/ui';
import { ensureMotionPrefs, motionLog, setMotionInput } from './motion';
import type { Workbench } from './workbench';

export function attachFakeMotion(wb: Workbench): void {
  let state: MotionInputState = { path: 'none', state: 'notPaired' };
  const ls = new Set<(s: MotionInputState) => void>();
  let pairs = 0;
  const fake: MotionInputLike = {
    state: () => state,
    onState: (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    pair: async () => {
      pairs++;
    },
    setSettings: () => {},
    dispose: () => {},
  };
  const emit = (s: MotionInputState) => {
    state = s;
    for (const l of [...ls]) l(s);
  };
  (window as unknown as Record<string, unknown>).__wrenMotionFake = {
    emit,
    pairs: () => pairs,
    /** A press is a state edge, like the real feed. */
    press: (b: number) => {
      const cur = state;
      if (cur.path !== 'webhid') return;
      emit({ ...cur, buttons: [b] });
      emit({ ...cur, buttons: [] });
    },
  };
  setMotionInput(wb, fake);
}

/** `__wrenApp.motion()`: attach the fake, read the commands run and the stored prefs. */
export function motionHooks(wb: Workbench) {
  return {
    attach: () => attachFakeMotion(wb),
    log: () => [...motionLog],
    prefs: () => ensureMotionPrefs(wb),
  };
}
