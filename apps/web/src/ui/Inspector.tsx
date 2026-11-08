/**
 * Right-panel content (PLAN §9.1 "context inspector"): sketch session, the feature being edited,
 * the viewport selection with context tools, or the part (material, mass) and document.
 */

import type { EntityRef, Feature, Material, WhittleDoc } from '@whittle/contracts';
import { MATERIALS } from '@whittle/document';
import {
  Button,
  FeatureInspector,
  Kbd,
  type MaterialLibraryItem,
  type MeasurePanelProps,
  PartInspector,
  type SectionPanelProps,
  type SelectionAction,
  SelectionInspector,
  SketchStatusChip,
  tools as shellTools,
} from '@whittle/ui';
import { FolderOpen, Library, Plus, Save } from 'lucide-react';
import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { useObservable } from '../app/observable';
import type { Workbench } from '../app/workbench';
import type { ModelTool } from '../features/factories';
import { selectionKind } from '../selection/pick';

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
export function describeRef(doc: WhittleDoc, ref: EntityRef): string {
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
          onClick={() => void wb.exportWhittle()}
        >
          Save file
        </Button>
      </div>
      <p className="mt-2 text-2xs text-fg-muted">Saved automatically to this device.</p>
    </section>
  );
}

export function useDoc(wb: Workbench): WhittleDoc {
  return useSyncExternalStore(wb.subscribeDoc, wb.getDoc);
}

const actionMeta = (id: ModelTool): SelectionAction => {
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
  const part = doc.parts[0];
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
    const f = part.features.find((x) => x.id === ui.featureId);
    if (f) {
      const status = regen?.result.features.find((s) => s.featureId === f.id);
      return (
        <FeatureInspector
          key={f.id}
          feature={f}
          {...(status ? { status } : {})}
          evaluate={(e, d) => wb.evaluate(e, d)}
          onChange={(next: Feature) => wb.updateFeature(next, 'commit')}
          onPreview={(next: Feature) => wb.updateFeature(next, 'preview')}
          onPick={(path) =>
            status?.unresolved?.some((u) => u.path === path)
              ? wb.repick(f.id, path)
              : wb.startPicking(f.id, path)
          }
          {...(status?.state === 'needsAttention' ? { onRepick: () => wb.repick(f.id) } : {})}
          pickingPath={ui.picking?.featureId === f.id ? ui.picking.path : null}
          describeRef={(r) => describeRef(doc, r)}
          {...(f.type === 'sketch' ? { onEditSketch: () => wb.editFeature(f.id) } : {})}
          onDone={() => wb.selectFeature(null)}
          units={{ length: doc.units.length, angle: doc.units.angle === 'deg' ? '°' : 'rad' }}
          density={density}
        />
      );
    }
  }

  if (ui.selection.length) {
    const first = ui.selection[0];
    const kinds = new Set(ui.selection.map((s) => selectionKind(s.hit.kind)));
    const kind = kinds.size === 1 && first ? selectionKind(first.hit.kind) : 'face';
    const label = ui.selection.length === 1 && first?.ref ? describeRef(doc, first.ref) : undefined;
    return (
      <SelectionInspector
        selection={{ kind, count: ui.selection.length, ...(label ? { label } : {}) }}
        actions={wb.selectionTools().map(actionMeta)}
        onAction={(id) => {
          if (id === 'sketch') wb.sketchTool();
          else void wb.runTool(id as ModelTool);
        }}
      />
    );
  }

  return (
    <>
      <PartInspector
        part={{
          name: part.name,
          ...(part.material ? { material: part.material } : {}),
          ...(part.color ? { color: part.color } : {}),
        }}
        library={LIBRARY}
        {...(() => {
          const m = wb.massSummary();
          return m ? { mass: m } : {};
        })()}
        evaluate={(e) => wb.evaluate(e, 'density')}
        onSetMaterial={(m) => wb.setMaterial(m)}
        density={density}
      />
      <DocumentSection wb={wb} />
    </>
  );
}
