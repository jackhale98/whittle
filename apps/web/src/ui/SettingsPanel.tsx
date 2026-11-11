/**
 * Settings (PLAN 9.4, M3.5): mouse navigation and the keymap. A panel over the view, not a modal
 * dialog: nothing is trapped, the model stays live behind it, Esc or Close dismisses it. Lazy
 * (the keymap editor and its reserved-key table are never on the initial route).
 */

import {
  IconButton,
  KeymapEditor,
  type LayoutMap,
  NavigationSettings,
  readLayoutMap,
  Segmented,
} from '@wren-cad/ui';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { APP_COMMANDS, withRightClickFinishes } from '../app/input';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';

export default function SettingsPanel({ wb, touch }: { wb: Workbench; touch: boolean }) {
  const ui = useObservable(wb.ui);
  const input = useObservable(wb.input);
  const [layout, setLayout] = useState<LayoutMap | null>(null);
  const panel = useRef<HTMLElement>(null);
  const tab = ui.settings ?? 'navigation';

  useEffect(() => {
    let live = true;
    void readLayoutMap().then((m) => live && setLayout(m ?? null));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('h2')?.focus();
  }, []);

  return (
    <section
      ref={panel}
      aria-label="Settings"
      data-testid="settings-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          wb.closeSettings();
        }
      }}
      className="w-panel pointer-events-auto absolute z-[4] flex flex-col overflow-hidden"
      style={
        touch
          ? {
              top: 'var(--chrome-top, 3.5rem)',
              left: 'max(var(--chrome-left, 0px), 0.5rem)',
              right: '0.5rem',
              bottom: 'calc(var(--chrome-bottom, 0px) + 0.5rem)',
            }
          : { top: '3.5rem', right: '0.75rem', width: 400, maxHeight: 'calc(100% - 4.5rem)' }
      }
    >
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <h2 tabIndex={-1} className="flex-1 text-ui font-semibold outline-none">
          Settings
        </h2>
        <IconButton
          label="Close settings"
          icon={<X className="size-4" />}
          onClick={() => wb.closeSettings()}
          data-testid="settings-close"
        />
      </header>
      <div className="px-3.5 pt-3">
        <Segmented
          label="Settings section"
          size={touch ? 'touch' : 'md'}
          value={tab}
          onChange={(v) => wb.patchUi({ settings: v })}
          options={[
            { value: 'navigation', label: 'Navigation' },
            { value: 'keyboard', label: 'Keyboard' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {tab === 'navigation' ? (
          <NavigationSettings
            value={input.navigation}
            onChange={(n) => wb.setNavigationSettings(n)}
            rightClickFinishes={input.rightClickFinishes !== false}
            onRightClickFinishesChange={(on) => wb.input.set((s) => withRightClickFinishes(s, on))}
            size={touch ? 'touch' : 'md'}
          />
        ) : (
          <KeymapEditor
            commands={APP_COMMANDS}
            overrides={input.keymap}
            onChange={(o) => wb.setKeymapOverrides(o)}
            layout={layout}
            size={touch ? 'touch' : 'md'}
          />
        )}
      </div>
    </section>
  );
}
