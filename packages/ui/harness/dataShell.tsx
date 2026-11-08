import type { DeviceTier, Expr, Feature, Id, KernelStatus } from '@whittle/contracts';
import { useMemo, useState } from 'react';
import {
  AppShell,
  type ExportRequest,
  FeatureInspector,
  type MoveResult,
  PartInspector,
  SelectionInspector,
  type ThemeSetting,
  type ToolId,
} from '../src';
import {
  makeEvaluator,
  sampleFeatures,
  sampleLibrary,
  sampleParams,
  sampleStatuses,
} from './fixtures';

/** The shells wired to sample data, the way apps/web will wire them to the store. */
export function DataShell({
  tier,
  theme,
  status,
  viewport,
  inspector: which,
}: {
  tier: DeviceTier;
  theme: ThemeSetting;
  status: KernelStatus;
  viewport: React.ReactNode;
  inspector: string;
}) {
  const [features, setFeatures] = useState<Feature[]>(sampleFeatures);
  const [params, setParams] = useState(sampleParams);
  const [selected, setSelected] = useState<Id | null>(which === 'part' ? null : 'F2');
  const [rollback, setRollback] = useState(5);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [exported, setExported] = useState<ExportRequest | null>(null);
  const evaluate = useMemo(() => makeEvaluator(params), [params]);
  const feature = features.find((f) => f.id === selected);
  const touch = tier === 'desktop' ? 'compact' : 'touch';

  const move = (id: Id, to: number): MoveResult => {
    const from = features.findIndex((f) => f.id === id);
    const f = features[from];
    if (f && (f.type === 'fillet' || f.type === 'chamfer') && to < 2)
      return { ok: false, reason: `${f.name} needs Extrude 1 above it.` };
    const next = [...features];
    const [it] = next.splice(from, 1);
    if (it) next.splice(to, 0, it);
    setFeatures(next);
    return { ok: true };
  };

  const inspector =
    which === 'none' ? undefined : which === 'part' || !feature ? (
      <PartInspector
        part={{
          name: 'Bracket',
          material: {
            libraryId: 'whittle:al-6061',
            name: 'Aluminium 6061-T6',
            density: '2.70 g/cm^3',
            appearance: '#c9ced6',
          },
        }}
        library={sampleLibrary}
        evaluate={(e: Expr) => evaluate(e, 'density')}
        mass={{ volume: 31_250, area: 8_420.5, mass: 0.0843, centroid: [30.125, 20, 6.5] }}
        onSetMaterial={() => {}}
        density={touch}
      />
    ) : which === 'selection' ? (
      <SelectionInspector selection={{ kind: 'none' }} />
    ) : (
      <FeatureInspector
        feature={feature}
        status={sampleStatuses.find((s) => s.featureId === feature.id)}
        evaluate={(e, x) => evaluate(e, x)}
        onChange={(f) => setFeatures((fs) => fs.map((x) => (x.id === f.id ? f : x)))}
        density={touch}
      />
    );

  return (
    <>
      <AppShell
        tier={tier}
        theme={theme}
        documentName="Untitled bracket"
        kernelStatus={status}
        viewport={viewport}
        featureTree={{
          features,
          statuses: sampleStatuses,
          rollbackIndex: rollback,
          selectedId: selected,
          onSelect: setSelected,
          onRollback: setRollback,
          onMove: move,
          onRename: (id, name) =>
            setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, name } : f))),
          onSuppress: (id, suppressed) =>
            setFeatures((fs) => fs.map((f) => (f.id === id ? { ...f, suppressed } : f))),
          onDelete: (id) => setFeatures((fs) => fs.filter((f) => f.id !== id)),
        }}
        paramsTable={{
          params,
          evaluate: (e) => evaluate(e),
          onAdd: () =>
            setParams((p) => [
              ...p,
              { id: `P${p.length + 1}`, name: `param${p.length + 1}`, expr: '10mm' },
            ]),
          onUpdate: (id, patch) =>
            setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p))),
          onRemove: (id) => setParams((ps) => ps.filter((p) => p.id !== id)),
        }}
        inspector={inspector}
        enabledTools={['sketch', 'extrude', 'revolve', 'fillet', 'chamfer']}
        activeTool={tool}
        onTool={setTool}
        onExportRequest={setExported}
        exportBodies={[{ id: 'B1', name: 'Bracket' }]}
        exportUnavailable={{ '3mf': 'Coming soon' }}
        diagnostics={undefined}
        onUndo={() => {}}
        onRedo={() => {}}
      />
      <output hidden data-testid="last-export">
        {exported ? JSON.stringify(exported) : ''}
      </output>
    </>
  );
}
