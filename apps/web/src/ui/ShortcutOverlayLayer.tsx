/**
 * Holding Ctrl, Cmd or Alt for 600 ms shows the shortcuts available now (PLAN 9.4, ADR-049).
 * Lazy: the hook and the overlay load right after the app is ready, never on the initial route.
 */

import {
  type KeymapContext,
  type LayoutMap,
  readLayoutMap,
  ShortcutOverlay,
  useModifierHold,
} from '@wren-cad/ui';
import { useEffect, useState } from 'react';
import { APP_COMMANDS } from '../app/input';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';

export default function ShortcutOverlayLayer({ wb }: { wb: Workbench }) {
  const input = useObservable(wb.input);
  const ui = useObservable(wb.ui);
  const hold = useModifierHold({ enabled: ui.settings === null });
  const [layout, setLayout] = useState<LayoutMap | null>(null);
  useEffect(() => {
    let live = true;
    void readLayoutMap().then((m) => live && setLayout(m ?? null));
    return () => {
      live = false;
    };
  }, []);
  const contexts: KeymapContext[] = ui.sketch ? ['sketch', 'global'] : ['model', 'global'];
  return (
    <ShortcutOverlay
      commands={APP_COMMANDS}
      resolved={input.resolved}
      contexts={contexts}
      visible={hold.visible}
      held={hold.held}
      layout={layout}
    />
  );
}
