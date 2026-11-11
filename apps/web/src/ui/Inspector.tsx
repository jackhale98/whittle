/**
 * Right-panel content (PLAN §9.1 "context inspector"): sketch session, the feature being edited,
 * the viewport selection with context tools, or the part (material, mass) and document.
 */

import type { EntityRef, Material, WrenDoc } from '@wren-cad/contracts';
import { MATERIALS } from '@wren-cad/document';
import {
  Button,
  Kbd,
  type MaterialLibraryItem,
  type MeasurePanelProps,
  PartInspector,
  type SectionPanelProps,
  type SelectionAction,
  SelectionInspector,
  SketchStatusChip,
  tools as shellTools,
} from '@wren-cad/ui';
import { FolderOpen, Library, Plus, Save } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { overrideIn } from '../app/config-model';
import { useObservable } from '../app/observable';
import { refAcks } from '../app/ref-notes';
import type { Workbench } from '../app/workbench';
import type { FeatureTool, ModelTool } from '../features/factories';
import { selectionLineage } from '../model/lineage';
import { selectionKind } from '../selection/pick';
import { useConfigurationView } from './config-view';

// The feature inspector (and the hole and thread fields behind it) is fetched when a feature is
// first selected: it is a sizeable part of the app and not on the first screen.
const FeatureInspectorPane = lazy(() => import('./FeatureInspectorPane'));
const MeasureView = lazy(() => import('./InspectPanels').then((m) => ({ default: m.MeasureView })));
const SectionView = lazy(() => import('./InspectPanels').then((m) => ({ default: m.SectionView })));

function category(m: Material): string {
  const id = m.libraryId ?? '';
  if (/steel/.test(id)) return 'Steel';
  if (/alumin/.test(id)) return 'Aluminium';
  if (/titan/.test(id)) return 'Titanium';
  if (/brass|copper|bronze/.test(id)) return 'Copper alloys';
  if (/wood|oak|pine|birch|plywood|maple/.test(id)) return 'Wood';
  return 'Plastic';
}

export const LIBRARY: readonly MaterialLibraryItem[] = MATERIALS.map((m) => ({
  libraryId: m.libraryId ?? m.name,
  name: m.name,
  category: category(m),
  density: m.density,
  ...(m.appearance ? { appearance: m.appearance } : {}),
}));

/** "Edge of Extrude 1", "Top plane", "Region of Sketch 1". */
export function describeRef(doc: WrenDoc, ref: EntityRef): string {
  const origin: Record<string, string> = {
    'origin:XY': 'Top plane',
    'origin:XZ': 'Front plane',
    'origin:YZ': 'Right plane',
    'origin:X': 'X axis',
    'origin:Y': 'Y axis',
    'origin:Z': 'Z axis',
  };
  if (origin[ref.name]) return origin[ref.name] as string;
  const part = doc.parts[0];
  // The most recent feature the name mentions (an extrude's edge also names its sketch).
  const owner = part?.features.findLast((f) => ref.name.includes(f.id));
  const kind = ref.kind === 'region' ? 'Region' : ref.kind[0]?.toUpperCase() + ref.kind.slice(1);
  if (ref.kind === 'body') return owner ? `Body of ${owner.name}` : 'Body';
  if (ref.kind === 'region') {
    const n = (ref.name.match(/region\(([^)]*)\)/)?.[1] ?? '').split(/[,|]/).filter(Boolean).length;
    return `${kind} · ${n} curve${n === 1 ? '' : 's'}${owner ? ` of ${owner.name}` : ''}`;
  }
  return owner ? `${kind} of ${owner.name}` : kind;
}

function DocumentSection({ wb }: { wb: Workbench }) {
  const doc = useDoc(wb);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <section className="border-t border-border px-4 py-3" aria-label="Document">
      <h3 className="pb-2 text-2xs font-semibold tracking-wider text-fg-muted uppercase">
        Document
      </h3>
      <input
        aria-label="Document name"
        data-testid="doc-name-input"
        value={draft ?? doc.meta.name}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) wb.renameDocument(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="mb-2.5 h-8 w-full rounded-[8px] bg-surface-2 px-2.5 text-ui font-medium text-fg outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          variant="secondary"
          icon={<Library className="size-4" />}
          onClick={() => wb.toggleLibrary(true)}
        >
          Library
        </Button>
        <Button
          variant="secondary"
          icon={<Plus className="size-4" />}
          onClick={() => void wb.newDocument()}
        >
          New
        </Button>
        <Button
          variant="secondary"
          icon={<FolderOpen className="size-4" />}
          onClick={() => void wb.openFromDisk()}
        >
          Open or import…
        </Button>
        <Button
          variant="secondary"
          icon={<Save className="size-4" />}
          onClick={() => void wb.exportWren()}
        >
          Save file
        </Button>
      </div>
      <p className="mt-2 text-2xs text-fg-muted">Saved automatically to this device.</p>
    </section>
  );
}

type HoleTables = typeof import('../features/hole-tables')['HOLE_TABLES'];
let holeTables: HoleTables | null = null;

/** The standards tables, loaded the first time a hole or thread is in the inspector. */
function useHoleTables(needed: boolean): HoleTables | null {
  const [tables, setTables] = useState(holeTables);
  useEffect(() => {
    if (!needed || tables) return;
    let live = true;
    void import('../features/hole-tables').then((m) => {
      holeTables = m.HOLE_TABLES;
      if (live) setTables(m.HOLE_TABLES);
    });
    return () => {
      live = false;
    };
  }, [needed, tables]);
  return tables;
}

export function useDoc(wb: Workbench): WrenDoc {
  return useSyncExternalStore(wb.subscribeDoc, wb.getDoc);
}

const actionMeta = (id: ModelTool | FeatureTool): SelectionAction => {
  const t = shellTools.find((x) => x.id === id);
  return {
    id,
    label: t?.label ?? id,
    ...(t?.shortcut ? { shortcut: t.shortcut } : {}),
    ...(t ? { icon: <t.Icon className="size-4" strokeWidth={1.75} aria-hidden /> } : {}),
  };
};

export function Inspector({
  wb,
  density,
  measure,
  section,
}: {
  wb: Workbench;
  density: 'compact' | 'touch';
  measure?: MeasurePanelProps;
  section?: SectionPanelProps;
}) {
  const ui = useObservable(wb.ui);
  const doc = useDoc(wb);
  const regen = useObservable(wb.regen);
  useObservable(refAcks.version); // accepted reference notes drop out of the status
  const part = doc.parts[0];
  const view = useConfigurationView(wb);
  const editingType = part?.features.find((x) => x.id === ui.featureId)?.type;
  const tables = useHoleTables(editingType === 'hole' || editingType === 'thread');
  if (!part) return null;
  const touch = density === 'touch';

  if (ui.measure?.active && measure) {
    return (
      <Suspense fallback={null}>
        <MeasureView measure={measure} onDone={() => wb.measure.stop()} touch={touch} />
      </Suspense>
    );
  }
  if (ui.section.open && section && !ui.sketch && !ui.featureId) {
    return (
      <Suspense fallback={null}>
        <SectionView section={section} onDone={() => wb.closeSection()} touch={touch} />
      </Suspense>
    );
  }

  if (ui.sketch) {
    const f = part.features.find((x) => x.id === ui.sketch?.featureId);
    const solve = ui.sketch.solve;
    return (
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4" data-testid="sketch-inspector">
        <header>
          <h2 className="truncate text-sm leading-5 font-semibold">{f?.name ?? 'Sketch'}</h2>
          <p className="text-2xs text-fg-muted">
            Sketch on {f?.type === 'sketch' ? describeRef(doc, f.on).toLowerCase() : 'a plane'}
          </p>
        </header>
        {solve ? (
          <SketchStatusChip
            status={solve.status}
            dof={solve.dof}
            redundant={solve.redundant.length}
          />
        ) : null}
        <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
          <dt className="text-fg-muted">Curves</dt>
          <dd className="text-right font-medium">
            {f?.type === 'sketch' ? f.entities.filter((e) => e.kind !== 'point').length : 0}
          </dd>
          <dt className="text-fg-muted">Constraints</dt>
          <dd className="text-right font-medium">
            {f?.type === 'sketch' ? f.constraints.length : 0}
          </dd>
        </dl>
        {wb.config.active ? (
          <p
            data-testid="sketch-config-hint"
            className="rounded-control bg-warning-soft px-2 py-1.5 text-2xs leading-4 text-warning-text"
          >
            Sketch dimensions are not configurable: editing one changes Default, so every
            configuration sees it. The sketch is solved with {wb.config.active.name}’s parameter
            values.
          </p>
        ) : null}
        <p className="text-2xs leading-4 text-fg-muted">
          Click to place points; the line tool chains until you close a loop or press Esc. Press{' '}
          <Kbd>D</Kbd>, click geometry, then click where the label goes: above or below measures
          horizontally, beside measures vertically (<Kbd>Shift</Kbd>: aligned). Drag points to
          adjust.
        </p>
        <Button variant="primary" onClick={() => wb.sketch?.finish()} data-testid="finish-sketch">
          Finish sketch
        </Button>
      </div>
    );
  }

  if (ui.featureId) {
    // The feature as the active configuration shows it (M3.7); Default's is the stored one.
    const f =
      wb.config.effectiveFeature(ui.featureId) ?? part.features.find((x) => x.id === ui.featureId);
    if (f) {
      const status = refAcks
        .apply(doc.meta.id ?? '', regen?.result.features)
        ?.find((s) => s.featureId === f.id);
      return (
        <Suspense fallback={null}>
          <FeatureInspectorPane
            wb={wb}
            doc={doc}
            f={f}
            {...(status ? { status } : {})}
            pickingPath={ui.picking?.featureId === f.id ? ui.picking.path : null}
            {...(tables ? { tables } : {})}
            density={density}
          />
        </Suspense>
      );
    }
  }

  if (ui.selection.length) {
    const first = ui.selection[0];
    const kinds = new Set(ui.selection.map((s) => selectionKind(s.hit.kind)));
    const kind = kinds.size === 1 && first ? selectionKind(first.hit.kind) : 'face';
    const label = ui.selection.length === 1 && first?.ref ? describeRef(doc, first.ref) : undefined;
    // "Made by": the feature and sketch behind a single face, edge or vertex.
    const lineage =
      ui.selection.length === 1 && first?.ref && first.hit.kind !== 'region'
        ? selectionLineage(doc, first.ref.name)
        : undefined;
    return (
      <SelectionInspector
        selection={{ kind, count: ui.selection.length, ...(label ? { label } : {}) }}
        onClear={() => wb.clearSelection()}
        {...(lineage ? { lineage, onEditFeature: (id: string) => wb.editFeature(id) } : {})}
        actions={wb.selectionTools().map(actionMeta)}
        onAction={(id) => {
          if (id === 'sketch') wb.sketchTool();
          else void wb.runTool(id as ModelTool | FeatureTool);
        }}
      />
    );
  }

  const shown = wb.config.resolved().doc.parts[0] ?? part;
  const active = wb.config.active;
  const activeName = active?.name ?? null;
  return (
    <>
      <PartInspector
        part={{
          name: part.name,
          ...(shown.material ? { material: shown.material } : {}),
          ...(shown.color ? { color: shown.color } : {}),
        }}
        configuration={{
          activeName,
          materialOverridden: overrideIn(active, { kind: 'material' }).has,
          onResetMaterial: () => wb.config.resetOverride({ kind: 'material' }),
          masses: view.masses,
          properties: {
            partNumber: shown.properties?.partNumber ?? '',
            description: shown.properties?.description ?? '',
            generatedPartNumber: active ? `${doc.meta.name}-${active.name}` : doc.meta.name,
            overridden: {
              partNumber: overrideIn(active, { kind: 'property', key: 'partNumber' }).has,
              description: overrideIn(active, { kind: 'property', key: 'description' }).has,
            },
            onChange: (patch, scope) => wb.config.setProperties(patch, scope),
            onReset: (key) => wb.config.resetOverride({ kind: 'property', key }),
          },
        }}
        library={LIBRARY}
        {...(() => {
          const m = wb.massSummary();
          return m ? { mass: m } : {};
        })()}
        evaluate={(e) => wb.evaluate(e, 'density')}
        onSetMaterial={(m, scope) => wb.config.setMaterial(m, scope)}
        density={density}
      />
      <DocumentSection wb={wb} />
    </>
  );
}
