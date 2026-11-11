/**
 * Settings, Radial menu (PLAN M3.8, ADR-085): the editor over the persisted rings. A section of
 * the settings panel, not a dialog. Lazy with the panel.
 */

import { RadialEditor } from '@wren-cad/ui';
import { useCallback, useMemo, useState } from 'react';
import {
  defaultRing,
  loadRadialConfig,
  parseRadialConfig,
  RADIAL_CONTEXTS,
  type RadialConfig,
  type RadialContext,
  resetRing,
  saveRadialConfig,
  serializeRadialConfig,
  setRing,
} from '../app/radial-config';
import { registryCommands } from './radial-registry';

const report = (dropped: readonly string[], newer?: boolean): string | null =>
  newer
    ? 'These settings come from a newer version of Wren and were ignored.'
    : dropped.length > 0
      ? `Removed ${dropped.length} command${dropped.length === 1 ? '' : 's'} that no longer exist: ${dropped.join(', ')}.`
      : null;

export function RadialSettings({ size }: { size: 'md' | 'touch' }) {
  const initial = useMemo(() => loadRadialConfig(), []);
  const [cfg, setCfg] = useState<RadialConfig>(initial.config);
  const [notice, setNotice] = useState<string | null>(report(initial.dropped, initial.newer));
  const model = useMemo(() => registryCommands(false), []);
  const sketch = useMemo(() => registryCommands(true), []);
  const isSketch = (id: string) => RADIAL_CONTEXTS.find((c) => c.id === id)?.sketch === true;

  const apply = useCallback((next: RadialConfig) => {
    setCfg(next);
    saveRadialConfig(next);
  }, []);

  return (
    <RadialEditor
      size={size}
      contexts={RADIAL_CONTEXTS}
      ringOf={(id) => cfg.rings[id as RadialContext] ?? defaultRing(id as RadialContext)}
      commandsOf={(id) => (isSketch(id) ? sketch : model)}
      modified={Object.keys(cfg.rings)}
      onRingChange={(id, ring) => apply(setRing(cfg, id as RadialContext, ring))}
      onResetContext={(id) => apply(resetRing(cfg, id as RadialContext))}
      onResetAll={() => apply({ ...cfg, rings: {} })}
      flickWindow={cfg.flickWindow}
      onFlickWindow={(ms) => apply({ ...cfg, flickWindow: ms })}
      drawAfterDelay={cfg.drawAfterDelay}
      onDrawAfterDelay={(on) => apply({ ...cfg, drawAfterDelay: on })}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      onExport={() => {
        const url = URL.createObjectURL(
          new Blob([serializeRadialConfig(cfg)], { type: 'application/json' }),
        );
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wren-radial-menu.json';
        a.click();
        URL.revokeObjectURL(url);
      }}
      onImport={(file) => {
        void file.text().then((t) => {
          try {
            const r = parseRadialConfig(JSON.parse(t));
            if (r.newer) setNotice(report([], true));
            else {
              apply(r.config);
              setNotice(report(r.dropped) ?? 'Wheel settings imported.');
            }
          } catch {
            setNotice('That file is not wheel settings (not valid JSON).');
          }
        });
      }}
    />
  );
}
