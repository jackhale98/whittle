/**
 * The configuration table in a panel over the viewport (desktop and tablet; never a modal). Lazy:
 * this file and `@wren-cad/ui/config-table` are fetched when the panel first opens, so neither is
 * in the initial route.
 */

import { IconButton } from '@wren-cad/ui';
import { X } from 'lucide-react';
import { lazy, Suspense, useMemo } from 'react';
import { keyOf } from '../app/config-model';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import { massText, useConfigurationView } from './config-view';
import { LIBRARY, useDoc } from './Inspector';

const ConfigurationTable = lazy(() => import('@wren-cad/ui/config-table'));

export default function ConfigurationPanel({ wb, touch }: { wb: Workbench; touch: boolean }) {
  const doc = useDoc(wb);
  const view = useConfigurationView(wb);
  const state = useObservable(wb.config.state);
  const unit = doc.units.length;
  const model = wb.config.table(unit);
  const rows = useMemo(
    () =>
      (model?.rows ?? []).map((r) => {
        const b = view.byKey[keyOf(r.id)];
        const mass = massText(b);
        return {
          ...r,
          status: b?.status ?? ('unbuilt' as const),
          ...(b?.message ? { statusMessage: b.message } : {}),
          ...(mass ? { mass } : {}),
        };
      }),
    [model, view.byKey],
  );
  if (!model || !state.panel) return null;
  const def = view.byKey[keyOf(null)];
  const defMass = massText(def);
  return (
    <section
      aria-label="Configurations"
      data-testid="configuration-panel"
      className="w-card pointer-events-auto flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-[14px] shadow-float"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-sm font-semibold">Configurations</h2>
        <p className="min-w-0 flex-1 truncate text-2xs text-fg-muted">
          Cells that differ from Default are highlighted. Paste a block from a spreadsheet to add
          rows.
        </p>
        <IconButton
          label="Close configurations"
          icon={<X className="size-4" />}
          {...(touch ? { size: 'touch' as const } : {})}
          onClick={() => wb.config.openPanel(false)}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Suspense
          fallback={<p className="px-4 py-6 text-center text-ui text-fg-muted">Loading table…</p>}
        >
          <ConfigurationTable
            columns={model.columns}
            rows={rows}
            defaultRow={{
              ...model.defaultRow,
              ...(def ? { status: def.status } : {}),
              ...(def?.message ? { statusMessage: def.message } : {}),
              ...(defMass ? { mass: defMass } : {}),
            }}
            activeId={view.missing ? null : view.activeId}
            onEdit={(edits) => wb.config.applyTableEdits(edits, unit)}
            onPaste={(plan) => wb.config.applyPaste(plan, unit)}
            onJumpToField={(featureId, path) => wb.config.jumpToField(featureId, path)}
            onActivate={(id) => wb.config.setActive(id)}
            onRename={(id, name) => wb.config.rename(id, name)}
            onRemove={(id) => wb.config.remove(id)}
            evaluate={(e) => wb.evaluate(e)}
            materials={LIBRARY}
            size={touch ? 'touch' : 'md'}
            maxHeight="min(50vh, 28rem)"
          />
        </Suspense>
      </div>
    </section>
  );
}
