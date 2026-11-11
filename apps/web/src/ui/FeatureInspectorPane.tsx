/**
 * The feature inspector with its lineage (parents and children), for the feature being edited.
 * Lazy: the form fields for every feature type are not part of the first screen.
 *
 * With a configuration active (M3.7) `f` is the feature as that configuration shows it. Fields it
 * overrides carry an override marker with Reset; "This configuration only" is a one-shot chip
 * (trap T1) that applies to the next edit and is then dropped.
 */

import type { Feature, FeatureStatus, WrenDoc } from '@wren-cad/contracts';
import { configurableFields } from '@wren-cad/document';
import {
  FeatureInspector,
  FeatureLineage,
  OverrideMarker,
  ScopeChip,
  useOneShotScope,
} from '@wren-cad/ui';
import { useEffect, useRef } from 'react';
import { useObservable } from '../app/observable';
import { refAcks } from '../app/ref-notes';
import type { Workbench } from '../app/workbench';
import { featureLineage } from '../model/lineage';
import { describeRef } from './Inspector';

type HoleTables = typeof import('../features/hole-tables')['HOLE_TABLES'];

export default function FeatureInspectorPane({
  wb,
  doc,
  f,
  status,
  pickingPath,
  tables,
  density,
}: {
  wb: Workbench;
  doc: WrenDoc;
  f: Feature;
  status?: FeatureStatus;
  pickingPath: string | null;
  tables?: HoleTables;
  density: 'compact' | 'touch';
}) {
  const part = doc.parts[0];
  const lineage = featureLineage(doc, f.id);
  const active = wb.config.active;
  const activeId = active?.id ?? null;
  const oneShot = useOneShotScope(active === undefined, activeId);
  const touch = density === 'touch';
  const owned = active?.features?.[f.id]?.fields ?? {};
  const focus = useObservable(wb.config.state).focusField;
  const root = useRef<HTMLDivElement>(null);

  // The table's "jump to field": focus the input of that field once the inspector shows it.
  useEffect(() => {
    if (!focus || focus.featureId !== f.id) return;
    const el = root.current?.querySelector<HTMLElement>(
      `[data-pointer="${CSS.escape(focus.path)}"] input`,
    );
    el?.focus();
    wb.config.clearFocusField();
  }, [focus, f.id, wb]);

  const optionOverrides = active
    ? configurableFields(f).filter((c) => c.kind === 'option' && Object.hasOwn(owned, c.pointer))
    : [];

  return (
    <div ref={root}>
      {active ? (
        <div
          className="flex flex-wrap items-center gap-2 px-4 pt-2"
          data-testid="config-edit-scope"
        >
          <span className="text-2xs text-fg-muted">Editing in {active.name}</span>
          <ScopeChip
            configurationName={active.name}
            activeIsDefault={false}
            scope={oneShot.scope}
            onScopeChange={oneShot.setScope}
            size={touch ? 'touch' : 'md'}
          />
        </div>
      ) : null}
      <FeatureInspector
        key={f.id}
        feature={f}
        {...(status ? { status } : {})}
        evaluate={(e, d) => wb.evaluate(e, d)}
        onChange={(next: Feature) => {
          wb.updateFeature(next, 'commit', oneShot.scope === 'configuration');
          oneShot.consume();
        }}
        onPreview={(next: Feature) =>
          wb.updateFeature(next, 'preview', oneShot.scope === 'configuration')
        }
        onPick={(path) =>
          status?.unresolved?.some((u) => u.path === path)
            ? wb.repick(f.id, path)
            : wb.startPicking(f.id, path)
        }
        {...(status?.state === 'needsAttention' && status.unresolved?.length
          ? { onRepick: () => wb.repick(f.id) }
          : {})}
        onAcceptRef={(note) => {
          const stored = note.kind === 'merged' ? status?.merged : status?.grown;
          const ref = stored?.find((r) => r.path === note.path && r.name === note.name);
          if (ref) refAcks.accept(doc.meta.id ?? '', f.id, note.kind, ref);
        }}
        onRepickRef={(path) => wb.repick(f.id, path)}
        pickingPath={pickingPath}
        describeRef={(r) => describeRef(doc, r)}
        describeFeature={(id) =>
          part?.features.find((x) => x.id === id)?.name ?? wb.rememberedName(id) ?? id
        }
        onSelectFeature={(id) => wb.selectFeature(id)}
        onUndo={() => wb.undo()}
        {...(tables ? { holeTables: tables } : {})}
        {...(f.type === 'sketch' ? { onEditSketch: () => wb.editFeature(f.id) } : {})}
        onDone={() => wb.selectFeature(null)}
        units={{ length: doc.units.length, angle: doc.units.angle === 'deg' ? '°' : 'rad' }}
        {...(active
          ? {
              configuration: {
                activeName: active.name,
                overridden: (pointer: string) => Object.hasOwn(owned, pointer),
                reset: (pointer: string) =>
                  wb.config.resetOverride({ kind: 'field', featureId: f.id, path: pointer }),
              },
            }
          : {})}
        density={density}
      />
      {optionOverrides.length > 0 && active ? (
        <ul
          className="m-0 mx-4 mt-2 flex list-none flex-col gap-1 p-0 text-ui"
          data-testid="config-option-overrides"
          aria-label={`Options overridden in ${active.name}`}
        >
          {optionOverrides.map((o) => (
            <li key={o.pointer} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-fg-muted">
                {o.kind === 'option' ? o.label : o.pointer}: {String(owned[o.pointer])}
              </span>
              <OverrideMarker
                overridden
                configurationName={active.name}
                fieldLabel={o.kind === 'option' ? o.label : o.pointer}
                onReset={() =>
                  wb.config.resetOverride({ kind: 'field', featureId: f.id, path: o.pointer })
                }
                size={touch ? 'touch' : 'md'}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {f.type !== 'sketch' || lineage.children.length > 0 || lineage.parents.length > 0 ? (
        <FeatureLineage
          parents={lineage.parents}
          dependents={lineage.children}
          onSelect={(id) => wb.selectFeature(id)}
        />
      ) : null}
    </div>
  );
}
